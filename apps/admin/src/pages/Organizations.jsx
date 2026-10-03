// P03-01 机构列表（图1）+ 图2 添加机构弹窗（2026-09-18 按线框图对齐）。
//
// 口径（用户 2026-09-18 定死）：平台侧**没有**「算力额度」，只有**授权次数** ——
//   总授权次数 / 已授权次数 / 剩余授权次数（= 前两者之差）。界面上不出现「算力额度」「总人次」「已分配人次」。
// 本页两个动作：① 选机构看详情（→ P03-02）② 进详情后在 P03-03 配置课包与授权次数。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Empty, ErrorState, formatDate, Loading, ListResultSummary, MetricCard, Notice, PageHeader, Pagination, Panel, SearchSelect, Status, useData } from '@platform/shared';
import { downloadCsv } from '../shared.jsx';
import { useAdminConfirm } from '../components/AdminConfirm.jsx';
import { OrganizationStatusBadge } from '../components/OrganizationShared.jsx';

// 状态筛选只有这三个是服务端 organizationFilters 认得的值（其余枚举 FROZEN/EXPIRED 不参与筛选）。
const ORGANIZATION_STATUS_FILTERS = [['', '全部状态'], ['ACTIVE', '启用'], ['TRIAL', '试用中'], ['DISABLED', '禁用']];

/**
 * 「已开通课包数」这一列：`GET /api/admin/organizations` **目前不返回**这个数
 * （lib.js 的 normalizeOrg 只算了教师数/学生数，没有课包数）。
 * 前端**不在这里逐行补请求**（一页 20 条机构就是 20 次请求）；只有服务端把课包数带上列表项时，
 * 这一列才会出现。已按契约在报告里列成「待服务端补的字段」。
 */
