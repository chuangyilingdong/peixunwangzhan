/**
 * VibeCoding 产物与预览的纯函数：不依赖浏览器 API，便于单测与复用。
 * 学生不再手写代码，所以这里只剩「把产物拼成可运行的预览文档」和「解析围栏信息」两件事。
 */
// 产物文件名：允许中日韩文字（学生做的是中文作品，模型自然会起「去新疆旅游.pptx」这种名字），
// 但仍然禁掉路径分隔符与空白——文件名在围栏信息里是一个以空格分界的词。
// 服务端 services/vibecodingArtifacts.js 有一份同样的规则，改要一起改。
export const FILE_NAME_PATTERN = /^[A-Za-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af][A-Za-z0-9._\-\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{0,63}$/;

/** 浏览器下载一段文本（工程包 / 对话记录都用它） */
export function downloadTextFile(filename, content, mime = 'application/json;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * 解析围栏代码块的 info 串，识别「```语言 文件名」写法（AI 被要求这样输出）。
 * 返回 { lang, filename }，filename 为空表示这个代码块不能一键写入文件。
 */
export function parseFenceInfo(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const lang = parts[0] || '';
  const filename = parts.slice(1).find((part) => FILE_NAME_PATTERN.test(part) && !part.includes('..') && part.includes('.')) || '';
  return { lang, filename };
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

/**
 * **沙箱里的存储替身**（2026-09-20，用户报「图1 无法正常玩」的根因）。
 *
 * 预览跑在 `sandbox="allow-scripts …"` 里（**故意不带 `allow-same-origin`**，见口径⑧：
 * 作品与主站同源，带了就读得到 cookie / localStorage），于是学生文档的 origin 是 **opaque** ——
 * `localStorage` / `sessionStorage` / `document.cookie` **一碰就抛 SecurityError**。
 * 而 AI 生成的游戏十有八九在**顶层**读一次最高分（实测：学生那份打地鼠第 165 行就是
 * `let best = Number(localStorage.getItem('whack_best') || 0);`）：这一抛，整个 `<script>` 当场结束，
 * 「开始游戏」的监听永远没人挂上 —— **页面画得出来但点不动**，看着像"作品坏了"，
 * 其实是我们的沙箱把它的第一行干掉了。
 *
 * 顶上来的是一份**只活在这次预览里**的内存实现：不写盘、不跨作品也不跨刷新共享
 * （真存储放在这里反而会变成侧信道），只保证语义够用：getItem/setItem/removeItem/clear/key/length，
 * cookie 也只在本文档内存里记一份。
 *
 * ⚠️ 必须在学生脚本**之前**执行（顶层那一行就在脚本开头），所以它和下面的 console 桥一起
 *    插进第一个 `<head>` / `<body>`。
 * ⚠️ 它**不放松隔离**：文档仍是 opaque origin，仍旧读不到主站的任何东西、也读不到别的作品 ——
 *    只是把「读自己的存储」从"抛异常"换成"一份空的内存"。p120 那条金丝雀（沙箱里三项必须
 *    SecurityError）钉的是**隔离性**，与本替身不冲突。
 * ⚠️ 管不到的那一面：广场上那 9 件**导入**的网页作品是 nginx 直接发 `entryUrl` 文件，
 *    我们不参与拼装，注入不了。`单词小侦探` 也用了存储，但它的读被 try 包着，只是丢持久化。
 */
export const SANDBOX_STORAGE_SHIM = `<script>(function(){
  function memory(){
    var data={};
    var api={
      getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(data,k)?data[k]:null;},
      setItem:function(k,v){data[String(k)]=String(v);},
      removeItem:function(k){delete data[String(k)];},
      clear:function(){data={};},
      key:function(i){var keys=Object.keys(data);return i>=0&&i<keys.length?keys[i]:null;}
    };
    Object.defineProperty(api,'length',{get:function(){return Object.keys(data).length;}});
    return api;
  }
  function install(name){
    var store=memory();
    try{Object.defineProperty(window,name,{configurable:true,get:function(){return store;},set:function(){}});}
    catch(e){try{window[name]=store;}catch(e2){}}
  }
  install('localStorage');
  install('sessionStorage');
  try{
    var jar={};
    Object.defineProperty(Document.prototype,'cookie',{configurable:true,
      get:function(){return Object.keys(jar).map(function(k){return k+'='+jar[k];}).join('; ');},
      set:function(value){
        var pair=String(value).split(';')[0];
        var eq=pair.indexOf('=');
        if(eq<0)return;
        var k=pair.slice(0,eq).trim();
        if(!k)return;
        if(/max-age=0|expires=Thu, 01 Jan 1970/i.test(String(value))){delete jar[k];return;}
        jar[k]=pair.slice(eq+1);
      }});
  }catch(e){}
})();</script>`;

// 预览文档里注入控制台桥：沙箱 iframe 不能同源读 DOM，但可以 postMessage 给父页面。
export const CONSOLE_BRIDGE = `<script>(function(){
  var send=function(level,args){try{parent.postMessage({source:'vibecoding-console',level:level,text:args.map(function(item){try{return typeof item==='string'?item:JSON.stringify(item);}catch(e){return String(item);}}).join(' ')},'*');}catch(e){}};
  ['log','info','warn','error'].forEach(function(level){var original=console[level]?console[level].bind(console):function(){};console[level]=function(){var args=[].slice.call(arguments);send(level,args);original.apply(null,args);};});
  window.addEventListener('error',function(event){send('error',[event.message+'（第 '+event.lineno+' 行）']);});
  window.addEventListener('unhandledrejection',function(event){send('error',['未处理的异步错误：'+(event.reason&&event.reason.message?event.reason.message:event.reason)]);});
})();</script>`;

function svgDataUrl(content) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(content || ''))}`;
}

function embedLocalAssets(value, files) {
  return String(value || '')
    .replace(/\b(src|href)=["']([^"']+)["']/gi, (match, attribute, name) => {
      const clean = String(name).replace(/^\.\//, '').split(/[?#]/)[0];
      if (!/\.svg$/i.test(clean) || files[clean] === undefined) return match;
      return `${attribute}="${svgDataUrl(files[clean])}"`;
    })
    .replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, name) => {
      const clean = String(name).replace(/^\.\//, '').split(/[?#]/)[0];
      if (!/\.svg$/i.test(clean) || files[clean] === undefined) return match;
      return `url("${svgDataUrl(files[clean])}")`;
    });
}

/**
 * 把入口 HTML 里引用的本地 css/js 内联进预览文档；外链保持原样（sandbox 内没有同源权限）。
 * 工作区预览与官网公开作品页共用这一份，保证「学生看到的」和「作品广场看到的」一致。
 */
export function buildPreviewDocument(files, entryFile) {
  const entry = files?.[entryFile];
  if (entry === undefined) return '<!doctype html><html><body style="font-family:sans-serif;padding:16px">入口文件不存在</body></html>';
  if (!/\.html?$/i.test(entryFile)) return `<!doctype html><html><body><pre style="font-family:monospace;padding:12px">${escapeHtml(entry)}</pre></body></html>`;
  const resolve = (name) => {
    const clean = String(name || '').replace(/^\.\//, '').split(/[?#]/)[0];
    return files[clean] !== undefined ? files[clean] : files[name];
  };
  const html = String(entry)
    .replace(/<link[^>]*href=["']([^"']+)["'][^>]*>/gi, (match, href) => (resolve(href) !== undefined ? `<style>${embedLocalAssets(resolve(href), files)}</style>` : match))
    .replace(/<script([^>]*)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (match, before, src, after) => {
      const content = resolve(src);
      if (content === undefined) return match;
      const attributes = `${before} ${after}`;
      if (/\bdefer\b/i.test(attributes)) {
        return `<script>window.addEventListener('DOMContentLoaded',function(){${content}\n},{once:true});</script>`;
      }
      return `<script>${content}</script>`;
    });
  const embedded = embedLocalAssets(html, files);
  // 存储替身与桥都必须装在学生脚本**之前**：前者要抢在那行顶层 localStorage 之前，
  // 后者要抢在 head 里的早期 console/error 调用之前。顺序：存储替身 → 控制台桥 → 学生脚本。
  const preamble = `${SANDBOX_STORAGE_SHIM}${CONSOLE_BRIDGE}`;
  if (/<head[^>]*>/i.test(embedded)) return embedded.replace(/<head[^>]*>/i, (match) => `${match}${preamble}`);
  if (/<body[^>]*>/i.test(embedded)) return embedded.replace(/<body[^>]*>/i, (match) => `${match}${preamble}`);
  return preamble + embedded;
}

/** 只有真正能在工作台里展示的主产物才允许单独提交。 */
export function isSubmittableArtifact(artifact) {
  const kind = String(artifact?.kind || '').toLowerCase();
  return kind === 'html' || ['pptx', 'docx', 'xlsx'].includes(kind) || /\.html?$/i.test(String(artifact?.name || ''));
}

