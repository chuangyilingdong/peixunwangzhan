/**
 * P92 机构端 / 学员端「消耗」口径守卫（2026-09-15 定稿）。
 *
 * 口径：**机构端与学员端看到的「消耗」= 对外售价合计**
 *   = `SUM(compute_attempts.sale_price_fen)`，且**只计成功尝试**。
 *
 * 起因（这是一个静默失败）：这些地方原来读 `usage_records.cost_fen`，而那一列现行代码
 * **恒写 0**（平台承担算力成本、不扣学生），于是：
 *   · 机构端课堂页那列「这节课消耗」永远显示 ¥0.00，老师看不出任何消耗；
 *   · 机构端账单/用量总览、学员端 AI 中心同理。
 * 更糟的是那一列还混了三种含义：现行链路写 0、VibeCoding 插画路径写过**对外售价**、
 * 2026-09-13 之前的历史行是**积分时代**旧值 —— 求和没有意义。
 *
 * 平台自己的**进货成本与毛利只在「财务与对账」看**（`compute_attempts.upstream_cost_fen`），
 * 所以本守卫同时钉住「预算/成本口径没被改坏」：`classroomBudgetStatus.knownCostFen` 仍读成本。
 *
 * 钉五件事：
 *   ① 消耗取对外售价快照，**不取** usage_records.cost_fen（用 999 这种污染值证明换了数据源）；
 *   ② 失败尝试的售价**不计入**（没交付东西，不该让学生/老师看到重复消耗）；
 *   ③ 课堂结算 `completed_cost_fen` 用同一口径（机构端「这节课消耗」的来源）；
 *   ④ 机构端两个接口（调用列表 / 账单用量总览）与学员端 AI 中心都走这个口径；
 *   ⑤ 平台端成本口径不受影响（已知成本仍来自 upstream_cost_fen，未知仍单列不按 0）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p92-sale-price-scope-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;
process.env.DEPLOYMENT_MODE = 'local-mock';
process.env.AI_PROVIDER = 'local-mock';
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

/* 造数据：一个 ACTIVE 课堂 + 一个学员，两条调用（成功 / 失败）。
   usage_records.cost_fen 故意写成 999 —— 只要「消耗」还读那一列，断言立刻红。 */
const seeded = {};
{
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA busy_timeout = 5000');
  const orgId = db.prepare("SELECT org_id FROM users WHERE login='org-admin'").get().org_id;
  const student = db.prepare("SELECT id FROM users WHERE login='student-1'").get().id;
  const teacher = db.prepare("SELECT id FROM users WHERE login='teacher-1'").get().id;
  const lesson = db.prepare("SELECT id FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1").get().id;
  const series = db.prepare('SELECT series_id FROM course_lessons WHERE id=?').get(lesson).series_id;
  const now = new Date().toISOString();
  const sessionId = 'csession_p92';
  db.prepare("INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode,started_by,started_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'ACTIVE','CANVAS',?,?,?,?)")
    .run(sessionId, 'P92 消耗口径课堂', orgId, series, lesson, teacher, now, now, now);
  db.prepare("INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at) VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)")
    .run('sstudent_p92', sessionId, student, orgId, lesson, series, teacher, now, now);

  // 成功一次：对外售价 100 分、上游成本 4 分（REPORTED），用量记录里塞 999 污染值
  db.prepare("INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,modality,channel_id,provider,model,routed_via,status,cost_source,upstream_cost_fen,sale_price_fen,sale_snapshot,class_session_id,lesson_id,created_at) VALUES (?,?,1,?,?,'IMAGE','p92-channel','custom','p92-model','direct','SUCCESS','REPORTED',4,100,'{}',?,?,?)")
    .run('attempt_p92_ok', 'call_p92_ok', orgId, student, sessionId, lesson, now);
  db.prepare("INSERT INTO usage_records(id,org_id,user_id,class_session_id,modality,model,credits_charged,status,cost_fen,compute_call_id,created_at) VALUES (?,?,?,?, 'IMAGE','p92-model',0,'SUCCESS',999,?,?)")
    .run('usage_p92_ok', orgId, student, sessionId, 'call_p92_ok', now);
  // 失败一次：同样有售价快照，但**不该**计入消耗；成本来源 UNKNOWN（失败尝试成本天然为空）
  db.prepare("INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,modality,channel_id,provider,model,routed_via,status,cost_source,upstream_cost_fen,sale_price_fen,sale_snapshot,class_session_id,lesson_id,created_at) VALUES (?,?,1,?,?,'IMAGE','p92-channel','custom','p92-model','direct','FAILED','UNKNOWN',NULL,100,'{}',?,?,?)")
    .run('attempt_p92_bad', 'call_p92_bad', orgId, student, sessionId, lesson, now);
  db.prepare("INSERT INTO usage_records(id,org_id,user_id,class_session_id,modality,model,credits_charged,status,cost_fen,compute_call_id,created_at) VALUES (?,?,?,?, 'IMAGE','p92-model',0,'FAILED',999,?,?)")
    .run('usage_p92_bad', orgId, student, sessionId, 'call_p92_bad', now);
  Object.assign(seeded, { orgId, student, teacher, lesson, series, sessionId });
  db.close();
}

/* 同进程直读口径函数（服务模块按 env 打开同一个库） */
const { salePriceFenFor, classroomBudgetStatus } = await import('../apps/server/src/services/computePool.js');
const { lessonCostFenFor } = await import('../apps/server/src/services/classroomSessions.js');
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

