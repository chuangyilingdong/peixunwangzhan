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
import { errors, requireRole, row, rows } from '../lib.js';
import { collectStudentDeliverable, launchStudentRuntime, listStudentDeliverables, runtimeGatewayUrl, stopStudentRuntime, studentRuntimeAvailability } from '../services/studentRuntime.js';
import { issueRuntimeKey } from './runtimeGateway.js';
import { vibecodingPresetPrompts, vibecodingSendLimit, vibecodingSendUsage } from '../services/vibecodingLessonSettings.js';
import { isSubmittableArtifactKind, kindForName } from '../services/vibecodingArtifacts.js';
import { documentMime } from '../services/ooxml/documents.js';
import { ensureRuntimeConversation, recordRuntimeSubmission, rewriteLocalReferences } from './vibecoding.js';
import { storeStudentArtifactAsset } from './fileAssets.js';

// 客户端运行时（dsh / VibeCoding）**只认 VIBECODING 课堂**。
//
// ⚠️ 2026-09-21（客户端项目报的）：这里的三个解析器原来都没有筛 `delivery_mode`，
//    于是**画布课堂也会被当成"你现在能进的课"下发** —— `client-context.classroom` 有值、
//    网关密钥照发，客户端看到 classroom != null 就打开 VibeCoding 环境。
//    客户端拿不到 deliveryMode 字段，它没法自己判断，所以**这道门禁必须在服务端**
//    （客户端只执行"平台下发的可进入结论"）。
const RUNTIME_DELIVERY_MODE = 'VIBECODING';
/** 「这节是不是客户端运行时的课」。 */
const isRuntimeClassroom = (session) => String(session?.delivery_mode || '').toUpperCase() === RUNTIME_DELIVERY_MODE;

/** 这个学生现在该进哪个课堂：名单里 ACTIVE 且课堂 ACTIVE、且是 VIBECODING 的，最近的第一个。 */
function resolveActiveClassroom(studentId) {
  return row(
    `SELECT s.id, s.lesson_id, s.title, s.delivery_mode
       FROM class_sessions s
       JOIN session_students p ON p.session_id = s.id
      WHERE p.student_id = ? AND p.status = 'ACTIVE' AND s.status = 'ACTIVE'
        AND s.delivery_mode = '${RUNTIME_DELIVERY_MODE}'
      ORDER BY s.started_at DESC, s.created_at DESC
      LIMIT 1`,
    [studentId],
  );
}

