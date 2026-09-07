// 机构端 - 积分流水查询页面
import { useState, useEffect } from 'react';
import { Loading, ErrorState, Empty, Notice, Panel, PageHeader, formatCredits, formatDate } from '@platform/shared';

function useData(load, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const refresh = async () => { 
    setState((old) => ({ ...old, loading: true, error: null })); 
    try { 
      setState({ loading: false, error: null, data: await load() }); 
    } catch (error) { 
      setState({ loading: false, error, data: null }); 
    } 
  };
  useEffect(() => { refresh(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, refresh };
}

export function BillingTransactionsPage({ api }) {
  const [filters, setFilters] = useState({
    type: 'ALL',
    startDate: '',
    endDate: ''
  });
  const [page, setPage] = useState(1);

  const query = new URLSearchParams();
  query.set('page', String(page));
  query.set('limit', '50');
  if (filters.type !== 'ALL') query.set('type', filters.type);
  if (filters.startDate) query.set('startDate', filters.startDate);
  if (filters.endDate) query.set('endDate', filters.endDate);

  const data = useData(() => api.get(`org/billing/transactions?${query.toString()}`), [api, filters, page]);

  function handleReset() {
    setFilters({ type: 'ALL', startDate: '', endDate: '' });
    setPage(1);
  }

  return (
    <>
      <PageHeader
        title="积分流水查询"
        description="查看机构积分充值、消耗和退款记录"
      />

      <Panel title="筛选条件">
        <form className="form-grid" onSubmit={(e) => e.preventDefault()}>
          <label>
            流水类型
            <select
              value={filters.type}
              onChange={(e) => { setFilters({ ...filters, type: e.target.value }); setPage(1); }}
            >
              <option value="ALL">全部</option>
              <option value="RECHARGE">充值</option>
              <option value="USAGE">消耗</option>
              <option value="REFUND">退款</option>
            </select>
          </label>

          <label>
            开始日期
            <input
              type="date"
              value={filters.startDate}
              onChange={(e) => { setFilters({ ...filters, startDate: e.target.value }); setPage(1); }}
            />
          </label>

          <label>
            结束日期
            <input
              type="date"
              value={filters.endDate}
              onChange={(e) => { setFilters({ ...filters, endDate: e.target.value }); setPage(1); }}
            />
          </label>

          <div>
            <button type="button" className="secondary-button" onClick={handleReset}>
              重置筛选
            </button>
          </div>
        </form>
      </Panel>

      {data.loading ? (
        <Loading label="加载流水记录..." />
      ) : data.error ? (
        <ErrorState error={data.error} onRetry={data.refresh} />
      ) : (
        <>
          <Panel title="积分汇总">
            <div className="metrics-row">
              <div className="metric-item">
                <span className="metric-label">当前余额</span>
                <span className="metric-value" style={{ color: '#27ae60', fontSize: '24px', fontWeight: 'bold' }}>
                  {formatCredits(data.data?.summary?.balance || 0)} 积分
                </span>
              </div>
              <div className="metric-item">
                <span className="metric-label">累计充值</span>
                <span className="metric-value">{formatCredits(data.data?.summary?.totalIn || 0)} 积分</span>
              </div>
              <div className="metric-item">
                <span className="metric-label">累计消耗</span>
                <span className="metric-value">{formatCredits(data.data?.summary?.totalOut || 0)} 积分</span>
              </div>
            </div>
          </Panel>

          <Panel title={`流水记录（共 ${data.data?.total || 0} 条）`}>
            {!data.data?.items?.length ? (
              <Empty title="暂无流水记录" body="充值或消耗记录会显示在这里" />
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>类型</th>
                        <th>方向</th>
                        <th>积分</th>
                        <th>余额</th>
                        <th>详情</th>
                        <th>用户/操作人</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.data.items.map((item) => (
                        <tr key={item.id}>
                          <td>{formatDate(item.createdAt)}</td>
                          <td>
                            {item.type === 'PLATFORM_ADJUSTMENT' && '平台充值'}
                            {item.type === 'AI_GENERATION' && 'AI 生成'}
                            {item.type === 'USER_ALLOCATION' && '用户分配'}
                            {item.type === 'BATCH_USER_ALLOCATION' && '批量分配'}
                            {item.type === 'REFUND' && '退款'}
                            {!['PLATFORM_ADJUSTMENT', 'AI_GENERATION', 'USER_ALLOCATION', 'BATCH_USER_ALLOCATION', 'REFUND'].includes(item.type) && item.type}
                          </td>
                          <td>
                            <span className={item.direction === 'IN' ? 'badge badge-success' : 'badge badge-danger'}>
                              {item.direction === 'IN' ? '收入' : '支出'}
                            </span>
                          </td>
                          <td className={item.direction === 'IN' ? 'text-success' : 'text-danger'}>
                            {item.direction === 'IN' ? '+' : '-'}{formatCredits(item.credits)}
                          </td>
                          <td>{formatCredits(item.balanceAfter)}</td>
                          <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {item.reason && <div>{item.reason}</div>}
                            {item.modality && <div className="text-muted">模态：{item.modality}</div>}
                            {item.projectTitle && <div className="text-muted">项目：{item.projectTitle}</div>}
                          </td>
                          <td>
                            {item.userName && <div>{item.userName}</div>}
                            {item.actorName && <div className="text-muted">操作人：{item.actorName}</div>}
                            {!item.userName && !item.actorName && '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {data.data.total > 50 && (
                  <div className="pagination">
                    <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                      上一页
                    </button>
                    <span>第 {page} 页 · 共 {data.data.total} 条</span>
                    <button disabled={data.data.items.length < 50} onClick={() => setPage(page + 1)}>
                      下一页
                    </button>
                  </div>
                )}
              </>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
