// 只读回放：官网公开作品页用（教师点评页已于 2026-09-11 按用户要求删除）。
//
// 学生不再手写代码，所以要回放的是两样东西——**创作对话的过程**和
// **最终的产物**。这里就是这两样的只读渲染，复用对话流的视觉语言（用户气泡 /
// 助手正文无气泡 / 代码块 / 产物外观），但不带任何操作按钮。
import { useEffect, useMemo, useState } from 'react';
import { ConsoleIcon } from './icons.jsx';
import { Empty, IconButton } from './primitives.jsx';
import { PreviewFrame } from './PreviewFrame.jsx';
import { DocumentPreview } from './DocumentPreview.jsx';
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

/**
 * 真文件产物的只读预览：服务端已经把 Office 转成 PDF，这里只是把它显示出来。
 * 为什么不像规格文本那样在客户端渲染：`.pptx` 是二进制，浏览器渲染不了；
 * 而作品广场的用途就是「给人看」—— 点开只有下载入口等于没展示。
 */
export function ReplayFilePreview({ url, name = '' }) {
  return (
    <ReplayPanel title="作品预览" icon="eye" className="c-replay__preview">
      <iframe className="c-replay__doc" src={url} title={name || '作品预览'} />
    </ReplayPanel>
  );
}

/**
 * 作品预览：真的能玩（沙箱 iframe 里跑学生的 HTML）。
 *
 * @param chrome 可选（默认 true）：要不要「作品预览」那层面板（标题条 + 重新运行）。
 *   ⚠️ **"看作品"的页面**（作品广场 / 学生主页 / 分享页、老师端与平台端的只读预览）请传
 *   `chrome={false} responsive` —— 2026-09-30 用户口径（原话）：
 *   「像图2 这种界面，怎么玩？那么小的界面。**为什么非要用作品预览把作品框上呢？不需要这些东西**」。
 *   工作台（学生自己边改边看、老师备课预览）保留面板，那里「重新运行」是常用的。
 * @param responsive 可选：**不缩放、按容器宽度自适应**（电脑端与手机端各自长成它自己的样子，
 *   见 PreviewFrame 里 PREVIEW_RESPONSIVE_MIN_H 那段注释）。
 */
export function ReplayPreview({ html, title = '作品预览', height = '62vh', fitContent = false, chrome = true, responsive = false, fill = false }) {
  const [reloadKey, setReloadKey] = useState(0);
  /* ⭐ 老口径（缩放）与 `responsive`（自适应）与 `fill`（铺满容器）是三条路：
     · 老口径：内层按 ≥640×768 的逻辑视口渲染再整体缩放 —— 面板越宽越扁，缩放比越小（实测 0.52），
       手机上字小到点不着，正是用户 2026-09-30 报的那张图；
     · `responsive`：不缩放，宽度＝容器真实宽度（学生页自己的媒体查询因此生效），
       高度＝内层自报的内容高度（下界 600 / 上界 4000）—— 公开页/分享页用这个；
     · `fill`（2026-10-02，老师端弹窗）：铺满给定容器、原生比例、**滚动条在 iframe 内部** ——
       弹窗不再整体滚动，页眉（分享按钮）与页脚常驻。容器必须有确定高度（调用方给）。 */
  const stage = <PreviewFrame
    className="c-replay__frame"
    html={html}
    reloadKey={reloadKey}
    title={title}
    fitToLogical={!responsive && !fill}
    fitContent={fitContent}
    responsive={responsive}
    fill={fill}
    stageClassName={fill ? 'c-replay__stage c-replay__stage--fill' : (responsive ? 'c-replay__stage c-replay__stage--flow' : (fitContent ? 'c-replay__stage c-replay__stage--tall' : 'c-replay__stage'))}
  />;
  if (!chrome) return stage;
  return (
    <ReplayPanel
      title="作品预览"
      icon="eye"
      className="c-replay__preview"
      actions={<IconButton icon="refresh" size={14} label="重新运行" small onClick={() => setReloadKey((value) => value + 1)} />}
    >
      {stage}
    </ReplayPanel>
  );
}

/** 文档产物（PPT / Word / Excel）：先预览，再下载。
 *  学生端工作台与官网公开作品页共用这一份——「预览长什么样」不该两边各写一遍。
 *  onDownload 由调用方决定：学生端要带鉴权取 blob，广场是公开地址直接下载。 */
export function ReplayDocument({ artifact, resolveImage, onDownload, downloadLabel = '下载' }) {
  return (
    <>
      <div className="c-preview__toolbar">
        <span className="c-preview__url" title={artifact?.name}>
          <ConsoleIcon name={artifactGroup(artifact?.kind).icon} size={13} />
          {artifact?.name}
        </span>
        {onDownload ? (
          <button type="button" className="c-btn c-btn--primary c-btn--sm" onClick={onDownload}>
            <ConsoleIcon name="download" size={14} />
            <span>{downloadLabel}</span>
          </button>
        ) : null}
      </div>
      <div className="c-preview__doc">
        <DocumentPreview artifact={artifact} resolveImage={resolveImage} />
      </div>
    </>
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
