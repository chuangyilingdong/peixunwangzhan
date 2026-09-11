// 控制台原语：按钮、标记、状态点、空态、载入、Toast、复制反馈。
// 全部只是 class 的薄封装，样式在 kit.css 里，不在这里写内联样式。
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ConsoleIcon } from './icons.jsx';

export function Button({ variant = 'default', size = 'md', icon, children, className = '', ...rest }) {
  const classes = ['c-btn'];
  if (variant !== 'default') classes.push(`c-btn--${variant}`);
  if (size === 'sm') classes.push('c-btn--sm');
  return (
    <button type="button" className={`${classes.join(' ')} ${className}`.trim()} {...rest}>
      {icon ? <ConsoleIcon name={icon} size={size === 'sm' ? 14 : 15} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, size = 16, variant, label, className = '', small = false, ...rest }) {
  const classes = ['c-icon-btn'];
  if (variant) classes.push(`c-icon-btn--${variant}`);
  if (small) classes.push('c-icon-btn--sm');
  return (
    <button type="button" className={`${classes.join(' ')} ${className}`.trim()} aria-label={label} title={label} {...rest}>
      <ConsoleIcon name={icon} size={size} />
    </button>
  );
}

export function Pill({ tone = 'default', children, className = '' }) {
  return <span className={`c-pill${tone === 'default' ? '' : ` c-pill--${tone}`} ${className}`.trim()}>{children}</span>;
}

export function Dot({ tone = 'default', pulse = false }) {
  const classes = ['c-dot'];
  if (tone !== 'default') classes.push(`c-dot--${tone}`);
  if (pulse) classes.push('c-pulse');
  return <span className={classes.join(' ')} aria-hidden="true" />;
}

export function Spinner({ className = '' }) {
  return <span className={`c-spinner ${className}`.trim()} role="status" aria-label="加载中" />;
}

export function Empty({ icon = 'sparkle', title, body, children }) {
  return (
    <div className="c-empty">
      <ConsoleIcon name={icon} size={22} />
      {title ? <strong>{title}</strong> : null}
      {body ? <p>{body}</p> : null}
      {children}
    </div>
  );
}

export function Kbd({ children }) {
  return <kbd className="c-kbd">{children}</kbd>;
}

/**
 * 复制到剪贴板，带三态反馈：idle → ok / danger → 1600ms 后回到 idle。
 * 参考用「按钮自己变勾/变叉」而不是弹 toast —— 复制是高频操作，
 * 就地反馈比拼一个全局提示轻得多。
 */
export function useCopy(text, { resetMs = 1600 } = {}) {
  const [state, setState] = useState('idle');
  const timerRef = useRef(null);
  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);
  const copy = useCallback(async () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    let ok = false;
    try {
      await navigator.clipboard.writeText(String(text ?? ''));
      ok = true;
    } catch {
      // 剪贴板不可用（非 HTTPS、无权限）时退到 execCommand
      try {
        const area = document.createElement('textarea');
        area.value = String(text ?? '');
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand('copy');
        document.body.removeChild(area);
      } catch { ok = false; }
    }
    setState(ok ? 'ok' : 'danger');
    timerRef.current = window.setTimeout(() => setState('idle'), resetMs);
    return ok;
  }, [text, resetMs]);
  return [state, copy];
}

export function CopyButton({ text, label = '复制', iconOnly = false, className = '' }) {
  const [state, copy] = useCopy(text);
  const title = state === 'ok' ? '已复制' : state === 'danger' ? '复制失败' : label;
  if (iconOnly) {
    return (
      <IconButton
        icon={state === 'ok' ? 'check' : state === 'danger' ? 'x' : 'copy'}
        size={14}
        label={title}
        className={`${state === 'ok' ? 'c-icon-btn--accent' : ''} ${className}`.trim()}
        onClick={copy}
      />
    );
  }
  return (
    <button type="button" className={`c-msg-action${state === 'ok' ? ' is-ok' : state === 'danger' ? ' is-danger' : ''} ${className}`.trim()} onClick={copy}>
      <ConsoleIcon name={state === 'ok' ? 'check' : state === 'danger' ? 'x' : 'copy'} size={13} />
      {title}
    </button>
  );
}

// ── Toast ───────────────────────────────────────────────────────────────────
const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const idRef = useRef(0);
  const push = useCallback((text, tone = 'info', ms = 4200) => {
    const id = ++idRef.current;
    setItems((current) => [...current.slice(-3), { id, text, tone }]);
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), ms);
  }, []);
  const value = useMemo(() => ({ toast: push, ok: (t) => push(t, 'ok'), error: (t) => push(t, 'danger', 7000) }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="c-toast-host" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`c-toast${item.tone === 'danger' ? ' c-toast--danger' : item.tone === 'ok' ? ' c-toast--ok' : ''}`} role="status">
            <ConsoleIcon name={item.tone === 'danger' ? 'alert' : item.tone === 'ok' ? 'check' : 'info'} size={15} />
            <span>{item.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  // 没有 Provider 时退化成 no-op，组件不会因为漏包 Provider 直接崩
  return value || { toast: () => {}, ok: () => {}, error: () => {} };
}

/**
 * 挂在触发元素旁边的弹出菜单。
 * anchor 是 getBoundingClientRect() 的结果；会自动翻转避免超出视口。
 */
export function PopoverMenu({ anchor, items = [], onClose, label }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!anchor) { setPos(null); return; }
    const width = 190;
    const estimated = Math.min(360, 16 + items.length * 35);
    const margin = 8;
    let left = Math.min(anchor.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    let top = anchor.bottom + 6;
    if (top + estimated > window.innerHeight - margin) top = Math.max(margin, anchor.top - estimated - 6);
    setPos({ left, top });
  }, [anchor, items.length]);

  useEffect(() => {
    if (!anchor) return undefined;
    const close = (event) => { if (!ref.current?.contains(event.target)) onClose?.(); };
    const onKey = (event) => { if (event.key === 'Escape') onClose?.(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [anchor, onClose]);

  if (!anchor || !pos) return null;
  return (
    <div className="c-menu" ref={ref} style={pos} role="menu" aria-label={label}>
      {items.map((item) => (item.type === 'sep'
        ? <div className="c-menu__sep" key={item.key} role="separator" />
        : item.type === 'label'
          ? <div className="c-menu__label" key={item.key}>{item.label}</div>
          : (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={item.danger ? 'is-danger' : undefined}
              disabled={item.disabled}
              onClick={() => { onClose?.(); item.onSelect?.(); }}
            >
              {item.icon ? <ConsoleIcon name={item.icon} size={14} /> : null}
              <span>{item.label}</span>
            </button>
          )))}
    </div>
  );
}

/** 深色控制台里的确认框（替代原生 confirm / prompt） */
export function ConfirmDialog({ open, title, body, confirmLabel = '确定', cancelLabel = '取消', tone = 'default', input = null, onConfirm, onCancel }) {
  const [value, setValue] = useState('');
  useEffect(() => { if (open) setValue(input?.initial || ''); }, [open, input?.initial]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="c-dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel?.(); }}>
      <div className="c-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {body ? <p>{body}</p> : null}
        {input ? (
          <input
            className="c-input"
            value={value}
            placeholder={input.placeholder}
            aria-label={input.label || title}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
        ) : null}
        <div className="c-dialog__actions">
          <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={() => onConfirm?.(input ? value : true)}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
