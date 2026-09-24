/**
 * P100 学生创作环境：**把作品交上来**（dsh 的产物 → 现有作品链路）。
 *
 * 这条守卫证的是主线里「取产物 + 落库」那一段。它分两半，两半都跑真东西：
 *
 *   ① 宿主侧的产物逻辑（deploy/dsh-student/host-user/collect-student.mjs）**直接跑**：
 *      列清单、取一份、拍平改写、留存，以及**对抗性用例** —— 越界（`../`）、绝对路径、
 *      符号链接、超限、非白名单主产物。这一段是 root 在跑、取回的东西最终会给学生下载，
 *      所以每一条拒绝都必须被测到（这一段跨平台，不依赖 bash/nginx）。
 *   ② 平台侧两个接口（列产物 / 交作品）：用**桩宿主脚本**把真实的 collect-student.mjs 接上，
 *      于是平台 → 脚本 → 产物逻辑 → 落库整条链是真的；只有「课堂+学生 → 哪个工作区」这一步是桩。
 *      验的是：门禁（没在课堂上就不给看/不给交）、版权确认、拍平后的入口与文件名、
 *      本地图片变成私有资产并改写引用、产物快照定格、重复提交 round+1、
 *      **二进制主产物（真 pptx）被明确拒绝**（现在的作品链路只吃规格文本）。
 *
 * 需要 bash 才能跑第 ② 半（宿主脚本的调用约定就是 bash）；没有就**明确跳过**第 ② 半，
 * 不装作通过。用临时 SQLite，不碰默认库与生产库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ensureClassroom, switchClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p100-runtime-deliverables-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

const workspace = path.join(temp, 'workspace');
const collectScript = path.join(root, 'deploy', 'dsh-student', 'host-user', 'collect-student.mjs');
const PORT = 19841;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** 跑一次 collect-student.mjs（直接跑，不经 bash），拿到它 stdout 的 JSON。 */
const collect = (args, env = {}) => {
  const result = spawnSync(process.execPath, [collectScript, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COLLECT_WORKSPACE: workspace, ...env },
  });
  return { status: result.status, json: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })(), stderr: result.stderr || '' };
};

/* ────────────────────────── 夹具：一个学生的工作区 ────────────────────────── */
fs.mkdirSync(path.join(workspace, 'mygame', 'assets'), { recursive: true });
fs.mkdirSync(path.join(workspace, 'deck'), { recursive: true });
fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
fs.mkdirSync(path.join(workspace, '.cache'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'index.html'),
  '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>'
  + '<body><h1>我的游戏</h1><img src="hero.png"></body></html>');
fs.writeFileSync(path.join(workspace, 'style.css'), 'body{color:#333}\n');
// 一个真的 PNG（魔术字节要对得上，平台侧的 persistSecureUpload 会验）
fs.writeFileSync(path.join(workspace, 'hero.png'),
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]));
fs.writeFileSync(path.join(workspace, 'mygame', 'index.html'),
  '<!doctype html><html><body><img src="assets/hero.png"></body></html>');
fs.writeFileSync(path.join(workspace, 'mygame', 'assets', 'hero.png'),
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 3)]));
// 二进制主产物：dsh 的 PPT 插件产出的就是这种真 .pptx
fs.writeFileSync(path.join(workspace, 'deck', '演示文稿.pptx'),
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(48, 1)]));
fs.writeFileSync(path.join(workspace, 'node_modules', 'lib.html'), '<p>噪声</p>');
fs.writeFileSync(path.join(workspace, '.cache', 'hidden.html'), '<p>噪声</p>');

let symlinkWorks = true;
try {
  fs.symlinkSync(path.join(temp, 'outside.html'), path.join(workspace, 'escape.html'));
  fs.writeFileSync(path.join(temp, 'outside.html'), '<p>工作区之外</p>');
} catch { symlinkWorks = false; }

console.log('\n【一】宿主侧的产物逻辑（跑的是真脚本）');