try {
  const byStudent = salePriceFenFor({ sessionId: seeded.sessionId, studentId: seeded.student });
  check('① 课堂+学员的消耗 = 成功尝试的对外售价 100 分（不是 cost_fen 的 999，也不是成本的 4）', byStudent === 100, String(byStudent));
  const bySession = salePriceFenFor({ sessionId: seeded.sessionId });
  check('② 失败尝试的售价不计入（仍为 100，而不是 200）', bySession === 100, String(bySession));
  const byOrg = salePriceFenFor({ orgId: seeded.orgId, since: new Date(Date.now() - 86400000).toISOString() });
  check('③ 按机构 + 时间窗同理', byOrg === 100, String(byOrg));
  check('④ 机构端「这节课消耗」的来源函数同口径', lessonCostFenFor({ studentId: seeded.student, sessionId: seeded.sessionId }) === 100);

  const budget = classroomBudgetStatus(seeded.sessionId);
  check('⑤ 平台成本口径没被改坏：knownCostFen 仍读 upstream_cost_fen（4 分）', Number(budget.knownCostFen) === 4, JSON.stringify(budget));
  check('⑥ 有成本未知的调用时不把已知部分当总额（usedFen 留空、未知单列）', budget.usedFen === null && Number(budget.unknownCalls) === 1, JSON.stringify(budget));

  /* 接口层：机构端两个 + 学员端一个 */
  const port = 19092;
  const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (x) => { serverLog += x; });
  server.stderr.on('data', (x) => { serverLog += x; });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const api = async (pathname, { method = 'GET', token, body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, data: j?.data ?? j, error: j?.error || null };
  };
  try {
    for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
    const login = async (name, password) => {
      const r = await api('/api/auth/login', { method: 'POST', body: { login: name, password } });
      assert.ok(r.data?.token, `登录失败：${name} ${JSON.stringify(r).slice(0, 160)}`);
      return r.data.token;
    };
    const orgToken = await login('org-admin', 'org123');
    const studentToken = await login('student-1', 'study123');

    const usage = await api('/api/org/ai-usage?limit=50', { token: orgToken });
    const items = usage.data?.items || [];
    const okItem = items.find((item) => item.id === 'usage_p92_ok');
    const badItem = items.find((item) => item.id === 'usage_p92_bad');
    check('⑦ 机构端调用列表：成功那笔显示对外售价 100 分', Number(okItem?.costFen) === 100, JSON.stringify(okItem?.costFen));
    check('⑧ 机构端调用列表：失败那笔消耗为 0（没有成功尝试可关联）', badItem !== undefined && Number(badItem.costFen) === 0, JSON.stringify({ found: badItem !== undefined, costFen: badItem?.costFen }));

    const overview = await api('/api/org/billing/usage-overview?days=30', { token: orgToken });
    check('⑨ 机构端账单/用量总览 totalFen = 100（不是 999、不是 4）', Number(overview.data?.totalFen) === 100, JSON.stringify(overview.data?.totalFen));
    const imageRow = (overview.data?.modalities || []).find((row) => row.modality === 'IMAGE');
    check('⑩ 按模态分组同口径', Number(imageRow?.costFen) === 100, JSON.stringify(overview.data?.modalities));
    const top = (overview.data?.topUsers || [])[0];
    check('⑪ 按学员分组同口径', Number(top?.costFen) === 100, JSON.stringify(overview.data?.topUsers));

    // 平台端「机构与学员」对照（SUPER_ADMIN）：学生消耗（对外售价）与我们的成本必须并排给出
    const rootToken = await login('root', 'admin123');
    const pair = await api('/api/admin/billing/org-student-usage?days=30', { token: rootToken });
    check('⑬ 对照表：机构行同时给出学生消耗 100 分与我们的成本 4 分', Number(pair.data?.orgs?.[0]?.saleFen) === 100 && Number(pair.data?.orgs?.[0]?.costFen) === 4, JSON.stringify(pair.data?.orgs?.[0]));
    check('⑭ 对照表：汇总合计同口径', Number(pair.data?.totals?.saleFen) === 100 && Number(pair.data?.totals?.costFen) === 4, JSON.stringify(pair.data?.totals));
    const studentPair = await api('/api/admin/billing/org-student-usage?days=30&orgId=' + encodeURIComponent(seeded.orgId), { token: rootToken });
    check('⑮ 对照表：学员行同口径（选到机构后能看到每个学员的两笔钱）', Number(studentPair.data?.students?.[0]?.saleFen) === 100 && Number(studentPair.data?.students?.[0]?.costFen) === 4, JSON.stringify(studentPair.data?.students?.[0]));

    const center = await api('/api/ai/center', { token: studentToken });
    const centerCost = center.data?.jobs?.costFen ?? center.data?.jobs?.costFen;
    check('⑫ 学员端 AI 中心消耗 = 100 分', Number(centerCost) === 100, JSON.stringify(center.data?.jobs));
  } finally {
    server.kill();
  }

  if (failures) { console.log(serverLog.slice(-800)); process.exitCode = 1; }
  else console.log('P92 机构端/学员端消耗=对外售价（只计成功尝试）、课堂结算同口径、平台成本口径未受影响 通过');
} finally {
  /* 断言失败也要把带日志的现场打出来 */
}
