/**
 * P161 生成对账：上游已出片、已计费，我们这边却判了失败 → **按 task_id 查回来**（2026-09-28 用户口径）。
 *
 * 口径原话：「上游已经生成好了，扣费了」→ 定了两件事：
 *   ① **按 task_id 对账，而不是把超时调大**（调大只会把"发版撞上生成"那一类放大）；
 *   ② 捞回来的素材**只补素材、不计费**。
 *
 * 这条守卫钉住的正是那两步 + 三个不许：
 *   · 上游说成功   → 任务收成 SUCCEEDED、素材落 `media_assets`、留 `AI_GENERATION_RECONCILED` 审计；
 *   · ⭐ **不计费**：`usage_records` 的 `credits_charged` / `cost_fen` 必须是 0，且带 `reconciled` 标记；
 *   · 幂等：已经收成 SUCCEEDED 的**不再是候选**，素材不许翻倍；
 *   · 上游还在跑 → 判 PENDING、**什么都不动**（下一轮再看，绝不判死）；
 *   · 上游自己说失败 → 任务保持 FAILED（不假装成功）；
 *   · ⭐ **只查不提交**：整轮对账对上游**一个 POST 都没有**（"能查就别重发……重发会双扣"）。
 *
 * 用临时 SQLite + 一个假上游（只认查询路径与产物地址），不碰默认库与生产库。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p161-reconcile-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
// 本脚本在**进程内**直接调用服务端函数（reconcileStrandedGenerations），它按 PLATFORM_DB_PATH 连库，
// 所以测试进程自己也要指向这个临时库。
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;
process.env.DEPLOYMENT_MODE = 'local-mock';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const { aq, arow } = await import('../packages/database/src/store.js');
const { setProviderApiKey } = await import('../apps/server/src/services/providerSecret.js');
const { reconcileStrandedGenerations } = await import('../apps/server/src/routes/aiGeneration.js');
// ⚠️ 没配 key 时 providerConfig 判 invalid → 退回 unavailableProvider（它**没有** queryTask）→
//    对账会报 UNSUPPORTED。所以夹具必须给这个渠道一把 key（假上游不看它，但装配链路要它）。
setProviderApiKey('p161-fake-key', 'p161-main');

/* ────────── 假上游：只提供「按任务号查询」和「产物字节」两条路 ────────── */
const TASK_ID = 'task_p161_reconcile';
let taskState = 'succeeded'; // succeeded / processing / failed
const seen = [];
let upstreamPort = 0;
const upstream = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url });
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url.startsWith('/v1/query/video_generation/')) {
    const taskId = decodeURIComponent(req.url.split('/').pop());
    // MiniMax V2 把状态包在 task 里 —— 与真实渠道同形状，判据才真的是生产那一套。
    if (taskState === 'processing') return json(200, { id: taskId, task: { status: 'processing' } });
    if (taskState === 'failed') return json(200, { id: taskId, task: { status: 'failed', fail_reason: '上游自己判的失败（内容安全）' } });
    return json(200, {
      id: taskId, task: { status: 'succeeded' },
      video_url: `http://127.0.0.1:${upstreamPort}/v1/files/p161.mp4`, mime_type: 'video/mp4',
    });
  }
  if (req.method === 'GET' && req.url === '/v1/files/p161.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.end(Buffer.from('00000018667479706d703432', 'hex'));
    return;
  }
  return json(404, { message: 'P161 假上游：没有这条路由' });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
upstreamPort = upstream.address().port;

/* ────────── 渠道：走「自定义（OpenAI 兼容）」+ 查询路径模板 ────────── */
await aq('UPDATE platform_settings SET ai_provider_policy=? WHERE id=1', [JSON.stringify({
  provider: 'custom', displayName: 'P161 上游', model: 'p161-model', endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
  channels: [{
    id: 'p161-main', name: 'P161 渠道', provider: 'custom', model: 'p161-model', models: ['p161-model'],
    endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
    pollPaths: { VIDEO: '/v1/query/video_generation/{id}' },
  }],
  modalityChannels: { VIDEO: 'p161-main' },
})]);

