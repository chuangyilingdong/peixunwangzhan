/**
 * P106 网关的**网页搜索透传**（Anthropic 协议进、Anthropic 协议出）。
 *
 * 为什么必须钉住这条链路：dsh 的搜索插件（`@deepseek-ai/dsh-web-search-deepseek`）调的是
 * **Anthropic 协议的 `/messages`**，而它要的密钥是**我们渠道的真密钥**。这条透传一旦写歪，
 * 后果分别是「学生搜不了」（插件报 no API key）、「真密钥进了学生环境」（泄漏 + 绕过账本花钱）、
 * 「搜索花费在账本上完全看不见」。所以下面四类各钉一遍：
 *
 *   ① 身份/门禁：与聊天那条路**同一套**实现（没密钥/篡改/过期 → 401；课堂结束、学生被移出 → 403）
 *   ② 不翻译协议：Anthropic 的字段原样送到上游（只换 model / 只留 web_search 工具）
 *   ③ 密钥边界：上游看到的是**渠道真密钥**；学生手里的运行时密钥**绝不出现**在任何一跳里
 *   ④ 记账：上游 tokens 与按合同单价折算的成本都落进 usage_records / compute_attempts
 *
 * 上游用一个本地假 Anthropic 服务顶替（真上游要花钱、也不该在守卫里跑），
 * 于是「发出去的到底是什么」可以被逐字断言 —— 这正是守卫该干的事。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p106-runtime-search-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
const secretFile = path.join(temp, 'secrets.json');
const SECRET = 'p106-runtime-secret';
const CHANNEL_ID = 'ch-search';
const CHANNEL_KEY = 'p106-real-channel-key';       // 「渠道真密钥」：只应该出现在我们 → 上游那一跳
const MOCK_PORT = 19407;
const PORT = 19406;

// 签发密钥这一步跑在本进程里，所以本进程也要有同一把密钥（baseEnv 只传给被拉起的服务）
process.env.RUNTIME_GATEWAY_SECRET = SECRET;
// ⚠️ `providerSecret` 的密钥文件路径是**模块加载时**读的（`const file = process.env...`），
// 而 ESM 的静态 import 会被提升到所有语句之前 —— 所以平台源码**只能**用下面的动态 import 引，
// 静态引会拿到「用默认路径 /etc/... 打开的模块」并缓存住，症状是密钥读不出来（本守卫踩过一次）。
process.env.AI_PROVIDER_SECRET_FILE = secretFile;
const { issueRuntimeKey, searchUpstreamEndpoint } = await import('../apps/server/src/routes/runtimeGateway.js');
const { setProviderApiKey } = await import('../apps/server/src/services/providerSecret.js');
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');


const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp, PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath, AI_PROVIDER_SECRET_FILE: secretFile,
  DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock', RUNTIME_GATEWAY_SECRET: SECRET,
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(code)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

/* ── 假 Anthropic 上游：把我们收到的**原样**记下来，供逐字断言 ───────────────────────── */
const seen = [];
let reply = null;
const anthropicOk = (over = {}) => ({
  id: 'msg_p106', type: 'message', role: 'assistant', model: 'mock-search-model',
  content: [
    { type: 'server_tool_use', id: 'call_1', name: 'web_search', input: { query: '北京今天的天气' } },
    { type: 'web_search_tool_result', tool_use_id: 'call_1', content: [{ type: 'web_search_result', url: 'https://example.com/a', title: '示例结果' }] },
    { type: 'text', text: '北京今天有雷阵雨。', citations: [{ type: 'web_search_result_location', url: 'https://example.com/a', cited_text: '雷阵雨' }] },
  ],
  // 用一个**大**用量让「按合同单价折算」算出非零的分，否则断言会退化成「0 === 0」
  usage: { input_tokens: 1000000, output_tokens: 500000, server_tool_use: { web_search_requests: 2 } },
  ...over,
});
const upstreamServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(raw); } catch { body = null; }
    seen.push({ method: req.method, url: req.url, headers: req.headers, body, raw });
    const answer = reply || { status: 200, body: anthropicOk() };
    res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(answer.body));
  });
});
await new Promise((resolve) => upstreamServer.listen(MOCK_PORT, '127.0.0.1', resolve));

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
setProviderApiKey(CHANNEL_KEY, CHANNEL_ID);

 
const teacher = await arow("SELECT * FROM users WHERE login='teacher-1'");
const student = await arow("SELECT * FROM users WHERE login='student-1'");
const lesson = await arow("SELECT * FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1");
const now = new Date().toISOString();
await aq('INSERT OR IGNORE INTO student_course_grants(id,org_id,student_id,series_id,granted_at) VALUES (?,?,?,?,?)', ['p106_grant', student.org_id, student.id, lesson.series_id, now]);
const sessionId = 'csession_p106';
await aq(`INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode,created_at,updated_at,started_at)
  VALUES (?,?,?,?,?,?,'ACTIVE','VIBECODING',?,?,?)`, [sessionId, 'P106 搜索透传', student.org_id, lesson.series_id, lesson.id, teacher.id, now, now, now]);
