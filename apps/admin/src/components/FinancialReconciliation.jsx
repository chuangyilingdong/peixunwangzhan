// 「用量与成本」页的三个视图（2026-09-13 起）：调用账 / 两账与毛利（机构与学员在 BillingPanels.jsx）。
//
// 2026-09-18 减法（用户口径「供应商账单两条线整体下线」「必须做大量的减法」）：
//   删掉 SupplierBillsView（CSV 手工导入 + 供应商账户 + 导入历史）、MatchingView（匹配与核销 + 人工拆分 + 争议/排除/取消）、
//   ProviderBillReconciliationBlock 与 ProviderBillReconciliationTable（官方账单接口按账期拉取 + 账期×模型对账表）。
//   理由：我们上游（Seedance 直连、DeepSeek）是逐笔回实扣金额，成本在调用时就已记进 compute_attempts，
//   CSV 导入与账单接口那两条线**永远是空的**（页面自己都写着「通常不需要配」）。真要对账就用
//   「实测单价 vs 合同单价」（调用账里的上游成本列），不需要再维护两套账、6 张表、2 套路由。
//
// 2026-09-18 第二版对齐（用户口径：「三账」→「两账」，第二本账的数据源换成 compute_attempts.upstream_cost_fen）：
//   平台只有**两本账** —— ① 对外售价（只进统计，不扣学生）② 上游成本（compute_attempts 逐笔成本）。
//   两者互为独立配置，差额只在对账时算。**接口调用与后端响应键名一个都没动**（settledAmountMinor 等
//   字段名沿用，语义已变成「上游成本」；settledAmountMinor 恒等于 knownUpstreamCostMinor），
//   所以这里只改文案与列：把重复的列合并、把「结算 / 核销」这套已经不存在的动作词换成「上游成本 / 成本未知」。
import { useMemo, useState } from 'react';
import { Empty, ErrorState, formatDate, Loading, MetricCard, Notice, Panel, Pagination, SearchSelect, Status, useData } from '@platform/shared';
import { downloadCsv } from '../shared.jsx';

const EMPTY_FILTERS = { days: '30', orgId: '', studentId: '', seriesId: '', sessionId: '', lessonId: '', model: '', channelId: '', currency: '' };
const money = (minor, currency) => minor == null || !currency ? '未知' : `${(Number(minor) / 100).toFixed(2)} ${currency}`;
// 金额单位是「分」，展示时换算成元。
// ⚠️ 逐笔折算出来的成本**可以是小数分**（2026-09-15：DeepSeek 一次课堂对话约 0.2~0.4 分），
// 所以不能一律 toFixed(2) —— 那会把 0.37 分显示成 0.00，看起来像没记账（数字其实是对的）。
// 规则：整数分按 2 位显示；带小数分的按 4 位显示，把那部分露出来。
const hasSubFen = (value) => Math.abs(Number(value) - Math.round(Number(value))) > 1e-9;
export const minorText = (value) => value == null ? '未知' : (Number(value) / 100).toFixed(hasSubFen(value) ? 4 : 2);
const SALE_SOURCE = { SNAPSHOT: '快照价', PRICING: '当前配置价', UNKNOWN: '未知' };
// 上游成本来源（P90）。COMPUTED = 按渠道「上游合同单价」折算出来的成本；它不等于供应商最终账单。
// 2026-09-18：这几种来源现在**都算进「上游成本」这一本账**，不再区分「估值 / 已结算」——上游成本本身就可能
// 是 ESTIMATED / REPORTED，所以旧文案「估算成本不计入结算成本」不再成立，已删。
const UPSTREAM_SOURCE = { COMPUTED: 'COMPUTED 按合同价折算', REPORTED: 'REPORTED 上游报告', ESTIMATED: 'ESTIMATED 配置估算', MOCK: 'MOCK 本地模拟（不计费）', UNKNOWN: 'UNKNOWN 未知' };
const UPSTREAM_SOURCE_HINT = { COMPUTED: '按合同单价自动折算', REPORTED: '上游回执', ESTIMATED: '配置估算', MOCK: '本地模拟，未产生上游费用', UNKNOWN: '缺用量或缺单价，只计笔数、不并入金额' };
// 折算用了哪一层价（P90）：MODEL = 模型级覆盖，MODALITY = 渠道的本渠道共用价（素材类型价）。
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
// 2026-09-18：两账合并列 —— 原来「已知上游成本」「已结算」「未结算笔数」三列里，
// 后两个分别恒等于第一个与「另有 N 笔成本未知」（后端 settledAmountMinor 恒等于 knownUpstreamCostMinor、
// unsettledCount 恒等于 upstreamUnknownCount），并排显示就是同一堆数字看三遍。现在只留一列「上游成本」，
// 未知笔数作为它下面的一行小字。
const SUMMARY_COLUMNS = ['维度', '调用次数', '对外金额', '上游成本', '差额'];

