// VibeCoding 产物：AI 产出的每一个文件。
//
// 产物从助手回复里的代码围栏解析出来，不引入工具调用协议，任何模型都能跑。
//
// 命名规则（两条，显式优先）：
//   ① 围栏写了文件名（```html index.html）→ 用它的；
//   ② 没写文件名 → **按语言推断**一个默认名（html→index.html、css→style.css、js→script.js），
//      但只在这个围栏看起来像「一个完整文件」时才认（整篇 HTML 文档 / 一条 CSS 规则块 /
//      一段 JS 代码），否则只当示例，不落库。
//
// ②是**兜底**，不是约定：2026-09-11 用户要求删掉注入给模型的产物约定，模型于是经常
// 只写 ```html 不带文件名——生产上实测「AI 说做好了网页、但预览没更新」。
// 服务端不能依赖模型遵守一条它没被告知的格式，所以改成自己认。
// 片段会被挡在外面，避免把解释用的 <h1> 示例写进学生的页面。
//
// 关键能力是**流式增量解析**：模型还在吐字时，每有一个围栏闭合就立刻落库并推事件，
// 学生才能看到产物卡片一个个出现，而不是等整轮结束才一次性冒出来。
import { count, id, nowIso, q, row, rows } from '../lib.js';
import { parseCsv } from './ooxml/xlsx.js';
import { parseDeckSpec } from './ooxml/documents.js';

export const ARTIFACT_LIMITS = Object.freeze({ maxFiles: 24, maxFileBytes: 256 * 1024, maxTotalBytes: 2 * 1024 * 1024 });

const KIND_BY_EXTENSION = {
  html: 'html', htm: 'html', css: 'css', js: 'js', mjs: 'js', cjs: 'js',
  json: 'json', md: 'md', markdown: 'md', svg: 'svg', csv: 'csv', txt: 'text', text: 'text',
  // 文档产物：围栏里写的不是文件本身，而是**规格文本**（pptx=JSON 提纲、docx=Markdown、xlsx=CSV），
  // 下载时才由 services/ooxml 渲染成真正的 Office 文件。见那个目录里的说明。
  pptx: 'pptx', docx: 'docx', xlsx: 'xlsx',
};

export function kindForName(name) {
  const extension = String(name || '').split('.').pop()?.toLowerCase();
  return KIND_BY_EXTENSION[extension] || 'text';
}

// 与 packages/shared/src/vibecodingProject.js 的 parseFenceInfo 同一套规则
// （服务端不引共享包，所以这里保留一份；两边改要一起改）
// 允许中日韩文字：学生做的是中文作品，模型会起「去新疆旅游.pptx」这种名字；
// 但仍禁掉路径分隔符与空白（文件名在围栏信息里是以空格分界的一个词）。
const FILE_NAME_PATTERN = /^[A-Za-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af][A-Za-z0-9._\-\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{0,63}$/;

export function parseFenceInfo(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const lang = parts[0] || '';
  const filename = parts.slice(1).find((part) => FILE_NAME_PATTERN.test(part) && !part.includes('..') && part.includes('.')) || '';
  return { lang, filename };
}

// 匹配**已闭合**的围栏块；未闭合的（还在流式中）不会命中，所以不会提前产出半截文件。
const CLOSED_FENCE_PATTERN = /^[ \t]*```([^\n`]*)\n([\s\S]*?)\n?[ \t]*```[ \t]*$/gm;

// 没写文件名时，按语言给一个默认名（多文件项目里 index.html 是预览入口）
const DEFAULT_NAME_BY_LANG = {
  html: 'index.html', htm: 'index.html', xml: 'index.html', svg: 'image.svg',
  css: 'style.css', scss: 'style.scss', less: 'style.less',
  js: 'script.js', javascript: 'script.js', mjs: 'script.mjs', cjs: 'script.cjs',
  ts: 'script.ts', typescript: 'script.ts', jsx: 'app.jsx', tsx: 'app.tsx',
  json: 'data.json', md: 'notes.md', markdown: 'notes.md', txt: 'notes.txt', text: 'notes.txt',
  // 文档产物：语言标签就是格式，没写文件名时给一个中文默认名（这个名字会直接显示给学生）
  pptx: '演示文稿.pptx', docx: '文档.docx', xlsx: '表格.xlsx',
};

// 段落/文档类产物的语言别名：模型常把文档写成 ```markdown / ```md，或直接按格式写 ```ppt
const DOCUMENT_ALIASES = { ppt: 'pptx', powerpoint: 'pptx', slides: 'pptx', deck: 'pptx', word: 'docx', excel: 'xlsx', sheet: 'xlsx', spreadsheet: 'xlsx' };

