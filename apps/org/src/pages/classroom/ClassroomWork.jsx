// 课堂里「只读作品预览」弹窗（2026-09-17 从 pages/Classrooms.jsx 原样搬进来，逻辑未改）。
import { useEffect, useState } from 'react';
import { CanvasEditor } from '@platform/canvas';
import { buildPreviewDocument, Empty, ErrorState, formatDate, Loading, Notice, ReplayDocument, ReplayFiles, ReplayPreview, WorkMediaGallery, useData } from '@platform/shared';
import { Modal } from './ui.jsx';

export function previewHref(value) {
  if (!value || typeof value !== 'string') return null;
  return /^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value) ? value : null;
}

// 作品图片一律转成 data: 地址：学生代码跑在 opaque 起源的 sandbox iframe 里，
// 拿不到父页面的 blob: 地址（实测 <img src="blob:..."> 在该文档内必然 onerror），
// 而 data: 在沙箱内和父页面都能显示（两处 CSP 都允许 img-src data:）。
async function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('作品图片读取失败。'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 只读作品预览弹窗（画布 / VibeCoding 产物都走它）。
 *
 * `workBase` 是接口前缀，**两种作用域共用这一个组件**（2026-09-20）：
 *   · 课堂详情里：`org/sessions/<sessionId>/works` —— 只认挂在这堂课里的作品；
 *   · 作品管理里：`org/works` —— 按机构看，**不要求作品有课堂**（有的提交没挂课堂，
 *     用课堂作用域根本打不开）。
 * 服务端两种作用域返回同一套图片 / 文件地址前缀，所以这里只换前缀、渲染逻辑一个字不动。
 */
export function ClassroomWork({ api, workBase, work = {}, onClose }) {
  const detail = useData(() => api.get(`${workBase}/${encodeURIComponent(work.source)}/${encodeURIComponent(work.id)}`), [api, workBase, work.source, work.id]);
  const [activeName, setActiveName] = useState('');
  // 作品先看**做出来的东西**（图/视频/音频）；画布放到「创作画布」那一档（用户 2026-09-21 口径）。
  const [workView, setWorkView] = useState('media');
  const [images, setImages] = useState({});
  const [imageError, setImageError] = useState('');
  const data = detail.data;
  useEffect(() => {
    let cancelled = false;
    setImages({});
    setImageError('');
    const prefix = `/api/${workBase}/${encodeURIComponent(work.source)}/${encodeURIComponent(work.id)}/images/`;
    Promise.allSettled(Object.entries(data?.imageUrls || {}).map(async ([id, path]) => {
      if (typeof path !== 'string' || !path.startsWith(prefix)) throw new Error('图片地址不属于此作品。');
      const blobUrl = await api.fetchBlobUrl(path);
      try {
        const dataUrl = await readAsDataUrl(await (await fetch(blobUrl)).blob());
        if (cancelled) return null;
        return [id, dataUrl];
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    })).then((entries) => {
      if (cancelled) return;
      setImages(Object.fromEntries(entries.filter((entry) => entry.status === 'fulfilled' && entry.value).map((entry) => entry.value)));
      if (entries.some((entry) => entry.status === 'rejected')) setImageError('部分作品图片不可用，已保留其余图片。');
    }).catch((error) => {
      if (!cancelled) setImageError(error.message || '作品图片读取失败。');
    });
    return () => { cancelled = true; };
  }, [api, data, workBase, work.id, work.source]);
  const snapshotImage = (value) => {
    const raw = String(value || '');
    const match = raw.match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:[?#].*)?$/);
    if (match) return images[match[1]] || null;
    const entry = Object.entries(data?.imageUrls || {}).find(([, path]) => path === raw);
    return entry ? images[entry[0]] || null : null;
  };
  const files = Object.fromEntries(Object.entries(data?.files || {}).map(([name, content]) => {
    let resolved = String(content ?? '');
    for (const [id, url] of Object.entries(images)) {
      resolved = resolved.split(`/api/student/file-assets/${id}/download`).join(url);
    }
    return [name, resolved];
  }));
  const artifacts = data?.artifacts || [];
  const views = artifacts.filter((item) => item.document || ['pptx', 'docx', 'xlsx', 'html', 'htm'].includes(String(item.kind).toLowerCase()) || /\.html?$/i.test(item.name));
  const selected = views.find((item) => item.name === activeName)
    || views.find((item) => item.name === data?.preview?.name)
    || views.find((item) => item.name === data?.entryFile)
    || views[0];
  const entry = selected?.name || data?.entryFile;
  const document = selected && (selected.document || ['pptx', 'docx', 'xlsx'].includes(String(selected.kind).toLowerCase()));
  // 真文件产物（学生创作环境交上来的 PPT/Word/Excel 原文件）：地址由服务端拼好，
  // 预览是服务端转出来的 PDF —— 这类产物没有「规格文本」，客户端渲染不了。
  const documentFile = document ? (data?.fileUrls?.[selected.name] || null) : null;
  // Run private student code in the existing opaque-origin sandbox, with network access blocked.
  const html = data?.source === 'VIBECODING' && entry && !document
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">${buildPreviewDocument(files, entry)}`
    : '';
  return <Modal title={`只读作品 · ${work.title || '未命名作品'}`} wide onClose={onClose}
    footer={<>
      {documentFile?.download ? <a className="secondary-button" href={documentFile.download}>下载原文件</a> : null}
      <button className="secondary-button" onClick={onClose}>关闭预览</button>
    </>}>
    {detail.loading ? <Loading label="正在读取私有作品…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : data ? <>
      <p className="muted">{data.studentName || '—'} · {formatDate(data.submittedAt)}</p>
      {imageError ? <Notice tone="warning">{imageError}</Notice> : null}
      {data.source === 'CANVAS' ? (Array.isArray(data.media) && data.media.length
        // 作品先看**做出来的东西**（图/视频/音频）——用户 2026-09-21：「应该显示的是图片/视频/音频等等，
        // 而不是画布」。画布放到下面的「创作画布」里，想看过程随时切。
        ? <>
          <div className="row-actions" role="tablist">
            <button type="button" role="tab" aria-selected={workView === 'media'} className={workView === 'media' ? 'primary-button' : 'secondary-button'} onClick={() => setWorkView('media')}>作品内容</button>
            <button type="button" role="tab" aria-selected={workView === 'canvas'} className={workView === 'canvas' ? 'primary-button' : 'secondary-button'} onClick={() => setWorkView('canvas')}>创作画布</button>
          </div>
          {workView === 'canvas'
            ? (data.canvasSnapshot ? <CanvasEditor key={data.id} initialSnapshot={data.canvasSnapshot} readOnly showStarter={false} resolveAssetUrl={snapshotImage} /> : <Empty title="暂无画布快照" />)
            : <WorkMediaGallery media={data.media} assets={data.assets} resolveSrc={(item) => (item?.fileId ? snapshotImage(`/api/student/file-assets/${item.fileId}/download`) : '')} />}
        </>
        : (data.canvasSnapshot
          ? <CanvasEditor key={data.id} initialSnapshot={data.canvasSnapshot} readOnly showStarter={false} resolveAssetUrl={snapshotImage} />
          : <Empty title="暂无画布快照" />))
        : <div data-console="vibecoding" className="classroom-work-preview">
          {views.length > 1 ? <label>作品文件<select value={entry || ''} onChange={(event) => setActiveName(event.target.value)}>
            {views.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select></label> : null}
          {documentFile ? <iframe className="c-replay__doc" src={documentFile.preview} title={selected.name} />
            : document ? <ReplayDocument artifact={{ ...selected, content: String(files[selected.name] ?? selected.content ?? '') }} resolveImage={(slide, slideIndex) => {
            const generated = selected.generatedImages?.find((item) => Number(item.slideIndex) === slideIndex && !item.error && images[item.fileId]);
            if (generated && images[generated.fileId]) return images[generated.fileId];
            const ordinal = Number(slide?.image?.attachment ?? slide?.imageAttachment);
            const attachment = ordinal > 0 && selected.attachmentImages?.find((item) => Number(item.index) === ordinal && images[item.fileId]);
            if (attachment) return images[attachment.fileId];
            // Embedded HTML images have only fileId; use explicit snapshot references, never an arbitrary image.
            const reference = typeof slide?.image === 'string' ? slide.image : slide?.image?.url || slide?.image?.src;
            const embedded = selected.embeddedImages?.find((item) => item.fileId === slide?.image?.fileId && images[item.fileId]);
            return (embedded && images[embedded.fileId]) || snapshotImage(reference);
          }} />
            : entry && Object.hasOwn(files, entry) ? <>
              <Notice tone="info">外部网络资源已禁用；依赖 CDN 或在线接口的内容可能无法运行。</Notice>
              <ReplayPreview html={html} title={data.title || '课堂作品'} />
            </> : <Empty title="暂无可预览产物" />}
          <details className="top-gap"><summary>查看作品源文件</summary><ReplayFiles files={files} entryFile={entry} /></details>
        </div>}
    </> : null}
  </Modal>;
}
