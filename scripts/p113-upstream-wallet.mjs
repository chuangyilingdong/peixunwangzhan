/**
 * P113 上游账户余额（实时）—— **平台内部专用**的只读探针。
 *
 * 用户口径（2026-09-18）：「学生消耗了，能显示给我们实时实际的价格消耗吗？有接口吗」+「加一下，只有平台内部可以看」。
 * 答案分两半，本守卫只钉后半：
 *   · 逐笔实扣（每个学生每节课真花了多少钱）**已经在收**（上游异步终态里的 `usage:{amount}` →
 *     `compute_attempts.upstream_cost_fen`），平台端「调用账」可看 —— 不属于本次改动，这里不管。
 *   · 上游**账户余额**（我们这把 key 在供应商那边还剩多少）由 `GET /api/admin/billing-config/upstream-wallet` 补上。
 *
 * 上游用一个本地假服务顶替（真上游要花钱、也不该在守卫里跑），于是「我们发了什么、回了什么、
 * 前端能看见什么」都能被逐字断言。五条硬要求，一条一个 `check`：
 *
 *   ① 平台超管调用 200，且 `amount` / `used_amount` / `display_type` 等字段**解析正确**；
 *   ② 响应里**不出现那把 key 的任何片段** —— 包括上游把 key 回显在错误文案 / username 字段里的两种情况
 *      （擦洗在服务端做，见 `scrubUpstreamSecret`），且**上游那一跳确实收到了真 key**（否则②会退化成
 *      「因为压根没探」而通过）；
 *   ③ **机构管理员 / 教师 / 学生**一律被拒（403）；
 *   ④ 上游 500 或**超时**时：端点仍然 200，只有该渠道 `ok:false` + 一句人能看懂的 error（不把整页打挂）；
 *   ⑤ 没配 key 的渠道被**跳过**：照列在 `channels` 里但标 `skipped:true` + `reason:'NO_API_KEY'`，
 *      **且一个请求都不发**（用「上游收到的每一发请求都带着已知的 key」来钉「没发出无 key 的请求」）。
 *
 * 另外钉住「endpoint → base」的推导规则（后端 `upstreamWalletBase`，纯函数，不硬编码域名）：
 * 渠道里存的是**生成接口**地址（`…/v1`），账户接口路径却挂在**站点根**（`/api/usage/wallet/`），
 * 所以必须推导。除 `/v1` 结尾外，本守卫专门断言**不带版本段的 endpoint**（`http://host:port`）与
 * **带路径前缀的**（`http://host:port/openai/v1` → `http://host:port/openai`）两种也推得对，
 * 后者还端到端跑通（假上游在 `/openai/api/usage/wallet/` 上也应答）。
 *
 * 多渠道是**并发**探（每渠道各自 9 秒超时）：串行 30 条渠道最坏 4 分半，页面会以为卡死。
 * 下面 ④ 的「挂住不答」那条顺便钉住这点 —— 三个渠道同时探，总耗时只比单条超时多一点。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p113-upstream-wallet-'));
const dbPath = path.join(temp, 'platform.db');
const secretFile = path.join(temp, 'secrets.json');

// 渠道里存的三把 key（都带 `sk-` 形状：擦洗规则认这个形状，也顺便钉住这个形状被擦）
const MAIN_ID = 'p113-main'; const MAIN_KEY = 'sk-p113-main-key-2f8c41';
const PLAIN_ID = 'p113-plain'; const PLAIN_KEY = 'sk-p113-plain-key-9b73d0';
const PREFIX_ID = 'p113-prefix'; const PREFIX_KEY = 'sk-p113-prefix-key-51ae66';
const FAIL_ID = 'p113-fail'; const FAIL_KEY = 'sk-p113-fail-key-77c2b1';
const HANG_ID = 'p113-hang'; const HANG_KEY = 'sk-p113-hang-key-0d4e93';
const NOKEY_ID = 'p113-nokey';
const ALL_KEYS = [MAIN_KEY, PLAIN_KEY, PREFIX_KEY, FAIL_KEY, HANG_KEY];

// ⚠️ `services/providerSecret.js` 的密钥文件路径是**模块加载时**读的（`const file = process.env…`），
// 而静态 import 会被提升到所有语句之前 —— 所以平台源码只能动态 import（与 p106 同一个坑）。
process.env.AI_PROVIDER_SECRET_FILE = secretFile;
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;
process.env.DEPLOYMENT_MODE = 'development';
// ⚠️ 这里**不设** AI_PROVIDER_API_KEY：它是 key 回退链（渠道 key → default → 全局 env）的最后一环，
// 设了的话「没配 key 的渠道」就会拿到这把全局 key 而不被跳过（⑤ 就测不成了）。
delete process.env.AI_PROVIDER_API_KEY;
// baseEnv 同理（只传给被拉起的服务进程）。
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: secretFile, DEPLOYMENT_MODE: 'development' };
delete baseEnv.AI_PROVIDER_API_KEY;

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

/* ── 假上游 A：**正常应答**的钱包。收到的每一发请求都记下来（含 Authorization），供逐字断言 ── */
const seen = [];
// 文档里的响应形状（https://api.seedance.nz/docs/）：{code,message,data:{object,…,display_type}}
const walletBody = (over = {}) => ({
  code: true, message: 'ok',
  data: {
    object: 'wallet_balance', quota: 1500000, used_quota: 250000, total_available: 1500000,
    amount: 3.0, used_amount: 0.5, display_type: 'CNY', username: 'demo', group: 'default', ...over,
  },
});
const okServer = http.createServer((req, res) => {
  const auth = req.headers.authorization || '';
  const key = auth.replace('Bearer ', '');
  const record = { url: req.url, auth };
  seen.push(record);
  const answer = req.url === '/api/usage/wallet/'
    // 按「收到的哪把 key」分两种应答，正好钉住两个口径：
    //  · 主渠道（MAIN_KEY）：文档里的完整响应（CNY + 全部字段）
    //  · 不带版本段的渠道（PLAIN_KEY）：**只给了 amount / used_amount / display_type**（TOKENS），
    //    quota / username 这些上游没给 → 我们这边必须是 null（前端据此不显示，绝不打印 "null"）
    ? (key === PLAIN_KEY
      ? { status: 200, body: { code: true, message: 'ok', data: { object: 'wallet_balance', amount: 1250000, used_amount: 3000, display_type: 'TOKENS' } } }
      : { status: 200, body: walletBody() })
    // 带路径前缀的渠道（endpoint=…/openai/v1）：账户接口就落在 /openai/api/usage/wallet/。
    // 这里**故意把收到的 key 回显在 username 里** —— 连「上游把 key 塞进账号字段」也不许漏到前端。
    : req.url === '/openai/api/usage/wallet/'
      ? { status: 200, body: walletBody({ display_type: 'USD', amount: 42.5, used_amount: 7.25, quota: 999, used_quota: 111, total_available: 888, username: `echo:${key}`, group: 'vip' }) }
      : { status: 404, body: { code: false, message: 'no such route' } };
  res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(answer.body));
});
await new Promise((resolve) => okServer.listen(0, '127.0.0.1', resolve));
const okPort = okServer.address().port;

