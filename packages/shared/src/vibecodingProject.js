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

// 预览文档里注入控制台桥：沙箱 iframe 不能同源读 DOM，但可以 postMessage 给父页面。
export const CONSOLE_BRIDGE = `<script>(function(){
  var send=function(level,args){try{parent.postMessage({source:'vibecoding-console',level:level,text:args.map(function(item){try{return typeof item==='string'?item:JSON.stringify(item);}catch(e){return String(item);}}).join(' ')},'*');}catch(e){}};
  ['log','info','warn','error'].forEach(function(level){var original=console[level]?console[level].bind(console):function(){};console[level]=function(){var args=[].slice.call(arguments);send(level,args);original.apply(null,args);};});
  window.addEventListener('error',function(event){send('error',[event.message+'（第 '+event.lineno+' 行）']);});
  window.addEventListener('unhandledrejection',function(event){send('error',['未处理的异步错误：'+(event.reason&&event.reason.message?event.reason.message:event.reason)]);});
})();</script>`;

/**
 * 把入口 HTML 里引用的本地 css/js 内联进预览文档；外链保持原样（sandbox 内没有同源权限）。
 * 工作区预览与官网公开作品页共用这一份，保证「学生看到的」和「作品广场看到的」一致。
 */
export function buildPreviewDocument(files, entryFile) {
  const entry = files?.[entryFile];
  if (entry === undefined) return '<!doctype html><html><body style="font-family:sans-serif;padding:16px">入口文件不存在</body></html>';
  if (!/\.html?$/i.test(entryFile)) return `<!doctype html><html><body><pre style="font-family:monospace;padding:12px">${escapeHtml(entry)}</pre></body></html>`;
  const resolve = (name) => {
    const clean = String(name || '').replace(/^\.\//, '');
    return files[clean] !== undefined ? files[clean] : files[name];
  };
  const html = String(entry)
    .replace(/<link[^>]*href=["']([^"']+)["'][^>]*>/gi, (match, href) => (resolve(href) !== undefined ? `<style>${resolve(href)}</style>` : match))
    .replace(/<script[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (match, src) => (resolve(src) !== undefined ? `<script>${resolve(src)}</script>` : match));
  // 桥必须装在学生脚本之前，否则早期 console 调用抓不到：优先塞进 head。
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${CONSOLE_BRIDGE}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (match) => `${match}${CONSOLE_BRIDGE}`);
  return CONSOLE_BRIDGE + html;
}