/* ────────── 夹具：学生 + 项目 + 「已受理但被判失败」的任务 ────────── */
const student = await arow("SELECT id, org_id FROM users WHERE login='student-1'");
check('夹具：种子里的学生存在', Boolean(student?.id), JSON.stringify(student));
const nowIso = new Date().toISOString();

const makeStrandedJob = async ({ jobId, attemptId, callId, taskId, errorCode = 'GENERATION_PROVIDER_TIMEOUT' }) => {
  const projectId = `proj_${jobId}`;
  await aq(`INSERT INTO student_projects(id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at)
     VALUES (?,?,?,?, 'DRAFT','{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}',1,?,?,?)`,
  [projectId, student.id, student.org_id, `P161 ${jobId}`, nowIso, nowIso, nowIso]);
  await aq(`INSERT INTO generation_jobs(id,org_id,user_id,project_id,modality,provider,model,prompt,status,error_code,error_message,created_at,started_at,completed_at)
     VALUES (?,?,?,?, 'VIDEO','custom','p161-model','英雄变身 15 秒动画','FAILED',?,?,?,?,?)`,
  [jobId, student.org_id, student.id, projectId, errorCode, 'AI 服务响应超时', nowIso, nowIso, nowIso]);
  // 上游任务号在提交成功那一刻就落库了 —— 这一列就是对账的唯一把手。
  await aq(`INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,project_id,generation_job_id,modality,channel_id,provider,model,status,task_id,sale_snapshot,error_code,created_at,completed_at)
     VALUES (?,?,1,?,?,?,?, 'VIDEO','p161-main','custom','p161-model','FAILED',?, '{}', ?, ?, ?)`,
  [attemptId, callId, student.org_id, student.id, projectId, jobId, taskId, errorCode, nowIso, nowIso]);
  return projectId;
};

const jobId = 'job_p161_timeout';
const projectId = await makeStrandedJob({ jobId, attemptId: 'attempt_p161', callId: 'call_p161', taskId: TASK_ID });
const jobIdPending = 'job_p161_pending';
await makeStrandedJob({ jobId: jobIdPending, attemptId: 'attempt_p161b', callId: 'call_p161b', taskId: 'task_p161_pending', errorCode: 'GENERATION_INTERRUPTED' });

const logLines = [];
const say = (message) => logLines.push(String(message));

/* ────────── ① 上游说成功：捞回来，且只补素材不计费 ────────── */
console.log('\n① 上游说 succeeded（生产里的真情形）');
// 只扫这一条 —— 另一条留给 ③/④ 当"还在跑 / 上游说失败"的样本，别在这里提前修好。
const first = await reconcileStrandedGenerations({ jobIds: [jobId], minAgeMs: 0, log: say });
check('① 对账扫到了 1 条候选', first.scanned === 1, JSON.stringify(first));

const job = await arow('SELECT status, error_code, error_message FROM generation_jobs WHERE id=?', [jobId]);
check('① 任务被收成 SUCCEEDED', job?.status === 'SUCCEEDED', JSON.stringify(job));
check('① 失败时的 error_code/error_message 被清掉（否则界面上还写着「响应超时」）', !job?.error_code && !job?.error_message, JSON.stringify(job));

const asset = await arow('SELECT * FROM media_assets WHERE job_id=?', [jobId]);
check('① 素材落进 media_assets（学生画布才看得到）', Boolean(asset?.asset_url), JSON.stringify(asset)?.slice(0, 200));
const assetMeta = String(asset?.metadata || '');
check('① 素材标了「对账找回」+ 上游任务号', assetMeta.includes('"reconciled":true') && assetMeta.includes(TASK_ID), assetMeta.slice(0, 240));

const usage = await arow('SELECT * FROM usage_records WHERE generation_job_id=? ORDER BY created_at DESC', [jobId]);
check('① 记了一条 usage', Boolean(usage?.id), JSON.stringify(usage)?.slice(0, 200));
check('⭐ 只补素材、不计费：credits_charged=0 且 cost_fen=0',
  Number(usage?.credits_charged) === 0 && Number(usage?.cost_fen) === 0,
  `credits_charged=${usage?.credits_charged} cost_fen=${usage?.cost_fen}`);
check('⭐ usage 带 reconciled 标记（报表里与正常成功可分）', String(usage?.pricing_snapshot || '').includes('"reconciled":true'), String(usage?.pricing_snapshot).slice(0, 240));

