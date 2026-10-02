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

/**
 * 「这份文档有多高」的上报桥（2026-09-27）。
 *
 * 为什么需要它：查看层把学生页放在一个**逻辑视口**里再整体缩放（口径㉕，见 PreviewFrame）。
 * 那个逻辑视口高度是写死的 768 —— 学生作品一旦比它高（例如一个 12 页的 PPT 式网页，
 * 某几页内容更高），**内层文档就自己滚起来**，右侧冒出一根滚动条。
 * 用户 2026-09-27 报的就是这个：「点下一页 2/12 这里出现（滚动条）」。
 *
 * 而外层**量不到**内层高度 —— 内层 iframe 是不带 `allow-same-origin` 的沙箱（opaque origin），
 * 所以只能让内层**自己报**：与控制台桥完全同一条路（parent.postMessage → 外壳转发 → 主站）。
 * 上层拿到高度后把框长到那么高 → 内层再也没有滚动条，外层页面滚（这才是"大的作品预览"）。
 *
 * ⚠️ 只报数、不做限制：上限、收敛保护都在 PreviewFrame 那边（改这里会把策略散到两处）。
 */
export const PREVIEW_HEIGHT_BRIDGE = `<script>(function(){
  var last=0;
  var report=function(){try{
    var doc=document.documentElement;var body=document.body;
    var h=Math.max(doc?doc.scrollHeight:0,doc?doc.offsetHeight:0,body?body.scrollHeight:0);
    if(!h||Math.abs(h-last)<2)return;
    last=h;
    parent.postMessage({source:'vibecoding-preview-height',height:h},'*');
  }catch(error){}};
  if(window.ResizeObserver){try{new ResizeObserver(report).observe(document.documentElement);}catch(error){}}
  window.addEventListener('load',report);
  window.addEventListener('resize',report);
  setTimeout(report,0);setTimeout(report,300);setTimeout(report,1200);
})();</script>`;

/**
 * PDF 桥（2026-10-02，客户端提的「沙箱内 PDF bridge」）。
 *
 * 为什么必须有它：学生页常写 `iframe.src = URL.createObjectURL(pdfBlob)`。
 *   ① 平台把 `frame-src` 放开了 blob:/data:（§九十三），但 **Chrome 在沙箱框架里根本不启用
 *      内置 PDF 查看器** —— 受控实验：同一份 PDF 不套沙箱能渲染，套上我们这套 sandbox 就只剩占位图标；
 *   ② 所以桥的分工是：**学生文档**截下这个 PDF（先显示"正在渲染"），把字节交给父级（预览壳），
 *      壳转发给**平台应用**（自带 pdf.js、且不在沙箱里）渲染成图片，再原路送回来贴进那个 iframe。
 * 全程：沙箱不放松、opaque origin 不带 cookie、不联网、不依赖外部 CDN（pdf.js 是我们自己打包的）。
 *
 * 兼容范围：**学生现在这种写法不用改代码**（客户端明确说"无法通过多传一个文件修复已有的
 * `<iframe src=blob:pdf>`"）。取不到渲染结果时给一句人话 + 指路"查看作品源文件"，不留白屏。
 */
