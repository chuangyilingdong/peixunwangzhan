/**
 * 授权次数变更流水（`course_quota_changes`）的唯一写入口。
 *
 * 口径（用户 2026-09-18：平台侧只有「授权次数」这一个说法，交接稿里的旧口径词一律不用）：
 *   · 这张流水记的是**授权次数（库存账）**：
 *       总授权次数 = course_assignments.quota_total
 *       已授权次数 = course_assignments.quota_used
 *       剩余授权次数 = quota_total − quota_used
 *   · 它**不是财务账**。财务账是 license_purchase_batches / license_revenue_events / license_revenue_allocations
 *     （成交金额、收入确认、批次分摊）。两者**可以不一致**：平台给机构开/调授权次数
 *     默认**不生成**许可批次（用户未要求联动），来源只记在 `source` 字段里。
 *   · ⚠️ 历史数据补不出来：表建好之后只记新的；建表之前发生的事一律没有流水。
 *
 * 五个 change_type 与各自的触发点：
 *   · INITIAL_OPEN —— 初始开通：平台给机构开通课包（建 course_assignments 那一笔）。
 *       routes/admin/courses.js：POST /course-series/:id/assignments、POST /course-series/:id/assignments/append
 *       里**新建**授权单的分支（以及 services/licenseLedger.js 的追加购买里新建授权单的分支）。
 *   · ADD —— 增加授权次数：平台侧调整接口
 *       POST /api/admin/organizations/:id/course-quotas/:seriesId/adjust（delta > 0）。
 *   · REDUCE —— 减少授权次数：同一个调整接口（delta < 0）。
 *   · GRANT_CONSUME —— 授权消耗：机构把课包授权给学生
 *       POST /api/org/course-grants（含「撤销后重新授权」的复活路径 —— 以 quota_used 实际变动为准，只记一笔）。
 *   · GRANT_REFUND —— 授权取消返还：平台撤销学生授权
 *       POST /api/admin/course-grants/:id/revoke（学生还没提交过作品时才退回 1 次）。
 *
 * `delta` 的定义（五个类型同一套算法，与线框图「变更值」列一致）：
 *   delta = 剩余授权次数的变化量 = (quota_total_after − quota_used_after) − (quota_total_before − quota_used_before)
 *   所以：初始开通/增加为正、减少为负、授权消耗为负、授权取消返还为正。
 *
 * ⚠️ 事务约定：**本函数内部绝不开事务** —— 必须由调用方在自己已有的那个事务里调用，
 *    否则会出现「授权单改了、流水没写」或反过来（见各调用点的注释）。
 *    也正因为如此，它只做「读一次变更后的实际值 + 插一条流水」，不改 course_assignments。
 */
import { id, nowIso, q, row, arow, aq } from '../lib.js';

/** 五个变更类型（表里有 CHECK 约束，这里是代码侧的同一份白名单）。 */
export const COURSE_QUOTA_CHANGE_TYPES = Object.freeze([
  'INITIAL_OPEN', // 初始开通
  'ADD',          // 增加授权次数
  'REDUCE',       // 减少授权次数
  'GRANT_CONSUME',// 授权消耗
  'GRANT_REFUND', // 授权取消返还
]);

/**
 * `source`：这笔变更从哪个入口来的（可读、稳定，方便对账时回溯）。
 * 不写路由字符串是因为列表接口要按它筛/给前端解释，常量放在一处便于以后加新入口。
 */
export const COURSE_QUOTA_SOURCES = Object.freeze({
  ADMIN_ASSIGN: 'ADMIN_COURSE_SERIES_ASSIGN',      // 平台给机构开通课包（含追加购买里新建授权单）
  ADMIN_ADJUST: 'ADMIN_COURSE_QUOTA_ADJUST',       // 平台调整某机构某课包的授权次数
  ORG_GRANT: 'ORG_COURSE_GRANT',                   // 机构把课包授权给学生
  ADMIN_GRANT_REVOKE: 'ADMIN_COURSE_GRANT_REVOKE', // 平台撤销学生授权（返还 1 次）
});

