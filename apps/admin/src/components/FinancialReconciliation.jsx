import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty, ErrorState, formatDate, Loading, MetricCard, Notice, Panel, Pagination, SearchSelect, Status, useData } from '@platform/shared';
import { downloadCsv } from '../shared.jsx';

const STATUS = { MATCHED: '已匹配', PARTIAL: '部分匹配', UNMATCHED: '未匹配', AMBIGUOUS: '有歧义', EXCLUDED: '已排除', DISPUTED: '争议中', CANCELLED: '已取消' };
const EMPTY_FILTERS = { days: '30', orgId: '', studentId: '', seriesId: '', sessionId: '', lessonId: '', model: '', channelId: '', currency: '' };
const money = (minor, currency) => minor == null || !currency ? '未知' : `${(Number(minor) / 100).toFixed(2)} ${currency}`;
const minorText = (value) => value == null ? '未知' : (Number(value) / 100).toFixed(2);
const SALE_SOURCE = { SNAPSHOT: '快照价', PRICING: '当前配置价', UNKNOWN: '未知' };
// 上游计费来源（P90）。COMPUTED = 按渠道「上游合同单价」折算出来的自动计费；它不是供应商最终账单。
const UPSTREAM_SOURCE = { COMPUTED: 'COMPUTED 按合同价折算', REPORTED: 'REPORTED 上游报告', ESTIMATED: 'ESTIMATED 配置估算', MOCK: 'MOCK 本地模拟（不计费）', UNKNOWN: 'UNKNOWN 未知' };
const UPSTREAM_SOURCE_HINT = { COMPUTED: '按合同单价自动折算', REPORTED: '上游回执，未对账', ESTIMATED: '配置估算，未对账', MOCK: '本地模拟，未产生上游费用', UNKNOWN: '缺用量或缺单价，不按 0 计' };
// 折算用了哪一层价（P90）：MODEL = 模型级覆盖，MODALITY = 渠道的素材类型价。
const PRICE_LEVEL = { MODEL: '模型级覆盖', MODALITY: '素材类型价' };
const EVIDENCE_KIND = { UPSTREAM_USAGE: '上游用量回执', REQUEST_PARAMS: '请求参数', NONE: '无' };
// 用量证据（usage_snapshot）：tokens / 张数 / 秒数 / 分辨率 —— 折算的输入，不是金额。
function usageEvidenceText(usage) {
  if (!usage || typeof usage !== 'object') return '用量证据：无（折算不出来时按 UNKNOWN 处理）';
  const parts = [];
  if (usage.inputTokens != null || usage.outputTokens != null) parts.push(`tokens 输入 ${usage.inputTokens ?? '—'} / 输出 ${usage.outputTokens ?? '—'}`);
  if (usage.images != null) parts.push(`${usage.images} 张`);
  if (usage.seconds != null) parts.push(`${usage.seconds} 秒`);
  if (usage.resolution) parts.push(`分辨率 ${usage.resolution}`);
  if (usage.audio === true) parts.push('含音频');
  if (!parts.length) return '用量证据：无（折算不出来时按 UNKNOWN 处理）';
  return `用量证据（${EVIDENCE_KIND[usage.evidence] || usage.evidence || '未知来源'}）：${parts.join(' · ')}`;
}
const safeCell = (value) => { let text = String(value ?? ''); if (/^[\s]*[=+@-]/.test(text)) text = "'" + text; return `"${text.replaceAll('"', '""')}"`; };
const asQuery = (values) => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== '' && value != null));

function FilterBar({ options, filters, onChange, includeCurrency = false, marginOnly = false }) {
  const selects = [
    ['orgId', '机构', options.organizations || []],
    ['studentId', '学生', (options.students || []).filter((item) => !filters.orgId || item.orgId === filters.orgId)],
    ['seriesId', '课包', options.series || []],
  ];
  if (!marginOnly) selects.push(
    ['sessionId', '课堂', (options.sessions || []).filter((item) => (!filters.orgId || item.orgId === filters.orgId) && (!filters.seriesId || item.seriesId === filters.seriesId))],
    ['lessonId', '课时', (options.lessons || []).filter((item) => !filters.seriesId || item.seriesId === filters.seriesId)],
    ['model', '模型', options.models || []], ['channelId', '渠道', options.channels || []],
  );
  if (includeCurrency) selects.push(['currency', '币种', options.currencies || []]);
  return <div className="financial-filters">
    <label>时间范围<select value={filters.days} onChange={(event) => onChange('days', event.target.value)}><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option><option value="365">近一年</option></select></label>
    {selects.map(([key, label, items]) => <label key={key}>{label}<SearchSelect ariaLabel={`搜索${label}`} value={filters[key]} onChange={(value) => onChange(key, value)} options={[{ id: '', name: `全部${label}` }, ...items]} placeholder={`全部${label}`} searchPlaceholder={`搜索${label}`} /></label>)}
  </div>;
}

const CALL_DIMENSIONS = [['modality', '模态'], ['channel', '渠道'], ['model', '模型'], ['org', '机构'], ['student', '学员']];
const SUMMARY_COLUMNS = ['维度', '调用次数', '对外金额', '已知上游成本', '实际核销', '未核销笔数', '差额'];

function CallSummaryBlock({ api, query }) {
  const [dimension, setDimension] = useState('modality');
  const summary = useData(() => api.get(`admin/financial-reporting/call-summary?${query}`), [api, query]);
  const rows = summary.data?.groups?.[dimension] || [];
  return <Panel title="对外售价与上游成本对照汇总" actions={<div className="row-actions">{CALL_DIMENSIONS.map(([key, label]) => <button key={key} type="button" className={dimension === key ? 'primary-button' : 'secondary-button'} aria-pressed={dimension === key} onClick={() => setDimension(key)}>{label}汇总</button>)}</div>}>
    <Notice tone="info">四类金额分区，禁止混读：① <strong>对外售价</strong>（本次快照价，无快照回退当前配置并标注来源；仅观测，不扣学生、不计收入）② <strong>学生消耗</strong>（调用次数与对应对外金额）③ <strong>上游计费</strong>（COMPUTED 按合同价自动折算 / REPORTED 上游报告 / ESTIMATED 配置估算 / UNKNOWN 未知，均为估值，不等于供应商最终账单）④ <strong>上游实际核销</strong>（供应商账单匹配金额，才是实际付款）。对外售价不进入收入或毛利公式；未知金额一律单列，不并入差额、不按 0 处理。</Notice>
    {summary.loading ? <Loading label="正在汇总对外售价…" /> : summary.error ? <ErrorState error={summary.error} onRetry={summary.refresh} /> : rows.length ? <div className="table-wrap"><table><thead><tr>{SUMMARY_COLUMNS.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((item) => <tr key={item.key || 'unknown'}><td><strong>{item.label}</strong>{item.currency ? <div className="muted">核销币种 {item.currency}</div> : null}</td><td>{item.calls}</td><td>{minorText(item.externalAmountMinor)}{item.saleUnknownCount ? <div className="muted">另有 {item.saleUnknownCount} 笔对外价未知</div> : null}</td><td>{minorText(item.knownUpstreamCostMinor)}{item.upstreamUnknownCount ? <div className="muted">另有 {item.upstreamUnknownCount} 笔上游成本未知</div> : null}</td><td>{item.settledAmountMinor == null ? <span className="muted">跨币种 / 未知</span> : minorText(item.settledAmountMinor)}</td><td>{item.unsettledCount}</td><td>{item.differenceMinor == null ? <span className="muted">未核销 / 未知</span> : <strong>{minorText(item.differenceMinor)}</strong>}</td></tr>)}</tbody></table></div> : <Empty title="当前筛选没有可汇总的调用" />}
  </Panel>;
}

