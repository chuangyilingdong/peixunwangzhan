import { ApiError, audit, count, errors, id, json, normalizeUser, nowIso, q, requireRole, row, rows, transaction } from '../lib.js';
import { resolveProjectUsageContext } from '../services/studentContext.js';
import { generationProviderInfo, getGenerationProvider } from '../services/generationProvider.js';
import { assertExternalAiAllowed, assertProviderCapability, normalizeProviderError } from '../services/providerContract.js';
import { getAiProviderPolicy, isModalityEnabled } from './billingConfig.js';
import { effectiveCapabilities } from '../services/modelCapabilities.js';
import { assertSessionAiControls } from '../services/aiControls.js';
import { chargeCreditsInTransaction } from '../services/creditLedger.js';
import { debitUserAiCredits, recordAiUsage } from '../services/creditUsage.js';
import { assertTransition } from '../services/domainState.js';

const MODALITIES = new Set(['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING']);
const MODALITY_LABELS = {
  TEXT: '灵感提示词', IMAGE: '画面素材', MUSIC: '音乐素材',
  VIDEO: '故事短片', PODCAST: '播客素材', DUBBING: '配音素材',
};
const SESSION_CAPABILITY_BY_MODALITY = { IMAGE: 'allowImage', MUSIC: 'allowMusic', VIDEO: 'allowVideo', PODCAST: 'allowPodcast', DUBBING: 'allowDubbing' };
const PACKAGE_CAPABILITY_BY_MODALITY = { IMAGE: 'allow_image', MUSIC: 'allow_music', VIDEO: 'allow_video', PODCAST: 'allow_podcast', DUBBING: 'allow_dubbing' };
const LESSON_CAPABILITY_BY_MODALITY = { TEXT: 'text', IMAGE: 'image', VIDEO: 'video', MUSIC: 'music', PODCAST: 'podcast', DUBBING: 'dubbing' };
const BLOCKED_ERROR_CODES = new Set(['SESSION_AI_PAUSED', 'SESSION_CAPABILITY_DISABLED', 'SESSION_STUDENT_CALL_CAP', 'SESSION_CREDIT_CAP', 'GENERATION_FIRST_FRAME_REQUIRED', 'MODALITY_DISABLED']);
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
  const project = row(`SELECT project.*, lesson.title AS lesson_title, series.title AS series_title, class.name AS class_name
     FROM student_projects project
     LEFT JOIN course_lessons lesson ON lesson.id = project.course_lesson_id
     LEFT JOIN course_series series ON series.id = lesson.series_id
     LEFT JOIN classes class ON class.id = project.class_id AND class.org_id = project.org_id
     WHERE project.id = ? AND project.student_id = ? AND project.org_id = ?
       AND project.deleted_at IS NULL AND project.status != 'ARCHIVED'`,
    [projectId, auth.user.id, auth.user.orgId]);
  if (!project) throw errors.notFound('项目不存在', 'PROJECT_NOT_FOUND');
  return project;
}

function packageForUser(user, orgId) {
  return user.billing_package_id ? row('SELECT * FROM billing_packages WHERE id = ? AND org_id = ?', [user.billing_package_id, orgId]) : null;
}

