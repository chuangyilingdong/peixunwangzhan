import { ApiError, audit, count, errors, id, json, normalizeUser, nowIso, parseJson, q, requireRole, row, rows, transaction } from '../lib.js';
import { resolveProjectUsageContext } from '../services/studentContext.js';
import { generationProviderInfo, getGenerationProvider } from '../services/generationProvider.js';
import { assertExternalAiAllowed, assertProviderCapability, normalizeProviderError, PROVIDER_ERROR_CODES } from '../services/providerContract.js';
import { getAiProviderPolicy, isModalityEnabled } from './billingConfig.js';
import { effectiveCapabilities, acceptsFirstFrame, acceptsLastFrame, requestTemplateFor } from '../services/modelCapabilities.js';
import { PUBLIC_SITE_URL } from '../config.js';
import { assertSessionAiControls } from '../services/aiControls.js';
import { recordAiUsage } from '../services/creditUsage.js';
import { assertTransition } from '../services/domainState.js';
import { applyGatewayRoute } from '../services/computeGateway.js';
import { priceFenFor, salePriceFenSuccessSql } from '../services/computePool.js';
// 2026-09-18（用户口径）：`services/courseCuLedger.js` 已**整体删除** —— 那套课包 CU 额度
// （`reserveCourseCu/settleCourseCu/releaseCourseCu`）的 `cu_limit` 全仓无人写，恒 `UNLIMITED`、
// 两张 `student_course_cu_*` 表永远是空的。学生算力额度现在**只有一套、且只观测不拦人**：
// `services/sessionCostCap.js`（每学生 × 每场课堂的消耗观测，`enforced` 恒 false）。
// 这个路由**不再调用它** —— 额度不进生成链路（用户口径：额度是内部看的，不真拦）。

/** 项目归属的课包 id（报表分组用）。失败路径上没有 context，所以这里按课时回查一次。 */
function seriesIdOf(project) {
  if (!project?.course_lesson_id) return null;
  return row('SELECT series_id FROM course_lessons WHERE id=?', [project.course_lesson_id])?.series_id || null;
}

const MODALITIES = new Set(['TEXT', 'IMAGE', 'MUSIC', 'VIDEO']);
const MODALITY_LABELS = {
  TEXT: '灵感提示词', IMAGE: '画面素材', MUSIC: '音乐素材',
  VIDEO: '故事短片',
};
/** 网关说「额度用尽」：这是本学生在这节课的钱花完了，不是故障，重试没有意义。 */
const isQuotaExhausted = (code) => String(code || '') === PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED;
const SESSION_CAPABILITY_BY_MODALITY = { IMAGE: 'allowImage', MUSIC: 'allowMusic', VIDEO: 'allowVideo' };
const LESSON_CAPABILITY_BY_MODALITY = { TEXT: 'text', IMAGE: 'image', VIDEO: 'video', MUSIC: 'music' };
// 业务侧「拦在调用前」的错误码：这些不是上游故障，是课堂/能力政策，记 BLOCKED 不是 FAILED。
// 2026-09-18：`SESSION_STUDENT_CALL_CAP`（按**次数**的课堂上限）已退役。
// 同日更正（用户口径）：「学生算力额度只观测、不真拦」—— 一度加过的那个
// 「额度已用完」错误码也**一并删除**（额度不再是任何一条拦截理由，学生端也不显示它）。
// 所以这张表里现在**没有任何额度类错误码**，别再往里加。
const BLOCKED_ERROR_CODES = new Set(['SESSION_AI_PAUSED', 'SESSION_CAPABILITY_DISABLED', 'GENERATION_FIRST_FRAME_REQUIRED', 'MODALITY_DISABLED']);
const GENERATION_PAGE_SIZE = 20;
const asyncGenerationQueue = [];
let asyncGenerationWorkerRunning = false;
// Seedance video tasks can remain queued for several minutes before the
// provider exposes the final URL. Keep the job alive long enough for normal
// queue latency instead of reporting a false generation failure at 120s.
const ASYNC_GENERATION_TIMEOUT_MS = 300000;
const ASYNC_GENERATION_MAX_RETRIES = 2;
const ASYNC_WORKER_ID = `ai-worker-${process.pid}-${id('w').slice(-8)}`;
const ASYNC_RUNNING_LEASE_MS = ASYNC_GENERATION_TIMEOUT_MS + 30000;
export const AI_MODALITIES = [...MODALITIES];

function modalityOf(value) {
  const modality = String(value || 'IMAGE').trim().toUpperCase();
  if (!MODALITIES.has(modality)) throw errors.badRequest('不支持的素材类型', 'UNSUPPORTED_MODALITY');
  return modality;
}

function ownProject(auth, projectId) {
  // 批次 D：原来的 class.name 取自班级表（class_id 现在恒为 NULL，取了也是空）——
  // 换成**课堂**名（student_projects.class_session_id 指向他进的那个课堂）。
  const project = row(`SELECT project.*, lesson.title AS lesson_title, series.title AS series_title, session.title AS session_title
     FROM student_projects project
     LEFT JOIN course_lessons lesson ON lesson.id = project.course_lesson_id
     LEFT JOIN course_series series ON series.id = lesson.series_id
     LEFT JOIN class_sessions session ON session.id = project.class_session_id
     WHERE project.id = ? AND project.student_id = ? AND project.org_id = ?
       AND project.deleted_at IS NULL AND project.status != 'ARCHIVED'`,
    [projectId, auth.user.id, (auth.session?.org_id || auth.user.orgId)]);
  if (!project) throw errors.notFound('项目不存在', 'PROJECT_NOT_FOUND');
  return project;
}

function packageForUser(user, orgId) {
  return user.billing_package_id ? row('SELECT * FROM billing_packages WHERE id = ? AND org_id = ?', [user.billing_package_id, orgId]) : null;
}

// 2026-09-16：删掉「套餐能力」这一层 —— 套餐不再参与「能不能用某个 AI 能力」的判定。
// 现在只看：平台模态开关 + 课堂开放的能力 + 课时开放的能力（后面几条在各自的函数里）。
function assertCapability(modality, session) {
  const sessionCapability = SESSION_CAPABILITY_BY_MODALITY[modality];
  if (!sessionCapability) return;
  if (session && session.capabilities && !session.capabilities[sessionCapability]) throw errors.forbidden('当前课堂未开放该 AI 能力', 'SESSION_CAPABILITY_DISABLED');
}

/**
 * 课时生成框体：每个框体单独配模型与生成参数，学生端按顺序逐个生成、每个框体只能生成一次。
 * 本课该模态没有配框体时不限制（未配置=不限制），配了就必须从框体发起，否则参数与计数都无从对应。
 */
export function resolveLessonGenerationBox(context, modality, boxId) {
  const key = String(modality || '').toUpperCase();
  const boxes = Array.isArray(context?.lesson?.generationBoxes) ? context.lesson.generationBoxes : [];
  const wanted = String(boxId || '').trim();
  if (wanted) {
    const box = boxes.find((item) => item.id === wanted);
    if (!box) throw errors.badRequest('生成框体不存在或已不属于本课', 'GENERATION_BOX_NOT_FOUND');
    if (box.modality !== key) throw errors.badRequest('生成框体类型与请求的素材类型不一致', 'GENERATION_BOX_MODALITY_MISMATCH');
    return box;
  }
  if (!boxes.some((box) => box.modality === key)) return null;
  throw errors.forbidden('请从课时配置的生成框体发起生成', 'GENERATION_BOX_REQUIRED');
}

// 每个框体只能成功生成一次；同一框体的在途任务也算占用（并发点击不会重复扣费）。
function assertBoxNotGenerated({ projectId, boxId, excludeJobId = '' }) {
  if (!projectId || !boxId) return;
  const inflight = count("SELECT COUNT(*) n FROM generation_jobs WHERE project_id=? AND box_id=? AND status IN ('QUEUED','RUNNING') AND id != ?", [projectId, boxId, excludeJobId || '']);
  const generated = count('SELECT COUNT(*) n FROM media_assets asset JOIN generation_jobs job ON job.id=asset.job_id WHERE asset.project_id=? AND job.box_id=?', [projectId, boxId]);
  if (Number(inflight || 0) + Number(generated || 0) > 0) throw errors.forbidden('该生成框体已经生成过了', 'GENERATION_BOX_USED');
}

/** 框体占用守卫：供生成链路与扣费类端点共用，保证同一套判断。 */
export function assertLessonGenerationBox({ context, modality, projectId, boxId, excludeJobId = '' }) {
  const box = resolveLessonGenerationBox(context, modality, boxId);
  if (box) assertBoxNotGenerated({ projectId, boxId: box.id, excludeJobId });
  return box;
}

/**
 * 视频的「输入画面」按模型声明的方式放行：模型支持多种方式时，学生给什么就用什么，
 * 不再二选一强制（MiniMax-H3 这类文生/图生/首尾帧都支持的模型，以前只能二选一）。
 */