/* 1. 列清单：该看到的看到、噪声排除、符号链接被点名 */
{
  const listed = collect(['list']);
  const names = (listed.json?.deliverables || []).map((item) => item.name).sort();
  check('列清单能拿到工作区里的三份产物', listed.status === 0 && names.join(',') === 'deck/演示文稿.pptx,index.html,mygame/index.html',
    `实际 ${JSON.stringify(names)}`);
  check('node_modules 与隐藏目录里的东西不算产物', !names.some((name) => name.includes('node_modules') || name.startsWith('.')));
  check('根目录的 index.html 被标成推荐入口', (listed.json?.deliverables || []).some((item) => item.name === 'index.html' && item.recommended === true));
  if (symlinkWorks) {
    check('符号链接在清单里被点名（SYMLINK），不当成产物', (listed.json?.skipped || []).some((item) => item.name === 'escape.html' && item.reason === 'SYMLINK'),
      `skipped=${JSON.stringify(listed.json?.skipped)}`);
  } else {
    console.log('  ⏭ 这个平台建不了符号链接 —— 跳过符号链接这条用例');
  }
}

/* 2. 取一份：素材跟着主产物一起来，且引用按主产物所在目录解析 */
{
  const exported = collect(['export', 'index.html']);
  const names = (exported.json?.files || []).map((file) => file.name).sort();
  check('取 index.html 时把同目录素材一起带回来', exported.status === 0 && names.join(',') === 'hero.png,index.html,style.css',
    `实际 ${JSON.stringify(names)}`);
  check('二进制素材走 base64、文本走 utf8',
    (exported.json?.files || []).every((file) => (file.binary ? file.encoding === 'base64' : file.encoding === 'utf8')));
}

/* 3. 拍平 + 引用改写：嵌套作品也能进「只认同层文件」的作品链路 */
{
  const exported = collect(['export', 'mygame/index.html']);
  const files = exported.json?.files || [];
  check('嵌套作品被拍平成同层文件（入口 index.html + 素材 hero.png）',
    files.map((file) => file.name).sort().join(',') === 'hero.png,index.html', `实际 ${JSON.stringify(files.map((f) => f.name))}`);
  const html = files.find((file) => file.name === 'index.html')?.content || '';
  check('HTML 里的引用被一起改写（assets/hero.png → hero.png）', html.includes('src="hero.png"'), html);
  check('拍平改了名字这件事被报出来（renamed/warnings）',
    (exported.json?.renamed || []).length === 2 && (exported.json?.warnings || []).length >= 1);
}

/* 4. 对抗性用例：越界、绝对路径、符号链接、超限、非白名单主产物 —— 每一条都必须被拒 */
{
  const traversal = collect(['export', '../../etc/shadow']);
  check('`../` 越界被拒（COLLECT_BAD_NAME）', traversal.status !== 0 && traversal.stderr.includes('COLLECT_BAD_NAME'), traversal.stderr.trim());
  const absolute = collect(['export', '/etc/shadow']);
  check('绝对路径被拒（COLLECT_BAD_NAME）', absolute.status !== 0 && absolute.stderr.includes('COLLECT_BAD_NAME'), absolute.stderr.trim());
  const wrongKind = collect(['export', 'style.css']);
  check('不是网页/PPT/Word/Excel 的主产物被拒（COLLECT_NOT_SUBMITTABLE）',
    wrongKind.status !== 0 && wrongKind.stderr.includes('COLLECT_NOT_SUBMITTABLE'), wrongKind.stderr.trim());
  const oversize = collect(['list'], { COLLECT_MAX_FILE_BYTES: '100' });
  check('超过单文件上限的产物被点名（TOO_LARGE）而不是悄悄少给',
    (oversize.json?.skipped || []).some((item) => item.reason === 'TOO_LARGE'), `skipped=${JSON.stringify(oversize.json?.skipped)}`);
  if (symlinkWorks) {
    const linked = collect(['export', 'escape.html']);
    check('符号链接被拒（COLLECT_SYMLINK）', linked.status !== 0 && linked.stderr.includes('COLLECT_SYMLINK'), linked.stderr.trim());
  }
}