export function CallLedgerView({ api }) {
  const options = useData(() => api.get('admin/financial-reporting/options'), [api]);
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS, status: '', evidenceMatch: '' }); const [page, setPage] = useState(1);
  const filterQuery = useMemo(() => asQuery(filters).toString(), [filters]);
  const query = useMemo(() => { const value = asQuery(filters); value.set('page', page); value.set('limit', '20'); return value.toString(); }, [filters, page]);
  const report = useData(() => api.get(`admin/financial-reporting/calls?${query}`), [api, query]);
  const update = (key, value) => { setFilters((current) => ({ ...current, [key]: value, ...(key === 'orgId' ? { studentId: '', sessionId: '' } : {}), ...(key === 'seriesId' ? { lessonId: '', sessionId: '' } : {}) })); setPage(1); };
  return <>
    <Notice>估算和上游报告仅作调用证据，不计入结算成本。没有供应商匹配时显示“未核销”，未知金额不会按 0 处理。对外售价不扣学生、不计收入。「上游计费」一列可能来自 <strong>COMPUTED</strong>（按渠道合同单价自动折算），但它<strong>仍是估值、不等于供应商最终账单</strong>；缺用量或缺单价时保持未知，不会按 0 计。</Notice>
    <Panel title="调用账筛选"><FilterBar options={options.data || {}} filters={filters} onChange={update} /><div className="financial-filters top-gap"><label>调用状态<select value={filters.status} onChange={(event) => update('status', event.target.value)}><option value="">全部状态</option><option value="SUCCESS">成功</option><option value="FAILED">失败</option><option value="RUNNING">处理中</option></select></label><label>证据状态<select value={filters.evidenceMatch} onChange={(event) => update('evidenceMatch', event.target.value)}><option value="">全部证据</option><option value="MATCHED">完整</option><option value="PARTIAL">部分</option><option value="UNMATCHED">缺失</option></select></label></div></Panel>
    <CallSummaryBlock api={api} query={filterQuery} />
    <Panel title="调用账">{report.loading || options.loading ? <Loading label="正在读取调用账…" /> : report.error ? <ErrorState error={report.error} onRetry={report.refresh} /> : report.data?.items?.length ? <><div className="table-wrap"><table><thead><tr><th>时间 / 请求 ID</th><th>机构 / 学生</th><th>模型 / 渠道</th><th>状态</th><th>对外售价</th><th>上游计费（来源 / 用量证据）</th><th>实际核销</th><th>差额</th></tr></thead><tbody>{report.data.items.map((item) => <tr key={item.id}><td>{formatDate(item.createdAt)}<div className="mono muted">{item.clientRequestId || item.responseRequestId || item.callId}</div><details><summary>全部证据</summary><div className="mono muted">attempt: {item.id}<br />usage: {item.usageId || '无'}<br />task: {item.taskId || '无'}<br />gateway: {item.gatewayLogId || '无'}</div></details></td><td><strong>{item.organizationName || item.orgId || '未归属'}</strong><div className="muted">{item.studentName || item.userId || '未归属'}</div></td><td>{item.model || '未知模型'}<div className="muted">{item.actualChannelId || item.channelId || '未知渠道'} · {item.modality}</div></td><td><Status value={item.status} /><div className="muted">证据：{item.evidenceMatch}</div></td><td>{item.salePriceFen == null ? <span className="muted">未知</span> : <strong>{minorText(item.salePriceFen)}</strong>}<div className="muted">来源：{SALE_SOURCE[item.salePriceSource] || item.salePriceSource}，不扣学生不计收入</div></td><td>{item.costUnknown ? <span className="muted">未知</span> : <strong>{minorText(item.estimatedOrReportedMinor)}</strong>}<div className="muted">{UPSTREAM_SOURCE[item.costSource] || item.costSource || 'UNKNOWN'} · {UPSTREAM_SOURCE_HINT[item.costSource] || '不作实际成本'}</div>{item.costRuleSnapshot?.priceLevel ? <div className="muted">价目层级：{item.costRuleSnapshot.priceLevel}{PRICE_LEVEL[item.costRuleSnapshot.priceLevel] ? `（${PRICE_LEVEL[item.costRuleSnapshot.priceLevel]}）` : ''}</div> : null}<div className="muted">{usageEvidenceText(item.usageSnapshot)}</div></td><td>{item.settledAmountMinor == null ? <strong>未核销</strong> : <strong>{money(item.settledAmountMinor, item.settledCurrency)}</strong>}<div className="muted">{item.matches.length} 条有效匹配</div></td><td>{item.differenceMinor == null ? <span className="muted">未核销</span> : <strong>{minorText(item.differenceMinor)}</strong>}<div className="muted">对外售价 − 实际核销</div></td></tr>)}</tbody></table></div><Pagination page={report.data.page} totalPages={report.data.totalPages} onChange={setPage} disabled={report.loading} /></> : <Empty title="当前筛选没有调用记录" />}</Panel>
  </>;
}

