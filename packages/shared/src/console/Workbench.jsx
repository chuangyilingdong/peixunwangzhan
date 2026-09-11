// 右侧工作台：预览 / 源码 / 控制台 三个页签 + 可拖拽调宽。
// 宽度常量与手柄手感全部照参考（OpenSquilla）取值。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConsoleIcon } from './icons.jsx';
import { IconButton } from './primitives.jsx';
import { PreviewFrame } from './PreviewFrame.jsx';
import { artifactGroup, fileSize } from './format.js';
import { DocumentPreview } from './DocumentPreview.jsx';
import { isDocumentArtifact } from './attachments.js';

export const WORKBENCH_DEFAULT_WIDTH = 520;
export const WORKBENCH_MIN_WIDTH = 360;
const WORKBENCH_CHAT_MIN_WIDTH = 480;     // 聊天侧至少留这么宽
const WORKBENCH_MAX_VIEWPORT_RATIO = 0.7; // 预览最多占视口 70%
const WORKBENCH_SPLIT_MIN_WIDTH = 960;    // ≥960 分栏，以下变浮层
const WORKBENCH_MOBILE_MAX_WIDTH = 720;   // ≤720 全屏
const DRAG_DEADZONE = 4;
const STORAGE_KEY = 'magic.workbench.width.v1';

/** 工作台展示模式：split（分栏） · overlay（浮层） · mobile（全屏） */
export function workbenchMode(viewportWidth) {
  if (viewportWidth <= WORKBENCH_MOBILE_MAX_WIDTH) return 'mobile';
  if (viewportWidth < WORKBENCH_SPLIT_MIN_WIDTH) return 'overlay';
  return 'split';
}

function clampWidth(raw, viewportWidth) {
  const dynamicMax = Math.max(WORKBENCH_MIN_WIDTH, Math.min(
    Math.floor(viewportWidth * WORKBENCH_MAX_VIEWPORT_RATIO),
    viewportWidth - WORKBENCH_CHAT_MIN_WIDTH,
  ));
  return Math.max(WORKBENCH_MIN_WIDTH, Math.min(dynamicMax, raw));
}

export function useWorkbenchWidth() {
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  // 从未手动拖过时，宽度是可用宽的 50%（参考的默认策略）
  const [committed, setCommitted] = useState(() => {
    if (typeof window === 'undefined') return WORKBENCH_DEFAULT_WIDTH;
    try {
      const stored = Number(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')?.width);
      if (Number.isFinite(stored)) return stored;
    } catch { /* 读不到就用默认 */ }
    return clampWidth(Math.floor(window.innerWidth / 2), window.innerWidth);
  });
  // 拖拽期间只改视觉宽度，松手才落库——避免每一帧都写 localStorage
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    const sync = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  const mode = workbenchMode(viewportWidth);
  const maxWidth = useMemo(
    () => Math.max(WORKBENCH_MIN_WIDTH, Math.min(
      Math.floor(viewportWidth * WORKBENCH_MAX_VIEWPORT_RATIO),
      viewportWidth - WORKBENCH_CHAT_MIN_WIDTH,
    )),
    [viewportWidth],
  );

  const commit = useCallback((next) => {
    setPreview(null);
    setCommitted(next);
    try {
      if (next === WORKBENCH_DEFAULT_WIDTH) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, width: next }));
    } catch { /* 隐私模式写不了就算了 */ }
  }, []);

  return {
    mode,
    width: preview ?? committed,
    maxWidth,
    commit,
    preview: setPreview,
    viewportWidth,
  };
}

/* ── 拖拽手柄 ───────────────────────────────────────────────────────────────
   命中区 16px 且一半压在对话侧：工作台自己 overflow:hidden，而预览是原生网页
   表面会吃掉指针事件，把手必须能从相邻面板够到。
   视觉线只有 2px，hover 只换色不加粗——拖拽时线不会跳一下。
   软失败恢复：Escape / 指针取消 / 丢捕获都回滚到起始宽度。 */