await aq(`INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at)
  VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)`, ['p106_part', sessionId, student.id, student.org_id, lesson.id, lesson.series_id, teacher.id, now, now]);

// 渠道指向假上游：`protocol` 不写 ANTHROPIC，走的正是「DeepSeek 官方那类 OpenAI 兼容口」那条推导，
// 与生产上文本主渠道（endpoint=https://api.deepseek.com/）同一形态。
const policy = {
  provider: 'custom', model: '', endpoint: '',
  channels: [{
    id: CHANNEL_ID, name: '搜索渠道', provider: 'custom', model: 'mock-search-model',
    models: ['mock-search-model'], endpoint: `http://127.0.0.1:${MOCK_PORT}`, protocol: 'RESPONSES',
    upstreamUnitPrices: { TEXT: { inputFenPer1MTokens: 200, outputFenPer1MTokens: 800 } },
  }],
  modalityChannels: { TEXT: CHANNEL_ID }, modalityBackupChannels: {}, modelRoutes: [],
  allowStudentExternalContent: true,
};
const writePolicy = async (patch = {}) => {
   
  await aq('UPDATE platform_settings SET ai_provider_policy=? WHERE id=1', [JSON.stringify({ ...policy, ...patch })]);
  
};
await writePolicy();


const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', (x) => { logs += x; });
server.stderr.on('data', (x) => { logs += x; });

const search = async (body, token, headers = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/gateway/v1/search/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null; try { payload = JSON.parse(text); } catch { payload = null; }
  return { status: response.status, payload, text };
};
// 学生环境里那个插件发的请求形状（源码照抄：tools 带 web_search_20250305，没别的字段）
const pluginBody = (over = {}) => ({
  model: 'deepseek-v4-flash',
  max_tokens: 4096,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: 北京今天的天气' }] }],
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
  ...over,
});