// ── 官方账单 API 自动对账（P91）────────────────────────────────────────────────
// 拉取侧：平台按账期去供应商的账单接口把官方数字拉回来（provider_bill_snapshots / provider_bill_aggregates），
// 与平台口径（COMPUTED 按合同价折算 / ESTIMATED / REPORTED）和 CSV 已核销并排放。
// 三条边界必须写在界面上（别在别处再抄一遍）：
//   ① 合同单价折算（COMPUTED）≠ 供应商最终账单；② 官方账单是**账期聚合**，不是逐笔明细；
//   ③ CSV 手工导入保留为兜底（接口不可用、上游不给历史账期、或需要票据级明细时用它）。
const SNAPSHOT_STATUS = { FETCHED: '已拉取', FAILED: '失败' };
const DIFFERENCE_REASON = { OFFICIAL_MISSING: '官方账单没有这个模型', COMPUTED_MISSING: '平台没有 COMPUTED 折算', COMPUTED_INCOMPLETE: '平台有成本未知的调用，差异不可算' };
const RECONCILE_COLUMNS = ['模型', '官方账单合计', '平台 COMPUTED（合同价折算）', 'ESTIMATED', 'REPORTED', 'CSV 已核销', '差异（官方 − COMPUTED）', '说明'];
const INCOMPLETE_LABEL = { official: '官方账单', computed: 'COMPUTED', estimated: 'ESTIMATED', reported: 'REPORTED', csvSettled: 'CSV 已核销', difference: '差异' };
const monthPeriod = (date = new Date()) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
function periodBounds(period) {
  const [year, month] = String(period || '').split('-').map(Number);
  if (!year || !month) return null;
  return { periodStart: new Date(Date.UTC(year, month - 1, 1)).toISOString(), periodEnd: new Date(Date.UTC(year, month, 1)).toISOString() };
}
// 缺失 / 未知一律留空并写明，**绝不显示成 0**。
const missingCell = (text = '缺失 / 未知') => <span className="muted">{text}</span>;

