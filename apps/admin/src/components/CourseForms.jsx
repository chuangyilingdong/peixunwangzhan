import { useEffect, useRef, useState } from 'react';
import { Notice } from '@platform/shared';

export function CreateCourseModal({ api, onClose, onCreated }) {
  const [form, setForm] = useState({ title: '', description: '', coverImageUrl: '', coverAssetId: '', version: '1.0', priceYuan: '', visibility: 'ALL_ORGS', difficultyLevel: '' });
  const dialogRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const update = (patch) => setForm((current) => ({ ...current, ...patch }));
  async function submit(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      if (!/^\d+(?:\.\d{1,2})?$/.test(form.priceYuan || '0')) throw new Error('价格最多支持两位小数');
      const course = await api.post('admin/course-series', { title: form.title, description: form.description, coverImageUrl: form.coverImageUrl || null, coverAssetId: form.coverAssetId || null, version: form.version, priceFen: Math.round(Number(form.priceYuan || 0) * 100), visibility: form.visibility, difficultyLevel: form.difficultyLevel === '' ? null : Number(form.difficultyLevel) });
      onCreated(course);
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  async function upload(file) {
    if (!file) return;
    setUploading(true);
    try {
      const asset = await api.upload('admin/file-assets/upload', file, { category: 'PROMO_COVER', visibility: 'PUBLIC_PLATFORM' });
      if (!asset?.id) throw new Error('上传未返回文件标识');
      update({ coverAssetId: asset.id, coverImageUrl: `/api/public/file-assets/${asset.id}/download` }); setMessage('封面上传成功');
    } catch (error) { setMessage(error.message); } finally { setUploading(false); }
  }
  return <dialog ref={dialogRef} aria-labelledby="create-course-title" style={{ width: 'min(760px, calc(100vw - 32px))', maxWidth: 'min(760px, calc(100vw - 32px))', margin: 'auto', border: 0, padding: 0, maxHeight: '90vh', borderRadius: 18 }} onCancel={(event) => { event.preventDefault(); if (!busy && !uploading) onClose(); }}><form className="modal-content modal-large" style={{ width: '100%', maxWidth: 'none' }} onSubmit={submit}>
    <div className="modal-header"><h2 id="create-course-title">新建课包</h2><button type="button" className="modal-close" aria-label="关闭新建课包" disabled={busy || uploading} onClick={onClose}>×</button></div>
    <div className="modal-body">
      {message && <Notice>{message}</Notice>}
      <p className="muted">先创建基础资料，再编排课时。完成配置后在版本发布中上线。</p>
      <details><summary>高级：使用封面地址</summary><label>封面地址<input value={form.coverImageUrl} placeholder="HTTPS 地址或上传图片" onChange={(event) => update({ coverImageUrl: event.target.value, coverAssetId: '' })} /></label></details>
      <label className="inline-file-upload">{uploading ? '上传中…' : '上传封面'}<input type="file" accept="image/*" disabled={uploading || busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; upload(file); }} /></label>
      <MaterialPreview url={form.coverImageUrl} type="IMAGE" />
      <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: '0 16px' }}>
      <label>课包名称<input autoFocus required maxLength={200} value={form.title} onChange={(event) => update({ title: event.target.value })} /></label>
        <label>初始版本<input required maxLength={100} value={form.version} onChange={(event) => update({ version: event.target.value })} /></label>
        <label>价格（元）<input inputMode="decimal" value={form.priceYuan} onChange={(event) => update({ priceYuan: event.target.value })} /></label>
        <label>可见范围<select value={form.visibility} onChange={(event) => update({ visibility: event.target.value })}><option value="ALL_ORGS">上架课程广场</option><option value="ASSIGNED_ORGS">仅授权机构</option><option value="PRIVATE">私有</option></select></label>
        <label>难度（1–5）<input type="number" min="1" max="5" value={form.difficultyLevel} onChange={(event) => update({ difficultyLevel: event.target.value })} /></label>
      <label style={{ gridColumn: '1 / -1' }}>简介<textarea rows={3} maxLength={10000} value={form.description} onChange={(event) => update({ description: event.target.value })} /></label>
      </div>
    </div>
    <div className="modal-footer"><button type="button" className="secondary-button" disabled={busy || uploading} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || uploading}>{busy ? '创建中…' : '创建并进入编排'}</button></div>
  </form></dialog>;
}

export function MaterialPreview({ url, type, content }) {
  if (content) return <details><summary>预览文字内容</summary><p style={{ whiteSpace: 'pre-wrap' }}>{content}</p></details>;
  if (!url || !/^(https:\/\/|\/api\/)/.test(url)) return null;
  const previewUrl = url.replace(/^\/api\/(student|org)\/file-assets\//, '/api/admin/file-assets/');
  return <details><summary>预览素材</summary>{type === 'IMAGE' ? <img src={previewUrl} alt="素材预览" style={{ maxWidth: '100%', maxHeight: 200 }} /> : type === 'VIDEO' ? <video src={previewUrl} controls style={{ maxWidth: '100%' }} /> : type === 'AUDIO' ? <audio src={previewUrl} controls /> : <a href={previewUrl} target="_blank" rel="noreferrer">打开文件</a>}</details>;
}
