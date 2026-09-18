// P03-03 机构课包与授权次数（图5）+ 图6 添加课包抽屉 + 图7 调整授权次数抽屉（2026-09-18 按线框图对齐）。
//
// 口径（用户 2026-09-18 定死）：平台侧只有**授权次数** ——
//   总授权次数 = course_assignments.quota_total
//   已授权次数 = course_assignments.quota_used（机构分给学生的部分）
//   剩余授权次数 = 总授权次数 − 已授权次数
// 界面上不出现「算力额度」「总人次」「已分配人次」。
//
// 依赖的接口（服务端另一个人在做，按交接文档的契约写）：
//   已有 GET  /api/admin/organizations/:id/detail            → 机构卡 + 已开通的课包（本页表格的数据源）
//   已有 POST /api/admin/course-series/:seriesId/assignments → 图6「添加课包」（平台给机构开课包那套，直接复用）
//   新   POST /api/admin/organizations/:id/course-quotas/:seriesId/adjust → 图7「调整授权次数」
//   新   GET  /api/admin/organizations/:id/course-quota-changes          → P03-04「查看变更记录」
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Empty, ErrorState, formatDate, Loading, ListResultSummary, Notice, PageHeader, Panel, SearchSelect, useData } from '@platform/shared';
import { AssignmentStatusBadge, OrganizationCard } from '../components/OrganizationShared.jsx';

/** 课包当前版本 / 课包编码：detail 的 courseAssignments 只带 seriesId + 课包名，
 *  版本与编码从「已发布课包」目录里现取（一次请求，不是每行一次）。服务端若日后在课包上补 code，自动生效。 */
function seriesMetaOf(assignment, seriesById) {
  const series = seriesById.get(assignment.seriesId);
  return {
    version: series?.version || '',
    code: series?.code || assignment.seriesCode || assignment.seriesId,
  };
}

