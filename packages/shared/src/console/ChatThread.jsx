// 对话流：用户气泡 / 助手正文（无气泡）/ 活动折叠 / 流式态 / 产物卡片。
// 滚动容器本身由外层持有（见 useFollowScroll.js），这里保持纯展示，
// 「回到底部」按钮也挂在输入停靠区里，所以不在这个文件。
//
// 一处刻意做对的地方：活动区在流式结束后**强制收起**——那是一次显式的视觉
// 移交，让最终回答成为稳定的阅读终点，而不是让工具噪声永久占着版面。
import { useEffect, useMemo, useState } from 'react';
import { ConsoleIcon } from './icons.jsx';
import { CopyButton, IconButton, Dot, Empty } from './primitives.jsx';
import { MarkdownView } from '../markdown.jsx';
import { artifactGroup, absoluteTime, duration, fileSize, isPreviewable, relativeTime } from './format.js';

// ── 流式状态行 ──────────────────────────────────────────────────────────────
// 400ms 延迟才出现：短请求不该闪一下状态行。动词每 2.5s 轮换一次。
const LIVE_VERBS = ['正在规划下一步', '正在读取上下文', '正在准备输出'];
const THINKING_DELAY_MS = 400;
const VERB_DWELL_MS = 2500;

/** 从 startedAt 起每秒走一格；active 为 false 时停住，避免终态还在跑定时器
 *  ⚠️ startedAt 是 ISO 字符串，必须先转成时间戳再相减——直接减会得到 NaN，
 *  显示层再兜一层就成了永远「0s」（线上就是这样：跑了两分钟还显示 0s）。 */
function useElapsedSeconds(startedAt, active) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const base = startedAt ? new Date(startedAt).getTime() : Date.now();
    if (!Number.isFinite(base)) return undefined;
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - base) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, active]);
  return seconds;
}

function LiveRow({ startedAt }) {
  const [visible, setVisible] = useState(false);
  const seconds = useElapsedSeconds(startedAt, visible);
  const [verbIndex, setVerbIndex] = useState(0);

  useEffect(() => {
    const showTimer = window.setTimeout(() => setVisible(true), THINKING_DELAY_MS);
    return () => window.clearTimeout(showTimer);
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    const rotate = window.setInterval(() => setVerbIndex((value) => (value + 1) % LIVE_VERBS.length), VERB_DWELL_MS);
    return () => window.clearInterval(rotate);
  }, [visible]);

  if (!visible) return null;
  return (
    <div className="c-live" role="status" aria-live="polite">
      <Dot tone="ok" pulse />
      <span>{LIVE_VERBS[verbIndex]}</span>
      <span className="c-live__elapsed">· {duration(seconds)}</span>
    </div>
  );
}