function assertCapability(modality, session, pkg) {
  const sessionCapability = SESSION_CAPABILITY_BY_MODALITY[modality];
  const packageColumn = PACKAGE_CAPABILITY_BY_MODALITY[modality];
  if (!sessionCapability) return;
  if (session && session.capabilities && !session.capabilities[sessionCapability]) throw errors.forbidden('当前课堂未开放该 AI 能力', 'SESSION_CAPABILITY_DISABLED');
  if (!pkg || pkg.status !== 'ACTIVE' || !pkg[packageColumn]) throw errors.forbidden('当前套餐未开通该 AI 能力', 'PACKAGE_CAPABILITY_DISABLED');
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
function assertVideoFrames({ modes, firstFrameUrl = '', lastFrameUrl = '' }) {
  const list = Array.isArray(modes) && modes.length ? modes : ['TEXT'];
  const hasFirst = Boolean(String(firstFrameUrl || '').trim());
  const hasLast = Boolean(String(lastFrameUrl || '').trim());
  if (hasLast && !hasFirst) throw errors.badRequest('尾帧要配合首帧一起用：请先连接一张首帧图', 'GENERATION_LAST_FRAME_WITHOUT_FIRST');
  if (hasFirst && !list.includes('FIRST_FRAME')) throw errors.forbidden('当前视频模型不支持图片输入，请去掉连接/预置的画面', 'GENERATION_FIRST_FRAME_UNSUPPORTED');
  if (hasLast && !list.includes('LAST_FRAME')) throw errors.forbidden('当前视频模型不支持首尾帧（尾帧）', 'GENERATION_LAST_FRAME_UNSUPPORTED');
  // 模型不支持纯文本（i2v 类）时必须给首帧，否则上游必然拒绝。
  if (!hasFirst && !list.includes('TEXT')) throw errors.forbidden('当前视频模型需要先连接一张画面（首帧）再生成', 'GENERATION_FIRST_FRAME_REQUIRED');
}

/**
 * 调用上游之前的预检：课时能力 / 课堂管控 / 套餐能力任一不满足就直接拒绝。
 * 否则会先花钱调一次上游、再在结算时失败并进入重试，重复消耗额度。
 * 结算时仍会再校验一次（异步任务等待期间状态可能变化）。
 */
function assertGenerationPreflight({ user, orgId, context, modality, projectId = null, boxId = '', excludeJobId = '', frameCheck = null }) {
  const pkg = packageForUser(user, orgId);
  assertCapability(modality, context.activeSession, pkg);
  assertSessionAiControls({ modality, session: context.activeSession, orgId, userId: user.id, credits: 1 });
  // 平台模态开关（机构覆盖优先）必须真正拦住调用，不能只影响展示
  if (!isModalityEnabled(orgId, modality).enabled) throw errors.forbidden('平台已关闭该 AI 能力', 'MODALITY_DISABLED');
  const lessonCapability = LESSON_CAPABILITY_BY_MODALITY[modality];
  if (lessonCapability && !(context.lesson?.capabilities || []).includes(lessonCapability)) {
    throw errors.forbidden('本课时未开放该 AI 能力', 'LESSON_CAPABILITY_DISABLED');
  }
  if (frameCheck) assertVideoFrames(frameCheck);
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
    className: value.class_name || null, modality: value.modality,
    boxId: value.box_id || null,
    modalityLabel: MODALITY_LABELS[value.modality] || value.modality,
    provider: value.provider, model: value.model, prompt: value.prompt, status: value.status,
    creditsCharged: Number(value.credits_charged || 0), retryOfJobId: value.retry_of_job_id || null, retryCount: Number(value.retry_count || 0), maxRetries: Number(value.max_retries ?? ASYNC_GENERATION_MAX_RETRIES),
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
                 lesson.title AS lesson_title, class.name AS class_name
          FROM generation_jobs job
          LEFT JOIN student_projects project ON project.id = job.project_id
          LEFT JOIN course_lessons lesson ON lesson.id = project.course_lesson_id
          LEFT JOIN classes class ON class.id = project.class_id AND class.org_id = project.org_id`;
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
function resolveFirstFrameUrl(projectId, sourceAssetUrl) {
  const url = String(sourceAssetUrl || '').trim();
  if (!url || url.length > 2000) return '';
  const asset = row("SELECT asset_url FROM media_assets WHERE project_id = ? AND modality = 'IMAGE' AND asset_url = ?", [projectId, url]);
  return asset ? String(asset.asset_url) : '';
}

function createJobRecord({ auth, project, modality, provider, prompt, retryOfJobId = null, requestContext = null, startImmediately = true, sourceAssetUrl = null, lastFrameAssetUrl = null, boxId = '' }) {
  const jobId = id('generation');
  const now = nowIso();
  transaction(() => q(`INSERT INTO generation_jobs(
       id,org_id,user_id,project_id,modality,provider,model,prompt,status,retry_of_job_id,created_at,started_at,source_asset_url,last_frame_asset_url,box_id
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [jobId, auth.user.orgId, auth.user.id, project.id, modality, provider.name, provider.model, prompt, 'QUEUED', retryOfJobId, now, null, sourceAssetUrl, lastFrameAssetUrl, boxId || null]));
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
  return { auth, project, modality: job.modality, prompt: job.prompt, title: '', jobId, sourceAssetUrl: job.source_asset_url || '', lastFrameAssetUrl: job.last_frame_asset_url || '', boxId: job.box_id || '', requestContext: null };
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
  q("UPDATE generation_jobs SET status='QUEUED',worker_id=NULL,next_attempt_at=? WHERE status='RUNNING' AND (started_at IS NULL OR started_at < ?)", [now, new Date(Date.now() - ASYNC_RUNNING_LEASE_MS).toISOString()]);
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
    const currentJob = row('SELECT status FROM generation_jobs WHERE id=?', [jobId]);
    if (currentJob) assertTransition(auditContext({ user: { id: userId, orgId }, rawUser: null }, requestContext), 'generationJob', currentJob.status, 'FAILED', { targetType: 'GENERATION_JOB', targetId: jobId, before: currentJob, details: { errorCode: failCode } });
    q("UPDATE generation_jobs SET status='FAILED',worker_id=NULL,error_code=?,error_message=?,completed_at=? WHERE id=?",
      [failCode, String(failMessage).slice(0, 1000), failAt, jobId]);
    recordAiUsage({
      orgId, userId, projectId: project.id, sessionId: session?.id || null, generationJobId: jobId,
      modality, model: provider.model, credits: 0,
      status: BLOCKED_ERROR_CODES.has(failCode) ? 'BLOCKED' : 'FAILED', failCode,
      pricing: { source: 'generation', provider: provider.name, mode: info.mode, charged: false, blocked: BLOCKED_ERROR_CODES.has(failCode) },
    });
  });
}

