import { errors, id, json, nowIso, q, requireRole, row, rows } from '../lib.js';

const RETENTION_DAYS = 90;
const EVENTS = new Set([
  'page_view',
  'cta_click',
  'marketplace_view',
  'marketplace_detail_view',
  'course_view',
  'work_view',
  'demo_submitted',
  'analytics_consent_granted',
]);
const META_KEYS = new Set(['title', 'target', 'resourceType', 'resourceId', 'resultCount', 'sort']);
const FUNNEL = [
  ['page_view', '公开页访问'],
  ['marketplace_view', '课程广场访问'],
  ['marketplace_detail_view', '课程详情访问'],
  ['demo_submitted', '预约提交'],
];

function cleanOldEvents() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  q('DELETE FROM analytics_events WHERE created_at < ?', [cutoff]);
}
cleanOldEvents();

function validAnonymousId(value) {
  const text = String(value || '').trim();
  if (text.length < 16 || text.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw errors.badRequest('匿名访问标识无效', 'INVALID_ANALYTICS_ANONYMOUS_ID');
  }
  return text;
}

function validPath(value) {
  const text = String(value || '/').trim();
  if (!text.startsWith('/') || text.length > 200 || /[\r\n]/.test(text)) throw errors.badRequest('页面路径无效', 'INVALID_ANALYTICS_PATH');
  return text.split('?')[0] || '/';
}

function validMetadata(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw errors.badRequest('埋点元数据必须是对象', 'INVALID_ANALYTICS_METADATA');
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!META_KEYS.has(key)) continue;
    if (typeof item === 'string') output[key] = item.trim().slice(0, 120);
    else if (typeof item === 'number' && Number.isFinite(item)) output[key] = Math.max(0, Math.min(1000000, Math.round(item)));
    else if (typeof item === 'boolean') output[key] = item;
  }
  return output;
}

function dateFilter(search) {
  const fromRaw = search.get('from');
  const toRaw = search.get('to');
  const from = fromRaw ? new Date(fromRaw) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = toRaw ? new Date(toRaw) : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw errors.badRequest('统计日期格式无效', 'INVALID_ANALYTICS_DATE');
  if (from >= to) throw errors.badRequest('统计开始时间必须早于结束时间', 'INVALID_ANALYTICS_DATE_RANGE');
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) throw errors.badRequest('统计区间不能超过 366 天', 'ANALYTICS_DATE_RANGE_TOO_LARGE');
  return { from: from.toISOString(), to: to.toISOString() };
}

function overview(search) {
  cleanOldEvents();
  const filters = dateFilter(search);
  const params = [filters.from, filters.to];
  const byEvent = rows(`SELECT event_name, COUNT(*) AS events, COUNT(DISTINCT anonymous_id) AS visitors
    FROM analytics_events WHERE created_at >= ? AND created_at < ? GROUP BY event_name ORDER BY events DESC`, params)
    .map((item) => ({ eventName: item.event_name, events: Number(item.events), visitors: Number(item.visitors) }));
  const byDay = rows(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS events, COUNT(DISTINCT anonymous_id) AS visitors
    FROM analytics_events WHERE created_at >= ? AND created_at < ? GROUP BY day ORDER BY day`, params)
    .map((item) => ({ day: item.day, events: Number(item.events), visitors: Number(item.visitors) }));
  const counts = Object.fromEntries(byEvent.map((item) => [item.eventName, item]));
  const funnel = FUNNEL.map(([eventName, label], index) => {
    const item = counts[eventName] || { events: 0, visitors: 0 };
    const prior = index ? (counts[FUNNEL[index - 1][0]]?.visitors || 0) : item.visitors;
    return { eventName, label, events: item.events, visitors: item.visitors, rateFromPrevious: prior ? Number((item.visitors / prior * 100).toFixed(1)) : null };
  });
  const total = row('SELECT COUNT(*) AS events, COUNT(DISTINCT anonymous_id) AS visitors FROM analytics_events WHERE created_at >= ? AND created_at < ?', params);
  return {
    generatedAt: nowIso(),
    filters,
    retentionDays: RETENTION_DAYS,
    totals: { events: Number(total?.events || 0), visitors: Number(total?.visitors || 0) },
    byEvent,
    byDay,
    funnel,
    privacy: { provider: 'first-party', consentRequired: true, storedFields: ['anonymousId', 'eventName', 'path', 'allowlistedMetadata', 'occurredAt'], excludedFields: ['ip', 'userAgent', 'name', 'phone', 'email', 'rawQuery'] },
  };
}

export function handlePublicAnalytics(ctx) {
  if (ctx.pathname !== '/api/public/analytics/events' || ctx.method !== 'POST') return null;
  const body = ctx.body || {};
  if (body.analyticsConsent !== true) throw errors.badRequest('未获得统计分析同意，不记录事件', 'ANALYTICS_CONSENT_REQUIRED');
  const eventName = String(body.eventName || '').trim();
  if (!EVENTS.has(eventName)) throw errors.badRequest('埋点事件类型无效', 'INVALID_ANALYTICS_EVENT');
  const anonymousId = validAnonymousId(body.anonymousId);
  const path = validPath(body.path);
  const metadata = validMetadata(body.metadata);
  const now = nowIso();
  const eventId = id('ae');
  q('INSERT INTO analytics_events(id,anonymous_id,event_name,path,metadata,occurred_at,created_at) VALUES (?,?,?,?,?,?,?)', [eventId, anonymousId, eventName, path, json(metadata), now, now]);
  return { accepted: true, id: eventId };
}

export function handleAdminAnalytics(ctx) {
  if (ctx.pathname !== '/api/admin/analytics/overview' || ctx.method !== 'GET') return null;
  requireRole(ctx, ['SUPER_ADMIN']);
  return overview(ctx.search);
}