function assertVideoFrames({ modes, firstFrameUrl = '', lastFrameUrl = '', referenceAssets = [], requestedFrames = false }) {
  const list = Array.isArray(modes) && modes.length ? modes : ['TEXT'];
  const hasFirst = Boolean(String(firstFrameUrl || '').trim());
  const hasLast = Boolean(String(lastFrameUrl || '').trim());
  const references = (Array.isArray(referenceAssets) ? referenceAssets : []).filter((item) => item && item.url);
  const acceptsOmni = list.includes('OMNI_REFERENCE');
  // 上游 MiniMax V2：图生（首/尾帧）与多素材参考互斥，不能混用。
  if (references.length && (hasFirst || hasLast || requestedFrames)) throw errors.badRequest('图生视频与全能参考不能混用：请只选一种输入方式', 'GENERATION_MIXED_INPUT_MODES');
  if (references.length && !acceptsOmni) throw errors.forbidden('当前视频模型不支持多素材参考', 'GENERATION_REFERENCES_UNSUPPORTED');
  if (hasLast && !hasFirst) throw errors.badRequest('尾帧要配合首帧一起用：请先连接一张首帧图', 'GENERATION_LAST_FRAME_WITHOUT_FIRST');
  if (hasFirst && !acceptsFirstFrame(list)) throw errors.forbidden('当前视频模型不支持图片输入，请去掉连接/预置的画面', 'GENERATION_FIRST_FRAME_UNSUPPORTED');
  if (hasLast && !acceptsLastFrame(list)) throw errors.forbidden('当前视频模型不支持尾帧，请去掉第二张连线图片', 'GENERATION_LAST_FRAME_UNSUPPORTED');
  // 模型不支持纯文本（i2v 类）时必须有画面输入，否则上游必然拒绝。
  if (!hasFirst && !references.length && !list.includes('TEXT')) throw errors.forbidden('当前视频模型需要先连接一张画面（首帧）再生成', 'GENERATION_FIRST_FRAME_REQUIRED');
}

/**
 * 调用上游之前的预检：课时能力 / 课堂管控 / 套餐能力任一不满足就直接拒绝。
 * 否则会先花钱调一次上游、再在结算时失败并进入重试，重复消耗额度。
 * 结算时仍会再校验一次（异步任务等待期间状态可能变化）。
 */
/**
 * 生成前的门禁：课时能力 / 课堂开关 / 平台模态开关。
 *
 * 导出是**故意**的：VibeCoding 的文档插画（services/vibecodingIllustrations.js）也要走同一套 ——
 * 复制一份迟早会漏掉某条检查，那就等于给文档产物开了一条绕过能力开关的后门。
 * `projectId` 可省：省掉就跳过「框体占用」那条纯画布规则。
 * `model` / `units` 是给算力池算钱用的（单价按模型或模态取；units = 这次要花的次数，
 * 文档插画一次生成 3 张就是 3）。
 */
export function assertGenerationPreflight({ user, orgId, context, modality, projectId = null, boxId = '', excludeJobId = '', frameCheck = null, model = '', units = 1 }) {
  assertCapability(modality, context.activeSession);
  assertSessionAiControls({ modality, session: context.activeSession, orgId, userId: user.id });
  // 2026-09-18（用户口径）：「学生算力额度只观测、不真拦」—— 这里原来有一行
  // 额度断言（按钱的课堂上限，超了抛 403）。**已删除**：额度不再进生成链路。
  // 观测值仍在（老师端/平台端看得到），但没有任何调用会被它挡住。
  // ⚠️ 别把额度断言加回来当闸门 —— 要拦人得先有用户口径，并连同学生端文案、守卫一起改。
  // 平台模态开关（机构覆盖优先）必须真正拦住调用，不能只影响展示
  if (!isModalityEnabled(orgId, modality).enabled) throw errors.forbidden('平台已关闭该 AI 能力', 'MODALITY_DISABLED');
  const lessonCapability = LESSON_CAPABILITY_BY_MODALITY[modality];
  if (lessonCapability && !(context.lesson?.capabilities || []).includes(lessonCapability)) {
    throw errors.forbidden('本课时未开放该 AI 能力', 'LESSON_CAPABILITY_DISABLED');
  }
  // ⚠️ 「输入画面」这套规则**只对视频成立**（首帧/尾帧/全能参考互斥、必须有画面…）。
  // 图片也会带参考图，而且从 2026-09-17 起图片的 referenceAssets 真的会进 options ——
  // 不限定模态的话，视频这套判据会把图片请求按视频规则拒掉
  // （实测：图片带参考图报「当前视频模型不支持多素材参考」，403）。
  if (frameCheck && String(modality || '').toUpperCase() === 'VIDEO') assertVideoFrames(frameCheck);
  // 框体占用同样属于业务拦截：入队前就能判断，不必等结算
  if (projectId) assertLessonGenerationBox({ context, modality, projectId, boxId, excludeJobId });
}

function normalizeAsset(value) {
  let metadata = {};
  try { metadata = JSON.parse(value.metadata || '{}'); } catch { metadata = {}; }
  return {
    id: value.id, jobId: value.job_id, projectId: value.project_id, modality: value.modality,
    label: value.label, mimeType: value.mime_type || null, assetUrl: value.asset_url,
    previewUrl: value.preview_url || null, metadata, createdAt: value.created_at,
  };
}

function normalizeJob(value, { assets = [] } = {}) {
  if (!value) return null;
  return {
    id: value.id, projectId: value.project_id, projectTitle: value.project_title || null,
    courseLessonId: value.course_lesson_id || null, courseLessonTitle: value.lesson_title || null,
    // 批次 D：原来是 className（班级名，恒空）→ 换成他进的那个课堂名
    sessionTitle: value.session_title || null, modality: value.modality,
    boxId: value.box_id || null,
    modalityLabel: MODALITY_LABELS[value.modality] || value.modality,
    provider: value.provider, model: value.model, prompt: value.prompt, status: value.status,
    retryOfJobId: value.retry_of_job_id || null, retryCount: Number(value.retry_count || 0), maxRetries: Number(value.max_retries ?? ASYNC_GENERATION_MAX_RETRIES),
    errorCode: value.error_code || null, errorMessage: value.error_message || null,
    createdAt: value.created_at, startedAt: value.started_at || null, completedAt: value.completed_at || null,
    assets,
  };
}

function assetsFor(jobId) {
  return rows('SELECT * FROM media_assets WHERE job_id = ? ORDER BY created_at DESC', [jobId]).map(normalizeAsset);
}

function jobQuery() {
  return `SELECT job.*, project.title AS project_title, project.course_lesson_id,
                 lesson.title AS lesson_title, session.title AS session_title
          FROM generation_jobs job
          LEFT JOIN student_projects project ON project.id = job.project_id
          LEFT JOIN course_lessons lesson ON lesson.id = project.course_lesson_id
          LEFT JOIN class_sessions session ON session.id = project.class_session_id`;
}

function jobDetail(jobId, { requireAuth = null } = {}) {
  const job = row(jobQuery() + ' WHERE job.id = ?', [jobId]);
  if (!job) return null;
  if (requireAuth && (job.org_id !== requireAuth.user.orgId || job.user_id !== requireAuth.user.id)) return null;
  return normalizeJob(job, { assets: assetsFor(job.id) });
}

/**
 * 图生视频模型的首帧来源：只认本项目已有的图片素材。
 * 客户端传的是 assetUrl，这里回查 media_assets 确认归属，避免任意外部 URL 被送进上游。
 */
// 站内相对地址（老师上传的素材是 /api/student/file-assets/<id>/download）上游抓不到，
// 只要这个文件是「公开可见」的，就换成绝对地址的公开下载链接再发；不可公开的一律拒绝。
function publicFileAssetUrl(value) {
  const url = String(value || '').trim();
  const match = url.match(/^\/api\/(?:student|public)\/file-assets\/([^/]+)\/download$/);
  if (!match) return '';
  const file = row('SELECT id,status,visibility,category,expires_at FROM file_assets WHERE id=?', [match[1]]);
  if (!file || file.status !== 'ACTIVE') return '';
  if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) return '';
  if (file.category === 'TEACHING_ASSET') return '';
  if (file.visibility !== 'PUBLIC_PLATFORM' && file.visibility !== 'PUBLIC_RELEASE') return '';
  return `${String(PUBLIC_SITE_URL || '').replace(/\/+$/, '')}/api/public/file-assets/${file.id}/download`;
}

// 生成用的画面/参考来源：已是绝对地址（生成素材、data URL、本地 mock）直接用，
// 否则尝试升级成公开绝对地址（老师上传的素材走这条）。
function resolvableAssetUrl(value) {
  const url = String(value || '').trim();
  if (!url || url.length > 2000) return '';
  if (/^(https?:\/\/|data:|mock:\/\/)/i.test(url)) return url;
  return publicFileAssetUrl(url);
}

function resolveFirstFrameUrl(projectId, sourceAssetUrl) {
  const url = String(sourceAssetUrl || '').trim();
  if (!url || url.length > 2000) return '';
  const asset = row("SELECT asset_url FROM media_assets WHERE project_id = ? AND modality = 'IMAGE' AND asset_url = ?", [projectId, url]);
  if (asset) return String(asset.asset_url);
  return publicFileAssetUrl(url);
}

// 描述生音乐：平台先用文本模型把学生的描述写成歌词，再交给音乐模型。
// 这一步不额外扣积分（用户口径：积分模式还没做），失败就让任务失败并说明原因。
const LYRICS_SYSTEM_PROMPT = [
  '你是少儿音乐平台的作词助手。把用户的一句话描述写成适合儿童演唱的中文歌词。',
  '要求：语言简单、正向、有画面感；不要出现暴力、恐怖、成人或广告内容。',
  '只输出歌词本身，不要解释、不要 markdown；用 [Verse] / [Chorus] 标注段落，控制在 3000 字以内。',
].join('');