export function ProviderBillReconciliationBlock({ api }) {
  const [accountId, setAccountId] = useState('');
  const [period, setPeriod] = useState(monthPeriod);
  const [draft, setDraft] = useState(null);
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const accounts = useData(() => api.get('admin/provider-billing/accounts'), [api]);
  const adapters = useData(() => api.get('admin/provider-billing/adapters'), [api]);
  const statusQuery = asQuery({ supplierAccountId: accountId, limit: '20' }).toString();
  const snapshotQuery = asQuery({ supplierAccountId: accountId, limit: '50' }).toString();
  const status = useData(() => api.get(`admin/provider-billing/status?${statusQuery}`), [api, statusQuery]);
  const snapshots = useData(() => api.get(`admin/provider-billing/snapshots?${snapshotQuery}`), [api, snapshotQuery]);
  const reconcileQuery = asQuery({ period, supplierAccountId: accountId }).toString();
  const reconcile = useData(() => api.get(`admin/financial-reporting/provider-bill-reconciliation?${reconcileQuery}`), [api, reconcileQuery]);
  const bounds = periodBounds(period);
  const accountOptions = accounts.data?.items || [];
  const account = (status.data?.accounts || [])[0] || null;
  const billing = account?.billing || null;
  const scheduler = status.data?.scheduler || accounts.data?.scheduler || {};
  useEffect(() => {
    if (!billing) { setDraft(null); return; }
    setDraft({
      adapter: billing.adapter || '', endpoint: billing.endpoint || '', method: billing.method || 'GET',
      periodDays: String(billing.periodDays || 1), enabled: Boolean(billing.enabled),
      headers: JSON.stringify(billing.headers || {}, null, 2), mapping: JSON.stringify(billing.mapping || {}, null, 2),
    });
  }, [accountId, billing?.adapter, billing?.endpoint, billing?.method, billing?.periodDays, billing?.enabled, billing?.credentialConfigured]);

  function refreshAll() { status.refresh(); snapshots.refresh(); reconcile.refresh(); }
  function parseObjectField(text, label) {
    const raw = String(text || '').trim();
    if (!raw) return {};
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`${label} 不是合法的 JSON`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
    return parsed;
  }
  async function run(action) {
    setBusy(true); setMessage(''); setError('');
    try { await action(); }
    catch (failure) { setError(`${failure.message || '操作失败，请重试。'}${failure.code ? `（${failure.code}）` : ''}`); }
    finally { setBusy(false); refreshAll(); }
  }
  const saveConfig = () => {
    if (!draft || !accountId) return;
    return run(async () => {
      await api.post(`admin/provider-billing/accounts/${accountId}/config`, {
        adapter: draft.adapter, endpoint: draft.endpoint, method: draft.method,
        periodDays: Number(draft.periodDays) || 1, enabled: draft.enabled,
        headers: parseObjectField(draft.headers, '请求头'), mapping: parseObjectField(draft.mapping, 'JSON 路径映射'),
      });
      setMessage('账单接口配置已保存。');
    });
  };
  const setCredentialValue = () => {
    if (!accountId || !credential.trim()) { setError('请先选择账户并填写凭据。'); return Promise.resolve(); }
    return run(async () => {
      await api.post(`admin/provider-billing/accounts/${accountId}/credential`, { credential: credential.trim() });
      setCredential('');
      setMessage('凭据已加密保存：界面只显示「已配置」，不回显明文。');
    });
  };
  const clearCredential = () => {
    if (!accountId) return Promise.resolve();
    return run(async () => { await api.delete(`admin/provider-billing/accounts/${accountId}/credential`); setMessage('凭据已清除，该账户不会再用凭据访问账单接口。'); });
  };
  const syncAccount = () => {
    if (!accountId) { setError('请先选择供应商账户。'); return Promise.resolve(); }
    return run(async () => {
      const result = await api.post(`admin/provider-billing/accounts/${accountId}/sync`, bounds || {});
      setMessage(`同步结果：${result.status}${result.idempotent ? '（同一份账单，未重复写入）' : ''}${result.snapshot ? `，${result.snapshot.itemCount} 条聚合` : ''}${result.error ? `；失败原因 ${result.error.code}：${result.error.message}` : ''}`);
    });
  };
  const syncAll = () => run(async () => {
    const result = await api.post('admin/provider-billing/sync', bounds || {});
    const failures = (result.results || []).filter((item) => item.error).map((item) => `${item.code}：${item.error.message}`);
    setMessage(`批量同步：${result.accountCount} 个启用账户，成功 ${result.fetchedCount}，失败 ${result.failedCount}${failures.length ? `；${failures.join('；')}` : ''}`);
  });

  return <Panel title="官方账单自动对账（按账期拉取供应商账单接口）" actions={<div className="row-actions">
    <label>账期<input type="month" value={period} onChange={(event) => setPeriod(event.target.value || monthPeriod())} /></label>
    <button type="button" className="secondary-button" onClick={refreshAll}>刷新</button>
  </div>}>
    <Notice tone="info">口径边界：<strong>官方账单</strong>是供应商账单接口按<strong>账期聚合</strong>的金额（不是逐笔明细）；<strong>平台 COMPUTED</strong> 是按「渠道与模型配置 → 上游合同单价」折算的自动估值，<strong>不等于供应商最终账单</strong>；接口不可用或上游不给历史账期时，上一个面板的 <strong>CSV 手工导入保留为兜底</strong>。缺失或未知一律留空、单列，不按 0 参与计算。</Notice>
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {message ? <Notice tone={message.includes('失败') ? 'danger' : 'success'}>{message}</Notice> : null}
    <label>供应商账户<SearchSelect ariaLabel="搜索供应商账户" value={accountId} onChange={setAccountId} options={[{ id: '', name: '全部账户（汇总）' }, ...accountOptions]} placeholder="全部账户（汇总）" searchPlaceholder="搜索账户" /></label>
    {!accountId ? <Notice tone="warning">选择了具体账户才能配置端点与凭据；账户在「供应商账户」面板创建（只存标识 / 渠道 / 币种 / 时区，不存密钥）。</Notice>
      : status.loading || adapters.loading || accounts.loading ? <Loading label="正在读取账单接口配置…" />
        : status.error || adapters.error || accounts.error ? <ErrorState error={status.error || adapters.error || accounts.error} onRetry={refreshAll} />
          : !draft ? <Empty title="读不到这个账户的账单配置" body="重新选择账户，或先在上面刷新一次。" />
            : <>
              <div className="form-grid top-gap">
                <label>账单适配器<select value={draft.adapter} onChange={(event) => setDraft({ ...draft, adapter: event.target.value })}><option value="">未选择（不参与自动拉取）</option>{(adapters.data?.items || []).map((item) => <option key={item.id} value={item.id}>{item.label}（{item.id}）{item.credentialRequired ? ' · 需要凭据' : ''}</option>)}</select></label>
                <label>账单接口地址<input value={draft.endpoint} placeholder="https://.../bill" onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} /></label>
                <label>请求方法<select value={draft.method} onChange={(event) => setDraft({ ...draft, method: event.target.value })}><option value="GET">GET</option><option value="POST">POST</option></select></label>
                <label>账期天数<input type="number" min="1" max="31" value={draft.periodDays} onChange={(event) => setDraft({ ...draft, periodDays: event.target.value })} /></label>
                <label className="checkbox-label"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用自动拉取（定时任务与「立即同步全部」只拉启用中的账户）</label>
              </div>
              <details className="top-gap"><summary>请求头与 JSON 路径映射（高级）</summary>
                <div className="muted">请求头只填<strong>非敏感</strong>字段（例如 x-tenant）；api key / secret / password / token / authorization 这类密钥字段会被后端拒绝——凭据走下面的「接口凭据」。映射示例：{'{'}"itemsPath":"data.items","modelPath":"model","amountPath":"amount","amountScale":"MAJOR","currencyPath":"currency","datePath":"date","filterByPeriod":true{'}'}。</div>
                <label className="top-gap">请求头（JSON）<textarea rows="3" value={draft.headers} onChange={(event) => setDraft({ ...draft, headers: event.target.value })} /></label>
                <label>JSON 路径映射<textarea rows="5" value={draft.mapping} onChange={(event) => setDraft({ ...draft, mapping: event.target.value })} /></label>
              </details>
              <div className="row-actions top-gap"><button type="button" className="primary-button" disabled={busy} onClick={saveConfig}>{busy ? '保存中…' : '保存账单接口配置'}</button><span className="muted">{billing?.adapterLabel || billing?.adapter || '未配置适配器'} · 最近同步 {billing?.lastSyncAt ? formatDate(billing.lastSyncAt) : '从未'}</span></div>
              <div className="card top-gap">
                <div className="row-actions"><strong>接口凭据</strong>{billing?.credentialConfigured ? <span className="status success">已配置</span> : <span className="status warning">未配置</span>}<span className="muted">凭据只提交、不回显：加密存放，任何响应只回「已配置 / 未配置」。</span></div>
                <div className="form-grid"><label>凭据（只提交，不回显）<input type="password" autoComplete="new-password" value={credential} placeholder="留空表示不改动" onChange={(event) => setCredential(event.target.value)} /></label></div>
                <div className="row-actions"><button type="button" className="secondary-button" disabled={busy || !credential.trim()} onClick={setCredentialValue}>保存凭据</button><button type="button" className="danger-button" disabled={busy || !billing?.credentialConfigured} onClick={clearCredential}>清除凭据</button></div>
              </div>
              <div className="row-actions top-gap"><button type="button" className="primary-button" disabled={busy} onClick={syncAccount}>立即同步该账户</button><button type="button" className="secondary-button" disabled={busy} onClick={syncAll}>立即同步全部启用账户</button></div>
              <div className="muted top-gap">同步账期 = {period}（{bounds ? `${bounds.periodStart} ~ ${bounds.periodEnd}` : '未设置'}）；不传账期时按各账户的「账期天数」拉最近一天。上游失败不写半截数据：只留一条 FAILED 快照与错误原文。</div>
              <div className="top-gap"><h4>最近同步状态与失败原因</h4>
                <div className="table-wrap"><table><thead><tr><th>账户</th><th>最近同步</th><th>状态</th><th>失败原因</th><th>凭据</th></tr></thead><tbody>
                  {(status.data?.accounts || []).map((item) => <tr key={item.id}><td><strong>{item.name}</strong><div className="mono muted">{item.code}</div><div className="muted">{item.billing.adapterLabel || item.billing.adapter || '未配置适配器'}{item.billing.enabled ? '' : ' · 未启用'}</div></td><td>{item.billing.lastSyncAt ? formatDate(item.billing.lastSyncAt) : '从未'}</td><td>{item.billing.lastSyncStatus ? <span className={'status ' + (item.billing.lastSyncStatus === 'FETCHED' ? 'success' : 'danger')}>{SNAPSHOT_STATUS[item.billing.lastSyncStatus] || item.billing.lastSyncStatus}</span> : <span className="status">从未同步</span>}</td><td>{item.billing.lastSyncError || '—'}</td><td>{item.billing.credentialConfigured ? <span className="status success">已配置</span> : <span className="status warning">未配置</span>}</td></tr>)}
                </tbody></table></div>
                {!(status.data?.accounts || []).length ? <Empty title="没有读到供应商账户" body="先在「供应商账户」面板创建一个账户。" /> : null}
                <div className="muted top-gap">定时任务：{scheduler.enabled ? (scheduler.running ? '已启用并运行中' : '已启用（未运行）') : '已禁用'} · 间隔 {scheduler.intervalMs ? `${Math.round(Number(scheduler.intervalMs) / 3600000)} 小时` : '未知'} · 上次运行 {scheduler.lastRunAt ? formatDate(scheduler.lastRunAt) : '从未'}{scheduler.lastResult?.error ? ` · 上次异常：${scheduler.lastResult.error}` : ''}</div>
              </div>
            </>}
    <div className="top-gap"><h4>官方账单快照</h4>
      {snapshots.loading ? <Loading label="正在读取官方账单快照…" /> : snapshots.error ? <ErrorState error={snapshots.error} onRetry={snapshots.refresh} /> : snapshots.data?.items?.length ? <div className="table-wrap"><table><thead><tr><th>拉取时间 / 快照</th><th>账户</th><th>适配器</th><th>账期</th><th>状态</th><th>条目 / 合计</th><th>错误</th></tr></thead><tbody>
        {snapshots.data.items.map((item) => <tr key={item.id}><td>{formatDate(item.fetchedAt)}<div className="mono muted">{item.id}</div><div className="muted">{item.source}</div></td><td className="mono">{item.supplierAccountId}</td><td>{item.adapter}</td><td>{formatDate(item.periodStart)}<div className="muted">至 {formatDate(item.periodEnd)}</div></td><td><span className={'status ' + (item.status === 'FETCHED' ? 'success' : 'danger')}>{SNAPSHOT_STATUS[item.status] || item.status}</span></td><td>{item.itemCount} 条<div>{item.totalAmountMinor == null ? missingCell('合计未知（跨币种或失败）') : minorText(item.totalAmountMinor) + (item.currency ? ` ${item.currency}` : '')}</div></td><td>{item.status === 'FETCHED' ? '—' : <>{item.errorCode ? <div className="mono">{item.errorCode}</div> : null}<div>{item.errorMessage || '未记录原因'}</div></>}</td></tr>)}
      </tbody></table></div> : <Empty title="还没有官方账单快照" body="配置端点与凭据后点「立即同步该账户」，或等定时任务按账期自动拉取。" />}
    </div>
    <div className="top-gap"><h4>官方账单 × 平台口径（账期 × 模型）</h4>
      {reconcile.loading ? <Loading label="正在对比官方账单与平台口径…" /> : reconcile.error ? <ErrorState error={reconcile.error} onRetry={reconcile.refresh} /> : <ProviderBillReconciliationTable data={reconcile.data} />}
    </div>
  </Panel>;
}

