// P03-04 授权次数变更记录（图8）（2026-09-18 按线框图对齐）。
//
// 数据来源（服务端已按交接文档的契约实现，字段名以 services/courseQuotaLedger.js 的
// normalizeQuotaChange 为准）：
//   GET /api/admin/organizations/:id/course-quota-changes?seriesId&changeType&from&to&page&limit
//   每条含：changeType（INITIAL_OPEN|ADD|REDUCE|GRANT_CONSUME|GRANT_REFUND）、delta、
//           quotaTotalBefore/After、quotaUsedBefore/After、seriesTitle、actorName、reason、createdAt
//   额外返回：seriesOptions（有过变更的课包，给「课包」下拉直接用）、changeTypes。
//   ⚠️ 时间约定与服务端一致：`from` 含、`to` **不含**（同 audit-logs）；界面填的是日期，
//      所以发请求前把「结束日期」+1 天，用户选「到 9 月 18 日」才真的含 18 号。
//
// 线框图没说清、这里按用户口径补的一处（已写在界面上）：线框图只画了「变更前/后总授权次数」，
//   但「授权消耗 / 授权取消返还」这两类**总授权次数不变**（totalBefore === totalAfter），
//   变的是「已授权次数」——所以本页额外显示变更前后的已授权次数，否则用户只会看到 321 → 321 一头雾水。
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Empty, ErrorState, formatDate, Loading, ListResultSummary, Notice, PageHeader, Panel, Pagination, useData } from '@platform/shared';
import { OrganizationCard } from '../components/OrganizationShared.jsx';

/** 5 种变更类型的中文名（服务端枚举固定，别在前端另造词）。 */
export const CHANGE_TYPE_LABELS = {
  INITIAL_OPEN: '初始开通',
  ADD: '增加授权次数',
  REDUCE: '减少授权次数',
  GRANT_CONSUME: '授权消耗',
  GRANT_REFUND: '授权取消返还',
};

function changeTypeTone(type) {
  if (type === 'ADD' || type === 'INITIAL_OPEN') return 'status success';
  if (type === 'REDUCE') return 'status warning';
  return 'status';
}

/** 变更值带正负号：delta > 0 → +N，delta < 0 → -N（服务端给的 delta 已带符号）。 */
function formatDelta(delta) {
  const value = Number(delta || 0);
  return value > 0 ? `+${value}` : String(value);
}

/** 课包名 / 操作人：服务端 normalizeQuotaChange 给的键名（seriesTitle / actorName，兜底 actorLogin）。 */
function changeTitle(row) {
  return row?.seriesTitle || row?.title || '—';
}

function changeActor(row) {
  return row?.actorName || row?.actorLogin || '—';
}