async function writeLyricsForMusic({ prompt, policy, requestContext = null, auth = null, lessonId = '' }) {
  const description = String(prompt || '').trim();
  if (!description) throw errors.badRequest('请先写下你想要的音乐是什么样子', 'GENERATION_PROMPT_REQUIRED');
  // 作词这一步也是学生在花算力，所以同样按他的令牌走网关（没有 auth 的调用点保持直连）。
  const baseSelection = providerSelectionForModality(policy, 'TEXT');
  const selection = auth
    ? await applyGatewayRoute(baseSelection, { orgId: (auth.session?.org_id || auth.user.orgId), studentId: auth.user.id, lessonId, modality: 'TEXT' })
    : baseSelection;
  const provider = getGenerationProvider(selection);
  try {
    const generated = await provider.generate({
      modality: 'TEXT',
      prompt: description,
      title: '歌词',
      messages: [
        { role: 'system', content: LYRICS_SYSTEM_PROMPT },
        { role: 'user', content: `请根据这个描述写一段歌词：${description}` },
      ],
    });
    const text = String(generated?.assets?.[0]?.metadata?.text || '').trim();
    if (!text) throw Object.assign(new Error('作词没有返回内容'), { code: 'GENERATION_EMPTY_RESULT' });
    return text.slice(0, 3000);
  } catch (error) {
    const normalized = normalizeProviderError(error);
    throw errors.badRequest(`平台作词失败：${normalized.message}`, normalized.code || 'LYRICS_GENERATION_FAILED');
  }
}

// 全能参考的素材：只认本项目对应模态的素材（和首帧同一套白名单思路）。
// 上游限制：图片 ≤9、视频 ≤3、音频 ≤3。
const REFERENCE_LIMITS = Object.freeze({ IMAGE: 9, VIDEO: 3, AUDIO: 3 });
const REFERENCE_MODALITIES = Object.freeze({ IMAGE: ['IMAGE'], VIDEO: ['VIDEO'], AUDIO: ['MUSIC'] });

function normalizeReferenceType(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'IMAGE' || text === 'VIDEO' || text === 'AUDIO') return text;
  return '';
}

function resolveReferenceAssets(projectId, value) {
  // 新格式 [{ type, url }]；老格式（字符串数组）按图片处理。
  const list = Array.isArray(value) ? value : [];
  const counts = { IMAGE: 0, VIDEO: 0, AUDIO: 0 };
  const out = [];
  for (const item of list) {
    const raw = typeof item === 'string' ? { type: 'IMAGE', url: item } : (item && typeof item === 'object' ? item : null);
    if (!raw) continue;
    const type = normalizeReferenceType(raw.type) || 'IMAGE';
    const url = String(raw.url || '').trim();
    if (!url || counts[type] >= REFERENCE_LIMITS[type]) continue;
    const allowed = row(
      `SELECT asset_url FROM media_assets WHERE project_id=? AND asset_url=? AND modality IN (${REFERENCE_MODALITIES[type].map(() => '?').join(',')})`,
      [projectId, url, ...REFERENCE_MODALITIES[type]],
    );
    const resolved = allowed ? String(allowed.asset_url) : publicFileAssetUrl(url);
    if (!resolved) continue;
    counts[type] += 1;
    out.push({ type, url: resolved });
  }
  return out;
}

function createJobRecord({ auth, project, modality, provider, prompt, retryOfJobId = null, requestContext = null, startImmediately = true, sourceAssetUrl = null, lastFrameAssetUrl = null, referenceAssetUrls = null, boxId = '', requestOptions = null, selection = null }) {
  const jobId = id('generation');
  const now = nowIso();
  // 对外售价观测：快照里的 unitFen 是「按当前公告价算出的售价」，只观测、不扣学生
  // （charged 恒 false，学生账本 usage_records.cost_fen/credits_charged 恒 0）。
  const saleSnapshot = { modality, model: provider.model, unitFen: priceFenFor({ modality, model: provider.model }), charged: false, baseline: 'OBSERVATION_ONLY', basis: 'OBSERVATION_ONLY', capturedAt: now, route: selection ? { ...selection, apiKey: undefined, gateway: undefined, backup: selection.backup ? { ...selection.backup, apiKey: undefined, gateway: undefined } : undefined } : null };
  transaction(() => q(`INSERT INTO generation_jobs(
       id,org_id,user_id,project_id,modality,provider,model,prompt,status,retry_of_job_id,created_at,started_at,source_asset_url,last_frame_asset_url,reference_asset_urls,box_id,request_options
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [jobId, (auth.session?.org_id || auth.user.orgId), auth.user.id, project.id, modality, provider.name, provider.model, prompt, 'QUEUED', retryOfJobId, now, null, sourceAssetUrl, lastFrameAssetUrl, Array.isArray(referenceAssetUrls) && referenceAssetUrls.length ? JSON.stringify(referenceAssetUrls) : null, boxId || null, requestOptions ? JSON.stringify(requestOptions) : null]));
  q('UPDATE generation_jobs SET compute_snapshot=? WHERE id=?', [json(saleSnapshot), jobId]);
    if (startImmediately) {
      assertTransition(auditContext(auth, requestContext), 'generationJob', 'QUEUED', 'RUNNING', { targetType: 'GENERATION_JOB', targetId: jobId, before: { status: 'QUEUED' }, details: { action: 'START' } });
      q("UPDATE generation_jobs SET status='RUNNING',started_at=? WHERE id=? AND status='QUEUED'", [now, jobId]);
    }
  return jobId;
}

function queueItemFromJob(jobId) {
  const job = row('SELECT * FROM generation_jobs WHERE id=?', [jobId]);
  if (!job) return null;
  const user = row("SELECT * FROM users WHERE id=? AND org_id=? AND status='ACTIVE'", [job.user_id, job.org_id]);
  if (!user) return null;
  const auth = { user: normalizeUser(user, { includeAuthMeta: true }), rawUser: user, org: row('SELECT * FROM organizations WHERE id=?', [job.org_id]) };
  const project = ownProject(auth, job.project_id);
  if (!project) return null;
  return { auth, project, modality: job.modality, prompt: job.prompt, title: '', jobId, sourceAssetUrl: job.source_asset_url || '', lastFrameAssetUrl: job.last_frame_asset_url || '', referenceAssets: parseJson(job.reference_asset_urls, []) || [], boxId: job.box_id || '', requestOptions: parseJson(job.request_options, null) || null, requestContext: null };
}

function enqueuePersistedJob(jobId, delayMs = 0) {
  const enqueue = () => {
    const item = queueItemFromJob(jobId);
    if (!item) return;
    const current = row('SELECT status,next_attempt_at FROM generation_jobs WHERE id=?', [jobId]);
    if (current?.status !== 'QUEUED') return;
    if (current.next_attempt_at && Date.parse(current.next_attempt_at) > Date.now()) {
      enqueuePersistedJob(jobId, Date.parse(current.next_attempt_at) - Date.now());
      return;
    }
    asyncGenerationQueue.push(item);
    drainAsyncGenerationQueue();
  };
  if (delayMs > 0) { const timer = setTimeout(enqueue, delayMs); timer.unref?.(); } else enqueue();
}

export function initializeAsyncGenerationQueue() {
  const now = nowIso();
  q("UPDATE generation_jobs SET status='FAILED',worker_id=NULL,error_code='UPSTREAM_OUTCOME_UNKNOWN',error_message='执行中断，上游结果未知；请核查后人工处理',completed_at=? WHERE status='RUNNING' AND (started_at IS NULL OR started_at < ?)", [now, new Date(Date.now() - ASYNC_RUNNING_LEASE_MS).toISOString()]);
  rows("SELECT id FROM generation_jobs WHERE status='QUEUED' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at", [now])
    .forEach(({ id: jobId }) => enqueuePersistedJob(jobId));
}

function markJobFailed({ jobId, orgId, userId, project, modality, provider, info, session, error, requestContext = null }) {
  // 业务侧拦截（课时能力 / 套餐能力 / 课堂管控 / 额度）保留原始错误码与文案；
  // 只有真正的上游调用失败才走供应商错误归一化，否则会被误报成「API Key 无效」。
  const normalized = error instanceof ApiError
    ? { code: error.code, message: error.message }
    : normalizeProviderError(error);
  const failCode = normalized.code || error?.code || 'GENERATION_FAILED';
  const failMessage = normalized.message || error?.message || '素材生成失败';
  const failAt = nowIso();
  transaction(() => {
    // 2026-09-18：这里原来要 releaseCourseCu 释放课包 CU 预留（那套已整体删除，恒 UNLIMITED、
    // 从没真的预留过任何东西）。现在失败路径不需要回滚任何额度：按钱的那套是**调用前准入**，
    // 不做预留，也就不存在"失败要退"的问题。
    const currentJob = row('SELECT status FROM generation_jobs WHERE id=?', [jobId]);
    if (currentJob) assertTransition(auditContext({ user: { id: userId, orgId }, rawUser: null }, requestContext), 'generationJob', currentJob.status, 'FAILED', { targetType: 'GENERATION_JOB', targetId: jobId, before: currentJob, details: { errorCode: failCode } });
    q("UPDATE generation_jobs SET status='FAILED',worker_id=NULL,error_code=?,error_message=?,completed_at=? WHERE id=?",
      [failCode, String(failMessage).slice(0, 1000), failAt, jobId]);
    recordAiUsage({
      orgId, userId, projectId: project.id, sessionId: session?.id || null, generationJobId: jobId,
      modality, model: provider.model,
      status: BLOCKED_ERROR_CODES.has(failCode) ? 'BLOCKED' : 'FAILED', failCode,
      // 失败不花学生的钱（cost_fen 记 0 但**仍然记 series_id**，这样池子报表里能看出「有哪些失败调用」）
      costFen: 0, seriesId: seriesIdOf(project) || null,
      pricing: { compute: provider.compute, source: 'generation', provider: provider.name, mode: info.mode, charged: false, blocked: BLOCKED_ERROR_CODES.has(failCode) },
    });
  });
}

function settleSuccessfulJob({ auth, project, modality, provider, info, jobId, assetPayloads, requestContext = null, usage = null }) {
  transaction(() => {
    const user = row("SELECT * FROM users WHERE id = ? AND org_id = ? AND status = 'ACTIVE'", [auth.user.id, (auth.session?.org_id || auth.user.orgId)]);
    const freshProject = ownProject(auth, project.id);
    if (!user) throw errors.forbidden('学生账号不可用', 'ACCOUNT_DISABLED');
    if (freshProject.status !== 'DRAFT') throw errors.conflict('项目已提交，不能继续生成素材', 'PROJECT_NOT_EDITABLE');
    const freshContext = resolveProjectUsageContext(user, freshProject);
    if (!freshContext.canUseNow) throw errors.forbidden(freshContext.blockReason, freshContext.blockCode);
    assertCapability(modality, freshContext.activeSession);
    assertSessionAiControls({ modality, session: freshContext.activeSession, orgId: (auth.session?.org_id || auth.user.orgId), userId: auth.user.id });
    const lessonCapability = LESSON_CAPABILITY_BY_MODALITY[modality];
    if (lessonCapability && !(freshContext.lesson?.capabilities || []).includes(lessonCapability)) {
      throw errors.forbidden('本课时未开放该 AI 能力', 'LESSON_CAPABILITY_DISABLED');
    }
    // 框体占用在结算时再校验一次：等待期间同一框体可能已被另一次生成占用。
    const settledBoxId = row('SELECT box_id FROM generation_jobs WHERE id=?', [jobId])?.box_id || '';
    if (settledBoxId) assertBoxNotGenerated({ projectId: project.id, boxId: settledBoxId, excludeJobId: jobId });
    // 2026-09-13（P4 删积分）：成员 AI 上限 / 周期额度两道刹车已删除，且不再扣积分。
    // 这里只收尾记账；额度不在这一层拦（历史上那句 assertComputePoolBudget 是个从不抛错的空壳，2026-09-18 已删）。
    // C3 前置：上游给了 token 用量就记下来（计费仍是「每次调用 × 单价」，不改口径）
    const firstAssetTokens = assetPayloads.find((asset) => asset?.metadata?.tokens)?.metadata?.tokens || null;
    // P90：优先用 provider 返回的 usage 回执（流式是最后一帧给的），退回产物 metadata 里的那份。
    const recordedUsage = usage || firstAssetTokens || null;
    recordAiUsage({
      orgId: (auth.session?.org_id || auth.user.orgId), userId: auth.user.id, projectId: project.id,
      sessionId: freshContext.activeSession?.id || null, generationJobId: jobId,
      modality, model: provider.model, status: 'SUCCESS',
      inputTokens: recordedUsage?.inputTokens || 0, outputTokens: recordedUsage?.outputTokens || 0,
      usage: recordedUsage,
      // 算力池账本：成功才花钱，金额 = 本次单价（与调用前预扣用的是同一个函数，所以两边必然一致）
      costFen: parseJson(row('SELECT compute_snapshot FROM generation_jobs WHERE id=?', [jobId])?.compute_snapshot, {})?.unitFen ?? provider.compute?.saleSnapshot?.unitFen ?? priceFenFor({ modality, model: provider.model }),
      seriesId: freshContext.series?.id || null,
      pricing: { compute: provider.compute, source: 'generation', provider: provider.name, mode: info.mode, costFen: priceFenFor({ modality, model: provider.model }) },
    });
    assetPayloads.forEach((asset, index) => {
      const assetId = id('asset');
      q(`INSERT INTO media_assets(
           id,job_id,org_id,user_id,project_id,modality,label,mime_type,asset_url,preview_url,metadata,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [assetId, jobId, (auth.session?.org_id || auth.user.orgId), auth.user.id, project.id, modality,
          String(asset.label || `${MODALITY_LABELS[modality] || modality} ${index + 1}`).slice(0, 120),
          asset.mimeType || null, String(asset.assetUrl || `mock://generation/${assetId}`), asset.previewUrl || null,
          json(asset.metadata || {}), nowIso()]);
    });
    const currentJob = row('SELECT status FROM generation_jobs WHERE id=?', [jobId]);
    assertTransition(auditContext(auth, requestContext), 'generationJob', currentJob?.status, 'SUCCEEDED', { targetType: 'GENERATION_JOB', targetId: jobId, before: currentJob, details: { modality } });
    q("UPDATE generation_jobs SET status='SUCCEEDED',worker_id=NULL,completed_at=? WHERE id=?", [nowIso(), jobId]);
  });
}