function requireActiveClassroom(studentId, what) {
  const classroom = resolveActiveClassroom(studentId);
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
function classroomContext(sessionId) {
  if (!sessionId) return null;
  const info = row(
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
function resolvePendingClassroom(studentId) {
  return row(
    `SELECT session.id, session.lesson_id, session.title, session.delivery_mode
       FROM class_sessions session
       JOIN session_students part ON part.session_id = session.id
      WHERE part.student_id = ? AND part.status = 'ACTIVE' AND session.status = 'PENDING'
        AND session.delivery_mode = '${RUNTIME_DELIVERY_MODE}'
      ORDER BY session.created_at DESC LIMIT 1`,
    [studentId],
  );
}

/**
 * 「你现在能进哪几节课 + 这次算哪一节」。
 *
 * 为什么会有"好几节"：口径上「一个学生全局最多属于一个未终态课堂」（docs/README.md），加人时也会被拒
 * （`IN_OTHER_SESSION`，守卫 p66/p78）—— 但**库里不一定干净**：种子/历史数据能绕过那条校验，
 * **线上实测就有一个学生同时挂着两场 ACTIVE 课堂**。而这里原来只取"最近开始的那一场"，
 * 于是学生做 A 课作业、拿到的却是 B 课的**次数上限与预设**，界面上还看不出任何异常。
 *
 * 所以：**候选全给出来**（客户端据此显示"你现在能进的课"），**选择可以被指定**
 * （`?sessionId=`，只认这个学生自己那几场 ACTIVE 的）；不指定时仍取最近一场 —— 老客户端不变。
 * 选的那节不可用（结束/被移除/不是他的）时**明说**，绝不默默换一节。
 *
 * 返回：`session` 保持库行形状（`id / lesson_id / title`，下游动作读它）、`classroom` 是给客户端看的
 * 同一节（带课包/课时/老师）、`candidates` 是全部候选（同形状）。
 */
function resolveClassroomEntry(studentId, requestedSessionId) {
  const raw = rows(
    `SELECT session.id, session.lesson_id, session.title, session.started_at, session.created_at, session.delivery_mode
       FROM class_sessions session
       JOIN session_students part ON part.session_id = session.id
      WHERE part.student_id = ? AND part.status = 'ACTIVE' AND session.status = 'ACTIVE'
      ORDER BY session.started_at DESC, session.created_at DESC`,
    [studentId],
  );
  const publicOf = (session) => ({
    id: session.id,
    lessonId: session.lesson_id || '',
    title: session.title,
    ...(classroomContext(session.id) || {}),
  });
  // ⭐ 候选**只放 VIBECODING 的**：画布课堂不该出现在"你现在能进的课"里（客户端会照单全收去开环境）。
  //    注意 raw 要保留全部（不带筛），否则"学生选的这节是画布课堂"这件事就看不出来了。
  const runtimeSessions = raw.filter(isRuntimeClassroom);
  const candidates = runtimeSessions.map(publicOf);
  const requested = String(requestedSessionId || '').trim();
  if (requested) {
    const hit = raw.find((item) => item.id === requested) || null;
    if (!hit) return { session: null, classroom: null, candidates, reason: 'CLASSROOM_NOT_AVAILABLE' };
    // 明确点名了一节画布课堂：**明说是类型不对，绝不默默换成另一节**（静默换课会把学生放到别的课上）。
    if (!isRuntimeClassroom(hit)) return { session: null, classroom: null, candidates, reason: 'CLASSROOM_MODE_MISMATCH' };
    return { session: hit, classroom: candidates.find((item) => item.id === hit.id) || null, candidates, reason: null };
  }
  const session = runtimeSessions[0] || null;
  return {
    session,
    classroom: session ? (candidates.find((item) => item.id === session.id) || null) : null,
    candidates,
    // 没有可进的 VIBECODING 课，但他**正在一节画布课上** → 说清是类型不对（不是"老师没开始上课"）
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
function requireSelectedClassroom(ctx, studentId, what, mismatch = '') {
  const entry = resolveClassroomEntry(studentId, ctx.search.get('sessionId') || ctx.body?.sessionId);
  if (!entry.session) {
    if (entry.reason === 'CLASSROOM_MODE_MISMATCH') {
      throw errors.forbidden(mismatch || '当前是画布课堂，不能在 VibeCoding 创作环境里做这个操作', 'RUNTIME_NO_ACTIVE_CLASSROOM');
    }
    const prefix = entry.reason === 'CLASSROOM_NOT_AVAILABLE' ? '你选的那节课已经结束了，' : '你现在没有正在上的课堂，';
    throw errors.forbidden(`${prefix}${what}`, 'RUNTIME_NO_ACTIVE_CLASSROOM');
  }
  return entry.session;
}


/** 文件名的尺度与现有产物一致：**平铺**（不带路径分隔符）。叫得出来、能当 URL 段。 */
function safeArtifactName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 100 || /[\\/\0]/.test(name) || name.includes('..') || name.startsWith('.')) {
    throw errors.badRequest(`作品里的文件名不合法：${name || '(空)'}`, 'INVALID_ARTIFACT_NAME');
  }
  return name;
}

/** 二进制素材的 MIME：只列我们真的会遇到的（storeStudentArtifactAsset 还会再验一次魔术字节）。 */
const MIME_BY_EXTENSION = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
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
  const auth = requireRole(ctx, ['STUDENT']);
  const part = pathname.slice('/api/student/runtime'.length);
  const orgId = auth.session?.org_id || auth.user.orgId;

  if (part === '/status' && method === 'GET') {
    const availability = studentRuntimeAvailability();
    const classroom = resolveActiveClassroom(auth.user.id);
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
  //   · ⭐ **`classrooms` 列出"你现在能进的课"，并接受 `?sessionId=` 指定**：
  //     口径上「一个学生全局最多属于一个未终态课堂」（docs/README.md）、加人时也会被拒
  //     （`IN_OTHER_SESSION`，p66/p78）——**但库里不一定干净**：线上实测就有一个学生同时挂着
  //     两场 ACTIVE 课堂（种子/历史数据绕过了校验）。以前这里只取"最近开始的那一场"，
  //     于是学生做 A 课作业、拿到的却是 B 课的上限与预设，界面上看不出任何异常。
  //     现在：多于一节时客户端**让学自己选**（选哪节，预设/次数上限/密钥就按哪节走）。
  //     不传 `sessionId` 时行为与以前一致（最近一场），老客户端不会坏。
  if (part === '/client-context' && method === 'GET') {
    const entry = resolveClassroomEntry(auth.user.id, ctx.search.get('sessionId'));
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
      const pending = resolvePendingClassroom(auth.user.id);
      const pendingInfo = pending ? (classroomContext(pending.id) || {}) : null;
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
    const limit = vibecodingSendLimit(lessonId);
    // ⚠️ 对外报的已用次数**封顶到上限**：库里存的是"观察到的发送次数最大值"（判据靠它，压缩也不会刷新
    //    额度），但给学生/老师看的是"用了几次／共几次"，所以这里取 min。见 vibecodingLessonSettings.js。
    const usedRaw = vibecodingSendUsage({ sessionId: classroom.id, studentId: auth.user.id });
    const used = limit === null ? usedRaw : Math.min(usedRaw, limit);
    return {
      // 课包/课时/老师一起给学生：预设与次数上限都是**按课时**配的，客户端要能显示"这是哪节课的"。
      classroom,
      classrooms: entry.candidates,
      reason: null,
      gateway: { baseUrl: runtimeGatewayUrl(), key: issueRuntimeKey({ orgId, userId: auth.user.id, sessionId: classroom.id, lessonId }) },
      presets: vibecodingPresetPrompts(lessonId),
      sends: { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) },
    };
  }

  if (part === '/launch' && method === 'POST') {
    const classroom = requireActiveClassroom(auth.user.id, '没有创作环境可以开');
    const launched = await launchStudentRuntime({
      sessionId: classroom.id,
      studentId: auth.user.id,
      orgId,
      lessonId: classroom.lesson_id || null,
    });
    return launched;
  }

  if (part === '/stop' && method === 'POST') {
    const classroom = requireActiveClassroom(auth.user.id, '没有环境可以收');
    return stopStudentRuntime({ sessionId: classroom.id, studentId: auth.user.id });
  }

  // 我这个创作环境里现在有哪些东西可以当作品交（读工作区；不改动任何文件）
  if (part === '/deliverables' && method === 'GET') {
    const classroom = requireSelectedClassroom(ctx, auth.user.id, '没有创作环境可看', '当前是画布课堂，没有 VibeCoding 创作环境可看');
    return listStudentDeliverables({
      sessionId: classroom.id, studentId: auth.user.id, orgId, lessonId: classroom.lesson_id || null,
    });
  }

  // 交作品：把选中的那份取回来，按现有作品链路落库（广场/发布/机构查看全都读这张表）
  if (part === '/submit' && method === 'POST') {
    const classroom = requireSelectedClassroom(ctx, auth.user.id, '没有创作环境可以交作品', '当前是画布课堂，不能提交 VibeCoding 作品');
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
  // ⚠️ 二进制用 base64 装在 JSON 里：body 上限是 `maxUploadBytes() + 1MB`（见 index.js），
  //    默认 25MB 文件 → 约 33MB 传输量，够学生交 PPT；超了会在这里明确报错而不是静默截断。
  if (part === '/submit-upload' && method === 'POST') {
    const classroom = requireSelectedClassroom(ctx, auth.user.id, '没有创作环境可以交作品', '当前是画布课堂，不能提交 VibeCoding 作品');
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
 * 解出来的字节总量上限（base64 解回来之后的**真实**大小）。
 *
 * ⚠️ 这个数必须**小于传输层的上限**才会先于它报错：`index.js` 给 body 的上限是
 *    `maxUploadBytes() + 1MB`（默认 26MB），而 base64 会胖 4/3 —— 于是单个文件超过约
 *    19MB 时请求根本进不来（框架先给一个 `PAYLOAD_TOO_LARGE`）。取 16MB 的意思是：
 *    「大到不像学生作品」的那一段由我们把话说清楚（学生看到的是中文原因，不是一个裸 413），
 *    再大才轮到传输层。
 */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/**
 * 把客户端传上来的产物整理成与 `collectStudentDeliverable()` **同形**的一份。
 *
 * 为什么要严进：这是**学生自己机器**上的字节，平台对它们的唯一约束就是这里 ——
 * 文件名要平铺（`safeArtifactName` 是**拒绝**带路径的名字，不是悄悄改名，所以借 `../`
 * 写到别处这条路根本走不通）、主产物必须在清单里、总量要有上限。
 * 形状不对一律 400 并说清是哪一条，别让学生对着一个 500 猜。
 * @param body - `{ name, files: [{ name, content, binary }] }`；`binary` 为真时 `content` 是 base64。
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
  // `missing` 与服务器取产物那条路同义：这里由客户端自己保证，平台侧没有"没取到"的概念
  return { name: entryName, files, missing: [], warnings: [] };
}

/**
 * 把一份产物清单落成一次作品提交（`/submit` 与 `/submit-upload` 共用）。
 *
 * 步骤：① 二进制存成学生的私有资产（主产物走 fileId、被引用的图走 URL 改写）；
 *       ② 文本产物落库并改写本地引用；③ 产物清单在这一刻定格（广场靠它认版本与图）。
 */
async function recordSubmissionFromArtifacts({ ctx, auth, orgId, classroom, collected }) {
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
  let entryFileId = null;
  for (const file of collected.files || []) {
    if (!file.binary) continue;
    const name = safeArtifactName(file.name);
    const mimeType = mimeForArtifact(name);
    if (!mimeType) {
      // 存不了的素材（少见格式）不拦提交，但要**说出来** —— 否则学生只会看到图裂了
      warnings.push(`素材 ${name} 的格式还不支持随作品提交，交上来的作品里它会是空的`);
      continue;
    }
    try {
      const asset = await storeStudentArtifactAsset({
        buffer: Buffer.from(file.content, 'base64'),
        mimeType,
        fileName: name,
        ownerUserId: auth.user.id,
        ownerOrgId: orgId,
      });
      assetUrls.set(name, asset.url);
      if (name === entryFile) {
        // 主产物就是这份真文件：字节进 file_assets，快照里只记 fileId
        entryFileId = asset.id;
      } else if (mimeType.startsWith('image/')) {
        // 被 HTML 引用的图：进快照的准入名单，发布后广场那条公开代理才认它
        embeddedImages.push({ fileId: asset.id });
      } else {
        warnings.push(`素材 ${name} 不是图片，发布到作品广场后可能取不到（广场只代理图片素材）`);
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
      // 只有入口 HTML 上挂图：与老链路 snapshotArtifacts 的规则一致（它只认入口那一份的配图）
      embeddedImages: name === entryFile ? embeddedImages : [],
    });
  }

  const conversation = ensureRuntimeConversation({
    auth, lessonId: classroom.lesson_id || null, classSessionId: classroom.id,
    title: classroom.title || '创作环境',
  });
  const body = ctx.body || {};
  const title = body.title === undefined || String(body.title).trim() === ''
    ? String(conversation.title || '我的作品').slice(0, 60)
    : String(body.title).trim().slice(0, 60);
  const submission = recordRuntimeSubmission({
    ctx, auth, conversation, entryFile, files, artifacts, title,
    description: String(body.description || '').slice(0, 1000),
  });
  // 拍平改名 / 丢了素材这些事要让学生看见 —— 提交成功了但作品缺了东西，比提交失败更糟
  return { ...submission, warnings, missing: collected.missing || [] };
}