/**
 * 官方账单对账结果表（账期 × 模型）。单独抽成组件是为了能被守卫直接渲染断言：
 * **缺失 / 未知一律留空**，绝不显示成 0；「严格合计」与「已拿到部分」分开显示。
 */
export function ProviderBillReconciliationTable({ data }) {
  const rows = data?.rows || [];
  const totals = data?.totals || {};
  const coverage = data?.coverage || {};
  const cell = (value, note) => value == null ? missingCell() : <><strong>{minorText(value)}</strong>{note ? <div className="muted">{note}</div> : null}</>;
  const totalCell = (strictValue, presentValue) => strictValue == null
    ? <span className="muted">严格合计留空<div>已拿到部分 {minorText(presentValue)}</div></span>
    : <><strong>{minorText(strictValue)}</strong><div className="muted">已拿到部分 {minorText(presentValue)}</div></>;
  if (!rows.length) return <Empty title="这个账期没有可对账的数据" body="先拉一次官方账单，或确认这个账期有平台调用记录。" />;
  return <>
    <div className="muted">官方快照 {coverage.officialSnapshotCount ?? 0} 份（同账户同账期只认最新一份，被顶掉 {coverage.supersededSnapshotCount ?? 0} 份）· 平台口径币种 {data?.period?.platformCurrency || 'CNY'} · 官方账币种 {(coverage.officialCurrencies || []).join('、') || '—'}{coverage.officialCurrencyMismatch ? <div>官方账单没有本币种的金额，官方列按缺失显示。</div> : null}{coverage.excludedOfficial?.length ? <div>别的币种的官方金额单列（不静默丢弃）：{coverage.excludedOfficial.map((item) => `${item.model || '未标注模型'} ${minorText(item.amountMinor)} ${item.currency}`).join('；')}</div> : null}</div>
    <div className="table-wrap top-gap"><table><thead><tr>{RECONCILE_COLUMNS.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>
      {rows.map((item) => <tr key={item.model || 'unknown'}>
        <td><strong>{item.modelLabel}</strong>{item.inOfficialOnly ? <div className="muted">只在官方账单里</div> : null}{item.inPlatformOnly ? <div className="muted">只在平台口径里</div> : null}<div className="muted">官方 {item.officialRowCount} 行{item.officialQuantity != null ? ` · 用量 ${item.officialQuantity}` : ''}</div></td>
        <td>{item.officialPresent ? cell(item.officialAmountMinor, '供应商接口给的账期聚合') : missingCell('官方账单没有这个模型')}</td>
        <td>{cell(item.computedAmountMinor, `${item.computedCallCount} 笔按合同价折算`)}{item.unknownCostCallCount ? <div className="muted">另有 {item.unknownCostCallCount} 笔成本未知</div> : null}</td>
        <td>{cell(item.estimatedAmountMinor, `${item.estimatedCallCount} 笔配置估算`)}</td>
        <td>{cell(item.reportedAmountMinor, `${item.reportedCallCount} 笔上游报告`)}</td>
        <td>{cell(item.csvSettledAmountMinor, item.csvSettledMatchCount ? `${item.csvSettledMatchCount} 条有效核销` : null)}</td>
        <td>{item.differenceMinor == null ? missingCell('差异不可算') : <><strong>{minorText(item.differenceMinor)}</strong><div className="muted">{item.differenceStatus === 'EXACT' ? '完全一致' : item.differenceStatus === 'OFFICIAL_HIGHER' ? '官方更高' : '官方更低'}</div></>}</td>
        <td className="muted">{DIFFERENCE_REASON[item.differenceReason] || item.differenceReason || '—'}</td>
      </tr>)}
    </tbody><tfoot><tr>
      <td><strong>合计</strong><div className="muted">{totals.modelCount ?? rows.length} 个模型</div><div className="muted">{totals.computedCallCount ?? 0} 笔 COMPUTED · {totals.unknownCostCallCount ?? 0} 笔成本未知</div></td>
      <td>{totalCell(totals.officialAmountMinor, totals.presentSums?.officialAmountMinor)}</td>
      <td>{totalCell(totals.computedAmountMinor, totals.presentSums?.computedAmountMinor)}</td>
      <td>{totalCell(totals.estimatedAmountMinor, totals.presentSums?.estimatedAmountMinor)}</td>
      <td>{totalCell(totals.reportedAmountMinor, totals.presentSums?.reportedAmountMinor)}</td>
      <td>{totalCell(totals.csvSettledAmountMinor, totals.presentSums?.csvSettledAmountMinor)}</td>
      <td>{totalCell(totals.differenceMinor, totals.presentSums?.differenceMinor)}</td>
      <td className="muted">严格合计列留空＝有模型缺失；「已拿到部分」不是全量</td>
    </tr></tfoot></table></div>
    {Object.entries(totals.complete || {}).some(([, complete]) => !complete) ? <div className="muted top-gap">合计不完整的列：{Object.entries(totals.complete || {}).filter(([, complete]) => !complete).map(([key]) => INCOMPLETE_LABEL[key] || key).join('、')}。</div> : null}
    <div className="muted top-gap">缺失单列、不按 0：官方账单没给的模型（{data?.missingInBill?.join('、') || '无'}）；平台没有 COMPUTED 折算的模型（{data?.missingInPlatform?.join('、') || '无'}）。差异只在两侧都有数、且平台没有成本未知的调用时才计算。</div>
  </>;
}

function AccountForm({ api, onCreated }) {
  const [form, setForm] = useState({ code: '', name: '', provider: '', channelId: '', defaultCurrency: 'CNY', timezone: 'UTC' }); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const submit = async (event) => { event.preventDefault(); setBusy(true); setMessage(''); try { await api.post('admin/supplier-billing/accounts', form); setMessage('供应商账户已创建。'); setForm({ code: '', name: '', provider: '', channelId: '', defaultCurrency: 'CNY', timezone: 'UTC' }); onCreated(); } catch (error) { setMessage(error.message); } finally { setBusy(false); } };
  return <form onSubmit={submit}><Notice>账户只保存供应商标识、渠道、币种和时区，禁止填写 API Key、令牌或密码。</Notice>{message ? <Notice tone={message.includes('已创建') ? 'success' : 'danger'}>{message}</Notice> : null}<div className="form-grid"><label>账户代码<input required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} /></label><label>显示名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>供应商 provider<input required value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value })} /></label><label>渠道 ID<input value={form.channelId} onChange={(event) => setForm({ ...form, channelId: event.target.value })} /></label><label>默认币种<input required pattern="[A-Z]{3}" maxLength="3" value={form.defaultCurrency} onChange={(event) => setForm({ ...form, defaultCurrency: event.target.value.toUpperCase() })} /></label><label>时区<input required value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} /></label></div><button className="primary-button" disabled={busy}>{busy ? '创建中…' : '创建账户'}</button></form>;
}