const auditRow = await arow("SELECT * FROM audit_logs WHERE action='AI_GENERATION_RECONCILED' AND target_id=?", [jobId]);
check('① 留了 AI_GENERATION_RECONCILED 审计（这是动钱的邻域，必须留痕）', Boolean(auditRow?.id), JSON.stringify(auditRow)?.slice(0, 200));

/* ────────── ② 幂等 ────────── */
console.log('\n② 再跑一次：不该重复捞');
const second = await reconcileStrandedGenerations({ jobIds: [jobId], minAgeMs: 0, log: () => {} });
check('② 已 SUCCEEDED 的不再是候选（第二次扫到 0 条）', second.scanned === 0, JSON.stringify(second));
const assetCount = Number((await arow('SELECT COUNT(*) n FROM media_assets WHERE job_id=?', [jobId]))?.n || 0);
check('② 素材没有翻倍', assetCount === 1, `实际 ${assetCount} 条`);
const usageCount = Number((await arow('SELECT COUNT(*) n FROM usage_records WHERE generation_job_id=?', [jobId]))?.n || 0);
check('② usage 没有翻倍', usageCount === 1, `实际 ${usageCount} 条`);

/* ────────── ③ 上游还在跑：什么都不动 ────────── */
console.log('\n③ 上游还在 processing：判 PENDING，不许判死');
taskState = 'processing';
const pendingOutcome = await reconcileStrandedGenerations({ jobIds: [jobIdPending], minAgeMs: 0, log: say });
check('③ 结果是 PENDING', pendingOutcome.results[0]?.state === 'PENDING', JSON.stringify(pendingOutcome));
check('③ 任务仍是 FAILED（等下一轮，不假装成功）',
  (await arow('SELECT status FROM generation_jobs WHERE id=?', [jobIdPending]))?.status === 'FAILED');
check('③ 没有落任何素材',
  Number((await arow('SELECT COUNT(*) n FROM media_assets WHERE job_id=?', [jobIdPending]))?.n || 0) === 0);

/* ────────── ④ 上游自己判失败：保持 FAILED ────────── */
console.log('\n④ 上游自己说 failed（内容安全之类）：不许假装成功');
taskState = 'failed';
const failedOutcome = await reconcileStrandedGenerations({ jobIds: [jobIdPending], minAgeMs: 0, log: say });
check('④ 结果是 FAILED', failedOutcome.results[0]?.state === 'FAILED', JSON.stringify(failedOutcome));
check('④ 任务保持 FAILED',
  (await arow('SELECT status FROM generation_jobs WHERE id=?', [jobIdPending]))?.status === 'FAILED');
check('④ 没有落素材',
  Number((await arow('SELECT COUNT(*) n FROM media_assets WHERE job_id=?', [jobIdPending]))?.n || 0) === 0);
check('④ 日志里带上了上游给的原因', logLines.some((line) => line.includes('上游判定') && line.includes('内容安全')), logLines.slice(-3).join(' | '));

/* ────────── ⑤ ⭐ 只查不提交 ────────── */
console.log('\n⑤ 只查不提交（"能查就别重发……重发会双扣"）');
const posts = seen.filter((item) => item.method !== 'GET');
check('⭐ 整轮对账对上游一个非 GET 请求都没有', posts.length === 0, JSON.stringify(posts.slice(0, 5)));
check('⭐ 查的确实是那两条任务号', seen.filter((item) => item.url.includes(TASK_ID) || item.url.includes('task_p161_pending')).length >= 2,
  JSON.stringify(seen.slice(0, 8)));

await new Promise((resolve) => { upstream.closeAllConnections?.(); upstream.close(resolve); });

console.log(JSON.stringify({
  name: 'generation-reconcile', pass: failures === 0,
  checks: { reconciled: job?.status, creditsCharged: usage?.credits_charged, costFen: usage?.cost_fen },
  upstreamRequests: seen.length, nonGetRequests: posts.length,
}, null, 2));
// ⚠️ 用 exitCode 而不是 process.exit()：Windows 上在 close() 之后硬退会撞 libuv 断言
//    （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码 127，看着像脚本崩了）。
if (failures) { console.error(`P161 失败 ${failures} 项`); process.exitCode = 1; }