export function providerSelectionForModality(policy, modality, modelOverride = '') {
  const key = String(modality || '').toUpperCase();
  const defaultChannel = policy?.channels?.find(item => item.id === policy?.modalityChannels?.[key]);
  const requestedModel = modelOverride || defaultChannel?.model || policy?.model;
  const mapping = policy?.modelRoutes?.find(item => item.modality === key && item.model === requestedModel);
  const channelId = mapping?.channelId || policy?.modalityChannels?.[key];
  const channel = Array.isArray(policy?.channels) ? policy.channels.find((item) => item.id === channelId) : null;
  const base = channel
    ? { provider: channel.provider, model: channel.model, endpoint: channel.endpoint, channelId: channel.id, providerAccountRef: channel.providerAccountRef || null, requestTemplates: channel.requestTemplates || {}, modelRequestTemplates: channel.modelRequestTemplates || {}, requestPaths: channel.requestPaths || {}, pollPaths: channel.pollPaths || {}, upstreamUnitPrices: channel.upstreamUnitPrices || null, modelUnitPrices: channel.modelUnitPrices || null }
    : { provider: policy.provider, model: policy.model, endpoint: policy.endpoint, channelId: 'default', requestTemplates: {}, modelRequestTemplates: {}, requestPaths: {}, pollPaths: {}, upstreamUnitPrices: null, modelUnitPrices: null };
  const selected = mapping ? { ...base, model: mapping.model } : modelOverride ? { ...base, model: modelOverride } : base;
  selected.estimatedCostFen = channel?.modelCosts?.[selected.model] ?? channel?.estimatedCostFen ?? null;
  const backup = policy?.channels?.find((item) => item.id === (mapping ? mapping.backupChannelId : policy?.modalityBackupChannels?.[key]));
  if (backup) {
    const backupModel = mapping?.backupModel || backup.model;
    selected.backup = { ...backup, channelId: backup.id, model: backupModel, upstreamUnitPrices: backup.upstreamUnitPrices || null, modelUnitPrices: backup.modelUnitPrices || null, estimatedCostFen: backup.modelCosts?.[backupModel] ?? backup.estimatedCostFen ?? null };
  }
  return selected;
}

/**
 * 生成参数：框体定了就以框体为准（学生在课堂里改不了）；框体留空＝平台没指定，
 * 这时采信学生自己选的，但必须落在该模型的能力白名单里（所以依旧绕不过课时限制）。
 * 框体与模型都没给时回落到模型能力的第一项。
 * 输入画面：按该模型声明的方式给 —— 支持文生就可以不带图，支持首帧才用连过来的图/框体预置素材，
 * 支持尾帧才带上尾帧。学生给了模型不支持的画面会被 assertVideoFrames 拦下。
 */