export const PDF_BRIDGE = `<script>(function(){
  var pdfBlobs=new Map();      // blob: 地址 → PDF Blob（返回的仍是**真地址**，只是顺手记一笔）
  var pending=new Map();       // 请求 id → {frame, timer}
  var seq=0;
  var realCreate=URL.createObjectURL?URL.createObjectURL.bind(URL):null;
  if(realCreate){URL.createObjectURL=function(value){
    var url=realCreate(value);
    try{if(value&&typeof value==='object'&&/application\\/pdf/i.test(String(value.type||'')))pdfBlobs.set(url,value);}catch(error){}
    return url;
  };}
  function toBase64(buffer){
    var bytes=new Uint8Array(buffer);var chunk=0x8000;var out='';
    for(var i=0;i<bytes.length;i+=chunk){out+=String.fromCharCode.apply(null,bytes.subarray(i,i+chunk));}
    try{return btoa(out);}catch(error){return '';}
  }
  function fallbackText(state){return state==='timeout'
    ?'PDF 预览：平台渲染超时。可以点开「查看作品源文件」下载原件。'
    :'PDF 预览：这份 PDF 没能渲染出来（'+(state||'未知原因')+'）。可以点开「查看作品源文件」下载原件。';}
  function paint(frame,images){
    var html='<body style="margin:0;background:#f3f4f6">';
    for(var i=0;i<images.length;i++){html+='<img src="'+images[i]+'" style="display:block;width:100%;margin:0 0 8px">';}
    html+='</body>';
    try{frame.srcdoc=html;}catch(error){}
  }
  function request(frame,blob){
    var id='pdf'+(++seq);
    var timer=setTimeout(function(){var entry=pending.get(id);pending.delete(id);if(entry&&entry.frame)try{entry.frame.srcdoc=fallbackText('timeout');}catch(error){}},20000);
    pending.set(id,{frame:frame,timer:timer});
    blob.arrayBuffer().then(function(buffer){
      var base64=toBase64(buffer);
      if(!base64){var entry=pending.get(id);if(entry)clearTimeout(entry.timer);pending.delete(id);try{frame.srcdoc=fallbackText('转码失败');}catch(error){}return;}
      try{parent.postMessage({source:'vibecoding-pdf-render',id:id,base64:base64,pages:12},'*');}catch(error){}
    }).catch(function(){var entry=pending.get(id);if(entry)clearTimeout(entry.timer);pending.delete(id);try{frame.srcdoc=fallbackText('读取失败');}catch(error){}});
  }
  window.addEventListener('message',function(event){
    var data=event.data;if(!data||typeof data!=='object')return;
    if(data.source!=='vibecoding-pdf-rendered')return;
    var key=String(data.id||'');var entry=pending.get(key);if(!entry)return;
    clearTimeout(entry.timer);pending.delete(key);
    if(data.images&&data.images.length)paint(entry.frame,data.images);
    else try{entry.frame.srcdoc=fallbackText(data.error);}catch(error){}
  });
  var descriptor=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');
  if(descriptor&&descriptor.set){
    Object.defineProperty(HTMLIFrameElement.prototype,'src',{
      configurable:true,enumerable:descriptor.enumerable,
      get:descriptor.get,
      set:function(value){
        var blob=(typeof value==='string'&&pdfBlobs.has(value))?pdfBlobs.get(value):null;
        if(!blob){descriptor.set.call(this,value);return;}
        // 不设置真地址：沙箱里 Chrome 不启用 PDF 查看器，设了只会得到一块"已阻止/未知内容"的灰块。
        try{this.srcdoc='<body style="margin:0;display:grid;place-items:center;height:100%;font:13px sans-serif;color:#6b7280">PDF 预览：正在由平台渲染…</body>';}catch(error){}
        request(this,blob);
      },
    });
  }
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
  // 后者要抢在 head 里的早期 console/error 调用之前。顺序：存储替身 → 控制台桥 → 高度上报 → 学生脚本。
  // PDF_BRIDGE 排最后：它要抢在学生脚本之前接管 `iframe.src = createObjectURL(pdfBlob)`。
  const preamble = `${SANDBOX_STORAGE_SHIM}${CONSOLE_BRIDGE}${PREVIEW_HEIGHT_BRIDGE}${PDF_BRIDGE}`;
  if (/<head[^>]*>/i.test(embedded)) return embedded.replace(/<head[^>]*>/i, (match) => `${match}${preamble}`);
  if (/<body[^>]*>/i.test(embedded)) return embedded.replace(/<body[^>]*>/i, (match) => `${match}${preamble}`);
  return preamble + embedded;
}

/** 只有真正能在工作台里展示的主产物才允许单独提交。 */
export function isSubmittableArtifact(artifact) {
  const kind = String(artifact?.kind || '').toLowerCase();
  return kind === 'html' || ['pptx', 'docx', 'xlsx'].includes(kind) || /\.html?$/i.test(String(artifact?.name || ''));
}

