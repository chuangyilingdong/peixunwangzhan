// Markdown 渲染：走 marked 的词法分析 + 自己渲染 React 元素，
// 不注入原始 HTML（模板里的 html token 一律转义成文本），代码块用 highlight.js 高亮。
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseFenceInfo } from './vibecodingProject.js';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import 'highlight.js/styles/github.css';

for (const [name, language] of [['javascript', javascript], ['xml', xml], ['css', css], ['json', json], ['python', python], ['bash', bash]]) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language);
}

const LANGUAGE_ALIASES = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'javascript', typescript: 'javascript', html: 'xml', htm: 'xml', svg: 'xml', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash' };

function languageOf(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return LANGUAGE_ALIASES[value] || (hljs.getLanguage(value) ? value : '');
}

// 单个代码块高亮的上限：超过就退化成纯等宽文本，避免一次性高亮几万字符把页面卡住
const HIGHLIGHT_MAX_CHARS = 30_000;

function CodeBlock({ code, lang, filename, onApply, streaming = false }) {
  const codeRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const language = languageOf(lang);
  // 流式期间不高亮：每个 delta 都重跑整块高亮会明显掉帧（参考项目也是这么取舍的），
  // 等这条消息落地后再一次性着色。
  const skipHighlight = streaming || String(code || '').length > HIGHLIGHT_MAX_CHARS;
  useEffect(() => {
    const element = codeRef.current;
    if (!element) return;
    if (skipHighlight) { element.textContent = code; return; }
    try {
      // hljs 会对输入做实体转义后再包高亮标签，输出是安全的
      element.innerHTML = language ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
    } catch {
      element.textContent = code;
    }
  }, [code, language, skipHighlight]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* 剪贴板不可用时保持静默 */ }
  }
  return <div className="md-code">
    <div className="md-code__bar"><span>{filename || language || 'code'}</span><div className="md-code__actions">
      {filename && onApply ? <button type="button" onClick={() => onApply(filename, code)}>写入 {filename}</button> : null}
      <button type="button" onClick={copy}>{copied ? '已复制' : '复制'}</button>
    </div></div>
    <pre><code ref={codeRef} className="hljs" /></pre>
  </div>;
}

function InlineNodes({ tokens }) {
  return (tokens || []).map((token, index) => {
    const key = `${token.type}-${index}`;
    switch (token.type) {
      case 'strong': return <strong key={key}><InlineNodes tokens={token.tokens} /></strong>;
      case 'em': return <em key={key}><InlineNodes tokens={token.tokens} /></em>;
      case 'del': return <del key={key}><InlineNodes tokens={token.tokens} /></del>;
      case 'codespan': return <code className="md-inline-code" key={key}>{token.text}</code>;
      case 'br': return <br key={key} />;
      case 'link': return <a key={key} href={token.href} target="_blank" rel="noreferrer noopener">{token.tokens ? <InlineNodes tokens={token.tokens} /> : token.text}</a>;
      case 'image': return <a key={key} href={token.href} target="_blank" rel="noreferrer noopener">{token.text || '图片'}</a>;
      case 'escape': return <span key={key}>{token.text}</span>;
      default: return <span key={key}>{token.text ?? ''}</span>;
    }
  });
}

function BlockNodes({ tokens, onApplyFile, streaming }) {
  return (tokens || []).map((token, index) => {
    const key = `${token.type}-${index}`;
    switch (token.type) {
      case 'heading': {
        const Tag = `h${Math.min(6, Math.max(1, Number(token.depth) || 3))}`;
        return <Tag key={key} className="md-heading"><InlineNodes tokens={token.tokens} /></Tag>;
      }
      case 'paragraph': return <p key={key}><InlineNodes tokens={token.tokens} /></p>;
      case 'code': { const fence = parseFenceInfo(token.lang); return <CodeBlock key={key} code={token.text} lang={fence.lang} filename={fence.filename} onApply={onApplyFile} streaming={streaming} />; }
      case 'blockquote': return <blockquote key={key}><BlockNodes tokens={token.tokens} onApplyFile={onApplyFile} streaming={streaming} /></blockquote>;
      case 'hr': return <hr key={key} />;
      case 'space': return null;
      case 'list': {
        const Tag = token.ordered ? 'ol' : 'ul';
        return <Tag key={key}>{token.items.map((item, itemIndex) => <li key={itemIndex}><BlockNodes tokens={item.tokens} onApplyFile={onApplyFile} streaming={streaming} /></li>)}</Tag>;
      }
      case 'table': return <div className="md-table-wrap" key={key}><table>
        <thead><tr>{token.header.map((cell, cellIndex) => <th key={cellIndex}><InlineNodes tokens={cell.tokens} /></th>)}</tr></thead>
        <tbody>{token.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><InlineNodes tokens={cell.tokens} /></td>)}</tr>)}</tbody>
      </table></div>;
      case 'html': return <p key={key}>{token.text}</p>;
      // 兜底：列表项里的裸文本、以及 marked 产出的 `text` 块，都带着内联 token。
      // 之前这里直接输出 token.text（**原文**），于是 `**点击换色**` 会原样显示成星号。
      default:
        if (token.tokens?.length) return <p key={key}><InlineNodes tokens={token.tokens} /></p>;
        return token.text ? <p key={key}>{token.text}</p> : null;
    }
  });
}

/**
 * Markdown 渲染。
 * @param streaming 流式期间传 true：跳过语法高亮（每个 delta 重跑高亮会掉帧），
 *                  并把代码块当纯文本渲染，落地后在一次性着色。
 */
export function MarkdownView({ content = '', className = '', onApplyFile = null, streaming = false }) {
  const tokens = useMemo(() => {
    try { return marked.lexer(String(content || '')); } catch { return []; }
  }, [content]);
  return <div className={`md-view ${className}`.trim()}><BlockNodes tokens={tokens} onApplyFile={onApplyFile} streaming={streaming} /></div>;
}
