// 官网 - 我的积分页面
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

function formatCredits(value) {
  return String(value || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDate(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MyCreditsPage({ api }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('usage'); // usage | allocation

  useEffect(() => {
    loadData();
  }, [api]);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      // 获取配额汇总
      const summary = await api.get('website/my-credits/summary');
      // 获取使用记录
      const usageHistory = await api.get('website/my-credits/usage?limit=20');
      // 获取配额变更记录
      const allocationHistory = await api.get('website/my-credits/allocations?limit=20');
      
      setData({
        summary,
        usageHistory: usageHistory.items || [],
        allocationHistory: allocationHistory.items || []
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="my-credits-page">
        <div className="page-header">
          <h1>我的积分</h1>
          <p>查看配额余额和使用记录</p>
        </div>
        <div className="loading">加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="my-credits-page">
        <div className="page-header">
          <h1>我的积分</h1>
          <p>查看配额余额和使用记录</p>
        </div>
        <div className="error-state">
          <p>❌ {error}</p>
          <button onClick={loadData}>重试</button>
        </div>
      </div>
    );
  }

  const summary = data?.summary || {};
  const usageHistory = data?.usageHistory || [];
  const allocationHistory = data?.allocationHistory || [];

  return (
    <div className="my-credits-page">
      <div className="page-header">
        <h1>我的积分</h1>
        <p>查看配额余额和使用记录</p>
      </div>

      {/* 积分汇总 */}
      <div className="credits-summary">
        <div className="summary-card">
          <div className="summary-label">总配额</div>
          <div className="summary-value">{formatCredits(summary.totalAllocated || 0)}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">已使用</div>
          <div className="summary-value used">{formatCredits(summary.totalUsed || 0)}</div>
        </div>
        <div className="summary-card highlight">
          <div className="summary-label">剩余</div>
          <div className="summary-value">{formatCredits(summary.balance || 0)}</div>
        </div>
      </div>

      {/* 标签页 */}
      <div className="credits-tabs">
        <button 
          className={tab === 'usage' ? 'tab active' : 'tab'} 
          onClick={() => setTab('usage')}
        >
          使用记录
        </button>
        <button 
          className={tab === 'allocation' ? 'tab active' : 'tab'} 
          onClick={() => setTab('allocation')}
        >
          配额变更
        </button>
      </div>

      {/* 使用记录 */}
      {tab === 'usage' && (
        <div className="credits-history">
          {usageHistory.length === 0 ? (
            <div className="empty-state">
              <p>暂无使用记录</p>
              <Link to="/learn" className="primary-button">开始创作</Link>
            </div>
          ) : (
            <table className="history-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>积分</th>
                  <th>项目</th>
                  <th>余额</th>
                </tr>
              </thead>
              <tbody>
                {usageHistory.map((item) => (
                  <tr key={item.id}>
                    <td>{formatDate(item.createdAt)}</td>
                    <td>
                      {item.modality === 'IMAGE' && '🎨 生图'}
                      {item.modality === 'VIDEO' && '🎬 生视频'}
                      {item.modality === 'AUDIO' && '🎵 生音频'}
                      {!item.modality && 'AI 生成'}
                    </td>
                    <td className="credits-used">-{formatCredits(item.credits)}</td>
                    <td>{item.projectTitle || '—'}</td>
                    <td>{formatCredits(item.balanceAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 配额变更记录 */}
      {tab === 'allocation' && (
        <div className="credits-history">
          {allocationHistory.length === 0 ? (
            <div className="empty-state">
              <p>暂无配额变更记录</p>
            </div>
          ) : (
            <table className="history-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>积分</th>
                  <th>说明</th>
                  <th>余额</th>
                </tr>
              </thead>
              <tbody>
                {allocationHistory.map((item) => (
                  <tr key={item.id}>
                    <td>{formatDate(item.createdAt)}</td>
                    <td>
                      {item.type === 'ALLOCATION' && '📥 分配'}
                      {item.type === 'ADJUSTMENT' && '⚙️ 调整'}
                      {item.type === 'RECLAIM' && '📤 回收'}
                      {!item.type && '变更'}
                    </td>
                    <td className={item.credits > 0 ? 'credits-gained' : 'credits-used'}>
                      {item.credits > 0 ? '+' : ''}{formatCredits(item.credits)}
                    </td>
                    <td>{item.reason || '—'}</td>
                    <td>{formatCredits(item.balanceAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