function settleSuccessfulJob({ auth, project, modality, provider, info, jobId, assetPayloads, requestContext = null }) {
  transaction(() => {
    const user = row("SELECT * FROM users WHERE id = ? AND org_id = ? AND status = 'ACTIVE'", [auth.user.id, auth.user.orgId]);
    const freshProject = ownProject(auth, project.id);
    if (!user) throw errors.forbidden('学生账号不可用', 'ACCOUNT_DISABLED');
    if (freshProject.status !== 'DRAFT') throw errors.conflict('项目已提交，不能继续生成素材', 'PROJECT_NOT_EDITABLE');
    const freshContext = resolveProjectUsageContext(user, freshProject);
    if (!freshContext.canUseNow) throw errors.forbidden(freshContext.blockReason, freshContext.blockCode);
    const pkg = packageForUser(user, auth.user.orgId);
    assertCapability(modality, freshContext.activeSession, pkg);
    assertSessionAiControls({ modality, session: freshContext.activeSession, orgId: auth.user.orgId, userId: auth.user.id, credits: 1 });
    const lessonCapability = LESSON_CAPABILITY_BY_MODALITY[modality];
    if (lessonCapability && !(freshContext.lesson?.capabilities || []).includes(lessonCapability)) {
      throw errors.forbidden('本课时未开放该 AI 能力', 'LESSON_CAPABILITY_DISABLED');
    }
    // 框体占用在结算时再校验一次：等待期间同一框体可能已被另一次生成占用。
    const settledBoxId = row('SELECT box_id FROM generation_jobs WHERE id=?', [jobId])?.box_id || '';
    if (settledBoxId) assertBoxNotGenerated({ projectId: project.id, boxId: settledBoxId, excludeJobId: jobId });
    const aiLimit = user.ai_credit_limit == null ? null : Number(user.ai_credit_limit);
    if (aiLimit !== null && Number(user.ai_credits_used || 0) + 1 > aiLimit) throw errors.forbidden('该账号 AI 积分使用上限已用尽', 'AI_MEMBER_CREDIT_LIMIT');
    const allowance = Number(user.monthly_credit_allowance || 0) + Number(user.monthly_bonus_credits || 0) + Number(user.month_period_boost_credits || 0);
    if (Number(user.used_credits_this_period || 0) + 1 > allowance) throw errors.forbidden('个人额度不足', 'STUDENT_CREDIT_LIMIT');
    chargeCreditsInTransaction({
      orgId: auth.user.orgId, credits: 1, type: `AI_GENERATE_${modality}`, modality, model: provider.model,
      userId: auth.user.id, sessionId: freshContext.activeSession?.id || null, projectId: project.id,
    });
    debitUserAiCredits({ userId: auth.user.id, orgId: auth.user.orgId, credits: 1 });
    recordAiUsage({
      orgId: auth.user.orgId, userId: auth.user.id, projectId: project.id,
      sessionId: freshContext.activeSession?.id || null, generationJobId: jobId,
      modality, model: provider.model, credits: 1, status: 'SUCCESS',
      pricing: { source: 'generation', provider: provider.name, mode: info.mode },
    });
    assetPayloads.forEach((asset, index) => {
      const assetId = id('asset');
      q(`INSERT INTO media_assets(
           id,job_id,org_id,user_id,project_id,modality,label,mime_type,asset_url,preview_url,metadata,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [assetId, jobId, auth.user.orgId, auth.user.id, project.id, modality,
          String(asset.label || `${MODALITY_LABELS[modality] || modality} ${index + 1}`).slice(0, 120),
          asset.mimeType || null, String(asset.assetUrl || `mock://generation/${assetId}`), asset.previewUrl || null,
          json(asset.metadata || {}), nowIso()]);
    });
    const currentJob = row('SELECT status FROM generation_jobs WHERE id=?', [jobId]);
    assertTransition(auditContext(auth, requestContext), 'generationJob', currentJob?.status, 'SUCCEEDED', { targetType: 'GENERATION_JOB', targetId: jobId, before: currentJob, details: { modality } });
    q("UPDATE generation_jobs SET status='SUCCEEDED',worker_id=NULL,credits_charged=1,completed_at=? WHERE id=?", [nowIso(), jobId]);
  });
}