/* ── 假上游 B：**永远 500**，且错误文案里**回显收到的 key**（上游确实会这么干） ── */
const failServer = http.createServer((req, res) => {
  const key = String(req.headers.authorization || '').replace('Bearer ', '');
  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code: false, message: `internal error, your key ${key} was rejected by upstream` }));
});
await new Promise((resolve) => failServer.listen(0, '127.0.0.1', resolve));
const failPort = failServer.address().port;

/* ── 假上游 C：**挂住不答**（故意不回、也不关连接）→ 钉「超时变成该渠道的 error，而不是整页 500」 ── */
const hangServer = http.createServer(() => { /* 故意什么都不做：等客户端自己超时 */ });
await new Promise((resolve) => hangServer.listen(0, '127.0.0.1', resolve));
const hangPort = hangServer.address().port;

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 19115;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let payload = null; try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: r.status, text, data: payload?.data ?? payload, error: payload?.error || null };
}

const WALLET = '/api/admin/billing-config/upstream-wallet';
const channelOf = (result, id) => (result.data?.channels || []).find((item) => item.channelId === id);

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const login = async (name, password) => (await api('/api/auth/login', { method: 'POST', body: { login: name, password } })).data?.token;
  const admin = await login('root', 'admin123');
  const orgAdmin = await login('org-admin', 'org123');
  const teacher = await login('teacher-1', 'teach123');
  const student = await login('student-2', 'study123');
  assert.ok(admin && orgAdmin && teacher && student, '登录失败');

  /* 建渠道：真实写路径 PUT admin/billing-config/ai-provider（key 也走它存进密钥文件），
     六条渠道各代表一种形态：
       main   endpoint 带 /v1（常态）        → base 应为站点根
       plain  **不带任何版本段**（本题专门要求）→ base 就是它本身
       prefix 带路径前缀 + /v1（/openai/v1）  → base 应保留前缀（/openai）
       fail   指向「永远 500 并回显 key」的上游
       hang   指向「挂住不答」的上游（超时）
       nokey  配了 endpoint 但**不配 key**（⑤ 要求跳过） */
  const channel = (id, name, endpoint, apiKey) => ({
    id, name, provider: 'custom', model: 'p113-model', models: ['p113-model'], endpoint,
    ...(apiKey ? { apiKey } : {}),
  });
  const saved = await api('/api/admin/billing-config/ai-provider', {
    method: 'PUT', token: admin,
    body: {
      provider: 'custom', displayName: 'P113 上游', model: 'p113-model', endpoint: `http://127.0.0.1:${okPort}/v1`,
      allowStudentExternalContent: true, reason: 'P113 上游余额守卫',
      channels: [
        channel(MAIN_ID, '主渠道（/v1）', `http://127.0.0.1:${okPort}/v1`, MAIN_KEY),
        channel(PLAIN_ID, '不带版本段', `http://127.0.0.1:${okPort}`, PLAIN_KEY),
        channel(PREFIX_ID, '带路径前缀', `http://127.0.0.1:${okPort}/openai/v1`, PREFIX_KEY),
        channel(FAIL_ID, '上游 500', `http://127.0.0.1:${failPort}/v1`, FAIL_KEY),
        channel(HANG_ID, '上游挂住', `http://127.0.0.1:${hangPort}/v1`, HANG_KEY),
        channel(NOKEY_ID, '没配 key', `http://127.0.0.1:${okPort}/v1`),
      ],
      modalityChannels: { TEXT: MAIN_ID },
    },
  });
  assert.equal(saved.status, 200, `渠道配置没存上：${saved.status} ${saved.text.slice(0, 300)}`);

  /* ① 平台超管：200 + 字段解析正确 */
  seen.length = 0;
  const probeFailed = await api(WALLET, { token: orgAdmin });
  const probe = await api(WALLET, { token: admin });
  check('① 平台超管 → 200', probe.status === 200, `${probe.status} ${probe.text.slice(0, 200)}`);
  const main = channelOf(probe, MAIN_ID);
  check('① 带 /v1 的渠道：base 推到站点根（去掉 /v1），字段逐个解出来',
    main?.ok === true && main.endpointBase === `http://127.0.0.1:${okPort}`
    && main.displayType === 'CNY' && main.currencyLike === 'CNY' && main.amount === 3
    && main.usedAmount === 0.5 && main.quota === 1500000 && main.usedQuota === 250000 && main.totalAvailable === 1500000
    && main.username === 'demo' && main.group === 'default',
    JSON.stringify(main));
  check('① 响应带 fetchedAt / scope=PLATFORM_INTERNAL（机构端学生端看不到的那条口径）',
    typeof probe.data?.fetchedAt === 'string' && probe.data?.scope === 'PLATFORM_INTERNAL', JSON.stringify({ at: probe.data?.fetchedAt, scope: probe.data?.scope }));
  const plain = channelOf(probe, PLAIN_ID);
  check('① **非 /v1 结尾**的 endpoint（http://host:port）也推对：base 就是它本身',
    plain?.ok === true && plain.endpointBase === `http://127.0.0.1:${okPort}`, JSON.stringify(plain));
  check('① TOKENS 类账号照 display_type 原样带出（amount=1250000 是 token 数，不是钱）',
    plain?.displayType === 'TOKENS' && plain?.currencyLike === null && plain?.amount === 1250000 && plain?.usedAmount === 3000,
    JSON.stringify(plain));
  check('① 上游没给的字段一律 null（前端不显示，不会打出 "null"）',
    plain?.quota === null && plain?.usedQuota === null && plain?.totalAvailable === null && plain?.username === null && plain?.group === null,
    JSON.stringify(plain));
  const prefix = channelOf(probe, PREFIX_ID);
  check('① 带路径前缀的 endpoint（…/openai/v1）→ base 保留前缀 …/openai（端到端：命中了 /openai/api/usage/wallet/）',
    prefix?.ok === true && prefix.endpointBase === `http://127.0.0.1:${okPort}/openai`
    && prefix.displayType === 'USD' && prefix.amount === 42.5 && prefix.usedAmount === 7.25 && prefix.group === 'vip',
    JSON.stringify(prefix));
  check('① 端点自报的账户接口路径与超时（便于运维排查）',
    probe.data?.walletPath === '/api/usage/wallet/' && probe.data?.timeoutMs === 9000,
    JSON.stringify({ path: probe.data?.walletPath, timeoutMs: probe.data?.timeoutMs }));

  /* ② key 不外泄：两种回显渠道（HTTP 500 文案 / username 字段）都不能把 key 带到前端 */
  {
    const leaky = ALL_KEYS.filter((key) => probe.text.includes(key));
    check('② 整个响应体里不出现任何一把渠道 key（含 sk- 片段）', leaky.length === 0, `泄漏了：${leaky.join(', ')}`);
    check('② 连 "sk-" 形状的串都没有（上游回显被擦干净）', !/sk-[A-Za-z0-9_-]{4,}/.test(probe.text), probe.text.slice(0, 200));
    check('② 上游 500 那一行的 error 保留了 HTTP 状态但擦掉了 key',
      /HTTP 500/.test(String(channelOf(probe, FAIL_ID)?.error || '')) && /已隐藏/.test(String(channelOf(probe, FAIL_ID)?.error || '')),
      String(channelOf(probe, FAIL_ID)?.error));
    check('② username 字段里的 key 回显也被擦掉（只留 "echo:[已隐藏]" 这类）',
      String(prefix?.username || '').startsWith('echo:') && !ALL_KEYS.some((key) => String(prefix?.username || '').includes(key)),
      String(prefix?.username));
    // 反向证据：key 确实**被用来**探过上游（否则 ② 会退化成「因为没探所以没泄漏」）
    check('② 上游那一跳确实收到了对应渠道的真 key（Bearer，逐渠道）',
      seen.some((one) => one.url === '/api/usage/wallet/' && one.auth === `Bearer ${MAIN_KEY}`)
      && seen.some((one) => one.url === '/openai/api/usage/wallet/' && one.auth === `Bearer ${PREFIX_KEY}`),
      JSON.stringify(seen.slice(0, 4)));
    check('② 响应体里没有 Authorization 头 / 没有上游原始响应（不透传）',
      !/Authorization/i.test(probe.text) && !/"object"\s*:\s*"wallet_balance"/.test(probe.text), probe.text.slice(0, 200));
  }

  /* ③ 门禁：机构管理员 / 教师 / 学生一律被拒 */
  {
    const studentCall = await api(WALLET, { token: student });
    const teacherCall = await api(WALLET, { token: teacher });
    const anonymous = await api(WALLET, {});
    check('③ 机构管理员 → 403', probeFailed.status === 403, `${probeFailed.status} ${probeFailed.text.slice(0, 160)}`);
    check('③ 教师 → 403', teacherCall.status === 403, `${teacherCall.status} ${teacherCall.text.slice(0, 160)}`);
    check('③ 学生 → 403', studentCall.status === 403, `${studentCall.status} ${studentCall.text.slice(0, 160)}`);
    check('③ 未登录 → 401', anonymous.status === 401, String(anonymous.status));
    check('③ 被拒的响应里也没有任何 key', !ALL_KEYS.some((key) => probeFailed.text.includes(key) || teacherCall.text.includes(key) || studentCall.text.includes(key)));
  }

  /* ④ 上游 500 / 超时：端点仍 200，只有该渠道 ok:false + error（整页不炸） */
  {
    const started = Date.now();
    const again = await api(WALLET, { token: admin });
    const elapsed = Date.now() - started;
    check('④ 上游 500 → 端点仍然 200', again.status === 200 && channelOf(again, FAIL_ID)?.ok === false, `${again.status} ${JSON.stringify(channelOf(again, FAIL_ID))}`);
    check('④ 该渠道的 error 是人能看懂的一句（不是 stack、不是上游原文）',
      typeof channelOf(again, FAIL_ID)?.error === 'string' && channelOf(again, FAIL_ID).error.length > 0
      && !/at\s+\w+\s+\(/.test(channelOf(again, FAIL_ID).error), String(channelOf(again, FAIL_ID)?.error));
    check('④ 上游挂住 → 超时后该渠道 ok:false 并说明超时（不是永远转圈）',
      channelOf(again, HANG_ID)?.ok === false && /没有响应|超时/.test(String(channelOf(again, HANG_ID)?.error)), String(channelOf(again, HANG_ID)?.error));
    check('④ 一条渠道挂掉不影响同一响应里的其他渠道（成功的那几条照样 ok:true）',
      channelOf(again, MAIN_ID)?.ok === true && channelOf(again, PLAIN_ID)?.ok === true, JSON.stringify({ main: channelOf(again, MAIN_ID)?.ok, plain: channelOf(again, PLAIN_ID)?.ok }));
    check('④ 渠道是**并发**探的：一条挂住 9 秒超时，整轮也不该把三条串成 27 秒',
      elapsed < 20000, `实际 ${elapsed} ms`);
  }

  /* ⑤ 没配 key 的渠道：照列但跳过，且**一个请求都不发** */
  {
    const nokey = channelOf(probe, NOKEY_ID);
    check('⑤ 没配 key 的渠道仍列出来（运维能看到「它为什么不在列表里」），标 skipped + reason',
      nokey?.ok === false && nokey?.skipped === true && nokey?.reason === 'NO_API_KEY' && /未配置 API Key/.test(String(nokey?.error)),
      JSON.stringify(nokey));
    check('⑤ 它没有 endpointBase 之外的字段（没查过，不编数字）', nokey?.amount === undefined || nokey?.amount === null, JSON.stringify(nokey));
    check('⑤ **没有**为它发出任何请求：假上游收到的每一发都带着已知的那几把 key 之一',
      seen.length > 0 && seen.every((one) => ALL_KEYS.some((key) => one.auth === `Bearer ${key}`)),
      JSON.stringify(seen.map((one) => one.auth)));
    check('⑤ summary 把「跳过」单独计数（不被算成失败）',
      probe.data?.summary?.skipped === 1 && probe.data?.summary?.failed === 2 && probe.data?.summary?.ok === 3,
      JSON.stringify(probe.data?.summary));
  }

  /* ⑥ 纯函数：endpoint → base 的推导规则（不硬编码域名） */
  {
    const { upstreamWalletBase } = await import('../apps/server/src/routes/admin/overview.js');
    for (const [input, expected] of [
      ['https://api.seedance.nz/v1', 'https://api.seedance.nz'],
      ['https://api.seedance.nz/v1/', 'https://api.seedance.nz'],
      ['https://api.seedance.nz', 'https://api.seedance.nz'],                 // 非 /v1 结尾
      ['https://api.seedance.nz/', 'https://api.seedance.nz'],
      ['https://gw.example.com:8443/v2', 'https://gw.example.com:8443'],      // 端口要保留
      ['https://gw.example.com/openai/v1', 'https://gw.example.com/openai'],  // 前缀要保留
      ['https://gw.example.com/v1/chat/completions', 'https://gw.example.com'],// 配到头了也推得出
      ['http://127.0.0.1:8080/v1beta', 'http://127.0.0.1:8080'],
      ['https://user:pass@gw.example.com/v1', 'https://gw.example.com'],      // URL 里的凭据不能进 base
      ['', ''], ['不是 URL', ''], ['ftp://gw.example.com/v1', ''],
    ]) {
      const actual = upstreamWalletBase(input);
      check(`⑥ upstreamWalletBase(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, actual === expected, `实际 ${JSON.stringify(actual)}`);
    }
  }

  /* ⑦ 交付面：这块 UI 只在平台端「渠道与价格」视图里，机构端 / 学生端一行都没有 */
  {
    const billing = fs.readFileSync(path.join(root, 'apps/admin/src/components/BillingPanels.jsx'), 'utf8');
    check('⑦ 平台端面板里写着「机构端 / 学生端看不到」', /机构端 \/ 学生端看不到这块/.test(billing));
    check('⑦ 平台端面板：低余额阈值是常量、TOKENS 不套金额阈值、USD 不做汇率换算都写清了',
      /LOW_BALANCE_ALERT_AMOUNT = 100/.test(billing) && /WALLET_ALERT_CURRENCIES/.test(billing)
      && /USD 未做汇率换算/.test(billing) && /按 token 计，不套金额阈值/.test(billing));
    check('⑦ 面板是手动刷新（useData 会自动加载 → 这块不能用它），不轮询',
      /const \[state, setState\] = useState\(\{ loading: false/.test(billing) && !/setInterval/.test(billing));
  }

  console.log(JSON.stringify({ name: 'upstream-wallet', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
  okServer.close(); failServer.close(); hangServer.close();
  await sleep(200);
}
