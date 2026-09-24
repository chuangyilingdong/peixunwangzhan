/**
 * P99 平台侧拉起学生创作环境（真容器）。
 *
 * 这条守卫证的是主线里「发盒子」那一段：**平台自己**就能给学生开一台盒子、
 * 给出学生该访问的入口，而且门禁与「调模型」那条路是同一套。
 *
 * 用例：
 *   ① 学生在名单里、课堂进行中 → 开盒子成功，容器真起来了，入口带票据能进（无票据 403）
 *   ② 盒子里的模型调用仍然走我们的网关（用平台刚签的那把密钥）
 *   ③ 课堂结束后 → **开不出来**（门禁不过，不留下一个没人管的盒子）
 *   ④ 学生不在名单里 → 同样开不出来
 *   ⑤ 收盒子 → 容器真的没了
 *
 * 需要本机能跑容器（本地 Docker Desktop；生产机上就是那台机器本身）。
 * 没有 docker / 没有镜像 / 宿主脚本不在 → **明确跳过**，不装作通过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p99-student-runtime-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
const SECRET = 'p99-runtime-secret';
const PORT = 19719;
const IMAGE = String(process.env.DSH_STUDENT_IMAGE || '').trim() || 'dsh-student:local';
const LAUNCH_SCRIPT = path.join(root, 'deploy', 'dsh-student', 'host', 'run-student-container.sh');
const STOP_SCRIPT = path.join(root, 'deploy', 'dsh-student', 'host', 'stop-student-container.sh');

let failures = 0;
const skip = (why) => {
  console.log(`  ⏭ ${why} —— 跳过「平台侧拉起」这条守卫`);
  console.log(JSON.stringify({ name: 'student-runtime-launch', pass: true, skipped: true, failures: 0 }, null, 2));
  process.exit(0);
};
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

if (spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status !== 0) skip('这台机器上没有可用的 docker');
if (spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' }).status !== 0) skip(`镜像 ${IMAGE} 不存在（先 docker build -t ${IMAGE} deploy/dsh-student）`);

// 门禁函数读的是进程环境里的 RUNTIME_GATEWAY_SECRET（签发密钥用），这里与将要拉起的服务保持一致。
// ⚠️ 库路径也必须在本进程里设：服务模块是在**本进程**里 import 的（不是被拉起的服务进程），
// lib.js 在 import 期就解析库路径 —— 不设的话它查的是仓库那份库（踩过：报「学生不属于该机构」，
// 因为仓库库里的 student-1 属于另一个机构）。
process.env.RUNTIME_GATEWAY_SECRET = SECRET;
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

// 这条守卫测的是**容器版**宿主脚本（本机有 docker）；用户版要 root 与 nginx，跑在真机上
// （见 deploy/dsh-student/host-user/ 与真机验证记录）。
process.env.DSH_RUNTIME_MODE = 'container';
process.env.DSH_RUNTIME_SUDO = 'false';
process.env.DSH_RUNTIME_LAUNCH_SCRIPT = LAUNCH_SCRIPT;
process.env.DSH_RUNTIME_STOP_SCRIPT = STOP_SCRIPT;
process.env.DSH_RUNTIME_GATEWAY_URL = `http://host.docker.internal:${PORT}/api/gateway/v1`;
process.env.DSH_RUNTIME_EDGE_BASE = ''; // 本机验证：入口直接给宿主端口（生产才走 nginx 的 /dsh/）

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
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
const docker = (args) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

 
const teacher = await arow("SELECT * FROM users WHERE login='teacher-1'");
const student = await arow("SELECT * FROM users WHERE login='student-1'");
const lesson = await arow("SELECT * FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1");
const now = new Date().toISOString();
await aq('INSERT OR IGNORE INTO student_course_grants(id,org_id,student_id,series_id,granted_at) VALUES (?,?,?,?,?)', ['p99_grant', student.org_id, student.id, lesson.series_id, now]);
const sessionId = 'csession_p99';
await aq(`INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode,created_at,updated_at,started_at)
  VALUES (?,?,?,?,?,?,'ACTIVE','VIBECODING',?,?,?)`, [sessionId, 'P99 平台侧拉起', student.org_id, lesson.series_id, lesson.id, teacher.id, now, now, now]);
await aq(`INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at)
  VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)`, ['p99_part', sessionId, student.id, student.org_id, lesson.id, lesson.series_id, teacher.id, now, now]);
await aq('UPDATE platform_settings SET ai_provider_policy=? WHERE id=1', [JSON.stringify({
  provider: 'local-mock', model: '', endpoint: '', allowStudentExternalContent: true,
  channels: [{ id: 'ch-t', name: '文本渠道', provider: 'local-mock', model: 'p99-text', models: ['p99-text'], endpoint: '' }],
  modalityChannels: { TEXT: 'ch-t' }, modalityBackupChannels: {}, modelRoutes: [], visionChannelId: '',
})]);


const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', (x) => { logs += x; });
server.stderr.on('data', (x) => { logs += x; });
let containerName = '';

try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert.ok(ready, logs);

  // 直接用服务层（与 HTTP 路由调用的是同一个函数）；路由那一层的鉴权在下面用未登录请求证明
  const { launchStudentRuntime, stopStudentRuntime } = await import('../apps/server/src/services/studentRuntime.js');

  // 未登录访问路由 → 401（证明路由挂上了、并且受保护）
  const unauth = await fetch(`http://127.0.0.1:${PORT}/api/student/runtime/status`);
  check('路由已挂上且未登录不可用（401/403）', [401, 403].includes(unauth.status), `实际 ${unauth.status}`);

  // ① 开盒子
  const launched = await launchStudentRuntime({ sessionId, studentId: student.id, orgId: student.org_id, lessonId: lesson.id });
  containerName = launched.containerName;
  check('① 平台开盒子成功，拿到容器名与端口', Boolean(containerName) && launched.hostPort > 0, JSON.stringify({ containerName, hostPort: launched.hostPort }));
  check('① 容器真的在跑', docker(['inspect', '-f', '{{.State.Running}}', containerName]).stdout.trim() === 'true', docker(['inspect', '-f', '{{.State.Status}}', containerName]).stderr?.slice(0, 200));

  // 等入口就绪，再验闸门
  let booted = false;
  for (let i = 0; i < 60; i++) {
    if (`${docker(['logs', containerName]).stdout}${docker(['logs', containerName]).stderr}`.includes('对外入口')) { booted = true; break; }
    await sleep(2000);
  }
  check('① 盒子里的入口起来了', booted);
  const noTicket = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '10', `http://127.0.0.1:${launched.hostPort}/`], { encoding: 'utf8' }).stdout.trim();
  check('① 没有票据进不去（403）', noTicket === '403', noTicket);
  const withTicket = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '10', launched.edgeUrl], { encoding: 'utf8' }).stdout.trim();
  check('① 平台给的那个入口地址带票据能进（200/302）', ['200', '302'].includes(withTicket), withTicket);

  // ② 盒子里的模型调用仍然走我们的网关（用平台刚签的那把密钥）
  const probe = `{"model":"deepseek-flash","messages":[{"role":"user","content":[{"type":"text","text":"这张图是什么"}]}]}`;
  const call = spawnSync('docker', ['exec', '-i', containerName, 'sh', '-lc',
    'cat > /tmp/p99.json && curl -s -X POST -H "content-type: application/json" -H "authorization: Bearer $PLATFORM_GATEWAY_KEY" --data @/tmp/p99.json "$GATEWAY_BASE_URL/chat/completions"'],
  { input: probe, encoding: 'utf8' });
  check('② 盒子里的调用走我们的网关（回复里是我们渠道的模型）', /"model"\s*:\s*"p99-text"/.test(String(call.stdout || '')), String(call.stdout || '').slice(0, 200));

  // ③④ 门禁不过就开不出来
  {
     
    await aq("UPDATE class_sessions SET status='ENDED', ended_at=? WHERE id=?", [now, sessionId]);
    
    let code = '';
    try { await launchStudentRuntime({ sessionId, studentId: student.id, orgId: student.org_id, lessonId: lesson.id }); } catch (error) { code = error.code || ''; }
    check('③ 课堂已结束 → 开不出来（RUNTIME_CLASSROOM_INACTIVE）', code === 'RUNTIME_CLASSROOM_INACTIVE', code);
  }
  {
     
    await aq("UPDATE class_sessions SET status='ACTIVE' WHERE id=?", [sessionId]);
    await aq("UPDATE session_students SET status='REMOVED', removed_reason='P99' WHERE id='p99_part'");
    
    let code = '';
    try { await launchStudentRuntime({ sessionId, studentId: student.id, orgId: student.org_id, lessonId: lesson.id }); } catch (error) { code = error.code || ''; }
    check('④ 学生被移出名单 → 开不出来（RUNTIME_STUDENT_NOT_ACTIVE）', code === 'RUNTIME_STUDENT_NOT_ACTIVE', code);
  }

  // ⑤ 收盒子
  const stopped = await stopStudentRuntime({ sessionId, studentId: student.id });
  check('⑤ 收盒子有回执', Array.isArray(stopped.output), JSON.stringify(stopped.output));
  const gone = docker(['inspect', '-f', '{{.State.Status}}', containerName]);
  check('⑤ 容器真的没了', gone.status !== 0, String(gone.stdout || gone.stderr).slice(0, 160));

  console.log(JSON.stringify({ name: 'student-runtime-launch', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(logs.slice(-2500));
  console.error(String(error?.stack || error));
  failures += 1;
} finally {
  if (containerName) docker(['rm', '-f', containerName]);
  server.kill('SIGTERM');
  await sleep(200);
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
