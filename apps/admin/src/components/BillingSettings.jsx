// 计费配置：模态开关与单价 / 平台限额 / 预警阈值
// 后端 /api/admin/billing-config/{modalities,quotas,alerts} 早已存在，此前管理端只有 AI 渠道界面。
import { useState } from 'react';
import { Empty, ErrorState, Loading, Notice, Panel, formatDate, useData } from '@platform/shared';

const PERIOD_LABELS = { DAY: '每日', MONTH: '每月' };
const SCOPE_LABELS = { GLOBAL: '全平台', STUDENT: '学生', TEACHER: '教师' };
const ALERT_LABELS = { BALANCE_LOW: '余额不足', CONSUMPTION_SPIKE: '消耗激增', QUOTA_EXCEEDED: '配额超限' };

export function BillingSettings({ api }) {
  const modalities = useData(() => api.get('admin/billing-config/modalities'), [api]);
  const quotas = useData(() => api.get('admin/billing-config/quotas'), [api]);
  const alerts = useData(() => api.get('admin/billing-config/alerts'), [api]);
  const [edit, setEdit] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  function start(kind, key, form) { setEdit({ kind, key, form }); setReason(''); setMessage(''); }
  function patch(changes) { setEdit((current) => (current ? { ...current, form: { ...current.form, ...changes } } : current)); }

  async function save() {
    if (!edit) return;
    setBusy(true);
    setMessage('');
    try {
      const path = 'admin/billing-config/' + edit.kind + 's/' + encodeURIComponent(edit.key);
      await api.put(path, { ...edit.form, reason });
      setMessage(`已保存：${edit.key}`);
      setEdit(null);
      modalities.refresh();
      quotas.refresh();
      alerts.refresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  const reasonField = <label className="span-2">变更原因（写入配置变更日志）<input value={reason} maxLength="500" placeholder="例如：2026 秋季调价" onChange={(event) => setReason(event.target.value)} /></label>;

  return <>
    {message ? <Notice tone={message.includes('已保存') ? 'success' : 'danger'}>{message}</Notice> : null}

    <Panel title="模态开关与单价">
      <p className="muted">关闭某个模态后，学生端生成会被服务端拒绝（MODALITY_DISABLED）；单价是该模态每次调用的积分消耗。</p>
      {modalities.loading ? <Loading /> : modalities.error ? <ErrorState error={modalities.error} onRetry={modalities.refresh} /> : <div className="table-wrap"><table>
        <thead><tr><th>模态</th><th>显示名</th><th>单价（积分/次）</th><th>开关</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>
          {(modalities.data?.items || []).map((item) => {
            const editing = edit?.kind === 'modality' && edit.key === item.modality;
            return <tr key={item.id}>
              <td><strong>{item.modality}</strong></td>
              <td>{editing ? <input value={edit.form.displayName} onChange={(event) => patch({ displayName: event.target.value })} /> : (item.displayName || '—')}</td>
              <td>{editing ? <input type="number" min="0" max="100" value={edit.form.unitCost} onChange={(event) => patch({ unitCost: event.target.value })} /> : item.unitCost}</td>
              <td>{editing
                ? <label className="checkbox-label"><input type="checkbox" checked={edit.form.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />启用</label>
                : <span className={`status ${item.enabled ? 'success' : 'danger'}`}>{item.enabled ? '启用' : '关闭'}</span>}</td>
              <td>{formatDate(item.updatedAt)}</td>
              <td>{editing
                ? <div className="row-actions"><button className="primary-button" disabled={busy} onClick={save}>保存</button><button className="secondary-button" onClick={() => setEdit(null)}>取消</button></div>
                : <button className="secondary-button" onClick={() => start('modality', item.modality, { displayName: item.displayName, unitCost: item.unitCost, enabled: item.enabled })}>编辑</button>}</td>
            </tr>;
          })}
          {!(modalities.data?.items || []).length ? <tr><td colSpan="6"><Empty title="暂无模态配置" /></td></tr> : null}
          {edit?.kind === 'modality' ? <tr><td colSpan="6">{reasonField}</td></tr> : null}
        </tbody>
      </table></div>}
    </Panel>

    <Panel title="平台限额">
      <p className="muted">-1 表示不限制。限额在扣费前校验，超出即拒绝。</p>
      {quotas.loading ? <Loading /> : quotas.error ? <ErrorState error={quotas.error} onRetry={quotas.refresh} /> : <div className="table-wrap"><table>
        <thead><tr><th>范围</th><th>周期</th><th>日上限</th><th>月上限</th><th>备注</th><th>操作</th></tr></thead>
        <tbody>
          {(quotas.data?.items || []).map((item) => {
            const editing = edit?.kind === 'quota' && edit.key === item.scope;
            return <tr key={item.id}>
              <td><strong>{SCOPE_LABELS[item.scope] || item.scope}</strong></td>
              <td>{editing
                ? <select value={edit.form.period} onChange={(event) => patch({ period: event.target.value })}><option value="DAY">每日</option><option value="MONTH">每月</option></select>
                : (PERIOD_LABELS[item.period] || item.period)}</td>
              <td>{editing ? <input type="number" value={edit.form.dailyLimit} onChange={(event) => patch({ dailyLimit: event.target.value })} /> : item.dailyLimit}</td>
              <td>{editing ? <input type="number" value={edit.form.monthlyLimit} onChange={(event) => patch({ monthlyLimit: event.target.value })} /> : item.monthlyLimit}</td>
              <td>{editing ? <input value={edit.form.note} onChange={(event) => patch({ note: event.target.value })} /> : (item.note || '—')}</td>
              <td>{editing
                ? <div className="row-actions"><button className="primary-button" disabled={busy} onClick={save}>保存</button><button className="secondary-button" onClick={() => setEdit(null)}>取消</button></div>
                : <button className="secondary-button" onClick={() => start('quota', item.scope, { period: item.period, dailyLimit: item.dailyLimit, monthlyLimit: item.monthlyLimit, note: item.note })}>编辑</button>}</td>
            </tr>;
          })}
          {!(quotas.data?.items || []).length ? <tr><td colSpan="6"><Empty title="暂无限额配置" /></td></tr> : null}
          {edit?.kind === 'quota' ? <tr><td colSpan="6">{reasonField}</td></tr> : null}
        </tbody>
      </table></div>}
    </Panel>

    <Panel title="预警阈值">
      <p className="muted">阈值与通知邮箱仅作配置记录，平台当前没有外发告警通道（按路线图冻结）；请在本页查看。</p>
      {alerts.loading ? <Loading /> : alerts.error ? <ErrorState error={alerts.error} onRetry={alerts.refresh} /> : <div className="table-wrap"><table>
        <thead><tr><th>类型</th><th>阈值</th><th>通知邮箱</th><th>开关</th><th>备注</th><th>操作</th></tr></thead>
        <tbody>
          {(alerts.data?.items || []).map((item) => {
            const editing = edit?.kind === 'alert' && edit.key === item.alertType;
            return <tr key={item.id}>
              <td><strong>{ALERT_LABELS[item.alertType] || item.alertType}</strong></td>
              <td>{editing ? <input type="number" min="0" value={edit.form.threshold} onChange={(event) => patch({ threshold: event.target.value })} /> : item.threshold}</td>
              <td>{editing ? <input value={edit.form.notifyEmail} placeholder="可留空" onChange={(event) => patch({ notifyEmail: event.target.value })} /> : (item.notifyEmail || '—')}</td>
              <td>{editing
                ? <label className="checkbox-label"><input type="checkbox" checked={edit.form.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />启用</label>
                : <span className={`status ${item.enabled ? 'success' : 'muted'}`}>{item.enabled ? '启用' : '关闭'}</span>}</td>
              <td>{editing ? <input value={edit.form.note} onChange={(event) => patch({ note: event.target.value })} /> : (item.note || '—')}</td>
              <td>{editing
                ? <div className="row-actions"><button className="primary-button" disabled={busy} onClick={save}>保存</button><button className="secondary-button" onClick={() => setEdit(null)}>取消</button></div>
                : <button className="secondary-button" onClick={() => start('alert', item.alertType, { threshold: item.threshold, notifyEmail: item.notifyEmail, enabled: item.enabled, note: item.note })}>编辑</button>}</td>
            </tr>;
          })}
          {!(alerts.data?.items || []).length ? <tr><td colSpan="6"><Empty title="暂无预警配置" /></td></tr> : null}
          {edit?.kind === 'alert' ? <tr><td colSpan="6">{reasonField}</td></tr> : null}
        </tbody>
      </table></div>}
    </Panel>
  </>;
}
