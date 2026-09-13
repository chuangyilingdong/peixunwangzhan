/**
 * P67 「删积分」的反向守卫（2026-09-13，P4）。
 *
 * 积分体系（P4 唯一整块没做的阶段）已删除，额度统一由**算力池**管
 * （学生 × 课包、四种模态共用一个上限，services/computePool.js）。
 *
 * 这个脚本是 O11 那套「删除守卫」的同类：把「删掉的积分面」钉死，免得哪天被顺手加回来。
 * 三条线：
 *   ① **被删的接口必须 404**（机构端成员配额、平台端机构充值、积分限额配置、官网我的积分、学生积分页）；
 *   ② **对外数据里不该再出现积分字段**（/api/me、对话消息、生成任务、学生 AI 中心），
 *      同时**算力口径必须在**（costFen / 池子）；
 *   ③ **保留的闸门必须还活着**（课堂能力开关、单学生调用次数、课时能力、算力池）——
 *      删积分最容易顺手删过头，这条比 ① 更重要。
 *
 * 数据库的积分列与表**故意保留**（删代码不删表的惯例）：本脚本最后会验证
 * 「列还在，但新写入的行 credits_charged 恒为 0」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p67-decredit-'));
const dbPath = path.join(temp, 'platform.db');
const env = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 19067;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };
const gone = async (label, token, pathname, method = 'GET', body) => {
  const r = await api(pathname, { method, token, body });
  check(`${label} 已删除（404）`, r.status === 404, `实际 ${r.status} ${JSON.stringify(r.data).slice(0, 110)}`);
};

try {
  for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const login = async (name, password) => {
    const r = await api('/api/auth/login', { method: 'POST', body: { login: name, password } });
    assert.ok(r.data?.token, `登录失败：${name} ${JSON.stringify(r).slice(0, 160)}`);
    return r.data.token;
  };
  const rootToken = await login('root', 'admin123');
  const orgToken = await login('org-admin', 'org123');
  const studentToken = await login('student-1', 'study123');

  const db = new DatabaseSync(dbPath);
  const orgId = db.prepare("SELECT org_id FROM users WHERE login='org-admin'").get().org_id;
  const studentId = db.prepare("SELECT id FROM users WHERE login='student-1'").get().id;
  db.close();

  /* ① 被删的积分接口：全部 404 */
  console.log('\n① 被删的积分接口');
  await gone('机构端成员配额列表', orgToken, '/api/org/members/credits');
  await gone('机构端成员配额调整', orgToken, `/api/org/members/${studentId}/credits/adjust`, 'POST', { creditsChange: 10 });
  await gone('机构端成员配额历史', orgToken, `/api/org/members/${studentId}/credits/history`);
  await gone('机构端批量分配配额', orgToken, '/api/org/members/credits/batch-allocate', 'POST', { userIds: [studentId], creditsPerUser: 1 });
  await gone('机构端周期额外积分', orgToken, `/api/org/users/${studentId}/period-boosts`, 'PUT', { bonusCredits: 10 });
  await gone('平台端机构充值/调整积分', rootToken, `/api/admin/organizations/${orgId}/credit-adjustments`, 'POST', { credits: 100 });
  await gone('平台端积分限额配置', rootToken, '/api/admin/billing-config/quotas');
  await gone('官网「我的积分」汇总', studentToken, '/api/website/my-credits/summary');
  await gone('学生端积分用量页', studentToken, '/api/student/credits');

  /* ② 对外数据里不该再有积分字段；算力口径必须在 */
  console.log('\n② 数据口径：积分字段没了，算力口径在');
  const me = await api('/api/me', { token: studentToken });
  const meKeys = Object.keys(me.data || {});
  check('GET /api/me 不再返回任何积分字段',
    !meKeys.some((key) => /credit|magic|stones|allowance/i.test(key)),
    meKeys.filter((key) => /credit|magic|stones|allowance/i.test(key)).join(','));
  const aiCenter = await api('/api/ai/center', { token: studentToken });
  check('学生 AI 中心把「已用」报成算力（jobs.costFen）而不是积分',
    aiCenter.status === 200 && Object.hasOwn(aiCenter.data?.jobs || {}, 'costFen') && !Object.hasOwn(aiCenter.data?.jobs || {}, 'creditsCharged'),
    JSON.stringify(aiCenter.data?.jobs || {}).slice(0, 160));
  check('学生 AI 中心整包里不出现积分字段（creditsCharged / magicStones / period.allowance）',
    !/creditsCharged|magicStones|allowance/.test(JSON.stringify(aiCenter.data || {})),
    JSON.stringify(aiCenter.data).slice(0, 160));

  /* ③ 保留的闸门还活着（删积分最容易删过头） */
  console.log('\n③ 保留的闸门必须还在');
  const courses = await api('/api/student/courses', { token: studentToken });
  check('学生课程列表仍可用（门禁只是叠了一层许可）', courses.status === 200);
  const center = await api('/api/student/dashboard', { token: studentToken });
  const lesson = (center.data?.classroomCourses || []).flatMap((course) => course.lessons || [])[0];
  check('课程中心仍下发课时与可进入标记（canStart / hasGrant）',
    Boolean(lesson) && Object.hasOwn(lesson, 'canStart') && Object.hasOwn(lesson, 'hasGrant'),
    JSON.stringify(lesson || {}).slice(0, 160));
  const capabilities = await api('/api/student/billing-config/effective-capabilities', { token: studentToken });
  check('模态开关（机构覆盖 + 平台默认）仍可读', capabilities.status === 200 && Array.isArray(capabilities.data?.items));
  check('课时能力开关仍在（LESSON_CAPABILITY_BY_MODALITY 没被删掉）',
    (await api('/api/ai/center', { token: studentToken })).data?.capabilities?.length > 0);

  /* ④ 列还在（删代码不删表），但新写入的积分列恒为 0 */
  console.log('\n④ 积分列保留但不再写入');
  const db2 = new DatabaseSync(dbPath);
  const cols = db2.prepare("SELECT name FROM pragma_table_info('users') WHERE name IN ('personal_credits','magic_stones','monthly_credit_allowance','ai_credit_limit')").all().map((r) => r.name);
  check('users 的积分列仍在库里（历史数据可回查）', cols.length === 4, cols.join(','));
  const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('credit_entries','personal_credit_ledger','user_credit_adjustments','org_billing_accounts')").all().map((r) => r.name);
  check('积分相关表仍在库里', tables.length === 4, tables.join(','));
  const written = db2.prepare('SELECT COUNT(*) n FROM usage_records WHERE credits_charged != 0').get().n;
  check('新写入的 usage_records.credits_charged 恒为 0', Number(written) === 0, `非 0 行数 ${written}`);
  db2.close();

  console.log(JSON.stringify({ name: 'decredit-removal', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