// 语言别名（模型常写 js / html / javascript 之类）
const LANG_ALIASES = { js: 'javascript', ts: 'typescript', htm: 'html', sh: 'shell' };

/**
 * 「这个围栏看起来像不像一个完整文件」——兜底命名必须过这一关。
 *
 * 为什么需要：删掉产物约定后，模型经常给个 ```html 的示例片段（解释用法用的
 * `<h1>标题</h1>`），把这种片段写成 index.html 会把学生的页面覆盖坏。
 * 宁可漏认，不可错认——错认的代价是学生的作品被一段示例覆盖。
 */
function looksLikeCompleteFile(content, lang) {
  const text = String(content || '');
  const trimmed = text.trim();
  if (!trimmed) return false;
  const language = LANG_ALIASES[lang] || lang;

  if (language === 'html' || language === 'xml' || language === 'svg') {
    // 整篇 HTML 文档：有 doctype 或 <html>，并且带上 </html>
    const hasDoctype = /<!doctype\s+html/i.test(trimmed);
    const hasRootOpen = /<html[\s>]/i.test(trimmed);
    const hasRootClose = /<\/html\s*>/i.test(trimmed);
    if ((hasDoctype || hasRootOpen) && hasRootClose) return true;
    // 只有 <body>…</body> 也算（模型有时省掉外层）
    if (/<body[\s>]/i.test(trimmed) && /<\/body\s*>/i.test(trimmed)) return true;
    // svg 是自成一体的：有 <svg> 且有闭合
    if (/<svg[\s>]/i.test(trimmed) && /<\/svg\s*>/i.test(trimmed)) return true;
    return false;
  }

  if (language === 'css' || language === 'scss' || language === 'less') {
    // CSS 至少要有「选择器 { 属性: 值 }」的形状，且不是孤零零一两行（那多半是示例）
    const hasRule = /[^{}]+\{[^{}]*:[^{}]*\}/.test(trimmed);
    const lineCount = trimmed.split('\n').length;
    return hasRule && lineCount >= 3;
  }

  if (language === 'javascript' || language === 'typescript') {
    // JS 片段太短就不认（console.log('x') 这种通常是在解释）
    const lineCount = trimmed.split('\n').filter((line) => line.trim()).length;
    if (lineCount >= 6) return true;
    // 短但带了「在一个页面里真正干活」的信号也认
    return /document\.|window\.|addEventListener|getElementById|querySelector|function\s|=>\s*\{|class\s+\w+\s*\{/.test(trimmed);
  }

  if (language === 'json') {
    try { const value = JSON.parse(trimmed); return typeof value === 'object' && value !== null; } catch { return false; }
  }

  // ── 文档产物（pptx / docx / xlsx）─────────────────────────────────────────
  // 这三类的判据比代码更保守：它们的内容是**规格文本**，一段示例也会「看着像」，
  // 所以要求出现真实的文档结构信号，否则宁可不落库（漏认只是少一个产物，错认会污染学生的作品列表）。
  if (language === 'pptx') {
    const deck = parseDeckSpec(text);
    return Boolean(deck && deck.slides.length >= 2);
  }
  if (language === 'docx') {
    const lines = trimmed.split('\n').filter((line) => line.trim());
    if (lines.length < 3) return false;
    // 有标题、或有无序/有序列表、或有表格，才当文档
    return /^#{1,4}\s/m.test(trimmed) || /^\s*[-*+]\s/m.test(trimmed) || /^\s*\d+[.)]\s/m.test(trimmed) || /^\s*\|.*\|\s*$/m.test(trimmed);
  }
  if (language === 'xlsx') {
    const rows = parseCsv(text).filter((row) => row.some((value) => String(value).trim() !== ''));
    // 表格至少要有表头 + 一行数据，且列数 ≥ 2（一列的「表格」多半是随手写的清单）
    return rows.length >= 2 && Math.max(...rows.map((row) => row.length)) >= 2;
  }

  // 其余语言（md/txt/未知）：不猜，避免把说明文字写成文件
  return false;
}

/**
 * 扫描文本里的产物候选：带文件名的直接用名字，没名字的按语言推断（要过完整度检查）。
 * @param from 已经处理过的闭合围栏数量（增量模式用）
 */
export function scanArtifacts(text, { from = 0 } = {}) {
  const source = String(text || '');
  const found = [];
  CLOSED_FENCE_PATTERN.lastIndex = 0;
  let match;
  let index = 0;
  while ((match = CLOSED_FENCE_PATTERN.exec(source)) !== null) {
    index += 1;
    if (index <= from) continue;
    const { lang, filename } = parseFenceInfo(match[1]);
    const content = match[2];
    const lowerLang = String(lang || '').toLowerCase();
    let name = filename;
    if (!name) {
      // 先过文档别名（```ppt / ```slides / ```word 这些模型也常写）
      const fallback = DEFAULT_NAME_BY_LANG[DOCUMENT_ALIASES[lowerLang] || lowerLang];
      if (!fallback || !looksLikeCompleteFile(content, DOCUMENT_ALIASES[lowerLang] || lowerLang)) continue;
      name = fallback;
    }
    found.push({
      name,
      kind: kindForName(name),
      content,
      bytes: Buffer.byteLength(content),
      fenceIndex: index,
    });
  }
  return { artifacts: found, closedFences: index };
}

/**
 * 增量扫描器：把流式增量喂进来，每调用一次返回「这次新闭合」的产物。
 * 状态只有一个数字（已处理的闭合围栏数），用完即弃，不需要清理。
 */
export function createArtifactScanner() {
  let buffer = '';
  let processed = 0;
  return {
    push(delta) {
      buffer += String(delta || '');
      const { artifacts, closedFences } = scanArtifacts(buffer, { from: processed });
      processed = closedFences;
      return artifacts;
    },
    get text() { return buffer; },
  };
}

/** 从一段完整文本提取产物（非流式场景：整轮结束后兜底补扫一次） */
export function extractArtifacts(text) {
  return scanArtifacts(text).artifacts;
}

// ── 读写 ────────────────────────────────────────────────────────────────────

export function normalizeArtifact(value) {
  if (!value) return null;
  return {
    id: value.id,
    conversationId: value.conversation_id,
    messageId: value.message_id || null,
    name: value.name,
    kind: value.kind || kindForName(value.name),
    bytes: Number(value.bytes || 0),
    revision: Number(value.revision || 1),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    // 列表接口默认不带正文：产物卡片只需要元信息，正文按需取
    ...(value.content === undefined ? {} : { content: value.content }),
  };
}

export function listArtifacts(conversationId, { includeContent = false } = {}) {
  const columns = includeContent ? '*' : 'id,conversation_id,message_id,name,kind,bytes,revision,created_at,updated_at';
  return rows(
    `SELECT ${columns} FROM vibecoding_artifacts WHERE conversation_id=? ORDER BY name ASC`,
    [conversationId],
  ).map(normalizeArtifact);
}

export function getArtifact(conversationId, artifactId) {
  return normalizeArtifact(row('SELECT * FROM vibecoding_artifacts WHERE id=? AND conversation_id=?', [artifactId, conversationId]));
}

/** 产物 → 文件映射（预览文档拼装、提交快照、作品广场都用它） */
export function artifactsAsFiles(conversationId) {
  const result = {};
  for (const artifact of rows('SELECT name, content FROM vibecoding_artifacts WHERE conversation_id=? ORDER BY name ASC', [conversationId])) {
    result[artifact.name] = String(artifact.content ?? '');
  }
  return result;
}

/**
 * 写入/更新一个产物。同名视为同一份产物的新修订（revision +1），
 * 而不是新建一条——否则模型每次重写都会在聊天里堆出一串重复卡片。
 */
export function upsertArtifact({ conversationId, messageId = null, name, content, at = null }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return null;
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text);
  if (bytes > ARTIFACT_LIMITS.maxFileBytes) return null;
  const total = Number(count('SELECT COALESCE(SUM(bytes),0) n FROM vibecoding_artifacts WHERE conversation_id=?', [conversationId]) || 0);
  const existing = row('SELECT * FROM vibecoding_artifacts WHERE conversation_id=? AND name=?', [conversationId, cleanName]);
  if (!existing && total + bytes > ARTIFACT_LIMITS.maxTotalBytes) return null;
  const timestamp = at || nowIso();

  if (existing) {
    // 内容没变就不动修订号（模型常把同一个文件原样再写一遍）
    if (existing.content === text) return normalizeArtifact(existing);
    q('UPDATE vibecoding_artifacts SET content=?,bytes=?,kind=?,revision=revision+1,message_id=?,updated_at=? WHERE id=?',
      [text, bytes, kindForName(cleanName), messageId, timestamp, existing.id]);
    return normalizeArtifact(row('SELECT * FROM vibecoding_artifacts WHERE id=?', [existing.id]));
  }

  const artifactId = id('vibeart');
  q(`INSERT INTO vibecoding_artifacts(id,conversation_id,message_id,name,kind,content,bytes,revision,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [artifactId, conversationId, messageId, cleanName, kindForName(cleanName), text, bytes, 1, timestamp, timestamp]);
  return normalizeArtifact(row('SELECT * FROM vibecoding_artifacts WHERE id=?', [artifactId]));
}

/** 批量写入（整轮结束后的兜底补扫） */
export function upsertArtifacts(conversationId, artifacts, { messageId = null } = {}) {
  const written = [];
  for (const artifact of artifacts) {
    const saved = upsertArtifact({ conversationId, messageId, name: artifact.name, content: artifact.content });
    if (saved) written.push(saved);
  }
  return written;
}

/** 预览入口：优先 index.html，否则第一个 HTML 产物，再否则第一个产物 */
export function pickEntryArtifact(artifacts) {
  return artifacts.find((item) => item.name === 'index.html')
    || artifacts.find((item) => item.kind === 'html')
    || artifacts[0]
    || null;
}

// 新建会话时的起始产物：让学生一进课堂就有东西可跑，而不是面对一块空白。
export const DEFAULT_ARTIFACTS = Object.freeze([
  {
    name: 'index.html',
    content: '<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>我的第一个网页</title>\n  <link rel="stylesheet" href="style.css" />\n</head>\n<body>\n  <h1>你好，AI 魔法学院！</h1>\n  <p>在这里写下你的第一个网页。</p>\n  <script src="script.js"></script>\n</body>\n</html>\n',
  },
  {
    name: 'style.css',
    content: 'body {\n  font-family: system-ui, -apple-system, "PingFang SC", sans-serif;\n  padding: 24px;\n  color: #2f2a45;\n}\n',
  },
  {
    name: 'script.js',
    content: "console.log('你好，VibeCoding！');\n",
  },
]);

export function seedDefaultArtifacts(conversationId) {
  return upsertArtifacts(conversationId, DEFAULT_ARTIFACTS);
}
