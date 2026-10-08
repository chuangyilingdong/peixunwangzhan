#!/usr/bin/env node
/**
 * P187 作品「大模型桥」守卫（2026-10-08，§一百一十五）
 *
 * 为什么需要它：用户拿一件学生作品来问「填了大模型的 Key 为什么跑不起来」——
 *   https://aicyld.com/s/shs_ef2cc10bd95340abb8d9afaf （作品 `summary.html`，界面里已有「接口设置」）
 * 真因不在 Key：那件作品是**前端 + 自带 Node 后端**的完整工程（旁边还有「启动智能内容总结.bat」），
 * 网页里 `fetch('/api/llm')` 打的是作者本机那份后端。作品提交到平台时只有入口 HTML，后端不跟着来，于是：
 *   · 请求落到我们的 `/api/llm` → 404（平台上没有这条路由）；
 *   · 而且沙箱文档是 **opaque origin**（`Origin: null`），我们的 API 不给 null origin 发 ACAO
 *     ⇒ 浏览器直接 `net::ERR_FAILED`，作品 `.catch` 把进度文案设成「已中止」。
 * 生产实测复现（2026-10-08，真浏览器 + 分享页）：`POST /api/llm` → preflight 失败 →「已中止」。
 *
 * 这一轮加的「大模型桥」把这条约定在**学生文档里**翻译成「浏览器直连厂商的 `/chat/completions`」：
 *   Key 与请求都不经过平台服务器；沙箱本来就能出网（预览壳 CSP `connect-src https: wss:`），
 *   厂商侧给 CORS 就通（DeepSeek / 月之暗面 / 智谱 / 火山 / 百炼 / 硅基流动实测都放行 `Origin: null`）。
 *
 * 本守卫钉四层（缺一层都可能是"改完看着对、线上一用就废"）：
 *   ① 源码口径：桥在、preamble 顺序对（PDF 桥仍最后）、**桥体里没有 postMessage**（Key 不出沙箱）、
 *      `/api/fetch` 不代理（SSRF 面另议）、超时给够（≥120s）；
 *   ② 本地真浏览器（真转发壳 + 假厂商，两条腿都要）：成功路径 / 厂商 401 / 厂商不给 CORS /
 *      没填 Key / 机构端那段收紧 meta CSP —— 五种路各自的话必须是人话，而且**不能打到我们自己的 /api/llm**；
 *   ③ 「平台不拦」这条承诺本身：生产 `/vibe-preview.html` 的 CSP 仍放行 https；
 *      官网那四个入口（分享页 / 广场 / 网站端弹窗 / 学生工作台）没有收紧的禁网 meta；
 *      老师端 / 平台端那两处**仍按旧口径禁网**（改动必须是显式的，别悄悄放开）。
 *   ④ 生产口径（默认 https://aicyld.com）：把测试页投进**生产**的壳，用**假 Key** 打真 DeepSeek ——
 *      必须拿回"厂商的鉴权错误"（证明 CSP + CORS + 桥三段全通），而不是我们平台自己的 404。
 *
 * 跑法（需要 node ≥ 20 与 Chrome/Chromium；本机 node 16 跑不了，服务器上跑）：
 *   node scripts/p187-llm-bridge.mjs
 *   node scripts/p187-llm-bridge.mjs --site=https://aicyld.com   # 换站点只影响第③④层
 *   CHROME_PATH=/usr/bin/chromium-browser node scripts/p187-llm-bridge.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item === `--${name}` || item.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : true;
};
const SITE = String(arg('site', 'https://aicyld.com')).replace(/\/+$/, '');
const SITE_PORT = Number(process.env.P187_SITE_PORT || 8797);       // 本地"站点"（发真壳）
const PROVIDER_PORT = Number(process.env.P187_PROVIDER_PORT || 8798); // 假厂商（回 ACAO，像 DeepSeek）
const NOCORS_PORT = Number(process.env.P187_NOCORS_PORT || 8799);     // 假厂商（不答 preflight）

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ───────────────────────── ① 源码口径 ─────────────────────────
console.log('① 源码口径');
const project = readSource('packages/shared/src/vibecodingProject.js');
const bridgeBody = project.split('export const LLM_BRIDGE = `')[1]?.split('`;\n')[0] || '';
// ⚠️ bridgeBody 是**模板的源码文本**（`\\` 注入到浏览器里才变成 `\`）—— 文本级断言先归一，
//    否则会去匹配一个浏览器里根本不存在的双反斜杠写法（本探针第一版就踩了这个）。
const bridgeText = bridgeBody.replace(/\\\\/g, '\\');
check('桥在（LLM_BRIDGE 被导出了，而且不是空壳）', /export const LLM_BRIDGE = `/.test(project) && bridgeBody.length > 1500, `桥体 ${bridgeBody.length} 字符`);
check('接的是作品那套约定：拦 POST /api/llm', bridgeText.includes('/\\/api\\/llm$/') && bridgeBody.includes("'POST'"),
  '桥体里没找到 /api/llm 的拦截');
check('翻译成厂商的 /chat/completions + Authorization: Bearer', bridgeBody.includes("'/chat/completions'")
  && bridgeBody.includes("'Authorization':'Bearer '+key"));
check('回包是作者后端的形状：{ok:true,content} / {ok:false,error,hint}', bridgeBody.includes('{ok:true')
  && bridgeBody.includes("function fail(error,hint)")); // NOSONAR —— 断言的是源码文本
check('⭐ Key 不出沙箱：桥体里没有任何 postMessage（Key 只进 Authorization 头）',
  bridgeBody.length > 0 && !bridgeBody.includes('postMessage'));
check('/api/fetch（按链接抓网页）不代理，只回一句人话 —— SSRF 面另议',
  bridgeText.includes('/\\/api\\/fetch$/') && bridgeBody.includes('平台不代理') && !bridgeBody.includes('vibecoding-asset-fetch'));
check('老师端/平台端那段禁网 meta 认得出来（先说环境、再说 Key）', bridgeBody.includes('metaBlocksNetwork')
  && bridgeBody.includes('这个预览窗口关掉了作品的联网'));
const timeout = Number((bridgeBody.match(/var TIMEOUT=(\d+);/) || [])[1] || 0);
check('超时给够（≥120s：长文 + 推理模型慢起来没谱）', timeout >= 120000, `实际 ${timeout}`);
check('preamble 顺序：存储替身 → 控制台桥 → 高度上报 → 素材桥 → 大模型桥 → PDF 桥（PDF 仍最后）',
  /\$\{SANDBOX_STORAGE_SHIM\}\$\{CONSOLE_BRIDGE\}\$\{PREVIEW_HEIGHT_BRIDGE\}\$\{ASSET_FETCH_BRIDGE\}\$\{LLM_BRIDGE\}\$\{PDF_BRIDGE\}/.test(project));
check('/api/config 仍给非敏感默认值（Key 永远来自本机浏览器）',
  bridgeText.includes('/\\/api\\/config$/') && bridgeBody.includes('function platformConfig')
  && bridgeBody.includes("DEFAULT_BASE='https://api.deepseek.com/v1'"));
check('只管自己的地址：其余 fetch 原样放行（含桥自身异常时的兜底）',
  bridgeText.includes('return realFetch?realFetch(input,init)')
  && bridgeBody.includes('桥自己出问题不能连累作品原本的 fetch'));

// ───────────────────── ② 本地真浏览器（真壳 + 假厂商） ─────────────────────
console.log('② 本地真浏览器（真转发壳 + 假厂商）');
const { buildPreviewDocument } = await import(new URL('../packages/shared/src/vibecodingProject.js', import.meta.url).href);
const shellHtml = fs.readFileSync(path.join(ROOT, 'apps/website/public/vibe-preview.html'));
const seen = { llmOnSite: 0, provider: [], nocors: [] };

const corsHeaders = (req) => ({
  'access-control-allow-origin': req.headers.origin || '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-credentials': 'true',
});
// 假厂商（像 DeepSeek）：答 preflight、认 Bearer、把收到的 payload 原样回显在正文里
const provider = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(req)); res.end(); return; }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 非 JSON 就按空处理 */ }
    seen.provider.push({ path: req.url, auth: String(req.headers.authorization || ''), body });
    if (!/^Bearer sk-p187-ok/.test(String(req.headers.authorization || ''))) {
      res.writeHead(401, { ...corsHeaders(req), 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key: ****-p187 is invalid', type: 'authentication_error' } }));
      return;
    }
    res.writeHead(200, { ...corsHeaders(req), 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: body?.model || 'x',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `FAKE-OK ${JSON.stringify(body)}` } }],
      usage: { total_tokens: 8 },
    }));
  });
});
// 假厂商（不允许浏览器直连的那种）：一个 CORS 头都不给
const nocors = http.createServer((req, res) => {
  // ⚠️ preflight 也要记：CORS 不给头时，浏览器**只发 OPTIONS、不发 POST** ——
  //    只记 POST 的话这条断言永远是空的（本探针第一版就是这么错的）。
  seen.nocors.push({ method: req.method, path: req.url });
  if (req.method === 'OPTIONS') { res.writeHead(405); res.end(); return; }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"message":{"content":"不该到这里"}}]}'); });
});
const GUARD_HTML = `<!doctype html><html><body><script>
  window.__out = [];
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (data && typeof data === 'object' && data.__p187) window.__out.push(data.out);
  });
</script></body></html>`;
const site = http.createServer((req, res) => {
  if (String(req.url).includes('/api/llm')) seen.llmOnSite += 1;   // 桥没接住才会打到这里
  if (req.url === '/vibe-preview.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(shellHtml); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(GUARD_HTML);
});
await new Promise((resolve) => site.listen(SITE_PORT, '127.0.0.1', resolve));
await new Promise((resolve) => provider.listen(PROVIDER_PORT, '127.0.0.1', resolve));
await new Promise((resolve) => nocors.listen(NOCORS_PORT, '127.0.0.1', resolve));

// 学生页：把「填了 Key 的作品」会走的那几种路各打一遍，每步把结果回传（父页收 __p187）
const STUDENT = `<!doctype html><html><body><p>run</p><script>
(async function(){
  function post(name, value){ try{ window.top.postMessage({ __p187:true, out:{name:name, value:value} }, '*'); }catch(e){} }
  async function call(body){
    try{
      var r = await fetch('/api/llm', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      return await r.json();
    }catch(e){ return { threw: String((e && e.message) || e) }; }
  }
  post('ok', await call({ apiKey:'sk-p187-ok', baseUrl:'http://127.0.0.1:${PROVIDER_PORT}/v1', model:'deepseek-chat',
    messages:[{role:'user',content:'hi'}], temperature:0.2, json:true }));
  post('auth', await call({ apiKey:'sk-p187-wrong', baseUrl:'http://127.0.0.1:${PROVIDER_PORT}/v1', model:'deepseek-chat', messages:[{role:'user',content:'hi'}] }));
  post('nocors', await call({ apiKey:'sk-p187-ok', baseUrl:'http://127.0.0.1:${NOCORS_PORT}/v1', model:'deepseek-chat', messages:[{role:'user',content:'hi'}] }));
  post('nokey', await call({ apiKey:'', baseUrl:'http://127.0.0.1:${PROVIDER_PORT}/v1', model:'m', messages:[] }));
  try{ post('config', await (await fetch('/api/config')).json()); }catch(e){ post('config', { threw:String(e) }); }
  try{ post('fetch', await (await fetch('/api/fetch', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{"url":"https://example.com"}' })).json()); }catch(e){ post('fetch', { threw:String(e) }); }
})();
</script></body></html>`;

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
let pageErrors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error.message || error)));
  const runStudent = async (studentHtml) => {
    await page.goto(`http://127.0.0.1:${SITE_PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(150);
    const doc = buildPreviewDocument({ 'index.html': studentHtml }, 'index.html');
    await page.evaluate((html) => {
      const frame = document.createElement('iframe');
      frame.id = 'shell';
      frame.src = '/vibe-preview.html';
      frame.style.cssText = 'width:900px;height:600px';
      document.body.appendChild(frame);
      frame.onload = () => frame.contentWindow.postMessage({ source: 'vibecoding-preview', html }, '*');
    }, doc);
    await page.waitForTimeout(2500);
    return Object.fromEntries((await page.evaluate(() => window.__out || [])).map((item) => [item.name, item.value]));
  };

  const out = await runStudent(STUDENT);
  check('成功路：厂商 200 → 作品拿到 {ok:true,content}', out.ok?.ok === true && String(out.ok?.content || '').startsWith('FAKE-OK'), JSON.stringify(out.ok).slice(0, 200));
  check('转发体是干净的：只带 model/messages/temperature/response_format，不带 apiKey/baseUrl/json',
    !/apiKey|baseUrl|"json"/.test(String(out.ok?.content || '')), String(out.ok?.content).slice(0, 200));
  check('json:true → response_format:{type:json_object}（作者后端就是这么干的）',
    /"response_format":\{"type":"json_object"\}/.test(String(out.ok?.content || '')));
  check('厂商 401 → 一句人话 + 指向 Key（不是"连不上本站后端服务"）',
    out.auth?.ok === false && /401/.test(out.auth?.error || '') && /Key/.test(out.auth?.hint || ''), JSON.stringify(out.auth).slice(0, 200));
  check('厂商不给 CORS（preflight 过不去）→ 说清"不允许浏览器直连"，并给出 endpoint',
    out.nocors?.ok === false && /连不上/.test(out.nocors?.error || '') && /有些厂商不允许浏览器直连/.test(out.nocors?.hint || ''), JSON.stringify(out.nocors).slice(0, 200));
  check('没填 Key → 让去「接口设置」里填（并说明只存在本机浏览器）',
    out.nokey?.ok === false && /还没有填写 API Key/.test(out.nokey?.error || ''), JSON.stringify(out.nokey).slice(0, 200));
  check('/api/config → {ok:true} + DeepSeek 默认值（作者后端原来给的就是非敏感默认值）',
    out.config?.ok === true && /api\.deepseek\.com/.test(out.config?.baseUrl || ''), JSON.stringify(out.config).slice(0, 200));
  check('/api/fetch → {ok:false} + 人话（不代理网页抓取）',
    out.fetch?.ok === false && /不代理/.test(out.fetch?.error || ''), JSON.stringify(out.fetch).slice(0, 200));
  check('沙箱里没有未捕获的页面错误（桥自身不许崩）', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));
  const providerHitsBefore = seen.provider.length;

  // 机构端/平台端预览那段收紧的 meta CSP（connect-src blob:）：桥要**认出来**，而不是让用户对着"连不上"发懵
  const META = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src blob:; frame-src blob: data:; form-action \'none\'; base-uri \'none\'">';
  pageErrors = [];
  const blocked = await runStudent(META + STUDENT);
  check('收紧 meta CSP（老师端/平台端预览）→ 先说"这个预览窗口关掉了联网"',
    blocked.ok?.ok === false && /关掉了作品的联网/.test(blocked.ok?.error || ''), JSON.stringify(blocked.ok).slice(0, 200));
  check('禁网时**不试网**：假厂商一个请求都没多收到', seen.provider.length === providerHitsBefore,
    `多了 ${seen.provider.length - providerHitsBefore} 条`);
  check('禁网不影响本地应答：/api/config 仍可用', blocked.config?.ok === true, JSON.stringify(blocked.config).slice(0, 160));
  check('禁网这一档也没有未捕获错误', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

  check('⭐ 桥接住了：本地"站点"的 /api/llm 一次都没被打（101 里的 404 不会再有）', seen.llmOnSite === 0, `实际 ${seen.llmOnSite} 次`);
  check('不给 CORS 的那家：浏览器确实去试了（它收到 preflight 就不再发 POST）—— 说明我们真在直连，不是假装成功',
    seen.nocors.some((item) => item.method === 'OPTIONS') && !seen.nocors.some((item) => item.method === 'POST'),
    JSON.stringify(seen.nocors).slice(0, 160));
} finally {
  await browser.close();
  site.close(); provider.close(); nocors.close();
}

// ───────────────── ③ 「平台不拦」这条承诺 + ④ 生产口径 ─────────────────
console.log(`③④ 生产口径（${SITE}）`);
let liveOk = false;
let liveDetail = '';
try {
  const head = await fetch(`${SITE}/vibe-preview.html`, { redirect: 'follow' });
  const csp = String(head.headers.get('content-security-policy') || '');
  check('③ 生产预览壳仍放行 https 出网（connect-src 里有 https:）',
    head.ok && /connect-src[^;]*https:/.test(csp), `HTTP ${head.status} · CSP=${csp.slice(0, 120)}`);

  const liveBrowser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });
  try {
    const live = await liveBrowser.newPage();
    await live.goto(`${SITE}/vibe-preview.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const result = await live.evaluate(async () => {
      const student = `<!doctype html><html><body><script>
        (async function(){
          var out;
          try{
            var r = await fetch('/api/llm', { method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ apiKey:'sk-p187-not-a-real-key', baseUrl:'https://api.deepseek.com/v1',
                model:'deepseek-chat', messages:[{ role:'user', content:'ping' }] }) });
            out = await r.json();
          }catch(e){ out = { threw: String((e && e.message) || e) }; }
          try{ window.top.postMessage({ __p187live:true, out: out }, '*'); }catch(e){}
        })();
      <\/script></body></html>`;
      return await new Promise((resolve) => {
        window.addEventListener('message', (event) => { if (event.data && event.data.__p187live) resolve(event.data.out); });
        const frame = document.createElement('iframe');
        frame.style.cssText = 'width:600px;height:400px;position:fixed;left:-9999px;top:0';
        frame.src = '/vibe-preview.html';
        frame.onload = () => frame.contentWindow.postMessage({ source: 'vibecoding-preview', html: student }, '*');
        document.body.appendChild(frame);
        setTimeout(() => resolve({ timeout: true }), 40000);
      });
    });
    const blob = JSON.stringify(result || {});
    liveOk = result?.ok === false && /Authentication Fails|invalid/i.test(blob);
    liveDetail = blob.slice(0, 240);
  } finally {
    await liveBrowser.close();
  }
  check('④ 生产里"假 Key 打真 DeepSeek"拿回**厂商的鉴权错误**（CSP + CORS + 桥三段全通）', liveOk, liveDetail);
} catch (error) {
  check('③④ 生产口径可跑（网络/站点可达）', false, String(error?.message || error).slice(0, 200));
}

console.log(JSON.stringify({ name: 'llm-bridge', pass: failures === 0, failures, site: SITE, liveDetail }, null, 2));
process.exit(failures ? 1 : 0);