/* 5. 留存：收环境前把产物留一份（家目录删了作品还在） */
{
  const preserveRoot = path.join(temp, 'preserved');
  const preserved = collect(['preserve'], { COLLECT_PRESERVE_ROOT: preserveRoot });
  const saved = preserved.json?.saved || [];
  check('留存把三份产物都写到了工作区之外', preserved.status === 0 && saved.length === 3 && !saved.some((item) => item.error), JSON.stringify(saved));
  const dir = preserved.json?.directory || '';
  check('留存件里有清单（INDEX.json）与每份的来源信息（MANIFEST.json）',
    fs.existsSync(path.join(dir, 'INDEX.json')) && fs.existsSync(path.join(dir, 'index.html', 'MANIFEST.json')));
}

/* ─────────────── 特权代理的校验（broker-policy.mjs，纯函数，跨平台可测） ─────────────── */
// 这一段是补出来的：真机上 PPT 一提交就报「name 不合法（必须是工作区内的相对路径）」，
// 因为我写的名字模式**不允许斜杠**，而平台传的正是工作区相对路径。
// 校验逻辑不该只能靠真机试出来，所以把它抽成纯函数并在守卫里逐条钉住。
console.log('\n【一·补】特权代理的校验与参数拼装');
{
  const { buildRequestPlan } = await import(pathToFileURL(path.join(root, 'deploy', 'dsh-student', 'host-user', 'broker-policy.mjs')).href);
  const scripts = { launch: '/s/launch.sh', stop: '/s/stop.sh', collect: '/s/collect.sh' };
  const timeouts = { launch: 1, stop: 2, collect: 3 };
  const plan = (request) => {
    try { return { ok: true, plan: buildRequestPlan(request, scripts, timeouts) }; }
    catch (error) { return { ok: false, message: error.message }; }
  };
  const base = { session: 'csession_1', student: 'user_1' };

  // 该放行的：工作区相对路径（就是会有斜杠）
  for (const name of ['index.html', 'deck/演示文稿.pptx', 'mygame/assets/hero.png']) {
    const result = plan({ ...base, op: 'collect', mode: 'export', name });
    check(`相对路径要放行：${name}`, result.ok && result.plan.args.at(-1) === name, JSON.stringify(result));
  }
  // 该拒的：越界、绝对、反斜杠、以 - 开头
  for (const [label, name] of [
    ['`..` 越界', '../../etc/shadow'],
    ['路径中间夹 `..`', 'a/../../b'],
    ['绝对路径', '/etc/shadow'],
    ['反斜杠', 'a\\b'],
    ['以 - 开头', '-rf'],
    ['NUL', 'a\u0000b'],
  ]) {
    const result = plan({ ...base, op: 'collect', mode: 'export', name });
    check(`产物名要拒（${label}）`, !result.ok, JSON.stringify(result));
  }
  // 未知 op / 带 - 的参数值 / 不合法的会话标识
  check('未知 op 要拒', !plan({ ...base, op: 'shell', cmd: 'id' }).ok);
  check('参数值以 - 开头要拒（会被脚本当成选项）',
    !plan({ ...base, op: 'launch', key: '--help', gateway: 'g', ticket: 't' }).ok);
  check('会话标识里的怪字符要拒', !plan({ op: 'stop', session: 'a b', student: 'user_1' }).ok);
  check('list 不传 name 也能拼出计划', plan({ ...base, op: 'collect', mode: 'list' }).ok);
}

const bashWorks = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' }).status === 0;
if (!bashWorks) {
  console.log('  ⏭ 这台机器上没有可用的 bash —— 跳过平台侧接口那一半（宿主脚本的调用约定就是 bash）');
  console.log(JSON.stringify({ name: 'student-runtime-deliverables', pass: failures === 0, skipped: 'platform-half', failures }, null, 2));
  process.exit(failures === 0 ? 0 : 1);
}

