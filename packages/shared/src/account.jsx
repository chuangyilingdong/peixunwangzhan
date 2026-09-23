import { useState } from 'react';
import { errorText } from './notice.js';
import { Notice } from './ui.jsx';

/**
 * 自助修改密码（三端共用：平台端 / 机构端（含老师）/ 学生端）。
 *
 * 2026-09-23 用户口径：「机构端/老师端/学生端创建了账号后，他们应该是有自行修改密码的按钮和操作」。
 * 做这一版之前的状态：
 *   · 平台端 —— 早就有（/security 那页，接口 `PUT admin/me/password`，守卫 p19 钉着）；
 *   · 学生端 —— 接口也有（`PUT student/account/password`，守卫 p37 钉着），但**界面上没有入口**，
 *     学生自己改不了，只能让老师/机构管理员替他改；
 *   · 机构端（机构管理员与老师）—— **连自助接口都没有**：orgAdmin.js 里只有
 *     「管理员改本机构成员密码」那条（`PUT org/members/:id/password`，改的是**别人**）。
 * 于是「创建账号时发的那个临时口令」三端都改不掉，除非让管理员再改一次 —— 这次补齐。
 *
 * 三条口径（三端共用这一份实现，别在各自的页面里再写一遍）：
 *   ① 必须验证**当前密码**：只凭一个已登录的会话就能改密 = 捡到一次登录就能把别人的账号锁死；
 *   ② 改密成功后服务端会**撤销该账号的所有会话（含当前这一个）** —— 所以这里成功之后
 *      **只提示、不假装还在登录**：让用户点一下回登录页，别留一个"看着还在、其实已经掉线"的界面
 *      （那正是口径「界面看得到、点开说无权」的翻版）；
 *   ③ 新密码 ≥6 位、且不能与当前密码相同。服务端也判（错误码 CURRENT_PASSWORD_INVALID /
 *      PASSWORD_UNCHANGED / PASSWORD_TOO_SHORT），这里先拦一次只是为了省一个来回。
 */
export function PasswordChangeForm({ api, endpoint, onSignedOut, note, submitLabel = '确认修改' }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (form.newPassword.length < 6) { setError(errorText('新密码至少 6 位')); return; }
    if (form.newPassword === form.currentPassword) { setError(errorText('新密码不能与当前密码相同')); return; }
    if (form.newPassword !== form.confirm) { setError(errorText('两次输入的新密码不一致')); return; }
    setBusy(true); setError('');
    try {
      const result = await api.put(endpoint, { currentPassword: form.currentPassword, newPassword: form.newPassword });
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      setDone(result || {});
    } catch (err) { setError(errorText(err.message || '修改失败')); } finally { setBusy(false); }
  }

  if (done) {
    const revoked = Number(done.sessionsRevoked || 0);
    return <>
      <Notice tone="success">密码已修改{revoked > 0 ? `，已退出 ${revoked} 处登录（含当前这一处）` : ''}。请用新密码重新登录。</Notice>
      <div className="row-actions top-gap">
        <button type="button" className="primary-button" onClick={() => onSignedOut?.(done)}>去重新登录</button>
      </div>
    </>;
  }

  return <form onSubmit={submit}>
    {error ? <Notice tone="danger">{error}</Notice> : null}
    <div className="form-grid">
      <label>当前密码<input type="password" value={form.currentPassword} required autoComplete="current-password" onChange={(event) => setForm({ ...form, currentPassword: event.target.value })} /></label>
      <label>新密码（至少 6 位）<input type="password" value={form.newPassword} minLength={6} required autoComplete="new-password" onChange={(event) => setForm({ ...form, newPassword: event.target.value })} /></label>
      <label>确认新密码<input type="password" value={form.confirm} minLength={6} required autoComplete="new-password" onChange={(event) => setForm({ ...form, confirm: event.target.value })} /></label>
    </div>
    <p className="muted">{note || '改密后所有登录会话（含当前这一处）都会失效，需要用新密码重新登录。'}</p>
    <button className="primary-button" disabled={busy}>{busy ? '提交中…' : submitLabel}</button>
  </form>;
}