export function SupplierBillsView({ api }) {
  const accounts = useData(() => api.get('admin/supplier-billing/accounts'), [api]); const events = useData(() => api.get('admin/supplier-billing/events?limit=100'), [api]);
  const [accountId, setAccountId] = useState(''); const [csv, setCsv] = useState(''); const [fileName, setFileName] = useState('pasted.csv'); const [preview, setPreview] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const run = async (action) => { setBusy(true); setError(''); try { await action(); } catch (failure) { setError(`${failure.message}${failure.code ? `（${failure.code}）` : ''}${failure.details?.lineNumber ? `，第 ${failure.details.lineNumber} 行` : ''}`); } finally { setBusy(false); } };
  const downloadTemplate = () => run(async () => { const result = await api.get('admin/supplier-billing/template'); downloadCsv('supplier-billing-canonical-v1.csv', result.content); });
  const previewCsv = () => run(async () => setPreview(await api.post('admin/supplier-billing/imports/preview', { csv })));
  const importCsv = () => run(async () => { await api.post('admin/supplier-billing/imports', { supplierAccountId: accountId, fileName, csv: preview.canonicalCsv }); setPreview(null); setCsv(''); events.refresh(); });
  const readFile = async (event) => { const file = event.target.files?.[0]; if (!file) return; setFileName(file.name); setCsv(await file.text()); setPreview(null); setError(''); };
  const history = (events.data?.items || []).filter((item) => ['IMPORT', 'IMPORT_CANCEL'].includes(item.action));
  return <><div className="split"><Panel title="供应商账户">
    <Notice>这里是 CSV 兜底路径：运营把供应商账单文件导进来核销。想直接按账期从供应商账单接口拉官方数字，用下面「官方账单自动对账」区块；账户本身两边共用（只存标识 / 渠道 / 币种 / 时区，不存 API Key）。</Notice>
    <AccountForm api={api} onCreated={accounts.refresh} />{accounts.data?.items?.length ? <div className="table-wrap top-gap"><table><thead><tr><th>账户</th><th>供应商</th><th>默认币种</th></tr></thead><tbody>{accounts.data.items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><div className="mono muted">{item.code}</div></td><td>{item.provider}<div className="muted">{item.channelId || '未绑定渠道'}</div></td><td>{item.defaultCurrency} · {item.timezone}</td></tr>)}</tbody></table></div> : null}</Panel><Panel title="导入供应商账单" actions={<button type="button" className="secondary-button" onClick={downloadTemplate}>下载 canonical CSV 模板</button>}>{error ? <Notice tone="danger">{error}</Notice> : null}<label>供应商账户<SearchSelect ariaLabel="搜索供应商账户" value={accountId} onChange={setAccountId} options={accounts.data?.items || []} placeholder="选择账户" searchPlaceholder="搜索账户" /></label><label>读取 CSV 文件<input type="file" accept=".csv,text/csv" onChange={readFile} /></label><label>或粘贴 canonical CSV<textarea rows="9" value={csv} onChange={(event) => { setCsv(event.target.value); setPreview(null); }} /></label><div className="row-actions"><button type="button" className="secondary-button" disabled={busy || !csv} onClick={previewCsv}>严格校验并预览</button><button type="button" className="primary-button" disabled={busy || !accountId || !preview} onClick={importCsv}>确认导入</button></div></Panel></div><ProviderBillReconciliationBlock api={api} />{preview ? <Panel title="导入预览"><Notice tone="success">校验通过：{preview.lineCount} 行，文件哈希 {preview.fileHash}</Notice><div className="table-wrap"><table><thead><tr><th>行</th><th>账单行</th><th>类型</th><th>时间</th><th>金额</th><th>匹配证据</th></tr></thead><tbody>{preview.lines.slice(0, 100).map((item) => <tr key={item.lineId}><td>{item.lineNumber}</td><td>{item.invoiceId}<div className="mono muted">{item.lineId}</div></td><td>{item.lineType}</td><td>{formatDate(item.occurredAt)}</td><td>{money(item.amountMinor, item.currency)}</td><td className="mono">{Object.values(item.identifiers).filter(Boolean).join(' / ') || '无'}</td></tr>)}</tbody></table></div></Panel> : null}<Panel title="导入历史">{events.loading ? <Loading /> : history.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>动作</th><th>导入 ID</th><th>行数</th><th>原因</th></tr></thead><tbody>{history.map((item) => <tr key={item.id}><td>{formatDate(item.createdAt)}</td><td>{item.action}</td><td className="mono">{item.importId}</td><td>{item.after?.lineCount ?? '—'}</td><td>{item.reason || '—'}</td></tr>)}</tbody></table></div> : <Empty title="暂无导入历史" />}</Panel></>;
}