console.log('\n【二】平台侧：列产物 / 交作品（产物逻辑是真的，只有「课堂+学生 → 工作区」是桩）');
// 桩：把平台的调用原样转给真的 collect-student.mjs，工作区固定成夹具。
//
// ⚠️ 桩要复刻 collect-student-user.sh 的**参数契约**：平台按 `--session X --student Y --list`
// 调 .sh，由那个 .sh 翻译成 .mjs 的子命令形式。这一层在真机上由真脚本承担（已验证）；
// 本机没有 root 与那些 Linux 学生用户，所以这里用一个桩把契约照抄一遍，好让「平台 → 脚本 → 产物逻辑」
// 这一段在本机也能真跑。脚本里那份**翻译逻辑本身**本机测不到 —— 它属于真机验证的范围。
// ⚠️ 路径一律转成正斜杠：runScript 是用 `bash <脚本>` 调的，Windows 风格的反斜杠会被 bash 当转义吃掉。
const slash = (value) => value.split(path.sep).join('/');
const stub = path.join(temp, 'stub-collect.sh');
fs.writeFileSync(stub, `#!/usr/bin/env bash
set -euo pipefail
export COLLECT_WORKSPACE="${slash(workspace)}"
COMMAND=""; TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) COMMAND="list"; shift ;;
    --export) COMMAND="export"; TARGET="\${2:-}"; shift 2 ;;
    --preserve) COMMAND="preserve"; shift ;;
    *) shift ;;
  esac
done
if [ -n "\${TARGET}" ]; then
  exec "${slash(process.execPath)}" "${slash(collectScript)}" "\${COMMAND}" "\${TARGET}"
fi
exec "${slash(process.execPath)}" "${slash(collectScript)}" "\${COMMAND}"
`);

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
  DSH_RUNTIME_MODE: 'user',
  DSH_RUNTIME_SUDO: 'false',
  DSH_RUNTIME_ENABLED: 'true',
  // 本机没有 dsh-host-broker（生产走的是那条特权代理 socket），这里明确用「脚本」通道，
  // 于是能用一个桩脚本把「平台 → 脚本 → 产物逻辑 → 落库」整条链真跑一遍。
  DSH_RUNTIME_TRANSPORT: 'script',
  DSH_RUNTIME_COLLECT_SCRIPT: stub.split(path.sep).join('/'),
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
{
   
  const lesson = await arow('SELECT id FROM course_lessons ORDER BY sort LIMIT 1');
  await aq("UPDATE course_lessons SET delivery_mode='VIBECODING' WHERE id=?", [lesson.id]);
  await aq("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))", [lesson.id]);
  
}

const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root, env: { ...baseEnv, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
};

