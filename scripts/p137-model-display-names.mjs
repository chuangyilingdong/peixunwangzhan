/**
 * P137 模型显示名（2026-09-23 用户口径）。
 *
 * 用户原话：「AI能力与价格页面能否有个单独配置页面来配置映射名字，比如这边显示的是 deepseek-flash，
 *   我可以自定义给这个模型取名，然后在画布或者 vibecoding 课堂模型名字这里可以映射我改过的名字」。
 *
 * 这个守卫钉四件事，缺一件这个需求就没真正满足：
 *   ① **别名能存能读**（只信真 HTTP：GET/PUT 那份 AI 渠道策略）—— 空串丢掉、超长的截断、非对象忽略；
 *   ② **画布框体拿得到它**：走真实链路（机构开课 → 学生建项目 → 读项目），框体上多出一个 `modelLabel`。
 *      ⚠️ 这一条必须在**发布快照**那条路上验（生产上学生读的就是快照）—— 所以夹具往
 *      `course_lessons.published_content` 里放框体，而不是只改实时素材；
 *   ③ **别名只碰显示**：`model` 字段一个字节都不能变（发给上游的就是它）—— 别把显示名写进 model；
 *   ④ 清空别名 = 回到原来的 ID（"不配就零变化"）。
 *
 * 真观感（画布那行字真的显示成别名）由 `.tmp/then-model-alias.mjs` 在真浏览器里核。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p137-model-name-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

const baseEnv = { ...process.env, PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp, PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const MODEL = 'p137-flash';
const ALIAS = 'P137 飞闪';
const SEEDED = {};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
{
  // 夹具（直接改库 —— 与 p128 / page-shot 的 fixture 同一条做法）：给 student-2 那节课
  // 一份「已发布、有生成框体」的快照，并把课时开放成画布课。
  
  
  const student = await arow("SELECT id, org_id FROM users WHERE login='student-2'");
  const grant = await arow('SELECT series_id FROM student_course_grants WHERE student_id=?', [student.id]);
  const lesson = await arow('SELECT id FROM course_lessons WHERE series_id=? ORDER BY sort LIMIT 1', [grant.series_id]);
  const box = { id: 'box_p137', title: 'P137 文字框体', modality: 'TEXT', model: MODEL, prompt: '', assetUrl: '' };
  await aq('UPDATE course_lessons SET status=?, delivery_modes=? WHERE id=?', ['PUBLISHED', JSON.stringify(['CANVAS']), lesson.id]);
  // ⚠️ 走**发布快照**（学生读的就是它）：`published_content.generationBoxes` 是数组时，
  //    mergedLessonCanvas 就取这一份（见 lib.js 的逐键回退），所以这里放进去就等于"运营已发布"。
  const materialGroups = [{ id: 'p137-group', title: 'P137 素材组', materials: [{ id: box.id, materialType: 'GENERATION_BOX', title: box.title, snapshot: { box } }] }];
  await aq('UPDATE course_lessons SET published_content=? WHERE id=?', [JSON.stringify({ capabilities: ['text'], materialGroups, generationBoxes: [box] }), lesson.id]);
  Object.assign(SEEDED, { studentId: student.id, seriesId: grant.series_id, lessonId: lesson.id });
  
}

const port = 19137;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null };
}

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }
  const rootToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data?.token;
  assert.ok(rootToken, '平台管理员登录失败');

  console.log('① 别名能存能读（真 HTTP；消毒在服务端做）');
  const channel = { id: 'p137-channel', name: 'P137 渠道', endpoint: 'https://example.invalid/v1', model: MODEL, models: [MODEL], apiKey: 'p137-key' };
  const saved = await api('/api/admin/billing-config/ai-provider', {
    method: 'PUT', token: rootToken,
    body: { provider: 'custom', displayName: 'P137 供应商', endpoint: 'https://example.invalid/v1', model: MODEL, channels: [channel], modalityChannels: { TEXT: channel.id }, modelDisplayNames: { [MODEL]: ALIAS, 'p137-blank': '   ', 'p137-number': 42, ['x'.repeat(260)]: '超长键' } },
  });
  check('① 保存渠道 + 显示名成功', saved.status === 200, JSON.stringify(saved.error));
  const policy = (await api('/api/admin/billing-config/ai-provider', { token: rootToken })).data?.policy;
  check(`① 别名读回来了（${MODEL} → ${ALIAS}）`, policy?.modelDisplayNames?.[MODEL] === ALIAS, JSON.stringify(policy?.modelDisplayNames));
  check('① 空串（只有空格）被丢掉 —— 空 = 恢复原名，不能存成空名', !('p137-blank' in (policy?.modelDisplayNames || {})));
  check('① 超长的模型 ID 被截到 200 以内（键也是运营填的，不能无限长）',
    Object.keys(policy?.modelDisplayNames || {}).every((key) => key.length <= 200), JSON.stringify(Object.keys(policy?.modelDisplayNames || {}).map((k) => k.length)));
  check('① 非字符串的值被转成字符串（不炸、也不留 undefined）', policy?.modelDisplayNames?.['p137-number'] === '42', JSON.stringify(policy?.modelDisplayNames?.['p137-number']));

  console.log('② 画布框体拿得到它（真链路：机构开课 → 学生建项目 → 读项目）');
  const studentToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data?.token;
  const orgToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data?.token;
  const session = await api('/api/org/sessions', { method: 'POST', token: orgToken, body: { lessonId: SEEDED.lessonId, deliveryMode: 'CANVAS', title: 'P137 课堂' } });
  const sessionId = session.data?.id;
  await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: orgToken, body: { studentIds: [SEEDED.studentId] } });
  const started = await api(`/api/org/sessions/${sessionId}/start`, { method: 'POST', token: orgToken });
  check('② 课堂开起来了（前置条件）', Boolean(sessionId) && started.status === 200, JSON.stringify(session).slice(0, 200));
  const created = await api('/api/student/projects', { method: 'POST', token: studentToken, body: { courseLessonId: SEEDED.lessonId, title: 'P137 显示名', sessionId } });
  const projectId = created.data?.id;
  check('② 学生建项目成功', Boolean(projectId), JSON.stringify(created).slice(0, 220));
  const project = await api(`/api/student/projects/${projectId}`, { token: studentToken });
  const boxes = Array.isArray(project.data?.generationBoxes) ? project.data.generationBoxes : [];
  const box = boxes.find((item) => item.model === MODEL) || boxes[0];
  check('② 项目里下发了框体（画布就是按它渲染的）', Boolean(box), JSON.stringify(boxes).slice(0, 200));
  check('② ★ 框体上带出了显示名（modelLabel = ' + ALIAS + '）', box?.modelLabel === ALIAS, JSON.stringify(box));
  check('③ 别名**只碰显示**：model 字段仍然是真 ID（发给上游的就是它）', box?.model === MODEL, JSON.stringify(box?.model));
  // ③b 左侧「课堂素材」面板渲染的是 materialGroups 里的框体（canvasWorkspace 的 boxParamsLabel），
  //     所以那一份也要打标签 —— 少一处就是"右边改了、左边还写着技术名"（真浏览器那一跑抓到的就是它）。
  const panelBox = (Array.isArray(project.data?.materialGroups) ? project.data.materialGroups : [])
    .flatMap((group) => (Array.isArray(group?.materials) ? group.materials : []))
    .find((material) => material?.materialType === 'GENERATION_BOX')?.snapshot?.box;
  check('③b ★ 素材面板那份框体也带出了显示名（materialGroups[].materials[].snapshot.box）', panelBox?.modelLabel === ALIAS, JSON.stringify(panelBox));

  console.log('④ 清空别名 = 回到原来的 ID（不配就零变化）');
  const current = (await api('/api/admin/billing-config/ai-provider', { token: rootToken })).data?.policy || {};
  const cleared = await api('/api/admin/billing-config/ai-provider', { method: 'PUT', token: rootToken, body: { ...current, modelDisplayNames: {} } });
  check('④ 清空保存成功', cleared.status === 200, JSON.stringify(cleared.error));
  const afterClear = (await api(`/api/student/projects/${projectId}`, { token: studentToken })).data?.generationBoxes?.find((item) => item.model === MODEL);
  check('④ ★ 清掉之后 modelLabel 回到真 ID（学生看到的就是原来的样子）', afterClear?.modelLabel === MODEL, JSON.stringify(afterClear));

  console.log('⑤ 界面入口与渲染（源码级）');
  const canvas = read('packages/canvas/src/index.jsx');
  const workspace = read('packages/shared/src/canvasWorkspace.jsx');
  const panel = read('apps/admin/src/components/ModelNamePanel.jsx');
  const compute = read('apps/admin/src/pages/ModelCompute.jsx');
  const adminMain = read('apps/admin/src/main.jsx');
  const courseEditor = read('apps/admin/src/components/CourseManagement.jsx');
  check('⑤ 画布两处都改成显示 modelLabel（配置标签 + 参数胶囊）',
    (canvas.match(/params\.push\(data\.modelLabel \|\| data\.model\)/g) || []).length === 2, `匹配到 ${(canvas.match(/params\.push\(data\.modelLabel \|\| data\.model\)/g) || []).length} 处`);
  check('⑤ 画布节点数据里带上了 modelLabel（服务端下发 → 画布渲染，中间不能断）', /modelLabel: box\.modelLabel \|\| ''/.test(workspace));
  check('⑤ 后台有单独一页（页签 + 路由都在）',
    /ModelNamePanel/.test(compute) && /to="\/compute\/names"/.test(compute) && /path="\/compute\/names"/.test(adminMain) && /export function ModelNamePanel/.test(panel));
  check('⑤ 这一页只改显示名、并写清"不改调用参数"（它读写的是同一份渠道策略）',
    /admin\/billing-config\/ai-provider/.test(panel) && /发给上游的仍然是模型 ID|发给上游的永远是真 ID/.test(panel));
  check('⑤ 课时编排的模型下拉也把别名带上（别名（真 ID）—— 只写一边就对不上号）',
    /modelOptionLabel/.test(courseEditor) && /（\$\{model\}）/.test(courseEditor));
} finally {
  server.kill('SIGTERM');
}

console.log('');
if (failures) { console.log(`✗ p137 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p137 模型显示名：全部通过');
