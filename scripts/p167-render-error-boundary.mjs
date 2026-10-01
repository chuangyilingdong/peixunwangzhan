/**
 * P167 渲染兜底（`AppErrorBoundary`）守卫 —— 2026-09-29。
 *
 * 为什么要它：09-29 一天里两次线上白屏（§六十一 后台「选新加的模型就白屏」、
 * §五十五 学生画布少一个 `?.`）都是**整页空白**：用户只能说"白的"，我们只能靠控制台或猜。
 * 三端入口包一层兜底之后，「渲染期抛错」至少要留一张写着错误信息的页面。
 *
 * 这个守卫分两段，缺一不可：
 *   ① **接线断言**（源码）：`AppErrorBoundary` 在 shared 里存在且真的是个错误边界
 *      （`getDerivedStateFromError` + `componentDidCatch`），并且**三端入口都把 `<App />` 包住了** ——
 *      只加组件不接线，等于没加（这正是"改了但没生效"的经典形状）。
 *   ② **真浏览器行为网**：真 Chrome 里加载一个最小页，同时挂三棵树：
 *      A) 有兜底 + 子组件抛错 → 必须看到**兜底页**（标题 / 原始报错 / 两个按钮）；
 *      B) 没有兜底 + 子组件抛错 → **容器里必须是空的**（这就是"整页白"那张图，把它钉成对照）；
 *      C) 有兜底 + 子树正常 → **原样透传**（兜底不许把好页面也换掉）。
 *      再点一次「重试这一页」，确认**确定性错误会回到兜底页**（而不是留个半坏的页面）。
 *
 * ⚠️ 两条踩过的（写在这儿省得下次重踩）：
 *   ① **SSR 不验这条**：`react-dom/server` 的 `renderToStaticMarkup` 遇到子树抛错时**直接往外抛**，
 *      不走 `getDerivedStateFromError`（2026-09-29 实测：进程都挂了）。所以行为只能真浏览器验。
 *   ② 页面用 **vite dev 现转 JSX**（`configFile:false` + esbuild jsx automatic）：这样测的是
 *      `packages/shared/src/errorBoundary.jsx` **源码本身**，不是某份构建产物。
 *      「构建产物里也真的挂上」由 p111 / p115 / p136 那些自己构建 + 真 Chrome 的网覆盖。
 *
 * ⚠️ 依赖 Chrome（与 p111 / p115 同一套口径，可用 `CHROME_PATH` 覆盖）。
 * 跑法：node scripts/p167-render-error-boundary.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { stripComments } from './lib/sourceText.mjs';

const root = process.cwd();
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const harnessDir = path.join(root, '.tmp', 'p167-boundary');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`); }
};
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/* ── ① 接线：shared 里有、三端入口都包住了 ───────────────────────────── */
console.log('\n① 入口接线（源码断言）');
const boundary = stripComments(read('packages/shared/src/errorBoundary.jsx'));
check('① shared 里存在 AppErrorBoundary 且是个**真**错误边界（两个静态钩子都在）',
  /export class AppErrorBoundary extends Component/.test(boundary)
  && /static getDerivedStateFromError\(error\)\s*\{\s*return \{ error \};?\s*\}/.test(boundary)
  && /componentDidCatch\(/.test(boundary));
check('① 没兜底时**原样返回子树**（`if (!error) return this.props.children`）',
  /if \(!error\) return this\.props\.children;/.test(boundary));
check('① 兜底页**不是 null / 空**（不然还是白屏，只是白得更安静）',
  /role="alert"/.test(boundary) && /重新加载/.test(boundary) && !/return null;/.test(boundary));
check("① shared 入口转出了它（三端都是 `from '@platform/shared'` 拿的）",
  /export \* from '\.\/errorBoundary\.jsx'/.test(stripComments(read('packages/shared/src/index.js'))));

// 三端入口：`createRoot(...).render(<AppErrorBoundary>…<App />…</AppErrorBoundary>)`
// ⚠️ 锚在 createRoot 那一句上，别用"文件里出现过 AppErrorBoundary"这种松断言 ——
//    那样"import 了但没包住"也会绿（接线守卫最该拦的就是这一种）。
const ENTRIES = ['apps/admin/src/main.jsx', 'apps/org/src/main.jsx', 'apps/website/src/main.jsx'];
for (const entry of ENTRIES) {
  const source = stripComments(read(entry));
  const render = source.match(/createRoot\([\s\S]*?\)\.render\(([\s\S]*)\);\s*$/);
  // ⚠️ 2026-10-01：多语言给 render 里加了一层 `<I18nProvider>`（`<AppErrorBoundary>` 仍是最外层），
  //    多行参数还会带一个**尾逗号** —— 断言跟着放宽这两点；"最外层是 AppErrorBoundary + 里面有 <App />"
  //    这条口径不变（这才是它真正要拦的东西）。
  const rendered = (render?.[1] || '').trim().replace(/,\s*$/, '').trim();
  const wired = Boolean(render)
    && /^<AppErrorBoundary>/.test(rendered)
    && /<App\s*\/>/.test(rendered)
    && /<\/AppErrorBoundary>\s*$/.test(rendered);
  check(`① ${entry} 的 render 把 <App /> 包在 <AppErrorBoundary> 里`, wired);
  check(`① ${entry} 从 '@platform/shared' 导入 AppErrorBoundary`,
    /import \{[^}]*\bAppErrorBoundary\b[^}]*\} from '@platform\/shared'/.test(source));
}