function integerOf(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

/**
 * 把一条流水行转成接口返回的形状（列表接口按这个下发，前端不用自己拼）。
 * `actorName` 来自 join users 的 display_name/login；没有操作人（系统动作）时为 null。
 */
export function normalizeQuotaChange(value) {
  if (!value) return null;
  const quotaTotalBefore = integerOf(value.quota_total_before);
  const quotaTotalAfter = integerOf(value.quota_total_after);
  const quotaUsedBefore = integerOf(value.quota_used_before);
  const quotaUsedAfter = integerOf(value.quota_used_after);
  return {
    id: value.id,
    orgId: value.org_id,
    seriesId: value.series_id,
    seriesTitle: value.series_title || null,
    assignmentId: value.assignment_id || null,
    changeType: value.change_type,
    // 变更值 = 剩余授权次数的变化量（见文件头定义）
    delta: integerOf(value.delta),
    quotaTotalBefore,
    quotaTotalAfter,
    quotaUsedBefore,
    quotaUsedAfter,
    remainingBefore: Math.max(0, quotaTotalBefore - quotaUsedBefore),
    remainingAfter: Math.max(0, quotaTotalAfter - quotaUsedAfter),
    actorId: value.actor_id || null,
    actorRole: value.actor_role || null,
    actorName: value.actor_name || value.actor_login || null,
    actorLogin: value.actor_login || null,
    reason: value.reason || '',
    source: value.source || '',
    createdAt: value.created_at,
  };
}

/**
 * 记一笔授权次数变更。**必须在调用方已有的事务里调用**（内部不开事务）。
 *
 * @param orgId        机构 id（必填）
 * @param seriesId     课包 id（必填）
 * @param assignmentId 授权单 id（course_assignments.id；理论上有，历史数据可能为空）
 * @param changeType   五个类型之一，或用 'AUTO' 让本函数按 quota_total 前后变化自己判断
 *                     （新建授权单用 INITIAL_OPEN，否则增加 → ADD / 减少 → REDUCE）。
 *                     判定 AUTO 需要传 quotaTotalBefore/quotaUsedBefore 与 autoCreated。
 * @param autoCreated  仅 changeType='AUTO' 时有效：true = 这次是新建授权单（→ INITIAL_OPEN）
 * @param quotaTotalBefore / quotaUsedBefore  变更前值，缺省按 0 处理（= 新建授权单）
 * @param skipWhenUnchanged true = 变更前后剩余授权次数没变时**不写流水**并返回 null。
 *                     平台重复开通同一个课包（配额没变）就走这条，避免刷出一堆空流水。
 * @param actorId / actorRole  操作人（平台账号或机构管理员），系统动作为空
 * @param reason       原因（平台调整/禁用撤销等场景必填，开通与授权消耗可以为空）
 * @param source       COURSE_QUOTA_SOURCES 里的来源
 */
export async function recordQuotaChange({
  orgId, seriesId, assignmentId = null, changeType,
  autoCreated = false, quotaTotalBefore = 0, quotaUsedBefore = 0,
  skipWhenUnchanged = false, actorId = null, actorRole = null, reason = '', source = '',
}) {
  if (!orgId || !seriesId) return null;
  if (!assignmentId) return null;
  const requested = String(changeType || '').toUpperCase();
  if (requested !== 'AUTO' && !COURSE_QUOTA_CHANGE_TYPES.includes(requested)) {
    throw new Error(`Unknown course quota change type: ${changeType}`);
  }
  // 「变更后」的实际值只读这一次：调用方已经改完 course_assignments（同一事务内可见）。
  const assignment = await arow('SELECT id, org_id, series_id, quota_total, quota_used FROM course_assignments WHERE id=?', [assignmentId]);
  if (!assignment) return null;
  const totalBefore = integerOf(quotaTotalBefore);
  const usedBefore = integerOf(quotaUsedBefore);
  const totalAfter = integerOf(assignment.quota_total);
  const usedAfter = integerOf(assignment.quota_used);
  const remainingBefore = totalBefore - usedBefore;
  const remainingAfter = totalAfter - usedAfter;
  const delta = remainingAfter - remainingBefore;
  let resolved = requested;
  if (requested === 'AUTO') {
    // AUTO 只给「开通 / 调整授权次数」用：按总授权次数的前后变化判定类型；
    // 总授权次数没变（平台重复开通同一个课包）就没什么可记的，直接不写。
    if (autoCreated) resolved = 'INITIAL_OPEN';
    else if (totalAfter > totalBefore) resolved = 'ADD';
    else if (totalAfter < totalBefore) resolved = 'REDUCE';
    else return null;
  }
  if (skipWhenUnchanged && totalAfter === totalBefore && usedAfter === usedBefore) return null;
  const createdAt = nowIso();
  const changeId = id('quota_change');
  await aq(`INSERT INTO course_quota_changes(
      id,org_id,series_id,assignment_id,change_type,delta,
      quota_total_before,quota_total_after,quota_used_before,quota_used_after,
      actor_id,actor_role,reason,source,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    changeId, assignment.org_id, assignment.series_id, assignment.id, resolved, delta,
    totalBefore, totalAfter, usedBefore, usedAfter,
    actorId || null, actorRole || null, String(reason || '').trim(), String(source || ''),
    createdAt,
  ]);
  return normalizeQuotaChange(await arow('SELECT * FROM course_quota_changes WHERE id=?', [changeId]));
}
