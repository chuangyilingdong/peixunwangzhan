import {
  errors,
  requireRole,
  row,
  transaction,
} from '../lib.js';
import { resolveProjectUsageContext } from '../services/studentContext.js';
import { assertSessionAiControls } from '../services/aiControls.js';
import { recordAiUsage } from '../services/creditUsage.js';
import { isModalityEnabled } from './billingConfig.js';
import { assertLessonGenerationBox } from './aiGeneration.js';

// 播客 / 配音已下线（用户决定不做），只保留文本、图片、音乐、视频四类。
const MODALITIES = new Set(['TEXT', 'IMAGE', 'MUSIC', 'VIDEO']);
const SESSION_CAPABILITY_BY_MODALITY = {
  IMAGE: 'allowImage', MUSIC: 'allowMusic', VIDEO: 'allowVideo',
};
const PACKAGE_CAPABILITY_BY_MODALITY = {
  IMAGE: 'allow_image', MUSIC: 'allow_music', VIDEO: 'allow_video',
};
const LESSON_CAPABILITY_BY_MODALITY = {
  TEXT: 'text', IMAGE: 'image', VIDEO: 'video', MUSIC: 'music',
};

function normalizedModality(value) {
  const modality = String(value ?? 'TEXT').trim().toUpperCase();
  if (!MODALITIES.has(modality)) throw errors.badRequest('不支持的 AI 能力类型', 'UNSUPPORTED_MODALITY');
  return modality;
}

// 积分已废弃（2026-09-13 P4）：这个端点不再接受 / 扣减积分，只写 usage_records。
// 端点本身保留（客户端的调用形状不变），钱由生成链路按单价记 cost_fen（算力池账本）。
function recordUsage({ orgId, userId, projectId = null, sessionId = null, generationJobId = null, modality, status, failCode = null }) {
  recordAiUsage({ orgId, userId, projectId, sessionId, generationJobId, modality, status, failCode });
}

function rejectWithUsage({ orgId, userId, projectId, sessionId = null, modality, error }) {
  transaction(() => recordUsage({
    orgId, userId, projectId, sessionId, modality, status: 'BLOCKED', failCode: error.code || 'BLOCKED',
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
  let projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';

  try {
    modality = normalizedModality(body.modality);
    if (!projectId || projectId.length > 100) {
      throw errors.badRequest('projectId 必填', 'PROJECT_REQUIRED');
    }
  } catch (error) {
    if (error?.code) return rejectWithUsage({ orgId, userId, projectId: projectId || null, modality, error });
    throw error;
  }

  const project = row(
    `SELECT * FROM student_projects
     WHERE id = ? AND student_id = ? AND org_id = ? AND status != 'ARCHIVED'`,
    [projectId, userId, orgId],
  );
  if (!project) {
    return rejectWithUsage({
      orgId, userId, projectId, modality,
      error: errors.notFound('项目不存在', 'PROJECT_NOT_FOUND'),
    });
  }
  if (project.status !== 'DRAFT') {
    return rejectWithUsage({
      orgId, userId, projectId, modality,
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
    if (error?.code) return rejectWithUsage({ orgId, userId, projectId, modality, error });
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
      assertSessionAiControls({ modality, session: currentSession, orgId, userId });

      // 平台模态开关（机构覆盖优先）必须真正拦住调用，不能只影响展示
      if (!isModalityEnabled(orgId, modality).enabled) throw errors.forbidden('平台已关闭该 AI 能力', 'MODALITY_DISABLED');

      const lessonCapability = LESSON_CAPABILITY_BY_MODALITY[modality];
      if (lessonCapability && !(currentContext.lesson?.capabilities || []).includes(lessonCapability)) {
        throw errors.forbidden('本课时未开放该 AI 能力', 'LESSON_CAPABILITY_DISABLED');
      }
      // 生成框体：每框体只能生成一次；本课该模态没配框体时不限制（与生成链路同一套判断）
      assertLessonGenerationBox({ context: currentContext, modality, projectId, boxId: String(body.boxId || '').trim().slice(0, 64) });

      // 2026-09-13（P4 删积分）：这里原有的三道「积分刹车」已删除 ——
      //   ① 成员 AI 上限（ai_credit_limit/ai_credits_used）
      //   ② 周期额度（monthly_credit_allowance + bonus + boost − used_credits_this_period）
      //   ③ 课堂用量上限（session_credit_cap/consumed_credits_total）
      // 额度统一由**算力池**管：学生 × 课包、四种模态共用一个上限（services/computePool.js）。
      // 这道端点只记 usage_records（不扣钱）—— 真正花钱的是生成链路，那里按单价记 cost_fen。
      recordUsage({ orgId, userId, projectId, sessionId: currentSession?.id || null, modality, status: 'SUCCESS' });
    });
  } catch (error) {
    if (error?.code) return rejectWithUsage({ orgId, userId, projectId, modality, sessionId, error });
    throw error;
  }

  return { charged: 0, balanceAfter: null, sessionId };
}
