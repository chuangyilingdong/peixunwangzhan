// 学生端「我的创作环境」：开一台自己的盒子 / 看它还在不在 / 下课收掉 / **把作品交上来**（2026-09-16）
//
// 学生要的东西只有一句：「进我的创作环境」。所以这里不让学生传课堂 id ——
// **课堂由服务端按他的名单反查**（一个学生全局最多属于一个未终态课堂这条口径，
// 见 docs/README.md），免得客户端随便传一个别人的课堂 id 过来。
//
// 真正的动作在两个地方：
//   · services/studentRuntime.js —— 门禁 → 签密钥 → 调宿主脚本（开 / 收 / 列产物 / 取产物）；
//   · 本文件的 /submit —— 把取回来的产物按**现有作品链路**落进 vibecoding_submissions；
//     网页里的本地图片存成私有文件资产并改写引用（见 fileAssets.js 的 storeStudentArtifactAsset）。
import { deliveryModesOf, errors, normalizeLesson, requireRole, row, rows, arow, arows, amap } from '../lib.js';
import { accessibleLesson } from './adminOrg.js';
import { collectStudentDeliverable, launchStudentRuntime, listStudentDeliverables, runtimeGatewayUrl, stopStudentRuntime, studentRuntimeAvailability } from '../services/studentRuntime.js';
import { issueRuntimeKey } from './runtimeGateway.js';
import { vibecodingPresetPrompts, vibecodingSendLimit, vibecodingSendUsage } from '../services/vibecodingLessonSettings.js';
import { isSubmittableArtifactKind, kindForName } from '../services/vibecodingArtifacts.js';
import { documentMime } from '../services/ooxml/documents.js';
import { ensureRuntimeConversation, recordRuntimeSubmission, rewriteLocalReferences, runtimeSubmissionWorkItem, textDefaultModel, textModelOptions } from './vibecoding.js';
import { storeStudentArtifactAsset } from './fileAssets.js';
import { scanUploadBuffers } from '../services/fileUploadSecurity.js';

// 客户端运行时（dsh / VibeCoding）**只认"这节课声明了 VibeCoding"**。
//
// ⚠️ 2026-09-21（客户端项目报的）：这里的三个解析器原来都没管上课类型，
//    于是**画布课也会被当成"你现在能进的课"下发** —— `client-context.classroom` 有值、
//    网关密钥照发，客户端看到 classroom != null 就打开 VibeCoding 环境
//    （客户端拿不到类型字段，它没法自己判断，所以**这道门禁必须在服务端**）。
//
// ⚠️ 判据用**课时声明的类型**（`course_lessons.delivery_modes`，平台勾选的、可以是两种），
//    **不用**课堂那个单值（`class_sessions.delivery_mode`）：那是老师建课堂时跟着课时带的
//    "第一个"（9-16 口径「老师不再选课堂模式」，它只作历史兼容）—— 按它判会把
//    "同时开了两种"的课时误挡（网页两个入口都亮、客户端却进不去）。
//    这与学生端网页的入口判定同源（`lessonAvailability` 也看课时声明的类型）—— 见口径 61。
const RUNTIME_DELIVERY_MODE = 'VIBECODING';
/** 「这节课是不是客户端运行时的课」= 它声明了 VIBECODING（两种都开时，客户端这一侧也算）。 */
const isRuntimeLesson = (lessonRow) => deliveryModesOf({ delivery_modes: lessonRow?.lesson_delivery_modes, delivery_mode: lessonRow?.lesson_delivery_mode }).includes(RUNTIME_DELIVERY_MODE);

/** 这个学生现在该进哪个课堂：名单里 ACTIVE 且课堂 ACTIVE、且**这节课声明了 VIBECODING**，最近的第一个。 */
async function resolveActiveClassroom(studentId) {
  return await arow(
    `SELECT s.id, s.lesson_id, s.title, s.delivery_mode,
            lesson.delivery_mode AS lesson_delivery_mode, lesson.delivery_modes AS lesson_delivery_modes
       FROM class_sessions s
       JOIN session_students p ON p.session_id = s.id
       LEFT JOIN course_lessons lesson ON lesson.id = s.lesson_id
      WHERE p.student_id = ? AND p.status = 'ACTIVE' AND s.status = 'ACTIVE'
        AND (lesson.delivery_mode = '${RUNTIME_DELIVERY_MODE}' OR lesson.delivery_modes LIKE '%${RUNTIME_DELIVERY_MODE}%')
      ORDER BY s.started_at DESC, s.created_at DESC
      LIMIT 1`,
    [studentId],
  );
}

async function requireActiveClassroom(studentId, what) {
  const classroom = await resolveActiveClassroom(studentId);
  if (!classroom) throw errors.forbidden(`你现在没有正在上的课堂，${what}`, 'RUNTIME_NO_ACTIVE_CLASSROOM');
  return classroom;
}

/**
 * 这节课「叫什么」—— 学生得在客户端上**看得见自己进的是哪节课**（2026-09-20 用户口径）。
 *
 * 为什么要单独查一次：`client-context` 原来只回课堂标题（老师起的名字，比如「上午班」），
 * 而**预设提示词与发送次数上限都是按课时配的** —— 学生只看到「上午班」对不上是哪个课包哪一节。
 * 老师名一并带上：学生要能确认「是不是这节课、是不是这个老师」。
 * ⚠️ 课时名取 `COALESCE(published_title, title)`：published_title 才是给学生看的那一版
 *    （与作品列表同一口径；`getStudentClassrooms` 用的是 lesson.title，那是机构侧口径）。
 */
async function classroomContext(sessionId) {
  if (!sessionId) return null;
  const info = await arow(
    `SELECT session.status AS session_status, session.started_at,
            COALESCE(lesson.published_title, lesson.title) AS lesson_title,
            series.title AS series_title,
            teacher.display_name AS teacher_name
       FROM class_sessions session
       LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
       LEFT JOIN course_series series ON series.id = lesson.series_id
       LEFT JOIN users teacher ON teacher.id = session.teacher_id
      WHERE session.id = ?`,
    [sessionId],
  );
  if (!info) return null;
  return {
    seriesTitle: info.series_title || null,
    lessonTitle: info.lesson_title || null,
    teacherName: info.teacher_name || null,
    sessionStatus: info.session_status || null,
    startedAt: info.started_at || null,
  };
}

