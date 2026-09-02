import { errors, id, json, nowIso, q, row, rows, transaction } from '../lib.js';
import { resolveProjectUsageContext } from '../services/studentContext.js';
import { generationProviderInfo, getGenerationProvider } from '../services/generationProvider.js';

const MODALITIES = new Set(['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING']);
const SESSION_CAPABILITY_BY_MODALITY = { IMAGE: 'allowImage', MUSIC: 'allowMusic', VIDEO: 'allowVideo', PODCAST: 'allowPodcast', DUBBING: 'allowDubbing' };
const PACKAGE_CAPABILITY_BY_MODALITY = { IMAGE: 'allow_image', MUSIC: 'allow_music', VIDEO: 'allow_video', PODCAST: 'allow_podcast', DUBBING: 'allow_dubbing' };
function modalityOf(value) { const modality = String(value || 'IMAGE').trim().toUpperCase(); if (!MODALITIES.has(modality)) throw errors.badRequest('不支持的素材类型', 'UNSUPPORTED_MODALITY'); return modality; }
function ownProject(auth, projectId) { const project = row("SELECT * FROM student_projects WHERE id=? AND student_id=? AND org_id=? AND status!='ARCHIVED'", [projectId, auth.user.id, auth.user.orgId]); if (!project) throw errors.notFound('项目不存在', 'PROJECT_NOT_FOUND'); return project; }
function assertCapability(modality, session, pkg) {
  const sessionCapability = SESSION_CAPABILITY_BY_MODALITY[modality];
  const packageColumn = PACKAGE_CAPABILITY_BY_MODALITY[modality];
  if (!sessionCapability) return;
  // resolveProjectUsageContext returns a normalized session with camelCase capabilities,
  // while billing_packages is read directly from SQLite and keeps snake_case columns.
  if (session && !session.capabilities?.[sessionCapability]) throw errors.forbidden('当前课堂未开放该 AI 能力', 'SESSION_CAPABILITY_DISABLED');
  if (!pkg || pkg.status !== 'ACTIVE' || !pkg[packageColumn]) throw errors.forbidden('当前套餐未开通该 AI 能力', 'PACKAGE_CAPABILITY_DISABLED');
}
function normalizeAsset(value) { return { id: value.id, jobId: value.job_id, projectId: value.project_id, modality: value.modality, label: value.label, mimeType: value.mime_type || null, assetUrl: value.asset_url, previewUrl: value.preview_url || null, metadata: JSON.parse(value.metadata || '{}'), createdAt: value.created_at }; }
function normalizeJob(value) { return { id: value.id, projectId: value.project_id, modality: value.modality, provider: value.provider, model: value.model, prompt: value.prompt, status: value.status, creditsCharged: Number(value.credits_charged || 0), errorCode: value.error_code || null, errorMessage: value.error_message || null, createdAt: value.created_at, startedAt: value.started_at || null, completedAt: value.completed_at || null }; }
function assetsFor(jobId) { return rows('SELECT * FROM media_assets WHERE job_id=? ORDER BY created_at DESC', [jobId]).map(normalizeAsset); }

