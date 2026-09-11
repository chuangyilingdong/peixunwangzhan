// 控制台外壳：侧边栏（可拖拽调宽 / 可 off-canvas 收起）+ 顶栏 + 主区。
// 侧边栏宽度常量、吸附阈值、迟滞带、键盘步进全部照参考（OpenSquilla）取值。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConsoleIcon } from './icons.jsx';
import { IconButton } from './primitives.jsx';

// ── 布局常量（照抄参考，不自己发明） ──────────────────────────────────────────
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_COMPACT_MAX_WIDTH = 260;
const COLLAPSE_THRESHOLD = 200;       // 拖到此值 → 进入「松手即收起」待发状态
const COLLAPSE_EXIT_THRESHOLD = 216;  // 回拖到此值 → 取消（16px 迟滞，防抖）
const DRAG_DEADZONE = 4;              // 位移小于此值不算拖拽，避免误触发提交
const RESIZABLE_MIN_VIEWPORT = 960;   // ≥960 才允许拖宽
const DRAWER_MAX_VIEWPORT = 768;      // ≤768 侧边栏变抽屉
const STORAGE_KEY = 'magic.sidebar.width.v1';

function readStoredWidth() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const width = Number(JSON.parse(raw)?.width);
    if (!Number.isFinite(width)) return null;
    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width));
  } catch { return null; }
}

/** 侧边栏布局模式：drawer（窄屏/粗指针） · compact（放不下拖宽） · resizable */
export function sidebarLayoutMode({ width, coarseOnly }) {
  if (width <= DRAWER_MAX_VIEWPORT || coarseOnly) return 'drawer';
  if (width < RESIZABLE_MIN_VIEWPORT) return 'compact';
  return 'resizable';
}

/** 动态上限：视口再大也不超过 480，且至少给主区留 700px */
function dynamicMax(viewportWidth) {
  return Math.floor(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - 700)));
}

export function useSidebarLayout() {
  const [viewport, setViewport] = useState(() => (typeof window === 'undefined'
    ? { width: 1280, coarseOnly: false }
    : { width: window.innerWidth, coarseOnly: Boolean(window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia?.('(any-pointer: fine)').matches) }));
  const [storedWidth, setStoredWidth] = useState(() => readStoredWidth() ?? SIDEBAR_DEFAULT_WIDTH);

  useEffect(() => {
    const sync = () => setViewport({
      width: window.innerWidth,
      coarseOnly: Boolean(window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia?.('(any-pointer: fine)').matches),
    });
    window.addEventListener('resize', sync);
    const media = window.matchMedia?.('(pointer: coarse)');
    media?.addEventListener?.('change', sync);
    return () => { window.removeEventListener('resize', sync); media?.removeEventListener?.('change', sync); };
  }, []);

  const mode = sidebarLayoutMode(viewport);
  const width = mode === 'compact' ? Math.min(storedWidth, SIDEBAR_COMPACT_MAX_WIDTH) : storedWidth;

  const commit = useCallback((next) => {
    setStoredWidth(next);
    try {
      if (next === SIDEBAR_DEFAULT_WIDTH) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, width: next }));
    } catch { /* 隐私模式写不了就算了，不影响本次会话 */ }
  }, []);

  return { mode, width, commit, viewport, maxWidth: dynamicMax(viewport.width) };
}

/* ── 侧边栏拖拽手柄 ─────────────────────────────────────────────────────────
   手感要点（全部来自参考）：命中区 10px 而可见的只有 1px 线；位移 <4px 不算拖拽；
   pointermove 用 rAF 合帧，每帧只写一次根变量；拖到 ≤200px 进入「松手即收起」，
   回拖到 ≥216 才解除；键盘 ←/→ 步进 8px、Shift 32px，双击复位。 */