function newIdempotencyKey() {
  return `org-quota-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 图6「添加课包」抽屉：为所选机构开启该课包。
 * ⚠️ 复用的是现有的 assignments 接口，而它**要求成交与订单信息**（服务端 normalizeLicensePurchaseInput：
 *    实际成交总额 / 币种 / 收款状态=PAID / 订单号 / 合同号 / 幂等键），缺一个就 400。
 *    所以除了线框图的字段，这里还带了一组「成交与订单信息」，并在界面上写明原因。
 */
function AddPackageDrawer({ api, orgId = '', options = [], assignedIds = new Set(), onClose = () => {}, onDone = () => {} }) {
  const [seriesId, setSeriesId] = useState('');
  const [quotaTotal, setQuotaTotal] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [note, setNote] = useState('');
  const [purchase, setPurchase] = useState({ amount: '', orderNo: '', contractNo: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const picked = options.find((item) => item.id === seriesId) || null;
  const quotaValue = Number(quotaTotal);
  const quotaValid = Number.isInteger(quotaValue) && quotaValue > 0;
  const purchaseValid = purchase.amount !== '' && Number(purchase.amount) >= 0 && purchase.orderNo.trim() && purchase.contractNo.trim();

  async function submit() {
    if (!picked) { setError('请选择要开通的课包'); return; }
    if (!quotaValid) { setError('初始授权次数必须是大于 0 的整数'); return; }
    if (!purchaseValid) { setError('请填写实际成交总额、订单号与合同号（现有开通接口必填）'); return; }
    setBusy(true); setError('');
    try {
      await api.post(`admin/course-series/${encodeURIComponent(picked.id)}/assignments`, {
        orgId,
        quotaTotal: quotaValue,
        amountMinor: Math.round(Number(purchase.amount) * 100),
        currency: 'CNY',
        paymentStatus: 'PAID',
        orderNo: purchase.orderNo.trim(),
        contractNo: purchase.contractNo.trim(),
        idempotencyKey: newIdempotencyKey(),
        // 业务备注：服务端开通接口目前没有这个入参，会被忽略（已在交付报告里列为待补字段）。
        note: note.trim() || undefined,
      });
      onDone(`已为机构开通课包「${picked.title}」，初始授权次数 ${quotaValue} 次。${note.trim() ? `业务备注：${note.trim()}。` : ''}${status === 'DISABLED' ? '（状态选择的是禁用，但现有接口开通即启用，未生效）' : ''}`);
      onClose();
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }

  return <div className="drawer-overlay" onClick={busy ? undefined : onClose}>
    <div className="drawer-panel" onClick={(event) => event.stopPropagation()}>
      <header className="drawer-head">
        <div><span className="eyebrow">P03-03 · 机构课包与授权次数</span><h2>添加课包</h2><span className="muted">为所选机构开启该课包，配置完成后该机构即可使用</span></div>
        <button type="button" className="drawer-close" onClick={onClose} disabled={busy} aria-label="关闭">×</button>
      </header>
      <div className="drawer-body">
        <section className="drawer-section">
          <h3>选择课包</h3>
          <label>课包（可搜索）
            <SearchSelect ariaLabel="选择要开通的课包" value={seriesId} options={options} placeholder="选择已发布课包" searchPlaceholder="输入课包名称搜索"
              getLabel={(item) => item.title} getDisabled={(item) => assignedIds.has(item.id)} onChange={(value) => { setSeriesId(value); setError(''); }} />
          </label>
          <small className="muted">只列已发布的平台课包；已开通的课包不可重复选择（要调次数请用列表里的「调整授权次数」）。</small>
          {picked ? <div className="table-wrap top-gap"><table><tbody>
            <tr><th>课包名称</th><td>{picked.title}</td></tr>
            <tr><th>版本</th><td>v{picked.version || '—'}（取该课包当前版本，不在这里改）</td></tr>
            <tr><th>课包库存</th><td>总 {picked.stockTotal ?? '—'} 次（平台侧可授权出去的次数池；超了服务端会拒绝，报「课包可分配库存不足」）</td></tr>
          </tbody></table></div> : null}
        </section>
        <section className="drawer-section">
          <h3>授权配置</h3>
          <div className="form-grid">
            <label>初始授权次数 *<input type="number" min="1" max="100000000" value={quotaTotal} onChange={(event) => setQuotaTotal(event.target.value)} placeholder="如：100" /><small className="muted">单位：次</small></label>
            <label>有效期<input value="自动跟随该机构合同到期日" readOnly /></label>
          </div>
          <div>
            <span className="org-field-label">状态</span>
            <div className="row-actions">
              <label className="checkbox-option"><input type="radio" name="assignment-status" checked={status === 'ACTIVE'} onChange={() => setStatus('ACTIVE')} />启用</label>
              <label className="checkbox-option"><input type="radio" name="assignment-status" disabled checked={status === 'DISABLED'} onChange={() => setStatus('DISABLED')} />禁用</label>
            </div>
            <small className="muted">现有开通接口只支持「开通即启用」；如开通后需要停用，请在「课包与课程编排」里撤销该机构的这个课包。</small>
          </div>
          <label>业务备注<textarea rows={3} maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} placeholder="如：本批次为秋季学期采购" /><small className="muted">{note.length}/200 · 服务端开通接口暂不接收该字段，仅随本次操作提示回显。</small></label>
        </section>
        <section className="drawer-section">
          <h3>成交与订单信息（现有开通接口必填）</h3>
          <p className="muted">平台给机构开通课包时，服务端会同时记一笔许可购买批次（许可三账里的库存账），所以这几项必填；收款状态固定为已收款。</p>
          <div className="form-grid">
            <label>实际成交总额（元）*<input type="number" min="0" step="0.01" value={purchase.amount} onChange={(event) => setPurchase({ ...purchase, amount: event.target.value })} /></label>
            <label>收款状态<input value="已收款" readOnly /></label>
            <label>订单号 *<input maxLength={200} value={purchase.orderNo} onChange={(event) => setPurchase({ ...purchase, orderNo: event.target.value })} /></label>
            <label>合同号 *<input maxLength={200} value={purchase.contractNo} onChange={(event) => setPurchase({ ...purchase, contractNo: event.target.value })} /></label>
          </div>
        </section>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <footer className="drawer-foot">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="primary-button" disabled={busy || !picked || !quotaValid || !purchaseValid} onClick={submit}>{busy ? '开通中…' : '确认添加'}</button>
      </footer>
    </div>
  </div>;
}

/** 图7「调整授权次数」抽屉：把某机构某课包的总授权次数加减一个值。 */
function AdjustQuotaDrawer({ api, orgId = '', assignment = null, assignments = [], seriesById = new Map(), onClose = () => {}, onDone = () => {} }) {
  const [direction, setDirection] = useState('ADD');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 提交后父级会刷新 detail，这里按 seriesId 重新取一次现值 —— 抽屉里的数字跟着变（线框图要求）。
  const current = assignments.find((item) => item.seriesId === assignment?.seriesId) || assignment;
  if (!current) return null;
  const meta = seriesMetaOf(current, seriesById);
  const total = Number(current.quotaTotal || 0);
  const used = Number(current.quotaUsed || 0);
  const remaining = Math.max(0, total - used);
  const amount = Number(value);
  const amountValid = Number.isInteger(amount) && amount > 0;
  const delta = direction === 'ADD' ? (amountValid ? amount : 0) : (amountValid ? -amount : 0);
  const nextTotal = total + delta;
  const belowUsed = nextTotal < used;
  const reasonValid = reason.trim().length > 0 && reason.trim().length <= 200;

  async function submit() {
    if (!amountValid) { setError('调整数值必须是大于 0 的整数'); return; }
    if (!reasonValid) { setError('请填写调整原因（不超过 200 字）'); return; }
    if (belowUsed) { setError(`调整后总授权次数不能少于当前已授权次数（${used} 次）`); return; }
    setBusy(true); setError('');
    try {
      await api.post(`admin/organizations/${encodeURIComponent(orgId)}/course-quotas/${encodeURIComponent(current.seriesId)}/adjust`, { delta, reason: reason.trim() });
      setValue('');
      onDone(`已调整课包「${current.title}」的授权次数：总授权次数 ${total} → ${nextTotal} 次。`);
    } catch (failure) {
      // 服务端在「总授权次数不得小于已授权次数」时返回 409，message 里带「当前已授权次数」——原样就地显示。
      setError(failure.message);
    } finally { setBusy(false); }
  }

  return <div className="drawer-overlay" onClick={busy ? undefined : onClose}>
    <div className="drawer-panel" onClick={(event) => event.stopPropagation()}>
      <header className="drawer-head">
        <div><span className="eyebrow">P03-03 · 机构课包与授权次数</span><h2>调整授权次数</h2><span className="muted">{current.title}</span></div>
        <button type="button" className="drawer-close" onClick={onClose} disabled={busy} aria-label="关闭">×</button>
      </header>
      <div className="drawer-body">
        <section className="drawer-section">
          <h3>课包信息</h3>
          <div className="table-wrap"><table><tbody>
            <tr><th>课包名称</th><td>{current.title}</td></tr>
            <tr><th>状态</th><td><AssignmentStatusBadge status={current.status} /></td></tr>
            <tr><th>当前版本</th><td>{meta.version ? `v${meta.version}` : '—'}</td></tr>
            <tr><th>课包编码</th><td><code>{meta.code || '—'}</code></td></tr>
            <tr><th>总授权次数</th><td>{total} 次</td></tr>
            <tr><th>已授权次数</th><td>{used} 次</td></tr>
            <tr><th>剩余授权次数</th><td>{remaining} 次</td></tr>
          </tbody></table></div>
        </section>
        <section className="drawer-section">
          <h3>调整内容</h3>
          <div>
            <span className="org-field-label">调整类型</span>
            <div className="row-actions">
              <label className="checkbox-option"><input type="radio" name="quota-direction" checked={direction === 'ADD'} onChange={() => { setDirection('ADD'); setError(''); }} />增加</label>
              <label className="checkbox-option"><input type="radio" name="quota-direction" checked={direction === 'REDUCE'} onChange={() => { setDirection('REDUCE'); setError(''); }} />减少</label>
            </div>
          </div>
          <label>调整数值（次）*<input type="number" min="1" step="1" value={value} onChange={(event) => { setValue(event.target.value); setError(''); }} placeholder="如：50" /><small className="muted">单位：次，必须是大于 0 的整数；{direction === 'ADD' ? '增加' : '减少'} {amountValid ? amount : 0} 次</small></label>
          <label>调整原因（必填，不超过 200 字）*<textarea rows={3} maxLength={200} value={reason} onChange={(event) => { setReason(event.target.value); setError(''); }} placeholder="如：机构追加采购 50 次" /><small className="muted">{reason.length}/200</small></label>
          <Notice tone="warning">调整后总授权次数不能少于当前已授权次数（{used} 次）。{amountValid ? <> 本次调整后总授权次数为 <strong>{nextTotal}</strong> 次，已授权 {used} 次、剩余 {Math.max(0, nextTotal - used)} 次。</> : null}</Notice>
        </section>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <footer className="drawer-foot">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="primary-button" disabled={busy || !amountValid || !reasonValid || belowUsed} onClick={submit}>{busy ? '提交中…' : '确认调整'}</button>
      </footer>
    </div>
  </div>;
}

export function OrganizationQuota({ api }) {
  const { orgId = '' } = useParams();
  const navigate = useNavigate();
  const detail = useData(() => (orgId ? api.get(`admin/organizations/${encodeURIComponent(orgId)}/detail`) : Promise.resolve(null)), [api, orgId]);
  // 已发布课包目录：图6 的选择列表 + 表格里的「当前版本 / 课包编码」都取自它（一次请求）。
  // 这个请求失败（例如账号只有机构域权限）不该让整页报错 —— 表格仍按 detail 渲染，版本列显示「—」。
  const catalog = useData(() => api.get('admin/course-series?status=PUBLISHED&limit=200&sort=title'), [api]);
  const [message, setMessage] = useState(null);
  const [showAddDrawer, setShowAddDrawer] = useState(false);
  const [adjustSeriesId, setAdjustSeriesId] = useState('');
  const organization = detail.data?.organization || null;
  const assignments = detail.data?.courseAssignments || [];
  const seriesItems = catalog.data?.items || [];
  const seriesById = useMemo(() => new Map(seriesItems.map((item) => [item.id, item])), [seriesItems]);
  const assignedIds = useMemo(() => new Set(assignments.map((item) => item.seriesId)), [assignments]);
  const adjustTarget = assignments.find((item) => item.seriesId === adjustSeriesId) || null;

  if (!orgId) return <Panel title="机构课包与授权次数"><Empty title="缺少机构标识" body="请从机构列表点「查看详情」，再用「授权次数」入口进入本页。" /></Panel>;

  return <>
    <PageHeader eyebrow="平台教务 · 机构与课包人次" title="机构课包与授权次数" description="给本机构开通课包、调整总授权次数；已授权次数是机构已经分给学生的部分，剩余 = 总授权次数 − 已授权次数。" actions={<><button className="secondary-button" onClick={() => navigate(`/organizations/${encodeURIComponent(orgId)}`)}>← 返回机构详情</button><Link className="secondary-button" to={`/authorizations?orgId=${encodeURIComponent(orgId)}`}>前往授权与人次流水</Link></>} />
    {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    {detail.loading ? <Loading label="正在读取机构课包…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : !detail.data ? <Panel title="机构课包与授权次数"><Empty title="没有找到该机构" body="机构可能已被删除，或链接里的机构标识不正确。" /></Panel> : <>
      <OrganizationCard organization={organization} meta={<p className="muted">共 {assignments.length} 个课包，其中有效 {assignments.filter((item) => item.status === 'ACTIVE').length} 个。</p>} />
      <Panel title={`共 ${assignments.length} 个课包`} actions={<div className="row-actions">
        <button type="button" className="primary-button" onClick={() => { setMessage(null); setShowAddDrawer(true); }}>添加课包</button>
        <button type="button" className="secondary-button" onClick={() => { detail.refresh(); catalog.refresh(); }}>刷新</button>
      </div>}>
        {catalog.error ? <Notice tone="warning">课包目录读取失败（{catalog.error.message}），「当前版本 / 课包编码」暂时显示为「—」，不影响列表本身。</Notice> : null}
        {assignments.length ? <>
          <ListResultSummary total={assignments.length} page={1} totalPages={1} label="个课包" />
          <div className="table-wrap"><table>
            <thead><tr>
              <th>序号</th><th>课包名称</th><th>当前版本</th><th>状态</th>
              <th>总授权次数</th><th>已授权次数</th><th>剩余授权次数</th><th>开通时间</th><th>操作</th>
            </tr></thead>
            <tbody>{assignments.map((item, index) => {
              const meta = seriesMetaOf(item, seriesById);
              return <tr key={item.id}>
                <td>{index + 1}</td>
                <td><strong>{item.title}</strong><div className="muted"><code>{meta.code}</code>{item.expiresAt ? ` · 到期 ${formatDate(item.expiresAt)}` : ''}</div></td>
                <td>{meta.version ? `v${meta.version}` : '—'}</td>
                <td><AssignmentStatusBadge status={item.status} /></td>
                <td>{item.quotaTotal} 次</td>
                <td>{item.quotaUsed} 次</td>
                <td>{item.remaining} 次</td>
                <td>{formatDate(item.assignedAt)}</td>
                <td><div className="row-actions">
                  <button type="button" className="secondary-button" onClick={() => { setMessage(null); setAdjustSeriesId(item.seriesId); }}>调整授权次数</button>
                  <button type="button" className="secondary-button" onClick={() => navigate(`/organizations/${encodeURIComponent(orgId)}/quota-changes?seriesId=${encodeURIComponent(item.seriesId)}`)}>查看变更记录</button>
                </div></td>
              </tr>;
            })}</tbody>
          </table></div>
          <p className="muted">「已授权次数」= 机构已经分给学生（或学生已消耗）的授权次数；「剩余授权次数」= 总授权次数 − 已授权次数。调整记录见每行的「查看变更记录」。</p>
        </> : <Empty title="该机构还没有开通任何课包" body="点右上角「添加课包」为它开通第一个课包并设置初始授权次数。" />}
      </Panel>
    </>}
    {showAddDrawer ? <AddPackageDrawer api={api} orgId={orgId} options={seriesItems} assignedIds={assignedIds}
      onClose={() => setShowAddDrawer(false)}
      onDone={(text) => { setMessage({ tone: 'success', text }); detail.refresh(); }} /> : null}
    {adjustTarget ? <AdjustQuotaDrawer api={api} orgId={orgId} assignment={adjustTarget} assignments={assignments} seriesById={seriesById}
      onClose={() => setAdjustSeriesId('')}
      onDone={(text) => { setMessage({ tone: 'success', text }); detail.refresh(); }} /> : null}
  </>;
}
