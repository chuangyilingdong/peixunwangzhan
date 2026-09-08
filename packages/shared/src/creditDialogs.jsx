// 积分/配额相关对话框（admin 与 org 共用，避免双份实现）
import { useState } from 'react';
import { Notice } from './ui.jsx';
import { formatCredits } from './auth.js';

// 配额调整对话框（机构管理员对单个成员调整 AI 配额）
export function CreditAdjustDialog({ api, user, onClose, onSuccess }) {
  const [form, setForm] = useState({ creditsChange: '', reason: '' });
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

            {message && <Notice tone={message.includes('成功') ? 'success' : 'danger'}>{message}</Notice>}
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

// 批量分配对话框（机构管理员批量分配 AI 配额）
export function BatchAllocateDialog({ api, selectedUsers, onClose, onSuccess }) {
  const [form, setForm] = useState({ creditsPerUser: '', reason: '' });
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
        userIds: selectedUsers.map((u) => u.userId),
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

            {message && <Notice tone={message.includes('成功') ? 'success' : 'danger'}>{message}</Notice>}
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
