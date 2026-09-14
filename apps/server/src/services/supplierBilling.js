import { createHash } from 'node:crypto';
import { errors, id, json, nowIso, parseJson, q, row, rows, transaction } from '../lib.js';

export const SUPPLIER_CSV_VERSION = 'v1';
export const SUPPLIER_CSV_HEADER = Object.freeze([
  'schema_version', 'provider', 'provider_account_id', 'invoice_id', 'line_id', 'line_type',
  'occurred_at', 'currency', 'amount_minor', 'original_line_id', 'usage_id', 'response_payload_id',
  'response_request_id', 'request_id', 'task_id', 'gateway_id', 'description',
]);
const MAX_ROWS = 10000;
const MAX_BYTES = 10 * 1024 * 1024;
const FORMULA_PREFIX = /^[\t ]*[=+@-]/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const CURRENCY = /^[A-Z]{3}$/;
const LINE_TYPES = new Set(['USAGE', 'REFUND', 'CREDIT', 'ADJUSTMENT', 'TAX']);
const SECRET_KEY = /(api.?key|secret|password|token|credential)/i;

const hash = (value) => createHash('sha256').update(value).digest('hex');
const csvFail = (message, code, details) => { throw errors.badRequest(message, code, details); };
const csvEscape = (value) => /[",\r\n]/.test(String(value ?? '')) ? `"${String(value ?? '').replaceAll('"', '""')}"` : String(value ?? '');
const canonicalRow = (values) => values.map(csvEscape).join(',');

function parseRfc4180(input) {
  if (typeof input !== 'string') csvFail('csv 必须是字符串', 'SUPPLIER_CSV_STRING_REQUIRED');
  if (Buffer.byteLength(input) > MAX_BYTES) csvFail('CSV 文件不能超过 10MB', 'SUPPLIER_CSV_TOO_LARGE');
  const source = input.startsWith('\ufeff') ? input.slice(1) : input;
  if (!source) csvFail('CSV 不能为空', 'SUPPLIER_CSV_EMPTY');
  const records = [];
  let record = []; let field = ''; let quoted = false; let closed = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (source[index + 1] === '"') { field += '"'; index += 1; }
      else { quoted = false; closed = true; }
      continue;
    }
    if (closed) {
      if (char === ',') { record.push(field); field = ''; closed = false; continue; }
      if (char === '\r' && source[index + 1] === '\n') { record.push(field); records.push(record); record = []; field = ''; closed = false; index += 1; continue; }
      if (char === '\n') { record.push(field); records.push(record); record = []; field = ''; closed = false; continue; }
      csvFail('引号字段结束后只能出现逗号或换行', 'SUPPLIER_CSV_RFC4180_INVALID');
    }
    if (char === '"') {
      if (field) csvFail('双引号只能出现在字段开头', 'SUPPLIER_CSV_RFC4180_INVALID');
      quoted = true;
    } else if (char === ',') { record.push(field); field = ''; }
    else if (char === '\r') {
      if (source[index + 1] !== '\n') csvFail('CSV 不允许裸 CR 换行', 'SUPPLIER_CSV_RFC4180_INVALID');
      record.push(field); records.push(record); record = []; field = ''; index += 1;
    } else if (char === '\n') { record.push(field); records.push(record); record = []; field = ''; }
    else field += char;
  }
  if (quoted) csvFail('CSV 存在未闭合的双引号', 'SUPPLIER_CSV_RFC4180_INVALID');
  if (field || record.length || closed) { record.push(field); records.push(record); }
  while (records.length && records.at(-1).length === 1 && records.at(-1)[0] === '') records.pop();
  return records;
}

function csvText(value, field, lineNumber, { required = false, max = 1000 } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) csvFail(`${field} 不能为空`, 'SUPPLIER_CSV_FIELD_REQUIRED', { lineNumber, field });
  if (text.length > max) csvFail(`${field} 过长`, 'SUPPLIER_CSV_FIELD_TOO_LONG', { lineNumber, field });
  if (text && FORMULA_PREFIX.test(text)) csvFail(`${field} 不允许公式前缀`, 'SUPPLIER_CSV_FORMULA_REJECTED', { lineNumber, field });
  return text;
}