/**
 * 学生名下**还没开始**的那节课（PENDING）。老师还没点「立即上课」时，学生至少能看见
 * 「接下来要上哪节课」，而不是只看到一句「老师还没有开始上课」—— 但**不发密钥**，
 * 「老师点了立即上课才能进」那道闸不动。
 * 口径见 docs/README.md：一个学生全局最多属于一个未终态课堂，所以这里最多一条。
 */
async function resolvePendingClassroom(studentId) {
  return await arow(
    `SELECT session.id, session.lesson_id, session.title, session.delivery_mode,
            lesson.delivery_mode AS lesson_delivery_mode, lesson.delivery_modes AS lesson_delivery_modes
       FROM class_sessions session
       JOIN session_students part ON part.session_id = session.id
       LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
      WHERE part.student_id = ? AND part.status = 'ACTIVE' AND session.status = 'PENDING'
        AND (lesson.delivery_mode = '${RUNTIME_DELIVERY_MODE}' OR lesson.delivery_modes LIKE '%${RUNTIME_DELIVERY_MODE}%')
      ORDER BY session.created_at DESC LIMIT 1`,
    [studentId],
  );
}

/**
 * 「一个学生全局最多属于一个未终态课堂」是产品口径（加人/开课两处都拦），但**种子与历史数据绕过过校验**。
 * 出现 >1 时打一条警告：让运维去清（脚本 `deploy/production/dissolve-duplicate-active-sessions.mjs`），
 * 而不是让"多选"看起来像个正常功能 —— 客户端契约第二版点名了这一点。
 */
function logDirtyClassroomCandidates(studentId, candidates) {
  if (!Array.isArray(candidates) || candidates.length <= 1) return;
  console.warn(`[client-context] 学生 ${studentId} 同时挂着 ${candidates.length} 场 ACTIVE 课堂（口径：最多 1 场）——`
    + ` 属于历史/种子数据，请收口：${candidates.map((item) => item.id).join(', ')}`);
}

/**
 * 「这次算哪一节」（附带把候选一并返回，**只为把脏数据暴露出来**）。
 *
 * ⚠️ **产品口径（2026-09-29 客户端契约第二版点名，与 docs/README.md 一致）：一个学生全局
 *    最多属于一个未终态课堂** —— 加人时会被拒（`IN_OTHER_SESSION`，守卫 p66/p78），
 *    开课时也会被拦（`STUDENT_IN_OTHER_SESSION`）。所以**正常情况下候选恒 ≤1 节**，
 *    "让客户端在几节课里选"**不是**一个功能。
 *
 * 那为什么还留着 `candidates` / `?sessionId=`：**种子与历史数据绕过过校验**（线上实测有一个学生
 * 同时挂着两场 ACTIVE 课堂），而这里原来只取"最近开始的那一场" —— 于是学生做 A 课作业、拿到的却是
 * B 课的**次数上限与预设**，界面上还看不出任何异常。留着候选与 `?sessionId=` 是给**脏数据**兜底
 * （让客户端至少能落到正确那节），并且 `>1` 时**打一条警告**（见上面 logDirtyClassroomCandidates），
 * 让运维看见"这学生该清一下"，而不是当成正常状态。
 * 选的那节不可用（结束/被移除/不是他的）时**明说**，绝不默默换一节。
 *
 * 返回：`session` 保持库行形状（`id / lesson_id / title`，下游动作读它）、`classroom` 是给客户端看的
 * 同一节（带课包/课时/老师）、`candidates` 是全部候选（同形状，正常 ≤1）。
 */
async function resolveClassroomEntry(studentId, requestedSessionId) {
  const raw = await arows(
    `SELECT session.id, session.lesson_id, session.title, session.started_at, session.created_at, session.delivery_mode,
            lesson.delivery_mode AS lesson_delivery_mode, lesson.delivery_modes AS lesson_delivery_modes
       FROM class_sessions session
       JOIN session_students part ON part.session_id = session.id
       LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
      WHERE part.student_id = ? AND part.status = 'ACTIVE' AND session.status = 'ACTIVE'
      ORDER BY session.started_at DESC, session.created_at DESC, session.id DESC`,
    [studentId],
  );
  const publicOf = async (session) => ({
    id: session.id,
    lessonId: session.lesson_id || '',
    title: session.title,
    ...(await classroomContext(session.id) || {}),
  });
  // ⭐ 候选**只放"这节课声明了 VIBECODING"的**：画布课不该出现在"你现在能进的课"里
  //    （客户端会照单全收去开环境）。注意 raw 要保留全部，否则"学生点名的这节是画布课"就看不出来了。
  const runtimeSessions = raw.filter(isRuntimeLesson);
  const candidates = await amap(runtimeSessions, publicOf);
  const requested = String(requestedSessionId || '').trim();
  if (requested) {
    const hit = raw.find((item) => item.id === requested) || null;
    if (!hit) return { session: null, classroom: null, candidates, reason: 'CLASSROOM_NOT_AVAILABLE' };
    // 明确点名了一节画布课：**明说是类型不对，绝不默默换成另一节**（静默换课会把学生放到别的课上）。
    if (!isRuntimeLesson(hit)) return { session: null, classroom: null, candidates, reason: 'CLASSROOM_MODE_MISMATCH' };
    return { session: hit, classroom: candidates.find((item) => item.id === hit.id) || null, candidates, reason: null };
  }
  const session = runtimeSessions[0] || null;
  return {
    session,
    classroom: session ? (candidates.find((item) => item.id === session.id) || null) : null,
    candidates,
    // 没有可进的客户端课，但他**正在一节画布课上** → 说清是类型不对（不是"老师没开始上课"）
    reason: session ? null : (raw.length ? 'CLASSROOM_MODE_MISMATCH' : 'NOT_STARTED'),
  };
}

