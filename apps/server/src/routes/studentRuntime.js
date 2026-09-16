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
import { errors, requireRole, row } from '../lib.js';
import { collectStudentDeliverable, launchStudentRuntime, listStudentDeliverables, stopStudentRuntime, studentRuntimeAvailability } from '../services/studentRuntime.js';
import { isSubmittableArtifactKind, kindForName } from '../services/vibecodingArtifacts.js';
import { ensureRuntimeConversation, recordRuntimeSubmission, rewriteLocalReferences } from './vibecoding.js';
import { storeStudentArtifactAsset } from './fileAssets.js';

/** 这个学生现在该进哪个课堂：名单里 ACTIVE 且课堂 ACTIVE，最近的第一个。 */
function resolveActiveClassroom(studentId) {
  return row(
    `SELECT s.id, s.lesson_id, s.title
       FROM class_sessions s
       JOIN session_students p ON p.session_id = s.id
      WHERE p.student_id = ? AND p.status = 'ACTIVE' AND s.status = 'ACTIVE'
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
    const classroom = requireActiveClassroom(auth.user.id, '没有创作环境可看');
    return listStudentDeliverables({
      sessionId: classroom.id, studentId: auth.user.id, orgId, lessonId: classroom.lesson_id || null,
    });
  }

  // 交作品：把选中的那份取回来，按现有作品链路落库（广场/发布/机构查看全都读这张表）
  if (part === '/submit' && method === 'POST') {
    const classroom = requireActiveClassroom(auth.user.id, '没有创作环境可以交作品');
    const scope = { sessionId: classroom.id, studentId: auth.user.id, orgId, lessonId: classroom.lesson_id || null };
    // 与工作台那条路同一条规矩：提交即确认版权与展示授权，平台之后才能发到作品广场
    if (ctx.body?.copyrightConfirmed !== true) {
      throw errors.badRequest('提交前请确认作品版权与展示授权', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
    }

    const collected = await collectStudentDeliverable({ ...scope, name: ctx.body?.name });
    const entryFile = safeArtifactName(collected.name);
    const entryKind = kindForName(entryFile);
    if (!isSubmittableArtifactKind(entryKind)) {
      throw errors.badRequest('只有网页、PPT、Word 和 Excel 可以作为作品提交', 'VIBECODING_ARTIFACT_NOT_SUBMITTABLE');
    }

    const entryPayload = (collected.files || []).find((file) => file.name === collected.name) || null;
    if (!entryPayload) throw errors.conflict('取回来的产物里没有主产物', 'RUNTIME_DELIVERABLE_EMPTY');
    // 主产物是二进制时**现在还不收**：作品快照的 files 只能装规格文本，下载/预览也是按规格文本渲染的
    // （见 services/ooxml/documents.js 的取舍说明）。dsh 的 PPT 插件产出的是真 .pptx 字节，
    // 直接存进去会得到一个「存得下、下载出来是乱码」的作品。所以先把话说清楚，别悄悄收下一个坏作品。
    if (entryPayload.binary) {
      throw errors.badRequest(
        '这份作品的主产物是二进制文件（PPT/Word/Excel 的原文件）。现在的作品链路只支持网页作品，'
        + '要把 PPT 也交上来得先定「二进制产物怎么存、在作品广场怎么展示」这条口径。',
        'RUNTIME_DELIVERABLE_BINARY_UNSUPPORTED',
      );
    }

    // ① 先把二进制素材（网页里的本地图）存成学生的私有资产，拿到引用要改写成的地址
    const warnings = [...(Array.isArray(collected.warnings) ? collected.warnings : [])];
    const assetUrls = new Map();
    const embeddedImages = [];
    for (const file of collected.files || []) {
      if (!file.binary) continue;
      const name = safeArtifactName(file.name);
      const extension = name.split('.').pop()?.toLowerCase() || '';
      const mimeType = MIME_BY_EXTENSION[extension];
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
        embeddedImages.push({ fileId: asset.id });
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
    if (!Object.hasOwn(files, entryFile)) throw errors.conflict('主产物没能落进作品快照', 'RUNTIME_DELIVERABLE_EMPTY');

    // ③ 产物清单在**这一刻定格**（广场靠它判断交上来的到底是哪一份、以及图片在哪）
    const now = new Date().toISOString();
    const artifacts = Object.keys(files).map((name) => ({
      name,
      kind: kindForName(name),
      bytes: Buffer.byteLength(files[name] || '', 'utf8'),
      revision: 1,
      updatedAt: now,
      generatedImages: [],
      attachmentImages: [],
      // 只有入口 HTML 上挂图：与老链路 snapshotArtifacts 的规则一致（它只认入口那一份的配图）
      embeddedImages: name === entryFile ? embeddedImages : [],
    }));

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

  return null;
}