// ── 活动折叠 ────────────────────────────────────────────────────────────────
function ActivityDisclosure({ steps, live, startedAt, elapsedMs }) {
  const [manualOpen, setManualOpen] = useState(null);
  // 流式中默认展开；一旦进入终态，强制收起并清掉手动开合记录
  const defaultOpen = Boolean(live);
  useEffect(() => { setManualOpen(null); }, [defaultOpen]);
  const open = manualOpen ?? defaultOpen;
  const liveSeconds = useElapsedSeconds(startedAt, live);
  const hasSteps = steps.length > 0;
  if (!hasSteps && !live) return null;

  const seconds = live ? liveSeconds : Math.round((elapsedMs || 0) / 1000);
  const settledLabel = seconds > 0 ? `工作了 ${duration(seconds)}` : '已完成';
  const label = live
    ? `正在工作 · ${duration(liveSeconds)}`
    : hasSteps ? `${settledLabel} · ${steps.length} 步` : settledLabel;

  return (
    <div className={`c-activity${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className={`c-activity__head${live ? '' : ' is-settled'}`}
        aria-expanded={open}
        onClick={() => setManualOpen(!open)}
      >
        <ConsoleIcon className={`c-activity__chevron${open ? ' is-open' : ''}`} name="chevronRight" size={13} />
        {live ? <Dot tone="accent" pulse /> : null}
        <span>{label}</span>
      </button>
      <div className="c-activity__body">
        <div className="c-activity__body-inner">
          {steps.map((step, index) => (
            <div
              key={step.id || index}
              className="c-activity__step"
              style={{ animationDelay: `${Math.min(index, 3) * 30}ms` }}
            >
              <b>{step.label}</b>
              {/* 思考过程是长文本：单独给一个限高可滚动的块，
                  不然几千字的推理会把整个折叠区撑得没法看 */}
              {step.detail ? (step.reasoning
                ? <p className="c-activity__reasoning">{step.detail}</p>
                : <p>{step.detail}</p>) : null}
              {step.at ? <time>{relativeTime(step.at)}</time> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 产物卡片 ────────────────────────────────────────────────────────────────
// 规矩：主体 = 主动作。能预览才给「打开」，否则只给「下载」。
function ArtifactCard({ artifact, onOpen, onDownload }) {
  const group = artifactGroup(artifact.kind);
  const canOpen = isPreviewable(artifact.kind);
  const meta = [
    group.label,
    artifact.bytes ? fileSize(artifact.bytes) : null,
    artifact.updated ? relativeTime(artifact.updated) : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="c-artifact-chip">
      <button
        type="button"
        className="c-artifact-chip__body"
        onClick={() => (canOpen ? onOpen?.(artifact) : onDownload?.(artifact))}
        aria-label={`${artifact.name}，${group.label}${artifact.bytes ? `，${fileSize(artifact.bytes)}` : ''}`}
      >
        <span className="c-artifact-chip__icon" data-kind={group.tone}>
          <ConsoleIcon name={group.icon} size={20} />
        </span>
        <span>
          <span className="c-artifact-chip__name">{artifact.name}</span>
          <span className="c-artifact-chip__meta">{meta}</span>
        </span>
      </button>
      <div className="c-artifact-chip__actions">
        {canOpen ? (
          <button type="button" className="c-artifact-chip__open" onClick={() => onOpen?.(artifact)} aria-label={`打开 ${artifact.name}`}>
            <ConsoleIcon name="external" size={14} />
            <span>打开</span>
          </button>
        ) : null}
        <IconButton icon="download" size={15} label={`下载 ${artifact.name}`} onClick={() => onDownload?.(artifact)} />
      </div>
    </div>
  );
}

// ── 单条消息 ────────────────────────────────────────────────────────────────
function UserMessage({ message, editable, onEdit, onDelete, canEdit }) {
  return (
    <article className="c-msg-user">
      <div className="c-msg-user__stack">
        {/* 附件是叠在气泡**上方**的独立对象，不塞进气泡里（与参考的「容器语法」一致） */}
        {message.attachments?.length ? (
          <div className="c-msg-user__attachments">
            {message.attachments.map((item) => (
              <a className="c-msg-attachment" key={item.id} href={item.url} target="_blank" rel="noreferrer noopener" title={item.name}>
                <img src={item.url} alt={item.name} loading="lazy" />
              </a>
            ))}
          </div>
        ) : null}
        <div className="c-msg-user__bubble">{message.content}</div>
      </div>
      <div className="c-msg-actions">
        <CopyButton text={message.content} />
        {canEdit && editable ? (
          <button type="button" className="c-msg-action" onClick={() => onEdit?.(message)}>
            <ConsoleIcon name="edit" size={13} />
            编辑
          </button>
        ) : null}
        {onDelete && !String(message.id).startsWith('local-') ? (
          <button type="button" className="c-msg-action" onClick={() => onDelete(message)}>
            <ConsoleIcon name="trash" size={13} />
            删除
          </button>
        ) : null}
        <time className="c-msg-time" title={absoluteTime(message.createdAt)}>{relativeTime(message.createdAt)}</time>
      </div>
    </article>
  );
}

function AssistantMessage({ message, streaming, onRegenerate, onDelete, onOpenArtifact, onDownloadArtifact, canRegenerate }) {
  const steps = message.activity || [];
  const artifacts = message.artifacts || [];
  const live = message.status === 'STREAMING';
  const hasBody = Boolean(String(message.content || '').trim());

  return (
    <article className="c-msg-ai">
      <div className="c-msg-ai__main">
        <ActivityDisclosure steps={steps} live={live} startedAt={message.startedAt} elapsedMs={message.elapsedMs} />
        {hasBody ? (
          <div className={`c-msg-ai__text${steps.length ? ' c-answer' : ''}${live ? ' is-streaming' : ''}`}>
            {/* 流式期间不做语法高亮：每个 delta 都重跑整块高亮会很卡，
                落地后再一次性着色（参考也是这么做的） */}
            <MarkdownView content={message.content} streaming={live} />
          </div>
        ) : null}
        {live && !hasBody ? <LiveRow startedAt={message.startedAt} /> : null}

        {artifacts.length ? (
          <div className="c-artifacts">
            {artifacts.map((artifact) => (
              <ArtifactCard
                key={artifact.id || artifact.name}
                artifact={artifact}
                onOpen={onOpenArtifact}
                onDownload={onDownloadArtifact}
              />
            ))}
          </div>
        ) : null}

        {message.status === 'FAILED' ? (
          <div className="c-msg-error" role="alert">
            <ConsoleIcon name="alert" size={15} />
            <span>{message.errorMessage || message.errorCode || 'AI 回复失败'}</span>
          </div>
        ) : null}
        {message.status === 'ABORTED' ? (
          <p className="c-dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--sp-2)' }}>已停止生成。</p>
        ) : null}

        {!live ? (
          <div className="c-msg-actions">
            {hasBody ? <CopyButton text={message.content} /> : null}
            {canRegenerate ? (
              <button type="button" className="c-msg-action" disabled={streaming} onClick={() => onRegenerate?.(message)}>
                <ConsoleIcon name="refresh" size={13} />
                重新生成
              </button>
            ) : null}
            {onDelete && !String(message.id).startsWith('local-') ? (
              <button type="button" className="c-msg-action" onClick={() => onDelete(message)}>
                <ConsoleIcon name="trash" size={13} />
                删除
              </button>
            ) : null}
            <time className="c-msg-time" title={absoluteTime(message.createdAt)}>{relativeTime(message.createdAt)}</time>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/**
 * 对话流（纯展示）。
 * @param threadRef 滚动容器的 ref，由 useFollowScroll 提供
 * @param dockHeight 输入面板实测高度（px）——由 useDockHeight 量好传进来，
 *                   给滚动区预留底部空间，避免最后一条消息被面板压住
 */
export function ChatThread({
  threadRef, messages = [], streaming = false, dockHeight = 200, editable = true,
  onRegenerate, onEditMessage, onDeleteMessage, onOpenArtifact, onDownloadArtifact,
  emptyState, lastUserMessageId,
}) {
  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') return messages[index].id;
    }
    return null;
  }, [messages]);

  return (
    <div
      className="c-thread"
      ref={threadRef}
      role="region"
      tabIndex={0}
      aria-label="对话内容"
      aria-busy={streaming ? 'true' : undefined}
      style={{ '--composer-dock-h': `${Math.max(0, dockHeight)}px` }}
    >
      <div className="c-thread__inner">
        {messages.length ? messages.map((message) => (
          message.role === 'user'
            ? (
              <UserMessage
                key={message.id}
                message={message}
                editable={editable}
                canEdit={message.id === lastUserMessageId}
                onEdit={onEditMessage}
                onDelete={onDeleteMessage}
              />
            )
            : (
              <AssistantMessage
                key={message.id}
                message={message}
                streaming={streaming}
                canRegenerate={message.id === lastAssistantId && editable}
                onRegenerate={onRegenerate}
                onDelete={onDeleteMessage}
                onOpenArtifact={onOpenArtifact}
                onDownloadArtifact={onDownloadArtifact}
              />
            )
        )) : (emptyState || <Empty icon="wand" title="和 AI 一起做东西" body="说一句你想做什么，AI 会把做好的网页直接放到右边给你玩。" />)}
      </div>
    </div>
  );
}

export { ArtifactCard };