function CallSummaryBlock({ api, query }) {
  const [dimension, setDimension] = useState('modality');
  const summary = useData(() => api.get(`admin/financial-reporting/call-summary?${query}`), [api, query]);
  const rows = summary.data?.groups?.[dimension] || [];
  return <Panel title="对外售价与上游成本对照汇总" actions={<div className="row-actions">{CALL_DIMENSIONS.map(([key, label]) => <button key={key} type="button" className={dimension === key ? 'primary-button' : 'secondary-button'} aria-pressed={dimension === key} onClick={() => setDimension(key)}>{label}汇总</button>)}</div>}>
    <Notice tone="info">平台只有<strong>两本账</strong>，禁止混读：① <strong>对外售价</strong>（本次快照价，无快照回退当前配置并标注来源；仅观测，<strong>不扣学生、不计收入</strong>）② <strong>上游成本</strong>（每次调用逐笔记录的成本：COMPUTED 按合同价折算 / REPORTED 上游报告 / ESTIMATED 配置估算，<strong>不等于供应商最终账单</strong>；缺用量或缺单价即 UNKNOWN，只计笔数、金额一律留空）。两本账<strong>互为独立配置</strong>（改价不影响成本、改成本也不追改已记录的售价），<strong>差额只在对账时算</strong>；未知金额一律单列，绝不按 0 处理。</Notice>
    {summary.loading ? <Loading label="正在汇总对外售价…" /> : summary.error ? <ErrorState error={summary.error} onRetry={summary.refresh} /> : rows.length ? <div className="table-wrap"><table><thead><tr>{SUMMARY_COLUMNS.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((item) => <tr key={item.key || 'unknown'}><td><strong>{item.label}</strong>{item.currency ? <div className="muted">成本币种 {item.currency}</div> : null}</td><td>{item.calls}</td><td>{minorText(item.externalAmountMinor)}{item.saleUnknownCount ? <div className="muted">另有 {item.saleUnknownCount} 笔对外价未知</div> : null}</td><td>{minorText(item.knownUpstreamCostMinor)}{item.upstreamUnknownCount ? <div className="muted">另有 {item.upstreamUnknownCount} 笔成本未知</div> : null}</td><td>{item.differenceMinor == null ? <span className="muted">成本未知 / 未知</span> : <strong>{minorText(item.differenceMinor)}</strong>}</td></tr>)}</tbody></table></div> : <Empty title="当前筛选没有可汇总的调用" />}
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
    <Notice>平台只有<strong>两本账</strong>：<strong>对外售价</strong>与<strong>上游成本</strong>。上游成本是每次调用的逐笔成本（COMPUTED 按渠道合同单价自动折算 / REPORTED 上游报告 / ESTIMATED 配置估算），<strong>仍是估值、不等于供应商最终账单</strong>；缺用量或缺单价时保持未知，绝不按 0 计。对外售价不扣学生、不计收入；差额只是这两本账相减，不构成任何扣款。上游成本按人民币分记账（CNY）。</Notice>
    <Panel title="调用账筛选"><FilterBar options={options.data || {}} filters={filters} onChange={update} /><div className="financial-filters top-gap"><label>调用状态<select value={filters.status} onChange={(event) => update('status', event.target.value)}><option value="">全部状态</option><option value="SUCCESS">成功</option><option value="FAILED">失败</option><option value="RUNNING">处理中</option></select></label><label>证据状态<select value={filters.evidenceMatch} onChange={(event) => update('evidenceMatch', event.target.value)}><option value="">全部证据</option><option value="MATCHED">完整</option><option value="PARTIAL">部分</option><option value="UNMATCHED">缺失</option></select></label></div></Panel>
    <CallSummaryBlock api={api} query={filterQuery} />
    {/* 2026-09-18：原「上游计费（来源 / 用量证据）」与「已结算」两列现在是**同一个数**
        （后端 settledAmountMinor 恒等于上游成本，也就是本列读的 estimatedOrReportedMinor），
        并排显示等于把同一个数印两遍 → 合并成一列「上游成本（来源 / 用量证据）」，来源与用量证据全部保留。 */}
    <Panel title="调用账">{report.loading || options.loading ? <Loading label="正在读取调用账…" /> : report.error ? <ErrorState error={report.error} onRetry={report.refresh} /> : report.data?.items?.length ? <><div className="table-wrap"><table><thead><tr><th>时间 / 请求 ID</th><th>机构 / 学生</th><th>模型 / 渠道</th><th>状态</th><th>对外售价</th><th>上游成本（来源 / 用量证据）</th><th>差额</th></tr></thead><tbody>{report.data.items.map((item) => <tr key={item.id}><td>{formatDate(item.createdAt)}<div className="mono muted">{item.clientRequestId || item.responseRequestId || item.callId}</div><details><summary>全部证据</summary><div className="mono muted">attempt: {item.id}<br />usage: {item.usageId || '无'}<br />task: {item.taskId || '无'}<br />gateway: {item.gatewayLogId || '无'}</div></details></td><td><strong>{item.organizationName || item.orgId || '未归属'}</strong><div className="muted">{item.studentName || item.userId || '未归属'}</div></td><td>{item.model || '未知模型'}<div className="muted">{item.actualChannelId || item.channelId || '未知渠道'} · {item.modality}</div></td><td><Status value={item.status} /><div className="muted">证据：{item.evidenceMatch}</div></td><td>{item.salePriceFen == null ? <span className="muted">未知</span> : <strong>{minorText(item.salePriceFen)}</strong>}<div className="muted">来源：{SALE_SOURCE[item.salePriceSource] || item.salePriceSource}，不扣学生不计收入</div></td><td>{item.costUnknown ? <span className="muted">成本未知</span> : <strong>{minorText(item.estimatedOrReportedMinor)}</strong>}<div className="muted">{UPSTREAM_SOURCE[item.costSource] || item.costSource || 'UNKNOWN'} · {UPSTREAM_SOURCE_HINT[item.costSource] || '不作实际成本'}</div>{item.costRuleSnapshot?.priceLevel ? <div className="muted">价目层级：{item.costRuleSnapshot.priceLevel}{PRICE_LEVEL[item.costRuleSnapshot.priceLevel] ? `（${PRICE_LEVEL[item.costRuleSnapshot.priceLevel]}）` : ''}</div> : null}<div className="muted">{usageEvidenceText(item.usageSnapshot)}</div></td><td>{item.differenceMinor == null ? <span className="muted">成本未知 / 未知</span> : <strong>{minorText(item.differenceMinor)}</strong>}<div className="muted">对外售价 − 上游成本</div></td></tr>)}</tbody></table></div><Pagination page={report.data.page} totalPages={report.data.totalPages} onChange={setPage} disabled={report.loading} /></> : <Empty title="当前筛选没有调用记录" />}</Panel>
  </>;
}