export function generationOptionsFor({ context, modality, policy, selection, box = null, studentOptions = null, firstFrameUrl = '', lastFrameUrl = '', referenceAssets = [], lyrics = '' }) {
  const key = String(modality || '').toUpperCase();
  if (key === 'MUSIC') {
    const target = box || resolveLessonGenerationBox(context, key, '');
    const mode = String(target?.mode || '').trim().toUpperCase() === 'DESCRIPTION' ? 'DESCRIPTION' : 'LYRICS';
    const channel = Array.isArray(policy?.channels) ? policy.channels.find((item) => item.id === selection?.channelId) : null;
    const capabilities = effectiveCapabilities(channel, key, selection?.model);
    // 歌词模式：学生的输入就是要唱的词，lyrics 留空＝用学生的输入；曲风用模型的默认曲风（上游必填）。
    // 描述模式：学生写的是描述（当曲风），歌词由平台代写后经 lyrics 传进来。
    return { mode, lyrics: mode === 'DESCRIPTION' ? String(lyrics || '').trim() : '', defaultStyle: String(capabilities.defaultStyle || '').trim() };
  }
  if (key !== 'IMAGE' && key !== 'VIDEO') return {};
  const channel = Array.isArray(policy?.channels) ? policy.channels.find((item) => item.id === selection?.channelId) : null;
  const capabilities = effectiveCapabilities(channel, key, selection?.model);
  const target = box || resolveLessonGenerationBox(context, key, '');
  // 框体没指定 → 用学生选的；选了模型不支持的值当场 400，而不是静默换成别的。
  const chosen = (field, allowed, label) => {
    const locked = String(target?.[field] ?? '').trim();
    if (locked) return locked;
    const value = String(studentOptions?.[field] ?? '').trim();
    if (!value) return '';
    if (allowed.length && !allowed.includes(value)) {
      throw errors.badRequest(`你选的${label}「${value}」不在该模型支持范围内（可用：${allowed.join('、')}）`, 'GENERATION_PARAM_INVALID');
    }
    return value;
  };
  const options = {
    aspectRatio: chosen('aspectRatio', capabilities.aspectRatios, '比例') || capabilities.aspectRatios[0] || '',
    resolution: chosen('resolution', capabilities.resolutions, '清晰度') || capabilities.resolutions[0] || '',
  };
  if (key === 'IMAGE') {
    // 图片参考：学生把素材连到生图框体，就是「照这张图改」的意思。
    // ⚠️ 这里以前**根本没设过** options.referenceAssets（只有 VIDEO 分支设）——
    // 于是前端就算把连线传上来，也会在这一层被吃掉（2026-09-17 用户报「引用没有真实生效」的三层之一）。
    // 承载它的位置由渠道模板决定（默认模板用 {{referenceImageUrls}} → 顶层 images）。
    const references = (Array.isArray(referenceAssets) ? referenceAssets : []).filter((item) => item && item.url);
    if (references.length) {
      const template = requestTemplateFor(
        Array.isArray(policy?.channels) ? policy.channels.find((item) => item.id === selection?.channelId) : null,
        key,
        { model: selection?.model },
      );
      // 模板里没有能放参考图的位置 → 上游收到的请求体里一张图都没有。
      // 这种情况**必须当场拒绝**：静默丢掉的结果是「出来一张跟参考无关的图」，
      // 比报错糟得多（学生会以为模型不听话，其实是图根本没发出去）。与视频那条门禁同一个口径。
      if (!/\{\{(referenceItems|referenceImageUrls)\}\}/.test(JSON.stringify(template || {}))) {
        throw errors.forbidden('当前图片模型不能带参考图：请去掉连线，或让老师换一个支持参考的模型', 'GENERATION_REFERENCES_UNSUPPORTED');
      }
      options.referenceAssets = references;
    }
  }
  if (key === 'VIDEO') {
    const lockedDuration = Number(target?.durationSeconds);
    const studentDuration = Number(studentOptions?.durationSeconds);
    const duration = Number.isInteger(lockedDuration) && lockedDuration > 0 ? lockedDuration : (Number.isInteger(studentDuration) && studentDuration > 0 ? studentDuration : 0);
    if (duration && capabilities.durations.length && !capabilities.durations.includes(duration)) {
      throw errors.badRequest(`你选的时长「${duration}秒」不在该模型支持范围内（可用：${capabilities.durations.join('、')}秒）`, 'GENERATION_PARAM_INVALID');
    }
    options.durationSeconds = duration || capabilities.durations[0] || 5;
    // 含音频：框体定了就按框体；框体没定（null）按学生选；模型不支持音频时一律不带。
    const lockedAudio = target?.audio;
    options.audio = (lockedAudio === true || lockedAudio === false ? lockedAudio : studentOptions?.audio === true) && capabilities.audio === true;
    options.inputModes = Array.isArray(capabilities.inputModes) ? capabilities.inputModes : ['TEXT'];
    const references = (Array.isArray(referenceAssets) ? referenceAssets : []).filter((item) => item && item.url);
    const presetAsset = String(target?.assetUrl || '').trim();
    if (options.inputModes.includes('OMNI_REFERENCE') && (references.length || presetAsset)) {
      // 全能参考：这些素材当参考发，不当首/尾帧（上游不允许混用）；框体预置素材也算一张图片参考。
      const presetResolved = resolvableAssetUrl(presetAsset);
      const omniReferences = references.length ? references : (presetResolved ? [{ type: 'IMAGE', url: presetResolved }] : []);
      // ⚠️ 与图片那条**同一个口径**：模板里没有能放参考的位置 → 上游一张图都收不到。
      //    静默丢掉的结果是「出来一段与参考无关的视频」，比报错糟得多 —— 用户 2026-09-21 撞的就是它
      //    （连了清明上河图当参考，出来的视频跟它毫无关系；根因是默认视频模板里没有 {{referenceItems}}）。
      const referencesTemplate = requestTemplateFor(channel, key, { model: selection?.model, withReferences: true });
      if (!/\{\{(referenceItems|referenceImageUrls)\}\}/.test(JSON.stringify(referencesTemplate || {}))) {
        throw errors.forbidden('当前视频模型不能带参考素材：请去掉连线，或让老师换一个支持参考的模型', 'GENERATION_REFERENCES_UNSUPPORTED');
      }
      options.referenceAssets = omniReferences;
    } else {
      // 框体挂了预置素材时，它就是首帧（学生不必自己再连一张）。
      const presetFirstFrame = acceptsFirstFrame(options.inputModes) ? resolvableAssetUrl(presetAsset) : '';
      const resolvedFirstFrame = String(firstFrameUrl || '').trim() || presetFirstFrame;
      if (resolvedFirstFrame) options.firstFrameUrl = resolvedFirstFrame;
      if (lastFrameUrl) options.lastFrameUrl = String(lastFrameUrl).trim();
    }
  }
  return options;
}

/**
 * 学生在画布上自选的生成参数（平台把框体参数留空时才生效，见 generationOptionsFor）。
 * 什么都没有时返回 null，避免往库里写空壳。
 */
function studentParamOptionsFrom(body = {}) {
  const text = (value) => (value === undefined || value === null ? '' : String(value).trim().slice(0, 40));
  const duration = body.durationSeconds === undefined || body.durationSeconds === null || body.durationSeconds === '' ? null : Number(body.durationSeconds);
  const options = {
    aspectRatio: text(body.aspectRatio),
    resolution: text(body.resolution),
    durationSeconds: Number.isInteger(duration) && duration > 0 && duration <= 600 ? duration : null,
    audio: body.audio === undefined || body.audio === null ? null : body.audio === true,
  };
  const hasValue = Boolean(options.aspectRatio || options.resolution || options.durationSeconds || options.audio !== null);
  return hasValue ? options : null;
}

/**
 * 只保留真正生效的学生选择：框体已经指定的项以框体为准，不写进去，
 * 否则 request_options 会让人误以为学生改过参数（重试时也会把这些值当学生选择再传一遍）。
 */
function effectiveStudentOptions(box, studentOptions) {
  if (!studentOptions) return null;
  const locked = (value) => value === true || value === false || (value !== null && value !== undefined && String(value).trim() !== '');
  const effective = {};
  if (!locked(box?.aspectRatio) && studentOptions.aspectRatio) effective.aspectRatio = studentOptions.aspectRatio;
  if (!locked(box?.resolution) && studentOptions.resolution) effective.resolution = studentOptions.resolution;
  if (!locked(box?.durationSeconds) && studentOptions.durationSeconds) effective.durationSeconds = studentOptions.durationSeconds;
  if (!locked(box?.audio) && studentOptions.audio !== null) effective.audio = studentOptions.audio;
  return Object.keys(effective).length ? effective : null;
}

function auditContext(auth, ctx = null) {
  return {
    auth,
    req: ctx?.req || null,
    method: ctx?.method || null,
    pathname: ctx?.pathname || null,
  };
}

export async function runGenerationJob({ auth, project, modality, prompt, title, retryOfJobId = null, action = 'AI_GENERATION_CREATE', requestContext = null, sourceAssetUrl = '', lastFrameAssetUrl = '', referenceAssets = [], boxId = '', studentOptions = null }) {
  if (project.status !== 'DRAFT') throw errors.conflict('项目已提交，不能继续生成素材', 'PROJECT_NOT_EDITABLE');
  const policy = getAiProviderPolicy();
  const context = resolveProjectUsageContext(auth.rawUser, project);
  if (!context.canUseNow) throw errors.forbidden(context.blockReason, context.blockCode);
  const box = resolveLessonGenerationBox(context, modality, boxId);
  // 走网关的话，这里换成「该学生在这节课的令牌」出口；解析不出来就原样直连。
  const providerSelection = await applyGatewayRoute(providerSelectionForModality(policy, modality, box?.model || ''), {
    orgId: (auth.session?.org_id || auth.user.orgId), studentId: auth.user.id, lessonId: context.lesson?.id || '', modality,
  });
  const provider = getGenerationProvider(providerSelection);
  const info = generationProviderInfo(providerSelection);
  assertExternalAiAllowed({ mode: info.mode, allowStudentExternalContent: policy.allowStudentExternalContent });
  if (info.configured && info.adapterAvailable) assertProviderCapability(provider, modality);
  const resolvedReferences = resolveReferenceAssets(project.id, referenceAssets);
  // 学生连了参考图，但**一张都没解析出可公开访问的地址**（素材库预置图、上游的过期临时链接、
  // data: 地址都会这样）—— 这时上游其实也收不到任何参考。当场拒绝，别让学生以为「引用生效了」
  // 却拿到一张无关的图（2026-09-17 用户报「引用没有真实生效」的另一条静默路径）。
  // 只对 IMAGE / VIDEO 生效：参考素材本来就只在这两个模态里用。
  {
    const modalityKey = String(modality || '').toUpperCase();
    const requested = (Array.isArray(referenceAssets) ? referenceAssets : [])
      .filter((item) => item && String(typeof item === 'string' ? item : item.url || '').trim());
    if (requested.length && !resolvedReferences.length && (modalityKey === 'IMAGE' || modalityKey === 'VIDEO')) {
      throw errors.forbidden('这张参考图没法发给模型（它不在可公开访问的素材里）：重新上传素材再连一次，或先去掉连线', 'GENERATION_REFERENCE_UNRESOLVED');
    }
  }
  const requestedFirstFrame = resolveFirstFrameUrl(project.id, sourceAssetUrl);
  const requestedLastFrame = resolveFirstFrameUrl(project.id, lastFrameAssetUrl);
  const writtenLyrics = String(modality).toUpperCase() === 'MUSIC' && String(box?.mode || '').toUpperCase() === 'DESCRIPTION'
    ? await writeLyricsForMusic({ prompt, policy, requestContext, auth, lessonId: context.lesson?.id || '' })
    : '';
  const options = generationOptionsFor({
    context, modality, policy, selection: providerSelection, box,
    firstFrameUrl: requestedFirstFrame,
    lastFrameUrl: requestedLastFrame,
    referenceAssets: resolvedReferences,
    lyrics: writtenLyrics,
    studentOptions,
  });
  assertGenerationPreflight({
    user: auth.rawUser, orgId: (auth.session?.org_id || auth.user.orgId), context, modality, projectId: project.id,
    boxId: box?.id || '', model: provider.model,
    frameCheck: { modes: options.inputModes, firstFrameUrl: options.firstFrameUrl || '', lastFrameUrl: options.lastFrameUrl || '', referenceAssets: options.referenceAssets || [], requestedFrames: Boolean(requestedFirstFrame || requestedLastFrame) },
  });
  const jobId = createJobRecord({ auth, project, modality, provider, prompt, retryOfJobId, requestContext, sourceAssetUrl: options.firstFrameUrl || null, lastFrameAssetUrl: options.lastFrameUrl || null, referenceAssetUrls: options.referenceAssets || null, boxId: box?.id || '', requestOptions: effectiveStudentOptions(box, studentOptions), selection: providerSelection });
  try {
    const generated = await provider.generate({ modality, prompt, title, projectId: project.id, userId: auth.user.id, options, computeContext: { orgId: (auth.session?.org_id || auth.user.orgId), userId: auth.user.id, jobId } });
    const assetPayloads = Array.isArray(generated?.assets) ? generated.assets : [];
    if (!assetPayloads.length) throw Object.assign(new Error('生成服务没有返回素材'), { code: 'GENERATION_EMPTY_RESULT' });
    settleSuccessfulJob({ auth, project, modality, provider, info, jobId, assetPayloads, requestContext, usage: generated?.usage || null });
    audit(auditContext(auth, requestContext), action, 'GENERATION_JOB', jobId, retryOfJobId ? { jobId: retryOfJobId } : null, { modality, provider: provider.name }, { orgId: (auth.session?.org_id || auth.user.orgId) });
    const job = jobDetail(jobId);
    return { job, assets: job.assets };
  } catch (error) {
    markJobFailed({ jobId, orgId: (auth.session?.org_id || auth.user.orgId), userId: auth.user.id, project, modality, provider, info, session: context?.activeSession, error, requestContext });
    if (error instanceof ApiError) throw error;
    const normalized = normalizeProviderError(error);
    throw errors.badRequest(normalized.message, normalized.code);
  }
}