/**
 * 「需要一节正在上的课」的动作（列产物 / 交作品）用它取课：**跟着学生选的那节走**，
 * 没选就取最近一场。选的那节不可用时**报错说清**，不能默默换成另一节 ——
 * 那会把作品交到别的课上（学生以为在 A 课交的，结果挂在 B 课）。
 *
 * ⚠️ `mismatch` 是「他在画布课堂上做 VibeCoding 的事」时那句话：客户端会把 message 显示出来，
 *    所以按客户端契约写成同一句（错误码沿用 RUNTIME_NO_ACTIVE_CLASSROOM，客户端不用改）。
 */
async function requireSelectedClassroom(ctx, studentId, what, mismatch = '') {
  const entry = await resolveClassroomEntry(studentId, ctx.search.get('sessionId') || ctx.body?.sessionId);
  if (!entry.session) {
    if (entry.reason === 'CLASSROOM_MODE_MISMATCH') {
      throw errors.forbidden(mismatch || '当前是画布课堂，不能在 VibeCoding 创作环境里做这个操作', 'RUNTIME_NO_ACTIVE_CLASSROOM');
    }
    const prefix = entry.reason === 'CLASSROOM_NOT_AVAILABLE' ? '你选的那节课已经结束了，' : '你现在没有正在上的课堂，';
    throw errors.forbidden(`${prefix}${what}`, 'RUNTIME_NO_ACTIVE_CLASSROOM');
  }
  return entry.session;
}


/** 相对路径里**每一段**允许的形状（与 packages/shared 的 FILE_NAME_PATTERN 同一套字符表）。 */
const ARTIFACT_SEGMENT = /^[A-Za-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af][A-Za-z0-9._\-\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]*$/;

/**
 * 作品里的文件/素材名 —— **允许相对子目录**（`assets/hero.png`），但仍然是一条严格白名单。
 *
 * ⚠️ 2026-09-30（用户报「教师后台看作品里图片/视频显示不出来」）：这里原来**拒收任何带 `/` 的名字**，
 *    而客户端工作区里的网页几乎都把素材放在子目录里（AI 生成的 HTML 写的就是
 *    `<img src="assets/character_mecha.png">`）—— 名字一交上来就被 400，
 *    于是客户端干脆不带这些文件，交上来的作品在老师端/广场/分享页里就是一片破图与空播放器。
 *    生产实据：`vibesub_cf3f389300224c448b06`（09-30 14:01 提交）里只有 `index.html` 一个文本文件，
 *    而它的 HTML 引用了 `assets/character_mecha.png` 与 `assets/transform.mp4` —— 两个字节都没上来。
 *
 * 允许 `/` 之后仍然不许：绝对路径、盘符、反斜杠、`..`、隐藏文件（以 `.` 开头）、空段、段过长、层数过深。
 * ⚠️ 与 `vibecoding.js` 的 `normalizeLocalReference`（扫描/回写那一侧）**同一套规矩**，两处要一起改。
 */
