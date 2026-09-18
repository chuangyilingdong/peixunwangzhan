// 能力配置：平台级模态总开关。
// 历史 alerts 接口继续兼容旧数据，但旧“余额不足/配额超限”口径不再出现在新算力总控。
//
// 2026-09-18：加 embedded 模式 —— 「AI 能力与价格」页把四个模态总开关收进「③ 路由与开关」那一块里
// （用户口径：全局配置合成一块，不再散落在「高级」折叠里），所以这里要能只出内容、不要自己那层 Panel。
// 顺带删掉只有一项的 ENDPOINT_BY_KIND 映射表：一个键的查表只是多一层绕。
import { useState } from 'react';
import { Empty, ErrorState, Loading, Notice, Panel, formatDate, useData } from '@platform/shared';

export function BillingSettings({ api, embedded = false }) {
  const modalities = useData(() => api.get('admin/billing-config/modalities'), [api]);
  const [edit, setEdit] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  function start(key, form) { setEdit({ key, form }); setReason(''); setMessage(''); }
  function patch(changes) { setEdit((current) => (current ? { ...current, form: { ...current.form, ...changes } } : current)); }

  async function save() {
    if (!edit) return;
    setBusy(true);
    setMessage('');
    try {
      await api.put('admin/billing-config/modalities/' + encodeURIComponent(edit.key), { ...edit.form, reason });
      setMessage(`已保存：${edit.key}`);
      setEdit(null);
      modalities.refresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  const reasonField = <label className="span-2">变更原因（写入配置变更日志）<input value={reason} maxLength="500" placeholder="例如：2026 秋季调价" onChange={(event) => setReason(event.target.value)} /></label>;

  const body = <>
    {modalities.loading ? <Loading /> : modalities.error ? <ErrorState error={modalities.error} onRetry={modalities.refresh} /> : <div className="table-wrap"><table>
      <thead><tr><th>模态</th><th>显示名</th><th>开关</th><th>更新时间</th><th>操作</th></tr></thead>
      <tbody>
        {(modalities.data?.items || []).map((item) => {
          const editing = edit?.key === item.modality;
          return <tr key={item.id}>
            <td><strong>{item.modality}</strong></td>
            <td>{editing ? <input value={edit.form.displayName} onChange={(event) => patch({ displayName: event.target.value })} /> : (item.displayName || '—')}</td>
            <td>{editing
              ? <label className="checkbox-label"><input type="checkbox" checked={edit.form.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />启用</label>
              : <span className={`status ${item.enabled ? 'success' : 'danger'}`}>{item.enabled ? '启用' : '关闭'}</span>}</td>
            <td>{formatDate(item.updatedAt)}</td>
            <td>{editing
              ? <div className="row-actions"><button className="primary-button" disabled={busy} onClick={save}>保存</button><button className="secondary-button" onClick={() => setEdit(null)}>取消</button></div>
              : <button className="secondary-button" onClick={() => start(item.modality, { displayName: item.displayName, enabled: item.enabled })}>编辑</button>}</td>
          </tr>;
        })}
        {!(modalities.data?.items || []).length ? <tr><td colSpan="5"><Empty title="暂无模态配置" /></td></tr> : null}
        {edit ? <tr><td colSpan="5">{reasonField}</td></tr> : null}
      </tbody>
    </table></div>}</>;

  if (embedded) return <div className="top-gap">
    <h4>模态总开关（平台级）</h4>
    <p className="muted">关闭后，学生将无法使用对应能力。课堂预算只做平台成本预警，请到“用量与成本”查看，不会在这里设置学生余额或配额。这里的改动有自己的保存按钮（每次都会写一条变更日志），不跟着页面底部的「保存全部配置」。</p>
    {message ? <Notice tone={message.includes('已保存') ? 'success' : 'danger'}>{message}</Notice> : null}
    {body}
  </div>;

  return <Panel title="模态开关（平台级总开关）">
    <p className="muted">关闭后，学生将无法使用对应能力。课堂预算只做平台成本预警，请到“用量与成本”查看，不会在这里设置学生余额或配额。</p>
    {message ? <Notice tone={message.includes('已保存') ? 'success' : 'danger'}>{message}</Notice> : null}
    {body}
  </Panel>;
}