async function processAsyncGeneration(item) {
  const { auth, project, modality, prompt, title, jobId, requestContext, sourceAssetUrl = '', lastFrameAssetUrl = '', referenceAssets = [], boxId = '', requestOptions = null } = item;
  const policy = getAiProviderPolicy();
  const persistedJob = row('SELECT provider,model,compute_snapshot FROM generation_jobs WHERE id=?', [jobId]);
  // 兼容恢复的旧任务：local-mock 任务继续使用进程环境 provider；新外部任务使用创建时记录的 provider。
  const routedSelection = parseJson(persistedJob?.compute_snapshot, {})?.route || providerSelectionForModality(policy, modality);
  // ⚠️ 必须把 routedSelection **整份**带上（只覆盖 provider/model）。异步 worker 原来只挑了
  //   provider / model / endpoint / channelId 四个字段，把渠道的 **modelRequestTemplates /
  //   requestTemplates / requestPaths / pollPaths 全丢了** → provider 退回内置默认请求体与默认路径 →
  //   MiniMax-H3 被上游拒（"requires the native V2 request in metadata.h3_request"）、
  //   mureka 被拒（"version is required"）；图片恰好因为默认模板就能用，所以只有视频/音乐坏。
  //   2026-09-11 用生产配置实跑复现并修掉（见交接说明第三节）。
  const providerSelection = persistedJob?.provider && persistedJob.provider !== 'local-mock'
    ? { ...routedSelection, provider: persistedJob.provider, model: persistedJob.model }
    : {};
  let context = null;
  let provider = { name: persistedJob?.provider || 'unknown', model: persistedJob?.model || '' };
  let info = { mode: 'unknown' };
  try {
    context = resolveProjectUsageContext(auth.rawUser, project);
    // 恢复任务也必须重新验证课堂与网关；失败进入统一收尾，不能使 worker 退出。
    const routedByGateway = await applyGatewayRoute(providerSelection, {
      orgId: (auth.session?.org_id || auth.user.orgId), studentId: auth.user.id, lessonId: context.lesson?.id || '', modality,
    });
    routedByGateway.saleSnapshot = parseJson(persistedJob?.compute_snapshot, null);
    provider = getGenerationProvider(routedByGateway);
    info = generationProviderInfo(routedByGateway);
    // 异步任务重算一次「对外售价观测」快照（路由/模型在这时才最终确定）：
    // 只刷新 unitFen/baseline 与模型，**不动 route**，也不改学生账本（cost_fen 恒 0）。
    q('UPDATE generation_jobs SET compute_snapshot=? WHERE id=?', [json({
      ...(routedByGateway.saleSnapshot || {}),
      modality, model: provider.model,
      unitFen: priceFenFor({ modality, model: provider.model }),
      charged: false, baseline: 'OBSERVATION_ONLY', basis: 'OBSERVATION_ONLY',
      route: routedByGateway.saleSnapshot?.route || null,
      capturedAt: nowIso(),
    }), jobId]);
    assertExternalAiAllowed({ mode: info.mode, allowStudentExternalContent: policy.allowStudentExternalContent });
    if (info.configured && info.adapterAvailable) assertProviderCapability(provider, modality);
    const box = resolveLessonGenerationBox(context, modality, boxId);
    const requestedFirstFrame = resolveFirstFrameUrl(project.id, sourceAssetUrl);
    const requestedLastFrame = resolveFirstFrameUrl(project.id, lastFrameAssetUrl);
    const writtenLyrics = String(modality).toUpperCase() === 'MUSIC' && String(box?.mode || '').toUpperCase() === 'DESCRIPTION'
      ? await writeLyricsForMusic({ prompt, policy, requestContext, auth, lessonId: context.lesson?.id || '' })
      : '';
    const options = generationOptionsFor({
      context, modality, policy, selection: routedByGateway, box,
      firstFrameUrl: requestedFirstFrame,
      lastFrameUrl: requestedLastFrame,
      referenceAssets: resolveReferenceAssets(project.id, referenceAssets),
      lyrics: writtenLyrics,
      studentOptions: requestOptions,
    });
    assertGenerationPreflight({
      user: auth.rawUser, orgId: (auth.session?.org_id || auth.user.orgId), context, modality, projectId: project.id, boxId: box?.id || '', excludeJobId: jobId, model: provider.model,
      frameCheck: { modes: options.inputModes, firstFrameUrl: options.firstFrameUrl || '', lastFrameUrl: options.lastFrameUrl || '', referenceAssets: options.referenceAssets || [], requestedFrames: Boolean(requestedFirstFrame || requestedLastFrame) },
    });
    const current = row('SELECT status FROM generation_jobs WHERE id=?', [jobId]);
    if (!current || current.status !== 'QUEUED') return;
    q("UPDATE generation_jobs SET status='RUNNING',started_at=?,worker_id=?,next_attempt_at=NULL WHERE id=? AND status='QUEUED'", [nowIso(), ASYNC_WORKER_ID, jobId]);
    const generated = await provider.generate({ modality, prompt, title, projectId: project.id, userId: auth.user.id, options, computeContext: { orgId: (auth.session?.org_id || auth.user.orgId), userId: auth.user.id, jobId } });
    const assetPayloads = Array.isArray(generated?.assets) ? generated.assets : [];
    if (!assetPayloads.length) throw Object.assign(new Error('生成服务没有返回素材'), { code: 'GENERATION_EMPTY_RESULT' });
    settleSuccessfulJob({ auth, project, modality, provider, info, jobId, assetPayloads, requestContext, usage: generated?.usage || null });
    audit(auditContext(auth, requestContext), 'AI_GENERATION_ASYNC_COMPLETE', 'GENERATION_JOB', jobId, null, { modality, provider: provider.name }, { orgId: (auth.session?.org_id || auth.user.orgId) });
  } catch (error) {
    markJobFailed({ jobId, orgId: (auth.session?.org_id || auth.user.orgId), userId: auth.user.id, project, modality, provider, info, session: context?.activeSession, error, requestContext });
  }
}

function drainAsyncGenerationQueue() {
  if (asyncGenerationWorkerRunning || !asyncGenerationQueue.length) return;
  asyncGenerationWorkerRunning = true;
  const item = asyncGenerationQueue.shift();
  processAsyncGeneration(item).finally(() => { asyncGenerationWorkerRunning = false; drainAsyncGenerationQueue(); });
}

function validPage(value) {
  const page = Number(value || 1);
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw errors.badRequest('页码必须是 1-10000 的整数', 'INVALID_PAGE');
  return page;
}

function validPageSize(value) {
  const size = Number(value || GENERATION_PAGE_SIZE);
  if (!Number.isInteger(size) || size < 1 || size > 100) throw errors.badRequest('每页数量必须是 1-100 的整数', 'INVALID_PAGE_SIZE');
  return size;
}

