// 平台管理端「audit」域路由：从 adminOrg.js 拆出，行为不变。
import {
  audit, count, errors, id, json, normalizeOrg, normalizePackage,
  normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson,
  assignmentActiveSql, PLATFORM_ADMIN_PERMISSIONS, platformPermissionForPathname, q, requirePlatformPermission, requireRole, row, rows, transaction, verifyPassword,
} from '../../lib.js';
import { hashPassword } from '@platform/database';
import { randomUUID } from 'node:crypto';
import { scheduleReminder } from '../communication.js';
import { assertKnownState, assertTransition } from '../../services/domainState.js';
import { getAiProviderPolicy } from '../billingConfig.js';
import { effectiveCapabilities, normalizeAspectRatio } from '../../services/modelCapabilities.js';
import { disableMfa, enableMfa, mfaSummary, regenerateRecoveryCodes, startMfaSetup } from '../../services/mfa.js';
import { normalizeSubmission } from '../vibecoding.js';
import {
  ENROLLMENT_STATUSES,
  ORG_MEMBER_ROLES,
  ORG_TEACHER_PERMISSIONS,
  PAYMENT_STATUSES,
  accessibleLesson,
  accessibleSeries,
  annotationRows,
  appendEnrollmentEvent,
  assertAnnotationNode,
  assertEnrollmentSeat,
  assertNotLastOrgAdmin,
  assertSelfPassword,
  auditListQuery,
  auditQuery,
  auditRow,
  buildOrganizationDetail,
  buildStudentDataExport,
  bumpSeriesVersion,
  contactPayload,
  createMember,
  csvDocument,
  csvFileName,
  enrollmentDate,
  enrollmentRow,
  ensureOrgBilling,
  escapeCsv,
  expireDueEnrollments,
  hasAnyPlatformPermission,
  hasPermission,
  importItems,
  integer,
  lastSuperAdminGuard,
  normalizeCanvasTemplateSnapshot,
  normalizeClassroomConfig,
  normalizeDeliveryMode,
  normalizeEnrollment,
  normalizeWorkPublishRequest,
  occupiedStudentSeats,
  orgAccountRequestRow,
  orgAccountRequestRows,
  orgAdminRows,
  orgContractMeta,
  orgId,
  orgMemberRow,
  orgUser,
  organizationFilters,
  organizationRow,
  packageSnapshot,
  packageWithSeatUsage,
  platformAdminPermissions,
  platformIssuerName,
  platformUserFilters,
  platformUserRow,
  platformWorkFilters,
  previewImport,
  replaceLessonCanvasConfig,
  replaceLessonTeachingMaterials,
  reportResolution,
  setStudentEnrollmentAccess,
  softDeleteStudent,
  userLoginMeta,
  validateImportItem,
  validateMemberPermissions,
  validateMemberPhone,
  validateSeriesForPublishing,
  validateTeacher,
  workInReviewScope,
  workReportInReviewScope,
  workReportRows,
} from './helpers.js';

export async function handleAudit(ctx, part, method) {
  if (part === '/audit-logs' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const q = auditQuery(ctx);
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    // 审计列表固定按时间倒序；返回 sort 元数据保持十类列表协议一致。
    const sort = 'created';
    const total = Number(row('SELECT COUNT(*) n FROM audit_logs WHERE ' + q.where.replace(/audit\./g, ''), q.params)?.n || 0);
    const items = rows(auditListQuery(q.where) + ' LIMIT ? OFFSET ?', [...q.params, limit, (page - 1) * limit]).map(auditRow);
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }
  if (part === '/audit-logs/summary' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const q = auditQuery(ctx);
    const base = 'SELECT audit.*, actor.display_name actor_name, actor.login actor_login, org.name org_name FROM audit_logs audit LEFT JOIN users actor ON actor.id=audit.actor_id LEFT JOIN organizations org ON org.id=audit.org_id WHERE ' + q.where;
    const byAction = rows('SELECT action, COUNT(*) n FROM (' + base + ') s GROUP BY action ORDER BY n DESC LIMIT 20', q.params).map((i) => ({ action: i.action, count: Number(i.n) }));
    const byActor = rows("SELECT actor_id, COALESCE(actor_name, actor_login, '系统') as actor_name, COUNT(*) n FROM (" + base + ') s GROUP BY actor_id, actor_name ORDER BY n DESC LIMIT 10', q.params).map((i) => ({ actorId: i.actor_id || null, actorName: i.actor_name, count: Number(i.n) }));
    const byOrg = rows('SELECT org_id, org_name, COUNT(*) n FROM (' + base + ') s GROUP BY org_id, org_name ORDER BY n DESC LIMIT 10', q.params).map((i) => ({ orgId: i.org_id || null, orgName: i.org_name || '平台', count: Number(i.n) }));
    const total = row('SELECT COUNT(*) n FROM audit_logs WHERE ' + q.where.replace(/audit\./g, ''), q.params);
    return { total: Number(total && total.n || 0), byAction, byActor, byOrg };
  }
  if (part === '/audit-logs/export' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const q = auditQuery(ctx);
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 2000, fallback: 500 });
    const items = rows(auditListQuery(q.where) + ' LIMIT ' + limit, q.params).map(auditRow);
    const hdr = ['时间', '操作者', '角色', '机构', '动作', '目标类型', '目标ID', '请求方法', '请求路径', 'IP', '变更前', '变更后'];
    const lines = [hdr.map(escapeCsv).join(',')];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      lines.push([item.createdAt, item.actorName, item.actorRole || '', item.orgName || '', item.action, item.targetType, item.targetId || '', item.requestMethod || '', item.requestPath || '', item.ip || '', JSON.stringify(item.before || {}), JSON.stringify(item.after || {})].map(escapeCsv).join(','));
    }
    const csv = '\ufeff' + lines.join('\r\n') + '\r\n';
    audit(ctx, 'PLATFORM_AUDIT_EXPORT', 'AUDIT_LOG', null, null, { count: items.length, filters: { orgId: ctx.search.get('orgId') || null, action: ctx.search.get('action') || null, from: ctx.search.get('from') || null, to: ctx.search.get('to') || null, actorId: ctx.search.get('actorId') || null, targetType: ctx.search.get('targetType') || null, targetId: ctx.search.get('targetId') || null } });
    return { filename: 'audit-logs-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv', content: csv, count: items.length };
  }
  if (part === '/audit-logs/actions' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const items = rows('SELECT action, COUNT(*) n FROM audit_logs GROUP BY action ORDER BY action ASC').map((i) => ({ action: i.action, count: Number(i.n) }));
    return { items, total: items.length };
  }

  return null;
}
