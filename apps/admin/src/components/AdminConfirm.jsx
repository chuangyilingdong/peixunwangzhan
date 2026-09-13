import { useEffect, useId, useRef, useState } from 'react';

export function ConfirmModal({ request = {}, onResolve = () => {} }) {
  const ref = useRef(null);
  const titleId = useId();
  const bodyId = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = request.password ? value : true;
      await request.execute?.(result);
      onResolve(result);
    } catch (failure) { setError(failure.message || '操作失败，请重试。'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => { ref.current?.close(); previous?.focus?.(); };
  }, []);
  return <dialog ref={ref} className="admin-confirm" aria-labelledby={titleId} aria-describedby={bodyId} onCancel={(event) => { event.preventDefault(); if (!busy) onResolve(false); }}>
    <form onSubmit={submit}>
      <h2 id={titleId}>{request.title || '确认操作'}</h2>
      <p id={bodyId}>{request.message}</p>
      {request.password && <label>新密码（至少 6 位）<input type="password" autoComplete="new-password" minLength={6} required value={value} onChange={(event) => setValue(event.target.value)} /></label>}
      {error && <div role="alert" className="notice danger">{error}</div>}
      <div className="row-actions"><button disabled={busy} type="button" autoFocus className="secondary-button" onClick={() => onResolve(false)}>取消</button><button className="primary-button" disabled={busy || (request.password && value.length < 6)}>{busy ? '处理中…' : request.confirmLabel || '确认执行'}</button></div>
    </form>
  </dialog>;
}

export function useAdminConfirm() {
  const [request, setRequest] = useState(null);
  const resolver = useRef(null);
  useEffect(() => () => resolver.current?.(false), []);
  function confirm(options) {
    resolver.current?.(false);
    return new Promise((resolve) => { resolver.current = resolve; setRequest(typeof options === 'string' ? { message: options } : options); });
  }
  function resolve(value) { resolver.current?.(value); resolver.current = null; setRequest(null); }
  return [confirm, request ? <ConfirmModal request={request} onResolve={resolve} /> : null];
}
