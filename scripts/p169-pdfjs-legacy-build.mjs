/**
 * P169 课件预览的 pdf.js **必须能在老浏览器上加载**（2026-09-30 用户报的线上问题）。
 *
 * 现象（用户原话）：「为什么我的电脑解析是正常的，别的电脑有这个报错」——图里是机构端
 * 「在线预览（不提供下载）」的教案，报 **「文档解析失败：Iterator is not defined」**。
 *
 * 真因（实测复现，不是猜）：`pdfjs-dist` 6.x 的**主构建**在**模块求值**时就去碰原生全局 `Iterator`：
 *   `if (typeof Iterator.prototype.join !== "function") { Iterator.prototype.join = … }`
 * 而 `Iterator` 是 **Chrome 122 / Safari 17.4 / Firefox 129 才有的新全局** —— 老一点的浏览器
 * （Chrome/Edge 110~121、360/QQ 老内核…）**一 import 就抛 `ReferenceError: Iterator is not defined`**，
 * 于是"我这台（新 Chrome）正常、别人的电脑报错"。这不是我们的代码，是依赖对浏览器版本的要求。
 * ⚠️ 两份构建里**那一行是一模一样的**，区别在：官方另发的 **legacy 构建带了 core-js 运行时补丁**，
 *    进来先把老浏览器缺的原生 API（含 `Iterator`）装上，所以轮到那行时它已经存在 ✓（实测）。
 *    （守卫 ② 的"反向对照"就是这个意思：主入口在同样环境下确实会炸。）
 *
 * 这一道钉两件事（缺一不可）：
 *   ① **源码**：预览组件引用的是 legacy 路径（主入口与非 legacy 的 worker 都不许再出现）；
 *   ② **行为**：在**删掉 `Iterator` 全局**的子进程里真 import 一次 —— legacy 必须成功，
 *      并且**顺带证明这条网是有效的**：同一个子进程里 import 主入口必须抛 `Iterator is not defined`
 *      （如果哪天主入口不再依赖 Iterator 了，这条会红，提醒我们把守卫口径改准，而不是留一条永远绿的假网）。
 *
 * 跑法：node scripts/p169-pdfjs-legacy-build.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { stripComments } from './lib/sourceText.mjs';

const root = process.cwd();
// ③ 那条要真浏览器（与 p111 / p115 同一套口径，可用 CHROME_PATH 覆盖）
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`); }
};

/* ── ① 源码：预览组件走 legacy 路径 ───────────────────────────────── */
console.log('\n① 源码口径：预览组件引用 pdfjs 的 legacy 构建');
const viewerPath = 'apps/org/src/components/TeachingAssetViewer.jsx';
const viewer = stripComments(fs.readFileSync(path.join(root, viewerPath), 'utf8'));
check('① 主库走 `pdfjs-dist/legacy/build/pdf.mjs`',
  /import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/.test(viewer));
check('① worker 也走 legacy（`pdfjs-dist/legacy/build/pdf.worker.min.mjs?url`）',
  /import\('pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url'\)/.test(viewer));
check('① 不再引用主入口 `import(\'pdfjs-dist\')`（那正是会炸的那份）',
  !/import\('pdfjs-dist'\)/.test(viewer));
