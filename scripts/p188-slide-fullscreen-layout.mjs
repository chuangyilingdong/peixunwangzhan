#!/usr/bin/env node
/**
 * P188 教学素材「PPT 原生放映」全屏布局守卫（2026-10-11）
 *
 * 用户报（两张截图）：图2 是课件预览（机构端备课抽屉），点「全屏放映」→ 图1：
 * **幻灯片不见了**，整屏只剩水印（"内部备课资料·请勿外传·时间"）与左右翻页键，
 * 屏幕正中一块 ~46×25 的白色小块 —— 那就是塌掉的幻灯片槽。
 *
 * 真因（复刻实验定位，数字对得上截图）：
 *   2026-10-05 为修「视频全屏只占 74vh」给 `.ta-panel:fullscreen .preview-stage` 加了
 *   `align-items:center`。原生放映台 `.ta-native-stage` 是那条 `:has()` 规则切过来的
 *   `position:static; flex:1` 子项：
 *     · 窗口内：父级是默认 `stretch` ⇒ 台面高度**由布局给**（确定值）⇒ 量它算 scale 是稳定的；
 *     · 全屏后：`align-items:center` 让台面高度变成**由内容决定**，而内容（幻灯片槽）的尺寸又是
 *       **量台面自己**算出来的 ⇒ 量一次缩一点、再量再缩，一路收敛到 0
 *       （实测：1680×1050 的台面被判成 1680×24，scale 成了 **−0.017**，槽塌成 42×24）。
 *   修法：`.ta-panel:fullscreen .ta-native-stage { align-self:stretch; }`（把原生台钉回"撑满"）。
 *
 * 本守卫做什么：用**真样式表**（`packages/shared/src/styles.css`）+ 真浏览器 + **真全屏 API**，
 * 配一个"同 class、同量算回路"的合成 DOM 复现那个回路。钉四件事：
 *   ① 源码口径：那条 `align-self:stretch` 在（并且 2026-10-05 的视频口径没被删）；
 *   ② 窗口内：台面高度是"由布局给"的（`align-self` 解析成 stretch），scale 落在合理区间；
 *   ③ 全屏后：原生台**必须撑满**（宽≈视口宽、高≥视口高的 70%）、scale > 1、槽宽 ≥ 视口宽的 80%
 *      —— 这一条就是"幻灯片没塌"；PDF 放映档（`.ta-slide-stage`，`position:absolute;inset:0`）
 *      同样必须撑满（它不走 flex 对齐，但一起钉住免得以后被顺手改坏）；
 *   ④ **反面**：把 `align-self` 强制回 `auto` ⇒ 必须**复现塌陷**（台面高 < 100px）——
 *      证明 ③ 那条断言不是空转（守卫自己得能红，口径同 p113/p137）。
 *
 * ⚠️ 它复现的是**布局机制**，不是真组件：真 .pptx 的解析要一份真课件（几 MB 二进制），
 *    p111 的文件头说明过为什么没把它放进自动网（要服务端 soffice / 真课件资源）。
 *    真课件那条路这次是**人工验的**：真课件（13 张）+ 真 pptx-preview，全屏前 0.741 / 全屏后 1.284、
 *    槽 1644×924；把修复撤掉立刻复现 1680×24（见交接文档 §一百一十七）。
 *
 * 跑法（需要 node ≥ 20 与 Chrome/Chromium；本机 node 16 跑不了，服务器上跑）：
 *   node scripts/p188-slide-fullscreen-layout.mjs
 *   CHROME_PATH=/usr/bin/chromium-browser node scripts/p188-slide-fullscreen-layout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.P188_PORT || 8793);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── ① 源码口径 ─────────────────────────────────────────────── */
console.log('① 源码口径（真样式表里的那两条口径）');
const css = readSource('packages/shared/src/styles.css');
check('① 原生台在全屏时被钉成"撑满"（这轮的修复本体，缺了幻灯片就会塌）',
  /\.ta-panel:fullscreen \.ta-native-stage\s*\{\s*align-self:\s*stretch\s*;?\s*\}/.test(css));