export function providerSelectionForModality(policy, modality, modelOverride = '') {
  const channelId = policy?.modalityChannels?.[String(modality || '').toUpperCase()];
  const channel = Array.isArray(policy?.channels) ? policy.channels.find((item) => item.id === channelId) : null;
  const base = channel
    ? { provider: channel.provider, model: channel.model, endpoint: channel.endpoint, channelId: channel.id, requestTemplates: channel.requestTemplates || {} }
    : { provider: policy.provider, model: policy.model, endpoint: policy.endpoint, channelId: 'default', requestTemplates: {} };
  return modelOverride ? { ...base, model: modelOverride } : base;
}

/**
 * 生成参数只以「课时配置的生成框体」为准：比例/清晰度/时长/音频由教师逐框体选定，
 * 客户端提交的取值一律不采信，避免绕过课时限制。框体没配（或本课没配该模态框体）时回落到该模型能力的第一项。
 * 输入画面：按该模型声明的方式给 —— 支持文生就可以不带图，支持首帧才用连过来的图/框体预置素材，
 * 支持尾帧才带上尾帧。学生给了模型不支持的画面会被 assertVideoFrames 拦下。
 */
export function generationOptionsFor({ context, modality, policy, selection, box = null, firstFrameUrl = '', lastFrameUrl = '' }) {
  const key = String(modality || '').toUpperCase();
  if (key !== 'IMAGE' && key !== 'VIDEO') return {};
  const channel = Array.isArray(policy?.channels) ? policy.channels.find((item) => item.id === selection?.channelId) : null;
  const capabilities = effectiveCapabilities(channel, key, selection?.model);
  const target = box || resolveLessonGenerationBox(context, key, '');
  const options = {
    aspectRatio: String(target?.aspectRatio || '').trim() || capabilities.aspectRatios[0] || '',
    resolution: String(target?.resolution || '').trim() || capabilities.resolutions[0] || '',
  };
  if (key === 'VIDEO') {
    options.durationSeconds = Number(target?.durationSeconds) || capabilities.durations[0] || 5;
    // 模型不支持生成音频时，即使框体勾选了也不发送。
    options.audio = target?.audio === true && capabilities.audio === true;
    options.inputModes = Array.isArray(capabilities.inputModes) ? capabilities.inputModes : ['TEXT'];
    // 框体挂了预置素材时，它就是首帧（学生不必自己再连一张）。
    const presetFirstFrame = options.inputModes.includes('FIRST_FRAME') ? String(target?.assetUrl || '').trim() : '';
    const resolvedFirstFrame = String(firstFrameUrl || '').trim() || presetFirstFrame;
    if (resolvedFirstFrame) options.firstFrameUrl = resolvedFirstFrame;
    if (lastFrameUrl) options.lastFrameUrl = String(lastFrameUrl).trim();
  }
  return options;
}

function auditContext(auth, ctx = null) {
  return {
    auth,
    req: ctx?.req || null,
    method: ctx?.method || null,
    pathname: ctx?.pathname || null,
  };
}

