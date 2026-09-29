#!/usr/bin/env node
/**
 * 取一个「**缓存命中 > 0** 的真实样本」—— 客户端（ZCode）契约第二版 待办 6 里点名要的那个，
 * 用来对 P0-1 的账（账单里的缓存 token 与上游实际返回的是否一致）。
 *
 * 做法（两步，都是**真请求**）：
 *   ① 登录联调学生 → `client-context` 拿课堂与运行时密钥（`gateway.baseUrl` + `gateway.key`）；
 *   ② 用**同一段长前缀**（下面那段可重复的说明，约 2000+ token）连打两次 `/chat/completions`：
 *      第一次通常是 miss（写缓存），第二次应当命中（`prompt_cache_hit_tokens > 0`）。
 *      两次都把 usage 原样打印，并做一条判定。
 *
 * ⚠️ 缓存是**上游渠道**的能力：渠道不支持（或没配）时两次都会是 0 —— 这时脚本会明说"这个渠道没有缓存
 *    能力"，而不是假装成功。要拿下限是"真样本"的账，得用支持 prompt caching 的渠道（如 DeepSeek 系）。
 * ⚠️ 只打**两次**、短请求，花费可以忽略；不发起任何生成类调用。
 *
 * 用法（服务器上跑；也可以在本机对临时实例跑）：
 *   PLATFORM_URL=http://127.0.0.1:8789 \
 *   FIXTURE_STUDENT_LOGIN=zcode-it FIXTURE_STUDENT_PASSWORD='<联调那个学生的密码>' \
 *     node deploy/production/probe-cache-hit-sample.mjs
 * 也可以只给运行时密钥（跳过登录）：RUNTIME_KEY=rt1.xxx GATEWAY_BASE=https://aicyld.com/api/gateway/v1 \
 *     node deploy/production/probe-cache-hit-sample.mjs
 */
const BASE = String(process.env.PLATFORM_URL || 'http://127.0.0.1:8789').replace(/\/+$/, '');
const LOGIN = process.env.FIXTURE_STUDENT_LOGIN || process.env.STUDENT_LOGIN || '';
const PASSWORD = process.env.FIXTURE_STUDENT_PASSWORD || process.env.STUDENT_PASSWORD || '';
const MODEL = process.env.PROBE_MODEL || '';

async function api(pathname, { method = 'GET', token, body, base = BASE } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
}

// ── ① 拿密钥：能直接给就跳过登录 ──────────────────────────────────────────────
let gatewayBase = String(process.env.GATEWAY_BASE || '').trim();
let runtimeKey = String(process.env.RUNTIME_KEY || '').trim();
let model = MODEL;
if (!runtimeKey) {
  if (!LOGIN || !PASSWORD) {
    console.error('缺少凭据：给 FIXTURE_STUDENT_LOGIN / FIXTURE_STUDENT_PASSWORD（联调学生），或直接给 RUNTIME_KEY + GATEWAY_BASE。');
    process.exit(2);
  }
  const login = await api('/api/auth/login', { method: 'POST', body: { login: LOGIN, password: PASSWORD } });
  if (!login.data?.token) { console.error(`登录失败：${JSON.stringify(login.raw).slice(0, 240)}`); process.exit(2); }
  const context = (await api('/api/student/runtime/client-context', { token: login.data.token })).data || {};
  const contextBase = String(context.gateway?.baseUrl || '');
  // ⚠️ 生产上 `client-context` 下发的基址指向**公网域名**（这是对的，客户端就是这么用的）；
  //    在本机对临时实例自测时，用 `GATEWAY_BASE=` 覆盖即可（别去改生产下发的值）。
  gatewayBase = String(process.env.GATEWAY_BASE || '').trim() || contextBase;
  runtimeKey = context.gateway?.key || '';
  model = model || context.defaultModel || '';
  console.log(`[登录] ${LOGIN} · 课堂=${context.classroom?.id || '(无)'} · 模型=${model || '(无)'}`);
  console.log(`[网关] ${gatewayBase}${gatewayBase !== contextBase ? `（本机覆盖，平台下发的是 ${contextBase}）` : ''}`);
  if (!context.classroom) { console.error('这个学生当前没有进行中的 VibeCoding 课堂 —— 先在机构端开始上课（或跑联调环境播种脚本）。'); process.exit(2); }
}
if (!gatewayBase || !runtimeKey) { console.error('没拿到 gateway.baseUrl / key。'); process.exit(2); }

/** 一段**可重复的长前缀**：缓存命中要求前缀稳定且够长（各家的最小缓存块不同，这里远大于阈值）。 */
const longPrefix = Array.from({ length: 40 }, (_, index) =>
  `第 ${index + 1} 条工作区说明：本课堂用 VibeCoding 做小工具，代码放在 index.html，样式内联，不要引外部 CDN；`
  + `提交作品前要自己点一次运行确认没有报错；遇到错误先读一遍控制台信息再改。`).join('\n');

const callOnce = async (label) => {
  const startedAt = Date.now();
  const response = await fetch(`${gatewayBase.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${runtimeKey}` },
    body: JSON.stringify({
      model,
      stream: false,
      stream_options: { include_usage: true },
      temperature: 0,
      max_tokens: 16,
      messages: [
        { role: 'system', content: longPrefix },
        { role: 'user', content: `只回四个字：准备就绪（这是第 ${label} 次）。` },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  const usage = payload?.usage || {};
  console.log(`\n[第 ${label} 次] HTTP ${response.status} · ${Date.now() - startedAt}ms`);
  console.log(`  usage: ${JSON.stringify(usage)}`);
  return { status: response.status, usage, error: payload?.error || null };
};

const first = await callOnce('一');
if (first.status !== 200) { console.error(`\n第一次就失败了：${JSON.stringify(first.error || {}).slice(0, 300)}`); process.exit(1); }
const second = await callOnce('二');

const hitOf = (result) => Number(
  result.usage?.prompt_cache_hit_tokens
  ?? result.usage?.prompt_tokens_details?.cached_tokens
  ?? 0,
);
const missOf = (result) => Number(result.usage?.prompt_cache_miss_tokens ?? 0);
console.log('\n──────── 判定 ────────');
console.log(`  第一次：hit=${hitOf(first)} miss=${missOf(first)} prompt=${first.usage?.prompt_tokens ?? '—'}`);
console.log(`  第二次：hit=${hitOf(second)} miss=${missOf(second)} prompt=${second.usage?.prompt_tokens ?? '—'}`);
if (hitOf(second) > 0) {
  console.log('  ✓ 第二次命中缓存了 —— 这一对就是可对账的「缓存命中 > 0」样本（两行的 usage 都在上面）。');
} else if (hitOf(first) > 0) {
  console.log('  ⚠️ 第一次就命中（说明这段前缀在缓存里已经热了）—— 同样可用作样本。');
} else {
  console.log('  ✗ 两次都没命中：要么这个渠道不支持 prompt caching，要么前缀还不够长/被上游做了别的前缀。');
  console.log('    这条不是平台侧的问题（平台只是把上游的 usage 原样透传），换一个支持缓存的渠道再试。');
}
