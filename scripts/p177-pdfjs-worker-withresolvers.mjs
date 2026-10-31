/**
 * P177 教案 DOCX 预览：老 Safari 的 pdf.js **worker 作用域**必须拿到 `Promise.withResolvers`。
 *
 * 背景（2026-10-31，老师那台 Safari 17.0）：
 *   · 第一次只在主线程补 polyfill —— worker 是独立作用域，进不去；worker 里的
 *     `WorkerTask` / `ChunkedStreamManager` 一用就抛 TypeError（界面显示
 *     「文档解析失败：undefined is not a function (near '...(function () { })...')」）。
 *   · 第二次把 worker 模块 import 到主线程（fake worker）—— 不报错了，但 Safari 17.0
 *     **整页白屏**（PDF 本身有 11 页文字；Chromium/WebKit 26 都能画出来）。
 *   · 现在的改法：**真 worker + 自定义 worker entry**，在 worker 求值 pdf.worker 之前补
 *     polyfill（`pdfWorkerWithPolyfill.js`）。真 worker 里跑的是和 Safari 17.4+ 完全相同的
 *     渲染路径，只是多了一份 withResolvers。
 *
 * 这一道钉三件事：
 *   ① 源码：两个加载器在原生不支持时用 `workerPort = new PdfWorkerWithPolyfill()`；
 *      worker entry 的 import 顺序必须是「polyfill 模块 → pdf.worker」；
 *   ② 反向对照：真 worker 里删掉 withResolvers、走 URL+Range，**必须**失败
 *      （证明测试打到了 worker，而不是只测主线程）；
 *   ③ 修复路径：同一个 worker 里先补 polyfill 再加载 pdf.worker，URL+Range 必须解析
 *      **并且真的画出像素**（不能只测 getPage/文本 —— 白屏就是"能解析、画不出"）。
 *
 * 跑法：node scripts/p177-pdfjs-worker-withresolvers.mjs
 * ⚠️ 用 Node 22.13+（Vite 7）；本机 PATH 里的 node 可能偏旧。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = process.cwd();
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`); }
};

/* ── ① 源码口径 ─────────────────────────────────────────────────── */
console.log('\n① 源码：老浏览器用自定义真 worker，worker 内先补 polyfill');
const orgViewer = fs.readFileSync(path.join(root, 'apps/org/src/components/TeachingAssetViewer.jsx'), 'utf8');
const sharedFrame = fs.readFileSync(path.join(root, 'packages/shared/src/console/PreviewFrame.jsx'), 'utf8');
const orgWorker = fs.readFileSync(path.join(root, 'apps/org/src/components/pdfWorkerWithPolyfill.js'), 'utf8');
const sharedWorker = fs.readFileSync(path.join(root, 'packages/shared/src/console/pdfWorkerWithPolyfill.js'), 'utf8');
for (const [label, source] of [['TeachingAssetViewer', orgViewer], ['PreviewFrame', sharedFrame]]) {
  check(`① ${label} 有原生支持判断（补丁不能算原生）`,
    /hasNativePromiseWithResolvers/.test(source) && /__platformPreviewPolyfill/.test(source));
  check(`① ${label} 老浏览器用 workerPort + 自定义 worker entry`,
    /pdfWorkerWithPolyfill\.js\?worker/.test(source) && /workerPort = new PdfWorkerWithPolyfill\(\)/.test(source));
  check(`① ${label} 不再把 worker 模块 import 到主线程（fake worker 会白屏）`,
    !/import\('pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs'\)/.test(source));
  check(`① ${label} 仍走 legacy 主库与 legacy worker`,
    /pdfjs-dist\/legacy\/build\/pdf\.mjs/.test(source) && /pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url/.test(source));
}
for (const [label, source] of [['org', orgWorker], ['shared', sharedWorker]]) {
  const polyfillAt = source.indexOf("import './pdfWorkerPromiseWithResolvers.js'");
  const workerAt = source.indexOf("import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'");
  check(`① ${label} worker entry 先补 polyfill、再加载 pdf.worker`,
    polyfillAt >= 0 && workerAt > polyfillAt, `polyfill@${polyfillAt} worker@${workerAt}`);
}

/* ── ②/③ 真浏览器：反向对照 + 修复路径（含像素） ─────────────────── */
console.log('\n②/③ 真浏览器：worker 缺 withResolvers 必炸；补上后必须画出像素');
const harnessDir = path.join(root, '.tmp', 'p177-pdfjs-worker');
fs.rmSync(harnessDir, { recursive: true, force: true });
fs.mkdirSync(path.join(harnessDir, 'public'), { recursive: true });
fs.mkdirSync(path.join(harnessDir, 'worker'), { recursive: true });

