import {
  errors,
  id,
  json,
  nowIso,
  q,
  requireRole,
  row,
  transaction,
} from '../lib.js';
import { resolveProjectUsageContext } from '../services/studentContext.js';
import { assertSessionAiControls } from '../services/aiControls.js';
import { chargeCreditsInTransaction } from '../services/creditLedger.js';

const MODALITIES = new Set(['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING']);
const SESSION_CAPABILITY_BY_MODALITY = {
  IMAGE: 'allowImage', MUSIC: 'allowMusic', VIDEO: 'allowVideo',
  PODCAST: 'allowPodcast', DUBBING: 'allowDubbing',
};
const PACKAGE_CAPABILITY_BY_MODALITY = {
  IMAGE: 'allow_image', MUSIC: 'allow_music', VIDEO: 'allow_video',
  PODCAST: 'allow_podcast', DUBBING: 'allow_dubbing',
};

function normalizedModality(value) {
  const modality = String(value ?? 'TEXT').trim().toUpperCase();
  if (!MODALITIES.has(modality)) throw errors.badRequest('不支持的 AI 能力类型', 'UNSUPPORTED_MODALITY');
  return modality;
}

function creditsFor(value) {
  const credits = Number(value ?? 1);
  if (!Number.isFinite(credits) || !Number.isInteger(credits) || credits < 0 || credits > 10000) {
    throw errors.badRequest('积分必须是 0 到 10000 的整数', 'INVALID_CREDITS');
  }
  return credits;
}