function MatchEditor({ api, line, onDone }) {
  const candidates = useData(() => api.get(`admin/supplier-billing/lines/${line.id}/candidates`), [api, line.id]); const [allocations, setAllocations] = useState([]); const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const items = candidates.data?.items || [];
  const toggle = (candidate) => setAllocations((current) => current.some((item) => item.targetType === candidate.targetType && item.targetId === candidate.targetId) ? current.filter((item) => item.targetType !== candidate.targetType || item.targetId !== candidate.targetId) : [...current, { targetType: candidate.targetType, targetId: candidate.targetId, amountMinor: '' }]);
  const updateAmount = (candidate, value) => setAllocations((current) => current.map((item) => item.targetType === candidate.targetType && item.targetId === candidate.targetId ? { ...item, amountMinor: value } : item));
  const submit = async () => { setBusy(true); setError(''); try { await api.post(`admin/supplier-billing/lines/${line.id}/matches`, { reason: reason.trim(), allocations: allocations.map((item) => ({ ...item, amountMinor: Number(item.amountMinor) })) }); onDone(); } catch (failure) { setError(failure.message); } finally { setBusy(false); } };
  return <div className="match-editor">{error ? <Notice tone="danger">{error}</Notice> : null}{candidates.loading ? <Loading label="正在读取候选…" /> : candidates.error ? <ErrorState error={candidates.error} onRetry={candidates.refresh} /> : items.length ? items.map((item) => { const selected = allocations.find((value) => value.targetType === item.targetType && value.targetId === item.targetId); return <div className="candidate-row" key={`${item.targetType}:${item.targetId}`}><label className="checkbox-label"><input type="checkbox" checked={Boolean(selected)} onChange={() => toggle(item)} /><span><strong>{item.model || item.targetType}</strong><span className="mono muted">{item.targetId}</span><span className="muted">{item.organizationName || item.orgId || '未归属'} · {item.studentName || item.studentId || '未归属学生'} · {formatDate(item.occurredAt || item.createdAt)}</span><span className="mono muted">账户 {item.providerAccountRef || '未记录'} · 请求 {item.evidence?.responseRequestId || item.evidence?.clientRequestId || item.evidence?.callId || '无'}</span></span></label>{selected ? <label>分摊金额（最小单位）<input type="number" required max={line.amountMinor < 0 ? -1 : undefined} min={line.amountMinor > 0 ? 1 : undefined} value={selected.amountMinor} onChange={(event) => updateAmount(item, event.target.value)} /><span className="muted">{line.amountMinor < 0 ? '退款/贷项必须填写负数' : '用正整数填写本次分摊'}</span></label> : null}</div>; }) : <Empty title="没有可用候选" body="该账单行缺少可精确关联的请求证据。" />}<label>操作原因<textarea required rows="2" value={reason} onChange={(event) => setReason(event.target.value)} /></label><button type="button" className="primary-button" disabled={busy || !reason.trim() || !allocations.length || allocations.some((item) => !Number.isSafeInteger(Number(item.amountMinor)) || Number(item.amountMinor) === 0 || Math.sign(Number(item.amountMinor)) !== Math.sign(line.amountMinor))} onClick={submit}>确认人工匹配{allocations.length > 1 ? '并拆分' : ''}</button></div>;
}

function ReconcileActionDialog({ action, onClose, onComplete, api }) {
  const ref = useRef(null); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  const submit = async (event) => {
    event.preventDefault(); if (!reason.trim() || busy) return; setBusy(true); setError('');
    try {
      if (action.kind === 'cancel-match') await api.post(`admin/supplier-billing/matches/${action.match.id}/cancel`, { reason: reason.trim() });
      else await api.post(`admin/supplier-billing/lines/${action.line.id}/${action.kind}`, { reason: reason.trim() });
      onComplete();
    } catch (failure) { setError(failure.message || '操作失败，请重试。'); setBusy(false); }
  };
  const title = action.kind === 'cancel-match' ? '取消匹配' : action.kind === 'exclude' ? '排除' : action.kind === 'dispute' ? '标记争议' : '取消账单行';
  return <dialog ref={ref} className="admin-confirm" aria-labelledby="reconcile-action-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}><form onSubmit={submit}><h2 id="reconcile-action-title">{title}</h2><p>{action.kind === 'cancel-match' ? `将取消 ${action.match.targetType} ${action.match.targetId} 的分摊 ${money(action.match.allocatedAmountMinor, action.match.currency)}。` : `账单行 ${action.line.lineId}，金额 ${money(action.line.amountMinor, action.line.currency)}。`}</p><label>操作原因<textarea autoFocus required rows="3" maxLength="1000" value={reason} onChange={(event) => setReason(event.target.value)} /></label>{error ? <Notice tone="danger">{error}</Notice> : null}<div className="row-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !reason.trim()}>{busy ? '处理中…' : `确认${title}`}</button></div></form></dialog>;
}