function SidebarResizer({ width, max, onPreview, onCommit, onCollapse }) {
  const stateRef = useRef(null);
  const frameRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => () => {
    document.documentElement.classList.remove('is-console-resizing');
    if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
  }, []);

  const onPointerDown = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stateRef.current = { start: width, last: width, startX: event.clientX, moved: false };
    setDragging(true);
    document.documentElement.classList.add('is-console-resizing');

    const onMove = (moveEvent) => {
      const state = stateRef.current;
      if (!state) return;
      const delta = moveEvent.clientX - state.startX;
      if (!state.moved && Math.abs(delta) < DRAG_DEADZONE) return;
      state.moved = true;
      state.last = state.start + delta;
      setArmed((current) => (current ? state.last <= COLLAPSE_EXIT_THRESHOLD : state.last <= COLLAPSE_THRESHOLD));
      if (frameRef.current) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = 0;
        const current = stateRef.current;
        if (current) onPreview(Math.max(SIDEBAR_MIN_WIDTH, Math.min(max, current.last)));
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const state = stateRef.current;
      stateRef.current = null;
      document.documentElement.classList.remove('is-console-resizing');
      if (frameRef.current) { window.cancelAnimationFrame(frameRef.current); frameRef.current = 0; }
      setDragging(false);
      setArmed(false);
      if (!state || !state.moved) return;
      if (state.last <= COLLAPSE_THRESHOLD) { onCollapse(); return; }
      if (state.last !== state.start) onCommit(Math.max(SIDEBAR_MIN_WIDTH, Math.min(max, state.last)));
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [width, max, onPreview, onCommit, onCollapse]);

  const onKeyDown = useCallback((event) => {
    const step = event.shiftKey ? 32 : 8;
    const clamp = (value) => Math.max(SIDEBAR_MIN_WIDTH, Math.min(max, value));
    if (event.key === 'ArrowLeft') { event.preventDefault(); onCommit(clamp(width - step)); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); onCommit(clamp(width + step)); }
    else if (event.key === 'Home') { event.preventDefault(); onCommit(SIDEBAR_MIN_WIDTH); }
    else if (event.key === 'End') { event.preventDefault(); onCommit(max); }
  }, [width, max, onCommit]);

  return (
    <>
      <div
        className={`c-sidebar-resizer${dragging ? ' is-dragging' : ''}${armed ? ' is-armed' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={max}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => onCommit(SIDEBAR_DEFAULT_WIDTH)}
      >
        {armed ? (
          <span className="c-collapse-hint" style={{ left: 14, top: '50%' }}>
            <ConsoleIcon name="panelLeft" size={14} />
            松手即收起侧边栏
          </span>
        ) : null}
      </div>
    </>
  );
}

/** 会话行的悬停卡片：零延迟、零动效（扫过列表时不该乱闪） */
function SessionHoverCard({ anchor, session, onDismiss }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useEffect(() => {
    if (!anchor) { setPos(null); return; }
    const CARD_WIDTH = 272;
    const ESTIMATED_HEIGHT = 104;
    const margin = 12;
    let left = anchor.right + 8;
    if (left + CARD_WIDTH > window.innerWidth - margin) left = anchor.left - 8 - CARD_WIDTH;
    let top = Math.max(margin, Math.min(window.innerHeight - margin - ESTIMATED_HEIGHT, anchor.top));
    left = Math.max(margin, left);
    setPos({ left, top });

    // 挂载后再量一次真实尺寸做二次内缩
    const frame = window.requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const nextTop = Math.max(margin, Math.min(window.innerHeight - margin - rect.height, anchor.top));
      if (nextTop !== top) setPos({ left, top: nextTop });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const close = () => onDismiss();
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [anchor, onDismiss]);

  if (!anchor || !pos) return null;
  return (
    <div className="c-hover-card" ref={ref} style={pos} role="presentation">
      <div className="c-hover-card__head">
        <span>{session.title}</span>
        {session.timeLabel ? <time>{session.timeLabel}</time> : null}
      </div>
      {session.hoverMeta ? <p className="c-hover-card__meta">{session.hoverMeta}</p> : null}
    </div>
  );
}

/**
 * 会话侧边栏：置顶 / 最近两个显示区，悬停卡，选中态，拖拽调宽。
 * 分组内容由调用方给，这里只负责渲染与交互。
 */
export function ConsoleSidebar({
  visible, mode, width, maxWidth, onPreviewWidth, onCommitWidth, onCollapse,
  brand, newLabel = '新建对话', onNew, navItems = [], zones = [], activeId, onSelect, onRowMenu,
  search, onSearch, foot, emptyText = '还没有对话。',
}) {
  const [hover, setHover] = useState(null);
  const [searchValue, setSearchValue] = useState(search || '');

  useEffect(() => { setSearchValue(search || ''); }, [search]);
  useEffect(() => {
    if (!onSearch) return;
    const timer = window.setTimeout(() => onSearch(searchValue.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchValue, onSearch]);

  const allSessions = useMemo(() => zones.flatMap((zone) => zone.items), [zones]);
  const hoveredSession = allSessions.find((item) => item.id === hover?.id);

  return (
    <>
      <aside className={`c-sidebar${visible ? ' is-docked' : ''}`} aria-label="会话导航">
        <div className="c-sidebar__brand">
          <span className="c-sidebar__mark" aria-hidden="true">{brand?.mark || <ConsoleIcon name="sparkle" size={16} />}</span>
          <div className="c-sidebar__brand-text">
            <strong>{brand?.title || 'VibeCoding'}</strong>
            {brand?.subtitle ? <small>{brand.subtitle}</small> : null}
          </div>
          <IconButton icon="panelLeft" label="收起侧边栏" onClick={onCollapse} small />
        </div>

        <div className="c-sidebar__core">
          <button type="button" className="c-new-session" onClick={onNew}>
            <ConsoleIcon name="plus" size={16} />
            <span>{newLabel}</span>
          </button>
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`c-nav-item${item.active ? ' is-active' : ''}`}
              onClick={item.onClick}
              title={item.title || item.label}
            >
              {item.icon ? <ConsoleIcon name={item.icon} size={15} /> : null}
              <span>{item.label}</span>
              {item.trailing || null}
            </button>
          ))}
        </div>

        <div className="c-sidebar__history">
          {onSearch ? (
            <div className="c-sidebar__search">
              <input
                className="c-input"
                value={searchValue}
                placeholder="搜索对话…"
                aria-label="搜索对话"
                onChange={(event) => setSearchValue(event.target.value)}
              />
            </div>
          ) : null}

          <div className="c-sidebar__zones">
            {zones.map((zone) => (
              <section key={zone.id}>
                <div className="c-zone-heading">
                  <span>{zone.label}</span>
                  {zone.count != null ? <small>{zone.count}</small> : null}
                </div>
                {zone.items.map((session) => (
                  <div
                    className="c-session-row"
                    key={session.id}
                    onMouseEnter={(event) => setHover({ id: session.id, rect: event.currentTarget.getBoundingClientRect() })}
                    onMouseLeave={() => setHover((current) => (current?.id === session.id ? null : current))}
                    onFocus={(event) => setHover({ id: session.id, rect: event.currentTarget.getBoundingClientRect() })}
                    onBlur={() => setHover((current) => (current?.id === session.id ? null : current))}
                  >
                    <button
                      type="button"
                      className={`c-session-item${session.id === activeId ? ' is-current' : ''}`}
                      onClick={() => onSelect?.(session)}
                      title={session.title}
                    >
                      <span className="c-session-title">{session.title}</span>
                      {session.pinned ? <ConsoleIcon className="c-session-row__pin" name="pin" size={11} /> : null}
                    </button>
                    {onRowMenu ? (
                      <div className="c-session-row__menu">
                        <IconButton icon="more" size={15} label="更多操作" small onClick={(event) => onRowMenu(session, event)} />
                      </div>
                    ) : null}
                  </div>
                ))}
              </section>
            ))}
            {allSessions.length ? null : <p className="c-sidebar__empty">{emptyText}</p>}
          </div>
        </div>

        {foot ? <div className="c-sidebar__foot">{foot}</div> : null}
      </aside>

      <SessionHoverCard
        anchor={hover?.rect || null}
        session={hoveredSession || {}}
        onDismiss={() => setHover(null)}
      />

      {mode === 'resizable' && visible ? (
        <SidebarResizer
          width={width}
          max={maxWidth}
          onPreview={onPreviewWidth}
          onCommit={onCommitWidth}
          onCollapse={onCollapse}
        />
      ) : null}
    </>
  );
}

/** 顶栏：左（展开按钮，仅侧边栏收起时出现）· 中（标题）· 右（动作槽） */
export function ConsoleTopbar({ onExpandSidebar, title, subtitle, actions }) {
  return (
    <header className="c-topbar">
      <div className="c-topbar__left">
        {onExpandSidebar ? <IconButton icon="panelLeft" label="展开侧边栏" onClick={onExpandSidebar} small /> : null}
      </div>
      <div className="c-topbar__title">
        {subtitle ? <span>{subtitle}</span> : null}
        <strong title={typeof title === 'string' ? title : undefined}>{title}</strong>
      </div>
      <div className="c-topbar__right">{actions}</div>
    </header>
  );
}

/**
 * 外壳：摆好侧边栏 / 顶栏 / 主区，并接管侧边栏的宽度与开合状态。
 * 主区内容（对话 + 工作台）由 children 提供。
 *
 * 注意：侧边栏开合时主区的位移是「瞬间吸附」的，CSS 里刻意没给它过渡——
 * 给 margin 加动画会让整个内容子树每帧重排（参考专门为性能放弃了这条动效）。
 */
export function ConsoleShell({
  brand, newLabel, onNew, navItems, zones, activeId, onSelect, onRowMenu, search, onSearch, foot, emptyText,
  title, subtitle, actions, children,
}) {
  const { mode, width, commit, viewport, maxWidth } = useSidebarLayout();
  const isDrawer = mode === 'drawer';
  const [open, setOpen] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth > DRAWER_MAX_VIEWPORT));
  const [previewWidth, setPreviewWidth] = useState(null);

  // 视口跨断点时收敛抽屉状态，避免大屏残留遮罩 / 小屏侧边栏挡内容
  useEffect(() => { setOpen(!isDrawer); }, [isDrawer]);
  useEffect(() => {
    if (isDrawer) return undefined;
    const onKey = (event) => { if (event.key === '[' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); setOpen((v) => !v); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDrawer]);

  const sidebarWidth = isDrawer ? Math.min(280, Math.max(SIDEBAR_MIN_WIDTH, viewport.width - 24)) : (previewWidth ?? width);
  const visible = isDrawer ? open : open;

  return (
    <div
      className={`c-shell${visible && !isDrawer ? ' is-docked' : ''}`}
      data-console="vibecoding"
      style={{ '--sidebar-width': `${sidebarWidth}px` }}
    >
      <ConsoleSidebar
        visible={visible}
        mode={mode}
        width={sidebarWidth}
        maxWidth={maxWidth}
        onPreviewWidth={setPreviewWidth}
        onCommitWidth={(next) => { setPreviewWidth(null); commit(next); }}
        onCollapse={() => setOpen(false)}
        brand={brand}
        newLabel={newLabel}
        onNew={onNew}
        navItems={navItems}
        zones={zones}
        activeId={activeId}
        onSelect={onSelect}
        onRowMenu={onRowMenu}
        search={search}
        onSearch={onSearch}
        foot={foot}
        emptyText={emptyText}
      />

      <div className="c-main">
        <ConsoleTopbar
          onExpandSidebar={visible ? null : () => setOpen(true)}
          title={title}
          subtitle={subtitle}
          actions={actions}
        />
        <div className="c-workspace">{children}</div>
      </div>

      {isDrawer && open ? <div className="c-scrim" onClick={() => setOpen(false)} role="presentation" /> : null}
    </div>
  );
}
