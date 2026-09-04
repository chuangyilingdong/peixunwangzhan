import { audit, errors } from '../lib.js';

/**
 * 单一领域状态字典。前后端页面应使用这些稳定值，不再自行发明同义文案。
 * 暂缓的举报、申诉、违规/内容审核、监护人和正式法律流程不在本字典的本轮业务范围内。
 */
export const DOMAIN_STATES = Object.freeze({
  organization: Object.freeze(['TRIAL', 'ACTIVE', 'FROZEN', 'DISABLED', 'EXPIRED']),
  user: Object.freeze(['ACTIVE', 'DISABLED']),
  enrollment: Object.freeze(['PENDING', 'ACTIVE', 'SUSPENDED', 'VOIDED', 'EXPIRED']),
  payment: Object.freeze(['UNRECORDED', 'RECORDED', 'WAIVED']),
  courseSeries: Object.freeze(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
  courseLesson: Object.freeze(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
  courseAssignment: Object.freeze(['ACTIVE', 'REVOKED']),
  class: Object.freeze(['ACTIVE', 'ARCHIVED']),
  classSession: Object.freeze(['ACTIVE', 'ENDED']),
  studentProject: Object.freeze(['DRAFT', 'SUBMITTED', 'GRADED', 'ARCHIVED']),
  work: Object.freeze(['PENDING', 'APPROVED', 'REJECTED', 'PUBLISHED']),
  workPublishRequest: Object.freeze(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN']),
  usage: Object.freeze(['SUCCESS', 'FAILED', 'BLOCKED']),
  generationJob: Object.freeze(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']),
  notification: Object.freeze(['DRAFT', 'PUBLISHED', 'RECALLED']),
  notificationTemplate: Object.freeze(['ACTIVE', 'DISABLED']),
  notificationRecipient: Object.freeze(['PENDING', 'DELIVERED', 'FAILED']),
  notificationEvent: Object.freeze(['PENDING', 'DELIVERED', 'SUPPRESSED', 'FAILED']),
  notificationDispatchJob: Object.freeze(['PENDING', 'IN_PROGRESS', 'FAILED', 'DEAD_LETTER', 'SUCCEEDED']),
  material: Object.freeze(['ACTIVE', 'DISABLED']),
  rechargeOrder: Object.freeze(['PENDING', 'PAID', 'CANCELLED', 'REFUNDED', 'INVOICED']),
  accountRequest: Object.freeze(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']),
  helpFeedback: Object.freeze(['SUBMITTED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']),
  fileAsset: Object.freeze(['PENDING', 'ACTIVE', 'DISABLED', 'REMOVED']),
  fileReview: Object.freeze(['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED']),
  creditEntry: Object.freeze(['EFFECTIVE', 'VOIDED']),
});

export const DOMAIN_TRANSITIONS = Object.freeze({
  organization: Object.freeze({
    TRIAL: Object.freeze(['ACTIVE', 'FROZEN', 'DISABLED', 'EXPIRED']),
    ACTIVE: Object.freeze(['FROZEN', 'DISABLED', 'EXPIRED']),
    FROZEN: Object.freeze(['ACTIVE', 'DISABLED', 'EXPIRED']),
    DISABLED: Object.freeze(['ACTIVE', 'EXPIRED']),
    EXPIRED: Object.freeze([]),
  }),
  user: Object.freeze({ ACTIVE: Object.freeze(['DISABLED']), DISABLED: Object.freeze(['ACTIVE']) }),
  enrollment: Object.freeze({
    PENDING: Object.freeze(['ACTIVE', 'VOIDED', 'EXPIRED']),
    ACTIVE: Object.freeze(['SUSPENDED', 'EXPIRED', 'VOIDED']),
    SUSPENDED: Object.freeze(['ACTIVE', 'EXPIRED', 'VOIDED']),
    EXPIRED: Object.freeze(['ACTIVE', 'VOIDED']),
    VOIDED: Object.freeze([]),
  }),
  payment: Object.freeze({
    UNRECORDED: Object.freeze(['RECORDED', 'WAIVED']),
    RECORDED: Object.freeze(['WAIVED']),
    WAIVED: Object.freeze(['RECORDED']),
  }),
  courseSeries: Object.freeze({ DRAFT: Object.freeze(['PUBLISHED', 'ARCHIVED']), PUBLISHED: Object.freeze(['ARCHIVED']), ARCHIVED: Object.freeze(['PUBLISHED']) }),
  courseLesson: Object.freeze({ DRAFT: Object.freeze(['PUBLISHED', 'ARCHIVED']), PUBLISHED: Object.freeze(['ARCHIVED']), ARCHIVED: Object.freeze(['PUBLISHED']) }),
  courseAssignment: Object.freeze({ ACTIVE: Object.freeze(['REVOKED']), REVOKED: Object.freeze(['ACTIVE']) }),
  class: Object.freeze({ ACTIVE: Object.freeze(['ARCHIVED']), ARCHIVED: Object.freeze([]) }),
  classSession: Object.freeze({ ACTIVE: Object.freeze(['ENDED']), ENDED: Object.freeze([]) }),
  studentProject: Object.freeze({ DRAFT: Object.freeze(['SUBMITTED', 'ARCHIVED']), SUBMITTED: Object.freeze(['GRADED', 'DRAFT', 'ARCHIVED']), GRADED: Object.freeze(['ARCHIVED']), ARCHIVED: Object.freeze(['DRAFT']) }),
  work: Object.freeze({ PENDING: Object.freeze(['APPROVED', 'REJECTED']), APPROVED: Object.freeze(['PUBLISHED', 'PENDING', 'REJECTED']), REJECTED: Object.freeze(['PENDING']), PUBLISHED: Object.freeze(['REJECTED']) }),
  workPublishRequest: Object.freeze({ PENDING: Object.freeze(['APPROVED', 'REJECTED', 'WITHDRAWN']), APPROVED: Object.freeze([]), REJECTED: Object.freeze([]), WITHDRAWN: Object.freeze([]) }),
  usage: Object.freeze({ SUCCESS: Object.freeze([]), FAILED: Object.freeze([]), BLOCKED: Object.freeze([]) }),
  generationJob: Object.freeze({ QUEUED: Object.freeze(['RUNNING', 'FAILED']), RUNNING: Object.freeze(['SUCCEEDED', 'FAILED']), SUCCEEDED: Object.freeze([]), FAILED: Object.freeze([]) }),
  notification: Object.freeze({ DRAFT: Object.freeze(['PUBLISHED', 'RECALLED']), PUBLISHED: Object.freeze(['RECALLED']), RECALLED: Object.freeze([]) }),
  notificationTemplate: Object.freeze({ ACTIVE: Object.freeze(['DISABLED']), DISABLED: Object.freeze(['ACTIVE']) }),
  notificationRecipient: Object.freeze({ PENDING: Object.freeze(['DELIVERED', 'FAILED']), DELIVERED: Object.freeze(['FAILED']), FAILED: Object.freeze(['PENDING', 'DELIVERED']) }),
  notificationEvent: Object.freeze({ PENDING: Object.freeze(['DELIVERED', 'SUPPRESSED', 'FAILED']), DELIVERED: Object.freeze([]), SUPPRESSED: Object.freeze([]), FAILED: Object.freeze(['PENDING']) }),
  notificationDispatchJob: Object.freeze({ PENDING: Object.freeze(['IN_PROGRESS', 'FAILED', 'DEAD_LETTER']), IN_PROGRESS: Object.freeze(['SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'PENDING']), FAILED: Object.freeze(['PENDING', 'DEAD_LETTER']), DEAD_LETTER: Object.freeze(['PENDING']), SUCCEEDED: Object.freeze([]) }),
  material: Object.freeze({ ACTIVE: Object.freeze(['DISABLED']), DISABLED: Object.freeze(['ACTIVE']) }),
  rechargeOrder: Object.freeze({ PENDING: Object.freeze(['PAID', 'CANCELLED']), PAID: Object.freeze(['REFUNDED', 'INVOICED']), INVOICED: Object.freeze(['REFUNDED']), CANCELLED: Object.freeze([]), REFUNDED: Object.freeze([]) }),
  accountRequest: Object.freeze({ PENDING: Object.freeze(['APPROVED', 'REJECTED', 'CANCELLED']), APPROVED: Object.freeze([]), REJECTED: Object.freeze([]), CANCELLED: Object.freeze([]) }),
  helpFeedback: Object.freeze({ SUBMITTED: Object.freeze(['IN_PROGRESS', 'RESOLVED', 'CLOSED']), IN_PROGRESS: Object.freeze(['RESOLVED', 'CLOSED']), RESOLVED: Object.freeze(['CLOSED']), CLOSED: Object.freeze([]) }),
  fileAsset: Object.freeze({ PENDING: Object.freeze(['ACTIVE', 'DISABLED', 'REMOVED']), ACTIVE: Object.freeze(['DISABLED', 'REMOVED']), DISABLED: Object.freeze(['ACTIVE', 'REMOVED']), REMOVED: Object.freeze([]) }),
  fileReview: Object.freeze({ NOT_REQUIRED: Object.freeze([]), PENDING: Object.freeze(['APPROVED', 'REJECTED']), APPROVED: Object.freeze(['PENDING', 'REJECTED']), REJECTED: Object.freeze(['PENDING', 'APPROVED']) }),
  creditEntry: Object.freeze({ EFFECTIVE: Object.freeze(['VOIDED']), VOIDED: Object.freeze([]) }),
});

function domainLabel(domain) { return String(domain || '').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(); }
export function stateValues(domain) { return DOMAIN_STATES[domain] || []; }
export function isKnownState(domain, value) { return stateValues(domain).includes(String(value || '').toUpperCase()); }
export function canTransition(domain, from, to) {
  const current = String(from || '').toUpperCase();
  const next = String(to || '').toUpperCase();
  return isKnownState(domain, current) && isKnownState(domain, next) && Boolean(DOMAIN_TRANSITIONS[domain]?.[current]?.includes(next));
}

export function assertKnownState(domain, value, { field = 'status' } = {}) {
  const normalized = String(value || '').toUpperCase();
  if (!isKnownState(domain, normalized)) throw errors.badRequest(`${field} 无效`, `INVALID_${domainLabel(domain)}_STATUS`, { domain, value });
  return normalized;
}

/**
 * 在真正写库前校验状态转换。非法转换会产生审计记录，便于定位前端旧枚举、重复提交和越权调用。
 */
export function assertTransition(ctx, domain, from, to, { targetType, targetId, before = null, details = null, message = null, code = null, allowedFrom = null, allowSameState = false } = {}) {
  const current = assertKnownState(domain, from);
  const next = assertKnownState(domain, to);
  if ((canTransition(domain, current, next) || (allowSameState && current === next)) && (!allowedFrom || allowedFrom.includes(current))) return next;
  const transitionCode = code || `INVALID_${domainLabel(domain)}_TRANSITION`;
  audit(ctx || {}, 'DOMAIN_INVALID_TRANSITION', targetType || domainLabel(domain), targetId, before ?? { status: current }, { status: next, domain, code: transitionCode, details });
  throw errors.conflict(message || `${domainLabel(domain)} 状态 ${current} 不允许转换为 ${next}`, transitionCode, { domain, from: current, to: next });
}

export function transitionOrThrow(domain, from, to, options = {}) {
  return assertTransition(null, domain, from, to, options);
}

export function domainStateContract() {
  return Object.fromEntries(Object.entries(DOMAIN_STATES).map(([domain, values]) => [domain, { values, transitions: DOMAIN_TRANSITIONS[domain] }]));
}
