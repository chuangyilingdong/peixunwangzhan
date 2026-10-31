/**
 * P177 教案 DOCX 预览：pdf.js 的 **worker 作用域**也必须拿到 `Promise.withResolvers`。
 *
 * 背景（2026-10-31 第二次报障，老师用 Safari）：
 *   第一次只补了主线程的 polyfill，以为 worker 不需要；实际 pdf.js 的 worker 是**独立作用域**，
 *   主线程的补丁进不去。worker 里的 `WorkerTask` / `ChunkedStreamManager`（预览地址走 Range
 *   请求时必建）都会调 `Promise.withResolvers`，于是在 worker 里抛 TypeError，经 MessageHandler
 *   包成 `UnknownErrorException` 回到界面 —— Safari 显示成
 *   「文档解析失败：undefined is not a function (near '...(function () { })...')」。
 *
 * 这一道钉三件事：
 *   ① 源码：两个加载器都在“原生不支持”时把 worker 模块 import 到主线程（fake worker），
 *      并用 `__platformPreviewPolyfill` 标记区分原生/补丁；
 *   ② 反向对照：真 worker 里删掉 `withResolvers`、走 URL+Range，**必须**失败
 *      （证明这条测试确实能打到 worker，而不是只测了主线程）；
 *   ③ 修复路径：主线程补 polyfill + worker 模块 import 到主线程（pdf.js 改用 fake worker），
 *      同样的 URL+Range 必须解析成功。
 *
 * 跑法：node scripts/p177-pdfjs-worker-withresolvers.mjs
 * ⚠️ 要用 Node 22.13+（Vite 7）；本机 PATH 里的 node 可能偏旧，必要时显式指定。
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
console.log('\n① 源码：老浏览器走 fake worker，且用标记区分原生/补丁');
const orgViewer = fs.readFileSync(path.join(root, 'apps/org/src/components/TeachingAssetViewer.jsx'), 'utf8');
const sharedFrame = fs.readFileSync(path.join(root, 'packages/shared/src/console/PreviewFrame.jsx'), 'utf8');
for (const [label, source] of [['TeachingAssetViewer', orgViewer], ['PreviewFrame', sharedFrame]]) {
  check(`① ${label} 有原生支持判断（补丁不能算原生）`,
    /hasNativePromiseWithResolvers/.test(source) && /__platformPreviewPolyfill/.test(source));
  check(`① ${label} 原生不支持时把 worker import 到主线程（fake worker）`,
    /nativeWithResolvers[\s\S]{0,900}import\('pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs'\)/.test(source));
  check(`① ${label} 仍走 legacy 主库与 legacy worker`,
    /pdfjs-dist\/legacy\/build\/pdf\.mjs/.test(source) && /pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url/.test(source));
}

/* ── ②/③ 真浏览器：反向对照 + 修复路径 ──────────────────────────── */
console.log('\n②/③ 真浏览器：worker 缺 withResolvers 必炸；fake worker 必须能解析 URL+Range');
const harnessDir = path.join(root, '.tmp', 'p177-pdfjs-worker');
fs.rmSync(harnessDir, { recursive: true, force: true });
fs.mkdirSync(path.join(harnessDir, 'public'), { recursive: true });

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

fs.writeFileSync(path.join(harnessDir, 'index.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>p177 harness</title></head>
<body><div id="out">running</div><script type="module" src="./harness.js"></script></body></html>
`);

fs.writeFileSync(path.join(harnessDir, 'harness.js'), `
const out = document.getElementById('out');
const report = { pageWithResolvers: null, worker: null, fixed: null };

// 模拟 Safari < 17.4：主线程也没有 withResolvers
delete Promise.withResolvers;
const marker = '__platformPreviewPolyfill';
if (typeof Promise.withResolvers !== 'function') {
  const withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  withResolvers[marker] = true;
  Promise.withResolvers = withResolvers;
}
report.pageWithResolvers = typeof Promise.withResolvers === 'function' && !Promise.withResolvers[marker];

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

// ③ 修复路径：worker 模块 import 到主线程 → pdf.js 自动 fake worker
try {
  await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  const doc = await Promise.race([
    lib.getDocument(options).promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 20s')), 20000)),
  ]);
  const page = await doc.getPage(1);
  const text = (await page.getTextContent()).items.map((item) => item.str).join('');
  report.fixed = 'numPages=' + doc.numPages + ' text=' + text;
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
  check('② 页面里确实没有原生 withResolvers（模拟成立）', report.pageWithResolvers === false, String(report.pageWithResolvers));
  check('② ⭐ 反向对照：真 worker 缺 withResolvers 时 URL+Range 确实失败（报错含 withResolvers）',
    /withResolvers/i.test(String(report.worker)), String(report.worker));
  check('③ 主线程补丁 + worker 模块 import 到主线程后，同一份 PDF 解析成功',
    /numPages=1/.test(String(report.fixed)) && /text=Hi/.test(String(report.fixed)), String(report.fixed));
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