export function MatchingView({ api }) {
  const accounts = useData(() => api.get('admin/supplier-billing/accounts'), [api]);
  const [accountId, setAccountId] = useState(''); const [status, setStatus] = useState('UNMATCHED'); const [offset, setOffset] = useState(0); const [editing, setEditing] = useState('');
  const [actionDialog, setActionDialog] = useState(null);
  const query = asQuery({ supplierAccountId: accountId, status, limit: 50, offset }).toString(); const lines = useData(() => api.get(`admin/supplier-billing/lines?${query}`), [api, query]);
  return <>{actionDialog ? <ReconcileActionDialog action={actionDialog} api={api} onClose={() => setActionDialog(null)} onComplete={() => { setActionDialog(null); lines.refresh(); }} /> : null}<Panel title="匹配与核销筛选"><div className="financial-filters"><label>供应商账户<SearchSelect ariaLabel="搜索供应商账户" value={accountId} onChange={(value) => { setAccountId(value); setOffset(0); }} options={[{ id: '', name: '全部账户' }, ...(accounts.data?.items || [])]} placeholder="全部账户" /></label><label>核销状态<select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}><option value="">全部状态</option>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div></Panel><Panel title="供应商账单行">{lines.loading ? <Loading label="正在读取核销记录…" /> : lines.error ? <ErrorState error={lines.error} onRetry={lines.refresh} /> : lines.data?.items?.length ? <><div className="table-wrap"><table><thead><tr><th>账单行</th><th>类型 / 金额</th><th>状态</th><th>匹配</th><th>操作</th></tr></thead><tbody>{lines.data.items.map((line) => <tr key={line.id}><td>{line.invoiceId}<div className="mono muted">{line.lineId}</div><div className="muted">{formatDate(line.occurredAt)}</div></td><td>{line.lineType}<div><strong>{money(line.amountMinor, line.currency)}</strong></div></td><td><Status value={line.reconciliationStatus} /><div className="muted">候选 {line.candidateCount} · {line.comparisonStatus}</div></td><td>{line.matches.length ? line.matches.map((match) => <div key={match.id}><span className="mono">{match.targetType} {match.targetId}</span> · {money(match.allocatedAmountMinor, match.currency)} <button type="button" className="text-button" onClick={() => setActionDialog({ kind: 'cancel-match', line, match })}>取消</button></div>) : <span className="muted">未匹配</span>}</td><td><div className="row-actions"><button type="button" className="secondary-button" onClick={() => setEditing(editing === line.id ? '' : line.id)}>{editing === line.id ? '收起' : '选择候选 / 拆分'}</button><button type="button" className="text-button" onClick={() => setActionDialog({ kind: 'exclude', line })}>排除</button><button type="button" className="text-button" onClick={() => setActionDialog({ kind: 'dispute', line })}>争议</button><button type="button" className="danger-button" onClick={() => setActionDialog({ kind: 'cancel', line })}>取消</button></div>{editing === line.id ? <MatchEditor api={api} line={line} onDone={() => { setEditing(''); lines.refresh(); }} /> : null}</td></tr>)}</tbody></table></div><div className="row-actions top-gap"><button type="button" className="secondary-button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><span className="muted">{offset + 1}–{Math.min(offset + 50, lines.data.total)} / {lines.data.total}</span><button type="button" className="secondary-button" disabled={offset + 50 >= lines.data.total} onClick={() => setOffset(offset + 50)}>下一页</button></div></> : <Empty title="当前筛选没有账单行" />}</Panel></>;
}

export function MarginView({ api }) {
  const options = useData(() => api.get('admin/financial-reporting/options'), [api]); const [filters, setFilters] = useState(EMPTY_FILTERS); const query = useMemo(() => asQuery(filters).toString(), [filters]); const report = useData(() => api.get(`admin/financial-reporting/summary?${query}`), [api, query]);
  const update = (key, value) => setFilters((current) => ({ ...current, [key]: value, ...(key === 'orgId' ? { studentId: '', sessionId: '' } : {}), ...(key === 'seriesId' ? { lessonId: '', sessionId: '' } : {}) }));
  const exportCsv = () => { const header = ['机构','机构ID','币种','机构购买实收','许可确认收入','结算成本','真实毛利']; const data = (report.data?.rows || []).map((item) => [item.organizationName,item.orgId,item.currency,item.cashReceivedMinor,item.recognizedRevenueMinor,item.settledCostMinor,item.grossProfitMinor]); downloadCsv('financial-reconciliation.csv', [header, ...data].map((line) => line.map(safeCell).join(',')).join('\r\n')); };
  const summary = report.data?.summary || {};
  return <><Notice>真实毛利 = 许可确认收入 − 已匹配供应商结算成本。仅同币种可比；未选择币种且结果包含多币种时，汇总留空。估算成本不进入本报表。</Notice><Panel title="三账对照筛选" actions={<button type="button" className="secondary-button" disabled={!report.data?.rows?.length} onClick={exportCsv}>导出 CSV</button>}><FilterBar options={options.data || {}} filters={filters} onChange={update} includeCurrency marginOnly /></Panel><div className="metrics"><MetricCard label="机构购买实收" value={money(summary.cashReceivedMinor, summary.currency)} hint="仅 PAID 真实成交批次" /><MetricCard label="许可确认收入" value={money(summary.recognizedRevenueMinor, summary.currency)} hint="发放与冲销不可变事件" /><MetricCard label="结算成本" value={money(summary.settledCostMinor, summary.currency)} hint="仅有效供应商匹配" tone="orange" /><MetricCard label="未核销" value={money(summary.unreconciledMinor, summary.currency)} hint="未匹配、部分、歧义与争议" tone="pink" /><MetricCard label="真实毛利" value={money(summary.grossProfitMinor, summary.currency)} hint="同币种且收入已知才计算" tone="teal" /></div><Panel title="机构三账明细">{report.loading || options.loading ? <Loading label="正在计算三账对照…" /> : report.error ? <ErrorState error={report.error} onRetry={report.refresh} /> : report.data?.rows?.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>币种</th><th>购买实收</th><th>确认收入</th><th>结算成本</th><th>未决敞口</th><th>真实毛利</th><th>数据状态</th></tr></thead><tbody>{report.data.rows.map((item) => <tr key={`${item.orgId}:${item.currency}`}><td><strong>{item.organizationName}</strong><div className="mono muted">{item.orgId || '未归属'}</div></td><td>{item.currency || '未知'}</td><td>{money(item.cashReceivedMinor, item.currency)}</td><td>{money(item.recognizedRevenueMinor, item.currency)}</td><td>{money(item.settledCostMinor, item.currency)}</td><td>{money(item.pendingExposureMinor, item.currency)}</td><td><strong>{money(item.grossProfitMinor, item.currency)}</strong></td><td>{item.unknownRevenueEvents || !item.supplierRowsComplete ? <Status value="UNKNOWN" /> : <Status value="KNOWN" />}<div className="muted">许可 {item.recognizedQuantity || 0} 次 · 匹配 {item.settledMatchCount || 0} 条</div></td></tr>)}</tbody></table></div> : <Empty title="当前筛选没有可对照的财务事实" />}</Panel></>;
}

export function FinancialReconciliation({ api, view }) {
  if (view === 'bills') return <SupplierBillsView api={api} />;
  if (view === 'matching') return <MatchingView api={api} />;
  if (view === 'margin') return <MarginView api={api} />;
  return <CallLedgerView api={api} />;
}
