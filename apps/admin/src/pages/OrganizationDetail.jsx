// P03-02 机构详情（图3）+ 图4 禁用机构抽屉（2026-09-18 按线框图对齐）。
//
// 数据来源：GET /api/admin/organizations/:id/detail（buildOrganizationDetail）——
//   summary.teachers / summary.students / summary.activeSessions 是服务端给的，
//   「已开通课包数」用 detail.courseAssignments 的长度（服务端一次就返回了，不额外请求）。
//   「当前活跃课堂数」用 summary.activeSessions（class_sessions 里 status='ACTIVE' 的数量）；
//   detail.summary.activeClasses 在服务端是**写死的 0**，所以不拿它当活跃课堂数（已在报告里说明）。
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Empty, ErrorState, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, useData } from '@platform/shared';
import { isoDateInput } from '../shared.jsx';
import { useAdminConfirm } from '../components/AdminConfirm.jsx';
import { OrganizationCard, OrganizationEntryCards, OrganizationStatusBadge } from '../components/OrganizationShared.jsx';

/**
 * 「机构管理员」三个弹窗（新增 / 编辑 / 停用启用）共用的外壳（2026-09-18 用户口径：
 * 新增与编辑都改成「按钮 → 弹窗」，面板里不再常驻输入框、行内也不再有密码输入框）。
 *
 * 复用仓库既有的 `.admin-confirm` 弹窗样式（`AdminConfirm.jsx` 的二次确认、图2「添加机构」弹窗
 * 都是这一套，来自 admin.css），只把「标题 / 就地错误 / 提交中禁用 / 取消+确认」写一次。
 * 一律 `<dialog showModal()>`：原生聚焦陷阱 + Esc 关闭，不用原生 confirm 对话框（p83 明确断言不许用）。
 */