check('① 2026-10-05 那条视频口径没被删（音视频在全屏里仍按可用高度撑满）',
  /\.ta-panel:fullscreen \.preview-stage video,\s*\n?\.ta-panel:fullscreen \.preview-stage audio\s*\{\s*width:auto;\s*height:100%;/.test(css));
check('① 全屏时页眉/缩略图栏/工具栏仍然是收起来的（"只剩幻灯片本身"这条口径没变）',
  /\.ta-panel:fullscreen \.preview-head,\s*\n?\.ta-panel:fullscreen \.ta-native-rail,\s*\n?\.ta-panel:fullscreen \.ta-rail,\s*\n?\.ta-panel:fullscreen \.ta-toolbar\s*\{\s*display:none;\s*\}/.test(css));
const component = readSource('apps/org/src/components/TeachingAssetViewer.jsx');
const padding = Number((component.match(/const SLIDE_PADDING = (\d+);/) || [])[1] || 0);
check('① 组件里的量算回路仍是"量台面 → 算 scale → 写槽/宿主尺寸"（守卫按它复刻，常量一起读）',
  padding > 0 && /nativeScale = nativeBox\.width && slideBox\.width/.test(component.replace(/\s+/g, ' '))
  && /Math\.min\(\(slideBox\.width - SLIDE_PADDING\)/.test(component.replace(/\s+/g, ' ')));

/* ── 复刻页：真样式表 + 同 class + 同量算回路 ─────────────────── */
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/packages/shared/src/styles.css">
<style>body{margin:0}</style></head><body>
<div class="preview-overlay">
  <div class="preview-panel ta-panel" id="panel">
    <header class="preview-head" style="padding:14px 20px;background:#fff">课件标题（页眉）</header>
    <div class="preview-stage" id="stage">
      <div class="preview-watermark" aria-hidden="true">内部备课资料 · 请勿外传 · 2026/10/11 14:14:05</div>
      <div class="ta-native-rail"><button class="ta-thumb on"><div class="ta-thumb-view" style="width:168px;height:94px;background:#fff"></div><span>1</span></button></div>
      <div class="ta-native-stage" id="nativeStage">
        <div class="ta-native-slot" id="slot">
          <div class="ta-native-host" id="host">
            <div class="pptx-preview-wrapper">
              <div class="pptx-preview-slide-wrapper on" style="width:1280px;height:720px;background:linear-gradient(135deg,#3b2e63,#1b1630)"></div>
            </div>
          </div>
        </div>
        <button class="ta-slide-nav prev">‹</button>
        <button class="ta-slide-nav next">›</button>
      </div>
      <div class="ta-slide-stage" id="slideStage"><div class="ta-slide-slot" style="width:800px;height:450px"></div></div>
    </div>
    <div class="ta-toolbar">第 1 / 共 13 张 · 100%　<button id="goFs">全屏放映</button></div>
  </div>
</div>
<script>
  var SLIDE_PADDING = ${padding || 36}, NB = { width: 1280, height: 720 };
  var slideBox = { width: 0, height: 0 }, stage = document.getElementById('nativeStage');
  var slot = document.getElementById('slot'), host = document.getElementById('host');
  function apply() {
    var scale = (slideBox.width && slideBox.height)
      ? Math.min((slideBox.width - SLIDE_PADDING) / NB.width, (slideBox.height - SLIDE_PADDING) / NB.height) : 0;
    window.__scale = scale;
    if (scale) {
      slot.style.width = Math.floor(NB.width * scale) + 'px';
      slot.style.height = Math.floor(NB.height * scale) + 'px';
      host.style.width = NB.width + 'px'; host.style.height = NB.height + 'px';
      host.style.transform = 'scale(' + scale + ')'; host.style.transformOrigin = 'top left';
    }
  }
  new ResizeObserver(function () { slideBox = { width: stage.clientWidth, height: stage.clientHeight }; apply(); }).observe(stage);
  slideBox = { width: stage.clientWidth, height: stage.clientHeight }; apply();
  window.__snapshot = function () {
    var r = function (el) { return el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null; };
    return {
      fullscreen: Boolean(document.fullscreenElement), viewport: { w: window.innerWidth, h: window.innerHeight },
      stage: r(document.getElementById('stage')),
      nativeStage: r(stage), slideStage: r(document.getElementById('slideStage')),
      slideBox: { ...slideBox }, scale: Number((window.__scale || 0).toFixed(3)), slot: r(slot),
      alignSelf: getComputedStyle(stage).alignSelf,
    };
  };
  document.getElementById('goFs').addEventListener('click', function () {
    document.getElementById('panel').requestFullscreen().catch(function (e) { window.__fsErr = String(e); });
  });
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(String(req.url).split('?')[0]);
  if (url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return; }
  const file = path.join(ROOT, url);
  if (url.startsWith('/packages/') && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': url.endsWith('.css') ? 'text/css' : 'text/plain' });
    res.end(fs.readFileSync(file));
    return;
  }
  res.writeHead(404); res.end('nope');
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  const windowed = await page.evaluate(() => window.__snapshot());
  console.log('  · 窗口内：', JSON.stringify(windowed));

  console.log('② 窗口内（基准）');
  // ⚠️ 别断言 computed `align-self`（窗口内它就是 `auto` —— `auto` 退化成父级的 `align-items`，
  //    行为上就是 stretch）。要钉的是**行为**：台面高度必须来自布局（≈ 舞台高）；
  //    一旦变成"由内容决定"，它就走上那条"量一次缩一点"的回路，一路塌到 0。
  check('② 台面高度"由布局给"（≈ 舞台高）',
    windowed.nativeStage.h >= windowed.stage.h * 0.9,
    `台面 ${windowed.nativeStage.h} vs 舞台 ${windowed.stage.h}`);
  check('② scale 落在合理区间（0.3~1.2：既没放大到离谱，也没塌）',
    windowed.scale > 0.3 && windowed.scale < 1.2, `实际 ${windowed.scale}`);
  check('② 幻灯片槽是"整张装下"的常规尺寸（宽 ≥ 台面宽的 80%）',
    windowed.slot.w >= windowed.nativeStage.w * 0.8, JSON.stringify(windowed.slot));

  console.log('③ 全屏后（用户图1 的那一步）');
  await page.click('#goFs');
  await page.waitForTimeout(1200);
  const full = await page.evaluate(() => window.__snapshot());
  console.log('  · 全屏后：', JSON.stringify(full));
  check('③ 真的进了全屏（全屏元素是查看器面板）', full.fullscreen === true);
  check('③ ⭐ 原生台撑满整屏（宽=视口宽、高 ≥ 视口高的 70% —— 塌陷时这里是 24px）',
    Math.abs(full.nativeStage.w - full.viewport.w) <= 2 && full.nativeStage.h >= full.viewport.h * 0.7,
    `${JSON.stringify(full.nativeStage)} vs 视口 ${JSON.stringify(full.viewport)}`);
  check('③ ⭐ 幻灯片槽跟着铺满（宽 ≥ 视口宽的 80%）——"全屏后只剩幻灯片本身"',
    full.slot.w >= full.viewport.w * 0.8, JSON.stringify(full.slot));
  check('③ 缩放是"整张放大到装下"的（>1，且不是负/近零）', full.scale > 1, `实际 ${full.scale}`);
  check('③ PDF 放映档在全屏里同样撑满（它走 position:absolute; inset:0，别被顺手改坏）',
    Math.abs(full.slideStage.w - full.viewport.w) <= 2 && full.slideStage.h >= full.viewport.h * 0.7,
    JSON.stringify(full.slideStage));

  console.log('④ 反面：把修复撤掉必须复现塌陷（守卫自己得能红）');
  await page.addStyleTag({ content: '.ta-panel:fullscreen .ta-native-stage { align-self:auto !important; }' });
  await page.waitForTimeout(1200);
  const broken = await page.evaluate(() => window.__snapshot());
  console.log('  · 撤掉修复：', JSON.stringify(broken));
  check('④ 撤掉 align-self:stretch 后，台面高度塌到 <100px（= 用户图1 那个白块）',
    broken.nativeStage.h < 100, `${broken.nativeStage.h}px`);
  check('④ 同时 scale 变成 ≤0（算不出正缩放）——这就是"幻灯片不见了"的直接原因',
    broken.scale <= 0, `实际 ${broken.scale}`);
} finally {
  await browser.close();
  server.close();
}

/* ── ⑤ 生产口径：那两处线上包（机构端 / 平台端）里得真的带上修复 ──────────────
   仓库改了、包没重建 = 线上还是"幻灯片全屏后消失"，所以这一条单独钉（与 p187 的 ④d 同款）。 */
const SITE = String((process.argv.find((item) => item.startsWith('--site=')) || '').split('=')[1] || 'https://aicyld.com').replace(/\/+$/, '');
console.log(`⑤ 生产口径（${SITE}）：线上样式里带着这条修复`);
try {
  for (const [appPath, label] of [['org', '机构端'], ['admin', '平台端']]) {
    const entry = await (await fetch(`${SITE}/${appPath}/`)).text();
    const assets = [...entry.matchAll(/assets\/index-[A-Za-z0-9_-]+\.css/g)].map((m) => m[0]);
    let found = false;
    let seen = '';
    for (const asset of assets) {
      const text = await (await fetch(`${SITE}/${appPath}/${asset}`)).text();
      seen += ` ${asset}(${text.length})`;
      if (/\.ta-panel:fullscreen\s+\.ta-native-stage\s*\{\s*align-self:\s*stretch/.test(text)) { found = true; break; }
    }
    check(`⑤ ${label}（/${appPath}/）的线上样式里已含 \`.ta-panel:fullscreen .ta-native-stage{align-self:stretch}\``,
      found, `查了:${seen.trim() || '(没找到 css 资源)'}`);
  }
} catch (error) {
  check('⑤ 生产口径可跑（站点可达）', false, String(error?.message || error).slice(0, 160));
}

console.log(JSON.stringify({ name: 'slide-fullscreen-layout', pass: failures === 0, failures, site: SITE }, null, 2));
process.exit(failures ? 1 : 0);
