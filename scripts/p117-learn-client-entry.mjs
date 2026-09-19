/**
 * P117 学生端「我的课程 → 课时卡片」的入口守卫（2026-09-19 新增）。
 *
 * 用户口径：**「网站上的 dsh 就不要了，以后 vibecoding 就是在客户端进行」**。
 * 改版前那一排是「进入创作环境」（点一下由平台在服务器上拉起 dsh 盒子、再新标签页打开）
 * +「提交作品」；改版后只剩**把学生送到客户端**：`lingdong://open` 深链 + 下载入口。
 * 这一道就是钉住"网页侧不许再拉起任何创作环境"这件事：
 *   · VibeCoding 课时上只有「打开创作客户端」+「下载客户端」两个入口；
 *   · 一个课时同时开画布与 VibeCoding 时**两个入口并列**（不许替学生挑一个）；
 *   · 没开始 / 已完课 / 未授权时按钮点不动，但**原因写在按钮上**、下载入口仍在；
 *   · ⭐ **整页跑一遍，一次 `/api/student/runtime/*` 的请求都不许发** ——
 *     这是"网页不再拉起创作环境"唯一能自动判的判据（接口还在，改回旧版就一定会打到它）；
 *   · 零控制台报错。
 *
 * ⚠️ 这一道**自己构建** apps/website（直接读 dist 的话，改源码不重建就绿得毫无意义 ——
 *    那是 p115 文件头写过的坑）。
 * ⚠️ 后端用**桩**：这一道只关心课时卡片渲染成什么，不验账号/名单/课堂（那些是 p6 / p108 的事），
 *    所以按 `services/studentContext.js` 里 `classroomCourses` 的形状喂一份固定数据。
 * ⚠️ Playwright 的路由是**后注册的优先**：兜底必须写在前，否则它会把 dashboard 也吃掉。
 * 跑法：node scripts/p117-learn-client-entry.mjs [--shots <目录>]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = process.cwd();
const shotIndex = process.argv.indexOf('--shots');
const shotDir = path.resolve(shotIndex >= 0 ? (process.argv[shotIndex + 1] || '.tmp/gate-shots') : '.tmp/gate-shots');
fs.mkdirSync(shotDir, { recursive: true });

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => { if (code) reject(new Error(err || out)); else resolve(out); });
});

/** 与 services/studentContext.js 的 classroomCourses 同形（只留界面读得到的字段）。 */
const lesson = (over) => ({
  id: over.id, sort: over.sort, title: over.title, summary: over.summary || '今天的任务是做一个自己的小网页。',
  deliveryMode: over.deliveryMode, deliveryModes: over.deliveryModes || [over.deliveryMode],
  canStart: Boolean(over.canStart), canStartVibeCoding: Boolean(over.canStartVibeCoding),
  hasGrant: over.hasGrant !== false, participationStatus: over.participationStatus || 'ACTIVE',
  blockReason: over.blockReason ?? null, vibeCodingBlockReason: over.vibeCodingBlockReason ?? null,
  teacherName: '李老师', sessionTitle: '周二 16:00 班', session: { id: 'sess-1' },
  projectCount: 0, draftCount: 0, workCount: 0, continueProject: null, participationLabel: '上课中',
});

const dashboard = {
  user: { displayName: '王小可', login: 'stu001' },
  organization: { name: '示例机构' },
  classroomCourses: [{
    id: 'course-1', title: 'AI 创作入门', description: '围绕真实作品展开的项目式创作课程。',
    hasGrant: true, canStart: true, classroomAvailable: true,
    lessons: [
      lesson({ id: 'l-vibe', sort: 1, title: '用 AI 做一个自我介绍网页', deliveryMode: 'VIBECODING', canStart: true, canStartVibeCoding: true }),
      lesson({ id: 'l-both', sort: 2, title: '画布 + AI 一起上', deliveryMode: 'CANVAS', deliveryModes: ['CANVAS', 'VIBECODING'], canStart: true, canStartVibeCoding: true }),
      lesson({ id: 'l-wait', sort: 3, title: '还没开始的那节课', deliveryMode: 'VIBECODING', participationStatus: 'PENDING' }),
      lesson({ id: 'l-done', sort: 4, title: '已经上完的 VibeCoding 课', deliveryMode: 'VIBECODING', participationStatus: 'COMPLETED' }),
      lesson({ id: 'l-cold', sort: 5, title: '老师还没把课包给我', deliveryMode: 'VIBECODING', hasGrant: false, participationStatus: 'PENDING' }),
    ],
  }],
};