export async function handleAiGeneration(ctx) {
  const { pathname, method, auth } = ctx;
  if (!pathname.startsWith('/api/ai/')) return null;
  if (!auth) throw errors.unauthorized();
  if (pathname === '/api/ai/providers' && method === 'GET') return generationProviderInfo();
  if (auth.user.role !== 'STUDENT') throw errors.forbidden();
  if (pathname === '/api/ai/generations' && method === 'GET') {
    const projectId = String(ctx.search.get('projectId') || '').trim();
    if (!projectId) throw errors.badRequest('projectId 必填', 'PROJECT_REQUIRED');
    ownProject(auth, projectId);
    const items = rows('SELECT * FROM generation_jobs WHERE project_id=? AND org_id=? AND user_id=? ORDER BY created_at DESC LIMIT 100', [projectId, auth.user.orgId, auth.user.id]).map((job) => ({ ...normalizeJob(job), assets: assetsFor(job.id) }));
    return { provider: generationProviderInfo(), items };
  }
  if (pathname !== '/api/ai/generations' || method !== 'POST') return null;
  const body = ctx.body || {};
  const projectId = String(body.projectId || '').trim();
  const prompt = String(body.prompt || '').trim();
  const title = String(body.title || '').trim().slice(0, 100);
  const modality = modalityOf(body.modality);
  if (!projectId || projectId.length > 100) throw errors.badRequest('projectId 必填', 'PROJECT_REQUIRED');
  if (!prompt) throw errors.badRequest('请先写下素材描述', 'GENERATION_PROMPT_REQUIRED');
  if (prompt.length > 2000) throw errors.badRequest('素材描述不能超过 2000 个字符', 'GENERATION_PROMPT_TOO_LONG');
  const project = ownProject(auth, projectId);
  if (project.status !== 'DRAFT') throw errors.conflict('项目已提交，不能继续生成素材', 'PROJECT_NOT_EDITABLE');
  const context = resolveProjectUsageContext(auth.rawUser, project);
  if (!context.canUseNow) throw errors.forbidden(context.blockReason, context.blockCode);
  const provider = getGenerationProvider(); const info = generationProviderInfo(); const now = nowIso(); const jobId = id('generation'); const credits = 1;
  transaction(() => q('INSERT INTO generation_jobs(id,org_id,user_id,project_id,modality,provider,model,prompt,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [jobId, auth.user.orgId, auth.user.id, project.id, modality, provider.name, provider.model, prompt, 'RUNNING', now, now]));
  try {
    const generated = await provider.generate({ modality, prompt, title, projectId: project.id, userId: auth.user.id });
    const assetPayloads = Array.isArray(generated?.assets) ? generated.assets : [];
    if (!assetPayloads.length) throw Object.assign(new Error('生成服务没有返回素材'), { code: 'GENERATION_EMPTY_RESULT' });
    const assetIds = [];
    transaction(() => {
      const user = row("SELECT * FROM users WHERE id=? AND org_id=? AND status='ACTIVE'", [auth.user.id, auth.user.orgId]);
      const freshProject = ownProject(auth, project.id); const freshContext = resolveProjectUsageContext(user, freshProject);
      if (!freshContext.canUseNow) throw errors.forbidden(freshContext.blockReason, freshContext.blockCode);
      const pkg = user.billing_package_id ? row('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [user.billing_package_id, auth.user.orgId]) : null;
      assertCapability(modality, freshContext.activeSession, pkg);
      const allowance = Number(user.monthly_credit_allowance || 0) + Number(user.monthly_bonus_credits || 0) + Number(user.month_period_boost_credits || 0);
      if (Number(user.used_credits_this_period || 0) + credits > allowance) throw errors.forbidden('个人额度不足', 'STUDENT_CREDIT_LIMIT');
      const account = row('SELECT * FROM org_billing_accounts WHERE org_id=?', [auth.user.orgId]);
      if (!account || Number(account.credit_balance || 0) < credits) throw errors.forbidden('机构积分池不足', 'ORG_CREDIT_LIMIT');
      q('UPDATE org_billing_accounts SET credit_balance=credit_balance-?,total_credits_spent=total_credits_spent+?,updated_version=updated_version+1 WHERE org_id=?', [credits, credits, auth.user.orgId]);
      q('UPDATE users SET used_credits_this_period=used_credits_this_period+?,magic_stones=MAX(0,magic_stones-?),updated_at=? WHERE id=? AND org_id=?', [credits, credits, nowIso(), auth.user.id, auth.user.orgId]);
      q('INSERT INTO usage_records(id,org_id,user_id,class_session_id,project_id,modality,model,credits_charged,status,pricing_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id('usage'), auth.user.orgId, auth.user.id, freshContext.activeSession?.id || null, project.id, modality, provider.model, credits, 'SUCCESS', json({ source: 'generation', provider: provider.name, mode: info.mode }), nowIso()]);
      q('INSERT INTO credit_entries(id,org_id,direction,type,credits,balance_after,modality,user_id,class_session_id,project_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id('credit'), auth.user.orgId, 'OUT', `AI_GENERATE_${modality}`, credits, Number(account.credit_balance) - credits, modality, auth.user.id, freshContext.activeSession?.id || null, project.id, nowIso()]);
      assetPayloads.forEach((asset, index) => { const assetId = id('asset'); assetIds.push(assetId); q('INSERT INTO media_assets(id,job_id,org_id,user_id,project_id,modality,label,mime_type,asset_url,preview_url,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [assetId, jobId, auth.user.orgId, auth.user.id, project.id, modality, String(asset.label || `${modality} 素材 ${index + 1}`).slice(0, 120), asset.mimeType || null, String(asset.assetUrl || `mock://generation/${assetId}`), asset.previewUrl || null, json(asset.metadata || {}), nowIso()]); });
      q("UPDATE generation_jobs SET status='SUCCEEDED',credits_charged=?,completed_at=? WHERE id=?", [credits, nowIso(), jobId]);
    });
    const job = row('SELECT * FROM generation_jobs WHERE id=?', [jobId]); return { job: normalizeJob(job), assets: assetsFor(jobId) };
  } catch (error) {
    q("UPDATE generation_jobs SET status='FAILED',error_code=?,error_message=?,completed_at=? WHERE id=?", [error.code || 'GENERATION_FAILED', String(error.message || '素材生成失败').slice(0, 1000), nowIso(), jobId]);
    if (error?.code) throw error;
    throw errors.badRequest('素材生成服务当前不可用，请检查 provider 配置。', 'GENERATION_PROVIDER_UNAVAILABLE');
  }
}

