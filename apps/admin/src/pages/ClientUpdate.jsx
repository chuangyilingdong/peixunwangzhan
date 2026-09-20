import { useEffect, useState } from 'react';
import { ErrorState, Loading, Notice, PageHeader, Panel } from '@platform/shared';

function megabytes(bytes) {
  const value = Number(bytes || 0);
  return value > 0 ? `${(value / 1024 / 1024).toFixed(1)} MB` : '未记录';
}

function timestamp(value) {
  if (!value) return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export function ClientUpdate({ api }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ enabled: false, mandatory: false, minVersion: '', note: '', channel: 'stable' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    setLoading(true); setError(''); setNotice('');
    try {
      const value = await api.get('admin/client-update');
      setData(value);
      setForm({
        enabled: value?.enabled !== false,
        mandatory: value?.mandatory === true,
        minVersion: value?.minVersion || '',
        note: value?.note || '',
        channel: value?.channel || 'stable',
      });
    } catch (err) {
      setError(err.message || '读取客户端更新配置失败');
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [api]);

  async function save(event) {
    event.preventDefault();
    setSaving(true); setError(''); setNotice('');
    try {
      const value = await api.put('admin/client-update', form);
      setData(value);
      setNotice('客户端更新配置已保存。修改会在客户端下次启动检查时生效。');
    } catch (err) {
      setError(err.message || '保存客户端更新配置失败');
    } finally { setSaving(false); }
  }

  const file = data?.file;
  return <>
    <PageHeader eyebrow="系统管理" title="客户端更新" description="配置客户端启动时的更新提示与发布状态。安装包版本、文件、大小与 SHA256 由发布脚本生成，后台只读展示。" />
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    {loading ? <Loading /> : !data ? <ErrorState error={error || '没有返回配置'} onRetry={load} /> : <>
      <Panel title="当前发布包" actions={<button type="button" className="secondary-button" onClick={load}>刷新</button>}>
        {!data.exists || !file ? <Notice tone="warning">当前服务器还没有客户端更新清单。请先运行 <code>deploy/desktop/publish-client.sh</code> 上传安装包。</Notice> : <div className="form-grid">
          <label>版本<input value={data.version || '未记录'} readOnly /></label>
          <label>更新通道<input value={data.channel || 'stable'} readOnly /></label>
          <label>安装包<input value={file.name || '未记录'} readOnly /></label>
          <label>大小<input value={megabytes(file.size)} readOnly /></label>
          <label>发布时间<input value={timestamp(data.publishedAt || data.updatedAt)} readOnly /></label>
          <label>SHA256<input value={file.sha256 || '未记录'} readOnly /></label>
        </div>}
      </Panel>
      <Panel title="更新策略">
        <form onSubmit={save}>
          <div className="form-grid">
            <label>更新通道<input value={form.channel} maxLength={40} onChange={(event) => setForm({ ...form, channel: event.target.value })} placeholder="stable" /></label>
            <label>最低支持版本<input value={form.minVersion} maxLength={64} onChange={(event) => setForm({ ...form, minVersion: event.target.value })} placeholder="例如 0.1.6-alpha.2；留空表示不限制" /></label>
          </div>
          <label className="checkbox-label top-gap"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> 启用启动更新检查</label>
          <label className="checkbox-label"><input type="checkbox" checked={form.mandatory} onChange={(event) => setForm({ ...form, mandatory: event.target.checked })} /> 强制更新（不提供“稍后”按钮）</label>
          <label className="top-gap">更新说明<textarea value={form.note} maxLength={2000} rows={5} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="会显示在客户端更新确认框中" /></label>
          <p className="muted">当前版本低于“最低支持版本”时，客户端也会被强制更新。不要把最低版本设成尚未发布的版本。</p>
          <button className="primary-button" disabled={saving || !file}>{saving ? '保存中…' : '保存更新配置'}</button>
        </form>
      </Panel>
    </>}
  </>;
}