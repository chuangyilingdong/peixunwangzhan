import { useEffect, useRef, useState } from 'react';
import { ErrorState, Loading, Notice, PageHeader, Panel, apiBase, readSession } from '@platform/shared';

function megabytes(bytes) {
  const value = Number(bytes || 0);
  return value > 0 ? `${(value / 1024 / 1024).toFixed(1)} MB` : '未记录';
}

/**
 * 安装包文件名契约（与客户端 `LingdongUpdater.ts` 一致）：客户端**按这个名字**校验更新包，
 * 名字不对的话包传上来了也永远不会被装上。所以前端先拦一道，省得白传几百 MB。
 */
const INSTALLER_NAME = /^lingdong-client-(.+)-(win-x64\.exe|mac-arm64\.dmg)$/;

/**
 * 上传安装包。
 *
 * ⚠️ 用 XHR 而不是 fetch：只有 XHR 能拿到**上传进度**（`upload.onprogress`）。现网包 377MB、
 *    这台机公网出口 5 Mbps，一次上传十分钟起步 —— 没有进度条的话运维只会看到一个不动的按钮，
 *    然后反复重传（服务端每条都会真写完一遍）。
 * ⚠️ 服务端这条路由收的是**原始字节**（不是 multipart），文件名走查询串：
 *    见 routes/admin/clientInstallerUpload.js 头部注释（少一层 multipart 解析 = 少一处
 *    能把 377MB 读进内存的地方）。
 */
function uploadInstaller(file, { onProgress }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const token = readSession()?.token || '';
    const url = `${apiBase()}/admin/client-update/upload?name=${encodeURIComponent(file.name)}`;
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.withCredentials = true;
    request.setRequestHeader('accept', 'application/json');
    request.setRequestHeader('content-type', 'application/octet-stream');
    if (token) request.setRequestHeader('authorization', `Bearer ${token}`);
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)); };
    request.onerror = () => rejectPromise(new Error('上传中断（网络或服务端），可以重试'));
    request.onabort = () => rejectPromise(new Error('上传已取消'));
    request.onload = () => {
      let payload = null;
      try { payload = request.responseText ? JSON.parse(request.responseText) : null; } catch { payload = null; }
      if (request.status >= 200 && request.status < 300 && payload?.success !== false) {
        onProgress(100);
        resolvePromise(payload?.data ?? payload);
        return;
      }
      rejectPromise(new Error(payload?.error?.message || `上传未能完成（HTTP ${request.status}）`));
    };
    request.send(file);
  });
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
  const [picked, setPicked] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [percent, setPercent] = useState(0);
  const fileInputRef = useRef(null);

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

  /**
   * 上传并发布：服务端落盘（流式）→ 算 sha256 → 原子写清单 → 顺手推 OSS。
   * 「触发更新」就是写清单这一步 —— 客户端每次启动都带 `?t=` 拉 /downloads/manifest.json。
   */
  async function publish() {
    if (!picked) { setError('先选一个安装包文件。'); return; }
    if (!INSTALLER_NAME.test(picked.name)) {
      setError('文件名必须是 lingdong-client-<版本>-win-x64.exe（Mac 用 -mac-arm64.dmg）—— 客户端按这个名字校验，改个名再传。');
      return;
    }
    setUploading(true); setError(''); setNotice(''); setPercent(0);
    try {
      const result = await uploadInstaller(picked, { onProgress: setPercent });
      setNotice(`已发布 ${result.fileName}（${megabytes(result.bytes)}，sha256 ${String(result.sha256).slice(0, 12)}…）。`
        + (result.ossSynced ? '安装包已同步到 OSS，客户端会从 OSS 下载。' : `⚠️ 本地已发布，但推 OSS 没成功（${result.ossReason || '未知原因'}）—— 下载会走本机出口，建议稍后用 11 号脚本补一次。`)
        + ' 客户端下次启动检查时就会收到更新。');
      setPicked(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await load();
    } catch (err) {
      setError(err.message || '上传安装包失败');
    } finally { setUploading(false); }
  }

  const file = data?.file;
  return <>
    <PageHeader eyebrow="系统管理" title="客户端更新" description="上传新安装包并发布，或配置客户端启动时的更新提示。发布后客户端下次启动检查时即可收到更新。" />
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    {loading ? <Loading /> : !data ? <ErrorState error={error || '没有返回配置'} onRetry={load} /> : <>
      <Panel title="上传新安装包" actions={uploading ? <span className="muted">上传中 {percent}%</span> : null}>
        <p className="muted">直接选安装包上传即可发布（几百 MB 的包会上传较久，进度在标题栏）。文件名必须是
          <code>lingdong-client-&lt;版本&gt;-win-x64.exe</code>，Mac 版是
          <code>lingdong-client-&lt;版本&gt;-mac-arm64.dmg</code> —— 客户端按这个名字与清单里的 SHA256 校验。</p>
        <div className="row-actions top-gap">
          <input ref={fileInputRef} type="file" accept=".exe,.dmg" disabled={uploading}
            onChange={(event) => { setPicked(event.target.files?.[0] || null); setError(''); setNotice(''); }} />
          <button type="button" className="primary-button" disabled={uploading || !picked} onClick={publish}>
            {uploading ? `上传中 ${percent}%` : '上传并发布'}
          </button>
        </div>
        {picked ? <p className="muted top-gap">已选：{picked.name}（{megabytes(picked.size)}）</p> : null}
        {uploading ? <progress className="top-gap" value={percent} max={100} style={{ width: '100%' }} /> : null}
      </Panel>
      <Panel title="当前发布包" actions={<button type="button" className="secondary-button" onClick={load}>刷新</button>}>
        {!data.exists || !file ? <Notice tone="warning">当前服务器还没有客户端更新清单。用上面的「上传新安装包」发布第一版即可（也可以在客户端仓跑 <code>deploy/desktop/publish-client.sh</code>）。</Notice> : <div className="form-grid">
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