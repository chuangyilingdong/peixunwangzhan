// 机构端 - 成员配额管理页面
import { useState } from 'react';
import {
  useData,
  Loading,
  ErrorState,
  Empty,
  Notice,
  Panel,
  PageHeader,
  formatCredits,
  formatDate,
  CreditAdjustDialog,
  BatchAllocateDialog
} from '@platform/shared';

// 配额历史对话框
function CreditHistoryDialog({ api, user, onClose }) {
  const [page, setPage] = useState(1);
  const data = useData(() => api.get(`org/members/${user.userId}/credits/history?page=${page}&limit=20`), [api, user.userId, page]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>配额调整历史 - {user.displayName}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        <div className="modal-body">
          {data.loading ? <Loading label="加载历史记录..." /> : data.error ? <ErrorState error={data.error} onRetry={data.refresh} /> : !data.data?.items?.length ? (
            <Empty title="暂无调整记录" />
          ) : (
            <>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>调整前</th>
                    <th>调整后</th>
                    <th>变化量</th>
                    <th>类型</th>
                    <th>原因</th>
                    <th>操作人</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.items.map((item) => (
                    <tr key={item.id}>
                      <td>{formatDate(item.createdAt)}</td>
                      <td>{formatCredits(item.creditsBefore)}</td>
                      <td>{formatCredits(item.creditsAfter)}</td>
                      <td className={item.creditsChange > 0 ? 'text-success' : 'text-danger'}>
                        {item.creditsChange > 0 ? '+' : ''}{formatCredits(item.creditsChange)}
                      </td>
                      <td>{item.adjustmentType === 'ALLOCATION' ? '分配' : item.adjustmentType === 'RECLAIM' ? '回收' : '调整'}</td>
                      <td>{item.reason || '-'}</td>
                      <td>{item.actorName || '系统'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              
              {data.data.total > 20 && (
                <div className="pagination">
                  <button disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
                  <span>第 {page} 页</span>
                  <button disabled={data.data.items.length < 20} onClick={() => setPage(page + 1)}>下一页</button>
                </div>
              )}
            </>
          )}
        </div>
        
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

// 主组件：成员配额管理
export function MemberCreditsPage({ api }) {
  const [role, setRole] = useState('STUDENT');
  const [page, setPage] = useState(1);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [adjustUser, setAdjustUser] = useState(null);
  const [historyUser, setHistoryUser] = useState(null);
  const [showBatchDialog, setShowBatchDialog] = useState(false);

  const data = useData(() => api.get(`org/members/credits?role=${role}&page=${page}&limit=50`), [api, role, page]);

  function toggleUser(user) {
    if (selectedUsers.some(u => u.userId === user.userId)) {
      setSelectedUsers(selectedUsers.filter(u => u.userId !== user.userId));
    } else {
      setSelectedUsers([...selectedUsers, user]);
    }
  }

  function selectAll() {
    if (selectedUsers.length === data.data?.items?.length) {
      setSelectedUsers([]);
    } else {
      setSelectedUsers(data.data?.items || []);
    }
  }

  return (
    <>
      <PageHeader
        title="成员配额管理"
        description="为学生和教师分配 AI 生成配额，查看使用情况"
        actions={
          selectedUsers.length > 0 && (
            <button className="primary-button" onClick={() => setShowBatchDialog(true)}>
              批量分配配额 ({selectedUsers.length} 人)
            </button>
          )
        }
      />

      <Panel
        title={`${role === 'STUDENT' ? '学生' : '教师'}配额列表`}
        actions={
          <div className="panel-actions">
            <label>
              角色：
              <select value={role} onChange={(e) => { setRole(e.target.value); setPage(1); setSelectedUsers([]); }}>
                <option value="STUDENT">学生</option>
                <option value="TEACHER">教师</option>
              </select>
            </label>
          </div>
        }
      >
        {data.loading ? <Loading label="加载成员配额..." /> : data.error ? <ErrorState error={data.error} onRetry={data.refresh} /> : !data.data?.items?.length ? (
          <Empty title={`暂无${role === 'STUDENT' ? '学生' : '教师'}成员`} />
        ) : (
          <>
            <table className="data-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={selectedUsers.length === data.data.items.length}
                      onChange={selectAll}
                    />
                  </th>
                  <th>姓名</th>
                  <th>总配额</th>
                  <th>已使用</th>
                  <th>剩余</th>
                  <th>使用率</th>
                  <th>最后使用</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.data.items.map((user) => {
                  const usageRate = user.aiCredits > 0 ? (user.aiCreditsUsed / user.aiCredits * 100).toFixed(1) : 0;
                  return (
                    <tr key={user.userId}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedUsers.some(u => u.userId === user.userId)}
                          onChange={() => toggleUser(user)}
                        />
                      </td>
                      <td>{user.displayName}</td>
                      <td>{formatCredits(user.aiCredits)}</td>
                      <td>{formatCredits(user.aiCreditsUsed)}</td>
                      <td>{formatCredits(user.aiCreditsAvailable)}</td>
                      <td>
                        <span style={{ color: usageRate > 80 ? '#e74c3c' : usageRate > 50 ? '#f39c12' : '#27ae60' }}>
                          {usageRate}%
                        </span>
                      </td>
                      <td>{user.lastUsedAt ? formatDate(user.lastUsedAt) : '从未使用'}</td>
                      <td>
                        <button className="text-button" onClick={() => setAdjustUser(user)}>调整</button>
                        <button className="text-button" onClick={() => setHistoryUser(user)}>历史</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {data.data.total > 50 && (
              <div className="pagination">
                <button disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
                <span>第 {page} 页 · 共 {data.data.total} 人</span>
                <button disabled={data.data.items.length < 50} onClick={() => setPage(page + 1)}>下一页</button>
              </div>
            )}
          </>
        )}
      </Panel>

      {adjustUser && (
        <CreditAdjustDialog
          api={api}
          user={adjustUser}
          onClose={() => setAdjustUser(null)}
          onSuccess={() => {
            data.refresh();
            setSelectedUsers([]);
          }}
        />
      )}

      {showBatchDialog && (
        <BatchAllocateDialog
          api={api}
          selectedUsers={selectedUsers}
          onClose={() => setShowBatchDialog(false)}
          onSuccess={() => {
            data.refresh();
            setSelectedUsers([]);
          }}
        />
      )}

      {historyUser && (
        <CreditHistoryDialog
          api={api}
          user={historyUser}
          onClose={() => setHistoryUser(null)}
        />
      )}
    </>
  );
}