export async function runGenerationJob({ auth, project, modality, prompt, title, retryOfJobId = null, action = 'AI_GENERATION_CREATE', requestContext = null, sourceAssetUrl = '', lastFrameAssetUrl = '', boxId = '' }) {
  if (project.status !== 'DRAFT') throw errors.conflict('项目已提交，不能继续生成素材', 'PROJECT_NOT_EDITABLE');
  const policy = getAiProviderPolicy();
  const context = resolveProjectUsageContext(auth.rawUser, project);
  if (!context.canUseNow) throw errors.forbidden(context.blockReason, context.blockCode);
  const box = resolveLessonGenerationBox(context, modality, boxId);
  const providerSelection = providerSelectionForModality(policy, modality, box?.model || '');
  const provider = getGenerationProvider(providerSelection);
  const info = generationProviderInfo(providerSelection);
  assertExternalAiAllowed({ mode: info.mode, allowStudentExternalContent: policy.allowStudentExternalContent });
  if (info.configured && info.adapterAvailable) assertProviderCapability(provider, modality);
  const options = generationOptionsFor({
    context, modality, policy, selection: providerSelection, box,
    firstFrameUrl: resolveFirstFrameUrl(project.id, sourceAssetUrl),
    lastFrameUrl: resolveFirstFrameUrl(project.id, lastFrameAssetUrl),
  });
  assertGenerationPreflight({
    user: auth.rawUser, orgId: auth.user.orgId, context, modality, projectId: project.id,
    boxId: box?.id || '',
    frameCheck: { modes: options.inputModes, firstFrameUrl: options.firstFrameUrl || '', lastFrameUrl: options.lastFrameUrl || '' },
  });
  const jobId = createJobRecord({ auth, project, modality, provider, prompt, retryOfJobId, requestContext, sourceAssetUrl: options.firstFrameUrl || null, boxId: box?.id || '' });
  try {
    const generated = await provider.generate({ modality, prompt, title, projectId: project.id, userId: auth.user.id, options });
    const assetPayloads = Array.isArray(generated?.assets) ? generated.assets : [];
    if (!assetPayloads.length) throw Object.assign(new Error('生成服务没有返回素材'), { code: 'GENERATION_EMPTY_RESULT' });
    settleSuccessfulJob({ auth, project, modality, provider, info, jobId, assetPayloads, requestContext });
    audit(auditContext(auth, requestContext), action, 'GENERATION_JOB', jobId, retryOfJobId ? { jobId: retryOfJobId } : null, { modality, provider: provider.name }, { orgId: auth.user.orgId });
    const job = jobDetail(jobId);
    return { job, assets: job.assets };
  } catch (error) {
    markJobFailed({ jobId, orgId: auth.user.orgId, userId: auth.user.id, project, modality, provider, info, session: context.activeSession, error, requestContext });
    if (error instanceof ApiError) throw error;
    const normalized = normalizeProviderError(error);
    throw errors.badRequest(normalized.message, normalized.code);
  }
}