// 最小合法 PDF（一页 Helvetica 文本），不依赖仓库文件
const pdfObjects = [
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
  '4 0 obj\n<< /Length 40 >>\nstream\nBT /F1 12 Tf 20 40 Td (Hi) Tj ET\nendstream\nendobj\n',
  '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
];
let pdfText = '%PDF-1.4\n';
const offsets = [];
for (const object of pdfObjects) { offsets.push(pdfText.length); pdfText += object; }
const xrefStart = pdfText.length;
pdfText += `xref\n0 ${pdfObjects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) pdfText += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdfText += `trailer\n<< /Size ${pdfObjects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
fs.writeFileSync(path.join(harnessDir, 'public/sample.pdf'), pdfText);
// 原样 worker（public 目录不做 Vite 转译）
fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
  path.join(harnessDir, 'public/pdf.worker.raw.mjs'));
// 反向对照：worker 模块求值完（会发 ready）后把 withResolvers 删掉
fs.writeFileSync(path.join(harnessDir, 'public/old-worker.mjs'),
  'import "/pdf.worker.raw.mjs";\ndelete Promise.withResolvers;\n');

// 修复路径的 worker entry：删掉原生 withResolvers（模拟 Safari 17.0），再按生产顺序补 polyfill。
fs.writeFileSync(path.join(harnessDir, 'worker/delete-with-resolvers.js'), 'delete Promise.withResolvers;\n');
fs.writeFileSync(path.join(harnessDir, 'worker/polyfill.js'), `
if (typeof Promise.withResolvers !== 'function') {
  const withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  withResolvers.__platformPreviewPolyfill = true;
  Promise.withResolvers = withResolvers;
}
`);
fs.writeFileSync(path.join(harnessDir, 'worker/entry.js'),
  "import './delete-with-resolvers.js';\nimport './polyfill.js';\nimport 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';\n");

fs.writeFileSync(path.join(harnessDir, 'index.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>p177 harness</title></head>
<body><div id="out">running</div><canvas id="cv"></canvas><script type="module" src="./harness.js"></script></body></html>
`);

fs.writeFileSync(path.join(harnessDir, 'harness.js'), `
import PdfWorkerWithPolyfill from './worker/entry.js?worker';
const out = document.getElementById('out');
const report = { worker: null, fixed: null, darkPixels: 0 };

const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
const options = { url: '/sample.pdf', rangeChunkSize: 100 }; // 强制 worker 建 ChunkedStreamManager

// ② 反向对照：真 worker 里没有 withResolvers → 必须失败
try {
  lib.GlobalWorkerOptions.workerSrc = '/old-worker.mjs';
  const doc = await Promise.race([
    lib.getDocument(options).promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 15s')), 15000)),
  ]);
  report.worker = 'unexpected success numPages=' + doc.numPages;
} catch (error) {
  report.worker = String(error?.message || error);
}

// ③ 修复路径：自定义 worker entry（真 worker，内部先补 polyfill）
try {
  lib.GlobalWorkerOptions.workerPort = new PdfWorkerWithPolyfill();
  const doc = await Promise.race([
    lib.getDocument(options).promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 20s')), 20000)),
  ]);
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.getElementById('cv');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) report.darkPixels += 1;
  }
  report.fixed = 'numPages=' + doc.numPages;
} catch (error) {
  report.fixed = 'THREW ' + String(error?.message || error);
}

out.textContent = 'REPORT ' + JSON.stringify(report);
`);

const port = 6900 + Math.floor(Math.random() * 200);
const vite = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'mpa',
  publicDir: path.join(harnessDir, 'public'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/.tmp/p177-pdfjs-worker/index.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => (document.getElementById('out')?.textContent || '').startsWith('REPORT '), null, { timeout: 60000 });
  const raw = await page.locator('#out').innerText();
  const report = JSON.parse(raw.replace(/^REPORT /, ''));
  console.log(`  报告：${JSON.stringify(report)}`);
  check('② ⭐ 反向对照：真 worker 缺 withResolvers 时 URL+Range 确实失败（报错含 withResolvers）',
    /withResolvers/i.test(String(report.worker)), String(report.worker));
  check('③ 自定义 worker entry（worker 内补 polyfill）解析成功',
    /numPages=1/.test(String(report.fixed)), String(report.fixed));
  check('③ ⭐ 而且真的画出了像素（白屏回归的口径）',
    Number(report.darkPixels) > 100, `darkPixels=${report.darkPixels}`);
} catch (error) {
  failures += 1;
  console.error('P177 浏览器那一段抛错：', error?.message || error);
} finally {
  if (browser) await browser.close();
  await vite.close();
}

console.log('');
if (failures) { console.log(`✗ p177 有 ${failures} 处不符合预期`); process.exit(1); }
assert.equal(failures, 0);
console.log('✓ p177 教案 DOCX 预览的 pdf.js worker 兼容（老 Safari）：全部通过');