function openedPackageCount(item) {
  for (const key of ['openedPackageCount', 'coursePackageCount', 'packageCount']) {
    const value = item?.[key];
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function newOrganizationForm() {
  return {
    name: '', shortName: '', region: '', notes: '', status: 'ACTIVE',
    contactName: '', contactPhone: '',
    // 图2 没画「签约信息 / 人数上限 / 管理员账号」，但服务端 POST /organizations 必需：
    // 管理员账号密码是硬校验（ORG_ADMIN_INPUT_REQUIRED），学生上限不给就是 0（等于开不出学生）。
    // 所以这几项收在「签约、人数上限与管理员账号」折叠区里，默认值与既有口径一致。
    contractStartAt: new Date().toISOString().slice(0, 10),
    contractExpiresAt: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
    teacherSeats: 3, studentSeats: 0,
    adminLogin: '', adminDisplayName: '', adminPassword: '',
  };
}

/** 图2「添加机构」弹窗：必填校验 + 错误就地提示；成功后由父级关窗、刷新列表、给成功提示。 */
function CreateOrganizationDialog({ form, setForm, saving, error, onClose, onSubmit }) {
  const dialogRef = useRef(null);
  const [fieldErrors, setFieldErrors] = useState({});
  // ⚠️ 2026-10-03（用户口径）：这些字段**不再收在折叠区里** —— 它们是服务端必填项，
  //    藏起来等于"先让用户点开才知道要填"（用户原话：「既然……是必填项，就不应该是展开形式」）；
  //    连带那套"校验失败自动展开折叠区"的逻辑（detailsOpen）也一并删了：字段一直在屏幕上，
  //    红字就地可见。
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.showModal();
    return () => { dialogRef.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);

  /** 必填与格式校验：全在前端先拦一道，错误就地显示在字段下方（不看控制台）。 */
  function validate() {
    const errors = {};
    if (!form.name.trim()) errors.name = '请填写机构名称';
    if (!form.shortName.trim()) errors.shortName = '请填写机构简称';
    if (!form.contactName.trim()) errors.contactName = '请填写联系人';
    if (!form.contactPhone.trim()) errors.contactPhone = '请填写联系电话';
    else if (!/^[0-9+\-\s()]{6,20}$/.test(form.contactPhone.trim())) errors.contactPhone = '联系电话格式不正确（6-20 位数字，可带 + - 空格括号）';
    if (form.notes.length > 200) errors.notes = '备注不能超过 200 字';
    const start = new Date(form.contractStartAt).getTime();
    const expires = new Date(form.contractExpiresAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(expires)) errors.contractStartAt = '请填写合同开始与到期日期';
    else if (start >= expires) errors.contractStartAt = '合同开始日期必须早于到期日期';
    if (Number(form.teacherSeats) < 0 || !Number.isFinite(Number(form.teacherSeats))) errors.teacherSeats = '教师数量上限不能为负数';
    if (Number(form.studentSeats) < 0 || !Number.isFinite(Number(form.studentSeats))) errors.studentSeats = '学生数量上限不能为负数';
    if (!form.adminLogin.trim()) errors.adminLogin = '请填写机构管理员登录名';
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(form.adminLogin.trim())) errors.adminLogin = '只能用英文和数字（可带 . _ -）';
    if (!form.adminDisplayName.trim()) errors.adminDisplayName = '请填写机构管理员姓名';
    if (form.adminPassword.length < 6) errors.adminPassword = '管理员初始密码至少 6 位';
    return errors;
  }

  // ⚠️ 2026-10-03：原来这里有一份 `DETAIL_FIELDS`（折叠区字段清单），用来在"折叠区里的字段校验失败时
  //    自动展开折叠区"。字段现在常驻可见，这份清单没有用武之地，删掉。

  function submit(event) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    onSubmit(event);
  }

  const errorText = (key) => (fieldErrors[key] ? <small className="org-field-error">{fieldErrors[key]}</small> : null);

  return <dialog ref={dialogRef} className="admin-confirm" style={{ width: 'min(760px, calc(100vw - 32px))' }} aria-labelledby="create-organization-title" onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={submit} noValidate>
      <h2 id="create-organization-title">添加机构</h2>
      <p className="muted">创建后到机构详情页配置课包与授权次数。</p>
      <div className="form-grid">
        <label>机构名称 *<input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={200} placeholder="如：北京市海淀区魔法学院" />{errorText('name')}</label>
        <label>机构简称 *<input value={form.shortName} onChange={(event) => setForm({ ...form, shortName: event.target.value })} required maxLength={50} placeholder="如：海淀魔法学院" />{errorText('shortName')}</label>
        <label>联系人 *<input value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} required maxLength={200} />{errorText('contactName')}</label>
        <label>联系电话 *<input type="tel" value={form.contactPhone} onChange={(event) => setForm({ ...form, contactPhone: event.target.value })} required maxLength={200} placeholder="如：13800138000" />{errorText('contactPhone')}</label>
      </div>
      <div>
        <span className="org-field-label">机构状态</span>
        <div className="row-actions org-option-row">
          <label className="checkbox-option"><input type="radio" name="organization-status" checked={form.status === 'ACTIVE'} onChange={() => setForm({ ...form, status: 'ACTIVE' })} />正常</label>
          <label className="checkbox-option"><input type="radio" name="organization-status" checked={form.status === 'DISABLED'} onChange={() => setForm({ ...form, status: 'DISABLED' })} />停用</label>
        </div>
        {form.status === 'DISABLED' ? <small className="muted">选择停用后，创建成功会立即调用「禁用机构」（禁用需写明原因，这里按「创建机构时选择停用」记录）。</small> : null}
      </div>
      <label>所属区域<input value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} maxLength={100} placeholder="如：北京市·海淀区" /><small className="muted">选填；机构课包与授权次数、变更记录页会显示。</small></label>
      <label>备注<textarea rows={3} maxLength={200} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="填机构服务的约定事项或口头承诺" /><small className="muted">{form.notes.length}/200</small>{errorText('notes')}</label>
      {/* ⭐ 2026-10-03（用户口径）：「既然创建机构这里图1是必填项，就不应该是展开形式」——
          这七格是**服务端必填**，原来包在 `<details>` 里默认收起，等于让用户"点开才知道要填"。
          现在改成**常驻小节**（标题 + 三列网格）。
          ⭐ 同一轮的第二条口径：「机构管理员登录名和初始密码应该挨在一起」——原来中间夹着
          「机构管理员姓名」，两格被隔开；现在把它们排成相邻两格，姓名挪到其后。 */}
      <section className="org-section">
        <p className="org-field-label">签约信息、人数上限与机构管理员账号（均为必填）</p>
        <div className="form-grid">
          <label>签约开始日期 *<input type="date" value={form.contractStartAt} onChange={(event) => setForm({ ...form, contractStartAt: event.target.value })} required />{errorText('contractStartAt')}</label>
          <label>签约到期日期 *<input type="date" value={form.contractExpiresAt} onChange={(event) => setForm({ ...form, contractExpiresAt: event.target.value })} required /></label>
          <label>教师数量上限 *<input type="number" min="0" max="1000000" value={form.teacherSeats} onChange={(event) => setForm({ ...form, teacherSeats: event.target.value })} required />{errorText('teacherSeats')}</label>
          <label>学生数量上限 *<input type="number" min="0" max="1000000" value={form.studentSeats} onChange={(event) => setForm({ ...form, studentSeats: event.target.value })} required />{errorText('studentSeats')}</label>
          <label>机构管理员登录名 *<input autoComplete="username" value={form.adminLogin} onChange={(event) => setForm({ ...form, adminLogin: event.target.value })} required maxLength={100} />{errorText('adminLogin')}</label>
          <label>管理员初始密码 *<input type="password" autoComplete="new-password" value={form.adminPassword} onChange={(event) => setForm({ ...form, adminPassword: event.target.value })} required minLength={6} />{errorText('adminPassword')}</label>
          <label>机构管理员姓名 *<input value={form.adminDisplayName} onChange={(event) => setForm({ ...form, adminDisplayName: event.target.value })} required maxLength={200} />{errorText('adminDisplayName')}</label>
        </div>
      </section>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="row-actions">
        <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
        <button className="primary-button" disabled={saving}>{saving ? '创建中…' : '创建机构'}</button>
      </div>
    </form>
  </dialog>;
}