function normalizeCsvLine(values, lineNumber) {
  if (values.length !== SUPPLIER_CSV_HEADER.length) csvFail('CSV 列数与 canonical v1 不一致', 'SUPPLIER_CSV_COLUMN_COUNT', { lineNumber, expected: SUPPLIER_CSV_HEADER.length, actual: values.length });
  const raw = Object.fromEntries(SUPPLIER_CSV_HEADER.map((key, index) => [key, values[index]]));
  if (raw.schema_version !== SUPPLIER_CSV_VERSION) csvFail('schema_version 必须严格为 v1', 'SUPPLIER_CSV_VERSION_INVALID', { lineNumber });
  const type = String(raw.line_type || '').trim();
  if (!LINE_TYPES.has(type)) csvFail('line_type 无效', 'SUPPLIER_CSV_LINE_TYPE_INVALID', { lineNumber });
  const amountText = String(raw.amount_minor ?? '').trim();
  if (!/^-?\d+$/.test(amountText)) csvFail('amount_minor 必须是带符号整数最小货币单位', 'SUPPLIER_CSV_AMOUNT_INVALID', { lineNumber });
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount === 0) csvFail('amount_minor 必须是非零安全整数', 'SUPPLIER_CSV_AMOUNT_INVALID', { lineNumber });
  if (['USAGE', 'TAX'].includes(type) && amount <= 0) csvFail(`${type} 金额必须为正整数`, 'SUPPLIER_CSV_AMOUNT_SIGN_INVALID', { lineNumber });
  if (['REFUND', 'CREDIT'].includes(type) && amount >= 0) csvFail(`${type} 金额必须为负整数`, 'SUPPLIER_CSV_AMOUNT_SIGN_INVALID', { lineNumber });
  const time = String(raw.occurred_at || '').trim();
  if (!ISO_INSTANT.test(time) || Number.isNaN(new Date(time).getTime())) csvFail('occurred_at 必须是有效的带时区 ISO 8601 时间', 'SUPPLIER_CSV_TIME_INVALID', { lineNumber });
  const currency = String(raw.currency || '').trim();
  if (!CURRENCY.test(currency)) csvFail('currency 必须是三位大写币种代码', 'SUPPLIER_CSV_CURRENCY_INVALID', { lineNumber });
  const normalized = {
    schema_version: SUPPLIER_CSV_VERSION,
    provider: csvText(raw.provider, 'provider', lineNumber, { required: true, max: 100 }),
    provider_account_id: csvText(raw.provider_account_id, 'provider_account_id', lineNumber, { required: true, max: 200 }),
    invoice_id: csvText(raw.invoice_id, 'invoice_id', lineNumber, { required: true, max: 200 }),
    line_id: csvText(raw.line_id, 'line_id', lineNumber, { required: true, max: 200 }),
    line_type: type,
    occurred_at: new Date(time).toISOString(), currency, amount_minor: String(amount),
    original_line_id: csvText(raw.original_line_id, 'original_line_id', lineNumber, { max: 200 }),
    usage_id: csvText(raw.usage_id, 'usage_id', lineNumber, { max: 200 }),
    response_payload_id: csvText(raw.response_payload_id, 'response_payload_id', lineNumber, { max: 200 }),
    response_request_id: csvText(raw.response_request_id, 'response_request_id', lineNumber, { max: 200 }),
    request_id: csvText(raw.request_id, 'request_id', lineNumber, { max: 200 }),
    task_id: csvText(raw.task_id, 'task_id', lineNumber, { max: 200 }),
    gateway_id: csvText(raw.gateway_id, 'gateway_id', lineNumber, { max: 200 }),
    description: csvText(raw.description, 'description', lineNumber, { max: 2000 }),
  };
  if (type === 'REFUND' && !normalized.original_line_id) csvFail('REFUND 必须填写 original_line_id', 'SUPPLIER_ORIGINAL_LINE_REQUIRED', { lineNumber });
  if (!['REFUND', 'CREDIT'].includes(type) && normalized.original_line_id) csvFail('只有 REFUND/CREDIT 可填写 original_line_id', 'SUPPLIER_ORIGINAL_LINE_INVALID', { lineNumber });
  return { ...normalized, lineNumber, amountMinor: amount, lineHash: hash(canonicalRow(SUPPLIER_CSV_HEADER.map((key) => normalized[key]))) };
}

export function canonicalSupplierCsv(lines) {
  return '\ufeff' + [canonicalRow(SUPPLIER_CSV_HEADER), ...lines.map((line) => canonicalRow(SUPPLIER_CSV_HEADER.map((key) => line[key] ?? '')))].join('\r\n') + '\r\n';
}

export function previewSupplierCsv(csv) {
  const records = parseRfc4180(csv);
  if (records.length < 2) csvFail('CSV 至少需要一条账单行', 'SUPPLIER_CSV_EMPTY');
  if (records.length - 1 > MAX_ROWS) csvFail(`单次最多导入 ${MAX_ROWS} 行`, 'SUPPLIER_CSV_ROW_LIMIT');
  if (records[0].length !== SUPPLIER_CSV_HEADER.length || records[0].some((value, index) => value !== SUPPLIER_CSV_HEADER[index])) csvFail('CSV 表头必须与 supplier billing canonical v1 完全一致', 'SUPPLIER_CSV_HEADER_INVALID', { expected: SUPPLIER_CSV_HEADER });
  const lines = records.slice(1).map((values, index) => normalizeCsvLine(values, index + 2));
  const seen = new Set();
  for (const line of lines) {
    if (seen.has(line.line_id)) csvFail('同一文件 line_id 重复', 'SUPPLIER_CSV_LINE_DUPLICATE', { lineNumber: line.lineNumber, lineId: line.line_id });
    seen.add(line.line_id);
  }
  const canonicalCsv = canonicalSupplierCsv(lines);
  return { version: SUPPLIER_CSV_VERSION, header: [...SUPPLIER_CSV_HEADER], canonicalCsv, fileHash: hash(canonicalCsv), lineCount: lines.length, netAmountMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0), currencies: [...new Set(lines.map((line) => line.currency))], lineTypes: Object.fromEntries([...LINE_TYPES].map((type) => [type, lines.filter((line) => line.line_type === type).length])), lines };
}

function required(value, field, max = 200) {
  const text = String(value ?? '').trim();
  if (!text) throw errors.badRequest(`${field} 不能为空`, 'SUPPLIER_ACCOUNT_FIELD_REQUIRED', { field });
  if (text.length > max) throw errors.badRequest(`${field} 过长`, 'SUPPLIER_ACCOUNT_FIELD_TOO_LONG', { field });
  return text;
}

export function supplierAccount(value) {
  return value ? { id: value.id, code: value.code, name: value.name, provider: value.provider, channelId: value.channel_id || null, defaultCurrency: value.default_currency, timezone: value.timezone, status: value.status, createdAt: value.created_at, updatedAt: value.updated_at } : null;
}