function recordUsage({ orgId, userId, projectId = null, sessionId = null, generationJobId = null, modality, credits, status, failCode = null }) {
  q(
    `INSERT INTO usage_records(
      id,org_id,user_id,class_session_id,project_id,generation_job_id,modality,model,credits_charged,status,fail_code,pricing_snapshot,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('usage'), orgId, userId, sessionId, projectId, generationJobId, modality, 'local-p0', credits,
      status, failCode, json({ modality, credits, status, failCode, generationJobId }), nowIso(),
    ],
  );
}

function rejectWithUsage({ orgId, userId, projectId, sessionId = null, modality, credits, error }) {
  transaction(() => recordUsage({
    orgId, userId, projectId, sessionId, modality, credits, status: 'BLOCKED', failCode: error.code || 'BLOCKED',
  }));
  throw error;
}

function assertCapability(modality, session, pkg) {
  const sessionColumn = SESSION_CAPABILITY_BY_MODALITY[modality];
  const packageColumn = PACKAGE_CAPABILITY_BY_MODALITY[modality];
  if (!sessionColumn) return;
  if (session && session.capabilities && !session.capabilities[sessionColumn]) {
    throw errors.forbidden('当前课堂未开放该 AI 能力', 'SESSION_CAPABILITY_DISABLED');
  }
  if (!pkg || pkg.status !== 'ACTIVE' || !pkg[packageColumn]) {
    throw errors.forbidden('当前套餐未开通该 AI 能力', 'PACKAGE_CAPABILITY_DISABLED');
  }
}

export async function handleAi(ctx) {
  const { pathname, method, auth } = ctx;
  if (!pathname.startsWith('/api/ai/')) return null;
  if (pathname !== '/api/ai/usage' || method !== 'POST') return null;
  requireRole(ctx, ['STUDENT']);

  const orgId = auth.user.orgId;
  const userId = auth.user.id;
  const body = ctx.body || {};
  let modality = 'TEXT';
  let credits = 0;
  let projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';

  try {
    modality = normalizedModality(body.modality);
    credits = creditsFor(body.credits);
    if (!projectId || projectId.length > 100) {
      throw errors.badRequest('projectId 必填', 'PROJECT_REQUIRED');
    }
  } catch (error) {
    if (error?.code) return rejectWithUsage({ orgId, userId, projectId: projectId || null, modality, credits, error });
    throw error;
  }

  const project = row(
    `SELECT * FROM student_projects
     WHERE id = ? AND student_id = ? AND org_id = ? AND status != 'ARCHIVED'`,
    [projectId, userId, orgId],
  );
  if (!project) {
    return rejectWithUsage({
      orgId, userId, projectId, modality, credits,
      error: errors.notFound('项目不存在', 'PROJECT_NOT_FOUND'),
    });
  }
  if (project.status !== 'DRAFT') {
    return rejectWithUsage({
      orgId, userId, projectId, modality, credits,
      error: errors.conflict('项目当前不可继续创作', 'PROJECT_NOT_EDITABLE'),
    });
  }

  let lessonContext;
  try {
    lessonContext = resolveProjectUsageContext(auth.rawUser, project);
    if (!lessonContext.canUseNow) {
      throw errors.forbidden(lessonContext.blockReason, lessonContext.blockCode);
    }
  } catch (error) {
    if (error?.code) return rejectWithUsage({ orgId, userId, projectId, modality, credits, error });
    throw error;
  }

  const sessionId = lessonContext.activeSession?.id || null;
  try {
    transaction(() => {
      const currentUser = row('SELECT * FROM users WHERE id = ? AND org_id = ? AND status = ?', [userId, orgId, 'ACTIVE']);
      const currentProject = row('SELECT * FROM student_projects WHERE id=? AND student_id=? AND org_id=?', [projectId, userId, orgId]);
      if (!currentUser || !currentProject) throw errors.notFound('项目或学生不存在', 'PROJECT_NOT_FOUND');
      if (currentProject.status !== 'DRAFT') throw errors.conflict('项目当前不可继续创作', 'PROJECT_NOT_EDITABLE');

      const currentContext = resolveProjectUsageContext(currentUser, currentProject);
      if (!currentContext.canUseNow) throw errors.forbidden(currentContext.blockReason, currentContext.blockCode);
      const currentSession = currentContext.activeSession;
      const pkg = currentUser.billing_package_id
        ? row('SELECT * FROM billing_packages WHERE id = ? AND org_id = ?', [currentUser.billing_package_id, orgId])
        : null;
      assertCapability(modality, currentSession, pkg);
      assertSessionAiControls({ modality, session: currentSession, orgId, userId, credits });

      const allowance = Number(currentUser.monthly_credit_allowance || 0)
        + Number(currentUser.monthly_bonus_credits || 0)
        + Number(currentUser.month_period_boost_credits || 0);
      if (Number(currentUser.used_credits_this_period || 0) + credits > allowance) {
        throw errors.forbidden('个人额度不足', 'STUDENT_CREDIT_LIMIT');
      }
      if (currentSession?.sessionCreditCap != null
        && Number(currentSession.consumedCreditsTotal || 0) + credits > Number(currentSession.sessionCreditCap)) {
        throw errors.forbidden('课堂用量已达上限', 'SESSION_CREDIT_CAP');
      }

      // Atomic conditional spend prevents concurrent AI calls from overdrawing the pool.
      chargeCreditsInTransaction({
        orgId,
        credits,
        type: `AI_${modality}`,
        modality,
        userId,
        sessionId: currentSession?.id || null,
        projectId,
      });
      if (currentSession) {
        q('UPDATE class_sessions SET consumed_credits_total=consumed_credits_total+? WHERE id=? AND status=?', [credits, currentSession.id, 'ACTIVE']);
      }
      q(
        `UPDATE users
         SET used_credits_this_period=used_credits_this_period+?, magic_stones=MAX(0, magic_stones-?), updated_at=?
         WHERE id=? AND org_id=?`,
        [credits, credits, nowIso(), userId, orgId],
      );
      recordUsage({ orgId, userId, projectId, sessionId: currentSession?.id || null, modality, credits, status: 'SUCCESS' });
    });
  } catch (error) {
    if (error?.code) return rejectWithUsage({ orgId, userId, projectId, modality, credits, sessionId, error });
    throw error;
  }

  const account = row('SELECT credit_balance FROM org_billing_accounts WHERE org_id=?', [orgId]);
  return { charged: credits, balanceAfter: Number(account?.credit_balance || 0), sessionId };
}
