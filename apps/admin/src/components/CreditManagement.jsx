// 积分管理相关组件
import { useState } from 'react';
import { ErrorState, Loading, Notice, formatCredits, formatDate } from '@platform/shared';

// 机构充值对话框（平台管理员使用）
export function OrgRechargeDialog({ api, orgId, orgName, onClose, onSuccess }) {
  const [form, setForm] = useState({
    credits: '',
    amountFen: '',
    paymentMethod: 'OFFLINE_TRANSFER',
    paymentReference: '',
    reason: ''
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    if (!form.credits || Number(form.credits) === 0) {
      setMessage('请输入充值积分');
      return;
    }
    
    setSaving(true);
    setMessage('');
    
    try {
      const payload = {
        credits: Number(form.credits),
        amountFen: form.amountFen ? Number(form.amountFen) * 100 : null,
        paymentMethod: form.paymentMethod || null,
        paymentReference: form.paymentReference || null,
        reason: form.reason || null
      };
      
      await api.post(`admin/organizations/${orgId}/credit-adjustments`, payload);
      setMessage('充值成功！');
      setTimeout(() => {
        onSuccess?.();
        onClose();
      }, 1000);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>为机构充值积分</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-row">
              <label>机构名称</label>
              <div className="form-value">{orgName}</div>
            </div>
            
            <div className="form-row">
              <label>充值积分 *</label>
              <input
                type="number"
                value={form.credits}
                onChange={(e) => setForm({ ...form, credits: e.target.value })}
                placeholder="请输入充值积分数量"
                min="1"
                required
              />
            </div>
            
            <div className="form-row">
              <label>付款金额（元）</label>
              <input
                type="number"
                step="0.01"
                value={form.amountFen}
                onChange={(e) => setForm({ ...form, amountFen: e.target.value })}
                placeholder="实际付款金额"
              />
            </div>
            
            <div className="form-row">
              <label>付款方式</label>
              <select
                value={form.paymentMethod}
                onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
              >
                <option value="OFFLINE_TRANSFER">线下转账</option>
                <option value="OFFLINE_CASH">现金</option>
                <option value="OFFLINE_CHECK">支票</option>
                <option value="OTHER">其他</option>
              </select>
            </div>
            
            <div className="form-row">
              <label>订单号/凭证号</label>
              <input
                type="text"
                value={form.paymentReference}
                onChange={(e) => setForm({ ...form, paymentReference: e.target.value })}
                placeholder="例如：OFF20260907001"
              />
            </div>
            
            <div className="form-row">
              <label>备注</label>
              <textarea
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="充值原因或备注信息"
                rows={3}
              />
            </div>
            
            {message && <Notice type={message.includes('成功') ? 'success' : 'error'}>{message}</Notice>}
          </div>
          
          <div className="modal-footer">
            <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? '充值中...' : '确认充值'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// 充值历史列表（平台管理员使用）
export function RechargeHistoryPanel({ api, orgId }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get(`admin/organizations/${orgId}/billing/recharge-history?page=${page}&limit=20`);
      setData(result);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  useState(() => {
    loadData();
  }, [api, orgId, page]);

  if (loading) return <Loading label="加载充值历史..." />;
  if (error) return <ErrorState error={error} onRetry={loadData} />;
  if (!data?.items?.length) return <Notice type="info">暂无充值记录</Notice>;

  return (
    <div className="recharge-history">
      <table className="data-table">
        <thead>
          <tr>
            <th>充值时间</th>
            <th>充值积分</th>
            <th>充值后余额</th>
            <th>充值原因</th>
            <th>操作人</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item) => (
            <tr key={item.id}>
              <td>{formatDate(item.createdAt)}</td>
              <td className="text-success">+{formatCredits(item.credits)}</td>
              <td>{formatCredits(item.balanceAfter)}</td>
              <td>{item.reason || '-'}</td>
              <td>{item.actorName || '系统'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      
      {data.totalPages > 1 && (
        <div className="pagination">
          <button
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </button>
          <span>第 {page} / {data.totalPages} 页</span>
          <button
            disabled={page === data.totalPages}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

// 配额调整对话框（机构管理员使用）
export function CreditAdjustDialog({ api, user, onClose, onSuccess }) {
  const [form, setForm] = useState({
    creditsChange: '',
    reason: ''
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const isIncrease = form.creditsChange && Number(form.creditsChange) > 0;
  const newCredits = user.aiCredits + Number(form.creditsChange || 0);

  async function handleSubmit(event) {
    event.preventDefault();
    
    if (!form.creditsChange || Number(form.creditsChange) === 0) {
      setMessage('请输入调整数量');
      return;
    }
    
    if (newCredits < 0) {
      setMessage('调整后配额不能为负数');
      return;
    }
    
    setSaving(true);
    setMessage('');
    
    try {
      await api.post(`org/members/${user.userId}/credits/adjust`, {
        creditsChange: Number(form.creditsChange),
        reason: form.reason || (isIncrease ? '配额补充' : '配额调整')
      });
      
      setMessage('配额调整成功！');
      setTimeout(() => {
        onSuccess?.();
        onClose();
      }, 1000);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>调整配额 - {user.displayName}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-row">
              <label>当前配额</label>
              <div className="form-value">{formatCredits(user.aiCredits)} 积分</div>
            </div>
            
            <div className="form-row">
              <label>已使用</label>
              <div className="form-value">{formatCredits(user.aiCreditsUsed)} 积分</div>
            </div>
            
            <div className="form-row">
              <label>剩余</label>
              <div className="form-value">{formatCredits(user.aiCreditsAvailable)} 积分</div>
            </div>
            
            <div className="form-row">
              <label>调整方式 *</label>
              <div className="radio-group">
                <label>
                  <input
                    type="radio"
                    checked={isIncrease}
                    onChange={() => setForm({ ...form, creditsChange: Math.abs(Number(form.creditsChange) || 0).toString() })}
                  />
                  增加配额
                </label>
                <label>
                  <input
                    type="radio"
                    checked={!isIncrease && form.creditsChange !== ''}
                    onChange={() => setForm({ ...form, creditsChange: (-Math.abs(Number(form.creditsChange) || 0)).toString() })}
                  />
                  减少配额
                </label>
              </div>
            </div>
            
            <div className="form-row">
              <label>调整数量 *</label>
              <input
                type="number"
                value={Math.abs(Number(form.creditsChange) || 0)}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setForm({ ...form, creditsChange: (isIncrease ? value : -value).toString() });
                }}
                placeholder="请输入调整数量"
                min="1"
                required
              />
            </div>
            
            <div className="form-row">
              <label>调整原因</label>
              <textarea
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="例如：月度配额补充"
                rows={3}
              />
            </div>
            
            <div className="form-row">
              <label>调整后配额</label>
              <div className="form-value" style={{ color: newCredits < 0 ? 'red' : 'inherit' }}>
                {formatCredits(newCredits)} 积分
              </div>
            </div>
            
            {message && <Notice type={message.includes('成功') ? 'success' : 'error'}>{message}</Notice>}
          </div>
          
          <div className="modal-footer">
            <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? '调整中...' : '确认调整'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// 批量分配对话框（机构管理员使用）
export function BatchAllocateDialog({ api, selectedUsers, onClose, onSuccess }) {
  const [form, setForm] = useState({
    creditsPerUser: '',
    reason: ''
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const totalCredits = selectedUsers.length * Number(form.creditsPerUser || 0);

  async function handleSubmit(event) {
    event.preventDefault();
    
    if (!form.creditsPerUser || Number(form.creditsPerUser) <= 0) {
      setMessage('请输入每人配额');
      return;
    }
    
    setSaving(true);
    setMessage('');
    
    try {
      await api.post('org/members/credits/batch-allocate', {
        userIds: selectedUsers.map(u => u.userId),
        creditsPerUser: Number(form.creditsPerUser),
        reason: form.reason || '批量配额分配'
      });
      
      setMessage(`成功为 ${selectedUsers.length} 个用户分配配额！`);
      setTimeout(() => {
        onSuccess?.();
        onClose();
      }, 1000);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>批量分配配额</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-row">
              <label>选中用户</label>
              <div className="form-value">{selectedUsers.length} 人</div>
            </div>
            
            <div className="form-row">
              <label>每人配额 *</label>
              <input
                type="number"
                value={form.creditsPerUser}
                onChange={(e) => setForm({ ...form, creditsPerUser: e.target.value })}
                placeholder="请输入每人配额"
                min="1"
                required
              />
            </div>
            
            <div className="form-row">
              <label>分配原因</label>
              <textarea
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="例如：新学期配额分配"
                rows={3}
              />
            </div>
            
            <div className="form-row">
              <label>总计消耗</label>
              <div className="form-value" style={{ color: '#e74c3c', fontWeight: 'bold' }}>
                {formatCredits(totalCredits)} 积分
              </div>
            </div>
            
            {message && <Notice type={message.includes('成功') ? 'success' : 'error'}>{message}</Notice>}
          </div>
          
          <div className="modal-footer">
            <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? '分配中...' : '确认分配'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
