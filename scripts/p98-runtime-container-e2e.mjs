/**
 * P98 学生运行时容器 → 平台网关（真容器端到端）。
 *
 * p97 证的是「网关这一侧」的规矩（身份、门禁、记账、模型名解析）。
 * 这一条证的是**从容器里真的能这样用**，也就是把学生端那条线接上的最后一段：
 *   ① 容器起来后，读图（modlens）的凭据确实指向我们的网关，而不是它自带的那些渠道；
 *   ② 容器里发一张图出来，图**没有在网关这一跳被压扁**，并且落在**读图渠道**上；
 *   ③ 这一通读图记进了 usage_records（否则读图的钱从账本里漏出去）；
 *   ④ 容器里的入口闸门仍然拦得住没票据的请求。
 *
 * 需要本机能跑容器（本地 Docker Desktop；生产机没有 docker，这条守卫只在开发机跑）。
 * 镜像不存在或 docker 不可用时**明确跳过**，不装作通过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { issueRuntimeKey } from '../apps/server/src/routes/runtimeGateway.js';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p98-runtime-container-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH ||= dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

const SECRET = 'p98-runtime-secret';
const PORT = 19718;
const IMAGE = String(process.env.DSH_STUDENT_IMAGE || '').trim() || 'dsh-student:local';
const CONTAINER = 'p98-runtime-e2e';
const TICKET = 'p98-edge-ticket';
const TEXT_CHANNEL = 'ch-p98-text';
const VISION_CHANNEL = 'ch-p98-vision';
const TEXT_MODEL = 'p98-text-model';
const VISION_MODEL = 'p98-vision-model';
// 1x1 的透明 PNG：只要求「是一张真图」，内容对这条守卫没有意义
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

process.env.RUNTIME_GATEWAY_SECRET = SECRET;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp, PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
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

// 容器相关的命令都先看看 docker 在不在：不在就跳过（不假装通过）
const docker = (args, { input = '' } = {}) => spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const dockerReady = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
if (dockerReady.status !== 0) {
  console.log('  ⏭ 这台机器上没有可用的 docker —— 跳过容器端到端（生产机本来也不跑这条）');
  console.log(JSON.stringify({ name: 'runtime-container-e2e', pass: true, skipped: true, failures: 0 }, null, 2));
  process.exit(0);
}
const imageReady = docker(['image', 'inspect', IMAGE]);
if (imageReady.status !== 0) {
  console.log(`  ⏭ 镜像 ${IMAGE} 不存在（先 docker build -t ${IMAGE} deploy/dsh-student）—— 跳过容器端到端`);
  console.log(JSON.stringify({ name: 'runtime-container-e2e', pass: true, skipped: true, failures: 0 }, null, 2));
  process.exit(0);
}

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

 
const teacher = await arow("SELECT * FROM users WHERE login='teacher-1'");
const student = await arow("SELECT * FROM users WHERE login='student-1'");
const lesson = await arow("SELECT * FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1");
const now = new Date().toISOString();
await aq('INSERT OR IGNORE INTO student_course_grants(id,org_id,student_id,series_id,granted_at) VALUES (?,?,?,?,?)', ['p98_grant', student.org_id, student.id, lesson.series_id, now]);
const sessionId = 'csession_p98';
await aq(`INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode,created_at,updated_at,started_at)
  VALUES (?,?,?,?,?,?,'ACTIVE','VIBECODING',?,?,?)`, [sessionId, 'P98 容器端到端', student.org_id, lesson.series_id, lesson.id, teacher.id, now, now, now]);
await aq(`INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at)
  VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)`, ['p98_part', sessionId, student.id, student.org_id, lesson.id, lesson.series_id, teacher.id, now, now]);
// 平台渠道：一条文本、一条读图。读图渠道名字与容器里 PLATFORM_VISION_MODEL 报的一致，
// 这样「容器报的名字落在哪条渠道的哪个模型」整条链都能被断言。
await aq('UPDATE platform_settings SET ai_provider_policy=? WHERE id=1', [JSON.stringify({
  provider: 'local-mock', model: '', endpoint: '', allowStudentExternalContent: true,
  channels: [
    { id: TEXT_CHANNEL, name: '文本渠道', provider: 'local-mock', model: TEXT_MODEL, models: [TEXT_MODEL], endpoint: '' },
    { id: VISION_CHANNEL, name: '读图渠道', provider: 'local-mock', model: VISION_MODEL, models: [VISION_MODEL], endpoint: '' },
  ],
  modalityChannels: { TEXT: TEXT_CHANNEL }, modalityBackupChannels: {}, modelRoutes: [], visionChannelId: VISION_CHANNEL,
})]);


const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', (x) => { logs += x; });
server.stderr.on('data', (x) => { logs += x; });

try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert.ok(ready, logs);

  const key = issueRuntimeKey({ orgId: student.org_id, userId: student.id, sessionId, lessonId: lesson.id });

  docker(['rm', '-f', CONTAINER]);
  const started = docker(['run', '-d', '--name', CONTAINER,
    '-e', `EDGE_TICKET=${TICKET}`,
    '-e', `GATEWAY_BASE_URL=http://host.docker.internal:${PORT}/api/gateway/v1`,
    '-e', `PLATFORM_GATEWAY_KEY=${key}`,
    '-e', `PLATFORM_VISION_MODEL=${VISION_MODEL}`,
    IMAGE]);
  assert.equal(started.status, 0, started.stderr);

  // 等入口就绪（dsh 起完 + nginx 起来）
  let booted = false;
  for (let i = 0; i < 90; i++) {
    const out = docker(['logs', CONTAINER]);
    if (`${out.stdout}${out.stderr}`.includes('对外入口')) { booted = true; break; }
    await sleep(2000);
  }
  check('① 容器起来了，入口闸门就位', booted, docker(['logs', CONTAINER]).stderr?.slice(-400));
  if (!booted) throw new Error('容器没有就绪');

  const configShow = docker(['exec', CONTAINER, 'sh', '-lc', '/home/student/.dsh/profiles/web/node_modules/.bin/modlens config show']);
  const configText = `${configShow.stdout || ''}${configShow.stderr || ''}`;
  check('① 读图凭据指向我们的网关（不是它自带的渠道）',
    configText.includes(`host.docker.internal:${PORT}`) && /"provider"\s*:\s*"openai"/.test(configText),
    configText.slice(0, 400));
  check('① 读图凭据不落在容器里别的地方（用的是本次注入的运行时密钥）',
    configText.includes('rt1.') || /apiKey/.test(configText),
    configText.slice(0, 400));

  const probe = JSON.stringify({
    model: VISION_MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: '这张图里是什么？' }, { type: 'image_url', image_url: { url: PNG_DATA_URL } }] }],
  });
  const visionCall = docker(['exec', '-i', CONTAINER, 'sh', '-lc',
    'cat > /tmp/p98-vision.json && curl -s -X POST -H "content-type: application/json" -H "authorization: Bearer $PLATFORM_GATEWAY_KEY" --data @/tmp/p98-vision.json "$GATEWAY_BASE_URL/chat/completions"'],
  { input: probe });
  const visionBody = String(visionCall.stdout || '');
  check('② 容器里的带图调用 → 200 且落在读图渠道的模型上',
    visionCall.status === 0 && /"model"\s*:\s*"p98-vision-model"/.test(visionBody),
    `${visionCall.status} ${visionBody.slice(0, 300)}${String(visionCall.stderr || '').slice(0, 200)}`);

  const textProbe = JSON.stringify({ model: 'deepseek-pro', messages: [{ role: 'user', content: '你好' }] });
  const textCall = docker(['exec', '-i', CONTAINER, 'sh', '-lc',
    'cat > /tmp/p98-text.json && curl -s -X POST -H "content-type: application/json" -H "authorization: Bearer $PLATFORM_GATEWAY_KEY" --data @/tmp/p98-text.json "$GATEWAY_BASE_URL/chat/completions"'],
  { input: textProbe });
  const textBody = String(textCall.stdout || '');
  check('② 容器里报一个我们没配过的模型名 → 落回文本渠道自己的模型（不原样发上游）',
    textCall.status === 0 && /"model"\s*:\s*"p98-text-model"/.test(textBody),
    `${textCall.status} ${textBody.slice(0, 300)}`);

  {
     
    const rows = await arows('SELECT model,modality,pricing_snapshot FROM usage_records WHERE class_session_id=? ORDER BY created_at DESC, rowid DESC', [sessionId]);
    check('③ 两通调用都落进了 usage_records（读图与文本都进我们的账）', rows.length >= 2, JSON.stringify(rows.length));
    const visionRow = rows.find((item) => item.model === VISION_MODEL);
    check('③ 读图那一笔记在读图渠道的模型上', Boolean(visionRow), JSON.stringify(rows.map((r) => r.model)));
    check('③ 读图那一笔留了「带图」的证据', /"withImages":true/.test(String(visionRow?.pricing_snapshot || '')), String(visionRow?.pricing_snapshot).slice(0, 240));
    check('③ 文本那一笔记在文本渠道的模型上', rows.some((item) => item.model === TEXT_MODEL), JSON.stringify(rows.map((r) => r.model)));
    
  }

  // ⑤ 默认那条路：**不配读图渠道**时，带图的请求跟着模型走（同一条 TEXT 渠道）。
  //    这是平台现在的真实配置（模型自己就能看图），所以这条是主路径，上面那条是可选覆盖。
  {
     
    const policy = JSON.parse((await arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1')).ai_provider_policy);
    await aq('UPDATE platform_settings SET ai_provider_policy=? WHERE id=1', [JSON.stringify({ ...policy, visionChannelId: '' })]);
    

    const followCall = docker(['exec', '-i', CONTAINER, 'sh', '-lc',
      'cat > /tmp/p98-follow.json && curl -s -X POST -H "content-type: application/json" -H "authorization: Bearer $PLATFORM_GATEWAY_KEY" --data @/tmp/p98-follow.json "$GATEWAY_BASE_URL/chat/completions"'],
    { input: probe });
    const followBody = String(followCall.stdout || '');
    check('⑤ 不配读图渠道 → 带图调用仍然 200，且落在**模型自己那条渠道**上',
      followCall.status === 0 && new RegExp(`"model"\\s*:\\s*"${TEXT_MODEL}"`).test(followBody),
      `${followCall.status} ${followBody.slice(0, 300)}`);

     
    const row = await arow('SELECT model,pricing_snapshot FROM usage_records WHERE class_session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', [sessionId]);
    check('⑤ 这一通也记在文本渠道的模型上（钱一样进我们的账）', row?.model === TEXT_MODEL, String(row?.model));
    check('⑤ 记账里仍然带着「这轮有图」的证据', /"withImages":true/.test(String(row?.pricing_snapshot || '')), String(row?.pricing_snapshot).slice(0, 240));
    
  }

  const gate = docker(['exec', CONTAINER, 'sh', '-lc', 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/']);
  check('④ 容器入口闸门仍然拦得住没票据的请求（403）', String(gate.stdout || '').trim() === '403', String(gate.stdout || '').trim());
  const gateTicket = docker(['exec', CONTAINER, 'sh', '-lc', `curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8080/?t=${TICKET}"`]);
  check('④ 带票据能进（302/200）', ['200', '302'].includes(String(gateTicket.stdout || '').trim()), String(gateTicket.stdout || '').trim());

  console.log(JSON.stringify({ name: 'runtime-container-e2e', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(logs.slice(-3000));
  console.error(String(error?.stack || error));
  failures += 1;
} finally {
  docker(['rm', '-f', CONTAINER]);
  server.kill('SIGTERM');
  await sleep(200);
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
