// 控制台里用到的几个格式化工具。都做成了纯函数，方便在别处复用与单测。

/** 相对时间：「刚刚 / 3 分钟前 / 昨天 / 3 月 5 日」 */
export function relativeTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < 0) return '刚刚';
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/** 绝对时间，用于消息时间戳的 title */
export function absoluteTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 时长：秒数 → 「12s」/「1m 20s」 */
export function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** 字节数 → 「1.2 KB」。产物卡片要显示文件大小，用得上。 */
export function fileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** 文本的 UTF-8 字节数（和 fileSize 配套：产物大小按字节算，不按字符算） */
export function byteLength(text) {
  const value = String(text ?? '');
  if (typeof TextEncoder === 'undefined') return value.length;
  return new TextEncoder().encode(value).length;
}

/** 产物类型 → 卡片图标/色调分组：可预览的页面、代码、数据 */
export function artifactGroup(kind) {
  const value = String(kind || '').toLowerCase();
  if (value === 'html' || value === 'htm') return { icon: 'globe', tone: 'preview', label: '网页' };
  if (value === 'css') return { icon: 'layers', tone: 'code', label: '样式' };
  if (value === 'js' || value === 'javascript' || value === 'mjs') return { icon: 'code', tone: 'code', label: '脚本' };
  if (value === 'json' || value === 'csv') return { icon: 'brackets', tone: 'data', label: '数据' };
  if (value === 'md' || value === 'markdown' || value === 'txt') return { icon: 'file', tone: 'data', label: '文档' };
  if (value === 'svg' || value === 'png' || value === 'jpg' || value === 'jpeg' || value === 'webp') return { icon: 'image', tone: 'preview', label: '图片' };
  // 文档产物：产物里存的是规格文本，点下载时由服务端渲染成真正的 Office 文件
  if (value === 'pptx') return { icon: 'list', tone: 'doc', label: 'PPT' };
  if (value === 'docx') return { icon: 'file', tone: 'doc', label: 'Word' };
  if (value === 'xlsx') return { icon: 'brackets', tone: 'doc', label: 'Excel' };
  return { icon: 'file', tone: 'code', label: '文件' };
}

/** 能被 iframe 预览的产物（决定产物卡片给「打开」还是只给「下载」） */
export function isPreviewable(kind) {
  const value = String(kind || '').toLowerCase();
  return value === 'html' || value === 'htm' || value === 'svg';
}

const EXTENSION_KINDS = {
  html: 'html', htm: 'html', css: 'css', js: 'js', mjs: 'js', json: 'json',
  md: 'md', markdown: 'md', txt: 'text', svg: 'svg', csv: 'csv',
};

/** 从文件名推断产物类型（模型偶尔不写语言标识时兜底） */
export function kindFromName(name) {
  const extension = String(name || '').split('.').pop()?.toLowerCase();
  return EXTENSION_KINDS[extension] || 'text';
}