function WorkbenchResizer({ width, max, onPreview, onCommit, onCancel }) {
  const stateRef = useRef(null);
  const frameRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const cleanup = useCallback(() => {
    document.documentElement.classList.remove('is-workbench-resizing');
    if (frameRef.current) { window.cancelAnimationFrame(frameRef.current); frameRef.current = 0; }
  }, []);
  useEffect(() => cleanup, [cleanup]);

  const onPointerDown = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stateRef.current = { start: width, last: width, startX: event.clientX, moved: false };
    setDragging(true);
    document.documentElement.classList.add('is-workbench-resizing');

    const onMove = (moveEvent) => {
      const state = stateRef.current;
      if (!state) return;
      const delta = state.startX - moveEvent.clientX; // 向左拖 = 变宽
      if (!state.moved && Math.abs(moveEvent.clientX - state.startX) < DRAG_DEADZONE) return;
      state.moved = true;
      state.last = Math.max(WORKBENCH_MIN_WIDTH, Math.min(max, state.start + delta));
      if (frameRef.current) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = 0;
        if (stateRef.current) onPreview(stateRef.current.last);
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const state = stateRef.current;
      stateRef.current = null;
      cleanup();
      setDragging(false);
      if (!state || !state.moved) return;
      if (state.last !== state.start) onCommit(state.last);
      else onCancel?.();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [width, max, onPreview, onCommit, onCancel, cleanup]);

  const onKeyDown = useCallback((event) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === 'ArrowLeft') { event.preventDefault(); onCommit(Math.min(max, width + step)); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); onCommit(Math.max(WORKBENCH_MIN_WIDTH, width - step)); }
    else if (event.key === 'Home') { event.preventDefault(); onCommit(WORKBENCH_MIN_WIDTH); }
    else if (event.key === 'End') { event.preventDefault(); onCommit(max); }
  }, [width, max, onCommit]);

  return (
    <div
      className={`c-workbench-resizer${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整工作台宽度"
      aria-valuemin={WORKBENCH_MIN_WIDTH}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(WORKBENCH_DEFAULT_WIDTH)}
    />
  );
}

const TABS = [
  { id: 'preview', label: '预览', icon: 'eye' },
  { id: 'source', label: '源码', icon: 'code' },
  { id: 'console', label: '控制台', icon: 'terminal' },
];

/**
 * 工作台。
 * @param artifacts 本次会话的全部产物
 * @param entryName 预览入口文件名（默认 index.html）
 * @param previewHtml 由调用方用 buildPreviewDocument 拼好的完整文档
 * @param consoleLines [{ level, text, source }]
 */
export function Workbench({
  mode = 'split', width, maxWidth, onPreviewWidth, onCommitWidth, onCancelWidth,
  artifacts = [], previewHtml = '', consoleLines = [], onClearConsole, onRefresh, onClose,
  activeTab, onTabChange, activeArtifactName, onSelectArtifact, running = false, emptyHint,
  tabs: allowedTabs, resolveAttachment, onDownloadArtifact,
}) {
  const [innerTab, setInnerTab] = useState('preview');
  const tab = activeTab ?? innerTab;
  const setTab = onTabChange ?? setInnerTab;
  const [reloadKey, setReloadKey] = useState(0);
  const [sourceName, setSourceName] = useState(null);
  // 学生端只给「预览」：代码与日志属于教师/调试视角，不是学生要看的东西
  const available = useMemo(
    () => (allowedTabs ? TABS.filter((item) => allowedTabs.includes(item.id)) : TABS),
    [allowedTabs],
  );

  const sourceArtifact = useMemo(() => {
    if (!artifacts.length) return null;
    const wanted = sourceName || activeArtifactName;
    return artifacts.find((item) => item.name === wanted) || artifacts[0];
  }, [artifacts, sourceName, activeArtifactName]);

  // 父级可能请求了一个被禁用的页签（例如学生端没有源码页），这时退回第一个可用页签
  const currentTab = available.some((item) => item.id === tab) ? tab : (available[0]?.id || 'preview');

  const previewable = artifacts.some((item) => /^html?$/i.test(String(item.kind)) || /\.html?$/i.test(item.name));

  // 预览区看什么：
  //   · 学生点名看了某个产物（点卡片/点文件页签）→ 就看它；
  //   · 没点名 → 看**最近产出的那个**；它如果是文档（PPT/Word/Excel）就渲染文档预览，
  //     否则回到网页预览（用 entryFile 拼整个站点）。
  // 这样「刚做出一个 PPT」时，预览区出现的就是那份 PPT，而不是被种子产物 index.html 占着。
  const documentArtifact = useMemo(() => {
    const wanted = activeArtifactName ? artifacts.find((item) => item.name === activeArtifactName) : null;
    if (wanted) return isDocumentArtifact(wanted.kind) ? wanted : null;
    const newest = [...artifacts]
      .sort((a, b) => String(b.updated || b.createdAt || '').localeCompare(String(a.updated || a.createdAt || '')))[0];
    return newest && isDocumentArtifact(newest.kind) ? newest : null;
  }, [artifacts, activeArtifactName]);

  const isSplit = mode === 'split';

  return (
    <aside
      className={`c-workbench${isSplit ? ' is-split' : ''}`}
      data-mode={mode}
      aria-label="工作台"
      aria-modal={isSplit ? undefined : 'true'}
      role={isSplit ? undefined : 'dialog'}
      style={{ '--workbench-width': `${width}px` }}
    >
      {isSplit ? (
        <WorkbenchResizer
          width={width}
          max={maxWidth}
          onPreview={onPreviewWidth}
          onCommit={onCommitWidth}
          onCancel={onCancelWidth}
        />
      ) : null}

      <div className="c-workbench__chrome">
        {/* 只有一个页签时不摆页签条，直接显示标题（参考也是这么处理的） */}
        {available.length > 1 ? (
          <div className="c-workbench__tabs" role="tablist">
            {available.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={`c-workbench__tab${tab === item.id ? ' is-active' : ''}`}
                onClick={() => setTab(item.id)}
              >
                <ConsoleIcon name={item.icon} size={14} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="c-workbench__tabs">
            <span className="c-workbench__title">{available[0]?.label || '预览'}</span>
          </div>
        )}
        {/* 刷新动作在各自面板里（预览有「重新运行」），这里不重复放一个同名按钮 */}
        {/* ⚠️ 图标名必须是控制台图标集里有的：写错会**静默渲染成一个空按钮**（这里原本写 close，
            而控制台只有 x，于是关闭键肉眼看不见）。p48 现在会静态扫出来，别再靠肉眼。 */}
        <IconButton icon="x" size={15} label="关闭工作台" onClick={onClose} small />
      </div>

      <div className="c-workbench__surface">
        <div className="c-workbench__layer" role="tabpanel" hidden={currentTab !== 'preview'}>
          {documentArtifact ? (
            <>
              {/* 文档产物：先在这里预览，再决定下载（用户明确要的顺序） */}
              <div className="c-preview__toolbar">
                <span className="c-preview__url" title={documentArtifact.name}>
                  <ConsoleIcon name={artifactGroup(documentArtifact.kind).icon} size={13} />
                  {documentArtifact.name}
                </span>
                <button
                  type="button"
                  className="c-btn c-btn--primary c-btn--sm"
                  onClick={() => onDownloadArtifact?.(documentArtifact)}
                >
                  <ConsoleIcon name="download" size={14} />
                  <span>下载</span>
                </button>
              </div>
              <div className="c-preview__doc">
                <DocumentPreview artifact={documentArtifact} resolveImage={(ordinal) => resolveAttachment?.(documentArtifact, ordinal)} />
              </div>
            </>
          ) : previewable ? (
            <>
              <div className="c-preview__toolbar">
                <span className="c-preview__url" title={entryLabel(artifacts)}>
                  <ConsoleIcon name="globe" size={13} />
                  {entryLabel(artifacts)}
                </span>
                <IconButton icon="refresh" size={15} label="重新运行" onClick={() => setReloadKey((value) => value + 1)} />
                <IconButton
                  icon="external"
                  size={15}
                  label="在新窗口打开"
                  onClick={() => openInNewWindow(previewHtml)}
                />
              </div>
              <PreviewFrame className="c-preview__frame" html={previewHtml} reloadKey={reloadKey} title="作品预览" />
            </>
          ) : (
            <div className="c-preview__status">
              {running ? (
                <span style={{ display: 'grid', gap: 'var(--sp-3)', justifyItems: 'center' }}>
                  <span className="c-progress-line" />
                  正在生成页面…
                </span>
              ) : (
                <span style={{ display: 'grid', gap: 'var(--sp-2)', justifyItems: 'center' }}>
                  <ConsoleIcon name="globe" size={22} />
                  {emptyHint || '还没有可预览的页面。让 AI 写一个 index.html 就会出现在这里。'}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="c-workbench__layer" role="tabpanel" hidden={currentTab !== 'source'}>
          {artifacts.length ? (
            <>
              <div className="c-file-tabs">
                {artifacts.map((artifact) => (
                  <button
                    key={artifact.id || artifact.name}
                    type="button"
                    className={`c-file-tab${artifact.name === sourceArtifact?.name ? ' is-active' : ''}`}
                    onClick={() => { setSourceName(artifact.name); onSelectArtifact?.(artifact); }}
                  >
                    {artifact.name}
                  </button>
                ))}
              </div>
              <div className="c-source__bar">
                <span className="c-source__name">
                  <ConsoleIcon name="file" size={13} />
                  {sourceArtifact?.name}
                </span>
                <span className="c-tag-mono">{artifactGroup(sourceArtifact?.kind).label}</span>
                <span className="c-dim" style={{ fontSize: 'var(--fs-xs)' }}>
                  {sourceArtifact?.bytes ? fileSize(sourceArtifact.bytes) : ''} · 只读
                </span>
              </div>
              <pre className="c-source__code">{sourceArtifact?.content || ''}</pre>
            </>
          ) : (
            <div className="c-workbench__empty">
              <ConsoleIcon name="code" size={22} />
              还没有产出任何文件。
            </div>
          )}
        </div>

        <div className="c-workbench__layer" role="tabpanel" hidden={currentTab !== 'console'}>
          <div className="c-source__bar">
            <span className="c-source__name"><ConsoleIcon name="terminal" size={13} /> 控制台</span>
            <button type="button" className="c-btn c-btn--ghost c-btn--sm" onClick={onClearConsole} disabled={!consoleLines.length}>清空</button>
          </div>
          <div className="c-console-body">
            {consoleLines.length ? consoleLines.map((line, index) => (
              <div key={index} className={`c-console-line${line.level && line.level !== 'log' ? ` is-${normalizeLevel(line.level)}` : ''}`}>
                {line.source ? <span className="c-console-line__src">{line.source}</span> : null}
                <span>{line.text}</span>
              </div>
            )) : <p className="c-dim">运行后这里会显示输出。</p>}
          </div>
        </div>
      </div>
    </aside>
  );
}

function normalizeLevel(level) {
  const value = String(level).toLowerCase();
  if (value === 'error' || value === 'err') return 'error';
  if (value === 'warn' || value === 'warning') return 'warn';
  return 'info';
}

function entryLabel(artifacts) {
  const entry = artifacts.find((item) => /^index\.html?$/i.test(item.name)) || artifacts.find((item) => /\.html?$/i.test(item.name));
  return entry ? `作品预览 · ${entry.name}` : '作品预览';
}

/** 把当前预览文档在一个新标签页里打开（学生作品是自包含 HTML，可以直接跑） */
function openInNewWindow(html) {
  try {
    const blob = new Blob([String(html || '')], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch { /* 弹窗被拦就静默 */ }
}

export { clampWidth as clampWorkbenchWidth };
