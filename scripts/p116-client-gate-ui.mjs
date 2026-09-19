/**
 * P116 客户端「登录门」三个页面的界面守卫（2026-09-19 新增）。
 *
 * 为什么补这一道：这一轮把登录页按用户给的参考图重做了（红底 + 吉祥物 + 右侧玻璃卡 + 我们的字标），
 * 而那三个页面是**framework-free 的静态 HTML**，跑在 Electron 的 `file://` 下、还带着一条
 * `default-src 'none'` 的 CSP —— 这类页面出错的方式很阴：图片被 CSP 挡掉时**页面照样渲染**，
 * 只是那一块空白；`window.lingdong.gate` 的名字写错时**要等学生点登录才炸**，而那时已经没人看了。
 * 所以这一道专门钉住"看得见"和"点得动"这两件事。
 *
 * ⚠️ 依赖 Chrome（与 p111 / p115 同一套口径，可用 CHROME_PATH 覆盖）。
 * 跑法：node scripts/p116-client-gate-ui.mjs [--shots <目录>]
 * 出图：默认写到 .tmp/gate-shots/（gitignore），给人眼看一眼那三张。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = process.cwd();
const GATE = path.join(root, 'deploy/desktop/client-patch/gate');
const shotIndex = process.argv.indexOf('--shots');
const shotDir = path.resolve(shotIndex >= 0 ? (process.argv[shotIndex + 1] || '.tmp/gate-shots') : '.tmp/gate-shots');
fs.mkdirSync(shotDir, { recursive: true });

const checks = [];
const check = async (name, run) => {
  try { await run(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, message: error.message }); }
};

/** 打开一个门页面：收集报错、把 `lingdong.gate` 换成记录调用的桩。 */
async function open(page, name, state = null) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    window.__gateCalls = [];
    window.lingdong = { gate: (payload) => { window.__gateCalls.push(payload); return Promise.resolve({ ok: true }); } };
  });
  await page.goto(pathToFileURL(path.join(GATE, `${name}.html`)).href);
  if (state) await page.evaluate((value) => { window.__LINGDONG_STATE__ = value; window.__lingdongRender?.(); }, state);
  await page.waitForTimeout(200);
  return {
    errors,
    calls: () => page.evaluate(() => window.__gateCalls || []),
    lastCall: async () => (await page.evaluate(() => window.__gateCalls || [])).at(-1),
  };
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});