check('① 也不再用非 legacy 的 worker 路径',
  !/import\('pdfjs-dist\/build\//.test(viewer));
check('① 全仓源码里没有别处再引 pdfjs 主入口',
  !fs.readdirSync(path.join(root, 'apps')).some((app) => {
    const dir = path.join(root, 'apps', app, 'src');
    if (!fs.existsSync(dir)) return false;
    return (function walk(current) {
      return fs.readdirSync(current, { withFileTypes: true }).some((entry) => {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (!/\.(jsx?|mjs)$/.test(entry.name)) return false;
        return /import\('pdfjs-dist'\)|import\('pdfjs-dist\/build\//.test(fs.readFileSync(full, 'utf8'));
      });
    })(dir);
  }));

/* ── ② 行为：在没有 `Iterator` 的环境里真 import 一次 ─────────────── */
console.log('\n② 行为口径：删掉 `Iterator` 全局（模拟老浏览器）后真 import');
const legacyWorker = path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs');
check('② legacy 的 worker 文件确实存在（路径写错的话只有真跑才炸）', fs.existsSync(legacyWorker), legacyWorker);

const probe = `
delete globalThis.Iterator;
const report = { iteratorGone: typeof Iterator === 'undefined', legacy: null, iteratorBackAfterLegacy: null, mainEntry: null };
try { await import('pdfjs-dist/legacy/build/pdf.mjs'); report.legacy = 'ok'; }
catch (error) { report.legacy = error.constructor.name + ': ' + error.message; }
// ⚠️ legacy 构建**自己会装一个 Iterator**（core-js 的补丁）—— 所以测主入口之前必须再删一次，
//    否则会得到"主入口也没事"的假结论（第一次跑就是这么被骗的）。
report.iteratorBackAfterLegacy = typeof Iterator !== 'undefined';
delete globalThis.Iterator;
try { await import('pdfjs-dist'); report.mainEntry = 'ok'; }
catch (error) { report.mainEntry = error.constructor.name + ': ' + error.message; }
console.log(JSON.stringify(report));
`;
const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: root, encoding: 'utf8' });
let result = null;
try { result = JSON.parse(String(child.stdout || '').trim().split('\n').pop()); } catch { /* 下面报 */ }
check('② 子进程确实把 `Iterator` 删掉了（复现"老浏览器"）', result?.iteratorGone === true, JSON.stringify(child.stdout || child.stderr).slice(0, 300));
check('② legacy 构建在"没有 Iterator"的环境里 import 成功', result?.legacy === 'ok', String(result?.legacy));
check('② ⭐ 反向对照：主入口在同样环境下**确实会炸**（`Iterator is not defined`）—— 证明这条网有效',
  /ReferenceError: Iterator is not defined/.test(String(result?.mainEntry || '')), String(result?.mainEntry));

/* ── ③ 真浏览器：在没有 `Iterator` 的环境里**真渲染出一页 PDF** ──────── */
// ② 只证明"能 import"；这一条证明"能干活"（老浏览器上真正缺的是整个 pdf.js 的可用性）。
console.log('\n③ 真浏览器：删掉 `Iterator` 后，用 legacy 构建真解析并渲染一页 PDF');
const harnessDir = path.join(root, '.tmp', 'p169-pdfjs');
fs.rmSync(harnessDir, { recursive: true, force: true });
fs.mkdirSync(harnessDir, { recursive: true });
fs.writeFileSync(path.join(harnessDir, 'index.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>p169 harness</title></head>
<body>
  <div id="out">running</div>
  <canvas id="cv" width="200" height="100"></canvas>
  <script type="module" src="./harness.jsx"></script>
</body></html>
`);
fs.writeFileSync(path.join(harnessDir, 'harness.jsx'), `// ⚠️ 第一件事就把 Iterator 删掉（模拟 Chrome<122），且要在 import('pdfjs') **之前**
delete globalThis.Iterator;
const out = document.getElementById('out');
const lines = ['Iterator gone: ' + (typeof Iterator === 'undefined')];
try {
  // 与预览组件**同一个 specifier**
  const [lib, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  // 现造一份最小合法 PDF（一页、一句话），不依赖仓库里任何文件
  const objects = [
    '1 0 obj\\n<< /Type /Catalog /Pages 2 0 R >>\\nendobj\\n',
    '2 0 obj\\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\\nendobj\\n',
    '3 0 obj\\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\\nendobj\\n',
    '4 0 obj\\n<< /Length 40 >>\\nstream\\nBT /F1 12 Tf 20 40 Td (Hi) Tj ET\\nendstream\\nendobj\\n',
    '5 0 obj\\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\\nendobj\\n',
  ];
  let pdf = '%PDF-1.4\\n';
  const offsets = [];
  for (const obj of objects) { offsets.push(pdf.length); pdf += obj; }
  const xrefStart = pdf.length;
  pdf += 'xref\\n0 ' + (objects.length + 1) + '\\n0000000000 65535 f \\n';
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \\n';
  pdf += 'trailer\\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\\nstartxref\\n' + xrefStart + '\\n%%EOF\\n';
  const doc = await lib.getDocument({ data: new TextEncoder().encode(pdf) }).promise;
  lines.push('numPages: ' + doc.numPages);
  const page = await doc.getPage(1);
  const text = (await page.getTextContent()).items.map((item) => item.str).join('');
  lines.push('text: ' + text);
  await page.render({ canvasContext: document.getElementById('cv').getContext('2d'), viewport: page.getViewport({ scale: 1 }) }).promise;
  lines.push('rendered: yes');
} catch (error) {
  lines.push('THREW: ' + error.constructor.name + ': ' + error.message);
}
out.textContent = lines.join(' | ');
`);

const { createServer } = await import('vite');
const port = 6000 + Math.floor(Math.random() * 300);
const vite = await createServer({
  root, configFile: false, logLevel: 'error',
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  server: { host: '127.0.0.1', port, strictPort: true },
});
let browser;
try {
  await vite.listen();
  // 先热（vite dev 首次要转译 + 预打包；不先热会在负载下超时 —— p167 踩过）
  let warmed = false;
  for (let attempt = 0; attempt < 90 && !warmed; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.tmp/p169-pdfjs/harness.jsx`);
      if (response.ok) { await response.text(); warmed = true; }
    } catch { /* 还没起来 */ }
    if (!warmed) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check('③ vite dev 起来了（入口模块能取到）', warmed, warmed ? '' : '90 秒内没热起来');
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/.tmp/p169-pdfjs/index.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => document.getElementById('out')?.textContent?.includes('rendered') || document.getElementById('out')?.textContent?.includes('THREW'), null, { timeout: 30000 });
  const text = await page.locator('#out').innerText();
  check('③ 页面里 `Iterator` 确实是缺的（模拟成立）', /Iterator gone: true/.test(text), text.slice(0, 200));
  check('③ legacy 构建在没有 `Iterator` 的浏览器里解析成功（numPages=1、文本读得到）',
    /numPages: 1/.test(text) && /text: Hi/.test(text), text.slice(0, 240));
  check('③ 并且真的渲染出来了（render 不抛错）', /rendered: yes/.test(text), text.slice(0, 240));
} catch (error) {
  failures += 1;
  console.error('P169 浏览器那一段抛错：', error?.message || error);
} finally {
  if (browser) await browser.close();
  await vite.close();
}

console.log('');
if (failures) { console.log(`✗ p169 有 ${failures} 处不符合预期`); process.exit(1); }
assert.equal(failures, 0);
console.log('✓ p169 课件预览的 pdf.js 老浏览器兼容（legacy 构建）：全部通过');
