/**
 * VibeCoding 工程文件（导入 / 导出）的纯函数：不依赖浏览器 API，便于单测与复用。
 * 导出成一个 JSON 工程文件（全部代码文件 + 入口文件）；导入时在本地先按服务端同样的
 * 限制（12 个文件 / 单文件 64KB / 总量 256KB）校验，避免保存时才被拒。
 */
export const PROJECT_FORMAT = 'ai-magic-academy/vibecoding-project';
export const PROJECT_LIMITS = Object.freeze({ maxFiles: 12, maxFileBytes: 64 * 1024, maxTotalBytes: 256 * 1024 });
export const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

export function projectFileBase(title) {
  const safe = String(title || 'vibecoding-project').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return safe || 'vibecoding-project';
}

export function buildProjectBundle({ title, entryFile, files }) {
  return {
    format: PROJECT_FORMAT,
    version: 1,
    title: String(title || 'vibecoding-project'),
    entryFile: String(entryFile || ''),
    files: { ...(files || {}) },
    exportedAt: new Date().toISOString(),
  };
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

export function parseProjectBundle(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('文件不是有效的 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('工程文件格式不正确');
  // 兼容两种写法：{format, files, entryFile} 或直接一个 { 文件名: 内容 } 的对象
  const raw = parsed.files !== undefined ? parsed.files : (parsed.format === undefined ? parsed : null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工程文件里没有 files 对象');
  const entries = Object.entries(raw);
  if (!entries.length) throw new Error('工程文件里没有任何代码文件');
  if (entries.length > PROJECT_LIMITS.maxFiles) throw new Error(`最多支持 ${PROJECT_LIMITS.maxFiles} 个文件`);
  const files = {};
  let total = 0;
  for (const [rawName, rawContent] of entries) {
    const name = String(rawName || '').trim();
    if (!FILE_NAME_PATTERN.test(name) || name.includes('..')) throw new Error(`文件名不合法：${name || '(空)'}`);
    const content = String(rawContent ?? '');
    const bytes = new TextEncoder().encode(content).length;
    if (bytes > PROJECT_LIMITS.maxFileBytes) throw new Error(`单个文件不能超过 ${Math.round(PROJECT_LIMITS.maxFileBytes / 1024)}KB：${name}`);
    total += bytes;
    if (total > PROJECT_LIMITS.maxTotalBytes) throw new Error(`代码总量不能超过 ${Math.round(PROJECT_LIMITS.maxTotalBytes / 1024)}KB`);
    files[name] = content;
  }
  const entryFile = files[parsed.entryFile] !== undefined ? parsed.entryFile : Object.keys(files)[0];
  return { files, entryFile };
}