const checks = [];
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, message: error.message }); }
};

await run(['node_modules/vite/bin/vite.js', 'build', 'apps/website', '--config', 'apps/website/vite.config.mjs']);

const dist = path.join(root, 'apps/website/dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  response.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const apiCalls = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', (request) => { if (request.url().includes('/api/')) apiCalls.push(new URL(request.url()).pathname); });

try {
  await page.addInitScript(() => {
    window.localStorage.setItem('ai-kids-platform.session.v1.student', JSON.stringify({
      token: 't', expiresAt: null, user: { id: 'u1', role: 'STUDENT', displayName: '王小可', login: 'stu001' }, organization: { name: '示例机构' },
    }));
  });
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {} }) }));
  await page.route('**/api/student/dashboard**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: dashboard }) }));

  await page.goto(`${base}/learn`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '查看课程' }).first().click();
  await page.waitForTimeout(300);

  await page.screenshot({ path: path.join(shotDir, 'site-learn-lessons.png'), fullPage: true });

  const cards = await page.$$eval('.lesson-detail-card', (nodes) => nodes.map((node) => ({
    title: node.querySelector('h3')?.textContent,
    actions: [...node.querySelectorAll('.lesson-detail-action a, .lesson-detail-action button')].map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: el.textContent.trim(),
      href: el.getAttribute('href'),
      disabled: el.disabled === true,
    })),
  })));
  const cardOf = (title) => {
    const found = cards.find((item) => item.title === title);
    assert.ok(found, `没渲染出这张课时卡片：${title}`);
    return found;
  };

  await check('零控制台报错', () => assert.deepEqual(errors, []));
  await check('五张课时卡片都渲染出来了', () => assert.equal(cards.length, 5));
  await check('已开始的 VibeCoding 课：只有「打开创作客户端」+「下载客户端」',
    () => assert.deepEqual(cardOf('用 AI 做一个自我介绍网页').actions, [
      { tag: 'a', text: '打开创作客户端', href: 'lingdong://open', disabled: false },
      { tag: 'a', text: '下载客户端', href: '/download', disabled: false },
    ]));
  await check('画布 + VibeCoding 都开时：两个入口**并列**（不许替学生挑一个）',
    () => assert.deepEqual(cardOf('画布 + AI 一起上').actions.map((item) => item.text), ['打开创作客户端', '下载客户端', '进入课堂']));
  await check('没开始：按钮点不动、原因写在按钮上，下载入口仍在',
    () => assert.deepEqual(cardOf('还没开始的那节课').actions, [
      { tag: 'button', text: '等待开课', href: null, disabled: true },
      { tag: 'a', text: '下载客户端', href: '/download', disabled: false },
    ]));
  await check('已完课 / 未授权：文案按状态给（沿用改版前那套口径）',
    () => {
      assert.equal(cardOf('已经上完的 VibeCoding 课').actions[0].text, '已完课');
      assert.equal(cardOf('老师还没把课包给我').actions[0].text, '未授权');
      assert.ok(cardOf('老师还没把课包给我').actions[0].disabled);
    });
  await check('⭐ 整页一次 /api/student/runtime/* 都没打（网页不再拉起创作环境）',
    () => assert.deepEqual(apiCalls.filter((item) => item.startsWith('/api/student/runtime')), []));
  await check('老工作台那条路也没回来（一条 /learn/vibecoding 都没有）',
    () => assert.deepEqual(apiCalls.filter((item) => item.includes('vibecoding')), []));
  await check('源码里不再有网页侧的拉起/提交实现（runtimeWorkspace 已删干净）',
    () => {
      assert.ok(!fs.existsSync(path.join(root, 'packages/shared/src/runtimeWorkspace.jsx')), 'runtimeWorkspace.jsx 还在');
      const entry = fs.readFileSync(path.join(root, 'packages/shared/src/clientEntry.jsx'), 'utf8');
      assert.match(entry, /lingdong:\/\/open/);
      assert.ok(!/api\.(get|post)\(/.test(entry), 'clientEntry 是纯展示，不该自己发请求');
    });
} finally {
  await browser.close();
  server.close();
}

const failed = checks.filter((item) => !item.ok);
const out = { name: 'p117-learn-client-entry', pass: failed.length === 0, checks: checks.length, failed };
if (failed.length) { console.error(JSON.stringify(out, null, 1)); process.exit(1); }
console.log(JSON.stringify(out));