async function processAsyncGeneration(item) {
  const { auth, project, modality, prompt, title, jobId, requestContext, sourceAssetUrl = '', lastFrameAssetUrl = '', boxId = '' } = item;
  const policy = getAiProviderPolicy();
  const persistedJob = row('SELECT provider,model FROM generation_jobs WHERE id=?', [jobId]);
  // 兼容恢复的旧任务：local-mock 任务继续使用进程环境 provider；新外部任务使用创建时记录的 provider。
  const routedSelection = providerSelectionForModality(policy, modality);
  const providerSelection = persistedJob?.provider && persistedJob.provider !== 'local-mock'
    ? { provider: persistedJob.provider, model: persistedJob.model, endpoint: routedSelection.endpoint, channelId: routedSelection.channelId }
    : {};
  const provider = getGenerationProvider(providerSelection); const info = generationProviderInfo(providerSelection);
  const context = resolveProjectUsageContext(auth.rawUser, project);
  try {
    if (info.configured && info.adapterAvailable) assertProviderCapability(provider, modality);
    const box = resolveLessonGenerationBox(context, modality, boxId);
    const options = generationOptionsFor({
      context, modality, policy, selection: providerSelection, box,
      firstFrameUrl: resolveFirstFrameUrl(project.id, sourceAssetUrl),
      lastFrameUrl: resolveFirstFrameUrl(project.id, lastFrameAssetUrl),
    });
    assertGenerationPreflight({
      user: auth.rawUser, orgId: auth.user.orgId, context, modality, projectId: project.id, boxId: box?.id || '', excludeJobId: jobId,
      frameCheck: { modes: options.inputModes, firstFrameUrl: options.firstFrameUrl || '', lastFrameUrl: options.lastFrameUrl || '' },
    });
    const current = row('SELECT status FROM generation_jobs WHERE id=?', [jobId]);
    if (!current || current.status !== 'QUEUED') return;
    q("UPDATE generation_jobs SET status='RUNNING',started_at=?,worker_id=?,next_attempt_at=NULL WHERE id=? AND status='QUEUED'", [nowIso(), ASYNC_WORKER_ID, jobId]);
    const generated = await Promise.race([
      provider.generate({ modality, prompt, title, projectId: project.id, userId: auth.user.id, options }),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('AI 生成超时，请稍后重试'), { code: 'GENERATION_TIMEOUT' })), ASYNC_GENERATION_TIMEOUT_MS)),
    ]);
    const assetPayloads = Array.isArray(generated?.assets) ? generated.assets : [];
    if (!assetPayloads.length) throw Object.assign(new Error('生成服务没有返回素材'), { code: 'GENERATION_EMPTY_RESULT' });
    settleSuccessfulJob({ auth, project, modality, provider, info, jobId, assetPayloads, requestContext });
    audit(auditContext(auth, requestContext), 'AI_GENERATION_ASYNC_COMPLETE', 'GENERATION_JOB', jobId, null, { modality, provider: provider.name }, { orgId: auth.user.orgId });
  } catch (error) {
    // 业务侧拦截（能力/套餐/管控/额度）重试没有意义，直接判失败。
    const current = error instanceof ApiError ? null : row('SELECT retry_count,max_retries,status FROM generation_jobs WHERE id=?', [jobId]);
    if (current?.status === 'RUNNING' && Number(current.retry_count || 0) < Number(current.max_retries ?? ASYNC_GENERATION_MAX_RETRIES)) {
      const retryCount = Number(current.retry_count || 0) + 1; const nextAttempt = new Date(Date.now() + retryCount * 5000).toISOString();
      const normalized = normalizeProviderError(error);
      q("UPDATE generation_jobs SET status='QUEUED',worker_id=NULL,retry_count=?,next_attempt_at=?,last_error_at=?,error_code=?,error_message=? WHERE id=? AND status='RUNNING' AND worker_id=?", [retryCount, nextAttempt, nowIso(), normalized.code || error?.code || 'GENERATION_FAILED', String(normalized.message || error?.message || '生成失败'), jobId, ASYNC_WORKER_ID]);
      enqueuePersistedJob(jobId, retryCount * 5000);
    } else {
      markJobFailed({ jobId, orgId: auth.user.orgId, userId: auth.user.id, project, modality, provider, info, session: context.activeSession, error, requestContext });
    }
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
  const params = [auth.user.id, auth.user.orgId];
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
      succeeded: count("SELECT COUNT(*) n FROM generation_jobs WHERE user_id = ? AND org_id = ? AND status = 'SUCCEEDED'", [auth.user.id, auth.user.orgId]),
      failed: count("SELECT COUNT(*) n FROM generation_jobs WHERE user_id = ? AND org_id = ? AND status = 'FAILED'", [auth.user.id, auth.user.orgId]),
      creditsCharged: count('SELECT COALESCE(SUM(credits_charged),0) n FROM generation_jobs WHERE user_id = ? AND org_id = ?', [auth.user.id, auth.user.orgId]),
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

function activeAiSessions(user) {
  return rows(`SELECT session.*, lesson.title AS lesson_title
     FROM class_sessions session
     JOIN classes class ON class.id = session.class_id
     JOIN class_members member ON member.class_id = class.id
     LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
     WHERE member.user_id = ? AND member.removed_at IS NULL AND class.org_id = ?
       AND class.current_session_id = session.id AND session.status = 'ACTIVE'
     ORDER BY session.started_at DESC`, [user.id, user.org_id]);
}

function normalizeAiSession(value) {
  if (!value) return null;
  return {
    id: value.id, classId: value.class_id, lessonId: value.lesson_id || null, lessonTitle: value.lesson_title || null,
    status: value.status, aiPaused: !!value.ai_paused,
    studentCallCap: value.student_call_cap === null || value.student_call_cap === undefined ? null : Number(value.student_call_cap),
    sessionCreditCap: value.session_credit_cap === null || value.session_credit_cap === undefined ? null : Number(value.session_credit_cap),
    consumedCreditsTotal: Number(value.consumed_credits_total || 0),
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
  const pkg = packageForUser(rawUser, auth.user.orgId);
  const allowance = Number(rawUser.monthly_credit_allowance || 0) + Number(rawUser.monthly_bonus_credits || 0) + Number(rawUser.month_period_boost_credits || 0);
  const used = Number(rawUser.used_credits_this_period || 0);
  const activeSessions = activeAiSessions(rawUser).map(normalizeAiSession);
  const session = activeSessions[0] || null;
  const capabilities = AI_MODALITIES.map((modality) => {
    const capability = SESSION_CAPABILITY_BY_MODALITY[modality];
    const packageEnabled = modality === 'TEXT' || Boolean(pkg?.status === 'ACTIVE' && pkg[PACKAGE_CAPABILITY_BY_MODALITY[modality]]);
    const sessionEnabled = !capability || !session || !session.capabilities || session.capabilities[capability];
    const reasons = [];
    if (!pkg || pkg.status !== 'ACTIVE') reasons.push('当前账号未绑定可用套餐');
    else if (!packageEnabled) reasons.push('套餐未开通该能力');
    if (session?.aiPaused) reasons.push('教师已暂停课堂 AI');
    else if (!sessionEnabled) reasons.push('当前课堂未开放');
    if (session?.studentCallCap !== null && session?.studentCallCap !== undefined) {
      const usedCalls = count("SELECT COUNT(*) n FROM usage_records WHERE org_id = ? AND class_session_id = ? AND user_id = ? AND status IN ('SUCCESS','FAILED')",
        [auth.user.orgId, session.id, auth.user.id]);
      if (usedCalls >= Number(session.studentCallCap)) reasons.push('本课堂调用次数已达上限');
    }
    if (session?.sessionCreditCap !== null && session?.sessionCreditCap !== undefined
      && Number(session.consumedCreditsTotal || 0) + 1 > Number(session.sessionCreditCap)) reasons.push('课堂用量已达上限');
    if (used + 1 > allowance) reasons.push('个人额度不足');
    const scopeBlocked = rawUser.student_usage_scope !== 'HOME_PRACTICE' && !session;
    if (scopeBlocked) reasons.push(rawUser.student_usage_scope === 'FOLLOW_CLASS' ? '等待老师开启课堂' : '当前账号暂不能使用 AI');
    return {
      modality, label: MODALITY_LABELS[modality], packageEnabled, sessionEnabled,
      available: packageEnabled && sessionEnabled && !session?.aiPaused && used + 1 <= allowance && !scopeBlocked,
      reasons, creditsPerCall: 1,
    };
  });
  const jobs = {
    total: count('SELECT COUNT(*) n FROM generation_jobs WHERE user_id = ? AND org_id = ?', [auth.user.id, auth.user.orgId]),
    succeeded: count("SELECT COUNT(*) n FROM generation_jobs WHERE user_id = ? AND org_id = ? AND status = 'SUCCEEDED'", [auth.user.id, auth.user.orgId]),
    failed: count("SELECT COUNT(*) n FROM generation_jobs WHERE user_id = ? AND org_id = ? AND status = 'FAILED'", [auth.user.id, auth.user.orgId]),
    creditsCharged: count('SELECT COALESCE(SUM(credits_charged),0) n FROM generation_jobs WHERE user_id = ? AND org_id = ?', [auth.user.id, auth.user.orgId]),
  };
  const assets = rows(`SELECT asset.*, project.title AS project_title, project.status AS project_status,
            lesson.title AS lesson_title, class.name AS class_name
     FROM media_assets asset
     LEFT JOIN student_projects project ON project.id = asset.project_id
     LEFT JOIN course_lessons lesson ON lesson.id = project.course_lesson_id
     LEFT JOIN classes class ON class.id = project.class_id AND class.org_id = project.org_id
     WHERE asset.user_id = ? AND asset.org_id = ?
     ORDER BY asset.created_at DESC LIMIT 100`, [auth.user.id, auth.user.orgId]);
  const projects = rows('SELECT id,canvas_snapshot FROM student_projects WHERE student_id = ? AND org_id = ?', [auth.user.id, auth.user.orgId]);
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
  const assetTotal = count('SELECT COUNT(*) n FROM media_assets WHERE user_id = ? AND org_id = ?', [auth.user.id, auth.user.orgId]);
  const normalizedAssets = assets.map((asset) => ({
    ...normalizeAsset(asset),
    projectTitle: asset.project_title || null,
    projectStatus: asset.project_status || null,
    courseLessonTitle: asset.lesson_title || null,
    className: asset.class_name || null,
    usage: assetUsageStatus(asset, currentByProject.get(asset.project_id), snapshotsByProject.get(asset.project_id) || []),
  }));
  return {
    provider: generationProviderInfo(),
    period: {
      allowance, used, remaining: Math.max(0, allowance - used),
      start: rawUser.period_start_at || null, reset: rawUser.period_reset_at || null,
      expired: Boolean(rawUser.period_reset_at && rawUser.period_reset_at <= nowIso()),
    },
    usageScope: rawUser.student_usage_scope || null,
    magicStones: Number(rawUser.magic_stones || 0),
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
  if (pathname === '/api/ai/generations/async' && method === 'POST') {
    const body = ctx.body || {}; const projectId = String(body.projectId || '').trim(); const prompt = String(body.prompt || '').trim(); const title = String(body.title || '').trim().slice(0, 100); const modality = modalityOf(body.modality); const boxId = String(body.boxId || '').trim().slice(0, 64);
    if (!projectId || !prompt) throw errors.badRequest('projectId 和素材描述必填', 'GENERATION_FIELDS_REQUIRED');
    const project = ownProject(auth, projectId); if (project.status !== 'DRAFT') throw errors.conflict('项目已提交，不能继续生成素材', 'PROJECT_NOT_EDITABLE');
    const policy = getAiProviderPolicy();
    const context = resolveProjectUsageContext(auth.rawUser, project); if (!context.canUseNow) throw errors.forbidden(context.blockReason, context.blockCode);
    const box = resolveLessonGenerationBox(context, modality, boxId);
    const providerSelection = providerSelectionForModality(policy, modality, box?.model || '');
    const provider = getGenerationProvider(providerSelection);
    const info = generationProviderInfo(providerSelection);
    assertExternalAiAllowed({ mode: info.mode, allowStudentExternalContent: policy.allowStudentExternalContent });
    if (info.configured && info.adapterAvailable) assertProviderCapability(provider, modality);
    // 业务预检（平台模态开关 / 课时能力 / 课堂管控 / 框体占用 / 首帧）在入队前拦掉，
    // 别让任务跑一遍上游再失败——与同步路径保持同一套判断。
    const options = generationOptionsFor({
      context, modality, policy, selection: providerSelection, box,
      firstFrameUrl: resolveFirstFrameUrl(project.id, String(body.sourceAssetUrl || '').trim()),
      lastFrameUrl: resolveFirstFrameUrl(project.id, String(body.lastFrameAssetUrl || '').trim()),
    });
    assertGenerationPreflight({
      user: auth.rawUser, orgId: auth.user.orgId, context, modality, projectId: project.id, boxId: box?.id || '',
      frameCheck: { modes: options.inputModes, firstFrameUrl: options.firstFrameUrl || '', lastFrameUrl: options.lastFrameUrl || '' },
    });
    const jobId = createJobRecord({ auth, project, modality, provider, prompt, requestContext: ctx, startImmediately: false, sourceAssetUrl: options.firstFrameUrl || null, lastFrameAssetUrl: options.lastFrameUrl || null, boxId: box?.id || '' });
    enqueuePersistedJob(jobId);
    return { job: jobDetail(jobId), queued: true };
  }
  const cancelMatch = pathname.match(/^\/api\/ai\/generations\/history\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    const jobId = decodeURIComponent(cancelMatch[1]); const job = row('SELECT * FROM generation_jobs WHERE id=? AND user_id=? AND org_id=?', [jobId, auth.user.id, auth.user.orgId]);
    if (!job) throw errors.notFound('生成任务不存在', 'GENERATION_JOB_NOT_FOUND');
    if (!['QUEUED','RUNNING'].includes(job.status)) throw errors.conflict('当前任务不能取消', 'GENERATION_NOT_CANCELABLE');
    q("UPDATE generation_jobs SET status='FAILED',worker_id=NULL,cancelled_at=?,error_code='GENERATION_CANCELLED',error_message='用户取消生成',completed_at=? WHERE id=?", [nowIso(), nowIso(), jobId]);
    return jobDetail(jobId, { requireAuth: auth });
  }
  if (pathname === '/api/ai/generations/history' && method === 'GET') return generationHistory(auth, ctx.search);
  if (pathname === '/api/ai/generations/history' && method === 'POST') {
    const body = ctx.body || {};
    const sourceJobId = String(body.jobId || '').trim();
    if (!sourceJobId || sourceJobId.length > 100) throw errors.badRequest('jobId 必填', 'JOB_REQUIRED');
    const source = row('SELECT * FROM generation_jobs WHERE id = ?', [sourceJobId]);
    if (!source || source.org_id !== auth.user.orgId || source.user_id !== auth.user.id) throw errors.notFound('生成任务不存在', 'GENERATION_JOB_NOT_FOUND');
    if (source.status !== 'FAILED') throw errors.conflict('仅失败任务可以重试', 'GENERATION_NOT_RETRYABLE');
    const project = ownProject(auth, source.project_id);
    return runGenerationJob({
      auth, project, modality: modalityOf(source.modality), prompt: source.prompt,
      retryOfJobId: source.id, action: 'AI_GENERATION_RETRY', requestContext: ctx,
      sourceAssetUrl: source.source_asset_url || '', lastFrameAssetUrl: source.last_frame_asset_url || '', boxId: source.box_id || '',
    });
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
  return runGenerationJob({ auth, project, modality, prompt, title, action: 'AI_GENERATION_CREATE', requestContext: ctx, boxId });
}