function safeArtifactName(value) {
  const raw = String(value || '(空)');
  const name = String(value || '').trim().replace(/^\.\//, '');
  const invalid = (why) => errors.badRequest(`作品里的文件名不合法（${why}）：${raw.slice(0, 80)}`, 'INVALID_ARTIFACT_NAME');
  if (!name || name.length > 120) throw invalid('空的或太长（上限 120 字）');
  if (/[\\\0]/.test(name) || /^[A-Za-z]:/.test(name) || name.startsWith('/')) throw invalid('不许绝对路径/盘符/反斜杠');
  if (name.includes('..') || name.startsWith('.')) throw invalid('不许 .. 或隐藏文件');
  const segments = name.split('/');
  if (segments.length > 6) throw invalid('目录太深（最多 5 层）');
  for (const segment of segments) {
    if (!segment) throw invalid('路径里有空目录名');
    if (segment.length > 64 || !ARTIFACT_SEGMENT.test(segment)) throw invalid(`目录/文件名不合法：${segment.slice(0, 40)}`);
  }
  return name;
}

/** 二进制素材的 MIME：只列我们真的会遇到的（storeStudentArtifactAsset 还会再验一次魔术字节）。 */
const MIME_BY_EXTENSION = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  // 字体四个：存储层白名单 2026-10-01 已放开（没有魔术字节可验，靠扩展名+MIME 对齐那一条）。
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
  // ⭐ 2026-10-01：wav / ogg / pdf 补上 —— 存储层白名单**一直都收**这三种
  //    （`MIME_EXTENSIONS` 有 audio/wav、audio/x-wav、audio/ogg、application/pdf，也验魔术字节），
  //    是这张"扩展名 → MIME"表漏了它们，于是学生交上来的音效（游戏里 wav 很常见）被
  //    「格式还不支持随作品提交」整条丢掉。实测矩阵见 §八十二。
  wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf',
  // ⭐ 2026-10-01 用户口径：「字体 woff/woff2/ttf/otf/svg/PPT word 这些都要能上传呀。」
  //    svg 与 Office 三种：存储层白名单都收（Office 本来就是"入口产物"的合法类型，
  //    这里补上是因为它也可能**只作为被引用的附件**出现，例如 HTML 里 `<a href="report.docx">`）。
  svg: 'image/svg+xml', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * 一份产物该用什么 MIME 存。文档三种按既有口径取（`documentMime`），其余查上表；
 * **查不到就返回 null**（调用方据此拒收并告警），绝不猜一个 MIME 出来 ——
 * 猜错的后果是 `persistSecureUpload` 拿魔术字节一验就对不上，白折腾一趟。
 */
function mimeForArtifact(name) {
  const extension = String(name).split('.').pop()?.toLowerCase() || '';
  if (['pptx', 'docx', 'xlsx'].includes(extension)) return documentMime(extension);
  return MIME_BY_EXTENSION[extension] || null;
}

export async function handleStudentRuntime(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/student/runtime')) return null;
  // ⚠️ 2026-09-30：这道角色门**放宽到老师/机构管理员**，但只为「客户端备课上下文」那一条
  //    （老师的 VibeCoding 备课也在客户端里，客户端要能问到"这是备课模式、哪一节课、不能发送"）。
  //    其余端点（launch / stop / deliverables / submit…）照旧**只认学生** —— 紧接着就拦回去，
  //    错误码与文案与原来 `requireRole(ctx, ['STUDENT'])` 抛的一字不差（守卫照旧钉得住）。
  const auth = requireRole(ctx, ['STUDENT', 'TEACHER', 'ORG_ADMIN']);
  const part = pathname.slice('/api/student/runtime'.length);
  const isPrepContext = part === '/client-context' && method === 'GET' && auth.user.role !== 'STUDENT';
  if (auth.user.role !== 'STUDENT' && !isPrepContext) throw errors.forbidden('当前角色无权访问该资源', 'FORBIDDEN');
  const orgId = auth.session?.org_id || auth.user.orgId;

  if (part === '/status' && method === 'GET') {
    const availability = studentRuntimeAvailability();
    const classroom = await resolveActiveClassroom(auth.user.id);
    return {
      available: availability.available,
      reason: availability.reason,
      classroom: classroom ? { id: classroom.id, lessonId: classroom.lesson_id, title: classroom.title } : null,
    };
  }

  // 桌面客户端启动后要的那一份（2026-09-19）：本课能不能进、网关地址与密钥、预设提示词、剩余发送次数。
  // ⚠️ 与 /launch 的区别：客户端**不在服务器上开任何进程**（学生环境跑在学生自己电脑上），
  //    所以这里只发「能不能进 + 进门要用的密钥与上下文」，不碰宿主脚本、不进 broker。
  // ⚠️ 没在上的课（老师没点「立即上课」）→ classroom:null：客户端据此只显示「我的课程」、
  //    不给进入对话区的入口。这就是「点了立即上课才能进」那道闸 —— 而且是**服务端兜底**的：
  //    客户端即使被改，没密钥就调不动网关（密钥里带机构/学生/课时/课堂，网关每次调用都重新过门禁）。
  //
  // 2026-09-20（用户口径：学生要"跟这节课的设定对应上"）：
  //   · `classroom` 补 `seriesTitle / lessonTitle / teacherName / startedAt` —— 预设与次数上限都是
  //     **按课时**配的，学生只看到课堂名（「上午班」）对不上是哪个课包哪一节；
  //   · 没有在上的课时给 `upcoming`（名下那节 PENDING 课堂的同组信息）—— 至少让他知道"接下来上哪节"，
  //     但**仍然不发密钥**，闸门不动。
  //   · `classrooms` / `?sessionId=`：**只为脏数据兜底，不是功能** —— 口径见 `resolveClassroomEntry()`
  //     的头注释（一个学生全局最多一场未终态课堂，加人/开课两处都拦）。正常情况候选 ≤1；
  //     `>1` 说明库里有绕过过校验的旧数据，这时打一条警告（下面 logDirtyClassroomCandidates），
  //     并让客户端可以指定哪一节，免得学生上错课、拿到别的课时的次数上限与预设。
  if (part === '/client-context' && method === 'GET') {
    // ⭐ 2026-09-30 用户口径：「老师端可以自由无限制进入对应的课时课堂（画布 / VibeCoding），
    //    他们可以走流程，但是**无法生成**」。
    //    VibeCoding 那一半只能落在客户端里（学生的创作环境就在客户端），所以这里给老师一份
    //    **备课上下文**：告诉客户端"这是备课模式、是哪一节课、不能发送"。
    //
    //    ⚠️ 三条纪律：
    //      ① **不发 `gateway` 密钥** —— 客户端拿不到运行密钥就调不动上游，这是服务端兜底
    //        （客户端就算忘了隐藏发送按钮，也发不出去）；
    //      ② 只给**已发布 + 课包仍授权给本机构**的课时（与机构端建课堂同一条准入）；
    //      ③ 老师/机构管理员一律走这一支 —— 学生课堂那套是学生作用域的，老师本来就没有课堂，
    //        以前会掉进「老师还没有开始上课」那句里。
    if (auth.user.role !== 'STUDENT') {
      const prepLessonId = String(ctx.search.get('lessonId') || '').trim();
      let prepLesson = prepLessonId
        ? await arow("SELECT * FROM course_lessons WHERE id=? AND status='PUBLISHED'", [prepLessonId])
        : null;
      if (prepLessonId && !prepLesson) throw errors.notFound('课时不存在或未发布', 'LESSON_NOT_FOUND');
      if (prepLesson && !await accessibleLesson((auth.session?.org_id || auth.user.orgId), prepLessonId)) {
        throw errors.forbidden('这个课包还没有授权给本机构', 'COURSE_NOT_ASSIGNED');
      }
      if (prepLesson) prepLesson = await normalizeLesson(prepLesson, { asPublished: true });
      const prepSeries = prepLesson?.seriesId ? await arow('SELECT title FROM course_series WHERE id=?', [prepLesson.seriesId]) : null;
      return {
        prep: true,
        classroom: null,
        classrooms: [],
        upcoming: null,
        reason: 'TEACHER_PREP',
        message: '备课模式：可以走一遍学生的界面流程，但不能生成内容',
        user: { id: auth.user.id, name: auth.user.displayName || auth.user.display_name || null, role: auth.user.role },
        lesson: prepLesson ? {
          id: prepLesson.id, title: prepLesson.title, seriesTitle: prepSeries?.title || null,
          deliveryMode: prepLesson.deliveryMode, deliveryModes: prepLesson.deliveryModes,
          capabilities: prepLesson.capabilities || [],
        } : null,
        presets: prepLesson ? await vibecodingPresetPrompts(prepLesson.id) : [],
        models: await textModelOptions(),
        defaultModel: await textDefaultModel(),
      };
    }
    const entry = await resolveClassroomEntry(auth.user.id, ctx.search.get('sessionId'));
    logDirtyClassroomCandidates(auth.user.id, entry.candidates);
    const classroom = entry.classroom;
    if (!classroom) {
      // 还没开始上课（或选的那节已经结束）：把「接下来是哪节课」也告诉客户端，
      // 但**不发密钥** —— 「老师点了立即上课才能进」那道闸不动。
      //
      // ⭐ 画布课堂走另一支：**只回 null 与一句话**（客户端契约的形状）——
      //    classroom:null / classrooms:[] / upcoming:null / reason:CLASSROOM_MODE_MISMATCH，
      //    并且**不带 gateway/presets/sends**（客户端拿不到密钥就开不了环境，这是服务端兜底）。
      if (entry.reason === 'CLASSROOM_MODE_MISMATCH') {
        return {
          classroom: null,
          classrooms: [],
          upcoming: null,
          reason: 'CLASSROOM_MODE_MISMATCH',
          message: '当前是画布课堂，请在学生端进入画布课堂',
        };
      }
      const pending = await resolvePendingClassroom(auth.user.id);
      const pendingInfo = pending ? (await classroomContext(pending.id) || {}) : null;
      return {
        classroom: null,
        classrooms: entry.candidates,
        upcoming: pending ? {
          id: pending.id,
          lessonId: pending.lesson_id || '',
          title: pending.title,
          seriesTitle: pendingInfo.seriesTitle ?? null,
          lessonTitle: pendingInfo.lessonTitle ?? null,
          teacherName: pendingInfo.teacherName ?? null,
          startedAt: null,
        } : null,
        reason: entry.reason,
        message: entry.reason === 'CLASSROOM_NOT_AVAILABLE' ? '你选的那节课已经结束了' : '老师还没有开始上课',
      };
    }
    const lessonId = classroom.lessonId;
    const limit = await vibecodingSendLimit(lessonId);
    // ⚠️ 对外报的已用次数**封顶到上限**：库里存的是"观察到的发送次数最大值"（判据靠它，压缩也不会刷新
    //    额度），但给学生/老师看的是"用了几次／共几次"，所以这里取 min。见 vibecodingLessonSettings.js。
    const usedRaw = await vibecodingSendUsage({ sessionId: classroom.id, studentId: auth.user.id });
    const used = limit === null ? usedRaw : Math.min(usedRaw, limit);
    return {
      // 课包/课时/老师一起给学生：预设与次数上限都是**按课时**配的，客户端要能显示"这是哪节课的"。
      classroom,
      classrooms: entry.candidates,
      reason: null,
      gateway: { baseUrl: runtimeGatewayUrl(), key: issueRuntimeKey({ orgId, userId: auth.user.id, sessionId: classroom.id, lessonId }) },
      presets: await vibecodingPresetPrompts(lessonId),
      sends: { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) },
      // ⭐ 模型清单下发给客户端（2026-09-24 客户端口径）：客户端不再把模型名写死在补丁层里，
      //    而是**用 displayName 显示、用 id 发上游** —— 否则运营在后台改的别名到不了学生眼前。
      //    ⚠️ 只放 TEXT 渠道**实际启用**的模型（+ 渠道默认），**不是** modelMappings：
      //    那是管理员挑选用的大列表（几百条跨供应商），下发给学生会冒出 gpt 之类的无关模型。
      //    未开课/画布课堂那两支**故意不带**（客户端拿不到环境时的契约是"只回 null 与一句话"，
      //    它会退回内置兜底列表）。
      models: await textModelOptions(),
      defaultModel: await textDefaultModel(),
    };
  }

  if (part === '/launch' && method === 'POST') {
    const classroom = await requireActiveClassroom(auth.user.id, '没有创作环境可以开');
    const launched = await launchStudentRuntime({
      sessionId: classroom.id,
      studentId: auth.user.id,
      orgId,
      lessonId: classroom.lesson_id || null,
    });
    return launched;
  }

  if (part === '/stop' && method === 'POST') {
    const classroom = await requireActiveClassroom(auth.user.id, '没有环境可以收');
    return stopStudentRuntime({ sessionId: classroom.id, studentId: auth.user.id });
  }

  // 我这个创作环境里现在有哪些东西可以当作品交（读工作区；不改动任何文件）
  if (part === '/deliverables' && method === 'GET') {
    const classroom = await requireSelectedClassroom(ctx, auth.user.id, '没有创作环境可看', '当前是画布课堂，没有 VibeCoding 创作环境可看');
    return listStudentDeliverables({
      sessionId: classroom.id, studentId: auth.user.id, orgId, lessonId: classroom.lesson_id || null,
    });
  }

  // 交作品：把选中的那份取回来，按现有作品链路落库（广场/发布/机构查看全都读这张表）
  if (part === '/submit' && method === 'POST') {
    const classroom = await requireSelectedClassroom(ctx, auth.user.id, '没有创作环境可以交作品', '当前是画布课堂，不能提交 VibeCoding 作品');
    const scope = { sessionId: classroom.id, studentId: auth.user.id, orgId, lessonId: classroom.lesson_id || null };
    // 与工作台那条路同一条规矩：提交即确认版权与展示授权，平台之后才能发到作品广场
    if (ctx.body?.copyrightConfirmed !== true) {
      throw errors.badRequest('提交前请确认作品版权与展示授权', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
    }
    return recordSubmissionFromArtifacts({
      ctx, auth, orgId, classroom, collected: await collectStudentDeliverable({ ...scope, name: ctx.body?.name }),
    });
  }

  // 桌面客户端交作品（2026-09-19）：学生在**自己电脑上**做出来的东西，服务器读不到他的磁盘，
  // 所以字节必须由客户端传上来（`/submit` 那条是服务器去学生盒子里取，客户端没有盒子）。
  // 形状与「取回来的产物」一致（`{ name, files: [{ name, content, binary }] }`），
  // 下半段（存资产 → 改引用 → 定格清单 → 落库）与 `/submit` **共用同一份实现** ——
  // 两条入口各写一份的话，广场那边的规则迟早只在一半上生效。
  // ⚠️ 二进制用 base64 装在 JSON 里：body 上限在 index.js 按**本档推导**（`runtimeUploadMaxBytes`
  //    × 4/3 + 4MB 余量；生产 100MB → 138MB），保证"作品太大"的中文原因由我们这条业务闸先说出口，
  //    而不是让学生吃一个裸 `PAYLOAD_TOO_LARGE`。⚠️ 2026-10-02 前这里写的是
  //    "maxUploadBytes() + 1MB"——那是 **multipart** 路径（index.js:149）的闸，这条 JSON 路径
  //    当时实际还是默认 24MB，100MB 的业务上限因此**从未真正生效**（客户端实测 19.6MB 视频被 413）。
  if (part === '/submit-upload' && method === 'POST') {
    const classroom = await requireSelectedClassroom(ctx, auth.user.id, '没有创作环境可以交作品', '当前是画布课堂，不能提交 VibeCoding 作品');
    if (ctx.body?.copyrightConfirmed !== true) {
      throw errors.badRequest('提交前请确认作品版权与展示授权', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
    }
    return recordSubmissionFromArtifacts({ ctx, auth, orgId, classroom, collected: collectUploadedArtifacts(ctx.body) });
  }

  return null;
}

/** 一次提交最多带几个文件：正常作品（一个 HTML + 几张图 / 一个 PPT）远用不到这么多。 */
const MAX_UPLOAD_FILES = 60;
/**
 * 解出来的字节总量上限（base64 解回来之后的**真实**大小）—— **可配**。
 *
 * ⚠️ 2026-09-30 口径变更（用户 + 客户端反馈）：原来是写死的 **16MB** —— 而一节 VibeCoding 课里
 *    「15 秒 480P 的视频」实测就有 **19.6MB**，等于**学生根本交不上带视频的作品**
 *    （客户端侧原话：「19.6MB 的视频现在根本交不上去……我倾向让平台放宽」）。
 *    现在读 `RUNTIME_UPLOAD_MAX_BYTES`：默认 **64MB**，夹在 16MB（老下限）~ 200MB（存储层的
 *    单文件上限 `FILE_UPLOAD_MAX_BYTES`）之间。**生产设 100MB**（见 §八十一）。
 *
 * ⚠️ 传输层的 body 上限**由本档推导**（index.js：`runtimeUploadMaxBytes() × 4/3 + 4MB`）——
 *    base64 会胖 4/3：100MB 的整单 ≈ 133MB 传输量，body 上限 138MB 接得住，且仍小于 nginx 的
 *    300m；所以学生超了我们这档时看到的是**我们的中文原因**，不是一个裸 `PAYLOAD_TOO_LARGE`。
 *    ⚠️⚠️ 2026-10-02 修正一条**写错的注释/表格**（§82.2）：这里原来写"body 上限是
 *    maxUploadBytes() + 1MB = 201MB"——那是 **multipart** 路径（index.js:149）的闸，不是这条
 *    JSON 路径的；这条路径当时实际是默认 **24MB**，100MB 的业务上限因此从未真正生效
 *    （客户端实测 19.6MB 视频交不上，被 413）。现在默认值跟着本档走，env
 *    `RUNTIME_UPLOAD_BODY_LIMIT` 仍可显式覆盖。
 */
const MAX_UPLOAD_BYTES = (() => {
  const configured = Number(process.env.RUNTIME_UPLOAD_MAX_BYTES || 0);
  const wanted = Number.isFinite(configured) && configured > 0 ? configured : 64 * 1024 * 1024;
  // 下限 1MB：只是防"手滑填个 0/负数"；上限 200MB 跟住存储层的单文件上限。
  // ⚠️ 夹具（p119）要把它压小到 8MB 来验"我们的中文原因先说话"，所以下限不能是 16MB。
  return Math.max(1 * 1024 * 1024, Math.min(200 * 1024 * 1024, wanted));
})();

/**
 * 本档的整单字节上限，**导出给 index.js 推导传输层 body 上限**（2026-10-02）：
 * base64 胖 4/3，body 上限 = 本值 × 4/3 + 4MB 余量（封面 + JSON 转义）。
 * 顶到 200MB 时 body ≈ 271MB，仍小于 nginx 的 300m —— 三层阶梯保持"业务闸先说话"。
 */
export const runtimeUploadMaxBytes = MAX_UPLOAD_BYTES;

/** 封面的固定文件名（客户端截图上传时用这个名字，服务端靠它认封面）。 */
const COVER_FILE_NAME = 'cover.png';
/** 封面图上限：截图（1280×720 PNG）通常 100~400KB，给到 1.5MB 足够、也不至于让整包变胖。 */
const MAX_COVER_BYTES = Math.floor(1.5 * 1024 * 1024);

/**
 * 把客户端传上来的产物整理成与 `collectStudentDeliverable()` **同形**的一份。
 *
 * 为什么要严进：这是**学生自己机器**上的字节，平台对它们的唯一约束就是这里 ——
 * 文件名要平铺（`safeArtifactName` 是**拒绝**带路径的名字，不是悄悄改名，所以借 `../`
 * 写到别处这条路根本走不通）、主产物必须在清单里、总量要有上限。
 * 形状不对一律 400 并说清是哪一条，别让学生对着一个 500 猜。
 * @param body - `{ name, files: [{ name, content, binary }], cover?: { content } }`；`binary` 为真时 `content` 是 base64。
 */
function collectUploadedArtifacts(body) {
  const rawName = String(body?.name || '').trim();
  if (!rawName) throw errors.badRequest('请告诉平台哪一份是主产物（name）', 'RUNTIME_UPLOAD_NAME_REQUIRED');
  const entryName = safeArtifactName(rawName);
  const raw = Array.isArray(body?.files) ? body.files : [];
  if (!entryName) throw errors.badRequest('请告诉平台哪一份是主产物（name）', 'RUNTIME_UPLOAD_NAME_REQUIRED');
  if (!raw.length) throw errors.badRequest('没有收到任何作品文件', 'RUNTIME_UPLOAD_EMPTY');
  if (raw.length > MAX_UPLOAD_FILES) {
    throw errors.badRequest(`一次最多交 ${MAX_UPLOAD_FILES} 个文件`, 'RUNTIME_UPLOAD_TOO_MANY_FILES');
  }

  const files = [];
  const warnings = [];
  const seen = new Set();
  let total = 0;
  for (const item of raw) {
    const name = safeArtifactName(item?.name);
    if (!name) throw errors.badRequest(`文件名不合法：${String(item?.name || '').slice(0, 60)}`, 'RUNTIME_UPLOAD_BAD_NAME');
    if (seen.has(name)) throw errors.badRequest(`同一个文件名出现了两次：${name}`, 'RUNTIME_UPLOAD_DUPLICATE_NAME');
    seen.add(name);
    const binary = item?.binary === true;
    const content = String(item?.content ?? '');
    const bytes = binary ? Buffer.byteLength(content, 'base64') : Buffer.byteLength(content, 'utf8');
    total += bytes;
    if (total > MAX_UPLOAD_BYTES) {
      throw errors.badRequest(`作品太大了（上限 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`, 'RUNTIME_UPLOAD_TOO_LARGE');
    }
    files.push({ name, content, binary, bytes });
  }
  if (!seen.has(entryName)) {
    throw errors.badRequest('主产物不在文件清单里', 'RUNTIME_UPLOAD_ENTRY_MISSING');
  }
  // ⭐ **可选封面**（2026-09-27 加，用户口径：「纯代码的小作品也得有真封面」）：
  //    客户端在提交时截一张图（浏览器里跑出来的那一屏）随同上传，广场/我的作品就有一张**真封面**，
  //    而不是那张按类型画的占位插图。形状与 files 里的一项一致（base64），名字**固定** `cover.png`
  //    —— 服务端靠这个名字认封面（存好后在快照里标 `coverFileId`，各端取封面时优先用它）。
  //    ⚠️ 三条纪律：① **不拦提交**（封面是锦上添花，坏了只记一条 warning，别让学生交不上作品）；
  //    ② 名字撞主产物/已有文件就忽略封面；③ 大小计入总上限，另有自己的上限（MAX_COVER_BYTES）。
  let coverName = null;
  const coverContent = String(body?.cover && typeof body.cover === 'object' ? (body.cover.content || '') : '');
  if (coverContent) {
    if (seen.has(COVER_FILE_NAME)) {
      warnings.push(`封面文件名 ${COVER_FILE_NAME} 与作品里的文件重名，这次没带上封面`);
    } else {
      const coverBytes = Buffer.byteLength(coverContent, 'base64');
      if (coverBytes > MAX_COVER_BYTES) {
        warnings.push(`封面图太大（${Math.round(coverBytes / 1024)}KB，上限 ${Math.floor(MAX_COVER_BYTES / 1024)}KB），这次没带上封面`);
      } else if (total + coverBytes > MAX_UPLOAD_BYTES) {
        warnings.push('加上封面会超过整包上限，这次没带上封面');
      } else {
        files.push({ name: COVER_FILE_NAME, content: coverContent, binary: true, bytes: coverBytes });
        seen.add(COVER_FILE_NAME);
        total += coverBytes;
        coverName = COVER_FILE_NAME;
      }
    }
  }
  // `missing` 与服务器取产物那条路同义：这里由客户端自己保证，平台侧没有"没取到"的概念
  return { name: entryName, files, coverName, missing: [], warnings };
}

/**
 * 把一份产物清单落成一次作品提交（`/submit` 与 `/submit-upload` 共用）。
 *
 * 步骤：① 二进制存成学生的私有资产（主产物走 fileId、被引用的图走 URL 改写）；
 *       ② 文本产物落库并改写本地引用；③ 产物清单在这一刻定格（广场靠它认版本与图）。
 */
async function recordSubmissionFromArtifacts({ ctx, auth, orgId, classroom, collected }) {
  const submitStartedAt = Date.now();
  const entryFile = safeArtifactName(collected.name);
  const entryKind = kindForName(entryFile);
  if (!isSubmittableArtifactKind(entryKind)) {
    throw errors.badRequest('只有网页、PPT、Word 和 Excel 可以作为作品提交', 'VIBECODING_ARTIFACT_NOT_SUBMITTABLE');
  }

  const entryPayload = (collected.files || []).find((file) => file.name === collected.name) || null;
  if (!entryPayload) throw errors.conflict('取回来的产物里没有主产物', 'RUNTIME_DELIVERABLE_EMPTY');

  // ① 二进制文件（PPT/Word/Excel 的原文件、网页里的本地图）都存成**学生的私有资产**。
  //    主产物走 fileId（快照里那份产物直接指向它），被引用的素材走 URL 改写。
  const warnings = [...(Array.isArray(collected.warnings) ? collected.warnings : [])];
  const assetUrls = new Map();
  const embeddedImages = [];
  // HTML 引用过的**所有**本地素材（图/视频/音频…）。`embeddedImages` 是历史字段（PPT 那套按图片读），
  // 媒体这种非图片素材单独记一份 —— 三端（机构端/广场/分享页）的取件准入名单都要认它。
  const embeddedAssets = [];
  let entryFileId = null;
  let coverFileId = null;
  // ⭐ 2026-10-05（客户端报「21.7MB 作品要等几十秒」）：**整单只扫一次**。
  //    原来每个二进制文件各起一次非驻留扫描器（`clamscan` 每次冷启动 16–40 秒、重新加载 108MB 病毒库），
  //    3 个文件＝3 次；现在把所有待交字节收成一批一次扫完，并按 SHA256 复用已扫过的结果。
  //    生产已按运营口径把扫描关掉（`FILE_UPLOAD_SCANNER=off`）——这里仍然保留批次语义，
  //    将来重建扫描体系（clamd/worker）时不会退回"每文件一次"。
  const binaries = (collected.files || []).filter((file) => file.binary);
  const scanStartedAt = Date.now();
  const batchScan = await scanUploadBuffers(binaries.map((file) => Buffer.from(file.content, 'base64')));
  const scanMs = Date.now() - scanStartedAt;
  let storageMs = 0;
  for (const file of binaries) {
    const name = safeArtifactName(file.name);
    const mimeType = mimeForArtifact(name);
    if (!mimeType) {
      // 存不了的素材（少见格式）不拦提交，但要**说出来** —— 否则学生只会看到图裂了
      warnings.push(`素材 ${name} 的格式还不支持随作品提交，交上来的作品里它会是空的`);
      continue;
    }
    try {
      const assetStartedAt = Date.now();
      const asset = await storeStudentArtifactAsset({
        buffer: Buffer.from(file.content, 'base64'),
        mimeType,
        // ⚠️ 交给存储层的只有**文件名**：底层 `cleanFileName` 明确拒收带 `/` 的名字（那是文件系统那一层的白名单，
        //    别为了支持 `assets/hero.png` 去松它）。相对路径只活在我们自己的改写映射里（key = 全路径）。
        fileName: name.split('/').pop(),
        ownerUserId: auth.user.id,
        ownerOrgId: orgId,
        scan: batchScan,
      });
      storageMs += Date.now() - assetStartedAt;
      // key 用**全路径**：下面回写 HTML 时按它匹配 `src="assets/hero.png"`（与 normalizeLocalReference 同一套规矩）
      assetUrls.set(name, asset.url);
      if (name === entryFile) {
        // 主产物就是这份真文件：字节进 file_assets，快照里只记 fileId
        entryFileId = asset.id;
      } else if (name === collected.coverName) {
        // 客户端截的封面：不进 embedded*（那是"被 HTML 引用的素材"），单独标出来
        coverFileId = asset.id;
      } else {
        // 被 HTML 引用的本地素材：进快照的准入名单，老师端/广场/分享页那条代理才认它。
        // ⚠️ 图片同时进 `embeddedImages`（老字段，PPT 那套按图读），**所有**素材都进 `embeddedAssets` ——
        //    非图片（视频/音频）以前只记一句告警就丢，结果 HTML 里的视频在三端全是空播放器
        //    （用户 2026-09-30 报的「教师后台看作品里视频显示不出来」）。
        embeddedAssets.push({ fileId: asset.id });
        if (mimeType.startsWith('image/')) embeddedImages.push({ fileId: asset.id });
      }
    } catch (error) {
      warnings.push(`素材 ${name} 没能随作品存下来：${String(error.message || error).slice(0, 120)}`);
    }
  }

  // ② 文本产物落库，把指向那些素材的引用改写成私有下载地址
  const files = {};
  for (const file of collected.files || []) {
    const name = safeArtifactName(file.name);
    if (file.binary) continue;
    files[name] = assetUrls.size ? rewriteLocalReferences(file.content, name, assetUrls) : file.content;
  }
  // 主产物必须落到某一处：要么是文本快照里的一份，要么是存下来的那个真文件
  if (!entryFileId && !Object.hasOwn(files, entryFile)) throw errors.conflict('主产物没能落进作品快照', 'RUNTIME_DELIVERABLE_EMPTY');

  // ③ 产物清单在**这一刻定格**（广场靠它判断交上来的到底是哪一份、以及图片在哪）
  const now = new Date().toISOString();
  const artifacts = [];
  if (entryFileId) {
    artifacts.push({
      name: entryFile, kind: entryKind, bytes: Number(entryPayload.bytes || 0), revision: 1,
      updatedAt: now, fileId: entryFileId, generatedImages: [], attachmentImages: [], embeddedImages: [],
      embeddedAssets: [],
      // ⭐ 客户端截的封面（没有就是 null）：各端算封面时**优先用它**（见 lib.js 的 workCoverFromSnapshot
      //    与 public.js 的 VibeCoding 封面），这样纯代码作品在广场上也有一张真封面。
      coverFileId: coverFileId || null,
    });
  }
  for (const name of Object.keys(files)) {
    artifacts.push({
      name,
      kind: kindForName(name),
      bytes: Buffer.byteLength(files[name] || '', 'utf8'),
      revision: 1,
      updatedAt: now,
      fileId: null,
      generatedImages: [],
      attachmentImages: [],
      // 只有入口 HTML 上挂素材：与老链路 snapshotArtifacts 的规则一致（它只认入口那一份的配图）。
      // `embeddedAssets` = 入口 HTML 引用过的**所有**本地素材（图/视频/音频），`embeddedImages` 只是其中图片那半边。
      embeddedImages: name === entryFile ? embeddedImages : [],
      embeddedAssets: name === entryFile ? embeddedAssets : [],
      coverFileId: name === entryFile ? (coverFileId || null) : null,
    });
  }

  const conversation = await ensureRuntimeConversation({
    auth, lessonId: classroom.lesson_id || null, classSessionId: classroom.id,
    title: classroom.title || '创作环境',
  });
  const body = ctx.body || {};
  const title = body.title === undefined || String(body.title).trim() === ''
    ? String(conversation.title || '我的作品').slice(0, 60)
    : String(body.title).trim().slice(0, 60);
  const dbStartedAt = Date.now();
  const submission = await recordRuntimeSubmission({
    ctx, auth, conversation, entryFile, files, artifacts, title,
    description: String(body.description || '').slice(0, 1000),
  });
  const dbMs = Date.now() - dbStartedAt;
  // 拍平改名 / 丢了素材这些事要让学生看见 —— 提交成功了但作品缺了东西，比提交失败更糟。
  // ⭐ 2026-09-29（客户端契约《平台接口契约-zcode.md》「作品提交」）：除了 `warnings` / `missing`
  //    还要回 **`works`** —— 客户端拿它直接回显"这次交上来了哪几条"，省掉一次「我的作品」往返。
  //    形状与 `/api/student/works` 的 VIBECODING 条目**同一份投影**（`vibecodingWorkItem`）：
  //    两边各拼一份的话，客户端回显的条目和列表里的迟早对不上（本文件上面那条纪律同理）。
  //    ⚠️ 查不到那一条就给空数组 —— **不能**因此把一次已经成功的提交报成失败（与"封面失败不阻断"同一条纪律）。
  const submittedWork = submission?.id
    ? await runtimeSubmissionWorkItem(submission.id, { classSessionId: classroom.id })
    : null;
  // ⭐ 2026-10-05（客户端报「按钮长期处理中」，要求补分阶段耗时）：一行看清时间花在哪。
  //    `scan` 那档现在是 `disabled`（生产 FILE_UPLOAD_SCANNER=off）或 `PASSED/…`；
  //    真出问题时光看这一行就能判断是扫描、落盘还是数据库。
  const contentBytes = binaries.reduce((sum, file) => sum + Math.floor(String(file.content || '').length * 3 / 4), 0);
  const timings = {
    fileCount: binaries.length,
    contentBytes,
    jsonBytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
    scanMs, storageMs, dbMs,
    totalMs: Date.now() - submitStartedAt,
    scanStatus: batchScan.status,
    scanCached: batchScan.cached || 0,
  };
  console.log(`[submit-upload] files=${timings.fileCount} bytes=${timings.contentBytes} scan=${timings.scanStatus}(cached=${timings.scanCached}) scanMs=${timings.scanMs} storageMs=${timings.storageMs} dbMs=${timings.dbMs} totalMs=${timings.totalMs}`);
  return { ...submission, warnings, missing: collected.missing || [], works: submittedWork ? [submittedWork] : [], timings };
}