function event({ accountId = null, importId = null, lineId = null, matchId = null, action, before = null, after = null, reason = '', actorId = null }) {
  q('INSERT INTO supplier_billing_events(id,supplier_account_id,import_id,line_id,match_id,action,before_data,after_data,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id('supplier_event'), accountId, importId, lineId, matchId, action, before == null ? null : json(before), after == null ? null : json(after), String(reason).slice(0, 1000), actorId, nowIso()]);
}

export function createSupplierAccount(input, actorId = null) {
  if (input && typeof input === 'object') {
    const forbidden = Object.keys(input).find((key) => SECRET_KEY.test(key));
    if (forbidden) throw errors.badRequest('供应商账户配置禁止包含密钥、令牌或密码', 'SUPPLIER_ACCOUNT_SECRET_FORBIDDEN', { field: forbidden });
  }
  const code = required(input?.code, 'code', 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(code)) throw errors.badRequest('code 格式无效', 'SUPPLIER_ACCOUNT_CODE_INVALID');
  const name = required(input?.name, 'name'); const provider = required(input?.provider, 'provider', 100);
  const channelId = String(input?.channelId || '').trim().slice(0, 100) || null;
  const defaultCurrency = String(input?.defaultCurrency || '').trim();
  if (!CURRENCY.test(defaultCurrency)) throw errors.badRequest('defaultCurrency 必须是三位大写币种代码', 'SUPPLIER_ACCOUNT_CURRENCY_INVALID');
  const timezone = String(input?.timezone || 'UTC').trim();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw errors.badRequest('timezone 无效', 'SUPPLIER_ACCOUNT_TIMEZONE_INVALID'); }
  if (row('SELECT id FROM supplier_accounts WHERE code=?', [code])) throw errors.conflict('供应商账户 code 已存在', 'SUPPLIER_ACCOUNT_EXISTS');
  const accountId = id('supplier'); const now = nowIso();
  q('INSERT INTO supplier_accounts(id,code,name,provider,channel_id,default_currency,timezone,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [accountId, code, name, provider, channelId, defaultCurrency, timezone, 'ACTIVE', actorId, now, now]);
  event({ accountId, action: 'ACCOUNT_CREATE', after: { code, name, provider, channelId, defaultCurrency, timezone }, actorId });
  return supplierAccount(row('SELECT * FROM supplier_accounts WHERE id=?', [accountId]));
}

export const listSupplierAccounts = () => rows('SELECT * FROM supplier_accounts ORDER BY name COLLATE NOCASE,id').map(supplierAccount);

function accountById(accountId, active = false) {
  const account = row('SELECT * FROM supplier_accounts WHERE id=?', [String(accountId || '')]);
  if (!account) throw errors.notFound('供应商账户不存在', 'SUPPLIER_ACCOUNT_NOT_FOUND');
  if (active && account.status !== 'ACTIVE') throw errors.conflict('供应商账户已停用', 'SUPPLIER_ACCOUNT_DISABLED');
  return account;
}

function scopedAttempts(column, value, account) {
  if (!value) return [];
  const clauses = [`${column}=?`, 'provider=?', "provider_account_ref IS NOT NULL", 'provider_account_ref=?'];
  const params = [value, account.provider, account.code];
  return rows(`SELECT id FROM compute_attempts WHERE ${clauses.join(' AND ')}`, params).map((item) => item.id);
}

function exactCandidates(line, account) {
  const stages = [
    ['USAGE', () => {
      const attempts = scopedAttempts('usage_id', line.usage_id, account).map((targetId) => ({ targetType: 'ATTEMPT', targetId }));
      if (attempts.length) return attempts;
      return line.usage_id && row('SELECT id FROM usage_records WHERE id=? AND EXISTS (SELECT 1 FROM compute_attempts WHERE internal_usage_record_id=usage_records.id AND provider=? AND provider_account_ref IS NOT NULL AND provider_account_ref=?)', [line.usage_id, account.provider, account.code]) ? [{ targetType: 'USAGE', targetId: line.usage_id }] : [];
    }],
    ['RESPONSE', () => [...scopedAttempts('response_payload_id', line.response_payload_id, account), ...scopedAttempts('response_request_id', line.response_request_id, account)].map((targetId) => ({ targetType: 'ATTEMPT', targetId }))],
    ['REQUEST', () => [...scopedAttempts('response_request_id', line.request_id, account), ...scopedAttempts('client_request_id', line.request_id, account)].map((targetId) => ({ targetType: 'ATTEMPT', targetId }))],
    ['TASK', () => scopedAttempts('task_id', line.task_id, account).map((targetId) => ({ targetType: 'ATTEMPT', targetId }))],
    ['GATEWAY', () => scopedAttempts('gateway_log_id', line.gateway_id, account).map((targetId) => ({ targetType: 'ATTEMPT', targetId }))],
  ];
  for (const [identifierType, load] of stages) {
    const unique = [...new Map(load().map((item) => [`${item.targetType}:${item.targetId}`, { ...item, identifierType }])).values()];
    if (unique.length) return unique;
  }
  return [];
}

function targetCost(targetType, targetId) {
  const target = targetType === 'ATTEMPT' ? row('SELECT upstream_cost_fen amount FROM compute_attempts WHERE id=?', [targetId]) : targetType === 'USAGE' ? row('SELECT cost_fen amount FROM usage_records WHERE id=?', [targetId]) : null;
  if (!target) throw errors.notFound('内部核销目标不存在', 'SUPPLIER_MATCH_TARGET_NOT_FOUND');
  const amount = Number(target.amount);
  return { amountMinor: Number.isSafeInteger(amount) && amount >= 0 ? amount : null, currency: 'CNY' };
}

function netAllocatedToTarget(targetType, targetId, currency, excludeLineId = null) {
  const params = [targetType, targetId, currency]; let extra = '';
  if (excludeLineId) { extra = ' AND match.line_id<>?'; params.push(excludeLineId); }
  return Number(row(`SELECT COALESCE(SUM(match.allocated_amount_minor),0) amount FROM supplier_billing_matches match JOIN supplier_billing_lines line ON line.id=match.line_id WHERE match.target_type=? AND match.target_id=? AND match.currency=? AND match.cancelled_at IS NULL AND line.reconciliation_status='MATCHED'${extra}`, params)?.amount || 0);
}

function activeMatches(lineId) {
  return rows('SELECT * FROM supplier_billing_matches WHERE line_id=? AND cancelled_at IS NULL ORDER BY created_at,id', [lineId]);
}

function matchView(match) {
  return { id: match.id, originalMatchId: match.original_match_id || null, targetType: match.target_type, targetId: match.target_id, identifierType: match.identifier_type, allocatedAmountMinor: Number(match.allocated_amount_minor), currency: match.currency, method: match.method, createdAt: match.created_at };
}

function lineView(value) {
  if (!value) return null;
  const matches = activeMatches(value.id).map(matchView);
  const allocatedAmountMinor = matches.reduce((sum, match) => sum + match.allocatedAmountMinor, 0);
  const settled = value.reconciliation_status === 'MATCHED';
  return { id: value.id, importId: value.import_id, supplierAccountId: value.supplier_account_id, lineNumber: Number(value.line_number), provider: value.provider, providerAccountId: value.provider_account_id, invoiceId: value.invoice_id, lineId: value.supplier_line_id, lineType: value.line_type, occurredAt: value.occurred_at, currency: value.currency, amountMinor: Number(value.amount_minor), originalLineId: value.original_supplier_line_id || null, originalInternalLineId: value.original_line_id || null, identifiers: { usageId: value.usage_id || null, responsePayloadId: value.response_payload_id || null, responseRequestId: value.response_request_id || null, requestId: value.request_id || null, taskId: value.task_id || null, gatewayId: value.gateway_id || null }, description: value.description || '', reconciliationStatus: value.reconciliation_status, comparisonStatus: value.comparison_status, candidateCount: Number(value.candidate_count), matchMethod: value.match_method || null, stateReason: value.state_reason || '', allocatedAmountMinor, settledAmountMinor: settled ? allocatedAmountMinor : null, settledMatchCount: settled ? matches.length : 0, matches, createdAt: value.created_at, updatedAt: value.updated_at };
}

function refreshLine(lineId) {
  const line = row('SELECT * FROM supplier_billing_lines WHERE id=?', [lineId]);
  if (!line || ['CANCELLED', 'EXCLUDED', 'DISPUTED'].includes(line.reconciliation_status)) return;
  const matches = rows('SELECT * FROM supplier_billing_matches WHERE line_id=? AND cancelled_at IS NULL', [lineId]);
  const allocated = matches.reduce((sum, match) => sum + Number(match.allocated_amount_minor), 0);
  const complete = allocated === Number(line.amount_minor);
  const status = !matches.length ? (Number(line.candidate_count) > 1 ? 'AMBIGUOUS' : 'UNMATCHED') : complete ? 'MATCHED' : 'PARTIAL';
  const comparison = !matches.length ? 'UNASSESSED' : line.currency !== 'CNY' ? 'UNKNOWN_CURRENCY' : matches.every((match) => targetCost(match.target_type, match.target_id).amountMinor !== null) ? 'KNOWN' : 'UNKNOWN_AMOUNT';
  q('UPDATE supplier_billing_lines SET reconciliation_status=?,comparison_status=?,match_method=?,state_reason=?,updated_at=? WHERE id=?', [status, comparison, matches.some((match) => match.method === 'MANUAL') ? 'MANUAL' : matches.length ? 'AUTO' : null, status === 'AMBIGUOUS' ? 'MULTIPLE_EXACT_CANDIDATES' : '', nowIso(), lineId]);
}

function addMatch({ line, targetType, targetId, identifierType, amountMinor, method, actorId, originalMatchId = null }) {
  const target = targetCost(targetType, targetId);
  let originalMatch = null;
  if (amountMinor < 0) {
    if (!originalMatchId) throw errors.conflict('退款/贷项匹配必须引用原匹配', 'SUPPLIER_ORIGINAL_MATCH_REQUIRED');
    originalMatch = row(`SELECT match.* FROM supplier_billing_matches match JOIN supplier_billing_lines source ON source.id=match.line_id
      WHERE match.id=? AND match.cancelled_at IS NULL AND match.allocated_amount_minor>0 AND source.id=? AND source.reconciliation_status='MATCHED'`, [originalMatchId, line.original_line_id]);
    if (!originalMatch || originalMatch.target_type !== targetType || originalMatch.target_id !== targetId || originalMatch.currency !== line.currency) throw errors.conflict('退款/贷项引用的原匹配无效', 'SUPPLIER_ORIGINAL_MATCH_INVALID');
    const refunded = Math.abs(Number(row('SELECT COALESCE(SUM(allocated_amount_minor),0) amount FROM supplier_billing_matches WHERE original_match_id=? AND cancelled_at IS NULL', [originalMatch.id])?.amount || 0));
    if (refunded + Math.abs(amountMinor) > Number(originalMatch.allocated_amount_minor)) throw errors.conflict('退款/贷项累计金额超过原匹配金额', 'SUPPLIER_ORIGINAL_MATCH_AMOUNT_EXCEEDED');
  } else if (originalMatchId) throw errors.badRequest('正向匹配不能引用原匹配', 'SUPPLIER_ORIGINAL_MATCH_INVALID');
  if (line.currency === target.currency && target.amountMinor !== null) {
    const allocated = netAllocatedToTarget(targetType, targetId, line.currency, line.id);
    const next = allocated + amountMinor;
    if (next > target.amountMinor) throw errors.conflict('分摊金额超过内部目标的已知金额上限', 'SUPPLIER_MATCH_TARGET_AMOUNT_EXCEEDED', { targetType, targetId, targetAmountMinor: target.amountMinor, alreadyAllocatedMinor: allocated, requestedMinor: amountMinor });
    if (next < 0) throw errors.conflict('退款/贷项不能使目标累计净成本小于 0', 'SUPPLIER_MATCH_TARGET_NEGATIVE', { targetType, targetId, alreadyAllocatedMinor: allocated, requestedMinor: amountMinor });
  }
  const matchId = id('supplier_match');
  q('INSERT INTO supplier_billing_matches(id,line_id,original_match_id,target_type,target_id,identifier_type,allocated_amount_minor,currency,method,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [matchId, line.id, originalMatch?.id || null, targetType, targetId, identifierType, amountMinor, line.currency, method, actorId, nowIso()]);
  event({ accountId: line.supplier_account_id, importId: line.import_id, lineId: line.id, matchId, action: method === 'AUTO' ? 'AUTO_MATCH' : 'MANUAL_MATCH', after: { targetType, targetId, identifierType, amountMinor, currency: line.currency, originalMatchId: originalMatch?.id || null }, actorId });
}

function autoMatchUsage(line, account, actorId) {
  const candidates = exactCandidates(line, account);
  q('UPDATE supplier_billing_lines SET candidate_count=?,reconciliation_status=?,state_reason=?,updated_at=? WHERE id=?', [candidates.length, candidates.length > 1 ? 'AMBIGUOUS' : 'UNMATCHED', candidates.length > 1 ? 'MULTIPLE_EXACT_CANDIDATES' : candidates.length ? '' : 'NO_EXACT_CANDIDATE', nowIso(), line.id]);
  if (candidates.length !== 1) return;
  try { addMatch({ line, ...candidates[0], amountMinor: Number(line.amount_minor), method: 'AUTO', actorId }); }
  catch (error) {
    if (error?.code === 'SUPPLIER_MATCH_TARGET_AMOUNT_EXCEEDED') { q("UPDATE supplier_billing_lines SET comparison_status='KNOWN',state_reason='TARGET_AMOUNT_EXCEEDED',updated_at=? WHERE id=?", [nowIso(), line.id]); return; }
    throw error;
  }
  refreshLine(line.id);
}

function linkCredits(accountId, inserted, actorId) {
  for (const line of inserted.filter((item) => ['REFUND', 'CREDIT'].includes(item.line_type) && item.original_supplier_line_id)) {
    const original = row("SELECT * FROM supplier_billing_lines WHERE supplier_account_id=? AND supplier_line_id=? AND line_type='USAGE'", [accountId, line.original_supplier_line_id]);
    if (!original) throw errors.conflict('original_line_id 对应的 USAGE 行不存在', 'SUPPLIER_ORIGINAL_LINE_NOT_FOUND', { lineId: line.supplier_line_id, originalLineId: line.original_supplier_line_id });
    const credited = Math.abs(Number(row("SELECT COALESCE(SUM(amount_minor),0) amount FROM supplier_billing_lines WHERE original_line_id=? AND reconciliation_status<>'CANCELLED' AND id<>?", [original.id, line.id])?.amount || 0));
    if (credited + Math.abs(Number(line.amount_minor)) > Number(original.amount_minor)) throw errors.conflict('退款/贷项累计金额超过原 USAGE 行', 'SUPPLIER_CREDIT_AMOUNT_EXCEEDED');
    q('UPDATE supplier_billing_lines SET original_line_id=?,updated_at=? WHERE id=?', [original.id, nowIso(), line.id]);
    line.original_line_id = original.id;
    let remaining = Math.abs(Number(line.amount_minor));
    const originals = original.reconciliation_status === 'MATCHED' ? activeMatches(original.id).filter((match) => Number(match.allocated_amount_minor) > 0) : [];
    for (const match of originals) {
      if (!remaining) break;
      const alreadyRefunded = Math.abs(Number(row('SELECT COALESCE(SUM(allocated_amount_minor),0) amount FROM supplier_billing_matches WHERE original_match_id=? AND cancelled_at IS NULL', [match.id])?.amount || 0));
      const available = Number(match.allocated_amount_minor) - alreadyRefunded;
      const amount = Math.min(remaining, Math.max(0, available));
      if (!amount) continue;
      addMatch({ line, targetType: match.target_type, targetId: match.target_id, identifierType: match.identifier_type, amountMinor: -amount, method: 'AUTO', actorId, originalMatchId: match.id });
      remaining -= amount;
    }
    q("UPDATE supplier_billing_lines SET candidate_count=?,state_reason=?,updated_at=? WHERE id=?", [originals.length, remaining ? 'ORIGINAL_MATCH_AMOUNT_UNAVAILABLE' : originals.length ? 'ORIGINAL_LINE_LINKED' : 'ORIGINAL_LINE_UNMATCHED', nowIso(), line.id]);
    refreshLine(line.id);
    event({ accountId, importId: line.import_id, lineId: line.id, action: 'ORIGINAL_LINE_LINK', after: { originalInternalLineId: original.id, originalLineId: original.supplier_line_id }, actorId });
  }
}

export function importSupplierCsv({ supplierAccountId, fileName = '', csv }, actorId = null) {
  const account = accountById(supplierAccountId, true); const preview = previewSupplierCsv(csv);
  for (const line of preview.lines) {
    if (line.provider !== account.provider || line.provider_account_id !== account.code) throw errors.conflict('CSV provider/provider_account_id 与供应商账户不一致', 'SUPPLIER_ACCOUNT_CSV_MISMATCH', { lineNumber: line.lineNumber });
  }
  const repeated = row('SELECT * FROM supplier_billing_imports WHERE supplier_account_id=? AND file_hash=?', [account.id, preview.fileHash]);
  if (repeated) return { ...supplierImport(repeated), idempotent: true };
  for (const line of preview.lines) {
    const existing = row('SELECT line_hash FROM supplier_billing_lines WHERE supplier_account_id=? AND supplier_line_id=?', [account.id, line.line_id]);
    if (existing && existing.line_hash !== line.lineHash) throw errors.conflict('line_id 已存在但内容不同', 'SUPPLIER_LINE_IDEMPOTENCY_CONFLICT', { lineNumber: line.lineNumber, lineId: line.line_id });
  }
  return transaction(() => {
    const importId = id('supplier_import'); const now = nowIso(); let duplicateLineCount = 0; const inserted = [];
    q('INSERT INTO supplier_billing_imports(id,supplier_account_id,file_name,file_hash,canonical_csv,status,line_count,imported_by,imported_at) VALUES (?,?,?,?,?,?,?,?,?)', [importId, account.id, String(fileName).slice(0, 255), preview.fileHash, preview.canonicalCsv, 'IMPORTED', preview.lineCount, actorId, now]);
    for (const item of preview.lines) {
      if (row('SELECT id FROM supplier_billing_lines WHERE supplier_account_id=? AND supplier_line_id=?', [account.id, item.line_id])) { duplicateLineCount += 1; continue; }
      const lineId = id('supplier_line');
      const excluded = ['TAX', 'ADJUSTMENT'].includes(item.line_type) || (item.line_type === 'CREDIT' && !item.original_line_id);
      q(`INSERT INTO supplier_billing_lines(id,import_id,supplier_account_id,line_number,line_hash,provider,provider_account_id,invoice_id,supplier_line_id,occurred_at,currency,amount_minor,line_type,original_supplier_line_id,usage_id,response_payload_id,response_request_id,request_id,task_id,gateway_id,description,reconciliation_status,state_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [lineId, importId, account.id, item.lineNumber, item.lineHash, item.provider, item.provider_account_id, item.invoice_id, item.line_id, item.occurred_at, item.currency, item.amountMinor, item.line_type, item.original_line_id || null, item.usage_id || null, item.response_payload_id || null, item.response_request_id || null, item.request_id || null, item.task_id || null, item.gateway_id || null, item.description, excluded ? 'EXCLUDED' : 'UNMATCHED', excluded ? 'NON_USAGE_DEFAULT_EXCLUDED' : '', now, now]);
      inserted.push(row('SELECT * FROM supplier_billing_lines WHERE id=?', [lineId]));
    }
    for (const line of inserted.filter((item) => item.line_type === 'USAGE')) autoMatchUsage(line, account, actorId);
    linkCredits(account.id, inserted, actorId);
    event({ accountId: account.id, importId, action: 'IMPORT', after: { fileHash: preview.fileHash, lineCount: preview.lineCount, insertedLineCount: inserted.length, duplicateLineCount }, actorId });
    return { ...supplierImport(row('SELECT * FROM supplier_billing_imports WHERE id=?', [importId])), insertedLineCount: inserted.length, duplicateLineCount, idempotent: false };
  });
}

export function supplierImport(value) {
  return value ? { id: value.id, supplierAccountId: value.supplier_account_id, fileName: value.file_name, fileHash: value.file_hash, status: value.status, lineCount: Number(value.line_count), importedAt: value.imported_at, cancelledAt: value.cancelled_at || null, cancelReason: value.cancel_reason || '' } : null;
}
export function getSupplierImport(importId) { const item = row('SELECT * FROM supplier_billing_imports WHERE id=?', [importId]); if (!item) throw errors.notFound('供应商账单导入不存在', 'SUPPLIER_IMPORT_NOT_FOUND'); return { ...supplierImport(item), canonicalCsv: item.canonical_csv, lines: rows('SELECT * FROM supplier_billing_lines WHERE import_id=? ORDER BY line_number', [item.id]).map(lineView) }; }
export function exportSupplierImport(importId) { const item = row('SELECT * FROM supplier_billing_imports WHERE id=?', [importId]); if (!item) throw errors.notFound('供应商账单导入不存在', 'SUPPLIER_IMPORT_NOT_FOUND'); return { filename: item.file_name || `supplier-billing-${item.id}.csv`, content: item.canonical_csv, fileHash: item.file_hash, lineCount: Number(item.line_count) }; }
export function listSupplierLines({ supplierAccountId = '', status = '', limit = 200, offset = 0 } = {}) { const conditions = []; const params = []; if (supplierAccountId) { conditions.push('supplier_account_id=?'); params.push(supplierAccountId); } if (status) { conditions.push('reconciliation_status=?'); params.push(status); } const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''; return { items: rows(`SELECT * FROM supplier_billing_lines${where} ORDER BY occurred_at DESC,id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]).map(lineView), total: Number(row(`SELECT COUNT(*) n FROM supplier_billing_lines${where}`, params)?.n || 0), limit, offset }; }

function candidateContext(candidate) {
  if (candidate.targetType === 'ATTEMPT') {
    const item = row(`SELECT attempt.*,organization.name organization_name,student.display_name student_name,
        usage.id linked_usage_id,usage.created_at usage_created_at,usage.org_id usage_org_id,usage.user_id usage_user_id,
        usage.model usage_model,usage.modality usage_modality
      FROM compute_attempts attempt
      LEFT JOIN organizations organization ON organization.id=attempt.org_id
      LEFT JOIN users student ON student.id=attempt.user_id
      LEFT JOIN usage_records usage ON usage.id=attempt.internal_usage_record_id
      WHERE attempt.id=?`, [candidate.targetId]);
    return {
      orgId: item.org_id || item.usage_org_id || null, organizationName: item.organization_name || null,
      studentId: item.user_id || item.usage_user_id || null, studentName: item.student_name || null,
      model: item.model || item.usage_model || null, modality: item.modality || item.usage_modality || null,
      provider: item.provider || null, providerAccountRef: item.provider_account_ref || null, channelId: item.channel_id || null, actualChannelId: item.actual_channel_id || null,
      occurredAt: item.created_at || item.usage_created_at || null,
      evidence: { attemptId: item.id, callId: item.call_id || null, attempt: Number(item.attempt), internalUsageRecordId: item.internal_usage_record_id || null, providerUsageId: item.usage_id || null, clientRequestId: item.client_request_id || null, responseRequestId: item.response_request_id || null, responsePayloadId: item.response_payload_id || null, taskId: item.task_id || null, gatewayLogId: item.gateway_log_id || null },
    };
  }
  const item = row(`SELECT usage.*,organization.name organization_name,student.display_name student_name
    FROM usage_records usage LEFT JOIN organizations organization ON organization.id=usage.org_id LEFT JOIN users student ON student.id=usage.user_id WHERE usage.id=?`, [candidate.targetId]);
  return {
    orgId: item.org_id || null, organizationName: item.organization_name || null,
    studentId: item.user_id || null, studentName: item.student_name || null,
    model: item.model || null, modality: item.modality || null, provider: null, channelId: null, actualChannelId: null,
    occurredAt: item.created_at || null,
    evidence: { attemptId: null, callId: item.compute_call_id || null, attempt: null, internalUsageRecordId: item.id, providerUsageId: null, clientRequestId: null, responseRequestId: null, responsePayloadId: null, taskId: null, gatewayLogId: null },
  };
}

export function listSupplierLineCandidates(lineId) {
  const line = row('SELECT * FROM supplier_billing_lines WHERE id=?', [lineId]);
  if (!line) throw errors.notFound('供应商账单行不存在', 'SUPPLIER_LINE_NOT_FOUND');
  const account = accountById(line.supplier_account_id);
  const items = line.line_type === 'USAGE' && !['CANCELLED', 'EXCLUDED'].includes(line.reconciliation_status) ? exactCandidates(line, account).map((candidate) => ({ ...candidate, ...targetCost(candidate.targetType, candidate.targetId), ...candidateContext(candidate) })) : [];
  return { line: lineView(line), items, total: items.length, confirmable: items.length === 1 && !['CANCELLED', 'EXCLUDED'].includes(line.reconciliation_status) };
}

export function manuallyMatchSupplierLine(lineId, allocations, { actorId = null, reason = '' } = {}) {
  if (!String(reason).trim()) throw errors.badRequest('人工匹配必须填写原因', 'SUPPLIER_REASON_REQUIRED');
  const line = row('SELECT * FROM supplier_billing_lines WHERE id=?', [lineId]);
  if (!line) throw errors.notFound('供应商账单行不存在', 'SUPPLIER_LINE_NOT_FOUND');
  if (['CANCELLED', 'EXCLUDED'].includes(line.reconciliation_status)) throw errors.conflict('当前账单行状态不允许匹配', 'SUPPLIER_LINE_STATE_CONFLICT');
  if (!Array.isArray(allocations) || !allocations.length || allocations.length > 100) throw errors.badRequest('allocations 必须包含 1 到 100 条分摊', 'SUPPLIER_MATCH_ALLOCATIONS_INVALID');
  const normalized = allocations.map((item) => ({ targetType: String(item?.targetType || '').toUpperCase(), targetId: required(item?.targetId, 'targetId'), amountMinor: item?.amountMinor, originalMatchId: String(item?.originalMatchId || '').trim() || null }));
  const keys = new Set();
  for (const item of normalized) {
    if (!['USAGE', 'ATTEMPT'].includes(item.targetType)) throw errors.badRequest('targetType 无效', 'SUPPLIER_MATCH_TARGET_INVALID');
    if (!Number.isSafeInteger(item.amountMinor) || item.amountMinor === 0 || Math.sign(item.amountMinor) !== Math.sign(Number(line.amount_minor))) throw errors.badRequest('分摊金额必须是与账单行同符号的非零安全整数', 'SUPPLIER_MATCH_AMOUNT_INVALID');
    const key = `${item.targetType}:${item.targetId}`; if (keys.has(key)) throw errors.badRequest('同一目标不能重复', 'SUPPLIER_MATCH_TARGET_DUPLICATE'); keys.add(key);
  }
  const allocated = normalized.reduce((sum, item) => sum + item.amountMinor, 0);
  if (Math.abs(allocated) > Math.abs(Number(line.amount_minor))) throw errors.conflict('分摊总额超过账单行金额', 'SUPPLIER_MATCH_LINE_AMOUNT_EXCEEDED');
  return transaction(() => {
    const before = lineView(line); const now = nowIso();
    const cancelled = cancelMatchesAndRefunds(activeMatches(line.id).map((match) => match.id), { actorId, reason: 'REPLACED_BY_MANUAL_MATCH', now });
    for (const affectedLineId of cancelled.lineIds) if (affectedLineId !== line.id) refreshLine(affectedLineId);
    q("UPDATE supplier_billing_lines SET reconciliation_status='UNMATCHED',candidate_count=0,state_reason=?,updated_at=? WHERE id=?", [String(reason).slice(0, 1000), now, line.id]);
    for (const allocation of normalized) addMatch({ line, ...allocation, identifierType: 'MANUAL', method: 'MANUAL', actorId });
    refreshLine(line.id); const after = lineView(row('SELECT * FROM supplier_billing_lines WHERE id=?', [line.id]));
    event({ accountId: line.supplier_account_id, importId: line.import_id, lineId: line.id, action: normalized.length > 1 ? 'MANUAL_SPLIT' : 'MANUAL_MATCH_REPLACE', before, after, reason, actorId });
    return after;
  });
}

function cancelMatchesAndRefunds(matchIds, { actorId, reason, now = nowIso() }) {
  const pending = [...new Set(matchIds.filter(Boolean))]; const cancelled = new Set(); const affectedLines = new Set();
  while (pending.length) {
    const batch = pending.splice(0, pending.length).filter((matchId) => !cancelled.has(matchId));
    if (!batch.length) continue;
    const placeholders = batch.map(() => '?').join(',');
    for (const child of rows(`SELECT id FROM supplier_billing_matches WHERE cancelled_at IS NULL AND original_match_id IN (${placeholders})`, batch)) pending.push(child.id);
    for (const match of rows(`SELECT id,line_id FROM supplier_billing_matches WHERE cancelled_at IS NULL AND id IN (${placeholders})`, batch)) {
      q('UPDATE supplier_billing_matches SET cancelled_at=?,cancelled_by=?,cancel_reason=? WHERE id=? AND cancelled_at IS NULL', [now, actorId, String(reason).slice(0, 1000), match.id]);
      cancelled.add(match.id); affectedLines.add(match.line_id);
    }
  }
  return { matchIds: [...cancelled], lineIds: [...affectedLines] };
}

export function cancelSupplierMatch(matchId, { actorId = null, reason = '' } = {}) {
  if (!String(reason).trim()) throw errors.badRequest('取消匹配必须填写原因', 'SUPPLIER_REASON_REQUIRED');
  return transaction(() => {
    const match = row('SELECT match.*,line.supplier_account_id,line.import_id FROM supplier_billing_matches match JOIN supplier_billing_lines line ON line.id=match.line_id WHERE match.id=?', [matchId]);
    if (!match) throw errors.notFound('供应商匹配不存在', 'SUPPLIER_MATCH_NOT_FOUND');
    if (match.cancelled_at) return { id: match.id, cancelled: true, idempotent: true };
    const cancelled = cancelMatchesAndRefunds([match.id], { actorId, reason });
    for (const lineId of cancelled.lineIds) refreshLine(lineId);
    event({ accountId: match.supplier_account_id, importId: match.import_id, lineId: match.line_id, matchId: match.id, action: 'MATCH_CANCEL', after: { cascadedMatchIds: cancelled.matchIds.filter((id) => id !== match.id) }, reason, actorId });
    return { id: match.id, line: lineView(row('SELECT * FROM supplier_billing_lines WHERE id=?', [match.line_id])), cancelled: true, cascadedMatchIds: cancelled.matchIds.filter((id) => id !== match.id), idempotent: false };
  });
}

export function setSupplierLineState(lineId, action, { actorId = null, reason = '' } = {}) {
  const next = { exclude: 'EXCLUDED', dispute: 'DISPUTED', cancel: 'CANCELLED' }[action];
  if (!next) throw errors.badRequest('账单行操作无效', 'SUPPLIER_LINE_ACTION_INVALID');
  if (!String(reason).trim()) throw errors.badRequest('状态操作必须填写原因', 'SUPPLIER_REASON_REQUIRED');
  return transaction(() => {
    const line = row('SELECT * FROM supplier_billing_lines WHERE id=?', [lineId]);
    if (!line) throw errors.notFound('供应商账单行不存在', 'SUPPLIER_LINE_NOT_FOUND');
    if (line.reconciliation_status === next) return { ...lineView(line), idempotent: true };
    if (line.reconciliation_status === 'CANCELLED') throw errors.conflict('已取消账单行不能再次变更', 'SUPPLIER_LINE_STATE_CONFLICT');
    const before = lineView(line); const now = nowIso();
    if (next !== 'DISPUTED') {
      const matchIds = activeMatches(line.id).map((match) => match.id);
      const cancelled = cancelMatchesAndRefunds(matchIds, { actorId, reason: `LINE_${next}`, now });
      for (const affectedLineId of cancelled.lineIds) if (affectedLineId !== line.id) refreshLine(affectedLineId);
    }
    q('UPDATE supplier_billing_lines SET reconciliation_status=?,state_reason=?,updated_at=? WHERE id=?', [next, String(reason).slice(0, 1000), now, line.id]);
    const after = lineView(row('SELECT * FROM supplier_billing_lines WHERE id=?', [line.id]));
    event({ accountId: line.supplier_account_id, importId: line.import_id, lineId: line.id, action: `LINE_${next}`, before, after, reason, actorId });
    return after;
  });
}

export function cancelSupplierImport(importId, { actorId = null, reason = '' } = {}) {
  if (!String(reason).trim()) throw errors.badRequest('取消导入必须填写原因', 'SUPPLIER_REASON_REQUIRED');
  return transaction(() => {
    const item = row('SELECT * FROM supplier_billing_imports WHERE id=?', [importId]);
    if (!item) throw errors.notFound('供应商账单导入不存在', 'SUPPLIER_IMPORT_NOT_FOUND');
    if (item.status === 'CANCELLED') return { ...supplierImport(item), idempotent: true };
    const now = nowIso();
    const matchIds = rows('SELECT match.id FROM supplier_billing_matches match JOIN supplier_billing_lines line ON line.id=match.line_id WHERE line.import_id=? AND match.cancelled_at IS NULL', [item.id]).map((match) => match.id);
    const cancelled = cancelMatchesAndRefunds(matchIds, { actorId, reason: 'IMPORT_CANCELLED', now });
    q("UPDATE supplier_billing_lines SET reconciliation_status='CANCELLED',state_reason=?,updated_at=? WHERE import_id=?", [String(reason).slice(0, 1000), now, item.id]);
    for (const lineId of cancelled.lineIds) if (!row('SELECT 1 FROM supplier_billing_lines WHERE id=? AND import_id=?', [lineId, item.id])) refreshLine(lineId);
    q("UPDATE supplier_billing_imports SET status='CANCELLED',cancelled_by=?,cancelled_at=?,cancel_reason=? WHERE id=?", [actorId, now, String(reason).slice(0, 1000), item.id]);
    event({ accountId: item.supplier_account_id, importId: item.id, action: 'IMPORT_CANCEL', after: { cascadedMatchIds: cancelled.matchIds }, reason, actorId });
    return { ...supplierImport(row('SELECT * FROM supplier_billing_imports WHERE id=?', [item.id])), idempotent: false };
  });
}

export function listSupplierEvents({ supplierAccountId = '', lineId = '', limit = 200 } = {}) {
  const conditions = []; const params = []; if (supplierAccountId) { conditions.push('supplier_account_id=?'); params.push(supplierAccountId); } if (lineId) { conditions.push('line_id=?'); params.push(lineId); } const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return rows(`SELECT * FROM supplier_billing_events${where} ORDER BY created_at DESC,id DESC LIMIT ?`, [...params, limit]).map((item) => ({ id: item.id, supplierAccountId: item.supplier_account_id || null, importId: item.import_id || null, lineId: item.line_id || null, matchId: item.match_id || null, action: item.action, before: parseJson(item.before_data, null), after: parseJson(item.after_data, null), reason: item.reason || '', actorId: item.actor_id || null, createdAt: item.created_at }));
}
