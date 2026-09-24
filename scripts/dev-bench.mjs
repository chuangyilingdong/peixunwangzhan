/**
 * 本地验证台：起一个**临时库**的整套平台，专门给「桌面客户端能不能上课」这条链做联调（2026-09-19）。
 *
 * 为什么要有它：客户端那个卡点（登录门拿到的网关密钥到不到得了 dsh）**只能**用
 * 「真客户端 + 真课堂 + 看平台的用量与发送次数」来判 —— 而真课堂在生产上不好造，
 * 也不该拿生产来试。所以这里在本机起一套：
 *   · 临时库（`PLATFORM_DATA_DIR` 指到临时目录，**不碰生产、也不碰仓库里的 data/**）；
 *   · 种子数据（`student-1 / study123`）；
 *   · 给每节已发布课时开一个 ACTIVE 课堂，并把入口类型改成 VIBECODING
 *     （用 `scripts/lib/classroomFixture.mjs`，与守卫同一套夹具）；
 *   · 网关地址指回自己（`DSH_RUNTIME_GATEWAY_URL`）—— 客户端从 `client-context` 拿到的就是它；
 *   · `RUNTIME_GATEWAY_SECRET` 自己给一个（没有它 `/client-context` 直接 409）；
 *   · `AI_PROVIDER=local-mock`：模型调用不需要外部 key，回一句本地模拟回复。
 *
 * 客户端那边怎么接（客户端仓库的 `docs/交接-客户端-20260919.md` 有完整版）：
 * ```bash
 * export LINGDONG_API_BASE=http://127.0.0.1:18910
 * export DSH_HOME=<隔离目录>                      # ⚠️ 别用真的 ~/.dsh
 * pnpm --filter @deepseek-ai/dsh-desktop run start
 * ```
 *
 * 跑法：`node scripts/dev-bench.mjs`（前台跑着，Ctrl+C 收）
 *   · 端口可用 `BENCH_PORT` 覆盖（默认 18910）
 *   · 数据目录可用 `BENCH_DIR` 固定下来**复用**（默认每次新建临时库）
 *     —— 换新库会让客户端里已经过门的会话失效、得重新登录一遍，调一轮多花几分钟；
 *        固定之后只重启验证台即可（客户端那把运行时密钥仍然有效）。
 *   · 信息（端口/库路径/账号/网关地址）写进 `.tmp/bench-info.json`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const PORT = Number(process.env.BENCH_PORT || 18910);
const temp = process.env.BENCH_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'lingdong-bench-'));
fs.mkdirSync(temp, { recursive: true });
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

const freshDb = !fs.existsSync(dbPath);

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  DSH_RUNTIME_GATEWAY_URL: `http://127.0.0.1:${PORT}/api/gateway/v1`,
  // ⚠️ 没有它 /client-context 直接 409（RUNTIME_GATEWAY_UNCONFIGURED）—— 签发/校验运行时密钥
  // 靠这一个共享密钥，生产上配在服务里；验证台自己给一个。
  RUNTIME_GATEWAY_SECRET: 'bench-secret-20260919',
  PORT: String(PORT),
};

const run = (args, label) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => { if (code) reject(new Error(`${label} 失败：\n${err || out}`)); else resolve(out); });
});

console.log(`[bench] 临时目录 ${temp}`);
if (freshDb) {
  await run(['packages/database/src/db.js', '--init'], 'db --init');
  await run(['packages/database/src/seed.js'], 'seed');
  console.log('[bench] 库已建、种子已灌');
} else {
  console.log('[bench] 复用已有库（BENCH_DIR）：跳过 init/seed');
}

// 给每节已发布课时开一个 ACTIVE 课堂（夹具**不造许可**：许可来自种子里的演示授权）
const created = await ensureClassroom(dbPath);
console.log(`[bench] 课堂夹具建了 ${created.length} 个 ACTIVE 课堂`);

// 入口类型改成 VIBECODING —— 「客户端上课」这条路只认 VibeCoding 课（登录门拿 client-context）


const sessions = await arows("SELECT session.id, session.lesson_id, lesson.title AS lesson_title FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id WHERE session.status='ACTIVE'");
for (const session of sessions) {
  await aq("UPDATE class_sessions SET delivery_mode='VIBECODING', updated_at=? WHERE id=?", [new Date().toISOString(), session.id]);
}
const roster = await arows("SELECT part.student_id, user.login, session.id AS session_id, session.lesson_id FROM session_students part JOIN users user ON user.id = part.student_id JOIN class_sessions session ON session.id = part.session_id WHERE session.status='ACTIVE' AND part.status='ACTIVE'");

console.log(`[bench] 把 ${sessions.length} 个课堂改成了 VIBECODING`);
for (const item of roster) console.log(`[bench]   名单：${item.login} → 课堂 ${item.session_id} / 课时 ${item.lesson_id}`);

const info = { port: PORT, temp, dbPath, base: `http://127.0.0.1:${PORT}`, gateway: baseEnv.DSH_RUNTIME_GATEWAY_URL, student: { login: 'student-1', password: 'study123' }, rosters: roster, sessions };
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
fs.writeFileSync(path.join(root, '.tmp/bench-info.json'), JSON.stringify(info, null, 2));
console.log(`[bench] 信息写进 .tmp/bench-info.json；网关 ${info.gateway}`);

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

// 探活
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const response = await fetch(`${info.base}/api/health`);
    if (response.ok) { console.log(`[bench] 服务起来了：${info.base}/api/health → ${response.status}`); break; }
  } catch { /* 还没起 */ }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

// 起台自检：用真登录确认 client-context 给得出课堂与密钥（给不出来就别往下试客户端了）
const login = await fetch(`${info.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(info.student) }).then((r) => r.json()).catch((error) => ({ error: String(error) }));
const token = login?.data?.token || login?.token;
if (token) {
  const context = await fetch(`${info.base}/api/student/runtime/client-context`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  const payload = context?.data ?? context;
  console.log(`[bench] client-context：classroom=${payload?.classroom ? payload.classroom.id : 'null'}，网关=${payload?.gateway?.baseUrl || '（无）'}，密钥=${payload?.gateway?.key ? '有' : '（无）'}`);
  if (!payload?.classroom) console.log('[bench] !! 没有 classroom —— 客户端只会显示「等老师开始上课」，检查上面的名单');
} else {
  console.log('[bench] !! 登录失败：', JSON.stringify(login).slice(0, 300));
}

process.on('SIGINT', () => { server.kill(); process.exit(0); });