function generationHistory(auth, search) {
  const page = validPage(search.get('page'));
  const pageSize = validPageSize(search.get('pageSize'));
  const modalityInput = search.get('modality');
  const modality = modalityInput ? String(modalityInput).trim().toUpperCase() : null;
  if (modality && !MODALITIES.has(modality)) throw errors.badRequest('不支持的素材类型', 'UNSUPPORTED_MODALITY');
  const status = search.get('status');
  if (status && !['SUCCEEDED', 'FAILED'].includes(status)) throw errors.badRequest('无效的任务状态', 'INVALID_JOB_STATUS');
  const projectId = String(search.get('projectId') || '').trim();
  if (projectId && projectId.length > 100) throw errors.badRequest('projectId 无效', 'PROJECT_REQUIRED');
  const filters = ['job.user_id = ?', 'job.org_id = ?'];
  const params = [auth.user.id, (auth.session?.org_id || auth.user.orgId)];
  if (modality) { filters.push('job.modality = ?'); params.push(modality); }
  if (status) { filters.push('job.status = ?'); params.push(status); }
  if (projectId) { filters.push('job.project_id = ?'); params.push(projectId); }
  const where = filters.join(' AND ');
  const total = count('SELECT COUNT(*) n FROM generation_jobs job WHERE ' + where, params);
  const rawJobs = rows(jobQuery() + ` WHERE ${where} ORDER BY job.created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]);
  const assetRows = rawJobs.length
    ? rows('SELECT * FROM media_assets WHERE job_id IN (' + rawJobs.map(() => '?').join(',') + ') ORDER BY created_at DESC', rawJobs.map((job) => job.id))
    : [];
  const assetsByJob = new Map();
  for (const asset of assetRows) {
    if (!assetsByJob.has(asset.job_id)) assetsByJob.set(asset.job_id, []);
    assetsByJob.get(asset.job_id).push(normalizeAsset(asset));
  }
  const items = rawJobs.map((job) => normalizeJob(job, { assets: assetsByJob.get(job.id) || [] }));
  return {
    page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
    summary: {
      total,
      succeeded: count("SELECT COUNT(*) n FROM generation_jobs WHERE user_id = ? AND org_id = ? AND status = 'SUCCEEDED'", [auth.user.id, (auth.session?.org_id || auth.user.orgId)]),
      failed: count("SELECT COUNT(*) n FROM generation_jobs WHERE user_id = ? AND org_id = ? AND status = 'FAILED'", [auth.user.id, (auth.session?.org_id || auth.user.orgId)]),
      // 对外售价口径（2026-09-15）：学员看到的「消耗」= 算力账本里成功尝试的售价快照合计。
      // 原来读 usage_records.cost_fen —— 那一列现行代码恒为 0（平台承担成本、不扣学生），这里永远显示 0。
      costFen: count(`SELECT ${salePriceFenSuccessSql()} n FROM compute_attempts WHERE user_id = ? AND org_id = ?`, [auth.user.id, (auth.session?.org_id || auth.user.orgId)]),
    },
    items,
  };
}

function assetUsageStatus(asset, currentSnapshot, snapshots) {
  if (String(currentSnapshot || '').includes(asset.asset_url)) {
    return { used: true, source: 'CURRENT', usedInVersion: null, usedAt: null };
  }
  const hit = [...snapshots].reverse().find((snapshot) => String(snapshot.canvas_snapshot || '').includes(asset.asset_url));
  if (hit) return { used: true, source: 'HISTORY', usedInVersion: Number(hit.version || 0), usedAt: hit.created_at };
  return { used: false, source: null, usedInVersion: null, usedAt: null };
}

/**
 * 学生**正在进行**的课堂（2026-09-13 批次 D 改成课堂口径）。
 *
 * ⚠️ 这里原来走 `classes JOIN class_members` 并要求 `class.current_session_id = session.id`。
 *    班级退场后新课堂的 class_id 是空的，所以它**恒返回空**，进而让下面那句
 *    `scopeBlocked = student_usage_scope !== 'HOME_PRACTICE' && !session` 两个方向都错：
 *      · HOME_PRACTICE 学员 → 恒为 false（等于宣称「不进课堂也能用」，正是被取消的那条通道）；
 *      · FOLLOW_CLASS 学员 → 恒为 true（哪怕课堂正在上，也一直被告知「等待老师开启课堂」）。
 *    改成从**课堂名单**取之后两个方向都对了。真实门禁一直在 studentContext（生成时才拦），
 *    所以这里错了只表现为**展示与口径矛盾**，不是安全洞 —— 但矛盾本身就是 bug。
 */
function activeAiSessions(user) {
  return rows(`SELECT session.*, lesson.title AS lesson_title
     FROM session_students part
     JOIN class_sessions session ON session.id = part.session_id
     LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
     WHERE part.student_id = ? AND part.org_id = ?
       AND part.status = 'ACTIVE' AND session.status = 'ACTIVE'
     ORDER BY session.started_at DESC`, [user.id, user.org_id]);
}

function normalizeAiSession(value) {
  if (!value) return null;
  return {
    id: value.id, classId: value.class_id, lessonId: value.lesson_id || null, lessonTitle: value.lesson_title || null,
    status: value.status, aiPaused: !!value.ai_paused,
    // 2026-09-18（用户口径，两次更正后的最终口径）：
    //   · `student_call_cap`（按**次数**的上限）已退役，不回显 —— 那是与钱无关、且不生效的旧数；
    //   · 按钱的观测额度（`student_cost_cap_fen`）**也不给学生**：「学生算力额度的设置
    //     目前都是不真拦，都是给我们内部看的」→ 学生既看不到它，也不会被它拦。
    //   所以学生可见的课堂对象里**没有任何额度字段**（`studentCallCap` 恒 null 只是键兼容位）。
    studentCallCap: null,
    capabilities: {
      allowText: value.allow_text === undefined ? true : !!value.allow_text,
      allowImage: !!value.allow_image, allowMusic: !!value.allow_music, allowVideo: !!value.allow_video,
      allowPodcast: !!value.allow_podcast, allowDubbing: !!value.allow_dubbing,
    },
    startedAt: value.started_at,
  };
}

function studentAiCenter(ctx) {
  const auth = ctx.auth;
  const rawUser = auth.rawUser;
  const orgId = (auth.session?.org_id || auth.user.orgId);
  // 学生可见负载**不带额度**（2026-09-18 用户口径）：观测数字只在老师端/平台端。
  const activeSessions = activeAiSessions(rawUser).map(normalizeAiSession);
  const session = activeSessions[0] || null;
  const capabilities = AI_MODALITIES.map((modality) => {
    const capability = SESSION_CAPABILITY_BY_MODALITY[modality];
    const sessionEnabled = !capability || !session || !session.capabilities || session.capabilities[capability];
    const reasons = [];
    // 2026-09-16：套餐（billing_packages）不再参与能力判定，那两条理由（未绑定套餐 /
    // 套餐未开通该能力）一并删掉 —— 学生看到「套餐」两个字已无从处理，只会来问。
    if (session?.aiPaused) reasons.push('教师已暂停课堂 AI');
    else if (!sessionEnabled) reasons.push('当前课堂未开放');
    // 2026-09-18（用户口径，两次更正后的最终口径）：额度**不是**学生侧的理由 ——
    // 先前的「本课堂 AI 调用次数已达上限」（按次数，已退役）和「本课堂算力额度已用完」
    // （按钱）两条**都不该出现在这里**：额度只观测、不真拦，学生也不该知道内部额度。
    // 别再往 reasons 里加任何额度类文案。
    // 2026-09-13：取消「在家练习」免课堂通道 —— **有许可只代表能看课包信息**，
    // 要进操作环境必须被老师加进课堂、且课堂正在进行。所以这里只看有没有进行中的课堂，
    // 不再看 student_usage_scope（那个字段已退役，见 orgAdmin 建号那段的说明）。
    const scopeBlocked = !session;
    if (scopeBlocked) reasons.push('等老师把你加进课堂并点「开始上课」');
    return {
      modality, label: MODALITY_LABELS[modality], sessionEnabled,
      // 可用性只看「课堂是否开放/是否被暂停/是否在课堂里」——**与额度无关**（额度不拦人）。
      available: sessionEnabled && !session?.aiPaused && !scopeBlocked,
      reasons,
    };
  });
  const jobs = {
    total: count('SELECT COUNT(*) n FROM generation_jobs WHERE user_id = ? AND org_id = ?', [auth.user.id, orgId]),
    succeeded: count("SELECT COUNT(*) n FROM generation_jobs WHERE user_id = ? AND org_id = ? AND status = 'SUCCEEDED'", [auth.user.id, (auth.session?.org_id || auth.user.orgId)]),
    failed: count("SELECT COUNT(*) n FROM generation_jobs WHERE user_id = ? AND org_id = ? AND status = 'FAILED'", [auth.user.id, (auth.session?.org_id || auth.user.orgId)]),
    // 同上：对外售价口径（2026-09-15），不读 usage_records.cost_fen。
    costFen: count(`SELECT ${salePriceFenSuccessSql()} n FROM compute_attempts WHERE user_id = ? AND org_id = ?`, [auth.user.id, (auth.session?.org_id || auth.user.orgId)]),
  };
  const assets = rows(`SELECT asset.*, project.title AS project_title, project.status AS project_status,
            lesson.title AS lesson_title, session.title AS session_title
     FROM media_assets asset
     LEFT JOIN student_projects project ON project.id = asset.project_id
     LEFT JOIN course_lessons lesson ON lesson.id = project.course_lesson_id
     LEFT JOIN class_sessions session ON session.id = project.class_session_id
     WHERE asset.user_id = ? AND asset.org_id = ?
     ORDER BY asset.created_at DESC LIMIT 100`, [auth.user.id, (auth.session?.org_id || auth.user.orgId)]);
  const projects = rows('SELECT id,canvas_snapshot FROM student_projects WHERE student_id = ? AND org_id = ?', [auth.user.id, (auth.session?.org_id || auth.user.orgId)]);
  const currentByProject = new Map(projects.map((project) => [project.id, project.canvas_snapshot || '']));
  const snapshotsByProject = new Map();
  if (projects.length) {
    const snapshots = rows('SELECT project_id,version,canvas_snapshot,created_at FROM project_snapshots WHERE project_id IN (' + projects.map(() => '?').join(',') + ') ORDER BY version',
      projects.map((project) => project.id));
    for (const snapshot of snapshots) {
      if (!snapshotsByProject.has(snapshot.project_id)) snapshotsByProject.set(snapshot.project_id, []);
      snapshotsByProject.get(snapshot.project_id).push(snapshot);
    }
  }
  const assetTotal = count('SELECT COUNT(*) n FROM media_assets WHERE user_id = ? AND org_id = ?', [auth.user.id, (auth.session?.org_id || auth.user.orgId)]);
  const normalizedAssets = assets.map((asset) => ({
    ...normalizeAsset(asset),
    projectTitle: asset.project_title || null,
    projectStatus: asset.project_status || null,
    courseLessonTitle: asset.lesson_title || null,
    sessionTitle: asset.session_title || null,
    usage: assetUsageStatus(asset, currentByProject.get(asset.project_id), snapshotsByProject.get(asset.project_id) || []),
  }));
  return {
    provider: generationProviderInfo(),
    // 2026-09-13（P4 删积分）：原来的 period（周期额度 allowance/used/remaining）已删除。
    // 学生的剩余额度看**算力池**（按 学生 × 课包 汇总，学生端课时卡片与「我的课程」都能看到。
    // ⚠️ 2026-09-20：「学习统计」那一页已按用户口径整页删除，注释别再指过去）。
    // 批次 D：`usageScope` 不再返回 —— 它对应已退役的 student_usage_scope，读它只会误导。
    activeSessions,
    capabilities,
    jobs,
    assets: {
      stats: {
        total: assetTotal,
        sampled: normalizedAssets.length,
        used: normalizedAssets.filter((item) => item.usage.used).length,
        unused: normalizedAssets.filter((item) => !item.usage.used).length,
      },
      items: normalizedAssets,
    },
  };
}

export async function handleAiGeneration(ctx) {
  const { pathname, method, auth } = ctx;
  if (!pathname.startsWith('/api/ai/')) return null;
  if (pathname === '/api/ai/providers' && method === 'GET') { const policy = getAiProviderPolicy(); return generationProviderInfo({ provider: policy.provider, model: policy.model, endpoint: policy.endpoint }); }
  requireRole(ctx, ['STUDENT']);

  if (pathname === '/api/ai/center' && method === 'GET') return studentAiCenter(ctx);
  // 说明：原来的 /api/ai/generations/history（GET 列表 / POST 重试）已删除 ——
  // 它与下方 /api/ai/generations（列表）返回同一份 payload，且没有任何调用方（界面与守卫都没用过）。
  // 保留的是 /api/ai/generations?projectId=…（列表，画布在用）、/history/:jobId（详情）、/cancel（取消）。
  if (pathname === '/api/ai/generations/async' && method === 'POST') {
    const body = ctx.body || {}; const projectId = String(body.projectId || '').trim(); const prompt = String(body.prompt || '').trim(); const title = String(body.title || '').trim().slice(0, 100); const modality = modalityOf(body.modality); const boxId = String(body.boxId || '').trim().slice(0, 64);
    if (!projectId || !prompt) throw errors.badRequest('projectId 和素材描述必填', 'GENERATION_FIELDS_REQUIRED');
    const project = ownProject(auth, projectId); if (project.status !== 'DRAFT') throw errors.conflict('项目已提交，不能继续生成素材', 'PROJECT_NOT_EDITABLE');
    const policy = getAiProviderPolicy();
    const context = resolveProjectUsageContext(auth.rawUser, project); if (!context.canUseNow) throw errors.forbidden(context.blockReason, context.blockCode);
    const box = resolveLessonGenerationBox(context, modality, boxId);
    const providerSelection = await applyGatewayRoute(providerSelectionForModality(policy, modality, box?.model || ''), {
      orgId: (auth.session?.org_id || auth.user.orgId), studentId: auth.user.id, lessonId: context.lesson?.id || '', modality,
    });
    const provider = getGenerationProvider(providerSelection);
    const info = generationProviderInfo(providerSelection);
    assertExternalAiAllowed({ mode: info.mode, allowStudentExternalContent: policy.allowStudentExternalContent });
    if (info.configured && info.adapterAvailable) assertProviderCapability(provider, modality);
    // 业务预检（平台模态开关 / 课时能力 / 课堂管控 / 框体占用 / 首帧）在入队前拦掉，
    // 别让任务跑一遍上游再失败——与同步路径保持同一套判断。
    const requestedFirstFrame = resolveFirstFrameUrl(project.id, String(body.sourceAssetUrl || '').trim());
    const requestedLastFrame = resolveFirstFrameUrl(project.id, String(body.lastFrameAssetUrl || '').trim());
    const writtenLyrics = modality === 'MUSIC' && String(box?.mode || '').toUpperCase() === 'DESCRIPTION'
      ? await writeLyricsForMusic({ prompt, policy, requestContext: ctx, auth, lessonId: context.lesson?.id || '' })
      : '';
    // 平台把框体的比例/清晰度/时长留空时，采纳学生在画布上自选的值（仍按模型能力白名单校验）。
    const studentOptions = studentParamOptionsFrom(body);
    const options = generationOptionsFor({
      context, modality, policy, selection: providerSelection, box,
      firstFrameUrl: requestedFirstFrame,
      lastFrameUrl: requestedLastFrame,
      referenceAssets: resolveReferenceAssets(project.id, body.referenceAssets ?? body.referenceAssetUrls),
      lyrics: writtenLyrics,
      studentOptions,
    });
    assertGenerationPreflight({
      user: auth.rawUser, orgId: (auth.session?.org_id || auth.user.orgId), context, modality, projectId: project.id, boxId: box?.id || '', model: provider.model,
      frameCheck: { modes: options.inputModes, firstFrameUrl: options.firstFrameUrl || '', lastFrameUrl: options.lastFrameUrl || '', referenceAssets: options.referenceAssets || [], requestedFrames: Boolean(requestedFirstFrame || requestedLastFrame) },
    });
    const jobId = createJobRecord({ auth, project, modality, provider, prompt, requestContext: ctx, startImmediately: false, sourceAssetUrl: options.firstFrameUrl || null, lastFrameAssetUrl: options.lastFrameUrl || null, referenceAssetUrls: options.referenceAssets || null, boxId: box?.id || '', requestOptions: effectiveStudentOptions(box, studentOptions), selection: providerSelection });
    enqueuePersistedJob(jobId);
    return { job: jobDetail(jobId), queued: true };
  }
  const cancelMatch = pathname.match(/^\/api\/ai\/generations\/history\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    const jobId = decodeURIComponent(cancelMatch[1]); const job = row('SELECT * FROM generation_jobs WHERE id=? AND user_id=? AND org_id=?', [jobId, auth.user.id, (auth.session?.org_id || auth.user.orgId)]);
    if (!job) throw errors.notFound('生成任务不存在', 'GENERATION_JOB_NOT_FOUND');
    if (!['QUEUED','RUNNING'].includes(job.status)) throw errors.conflict('当前任务不能取消', 'GENERATION_NOT_CANCELABLE');
    // 2026-09-18：取消不再需要释放任何额度（课包 CU 预留那套已删；按钱的那套是准入判断、不预留）。
    q("UPDATE generation_jobs SET status='FAILED',worker_id=NULL,cancelled_at=?,error_code='GENERATION_CANCELLED',error_message='用户取消生成',completed_at=? WHERE id=?", [nowIso(), nowIso(), jobId]);
    return jobDetail(jobId, { requireAuth: auth });
  }
  const detailMatch = pathname.match(/^\/api\/ai\/generations\/history\/([^/]+)$/);
  if (detailMatch && method === 'GET') {
    const job = jobDetail(decodeURIComponent(detailMatch[1]), { requireAuth: auth });
    if (!job) throw errors.notFound('生成任务不存在', 'GENERATION_JOB_NOT_FOUND');
    return job;
  }

  if (pathname === '/api/ai/generations' && method === 'GET') {
    const projectId = String(ctx.search.get('projectId') || '').trim();
    if (!projectId) throw errors.badRequest('projectId 必填', 'PROJECT_REQUIRED');
    ownProject(auth, projectId);
    return { provider: generationProviderInfo(), ...generationHistory(auth, new URLSearchParams({ projectId })) };
  }
  if (pathname !== '/api/ai/generations' || method !== 'POST') return null;
  const body = ctx.body || {};
  const projectId = String(body.projectId || '').trim();
  const prompt = String(body.prompt || '').trim();
  const title = String(body.title || '').trim().slice(0, 100);
  const modality = modalityOf(body.modality);
  const boxId = String(body.boxId || '').trim().slice(0, 64);
  if (!projectId || projectId.length > 100) throw errors.badRequest('projectId 必填', 'PROJECT_REQUIRED');
  if (!prompt) throw errors.badRequest('请先写下素材描述', 'GENERATION_PROMPT_REQUIRED');
  if (prompt.length > 2000) throw errors.badRequest('素材描述不能超过 2000 个字符', 'GENERATION_PROMPT_TOO_LONG');
  const project = ownProject(auth, projectId);
  if (project.status !== 'DRAFT') throw errors.conflict('项目已提交，不能继续生成素材', 'PROJECT_NOT_EDITABLE');
  return runGenerationJob({ auth, project, modality, prompt, title, action: 'AI_GENERATION_CREATE', requestContext: ctx, boxId, studentOptions: studentParamOptionsFrom(body) });
}
