// 只读回放：官网公开作品页用（教师点评页已于 2026-09-11 按用户要求删除）。
//
// 学生不再手写代码，所以要回放的是两样东西——**创作对话的过程**和
// **最终的产物**。这里就是这两样的只读渲染，复用对话流的视觉语言（用户气泡 /
// 助手正文无气泡 / 代码块 / 产物外观），但不带任何操作按钮。
import { useEffect, useMemo, useState } from 'react';
import { ConsoleIcon } from './icons.jsx';
import { Empty, IconButton } from './primitives.jsx';
import { PreviewFrame } from './PreviewFrame.jsx';
import { MarkdownView } from '../markdown.jsx';
import { artifactGroup, byteLength, fileSize, relativeTime } from './format.js';

function filesFromMap(files) {
  return Object.fromEntries(Object.entries(files || {}).map(([name, content]) => [name, String(content ?? '')]));
}

export function ReplayShell({ eyebrow, title, meta, actions, children, embedded = false }) {
  return (
    <div className={`c-page${embedded ? ' c-page--embed' : ''}`} data-console="vibecoding">
      <header className="c-page__head">
        <div>
          {eyebrow ? <p className="c-eyebrow">{eyebrow}</p> : null}
          <h1>{title}</h1>
          {meta ? <div className="c-replay__meta">{meta}</div> : null}
        </div>
        {actions ? <div className="c-page__actions">{actions}</div> : null}
      </header>
      <div className="c-replay">{children}</div>
    </div>
  );
}

export function ReplayPanel({ title, icon = 'code', actions, children, className = '' }) {
  return (
    <section className={`c-replay__panel ${className}`.trim()}>
      <div className="c-replay__panel-head">
        <ConsoleIcon name={icon} size={14} />
        <span>{title}</span>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** 作品预览：真的能玩（沙箱 iframe 里跑学生的 HTML） */
export function ReplayPreview({ html, title = '作品预览', height = '62vh' }) {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <ReplayPanel
      title="作品预览"
      icon="eye"
      className="c-replay__preview"
      actions={<IconButton icon="refresh" size={14} label="重新运行" small onClick={() => setReloadKey((value) => value + 1)} />}
    >
      <PreviewFrame className="c-replay__frame" html={html} reloadKey={reloadKey} title={title} />
    </ReplayPanel>
  );
}

/** 产物源码：只读，按文件切换 */
export function ReplayFiles({ files, entryFile }) {
  const map = useMemo(() => filesFromMap(files), [files]);
  const names = useMemo(() => {
    const all = Object.keys(map);
    return all.sort((a, b) => (a === entryFile ? -1 : b === entryFile ? 1 : a.localeCompare(b)));
  }, [map, entryFile]);
  const [active, setActive] = useState('');
  useEffect(() => { setActive(''); }, [entryFile, names.join('|')]);
  const current = active || entryFile || names[0] || '';
  if (!names.length) return <Empty icon="file" title="没有产物" body="这次创作没有产出文件。" />;
  const group = artifactGroup(current.split('.').pop());
  return (
    <>
      <div className="c-file-tabs">
        {names.map((name) => (
          <button key={name} type="button" className={`c-file-tab${name === current ? ' is-active' : ''}`} onClick={() => setActive(name)}>{name}</button>
        ))}
      </div>
      <div className="c-source__bar">
        <span className="c-source__name"><ConsoleIcon name="file" size={13} />{current}</span>
        <span className="c-tag-mono">{group.label}</span>
        <span className="c-dim" style={{ fontSize: 'var(--fs-xs)' }}>{fileSize(byteLength(map[current]))} · 只读</span>
      </div>
      <pre className="c-source__code">{map[current] || ''}</pre>
    </>
  );
}

/** 创作对话回放：只读，保留用户气泡与助手正文的区别 */
export function ReplayTranscript({ messages = [] }) {
  if (!messages.length) return <Empty icon="messageSquare" title="没有对话记录" body="这次提交没有可回放的对话。" />;
  return (
    <div className="c-replay__thread">
      {messages.map((message, index) => (
        message.role === 'user' ? (
          <article className="c-msg-user" key={index}>
            <div className="c-msg-user__stack"><div className="c-msg-user__bubble">{message.content}</div></div>
            {message.createdAt ? <time className="c-msg-time" style={{ marginTop: 4 }}>{relativeTime(message.createdAt)}</time> : null}
          </article>
        ) : (
          <article className="c-msg-ai" key={index}>
            <div className="c-msg-ai__main">
              <div className="c-msg-ai__text"><MarkdownView content={message.content} /></div>
            </div>
          </article>
        )
      ))}
    </div>
  );
}

export { filesFromMap };
