/**
 * P53 课包版本与「更新发布」守卫（2026-09-12，平台侧重做梳理 P1 第三刀）。
 *
 * 用户的规则（1.3）：课包发布后每次修改都要填**最新版本号**，并选**是否更新发布**；
 * 更新发布后，已授权机构与官网外显层面都要跟着更新。
 * 实现口径：版本号不再自动 +0.1（由人填写），每次「更新发布」写一条版本记录；
 * 读模型仍是当前内容，所以发布即对所有读取方生效；「有没有未发布的改动」由时间比较得出。
 *
 * 盯住：
 *   ① 改课时/素材不再偷偷改版本号（老行为是任何改动自动 +0.1，版本号会失去意义）；
 *   ② 「有未发布的改动」能被识别出来，更新发布之后归零；
 *   ③ 版本号：必填、不能与当前相同、不能重复；
 *   ④ 更新发布后课包版本号落库，机构端/学生端读到的就是新内容（同一份数据）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p53-series-version-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
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

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 18899;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
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
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data;
  assert.ok(admin && orgAdmin?.token && student?.token, '登录失败');

  // 建课包（版本 1.0）+ 课时
  const created = await api('/api/admin/course-series', {
    method: 'POST', token: admin,
    body: { title: 'P53 版本课包', stockTotal: 20, coverImageUrl: 'https://example.com/p53-cover.png', description: '版本守卫', visibility: 'ALL_ORGS', version: '1.0', lessons: [{ title: '第1课', status: 'PUBLISHED', capabilities: ['text'], deliveryModes: ['CANVAS'] }] },
  });
  assert.equal(created.status, 200, `建课包失败: ${JSON.stringify(created.data).slice(0, 160)}`);
  const seriesId = created.data.id;
  const lessonId = (created.data.lessons || [])[0]?.id;
  check('新版本课包初始版本号来自填写值', created.data.version === '1.0', String(created.data.version));

  const detail1 = await api(`/api/admin/course-series/${seriesId}/detail`, { token: admin });
  check('详情带版本历史字段', Array.isArray(detail1.data.versions), JSON.stringify(detail1.data.versions)?.slice(0, 80));
  check('建课包即记一条「初始版本」（版本历史有起点）', (detail1.data.versions || []).length === 1 && detail1.data.versions[0].version === '1.0' && detail1.data.versions[0].note === '初始版本', JSON.stringify(detail1.data.versions));

  // ① 改课时：不再自动改版本号
  await sleep(1100);
  const edited = await api(`/api/admin/course-lessons/${lessonId}`, { method: 'PUT', token: admin, body: { title: '第1课（改过）' } });
  assert.equal(edited.status, 200, `改课时失败: ${JSON.stringify(edited.data).slice(0, 160)}`);
  const detail2 = await api(`/api/admin/course-series/${seriesId}/detail`, { token: admin });
  check('改课时不会偷偷改版本号（还是 1.0）', detail2.data.series.version === '1.0', String(detail2.data.series.version));
  check('改课时后能识别出「有未发布的改动」', detail2.data.hasUnpublishedChanges === true, JSON.stringify({ has: detail2.data.hasUnpublishedChanges, lastChangeAt: detail2.data.lastChangeAt, lastVersionAt: detail2.data.lastVersionAt }));

  // ② 更新发布：版本号必填 / 不能与当前相同 / 不能重复
  const empty = await api(`/api/admin/course-series/${seriesId}/versions`, { method: 'POST', token: admin, body: { note: '缺版本号' } });
  check('版本号必填', empty.status === 400, `${empty.status} ${empty.error?.code}`);
  const same = await api(`/api/admin/course-series/${seriesId}/versions`, { method: 'POST', token: admin, body: { version: '1.0', note: '同版本' } });
  check('不能填与当前相同的版本号', same.status === 400 && same.error?.code === 'VERSION_UNCHANGED', `${same.status} ${same.error?.code}`);

  const published = await api(`/api/admin/course-series/${seriesId}/versions`, { method: 'POST', token: admin, body: { version: '1.1', note: '改了第 1 课标题' } });
  check('更新发布成功', published.status === 200 && published.data.version === '1.1', `${published.status} ${JSON.stringify(published.data).slice(0, 120)}`);
  const detail3 = await api(`/api/admin/course-series/${seriesId}/detail`, { token: admin });
  check('课包版本号已推进到 1.1', detail3.data.series.version === '1.1', String(detail3.data.series.version));
  check('版本历史里能查到这次发布与变更说明', (detail3.data.versions || []).some((v) => v.version === '1.1' && v.note.includes('第 1 课')), JSON.stringify(detail3.data.versions)?.slice(0, 200));
  check('更新发布后「有未发布的改动」归零', detail3.data.hasUnpublishedChanges === false, JSON.stringify({ has: detail3.data.hasUnpublishedChanges, lastChangeAt: detail3.data.lastChangeAt, lastVersionAt: detail3.data.lastVersionAt }));
  const dup = await api(`/api/admin/course-series/${seriesId}/versions`, { method: 'POST', token: admin, body: { version: '1.0', note: '用过的旧版本号' } });
  check('用过的版本号不能重复发布', dup.status === 409 && dup.error?.code === 'VERSION_EXISTS', `${dup.status} ${dup.error?.code}`);

  // ③ 发布即生效：机构端与学生端读到的就是新内容（同一份数据，不需要额外同步）
  await api(`/api/admin/course-series/${seriesId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
  await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: admin, body: { orgIds: [orgAdmin.organization.id], validityDays: 365, quotaTotal: 10 } });
  const orgCourse = await api(`/api/org/course-series/${seriesId}`, { token: orgAdmin.token });
  check('机构端读到的课时标题就是改后的内容（发布即生效）', JSON.stringify(orgCourse.data).includes('第1课（改过）'), JSON.stringify(orgCourse.data).slice(0, 160));

  console.log(JSON.stringify({ name: 'series-version-publish', pass: failures === 0, seriesId, failures }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
