import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatCredits, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function Security({ api, onSignedOut }) {
  const status = useData(() => api.get('admin/me/mfa'), [api]);
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [passwordMessage, setPasswordMessage] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  async function run(action, successMessage) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await action();
      if (successMessage) setNotice(successMessage);
      return result;
    } catch (err) {
      setError(err.message || '操作失败，请稍后重试');
      return null;
    } finally { setBusy(false); }
  }
  async function beginSetup() {
    const data = await run(() => api.post('admin/me/mfa/setup', {}));
    if (data) { setSetup(data); setRecoveryCodes([]); setCode(''); status.refresh(); }
  }
  async function confirmEnable(event) {
    event.preventDefault();
    const data = await run(() => api.post('admin/me/mfa/enable', { code }));
    if (data) { setSetup(null); setCode(''); setRecoveryCodes(data.recoveryCodes || []); setNotice('二次验证已开启，请立即保存下面的恢复码。'); status.refresh(); }
  }
  async function regenerate(event) {
    event.preventDefault();
    const data = await run(() => api.post('admin/me/mfa/recovery-codes', { password, code }));
    if (data) { setRecoveryCodes(data.recoveryCodes || []); setCode(''); setPassword(''); setNotice('恢复码已重新生成，旧的恢复码全部作废。'); status.refresh(); }
  }
  async function disable(event) {
    event.preventDefault();
    const data = await run(() => api.post('admin/me/mfa/disable', { password, code }));
    if (data) { setRecoveryCodes([]); setCode(''); setPassword(''); setNotice('二次验证已关闭。'); status.refresh(); }
  }
  async function changePassword(event) {
    event.preventDefault();
    if (passwordForm.newPassword.length < 6) { setPasswordMessage('新密码至少 6 位'); return; }
    if (passwordForm.newPassword !== passwordForm.confirm) { setPasswordMessage('两次输入的新密码不一致'); return; }
    setPasswordBusy(true); setPasswordMessage('');
    try {
      await api.put('admin/me/password', { currentPassword: passwordForm.currentPassword, newPassword: passwordForm.newPassword });
      window.alert('密码已修改，请用新密码重新登录。');
      onSignedOut();
    } catch (err) { setPasswordMessage(err.message || '修改失败'); } finally { setPasswordBusy(false); }
  }

  const enabled = !!status.data?.enabled;
  return <>
    <PageHeader eyebrow="我的账号" title="账号安全" description="维护登录密码，并为平台管理员账号开启二次验证（TOTP 动态码 + 一次性恢复码）。" />
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    <Panel title="登录密码">
      {passwordMessage ? <Notice tone="danger">{passwordMessage}</Notice> : null}
      <form onSubmit={changePassword}>
        <div className="form-grid">
          <label>当前密码<input type="password" value={passwordForm.currentPassword} required onChange={(event) => setPasswordForm({ ...passwordForm, currentPassword: event.target.value })} /></label>
          <label>新密码（至少 6 位）<input type="password" value={passwordForm.newPassword} minLength={6} required onChange={(event) => setPasswordForm({ ...passwordForm, newPassword: event.target.value })} /></label>
          <label>确认新密码<input type="password" value={passwordForm.confirm} minLength={6} required onChange={(event) => setPasswordForm({ ...passwordForm, confirm: event.target.value })} /></label>
        </div>
        <p className="muted">改密后所有登录会话（含当前会话）都会失效，需要用新密码重新登录。</p>
        <button className="primary-button" disabled={passwordBusy}>{passwordBusy ? '提交中…' : '确认修改'}</button>
      </form>
    </Panel>
    <Panel title="二次验证（TOTP）" actions={<button className="secondary-button" onClick={status.refresh}>刷新</button>}>
      {status.loading ? <Loading /> : status.error ? <ErrorState error={status.error} onRetry={status.refresh} /> : <>
        <p>当前状态：<strong>{enabled ? '已开启' : (status.data?.setupPending ? '已生成密钥，等待验证' : '未开启')}</strong>
          {enabled ? ` · 恢复码剩余 ${status.data.recoveryCodesRemaining} 枚 · 绑定于 ${formatDate(status.data.enabledAt) || '—'}` : ''}
        </p>
        {!enabled && !setup && <button className="primary-button" disabled={busy} onClick={beginSetup}>{busy ? '生成中…' : '生成绑定密钥'}</button>}
        {!enabled && setup && <form onSubmit={confirmEnable}>
          <Notice>① 打开验证器 App（Google Authenticator / Microsoft Authenticator / 1Password 等），选择「手动输入密钥」。<br />② 输入下面的密钥，账户名填你的登录名，类型选「基于时间」。<br />③ 把验证器当前显示的 6 位动态码填到下面确认。</Notice>
          <label>密钥（手动录入）<input readOnly value={setup.secret} onFocus={(event) => event.target.select()} className="mono-input" /></label>
          <label>otpauth 链接（可导入）<input readOnly value={setup.otpauthUri} onFocus={(event) => event.target.select()} /></label>
          <label>验证器当前显示的 6 位动态码<input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" required /></label>
          <div className="row-actions top-gap"><button className="primary-button" disabled={busy}>{busy ? '校验中…' : '确认开启'}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => { setSetup(null); setCode(''); }}>取消</button></div>
        </form>}
        {enabled && <form onSubmit={regenerate}>
          <div className="form-grid">
            <label>当前密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            <label>动态验证码 / 恢复码<input value={code} onChange={(event) => setCode(event.target.value)} placeholder="6 位动态码，或 XXXX-XXXXX 恢复码" required /></label>
          </div>
          <div className="row-actions top-gap"><button className="secondary-button" disabled={busy}>{busy ? '处理中…' : '重新生成恢复码'}</button><button type="button" className="text-button danger-text" disabled={busy} onClick={disable}>关闭二次验证</button></div>
        </form>}
        {recoveryCodes.length > 0 && <div className="top-gap">
          <Notice tone="warning">恢复码只显示这一次：每枚只能使用一次，请离线保存（打印或存进密码管理器）。</Notice>
          <div className="recovery-codes">{recoveryCodes.map((item) => <code key={item}>{item}</code>)}</div>
          <button className="secondary-button" onClick={() => { navigator.clipboard?.writeText(recoveryCodes.join('\n')); setNotice('恢复码已复制到剪贴板。'); }}>复制全部</button>
        </div>}
      </>}
    </Panel>
    <Panel title="安全说明">
      <Notice>二次验证对平台管理员账号自愿开启：开启后登录必须再输入一次动态码或恢复码。密钥只保存在平台数据库，不发送到任何外部服务；验证器与服务器时间相差超过 30 秒会校验失败，请保持手机时间自动同步。</Notice>
    </Panel>
  </>;
}