function AdminDialogShell({ title, description = '', error = '', saving = false, submitLabel, submitDisabled = false, onClose = () => {}, onSubmit = () => {}, children }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.showModal();
    return () => { dialogRef.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  return <dialog ref={dialogRef} className="admin-confirm" style={{ width: 'min(720px, calc(100vw - 32px))' }} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={onSubmit} noValidate>
      <h2 id={titleId}>{title}</h2>
      {description ? <p className="muted">{description}</p> : null}
      {children}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="row-actions">
        <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
        <button className="primary-button" disabled={saving || submitDisabled}>{saving ? '提交中…' : submitLabel}</button>
      </div>
    </form>
  </dialog>;
}

/** 字段下方的固定提示位：有错误就显示红字（就地提示），否则显示灰色说明 —— 两者不会叠成两行。 */
function fieldNote(errors, key, hint) {
  if (errors[key]) return <small className="org-field-error">{errors[key]}</small>;
  return hint ? <small className="muted">{hint}</small> : null;
}

/** 新增管理员弹窗：字段顺序 姓名 → 登录名 → 初始密码（用户口径：姓名排最前面）。 */
function CreateAdminDialog({ onClose = () => {}, onSubmit = () => {} }) {
  const [form, setForm] = useState({ displayName: '', login: '', password: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function validate() {
    const next = {};
    if (!form.displayName.trim()) next.displayName = '请填写姓名';
    if (!form.login.trim()) next.login = '请填写登录名';
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(form.login.trim())) next.login = '登录名只能用英文和数字（可带 . _ -）';
    if (form.password.length < 6) next.password = '初始密码至少 6 位';
    return next;
  }

  async function submit(event) {
    event.preventDefault();
    const next = validate(); setErrors(next); setError('');
    if (Object.keys(next).length) return;
    setSaving(true);
    try { await onSubmit({ displayName: form.displayName.trim(), login: form.login.trim(), password: form.password }); }
    catch (failure) { setError(failure.message); } finally { setSaving(false); }
  }

  const distinct = '全平台不能重复';
  return <AdminDialogShell title="新增管理员" description="新账号用「登录名 + 初始密码」登录机构端，可以管理机构下的教师、学生与课包授权。" error={error} saving={saving} submitLabel="创建管理员" onClose={onClose} onSubmit={submit}>
    <div className="form-grid grid-3">
      <label>姓名 *<input autoFocus value={form.displayName} maxLength={200} placeholder="如：李校长" onChange={(event) => setForm({ ...form, displayName: event.target.value })} />{fieldNote(errors, 'displayName', '机构内显示，可用作重名区分')}</label>
      <label>登录名 *<input value={form.login} maxLength={50} placeholder="如：lixiaozhang" onChange={(event) => setForm({ ...form, login: event.target.value })} />{fieldNote(errors, 'login', `英文和数字（可带 . _ -）；${distinct}`)}</label>
      <label>初始密码 *<input type="password" autoComplete="new-password" minLength={6} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />{fieldNote(errors, 'password', '至少 6 位，交给机构管理员本人后请尽快修改')}</label>
    </div>
  </AdminDialogShell>;
}

/** 编辑管理员弹窗：可改姓名；重置密码留空 = 不改（服务端 PUT 支持 displayName 与 password 两个字段）。 */
function EditAdminDialog({ admin = {}, onClose = () => {}, onSubmit = () => {} }) {
  const [displayName, setDisplayName] = useState(admin.displayName || '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function validate() {
    const next = {};
    if (!displayName.trim()) next.displayName = '请填写姓名';
    if (password && password.length < 6) next.password = '新密码至少 6 位（不想改就留空）';
    return next;
  }

  async function submit(event) {
    event.preventDefault();
    const next = validate(); setErrors(next); setError('');
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      // 只提交真正要改的字段：password 留空就**不带这个键**，服务端保持原密码（PUT 是增量语义）。
      const payload = { displayName: displayName.trim() };
      if (password) payload.password = password;
      await onSubmit(payload);
    } catch (failure) { setError(failure.message); } finally { setSaving(false); }
  }

  return <AdminDialogShell title="编辑管理员" description={`${admin.login || ''} · 姓名可以改；重置密码留空则保持原密码不变。`} error={error} saving={saving} submitLabel="保存修改" onClose={onClose} onSubmit={submit}>
    <div className="form-grid">
      <label>姓名 *<input autoFocus value={displayName} maxLength={200} onChange={(event) => setDisplayName(event.target.value)} />{fieldNote(errors, 'displayName', '机构内显示，可用作重名区分')}</label>
      <label>重置密码<input type="password" autoComplete="new-password" minLength={6} value={password} placeholder="留空 = 不修改" onChange={(event) => setPassword(event.target.value)} />{fieldNote(errors, 'password', '至少 6 位；填了就覆盖原密码，该账号现有会话会失效')}</label>
    </div>
  </AdminDialogShell>;
}

/** 停用 / 启用管理员的确认弹窗（影响说明写清，不用原生 confirm 对话框）。 */
function AdminStatusDialog({ admin = {}, nextStatus = 'DISABLED', onClose = () => {}, onSubmit = () => {} }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const disabling = nextStatus === 'DISABLED';

  async function submit(event) {
    event.preventDefault();
    setSaving(true); setError('');
    try { await onSubmit(); } catch (failure) { setError(failure.message); } finally { setSaving(false); }
  }

  return <AdminDialogShell title={disabling ? '停用管理员' : '启用管理员'} error={error} saving={saving}
    submitLabel={disabling ? '确认停用' : '确认启用'} onClose={onClose} onSubmit={submit}>
    <Notice tone={disabling ? 'warning' : 'info'}>{disabling
      ? '停用后该账号立即无法登录机构端，现有登录会话也会立即失效（历史数据与审计不受影响）；同一机构至少要保留一名有效管理员，最后一名会被服务端拒绝。'
      : '启用后该账号可以重新登录机构端，恢复原有的机构管理权限。'}</Notice>
    <div className="table-wrap"><table><tbody>
      <tr><th>姓名</th><td>{admin.displayName || '—'}</td></tr>
      <tr><th>登录名</th><td>{admin.login || '—'}</td></tr>
      <tr><th>当前状态</th><td><span className={'status ' + (admin.status === 'ACTIVE' ? 'success' : 'muted')}>{admin.status === 'ACTIVE' ? '启用' : '停用'}</span></td></tr>
      <tr><th>操作后状态</th><td><span className={'status ' + (disabling ? 'danger' : 'success')}>{disabling ? '停用' : '启用'}</span></td></tr>
    </tbody></table></div>
  </AdminDialogShell>;
}

/**
 * 图4「禁用机构」确认抽屉。
 * 口径：禁用原因**必填、上限 500 字**（服务端 POST /organizations/:id/status 的 disable 分支校验，其余动作可选）。
 */
function DisableOrganizationDrawer({ organization = {}, stats = {}, onClose = () => {}, onConfirm = () => {}, saving = false, error = '' }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const reasonError = !reason.trim() ? '请填写禁用原因' : reason.length > 500 ? '禁用原因不能超过 500 字' : '';
  return <div className="drawer-overlay" onClick={saving ? undefined : onClose}>
    <div className="drawer-panel" onClick={(event) => event.stopPropagation()}>
      <header className="drawer-head">
        <div><span className="eyebrow">P03-02 · 机构详情</span><h2>禁用机构</h2><span className="muted">{organization.name || '—'}</span></div>
        <button type="button" className="drawer-close" onClick={onClose} disabled={saving} aria-label="关闭">×</button>
      </header>
      <div className="drawer-body">
        <Notice tone="warning">禁用该机构后，该机构的机构账号以及该机构下的所有教师、学生将无法正常使用平台的各项业务功能，但不影响历史数据的查看。</Notice>
        <section className="drawer-section">
          <h3>机构信息（只读）</h3>
          <div className="table-wrap"><table><tbody>
            <tr><th>机构名称</th><td>{organization.name || '—'}</td></tr>
            <tr><th>当前状态</th><td><OrganizationStatusBadge status={organization.status} /></td></tr>
            <tr><th>教师数</th><td>{stats.teachers ?? '—'}</td></tr>
            <tr><th>学生数</th><td>{stats.students ?? '—'}</td></tr>
            <tr><th>已开通课包数</th><td>{stats.packages ?? '—'}</td></tr>
          </tbody></table></div>
        </section>
        <section className="drawer-section">
          <h3>禁用原因（必填）</h3>
          <label>禁用原因（不超过 500 字）
            <textarea rows={4} maxLength={500} value={reason} placeholder="如：合同到期未续签；机构申请暂停服务" onChange={(event) => { setReason(event.target.value); setTouched(true); }} />
            <small className="muted">{reason.length}/500</small>
          </label>
          {touched && reasonError ? <small className="org-field-error">{reasonError}</small> : null}
        </section>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <footer className="drawer-foot">
        <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
        <button type="button" className="primary-button" disabled={saving} onClick={() => { setTouched(true); if (reasonError) return; onConfirm(reason.trim()); }}>{saving ? '禁用中…' : '确认禁用'}</button>
      </footer>
    </div>
  </div>;
}

export function OrganizationDetail({ api }) {
  const { orgId = '' } = useParams();
  const navigate = useNavigate();
  const detail = useData(() => (orgId ? api.get(`admin/organizations/${encodeURIComponent(orgId)}/detail`) : Promise.resolve(null)), [api, orgId]);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showDisableDrawer, setShowDisableDrawer] = useState(false);
  const [disableError, setDisableError] = useState('');
  const [confirm, confirmation] = useAdminConfirm();
  const [editForm, setEditForm] = useState(null);
  // 机构管理员的三个弹窗：null | {mode:'create'} | {mode:'edit',admin} | {mode:'status',admin,nextStatus}
  const [adminDialog, setAdminDialog] = useState(null);
  const organization = detail.data?.organization || null;
  const summary = detail.data?.summary || {};
  const assignments = detail.data?.courseAssignments || [];
  const openedPackages = assignments.length;
  const activePackages = assignments.filter((item) => item.status === 'ACTIVE').length;
  const stats = { teachers: summary.teachers, students: summary.students, packages: openedPackages };

  useEffect(() => {
    if (!organization) return;
    const contact = organization.contact || {};
    setEditForm({
      name: organization.name || '',
      shortName: organization.shortName || '',
      region: organization.region || '',
      contractStartAt: isoDateInput(organization.contractStartAt),
      contractExpiresAt: isoDateInput(organization.contractExpiresAt),
      teacherSeats: organization.teacherSeats,
      studentSeats: organization.studentSeats,
      contactName: contact.name || '',
      contactPhone: contact.phone || '',
      contactEmail: contact.email || '',
      contractNotes: contact.contractNotes || '',
    });
  }, [organization?.id, organization?.updatedAt]);

  async function saveEdit(event) {
    event.preventDefault();
    if (!orgId || !editForm) return;
    setBusy(true); setMessage(null);
    try {
      await api.put(`admin/organizations/${encodeURIComponent(orgId)}`, {
        name: editForm.name,
        // 简称 / 所属区域：2026-09-18 新增字段（服务端正在补），老服务端忽略未知键，不会报错。
        shortName: editForm.shortName || undefined,
        region: editForm.region || undefined,
        contractStartAt: new Date(editForm.contractStartAt).toISOString(),
        contractExpiresAt: new Date(editForm.contractExpiresAt + 'T23:59:59.999Z').toISOString(),
        teacherSeats: Number(editForm.teacherSeats),
        studentSeats: Number(editForm.studentSeats),
        contact: { name: editForm.contactName, phone: editForm.contactPhone, email: editForm.contactEmail, contractNotes: editForm.contractNotes },
      });
      setMessage({ tone: 'success', text: '机构资料已保存。' });
      detail.refresh();
    } catch (error) { setMessage({ tone: 'danger', text: error.message }); } finally { setBusy(false); }
  }

  /** 禁用机构：走图4 抽屉（原因必填）。 */
  async function disableOrganization(reason) {
    setBusy(true); setDisableError('');
    try {
      await api.post(`admin/organizations/${encodeURIComponent(orgId)}/status`, { action: 'disable', reason });
      setShowDisableDrawer(false);
      setMessage({ tone: 'success', text: '机构已禁用，该机构的机构账号与教师、学生将无法使用平台业务功能。' });
      detail.refresh();
    } catch (error) { setDisableError(error.message); } finally { setBusy(false); }
  }

  async function changeStatus(action) {
    const text = action === 'recover'
      ? `确认恢复「${organization.name}」的服务？恢复要求合同未到期，成功后机构用户可重新登录。`
      : `确认把「${organization.name}」从试用转为正式？`;
    const approved = await confirm({ title: action === 'recover' ? '恢复服务' : '确认机构状态变更', message: text, confirmLabel: '确认执行' });
    if (!approved) return;
    setBusy(true); setMessage(null);
    try {
      await api.post(`admin/organizations/${encodeURIComponent(orgId)}/status`, { action });
      setMessage({ tone: 'success', text: '机构状态已更新。' });
      detail.refresh();
    } catch (error) { setMessage({ tone: 'danger', text: error.message }); } finally { setBusy(false); }
  }

  /**
   * 新增机构管理员（弹窗提交）。**故意不在这里 catch**：错误要让弹窗就地显示（red 字），
   * 而不是飘到页面顶上；成功才关窗、刷新、给页面提示。
   */
  async function createAdmin(payload) {
    await api.post(`admin/organizations/${encodeURIComponent(orgId)}/admins`, payload);
    setAdminDialog(null);
    setMessage({ tone: 'success', text: `管理员「${payload.displayName}」已创建。` });
    detail.refresh();
  }

  /** 编辑（改姓名 / 重置密码）与停用启用共用同一条 PUT；失败同样抛回弹窗就地显示。 */
  async function updateAdmin(admin, payload) {
    await api.put(`admin/organizations/${encodeURIComponent(orgId)}/admins/${admin.id}`, payload);
    setAdminDialog(null);
    setMessage({
      tone: 'success',
      text: payload.status === 'DISABLED' ? `管理员「${admin.displayName}」已停用，该账号现有会话已失效。`
        : payload.status === 'ACTIVE' ? `管理员「${admin.displayName}」已启用。`
          : `管理员「${admin.displayName}」的资料已更新。`,
    });
    detail.refresh();
  }

  if (!orgId) return <Panel title="机构详情"><Empty title="缺少机构标识" body="请从机构列表点「查看详情」进入本页。" /></Panel>;

  return <>
    <PageHeader eyebrow="平台教务 · 机构与课包人次" title={organization?.name || '机构详情'} description="机构卡、四个业务入口与数据概览；禁用机构需要填写原因。" actions={<button className="secondary-button" onClick={() => navigate('/organizations')}>← 返回机构列表</button>} />
    {confirmation}
    {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    {detail.loading ? <Loading label="正在读取机构详情…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : !detail.data ? <Panel title="机构详情"><Empty title="没有找到该机构" body="机构可能已被删除，或链接里的机构标识不正确。" /></Panel> : <>
      <OrganizationCard organization={organization} meta={<p className="muted">合同到期：{formatDate(organization.contractExpiresAt)}（剩余 {organization.daysUntilContractExpires ?? '—'} 天）</p>} actions={<>
        {organization.status === 'DISABLED'
          ? <button type="button" className="secondary-button" disabled={busy} onClick={() => changeStatus('recover')}>恢复服务</button>
          : <button type="button" className="secondary-button danger-text" disabled={busy} onClick={() => { setDisableError(''); setShowDisableDrawer(true); }}>禁用机构</button>}
        {organization.status === 'TRIAL' ? <button type="button" className="secondary-button" disabled={busy} onClick={() => changeStatus('activate')}>试用转正</button> : null}
      </>} />

      {organization.contractExpiringSoon ? <Notice tone="warning">该机构合同将在 {organization.daysUntilContractExpires} 天内到期，请尽快联系续约。</Notice> : null}

      <OrganizationEntryCards orgId={orgId} />

      <div className="metrics">
        <MetricCard label="教师数" value={summary.teachers ?? 0} hint={`上限 ${organization.teacherSeats} 人（基础 ${organization.baseTeacherSeats} + 购买 ${organization.purchasedTeacherSeats}）`} tone={organization.teacherSeats - (summary.teachers || 0) < 3 ? 'orange' : 'violet'} />
        <MetricCard label="学生数" value={summary.students ?? 0} hint={`上限 ${organization.studentSeats} 人，停用账号仍占容量`} tone="teal" />
        <MetricCard label="已开通课包数" value={openedPackages} hint={`其中有效 ${activePackages} 个（去「授权次数」入口看明细）`} tone="pink" />
        <MetricCard label="当前活跃课堂数" value={summary.activeSessions ?? 0} hint="进行中的课堂（按课堂状态统计）" tone={summary.activeSessions ? 'orange' : undefined} />
      </div>
      <p className="muted">另有：项目 {summary.projects ?? 0} 个 · 作品 {summary.works ?? 0} 个。</p>

      <div className="split">
        <Panel title="编辑机构资料">{editForm ? <form onSubmit={saveEdit}>
          <div className="form-grid">
            <label>机构名称<input value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} required /></label>
            <label>机构简称<input value={editForm.shortName} onChange={(event) => setEditForm({ ...editForm, shortName: event.target.value })} maxLength={50} /></label>
            <label>所属区域<input value={editForm.region} onChange={(event) => setEditForm({ ...editForm, region: event.target.value })} maxLength={100} placeholder="如：北京市·海淀区" /></label>
            <label>合同开始日期<input type="date" value={editForm.contractStartAt} onChange={(event) => setEditForm({ ...editForm, contractStartAt: event.target.value })} required /></label>
            <label>合同到期日期<input type="date" value={editForm.contractExpiresAt} onChange={(event) => setEditForm({ ...editForm, contractExpiresAt: event.target.value })} required /></label>
            <label>学生数量上限<input type="number" min="0" value={editForm.studentSeats} onChange={(event) => setEditForm({ ...editForm, studentSeats: event.target.value })} required /></label>
            <label>教师数量上限<input type="number" min={summary.teachers || 0} max="1000000" value={editForm.teacherSeats} onChange={(event) => setEditForm({ ...editForm, teacherSeats: event.target.value })} required /></label>
            <label>联系人<input value={editForm.contactName} onChange={(event) => setEditForm({ ...editForm, contactName: event.target.value })} /></label>
            <label>联系电话<input value={editForm.contactPhone} onChange={(event) => setEditForm({ ...editForm, contactPhone: event.target.value })} /><small className="muted">机构卡上显示的是脱敏号码，这里编辑的是明文。</small></label>
            <label>联系邮箱<input value={editForm.contactEmail} onChange={(event) => setEditForm({ ...editForm, contactEmail: event.target.value })} /></label>
          </div>
          <label>签约备注<textarea rows={3} maxLength={5000} value={editForm.contractNotes} onChange={(event) => setEditForm({ ...editForm, contractNotes: event.target.value })} placeholder="填写签约服务、约定事项或合同备注" /></label>
          <button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存机构资料'}</button>
          <p className="muted">机构状态请用右上角的「禁用机构 / 恢复服务」，状态变更都会写入审计。</p>
        </form> : null}</Panel>
        <Panel title="机构管理员" actions={(detail.data.admins || []).length ? <button type="button" className="primary-button" onClick={() => setAdminDialog({ mode: 'create' })}>新增管理员</button> : null}>
          {/* 2026-09-18 用户口径：这里**不再常驻输入框**（新增走右上角按钮 → 弹窗），
              表格行里也不再有密码框（编辑 / 重置密码走「编辑」弹窗）。 */}
          {(detail.data.admins || []).length ? <div className="table-wrap"><table><thead><tr><th>姓名</th><th>登录名</th><th>状态</th><th>操作</th></tr></thead><tbody>
            {(detail.data.admins || []).map((admin) => <tr key={admin.id}>
              <td><strong>{admin.displayName}</strong></td>
              <td>{admin.login}</td>
              <td><span className={'status ' + (admin.status === 'ACTIVE' ? 'success' : 'muted')}>{admin.status === 'ACTIVE' ? '启用' : '停用'}</span></td>
              <td><div className="row-actions">
                <button type="button" className="secondary-button" onClick={() => setAdminDialog({ mode: 'edit', admin })}>编辑</button>
                {admin.status === 'ACTIVE'
                  ? <button type="button" className="secondary-button danger-text" onClick={() => setAdminDialog({ mode: 'status', admin, nextStatus: 'DISABLED' })}>停用</button>
                  : <button type="button" className="secondary-button" onClick={() => setAdminDialog({ mode: 'status', admin, nextStatus: 'ACTIVE' })}>启用</button>}
              </div></td>
            </tr>)}
          </tbody></table></div> : <Empty title="暂无机构管理员" body="点右上角「新增管理员」，用弹窗为该机构创建一个机构管理员账号。" />}
        </Panel>
      </div>

      <Panel title="最近审计记录">
        {(detail.data.audits || []).length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>动作</th><th>操作者</th><th>目标</th><th>变更摘要</th></tr></thead><tbody>{(detail.data.audits || []).map((item) => <tr key={item.id}>
          <td>{formatDate(item.createdAt)}</td><td><code>{item.action}</code></td><td>{item.actorRole || '—'}</td><td>{item.targetType}{item.targetId ? ` · ${item.targetId}` : ''}</td>
          <td>{JSON.stringify(item.afterData || {})}</td>
        </tr>)}</tbody></table></div> : <Empty title="暂无审计记录" />}
      </Panel>
      <p className="muted">课包与授权次数（总授权次数 / 已授权次数 / 剩余授权次数）在 <Link to={`/organizations/${encodeURIComponent(orgId)}/quota`}>本机构的课包与授权次数</Link>页配置；授权次数的变更流水在 <Link to={`/organizations/${encodeURIComponent(orgId)}/quota-changes`}>授权次数变更记录</Link>页。</p>
    </>}
    {showDisableDrawer ? <DisableOrganizationDrawer organization={organization || {}} stats={stats} saving={busy} error={disableError} onClose={() => { if (!busy) setShowDisableDrawer(false); }} onConfirm={disableOrganization} /> : null}
    {/* 机构管理员：三个弹窗按需渲染（没点按钮时 DOM 里连表单都没有 —— p83 的「首屏不渲染表单」同款口径）。 */}
    {adminDialog?.mode === 'create' ? <CreateAdminDialog onClose={() => setAdminDialog(null)} onSubmit={createAdmin} /> : null}
    {adminDialog?.mode === 'edit' ? <EditAdminDialog admin={adminDialog.admin} onClose={() => setAdminDialog(null)} onSubmit={(payload) => updateAdmin(adminDialog.admin, payload)} /> : null}
    {adminDialog?.mode === 'status' ? <AdminStatusDialog admin={adminDialog.admin} nextStatus={adminDialog.nextStatus} onClose={() => setAdminDialog(null)} onSubmit={() => updateAdmin(adminDialog.admin, { status: adminDialog.nextStatus })} /> : null}
  </>;
}