export function OrganizationQuotaChanges({ api }) {
  const { orgId = '' } = useParams();
  const navigate = useNavigate();
  const detail = useData(() => (orgId ? api.get(`admin/organizations/${encodeURIComponent(orgId)}/detail`) : Promise.resolve(null)), [api, orgId]);
  const [draft, setDraft] = useState({ seriesId: '', changeType: '', from: '', to: '' });
  const [applied, setApplied] = useState({ seriesId: '', changeType: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (applied.seriesId) params.set('seriesId', applied.seriesId);
    if (applied.changeType) params.set('changeType', applied.changeType);
    // 时间范围：界面给的是「日期」（用户想的是整天含头含尾），而服务端是 from 含 / to **不含**
    // （与 audit-logs 同一套约定），所以这里把结束日期 +1 天再发过去，否则「选到今天」会漏掉今天的记录。
    if (applied.from) params.set('from', `${applied.from}T00:00:00.000Z`);
    if (applied.to) {
      const end = new Date(`${applied.to}T00:00:00.000Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      params.set('to', end.toISOString());
    }
    params.set('page', String(page)); params.set('limit', String(limit));
    return params;
  }, [applied, page, limit]);
  const changes = useData(() => (orgId ? api.get(`admin/organizations/${encodeURIComponent(orgId)}/course-quota-changes?${query.toString()}`) : Promise.resolve(null)), [api, orgId, query]);
  const organization = detail.data?.organization || null;
  const assignments = detail.data?.courseAssignments || [];
  // 列表接口的返回形状按仓库惯例是 { items, total, page, totalPages }；这里同时兼容裸数组。
  const payload = changes.data;
  const items = Array.isArray(payload) ? payload : (payload?.items || []);
  const total = Array.isArray(payload) ? items.length : (payload?.total ?? items.length);
  const totalPages = Array.isArray(payload) ? 1 : (payload?.totalPages ?? 1);
  const currentPage = Array.isArray(payload) ? 1 : (payload?.page ?? page);
  // 课包下拉：优先用列表接口给的 seriesOptions（只列真有变更的课包），没有就用该机构已开通的课包。
  const seriesOptions = Array.isArray(payload?.seriesOptions) && payload.seriesOptions.length
    ? payload.seriesOptions
    : assignments.map((item) => ({ id: item.seriesId, title: item.title }));
  const rangeInvalid = Boolean(applied.from && applied.to && applied.from > applied.to);

  function submitFilters(event) {
    event.preventDefault();
    if (rangeInvalid) return;
    setPage(1); setApplied({ ...draft }); changes.refresh();
  }

  function resetFilters() {
    const empty = { seriesId: '', changeType: '', from: '', to: '' };
    setDraft(empty); setApplied(empty); setPage(1); changes.refresh();
  }

  if (!orgId) return <Panel title="授权次数变更记录"><Empty title="缺少机构标识" body="请从机构列表点「查看详情」，再用「授权次数 → 查看变更记录」进入本页。" /></Panel>;

  return <>
    <PageHeader eyebrow="平台教务 · 机构与课包人次" title="授权次数变更记录" description="本机构每个课包的授权次数变动流水（总授权次数、已授权次数的前后值）。" actions={<><button className="secondary-button" onClick={() => navigate(`/organizations/${encodeURIComponent(orgId)}/quota`)}>← 返回课包与授权次数</button><button className="secondary-button" onClick={() => navigate(`/organizations/${encodeURIComponent(orgId)}`)}>机构详情</button></>} />
    {detail.loading ? <Loading label="正在读取机构…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : <OrganizationCard organization={organization || {}} meta={<p className="muted">共 {assignments.length} 个课包。</p>} />}
    <Panel title="筛选">
      <form className="filter-form" onSubmit={submitFilters}>
        <label>课包<select value={draft.seriesId} onChange={(event) => setDraft({ ...draft, seriesId: event.target.value })}>
          <option value="">全部课包</option>
          {seriesOptions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label>
        <label>变更类型<select value={draft.changeType} onChange={(event) => setDraft({ ...draft, changeType: event.target.value })}>
          <option value="">全部类型</option>
          {Object.entries(CHANGE_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>开始日期<input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
        <label>结束日期<input type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
        <div className="row-actions">
          <button className="primary-button" disabled={changes.loading || rangeInvalid}>查询</button>
          <button type="button" className="secondary-button" onClick={resetFilters}>重置</button>
        </div>
      </form>
      <p className="muted">时间范围按整天算（含开始与结束这两天）。</p>
      {rangeInvalid ? <Notice tone="danger">开始日期不能晚于结束日期。</Notice> : null}
    </Panel>
    <Panel title="变更记录">
      <Notice tone="info">「授权消耗 / 授权取消返还」这两类<strong>只改已授权次数</strong>（机构把课包分给学生、或平台取消授权返还一次），总授权次数不变 —— 所以那两行的「变更前/后总授权次数」看起来一样是正常的，真正的变化看「变更前/后已授权次数」两列。</Notice>
      {changes.loading ? <Loading label="正在读取变更记录…" /> : changes.error ? <ErrorState error={changes.error} onRetry={changes.refresh} /> : items.length ? <>
        <ListResultSummary total={total} page={currentPage} totalPages={totalPages} label="条记录" />
        <div className="table-wrap"><table>
          <thead><tr>
            <th>时间</th><th>课包名称</th><th>变更类型</th><th>变更值</th>
            <th>变更前总授权次数</th><th>变更后总授权次数</th>
            <th>变更前已授权次数</th><th>变更后已授权次数</th>
            <th>操作人</th><th>原因</th>
          </tr></thead>
          <tbody>{items.map((row) => <tr key={row.id || `${row.createdAt}-${row.changeType}-${row.seriesId}-${row.delta}`}>
            <td>{formatDate(row.createdAt)}</td>
            <td>{changeTitle(row)}</td>
            <td><span className={changeTypeTone(row.changeType)}>{CHANGE_TYPE_LABELS[row.changeType] || row.changeType || '—'}</span></td>
            <td><strong>{formatDelta(row.delta)}</strong> 次</td>
            <td>{row.quotaTotalBefore ?? '—'}</td>
            <td>{row.quotaTotalAfter ?? '—'}</td>
            <td>{row.quotaUsedBefore ?? '—'}</td>
            <td>{row.quotaUsedAfter ?? '—'}</td>
            <td>{changeActor(row)}</td>
            <td>{row.reason || '—'}</td>
          </tr>)}</tbody>
        </table></div>
        <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} disabled={changes.loading} />
      </> : <Empty title="没有符合条件的变更记录" body="可以调整课包、变更类型或时间范围；如果服务端刚上线这张流水表，历史变更补不回来，只能从上线后开始记。" />}
    </Panel>
  </>;
}