export function MarginView({ api }) {
  const options = useData(() => api.get('admin/financial-reporting/options'), [api]); const [filters, setFilters] = useState(EMPTY_FILTERS); const query = useMemo(() => asQuery(filters).toString(), [filters]); const report = useData(() => api.get(`admin/financial-reporting/summary?${query}`), [api, query]);
  const update = (key, value) => setFilters((current) => ({ ...current, [key]: value, ...(key === 'orgId' ? { studentId: '', sessionId: '' } : {}), ...(key === 'seriesId' ? { lessonId: '', sessionId: '' } : {}) }));
  const exportCsv = () => { const header = ['机构','机构ID','币种','机构购买实收','许可确认收入','上游成本','成本未知笔数','真实毛利']; const data = (report.data?.rows || []).map((item) => [item.organizationName,item.orgId,item.currency,item.cashReceivedMinor,item.recognizedRevenueMinor,item.settledCostMinor,item.costUnknownCallCount,item.grossProfitMinor]); downloadCsv('financial-reconciliation.csv', [header, ...data].map((line) => line.map(safeCell).join(',')).join('\r\n')); };
  const summary = report.data?.summary || {};
  // 2026-09-18 两账口径：平台只有两本账 —— 对外售价（只进统计）与上游成本（compute_attempts 逐笔成本）。
  // 两者互为独立配置，差额只在对账时算；本屏把成本与机构收入侧并排看毛利。
  // 「估算成本不进入本报表」这句已删：上游成本本身就可能是 ESTIMATED / REPORTED（后端 basis.estimatesExcluded=false）。
  return <><Notice>平台只有<strong>两本账</strong>：<strong>对外售价</strong>与<strong>上游成本</strong>。两者<strong>互为独立配置</strong>（改价不影响成本、改成本也不追改已记录的售价），<strong>差额只在对账时算</strong>（看「调用账」）。真实毛利 = 许可确认收入 − 上游成本；仅同币种可比，未选择币种且结果包含多币种时汇总留空。上游成本来自每次调用的逐笔记录，可能是按合同价折算 / 上游报告 / 配置估算 —— 不等于供应商最终账单。</Notice><Panel title="两账对照筛选" actions={<button type="button" className="secondary-button" disabled={!report.data?.rows?.length} onClick={exportCsv}>导出 CSV</button>}><FilterBar options={options.data || {}} filters={filters} onChange={update} includeCurrency marginOnly /></Panel><div className="metrics"><MetricCard label="机构购买实收" value={money(summary.cashReceivedMinor, summary.currency)} hint="仅 PAID 真实成交批次" /><MetricCard label="许可确认收入" value={money(summary.recognizedRevenueMinor, summary.currency)} hint="发放与冲销不可变事件" /><MetricCard label="上游成本" value={money(summary.settledCostMinor, summary.currency)} hint="逐笔成本合计；有成本未知就留空" tone="orange" /><MetricCard label="成本未知" value={`${summary.costUnknownCallCount || 0} 笔`} hint="成本未知的调用只计数，金额一律留空" tone="pink" /><MetricCard label="真实毛利" value={money(summary.grossProfitMinor, summary.currency)} hint="同币种、收入与成本都已知才计算" tone="teal" /></div><Panel title="机构两账明细">{report.loading || options.loading ? <Loading label="正在计算两账对照…" /> : report.error ? <ErrorState error={report.error} onRetry={report.refresh} /> : report.data?.rows?.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>币种</th><th>购买实收</th><th>确认收入</th><th>上游成本</th><th>成本未知</th><th>真实毛利</th><th>数据状态</th></tr></thead><tbody>{report.data.rows.map((item) => <tr key={`${item.orgId}:${item.currency}`}><td><strong>{item.organizationName}</strong><div className="mono muted">{item.orgId || '未归属'}</div></td><td>{item.currency || '未知'}</td><td>{money(item.cashReceivedMinor, item.currency)}</td><td>{money(item.recognizedRevenueMinor, item.currency)}</td><td>{money(item.settledCostMinor, item.currency)}</td><td>{item.costUnknownCallCount ? <strong>{item.costUnknownCallCount} 笔</strong> : <span className="muted">无</span>}<div className="muted">金额不可知，不按 0 计</div></td><td><strong>{money(item.grossProfitMinor, item.currency)}</strong></td><td>{item.unknownRevenueEvents || !item.supplierRowsComplete ? <Status value="UNKNOWN" /> : <Status value="KNOWN" />}<div className="muted">许可 {item.recognizedQuantity || 0} 次 · 有成本 {item.settledMatchCount || 0} 笔</div></td></tr>)}</tbody></table></div> : <Empty title="当前筛选没有可对照的财务事实" />}</Panel></>;
}

export function FinancialReconciliation({ api, view }) {
  if (view === 'margin') return <MarginView api={api} />;
  return <CallLedgerView api={api} />;
}