try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { ready = true; break; } } catch { /* 还没起来 */ }
    await sleep(100);
  }
  assert.ok(ready, logs);

  const key = issueRuntimeKey({ orgId: student.org_id, userId: student.id, sessionId, lessonId: lesson.id });

  /* ① 身份：与聊天那条路同一套（插件两个头都发，所以两个都得认） */
  const noKey = await search(pluginBody(), '');
  check('① 没有密钥 → 401', noKey.status === 401, `实际 ${noKey.status} ${noKey.text.slice(0, 160)}`);
  const tampered = await search(pluginBody(), key.replace(/.$/, key.endsWith('A') ? 'B' : 'A'));
  check('① 篡改过的密钥 → 401', tampered.status === 401, `实际 ${tampered.status}`);
  const expired = issueRuntimeKey({ orgId: student.org_id, userId: student.id, sessionId, lessonId: lesson.id, ttlMs: -1000 });
  const expiredCall = await search(pluginBody(), expired);
  check('① 过期密钥 → 401', expiredCall.status === 401, `实际 ${expiredCall.status}`);
  check('① 失败也是 Anthropic 形状（客户端读的是 error.message，不是我们的信封）',
    noKey.payload?.type === 'error' && typeof noKey.payload?.error?.message === 'string' && noKey.payload?.success === undefined,
    noKey.text.slice(0, 160));
  {
    // 插件两个头都发；只给 x-api-key（没有 authorization）也必须认
    const apiKeyOnly = await search(pluginBody(), '', { 'x-api-key': key });
    check('① 只带 x-api-key（插件的另一种发法）也认', apiKeyOnly.status === 200, `实际 ${apiKeyOnly.status} ${apiKeyOnly.text.slice(0, 160)}`);
  }
  seen.length = 0;

  /* ② 正常一通：不翻译协议，只换必须由我们决定的两处 */
  const ok = await search(pluginBody({ system: '你是搜索助手', metadata: { user_id: 'x' } }), key);
  check('② 正常调用 → 200，响应是上游的 Anthropic 正文', ok.status === 200 && ok.payload?.type === 'message'
    && ok.payload?.content?.some((b) => b.type === 'web_search_tool_result'), `实际 ${ok.status} ${ok.text.slice(0, 200)}`);
  {
    const hit = seen.at(-1);
    check('② 打到「同源主机的 /anthropic/v1/messages」', hit?.url === '/anthropic/v1/messages', String(hit?.url));
    check('② Anthropic 的字段原样带过（system / metadata / content 内容块不动）',
      hit?.body?.system === '你是搜索助手' && hit?.body?.metadata?.user_id === 'x'
      && Array.isArray(hit?.body?.messages?.[0]?.content) && hit.body.messages[0].content[0].type === 'text',
      JSON.stringify(hit?.body?.messages));
    check('② 插件报的模型名不原样发上游 → 换成我们渠道的模型', hit?.body?.model === 'mock-search-model', String(hit?.body?.model));
    check('② 认得出的模型名就用它（deepseek 那类是意向，渠道清单里认得出才照用）',
      (await search(pluginBody({ model: 'mock-search-model' }), key), seen.at(-1)?.body?.model === 'mock-search-model'), String(seen.at(-1)?.body?.model));
    check('② 不是流式（我们一次性读完再回吐，用量才读得全）', hit?.body?.stream === false, String(hit?.body?.stream));
  }

  /* ③ 密钥边界：真密钥只出现在我们 → 上游那一跳；学生的运行时密钥一步都不许出现 */
  {
    const hit = seen.at(-1);
    check('③ 上游收到的是**渠道真密钥**', hit?.headers?.['x-api-key'] === CHANNEL_KEY && hit?.headers?.authorization === `Bearer ${CHANNEL_KEY}`,
      JSON.stringify({ x: hit?.headers?.['x-api-key'], auth: hit?.headers?.authorization }));
    const leaked = seen.some((one) => JSON.stringify(one.headers).includes(key) || String(one.raw).includes(key));
    check('③ 运行时密钥**没有**出现在任何一发上游请求里（泄漏即等于把学生环境变成提款机）', !leaked);
    check('③ 上游收到的是我们自己的 UA（不是学生环境的）', String(hit?.headers?.['user-agent'] || '').includes('ai-kids-platform-gateway'), String(hit?.headers?.['user-agent']));
  }

  /* ④ 工具收口：只留 web_search，且检索次数有上限 */
  {
    seen.length = 0;
    await search(pluginBody({
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 99 },
        { type: 'code_execution_20250522', name: 'code_execution' },
      ],
    }), key);
    const tools = seen.at(-1)?.body?.tools || [];
    check('④ 非搜索类服务端工具被摘掉（网关不是「能点上游任何服务端能力」的机器）',
      tools.length === 1 && tools[0].type === 'web_search_20250305', JSON.stringify(tools));
    check('④ 检索次数被夹到上限（10）', tools[0]?.max_uses === 10, String(tools[0]?.max_uses));
    seen.length = 0;
    const noTool = await search(pluginBody({ tools: [] }), key);
    check('④ 一个搜索工具都没有 → 明确报错（不静默让上游干聊）', noTool.status === 400 && /web_search/.test(noTool.text), `${noTool.status} ${noTool.text.slice(0, 140)}`);
  }

  /* ⑤ 记账：上游 tokens 与按合同单价折算的成本都落账 */
  {
     
    const usage = await arow("SELECT * FROM usage_records WHERE class_session_id=? AND modality='TEXT' ORDER BY created_at DESC, rowid DESC LIMIT 1", [sessionId]);
    check('⑤ 落了 usage_records，tokens 来自上游回执', usage?.input_tokens === 1000000 && usage?.output_tokens === 500000,
      JSON.stringify({ in: usage?.input_tokens, out: usage?.output_tokens }));
    check('⑤ 还留在密钥里的归属（学生/机构）上，不是请求里塞的',
      usage?.user_id === student.id && usage?.org_id === student.org_id, JSON.stringify({ u: usage?.user_id, o: usage?.org_id }));
    check('⑤ 留档写明了「插件报的名字 → 实际渠道/模型」与检索次数',
      /modelResolution/.test(String(usage?.pricing_snapshot || '')) && /web_search_requests|"requests":2/.test(String(usage?.pricing_snapshot || '')),
      String(usage?.pricing_snapshot).slice(0, 300));
    const attempt = await arow("SELECT * FROM compute_attempts WHERE class_session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1", [sessionId]);
    check('⑤ compute_attempts 落了 SUCCESS + 用量证据', attempt?.status === 'SUCCESS' && attempt?.input_tokens === undefined && /UPSTREAM_USAGE/.test(String(attempt?.usage_snapshot || '')),
      JSON.stringify({ status: attempt?.status, evidence: String(attempt?.usage_snapshot).slice(0, 120) }));
    check('⑤ 成本按合同单价折算成非零的分（1000000×200/1M + 500000×800/1M = 600）',
      attempt?.cost_source === 'COMPUTED' && attempt?.upstream_cost_fen === 600, JSON.stringify({ source: attempt?.cost_source, fen: attempt?.upstream_cost_fen }));
    
  }

  /* ⑥ 上游报错：状态码与正文原样回吐，账本记 FAILED（不能失败得无声无息） */
  {
    reply = { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: '上游限流了' } } };
    const limited = await search(pluginBody(), key);
    check('⑥ 上游 429 → 原样回吐 429 与上游原话', limited.status === 429 && /上游限流了/.test(limited.text), `${limited.status} ${limited.text.slice(0, 160)}`);
     
    const failed = await arow("SELECT * FROM usage_records WHERE class_session_id=? AND status='FAILED' ORDER BY created_at DESC, rowid DESC LIMIT 1", [sessionId]);
    check('⑥ 失败也落账（带 fail_code）', Boolean(failed?.fail_code), JSON.stringify({ code: failed?.fail_code }));
    
    reply = null;
  }

  /* ⑦ 外发闸门：不许把学生内容发到平台外时，搜索一并挡住 */
  {
    await writePolicy({ allowStudentExternalContent: false });
    const blocked = await search(pluginBody(), key);
    check('⑦ 机构禁掉「学生内容外发」→ 搜索也 403（搜索框里的话同样是学生内容）',
      blocked.status === 403 && /外部 AI/.test(blocked.text), `${blocked.status} ${blocked.text.slice(0, 160)}`);
    await writePolicy();
  }

  /* ⑧ 门禁：课堂结束 / 学生被移出（与聊天同一个判据，不用等环境回收） */
  {
     
    await aq("UPDATE class_sessions SET status='ENDED', ended_at=? WHERE id=?", [now, sessionId]);
    
    const ended = await search(pluginBody(), key);
    check('⑧ 课堂已结束 → 403', ended.status === 403 && /课堂已经结束/.test(ended.text), `${ended.status} ${ended.text.slice(0, 160)}`);
     
    await aq("UPDATE class_sessions SET status='ACTIVE' WHERE id=?", [sessionId]);
    await aq("UPDATE session_students SET status='REMOVED', removed_reason='P106' WHERE id='p106_part'");
    
    const removed = await search(pluginBody(), key);
    check('⑧ 学生被移出名单 → 403', removed.status === 403 && /不在课堂名单/.test(removed.text), `${removed.status} ${removed.text.slice(0, 160)}`);
     
    await aq("UPDATE session_students SET status='ACTIVE', removed_reason=NULL WHERE id='p106_part'");
    
  }

  /* ⑨ 端点推导（纯函数）：另外两种渠道形态 */
  {
    check('⑨ 渠道自己就是 Anthropic 协议 → 它的 endpoint 就是基地址',
      searchUpstreamEndpoint({ endpoint: 'https://api.deepseek.com/anthropic/v1', protocol: 'ANTHROPIC' }) === 'https://api.deepseek.com/anthropic/v1/messages',
      searchUpstreamEndpoint({ endpoint: 'https://api.deepseek.com/anthropic/v1', protocol: 'ANTHROPIC' }));
    check('⑨ 配到头（以 /messages 结尾）→ 不再拼一层',
      searchUpstreamEndpoint({ endpoint: 'https://example.com/v1/messages', protocol: 'ANTHROPIC' }) === 'https://example.com/v1/messages');
    check('⑨ 走算力网关 → 网关自己的 /v1/messages',
      searchUpstreamEndpoint({ endpoint: 'https://gw.example.com', viaGateway: true }) === 'https://gw.example.com/v1/messages',
      searchUpstreamEndpoint({ endpoint: 'https://gw.example.com', viaGateway: true }));
    check('⑨ OpenAI 兼容口 → 同源主机的 /anthropic/v1/messages（生产文本主渠道就吃这条）',
      searchUpstreamEndpoint({ endpoint: 'https://api.deepseek.com/', protocol: 'RESPONSES' }) === 'https://api.deepseek.com/anthropic/v1/messages',
      searchUpstreamEndpoint({ endpoint: 'https://api.deepseek.com/', protocol: 'RESPONSES' }));
    let threw = '';
    try { searchUpstreamEndpoint({ endpoint: '' }); } catch (error) { threw = String(error.message); }
    check('⑨ 端点是空的 → 明确报错（不静默打到一个没配的地方）', /端点/.test(threw), threw);
  }

  /* ⑩ 接线：宿主脚本必须把插件的两个变量注入进去（路由写得再对，不注入照样搜不了） */
  {
    const hostUser = fs.readFileSync(path.join(root, 'deploy/dsh-student/host-user/run-student-user.sh'), 'utf8');
    const container = fs.readFileSync(path.join(root, 'deploy/dsh-student/host/run-student-container.sh'), 'utf8');
    check('⑩ 用户版：注入 DEEPSEEK_SEARCH_BASE_URL（指到我们网关的 /search）',
      /--setenv=DEEPSEEK_SEARCH_BASE_URL="\$\{SEARCH_GATEWAY\}"/.test(hostUser) && /SEARCH_GATEWAY="\$\{GATEWAY%\/\}\/search"/.test(hostUser));
    check('⑩ 用户版：DEEPSEEK_API_KEY 给的是**本次运行时密钥**，不是渠道真密钥',
      /--setenv=DEEPSEEK_API_KEY="\$\{KEY\}"/.test(hostUser));
    check('⑩ 用户版：复用判定也认这两个变量（否则复用会得到一个「一搜索就报 no API key」的半坏环境）',
      /running_env_value DEEPSEEK_SEARCH_BASE_URL/.test(hostUser) && /VERBOSE_REASON="环境里的搜索网关不是这次的/.test(hostUser));
    check('⑩ 容器版同样注入（DEEPSEEK_RUNTIME_MODE 切回容器时不能少这一条）',
      /-e "DEEPSEEK_SEARCH_BASE_URL=\$\{GATEWAY%\/\}\/search"/.test(container) && /-e "DEEPSEEK_API_KEY=\$\{KEY\}"/.test(container));
    check('⑩ 两个脚本里都**没有**出现渠道真密钥的名字（真密钥绝不进学生环境）',
      !/p106-real-channel-key|DEEPSEEK_CHANNEL_KEY/.test(hostUser) && !/p106-real-channel-key|DEEPSEEK_CHANNEL_KEY/.test(container));
  }

  console.log(JSON.stringify({ name: 'runtime-search-gateway', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(logs.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
  upstreamServer.close();
  await sleep(200);
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