try {
  const login = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  const loginRun = await open(login, 'login');
  await login.screenshot({ path: path.join(shotDir, 'login.png') });

  await check('登录页零控制台报错（file:// + CSP 下 img/script 被挡都会在这里现形）',
    () => assert.deepEqual(loginRun.errors, []));
  await check('吉祥物与字标真的解码出来了（0 宽 = 被 CSP 挡了，而页面**不会**报错）',
    async () => {
      const images = await login.evaluate(() => [...document.images].map((img) => [img.getAttribute('src'), img.complete && img.naturalWidth > 0]));
      assert.deepEqual(images, [['mascot.png', true], ['logo.png', true]]);
    });
  await check('登录表单的四个元素都在（账号 / 密码 / 登录 / 错误框）',
    async () => {
      const found = await login.evaluate(() => ['login', 'password', 'submit', 'error'].map((id) => Boolean(document.getElementById(id))));
      assert.deepEqual(found, [true, true, true, true]);
    });
  await check('密码框是 password 类型（别把学生的密码明文摊在屏幕上）',
    async () => assert.equal(await login.evaluate(() => document.getElementById('password').type), 'password'));
  await login.fill('#login', 'stu001');
  await login.fill('#password', 'pw');
  await login.click('#submit');
  await login.waitForTimeout(120);
  await check('提交走的是门协议：{action:"login", login, password}',
    async () => assert.deepEqual(await loginRun.lastCall(), { action: 'login', login: 'stu001', password: 'pw' }));
  await check('提交后按钮进入「登录中…」且禁用（点了没反应会被当成卡住）',
    async () => {
      const state = await login.evaluate(() => ({ text: document.getElementById('submit').textContent, disabled: document.getElementById('submit').disabled }));
      assert.equal(state.text, '登录中…');
      assert.equal(state.disabled, true);
    });

  // 版式：本轮第一版把参考图的标语**印在了素材图上**，真文字与它重叠 —— 那一版所有断言都是绿的，
  // 是截图看出来的。所以这里钉住"两个盒子不相交"这个可判据的形状。
  await check('吉祥物与登录卡不相交（相交说明版式塌了）',
    async () => {
      const box = await login.evaluate(() => {
        const rect = (selector) => { const node = document.querySelector(selector); const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        return { mascot: rect('.mascot'), card: rect('.card'), slogan: rect('.slogan') };
      });
      assert.ok(box.mascot.right <= box.card.left + 1, `mascot.right=${box.mascot.right} 压到了 card.left=${box.card.left}`);
      assert.ok(box.slogan.left > box.mascot.left, '标语应该在吉祥物右侧（参考图：兔子指着标语）');
      assert.ok(box.slogan.top > box.mascot.top, '标语应该落在吉祥物的中下部');
    });
  await check('登录页是深红底（写的是 background-image 上的 radial-gradient，不是 background-color —— 后者会一直是透明）',
    async () => {
      const style = await login.evaluate(() => ({ image: getComputedStyle(document.body).backgroundImage, color: getComputedStyle(document.body).backgroundColor }));
      assert.match(style.image, /radial-gradient/, `background-image=${style.image}`);
      assert.match(style.image, /126, 17, 35|101, 16, 29/, '渐变里没有参考图那支深红（#7e1123 / #65101d）');
    });

  await login.setViewportSize({ width: 720, height: 720 });
  await login.waitForTimeout(150);
  await check('窄窗口（720px）时吉祥物让位，不压住登录卡',
    async () => assert.equal(await login.evaluate(() => getComputedStyle(document.querySelector('.stage')).display), 'none'));
  await login.close();

  const errorPage = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  await open(errorPage, 'login', { message: '账号或密码不正确' });
  await errorPage.screenshot({ path: path.join(shotDir, 'login-error.png') });
  await check('错误态按 __LINGDONG_STATE__.message 显示（不是一句写死的"登录失败"）',
    async () => assert.equal(await errorPage.textContent('#error'), '账号或密码不正确'));
  await errorPage.close();

  const waiting = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  const waitingRun = await open(waiting, 'waiting', { name: '王小可', message: '老师还没有开始上课' });
  await waiting.screenshot({ path: path.join(shotDir, 'waiting.png') });
  await check('等待页零控制台报错', () => assert.deepEqual(waitingRun.errors, []));
  await check('等待页把学生名字与「为什么在这等」都显示出来',
    async () => {
      const text = await waiting.textContent('main');
      assert.ok(text.includes('王小可'), '缺学生名字');
      assert.ok(text.includes('老师还没有开始上课'), '缺原因');
    });
  await waiting.click('#refresh');
  await waiting.waitForTimeout(120);
  await check('点刷新走 {action:"refresh"}（深链叫起来的客户端也走这一条）',
    async () => assert.deepEqual(await waitingRun.lastCall(), { action: 'refresh' }));
  await waiting.click('#logout');
  await waiting.waitForTimeout(120);
  await check('点退出走 {action:"logout"}', async () => assert.deepEqual(await waitingRun.lastCall(), { action: 'logout' }));
  await waiting.close();

  const loading = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  const loadingRun = await open(loading, 'loading', { name: '王小可' });
  await loading.screenshot({ path: path.join(shotDir, 'loading.png') });
  await check('准备页零控制台报错', () => assert.deepEqual(loadingRun.errors, []));
  await check('准备页带学生名字（不能只剩一句"第一次启动会慢一点"）',
    async () => assert.ok((await loading.textContent('#who')).includes('王小可')));
  await loading.close();

  await check('三个页面的 CSP 都放开了 img-src（漏了它图片静默不显示）',
    () => {
      for (const name of ['login', 'waiting', 'loading']) {
        assert.match(fs.readFileSync(path.join(GATE, `${name}.html`), 'utf8'), /img-src file: data:;/, `${name}.html 的 CSP 里没有 img-src`);
      }
    });
  await check('三个页面都带上了我们的字标',
    () => {
      for (const name of ['login', 'waiting', 'loading']) {
        assert.match(fs.readFileSync(path.join(GATE, `${name}.html`), 'utf8'), /src="logo\.png"/, `${name}.html 里没有字标`);
      }
    });
  await check('随包分发的素材真的在（吉祥物 / 字标 / 应用图标）',
    () => {
      for (const name of ['mascot.png', 'logo.png', 'app-icon-1024.png']) {
        assert.ok(fs.statSync(path.join(GATE, name)).size > 10_000, `${name} 太小，多半是空文件`);
      }
    });
} finally {
  await browser.close();
}

const failed = checks.filter((item) => !item.ok);
const out = { name: 'p116-client-gate-ui', pass: failed.length === 0, checks: checks.length, shots: path.relative(root, shotDir).replace(/\\/g, '/'), failed };
if (failed.length) { console.error(JSON.stringify(out, null, 1)); process.exit(1); }
console.log(JSON.stringify(out));
