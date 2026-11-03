/**
 * 作品调用模型（2026-11-03）
 *
 * 用户口径：学生作品运行时可以调**平台的 Key**（默认智谱 GLM-4-Flash），学生不用自己填 Key；
 * 学生端 / 客户端 / 老师端 / 作品广场 / 学生主页都要能用。
 *
 * 三条硬边界（改之前先读）：
 *   ① **完全独立于 `ai_provider_policy`**：Agent 的渠道、TEXT 路由、模型下拉一概不动；
 *      这里只读 `platform_settings.works_llm` 与 `providerSecret('works-llm')`。
 *   ② **Key 不下发**：作品文档里只注入短期 grant；Key 只在服务端解密、只用于发上游。
 *   ③ **能停**：`enabled=false` 或配额用尽时一律拒绝，且返回人话（作品里的桥会原样显示）。
 *
 * 调用链：作品里的 LLM 桥（`packages/shared/src/vibecodingProject.js`）→
 *   `POST /api/works-llm/chat`（`routes/workLlm.js`）→ 本文件 `callWorksLlm()` → 上游。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { aq, arow, arows, errors, id, nowIso, parseJson } from '../lib.js';
import { isUniqueViolation } from '@platform/database';
import { clearProviderApiKey, getProviderApiKey, hasProviderApiKey, setProviderApiKey } from './providerSecret.js';

export const WORKS_LLM_KEY_ID = 'works-llm';

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  model: 'glm-4-flash-250414',
  maxTokens: 1024,
  temperature: 0.7,
  timeoutMs: 60000,
  scopes: { classroom: true, preview: true, public: true },
  quotas: { studentDaily: 200, workDaily: 500, ipDaily: 200, globalDaily: 5000, qps: 5 },
});

const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 24000;

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const scopes = source.scopes && typeof source.scopes === 'object' ? source.scopes : {};
  const quotas = source.quotas && typeof source.quotas === 'object' ? source.quotas : {};
  return {
    enabled: source.enabled === true,
    endpoint: String(source.endpoint || DEFAULT_CONFIG.endpoint).trim() || DEFAULT_CONFIG.endpoint,
    model: String(source.model || DEFAULT_CONFIG.model).trim() || DEFAULT_CONFIG.model,
    maxTokens: clampInt(source.maxTokens, 1, 4096, DEFAULT_CONFIG.maxTokens),
    temperature: clampNumber(source.temperature, 0, 2, DEFAULT_CONFIG.temperature),
    timeoutMs: clampInt(source.timeoutMs, 5000, 120000, DEFAULT_CONFIG.timeoutMs),
    scopes: {
      classroom: scopes.classroom !== false,
      preview: scopes.preview !== false,
      public: scopes.public !== false,
    },
    quotas: {
      studentDaily: clampInt(quotas.studentDaily, 0, 1000000, DEFAULT_CONFIG.quotas.studentDaily),
      workDaily: clampInt(quotas.workDaily, 0, 1000000, DEFAULT_CONFIG.quotas.workDaily),
      ipDaily: clampInt(quotas.ipDaily, 0, 1000000, DEFAULT_CONFIG.quotas.ipDaily),
      globalDaily: clampInt(quotas.globalDaily, 0, 1000000, DEFAULT_CONFIG.quotas.globalDaily),
      qps: clampInt(quotas.qps, 1, 200, DEFAULT_CONFIG.quotas.qps),
    },
  };
}

export async function readWorksLlmConfig() {
  try {
    const row = await arow('SELECT works_llm FROM platform_settings WHERE id=1');
    return normalizeConfig(parseJson(row?.works_llm, {}) || {});
  } catch (error) {
    // 迁移 52 还没跑时列不存在：**不能连累 client-context**（它每次轮询都会读这里）。
    // 当成"未启用"返回；后台保存会明确报错，提醒先跑迁移。
    if (isMissingSchema(error)) return normalizeConfig({});
    throw error;
  }
}

/** 后台保存：严格校验，别把明显错的地址/模型存进去（存了也只会在第一次调用时炸）。 */
export async function saveWorksLlmConfig(patch = {}) {
  const before = await readWorksLlmConfig();
  const source = patch && typeof patch === 'object' ? patch : {};
  const next = normalizeConfig({
    ...before,
    ...source,
    scopes: { ...before.scopes, ...(source.scopes || {}) },
    quotas: { ...before.quotas, ...(source.quotas || {}) },
  });
  if (!/^https?:\/\//i.test(next.endpoint)) throw errors.badRequest('调用地址必须是 http(s) 完整地址', 'WORK_LLM_ENDPOINT_INVALID');
  if (next.endpoint.length > 500) throw errors.badRequest('调用地址不能超过 500 个字符', 'WORK_LLM_ENDPOINT_TOO_LONG');
  if (!next.model) throw errors.badRequest('模型 ID 不能为空', 'WORK_LLM_MODEL_REQUIRED');
  if (next.model.length > 200) throw errors.badRequest('模型 ID 不能超过 200 个字符', 'WORK_LLM_MODEL_TOO_LONG');
  try {
    await aq('UPDATE platform_settings SET works_llm=?, updated_at=? WHERE id=1', [JSON.stringify(next), nowIso()]);
  } catch (error) {
    if (isMissingSchema(error)) throw errors.conflict('数据库还没有执行迁移 52（works_llm 列不存在），请先跑迁移再保存', 'WORK_LLM_SCHEMA_MISSING');
    throw error;
  }
  return next;
}

export function saveWorksLlmKey(value) {
  const text = String(value || '').trim();
  if (!text) throw errors.badRequest('请填写作品模型的 API Key', 'WORK_LLM_KEY_REQUIRED');
  if (text.length > 4000) throw errors.badRequest('API Key 过长', 'WORK_LLM_KEY_TOO_LONG');
  setProviderApiKey(text, WORKS_LLM_KEY_ID);
}

export function clearWorksLlmKey() {
  return clearProviderApiKey(WORKS_LLM_KEY_ID);
}

export function worksLlmReady() {
  return hasProviderApiKey(WORKS_LLM_KEY_ID);
}

export async function worksLlmAdminView() {
  const config = await readWorksLlmConfig();
  const keyConfigured = worksLlmReady();
  const day = todayKey();
  let totals = null;
  let rows = [];
  try {
    totals = await arow(
      `SELECT COALESCE(SUM(calls),0) calls, COALESCE(SUM(input_tokens),0) inputTokens,
              COALESCE(SUM(output_tokens),0) outputTokens
         FROM work_llm_usage WHERE day=?`,
      [day],
    );
    rows = await arows(
      `SELECT scope, subject_id, calls, input_tokens, output_tokens, updated_at
         FROM work_llm_usage WHERE day=? ORDER BY calls DESC LIMIT 50`,
      [day],
    );
  } catch (error) {
    // 迁移 52 还没跑：后台页面要能打开（显示 0），而不是整页 500。
    if (!isMissingSchema(error)) throw error;
  }
  return {
    config,
    keyConfigured,
    ready: config.enabled && keyConfigured,
    usage: {
      day,
      calls: Number(totals?.calls || 0),
      inputTokens: Number(totals?.inputTokens || 0),
      outputTokens: Number(totals?.outputTokens || 0),
      rows: rows.map((item) => ({
        scope: item.scope,
        subjectId: item.subject_id,
        calls: Number(item.calls || 0),
        inputTokens: Number(item.input_tokens || 0),
        outputTokens: Number(item.output_tokens || 0),
        updatedAt: item.updated_at,
      })),
    },
  };
}

// ── grant：作品文档里只拿得到这个，拿不到 Key ────────────────────────────────
// scope:
//   classroom —— 课堂内的实时预览；内含 studentId + classroomId，服务端每次调用都重验「课堂还在、学生还在名单」。
//   preview   —— 老师端 / 平台端作品预览；内含 workId + userId，签发方已经验过权限。
//   public    —— 广场 / 学生主页 / 分享页；内含 workId，签发方已经验过公开/主页口径。

function grantSecret() {
  return String(process.env.WORK_LLM_GRANT_SECRET || process.env.RUNTIME_GATEWAY_SECRET || process.env.AUTH_PEPPER || 'p0-local-pepper');
}

function grantSignature(body) {
  return createHmac('sha256', grantSecret()).update(`works-llm:${body}`).digest('base64url');
}

export function issueWorksLlmGrant({ scope, subject, userId = '', workId = '', classroomId = '', ttlMs = 2 * 60 * 60 * 1000 } = {}) {
  const payload = {
    v: 1,
    scope: String(scope || ''),
    subject: String(subject || ''),
    uid: String(userId || ''),
    work: String(workId || ''),
    room: String(classroomId || ''),
    exp: Date.now() + Math.max(60 * 1000, Math.min(7 * 24 * 60 * 60 * 1000, Number(ttlMs) || 0)),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${grantSignature(body)}`;
}

export function verifyWorksLlmGrant(grant) {
  try {
    const [body, signature] = String(grant || '').split('.');
    if (!body || !signature) return null;
    const expected = grantSignature(body);
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || payload.v !== 1) return null;
    if (!['classroom', 'preview', 'public'].includes(payload.scope)) return null;
    if (!payload.exp || Number(payload.exp) <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * 课时开关：`course_lessons.classroom_config.vibeCoding.worksLlm === true`。
 *
 * 用户口径（2026-11-03）：「这节课需要用到 Key，就用我们封装好的」。
 * 只有勾了的课时，才给它的作品发平台模型授权；没勾的课时保持「学生自己填 Key」的老行为。
 * 这是**课时级**的附加门禁：全局总开关 / Key / scope 仍然要先满足。
 */
async function lessonWorksLlmEnabled(lessonId) {
  if (!lessonId) return false;
  const row = await arow('SELECT classroom_config FROM course_lessons WHERE id=?', [lessonId]);
  const config = parseJson(row?.classroom_config, {}) || {};
  return config?.vibeCoding?.worksLlm === true;
}

/** 课堂内实时预览：grant 给到整节课（12h），每次调用仍会重验课堂是否还在进行。 */
export async function classroomWorksLlmGrant({ classroomId, studentId, lessonId } = {}) {
  if (!classroomId || !studentId || !(await lessonWorksLlmEnabled(lessonId))) return null;
  const config = await readWorksLlmConfig();
  if (!config.enabled || !config.scopes.classroom || !worksLlmReady()) return null;
  return { grant: issueWorksLlmGrant({ scope: 'classroom', subject: studentId, userId: studentId, classroomId, ttlMs: 12 * 60 * 60 * 1000 }) };
}

/** 老师端 / 平台端 / 学生端作品预览。 */
export async function previewWorksLlmGrant({ workId, userId } = {}) {
  if (!workId) return null;
  const work = await arow('SELECT lesson_id FROM vibecoding_submissions WHERE id=?', [workId]);
  if (!work || !(await lessonWorksLlmEnabled(work.lesson_id))) return null;
  const config = await readWorksLlmConfig();
  if (!config.enabled || !config.scopes.preview || !worksLlmReady()) return null;
  return { grant: issueWorksLlmGrant({ scope: 'preview', subject: workId, userId, workId, ttlMs: 2 * 60 * 60 * 1000 }) };
}

/** 作品广场 / 学生主页 / 分享页（公开页）。 */
export async function publicWorksLlmGrant({ workId } = {}) {
  if (!workId) return null;
  const work = await arow('SELECT lesson_id FROM vibecoding_submissions WHERE id=?', [workId]);
  if (!work || !(await lessonWorksLlmEnabled(work.lesson_id))) return null;
  const config = await readWorksLlmConfig();
  if (!config.enabled || !config.scopes.public || !worksLlmReady()) return null;
  return { grant: issueWorksLlmGrant({ scope: 'public', subject: workId, workId, ttlMs: 24 * 60 * 60 * 1000 }) };
}

// ── 配额 ────────────────────────────────────────────────────────────────────
// 计数表按 (day, scope, subject_id) 一行；public 会写两行（work:<id> 与 ip:<ip>）。
// qps 用进程内滑窗：单进程部署足够；重启清零可接受（真正的滥用由日配额兜底）。
const qpsBuckets = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/** 迁移 52 还没跑完时的兜底：不能因为少一张表就把预览/作品调用打 500。 */
function isMissingSchema(error) {
  return /unknown column|no such column|no such table|doesn't exist|unknown table/i.test(String(error?.message || ''));
}

function quotaReached(limit, used) {
  return Number(limit) <= 0 || used >= Number(limit);
}

async function usageOf(day, scope, subjectId) {
  try {
    const row = await arow('SELECT calls FROM work_llm_usage WHERE day=? AND scope=? AND subject_id=?', [day, scope, subjectId]);
    return Number(row?.calls || 0);
  } catch (error) {
    if (isMissingSchema(error)) return 0;
    throw error;
  }
}

async function globalUsageOf(day) {
  try {
    const row = await arow('SELECT COALESCE(SUM(calls),0) n FROM work_llm_usage WHERE day=?', [day]);
    return Number(row?.n || 0);
  } catch (error) {
    if (isMissingSchema(error)) return 0;
    throw error;
  }
}

function qpsAllowed(key, limit) {
  const now = Date.now();
  const bucket = (qpsBuckets.get(key) || []).filter((stamp) => now - stamp < 1000);
  if (bucket.length >= limit) {
    qpsBuckets.set(key, bucket);
    return false;
  }
  bucket.push(now);
  qpsBuckets.set(key, bucket);
  if (qpsBuckets.size > 5000) {
    for (const [entry, stamps] of qpsBuckets) {
      if (!stamps.length || now - stamps[stamps.length - 1] > 60000) qpsBuckets.delete(entry);
    }
  }
  return true;
}

export async function checkWorksLlmQuota({ scope, subjectId, ip = '' } = {}) {
  const config = await readWorksLlmConfig();
  if (!config.enabled) return { ok: false, code: 'WORK_LLM_DISABLED', message: '作品模型未开启（平台后台可打开）' };
  if (!worksLlmReady()) return { ok: false, code: 'WORK_LLM_KEY_MISSING', message: '作品模型还没有配置 API Key（平台后台可配置）' };
  if (!config.scopes[scope]) return { ok: false, code: 'WORK_LLM_SCOPE_DISABLED', message: '这个入口没有开启作品模型' };

  const day = todayKey();
  if (quotaReached(config.quotas.globalDaily, await globalUsageOf(day))) {
    return { ok: false, code: 'WORK_LLM_QUOTA_EXCEEDED', message: '今天的作品模型总调用额度已用完，请明天再试' };
  }
  if (scope === 'classroom') {
    if (quotaReached(config.quotas.studentDaily, await usageOf(day, 'classroom', subjectId))) {
      return { ok: false, code: 'WORK_LLM_QUOTA_EXCEEDED', message: '你今天用作品模型次数已达上限，请明天再试' };
    }
  } else if (scope === 'preview') {
    if (quotaReached(config.quotas.workDaily, await usageOf(day, 'preview', subjectId))) {
      return { ok: false, code: 'WORK_LLM_QUOTA_EXCEEDED', message: '这件作品今天的模型调用次数已达上限' };
    }
  } else if (scope === 'public') {
    if (quotaReached(config.quotas.workDaily, await usageOf(day, 'public', `work:${subjectId}`))) {
      return { ok: false, code: 'WORK_LLM_QUOTA_EXCEEDED', message: '这件作品今天的模型调用次数已达上限' };
    }
    if (ip && quotaReached(config.quotas.ipDaily, await usageOf(day, 'public', `ip:${ip}`))) {
      return { ok: false, code: 'WORK_LLM_QUOTA_EXCEEDED', message: '你这个网络今天调用太多次了，请明天再试' };
    }
  } else {
    return { ok: false, code: 'WORK_LLM_SCOPE_INVALID', message: '作品模型授权范围无效' };
  }
  if (!qpsAllowed(`${scope}:${subjectId}:${ip}`, config.quotas.qps)) {
    return { ok: false, code: 'WORK_LLM_RATE_LIMITED', message: '调用太频繁了，请稍等一两秒再试' };
  }
  return { ok: true, config };
}

async function bumpUsage(day, scope, subjectId, inputTokens, outputTokens) {
  const now = nowIso();
  const updated = await aq(
    `UPDATE work_llm_usage SET calls=calls+1,input_tokens=input_tokens+?,output_tokens=output_tokens+?,updated_at=?
      WHERE day=? AND scope=? AND subject_id=?`,
    [inputTokens, outputTokens, now, day, scope, subjectId],
  );
  if (Number(updated?.changes || 0) > 0) return;
  try {
    await aq(
      `INSERT INTO work_llm_usage(id,day,scope,subject_id,calls,input_tokens,output_tokens,created_at,updated_at)
       VALUES (?,?,?,?,1,?,?,?,?)`,
      [id('wlu'), day, scope, subjectId, inputTokens, outputTokens, now, now],
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await aq(
      `UPDATE work_llm_usage SET calls=calls+1,input_tokens=input_tokens+?,output_tokens=output_tokens+?,updated_at=?
        WHERE day=? AND scope=? AND subject_id=?`,
      [inputTokens, outputTokens, now, day, scope, subjectId],
    );
  }
}

export async function recordWorksLlmUsage({ scope, subjectId, ip = '', usage = null } = {}) {
  try {
    const day = todayKey();
    const inputTokens = Math.max(0, Number(usage?.prompt_tokens || usage?.input_tokens || 0));
    const outputTokens = Math.max(0, Number(usage?.completion_tokens || usage?.output_tokens || 0));
    await bumpUsage(day, scope, subjectId, inputTokens, outputTokens);
    if (scope === 'public' && ip) await bumpUsage(day, 'public', `ip:${ip}`, 0, 0);
  } catch (error) {
    // 迁移没跑完：这次调用已经成功了，不能因为计数失败把作品打成 red。
    if (!isMissingSchema(error)) throw error;
  }
}

// ── 上游调用 ────────────────────────────────────────────────────────────────
function normalizeMessages(input) {
  if (!Array.isArray(input) || !input.length) throw errors.badRequest('请提供 messages', 'WORK_LLM_MESSAGES_INVALID');
  if (input.length > MAX_MESSAGES) throw errors.badRequest(`一次最多 ${MAX_MESSAGES} 条消息`, 'WORK_LLM_MESSAGES_TOO_MANY');
  let chars = 0;
  const messages = input.map((item) => {
    const role = String(item?.role || '').trim().toLowerCase();
    if (!['system', 'user', 'assistant'].includes(role)) throw errors.badRequest('消息角色只能是 system/user/assistant', 'WORK_LLM_MESSAGES_INVALID');
    if (typeof item?.content !== 'string') throw errors.badRequest('消息内容必须是文本', 'WORK_LLM_MESSAGES_INVALID');
    chars += item.content.length;
    return { role, content: item.content };
  });
  if (chars > MAX_MESSAGE_CHARS) throw errors.badRequest('对话内容太长，请删减后再试', 'WORK_LLM_MESSAGES_TOO_LONG');
  return messages;
}

function upstreamContent(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? payload?.data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : String(part?.text || ''))).join('').trim();
  }
  return '';
}

export async function callWorksLlm({ messages, temperature, json = false } = {}) {
  const config = await readWorksLlmConfig();
  const normalized = normalizeMessages(messages);
  const apiKey = getProviderApiKey(WORKS_LLM_KEY_ID);
  if (!apiKey) return { ok: false, code: 'WORK_LLM_KEY_MISSING', error: '作品模型还没有配置 API Key' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();
  try {
    const requestBody = {
      model: config.model,
      messages: normalized,
      temperature: Number.isFinite(Number(temperature)) ? clampNumber(temperature, 0, 2, config.temperature) : config.temperature,
      max_tokens: config.maxTokens,
      stream: false,
    };
    if (json) requestBody.response_format = { type: 'json_object' };
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok) {
      const status = response.status;
      const upstream = String(payload?.message || payload?.error?.message || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (status === 401 || status === 403) {
        return { ok: false, code: 'WORK_LLM_AUTH_FAILED', status, error: '作品模型的 Key 无效或没有权限，请管理员检查后台配置' };
      }
      if (status === 429) {
        return { ok: false, code: 'WORK_LLM_RATE_LIMITED', status, error: '作品模型调用太频繁，请稍等再试' };
      }
      return { ok: false, code: 'WORK_LLM_UPSTREAM', status, error: `作品模型暂时不可用（上游 ${status}）${upstream ? `：${upstream}` : ''}`.slice(0, 300) };
    }
    const content = upstreamContent(payload);
    if (!content) return { ok: false, code: 'WORK_LLM_RESPONSE_INVALID', error: '作品模型返回了空内容，请换个说法再试' };
    return { ok: true, content, model: config.model, usage: payload?.usage || null };
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, code: 'WORK_LLM_TIMEOUT', error: '作品模型响应超时，请稍后再试' };
    return { ok: false, code: 'WORK_LLM_NETWORK', error: `作品模型连接失败：${String(error?.message || error).slice(0, 160)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 后台「试一次」：用同一套配置与 Key 发一句最小请求。不写用量（它不是学生调用）。 */
export async function testWorksLlm() {
  const config = await readWorksLlmConfig();
  if (!worksLlmReady()) return { ok: false, error: '还没有配置 API Key' };
  const started = Date.now();
  const result = await callWorksLlm({ messages: [{ role: 'user', content: '你好，请只回复“连接成功”。' }], temperature: 0 });
  return result.ok
    ? { ok: true, content: result.content, model: result.model, latencyMs: Date.now() - started }
    : { ok: false, error: result.error, code: result.code };
}