export function Organizations({ api }) {
  const navigate = useNavigate();
  // 筛选分「输入中」与「已生效」两份：点「查询」才把 draft 抄进 applied（图1 的查询 / 重置按钮）。
  const [draft, setDraft] = useState({ search: '', status: '' });
  const [applied, setApplied] = useState({ search: '', status: '' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [sort, setSort] = useState('created');
  const query = useMemo(() => {
    const params = new URLSearchParams(Object.entries(applied).filter(([, value]) => value));
    params.set('page', String(page)); params.set('limit', String(limit)); params.set('sort', sort);
    return params;
  }, [applied, page, limit, sort]);
  const organizations = useData(() => api.get(`admin/organizations?${query.toString()}`), [api, query]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [form, setForm] = useState(newOrganizationForm);
  const [dialogError, setDialogError] = useState('');
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState(null);
  const [createdId, setCreatedId] = useState('');

  function submitFilters(event) {
    event.preventDefault();
    setPage(1);
    setApplied({ ...draft });
    setMessage(null);
    organizations.refresh();
  }

  function resetFilters() {
    const empty = { search: '', status: '' };
    setDraft(empty); setApplied(empty); setSort('created'); setPage(1);
    organizations.refresh(); setMessage(null);
  }

  async function exportOrganizations() {
    setExporting(true); setMessage(null);
    try {
      const params = new URLSearchParams(Object.entries(applied).filter(([, value]) => value));
      const result = await api.get(`admin/organizations/export?${params.toString()}`);
      downloadCsv(result.filename, result.content);
      setMessage({ tone: 'success', text: `已导出 ${result.count} 家机构。` });
    } catch (error) { setMessage({ tone: 'danger', text: error.message }); } finally { setExporting(false); }
  }

  async function create(event) {
    event.preventDefault(); setSaving(true); setDialogError('');
    try {
      const created = await api.post('admin/organizations', {
        name: form.name.trim(),
        // 机构简称 / 所属区域：2026-09-18 新增字段，服务端正在补；老服务端会忽略这两个键，不会报错。
        shortName: form.shortName.trim(),
        region: form.region.trim() || undefined,
        isTrial: false,
        contractStartAt: form.contractStartAt,
        contractExpiresAt: form.contractExpiresAt,
        teacherSeats: Number(form.teacherSeats),
        studentSeats: Number(form.studentSeats),
        // 联系人 / 电话仍在 contact 这个 JSON 里，键名照服务端 contactPayload 的白名单：
        // name / phone / email / contractNotes（图2 的「备注」就是 contractNotes）。
        contact: { name: form.contactName.trim(), phone: form.contactPhone.trim(), contractNotes: form.notes.trim() },
        adminLogin: form.adminLogin.trim(),
        adminDisplayName: form.adminDisplayName.trim(),
        adminPassword: form.adminPassword,
      });
      let warning = '';
      if (form.status === 'DISABLED') {
        // 服务端 POST 只能建 ACTIVE，没有「直接建停用机构」的入参 → 建完立刻走状态动作（禁用必须带原因）。
        try { await api.post(`admin/organizations/${created.id}/status`, { action: 'disable', reason: '创建机构时选择停用' }); }
        catch (error) { warning = `机构已创建，但停用未生效：${error.message}`; }
      }
      setShowCreateDialog(false);
      setCreatedId(created.id);
      setMessage(warning ? { tone: 'warning', text: warning } : { tone: 'success', text: `机构「${created.name}」已创建。` });
      organizations.refresh();
    } catch (error) { setDialogError(error.message); } finally { setSaving(false); }
  }

  const items = organizations.data?.items || [];
  // 「已开通课包数」整列只在服务端真的带了这个数时才出现（见 openedPackageCount 的注释）。
  const showPackageColumn = items.some((item) => openedPackageCount(item) !== null);

  return <>
    <PageHeader eyebrow="平台教务" title="创建机构与授权" description="创建与维护机构资料、服务状态，并为每家机构配置课包与授权次数。" actions={<><button className="secondary-button" disabled={exporting} onClick={exportOrganizations}>{exporting ? '导出中…' : '导出 CSV'}</button><button className="secondary-button" onClick={() => { organizations.refresh(); setMessage(null); }}>刷新</button></>} />
    {showCreateDialog ? <CreateOrganizationDialog form={form} setForm={setForm} saving={saving} error={dialogError} onClose={() => setShowCreateDialog(false)} onSubmit={create} /> : null}
    <Notice tone="info">先选机构 → 再配置课包与授权次数（总授权次数 / 已授权次数 / 剩余授权次数）：列表里<b>「授权课包」直达</b>本机构的课包与授权次数，「查看详情」进机构详情。</Notice>
    {message ? <Notice tone={message.tone}>{message.text}{createdId ? <> 下一步：<Link to={`/organizations/${encodeURIComponent(createdId)}/quota`}>去授权课包</Link> · <Link to={`/organizations/${encodeURIComponent(createdId)}`}>查看机构详情</Link></> : null}</Notice> : null}
    <Panel title="机构列表">
      <form className="filter-form" onSubmit={submitFilters}>
        <label>机构名称<input value={draft.search} placeholder="机构名称 / 机构 ID" onChange={(event) => setDraft({ ...draft, search: event.target.value })} /></label>
        <label>状态<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>{ORGANIZATION_STATUS_FILTERS.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}</select></label>
        <label>排序<select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="created">创建时间</option><option value="name">机构名称</option><option value="expires">合同到期</option></select></label>
        <label>每页<select value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setPage(1); }}><option value="10">10 条</option><option value="20">20 条</option><option value="50">50 条</option><option value="100">100 条</option></select></label>
        <div className="row-actions">
          <button className="primary-button" disabled={organizations.loading}>查询</button>
          <button type="button" className="secondary-button" onClick={resetFilters}>重置</button>
          <button type="button" className="secondary-button" onClick={() => { setForm(newOrganizationForm()); setDialogError(''); setShowCreateDialog(true); }}>创建机构</button>
        </div>
      </form>
      {organizations.loading ? <Loading /> : organizations.error ? <ErrorState error={organizations.error} onRetry={organizations.refresh} /> : items.length ? <>
        <ListResultSummary total={organizations.data.total} page={organizations.data.page} totalPages={organizations.data.totalPages} label="条数据" />
        <div className="table-wrap"><table>
          <thead><tr>
            <th>机构名称</th><th>状态</th><th>教师数</th><th>学生数</th>
            {showPackageColumn ? <th>已开通课包数</th> : null}
            <th>创建时间</th><th>操作</th>
          </tr></thead>
          <tbody>{items.map((item) => <tr key={item.id}>
            <td>
              <Link to={`/organizations/${encodeURIComponent(item.id)}`}><strong>{item.name}</strong></Link>
              <div className="muted">{item.shortName || item.orgCode || item.id}</div>
            </td>
            <td><OrganizationStatusBadge status={item.status} /></td>
            <td>{item.teacherUsedSeats}</td>
            <td>{item.studentUsedSeats}</td>
            {showPackageColumn ? <td>{openedPackageCount(item) ?? '—'}</td> : null}
            <td>{formatDate(item.createdAt)}</td>
            <td><div className="row-actions">
              <button type="button" className="secondary-button" onClick={() => navigate(`/organizations/${encodeURIComponent(item.id)}`)}>查看详情</button>
              {/* ⭐ 2026-10-03（用户口径）：「创建完机构，在图2位置多个按钮，授权课包。跳转到图3页面」——
                  列表里**直达**该机构的「课包与授权次数」页（原来要先点进机构详情、再找「授权次数」入口，
                  多两步；详情页那个入口保留，两条路都能到）。 */}
              <button type="button" className="secondary-button" onClick={() => navigate(`/organizations/${encodeURIComponent(item.id)}/quota`)}>授权课包</button>
            </div></td>
          </tr>)}</tbody>
        </table></div>
        <Pagination page={organizations.data.page} totalPages={organizations.data.totalPages} onChange={setPage} disabled={organizations.loading} />
      </> : <Empty title="没有符合条件的机构" body="可以调整机构名称或状态筛选条件，或点「重置」清空条件。" />}
    </Panel>
  </>;
}

// （2026-09-27：这里原来有 `newLicensePurchaseKey()` / `initialLicensePurchaseForm()` 两个小工具，
//   给「授权与人次流水」页的追加次数表单用。那份表单**整体搬去机构页**了（见下），
//   这两个函数在本文件里已无引用，一并删掉。采购字段现在在
//   `pages/OrganizationQuota.jsx` 的「调整授权次数」抽屉里，幂等键随每次提交现生成。）

export function Authorizations({ api }) {
  const location = useLocation();
  const inventory = useData(() => api.get('admin/authorizations'), [api]);
  const organizations = { data: { items: inventory.data?.organizations || [] }, loading: inventory.loading, error: inventory.error, refresh: inventory.refresh };
  const deepLink = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const [seriesId, setSeriesId] = useState(() => deepLink.get('seriesId') || '');
  const [orgId, setOrgId] = useState(() => deepLink.get('orgId') || '');
  const [stock, setStock] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirm, confirmation] = useAdminConfirm();
  const selected = inventory.data?.items.find((item) => item.id === seriesId) || null;
  const selectedOrg = organizations.data?.items.find((item) => item.id === orgId) || null;
  const assignment = selected?.allocations.find((item) => item.orgId === orgId) || null;

  useEffect(() => {
    const requested = deepLink.get('seriesId');
    if (requested && inventory.data?.items.some((item) => item.id === requested)) setSeriesId(requested);
  }, [deepLink, inventory.data]);
  useEffect(() => {
    const requested = deepLink.get('orgId');
    if (requested && organizations.data?.items.some((item) => item.id === requested)) setOrgId(requested);
  }, [deepLink, organizations.data]);
  useEffect(() => {
    setStock(selected ? String(selected.stockTotal) : '');
  }, [seriesId, orgId, selected?.stockTotal, assignment?.expiresAt]);

  async function saveStock(event) {
    event.preventDefault();
    const next = Number(stock);
    await confirm({ title: '确认调整课包库存', message: `${selected.title}：库存总次数 ${selected.stockTotal} → ${next}。`, confirmLabel: '确认调整', execute: async () => {
      setBusy(true); setMessage('');
      try { await api.put(`admin/course-series/${seriesId}/stock`, { stockTotal: next }); setMessage('库存已更新。'); inventory.refresh(); }
      finally { setBusy(false); }
    } });
  }

  // （2026-09-27：这里的 `appendQuota`（追加次数 / 首次授权）已**整体搬走** —— 用户口径
  //   「图4 添加库存还能授权给机构，图5图6 这里也能授权给机构、也能添加次数。很多重复的逻辑和操作。
  //   梳理下能合并就合并」：给机构开通 / 追加 / 调整次数现在只有**机构页**一个入口
  //   （`/organizations/:orgId/quota`，机构采购与平台调整在同一个抽屉里二选一）。
  //   本页保留**课包视角**：库存总次数（平台自己的池子）+ 各机构已分到多少，只读。）
  return <>
    <PageHeader title="授权管理" description="选择一个课包和一家机构，查看当前授权后再追加次数或调整有效期。" />
    {confirmation}
    {message && <Notice tone="success">{message}</Notice>}
    {inventory.loading || organizations.loading ? <Loading /> : inventory.error ? <ErrorState error={inventory.error} onRetry={inventory.refresh} /> : organizations.error ? <ErrorState error={organizations.error} onRetry={organizations.refresh} /> : <>
      <Panel title="选择授权对象"><div className="form-grid">
        <label>课包<SearchSelect ariaLabel="搜索课包" value={seriesId} onChange={(value) => { setSeriesId(value); setMessage(''); }} options={inventory.data?.items || []} placeholder="选择已发布课包" searchPlaceholder="搜索课包名称" /></label>
        <label>机构<SearchSelect ariaLabel="搜索机构" value={orgId} onChange={(value) => { setOrgId(value); setMessage(''); }} options={organizations.data?.items || []} placeholder="选择一家机构" searchPlaceholder="搜索机构名称" /></label>
      </div></Panel>
      {selected ? <Panel title={`${selected.title} · 库存`}><div className="split">
        <div className="metrics"><MetricCard label="库存总次数" value={selected.stockTotal} /><MetricCard label="已分配或消耗" value={selected.reserved} /><MetricCard label="可分配库存" value={selected.available} /></div>
        <form onSubmit={saveStock}><label>调整库存总次数<input type="number" min={selected.reserved} max="100000000" required value={stock} onChange={(event) => setStock(event.target.value)} /></label><button className="secondary-button" disabled={busy || Number(stock) === selected.stockTotal}>调整库存</button></form>
      </div></Panel> : null}
      {selected && selectedOrg ? <>
        <div className="metrics">
          <MetricCard label="库存" value={selected.stockTotal} hint={`可分配 ${selected.available}`} />
          <MetricCard label="当前总次数" value={assignment?.quotaTotal || 0} hint={assignment ? '该机构现有授权' : '尚未授权'} />
          <MetricCard label="已分配" value={assignment?.quotaUsed || 0} hint="已发放给学生" />
          <MetricCard label="剩余" value={assignment?.remaining || 0} hint="机构仍可分配" />
          <MetricCard label="有效期" value={assignment?.expiresAt ? formatDate(assignment.expiresAt) : '未设置'} hint={assignment?.status || '未授权'} />
        </div>
        <div className="split">
          {/* ⭐ 2026-09-27（合并重复入口）：「追加次数」表单已**整体搬去机构页** —— 用户口径
              「很多重复的逻辑和操作。梳理下能合并就合并」。这里改成指路 + 只读说明：
              本页是**课包视角**（库存总次数 + 各机构分到多少），给机构开通/追加/调整在机构页那一个抽屉里。 */}
          <Panel title="给这家机构加次数">
            <p className="muted">加次数现在只有<strong>一个入口</strong>：进这家机构的「机构课包与授权次数」页——
              那里能看到它的全部课包与次数台账；<strong>增加</strong>要记一笔采购与收款（成交额 / 收款状态），
              <strong>减少</strong>只改次数、不动财务账。</p>
            <p className="muted">这一页负责的是<strong>课包自己的库存池</strong>（上面那个「调整库存总次数」）与各机构已分到多少。</p>
            <Link className="primary-button" to={`/organizations/${encodeURIComponent(orgId)}/quota`}>去「{selectedOrg.name}」的机构页加次数 →</Link>
          </Panel>
          <Panel title="授权有效期"><div className="card-list">
            <p className="muted">授权有效期<strong>不需要在这里填</strong>：它自动跟随该机构的<strong>合同到期日</strong>
              （2026-09-16 口径）。要延长机构的使用期限，就去改这家机构的合同日期，授权会自动一起续上。</p>
            <p className="muted">当前：{assignment?.expiresAt
              ? <>到期时间 <strong>{formatDate(assignment.expiresAt)}</strong>{selectedOrg?.contractExpiresAt ? <>，与合同到期日（{formatDate(selectedOrg.contractExpiresAt)}）一致</> : null}</>
              : '未设置（该机构没有合同到期日，视为永久有效）'}</p>
          </div></Panel>
        </div>
        {assignment?.purchaseBatches?.length ? <Panel title="购买批次历史"><div className="table-wrap"><table><thead><tr><th>购买时间</th><th>次数</th><th>实际成交总额</th><th>收款状态</th><th>订单号</th><th>合同号</th><th>已确认次数</th></tr></thead><tbody>{assignment.purchaseBatches.map((batch) => <tr key={batch.id}><td>{formatDate(batch.purchasedAt)}</td><td>{batch.quantity}</td><td>{batch.amountMinor == null || !batch.currency ? '未知（历史导入）' : `${(batch.amountMinor / 100).toFixed(2)} ${batch.currency}`}</td><td>{batch.paymentStatus === 'UNKNOWN' ? '未知' : <Status value={batch.paymentStatus} />}</td><td>{batch.orderNo || '未知'}</td><td>{batch.contractNo || '未知'}</td><td>{batch.recognizedQuantity}</td></tr>)}</tbody></table></div></Panel> : null}
        {!assignment ? <Notice tone="info">该机构尚未获得此课包。先追加正数次数即可创建授权；有效期自动跟随该机构的合同到期日。</Notice> : null}
      </> : <Empty title="选择课包和机构查看授权" body="普通授权流程一次只操作一家机构。" />}
      {selected ? <Panel title="该课包机构授权明细">{selected.allocations.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>状态</th><th>购买次数</th><th>已分配</th><th>余额</th><th>到期时间</th></tr></thead><tbody>{selected.allocations.map((item) => <tr key={item.id}><td>{item.orgName}</td><td><Status value={item.status} /></td><td>{item.quotaTotal}</td><td>{item.quotaUsed}</td><td>{item.remaining}</td><td>{formatDate(item.expiresAt)}</td></tr>)}</tbody></table></div> : <Empty title="暂无机构授权" />}</Panel> : null}
    </>}
  </>;
}