try {
  const deadline = Date.now() + 30000;
  for (;;) {
    try { const res = await fetch(`http://127.0.0.1:${PORT}/health`); if (res.ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-800)}`);
    await sleep(150);
  }

  const login = async (l, p) => (await api('/api/auth/login', { method: 'POST', body: { login: l, password: p } })).data.token;
  // 先**没有**课堂：门禁应当拦住一切（这是「没被老师排进课就进不去」那条口径）
   
  const anyStudent = await arow("SELECT login FROM users WHERE role='STUDENT' AND deleted_at IS NULL ORDER BY created_at LIMIT 1");
  
  const coldToken = await login(anyStudent.login, 'study123');
  const coldList = await api('/api/student/runtime/deliverables', { token: coldToken });
  check('没在课堂上时列产物被拒（RUNTIME_NO_ACTIVE_CLASSROOM）',
    coldList.status === 403 && coldList.data?.error?.code === 'RUNTIME_NO_ACTIVE_CLASSROOM', JSON.stringify(coldList.data));

  // 放进课堂（夹具覆盖所有有许可的学生）
  await ensureClassroom(dbPath);
  await switchClassroom(dbPath, { deliveryMode: 'VIBECODING' });
   
  const enrolled = await arow(`SELECT student.login, lesson.id AS lesson_id FROM session_students part
       JOIN class_sessions session ON session.id = part.session_id AND session.status='ACTIVE'
       JOIN users student ON student.id = part.student_id
       JOIN course_lessons lesson ON lesson.id = session.lesson_id
      WHERE part.status='ACTIVE' ORDER BY student.created_at LIMIT 1`);
  
  assert.ok(enrolled?.login, '夹具没把任何学生放进课堂 —— 后面的用例没有意义');
  const token = await login(enrolled.login, 'study123');

  const listed = await api('/api/student/runtime/deliverables', { token });
  check('在课堂上能列产物，三份都在',
    listed.status === 200 && (listed.data?.deliverables || []).length === 3, JSON.stringify(listed.data).slice(0, 200));

  const noConfirm = await api('/api/student/runtime/submit', { method: 'POST', token, body: { name: 'index.html' } });
  check('未确认版权必须被拒（WORK_COPYRIGHT_CONFIRMATION_REQUIRED）',
    noConfirm.status === 400 && noConfirm.data?.error?.code === 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED', JSON.stringify(noConfirm.data));

  const binaryEntry = await api('/api/student/runtime/submit', { method: 'POST', token, body: { name: 'deck/演示文稿.pptx', copyrightConfirmed: true } });
  check('二进制主产物（真 pptx）能交上来，入口拍平', binaryEntry.status === 200 && binaryEntry.data?.entryFile === '演示文稿.pptx',
    JSON.stringify(binaryEntry.data).slice(0, 300));
  check('真文件产物不进 files（它按 fileId 存在快照里）',
    Object.keys(binaryEntry.data?.files || {}).length === 0, JSON.stringify(Object.keys(binaryEntry.data?.files || {})));
  const binaryArtifact = (binaryEntry.data?.artifacts || []).find((item) => item.name === '演示文稿.pptx');
  check('快照里记下了这份真文件的 fileId', Boolean(binaryArtifact?.fileId), JSON.stringify(binaryArtifact));
  check('主产物预览仍是文档（广场卡片靠它决定怎么展示）',
    binaryEntry.data?.preview?.document === true && binaryEntry.data?.preview?.kind === 'pptx', JSON.stringify(binaryEntry.data?.preview));

  const submitted = await api('/api/student/runtime/submit', {
    method: 'POST', token, body: { name: 'mygame/index.html', title: '嵌套作品', copyrightConfirmed: true },
  });
  check('交作品成功且入口被拍平', submitted.status === 200 && submitted.data?.entryFile === 'index.html', JSON.stringify(submitted.data).slice(0, 300));
  check('落库的文件名全是同层的（作品链路只认这个）',
    Object.keys(submitted.data?.files || {}).length > 0 && Object.keys(submitted.data?.files || {}).every((name) => !name.includes('/')),
    JSON.stringify(Object.keys(submitted.data?.files || {})));
  check('二进制素材不进 files（它走私有资产 + 引用改写，与老链路的配图同一套）',
    !Object.hasOwn(submitted.data?.files || {}, 'hero.png'), JSON.stringify(Object.keys(submitted.data?.files || {})));
  const html = submitted.data?.files?.['index.html'] || '';
  check('本地图片被存成私有资产并改写了引用',
    /src="\/api\/student\/file-assets\/[^"]+\/download"/.test(html), html.slice(0, 200));
  const entryArtifact = (submitted.data?.artifacts || []).find((item) => item.name === 'index.html');
  check('产物快照里定格了图片引用（广场发布要靠它准入图片）', (entryArtifact?.embeddedImages || []).length === 1, JSON.stringify(entryArtifact));
  check('主产物预览已能解析（广场读的就是这个字段）', submitted.data?.preview?.name === 'index.html', JSON.stringify(submitted.data?.preview));

  const assetPath = (html.match(/src="(\/api\/student\/file-assets\/[^"]+\/download)"/) || [])[1];
  if (assetPath) {
    const assetDownload = await fetch(`http://127.0.0.1:${PORT}${assetPath}`, { headers: { authorization: `Bearer ${token}` } });
    const assetBytes = Buffer.from(await assetDownload.arrayBuffer());
    check('学生自己能取回那张图（私有素材，PNG 魔术字节对得上）',
      assetDownload.status === 200 && assetBytes.subarray(0, 4).toString('hex') === '89504e47', `status=${assetDownload.status} bytes=${assetBytes.length}`);
  } else {
    check('学生自己能取回那张图（私有素材）', false, 'HTML 里没有可解析的素材地址');
  }

  const resubmitted = await api('/api/student/runtime/submit', {
    method: 'POST', token, body: { name: 'mygame/index.html', copyrightConfirmed: true },
  });
  check('同一份产物重复提交是覆盖（round+1）', resubmitted.status === 200 && resubmitted.data?.round === 2, JSON.stringify(resubmitted.data?.round));

  // 根目录那份作品引用了 CSS（文本素材，应当内联进 files）与 PNG（二进制，应当变成私有资产）——
  // 一份作品里两种素材同时存在，是学生作品最常见的样子。
  const mixed = await api('/api/student/runtime/submit', {
    method: 'POST', token, body: { name: 'index.html', copyrightConfirmed: true },
  });
  check('文本素材内联进 files、二进制素材不内联（同一份作品里两种都要对）',
    mixed.status === 200 && Object.keys(mixed.data?.files || {}).sort().join(',') === 'index.html,style.css',
    JSON.stringify(Object.keys(mixed.data?.files || {})));

  const mine = await api('/api/student/vibecoding/submissions', { token });
  check('交上来的作品出现在学生的作品列表里（与老链路同一张表）',
    mine.status === 200 && (mine.data?.items || []).some((item) => item.entryFile === 'index.html'), JSON.stringify(mine.data).slice(0, 200));

  /* ── 真文件产物发布到作品广场：看得到、下得动、预览不 500 ── */
  const rootAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  const published = await api(`/api/admin/vibecoding-works/${binaryEntry.data.id}/plaza`, { method: 'PUT', token: rootAdmin, body: { published: true } });
  check('真文件产物能发布到作品广场', published.status === 200 && published.data?.isPublic === true, JSON.stringify(published.data).slice(0, 200));
  const shareToken = published.data?.shareToken;
  const detail = await api(`/api/public/vibecoding-works/${shareToken}`);
  const catalog = detail.data?.artifacts || [];
  const card = catalog.find((item) => item.name === '演示文稿.pptx');
  check('广场作品清单里有这份真文件（不能因为不在 files 里就凭空消失）', Boolean(card), JSON.stringify(catalog));
  check('它带的是「真文件」标记与预览/下载两个地址',
    card?.storage === 'FILE' && String(card.previewUrl || '').includes('/preview') && String(card.downloadUrl || '').includes('/download'),
    JSON.stringify(card));
  const fileResponse = await fetch(`http://127.0.0.1:${PORT}${card?.downloadUrl}`);
  const fileBytes = Buffer.from(await fileResponse.arrayBuffer());
  check('广场能下到原文件，字节与交上来的一致（PK 头对得上）',
    fileResponse.status === 200 && fileBytes.subarray(0, 4).toString('hex') === '504b0304' && fileBytes.length === 52,
    `status=${fileResponse.status} bytes=${fileBytes.length}`);
  const previewResponse = await fetch(`http://127.0.0.1:${PORT}${card?.previewUrl}`);
  // 本机没有 LibreOffice 时转不出 PDF，那是**预期内**的失败 —— 关键是不能 500、
  // 也不能回退去发原始 Office 文件（那等于把下载绕过去了）。
  const previewOk = previewResponse.status === 200
    ? String(previewResponse.headers.get('content-type') || '').includes('pdf')
    : previewResponse.status === 400;
  check('广场预览：转得出就给 PDF，转不出就明确说「无法预览」（不 500、不回退发原文件）',
    previewOk, `status=${previewResponse.status} type=${previewResponse.headers.get('content-type')}`);
} finally {
  server.kill();
  // 有红的地方就把后端日志尾巴贴出来：这条链路的失败大多发生在宿主脚本那一跳，
  // 而接口层只会回一个「服务器内部错误」，不看日志等于没法查。
  if (failures) {
    const tail = serverLog.split('\n').filter((line) => line.trim()).slice(-15).join('\n');
    console.log(`\n--- 后端日志尾巴（用于定位） ---\n${tail}\n`);
  }
}

console.log(JSON.stringify({ name: 'student-runtime-deliverables', pass: failures === 0, failures }, null, 2));
process.exit(failures === 0 ? 0 : 1);