/* ── ② 真浏览器：兜底页真的会出现（对照组是"整页白"） ────────────────── */
console.log('\n② 真 Chrome：兜底页 / 整页白 / 正常透传 三种形状');
fs.rmSync(harnessDir, { recursive: true, force: true });
fs.mkdirSync(harnessDir, { recursive: true });
fs.writeFileSync(path.join(harnessDir, 'index.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>p167 harness</title></head>
<body>
  <div id="with-boundary"></div>
  <div id="without-boundary"></div>
  <div id="healthy"></div>
  <script type="module" src="./harness.jsx"></script>
</body></html>
`);
fs.writeFileSync(path.join(harnessDir, 'harness.jsx'), `import { createRoot } from 'react-dom/client';
// ⚠️ 直接 import **源码**（不是构建产物）：vite dev 现转这个 .jsx，测的就是三端要用的那一份。
import { AppErrorBoundary } from '../../packages/shared/src/errorBoundary.jsx';

function Boom() { throw new Error('p167 故意抛的渲染错误'); }

// A) 有兜底：现在三端入口的形状
createRoot(document.getElementById('with-boundary')).render(<AppErrorBoundary><Boom /></AppErrorBoundary>);
// B) 没兜底：对照组 —— 这就是"整页白"那张图（React 会把这一棵树的渲染丢掉）
createRoot(document.getElementById('without-boundary')).render(<Boom />);
// C) 正常子树：兜底**不许**把好页面也换掉
createRoot(document.getElementById('healthy')).render(<AppErrorBoundary><p id="healthy-child">正常内容</p></AppErrorBoundary>);
`);

const { createServer } = await import('vite');
const port = 5600 + Math.floor(Math.random() * 300);
const vite = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  // 显式钉 jsx 运行时：不依赖 vite 的默认值（默认值跟着版本变，测出来就不是同一件事了）
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  server: { host: '127.0.0.1', port, strictPort: true },
});
let browser;
try {
  await vite.listen();
  const url = `http://127.0.0.1:${port}/.tmp/p167-boundary/index.html`;
  // ⚠️ 先**把 vite 热起来**再开浏览器：vite dev 的第一次请求要现场转 JSX + 预打包依赖
  //    （esbuild），在跑全量时机器很忙，这一步能超过 30 秒 —— 上一轮全量里就是这里
  //    `page.goto: Timeout 30000ms exceeded` 判红的（是这条守卫脆，不是产品坏了）。
  //    这里先用 fetch 把入口模块拉一遍（它会把依赖链都打出来），成功后再导航。
  let warmed = false;
  for (let attempt = 0; attempt < 90 && !warmed; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.tmp/p167-boundary/harness.jsx`);
      if (response.ok) { await response.text(); warmed = true; }
    } catch { /* 还没起来 */ }
    if (!warmed) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check('② vite dev 起来了（入口模块能取到）', warmed, warmed ? '' : '90 秒内没热起来');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`));
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  // A) 兜底页出现（等它真渲染，不靠 sleep 猜）
  await page.waitForFunction(
    () => /这一页没能画出来/.test(document.querySelector('#with-boundary')?.textContent || ''),
    null, { timeout: 15000 },
  );
  const fallbackText = await page.locator('#with-boundary').innerText();
  check('② 有兜底：出现兜底页标题「这一页没能画出来」', /这一页没能画出来/.test(fallbackText));
  check('② 兜底页带着**原始报错**（用户截图就能定位）', fallbackText.includes('p167 故意抛的渲染错误'), fallbackText.slice(0, 120));
  check('② 兜底页有「重新加载」与「重试这一页」两个按钮',
    (await page.locator('#with-boundary button', { hasText: '重新加载' }).count()) === 1
    && (await page.locator('#with-boundary button', { hasText: '重试这一页' }).count()) === 1);
  check('② componentDidCatch 真跑了（控制台有 [AppErrorBoundary] 那一行）',
    consoleLines.some((line) => line.includes('[AppErrorBoundary]') && line.includes('渲染失败')),
    consoleLines.slice(-3).join(' | '));

  // B) 对照组：没有兜底时容器是空的 —— 把"整页白"钉成可复现的对照
  const withoutBoundary = await page.evaluate(() => document.querySelector('#without-boundary').innerHTML);
  check('② 对照：**没有兜底**时那个容器是空的（这就是"整页白"）', withoutBoundary.trim() === '', withoutBoundary.slice(0, 80));

  // C) 正常子树原样透传
  const healthy = await page.evaluate(() => document.querySelector('#healthy').innerHTML);
  check('② 子树正常时**原样透传**（没被兜底页换掉）', /healthy-child/.test(healthy) && /正常内容/.test(healthy), healthy.slice(0, 80));

  // D) 点「重试这一页」：错误还在 → 回到兜底页（不许留成半坏的样子）
  await page.locator('#with-boundary button', { hasText: '重试这一页' }).click();
  await page.waitForFunction(
    () => /这一页没能画出来/.test(document.querySelector('#with-boundary')?.textContent || ''),
    null, { timeout: 15000 },
  );
  check('② 点「重试这一页」后（错误仍在）回到兜底页，不是空白', true);

  const shot = path.join(harnessDir, 'fallback.png');
  await page.locator('#with-boundary').screenshot({ path: shot });
  console.log(`  · 兜底页截图：${path.relative(root, shot)}`);
} catch (error) {
  failures += 1;
  console.error('P167 抛错：', error?.message || error);
} finally {
  if (browser) await browser.close();
  await vite.close();
}

console.log('');
if (failures) { console.log(`✗ p167 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p167 渲染兜底（AppErrorBoundary）：全部通过');
assert.equal(failures, 0);
