// 平台端「学生作品预览」（2026-09-20 起；2026-09-27 改成**弹窗**并补上画布作品）。
//
// 用户口径：
//   · 2026-09-20「平台能看到作品，但是也要能预览吧。现在只有个标题」；
//   · 2026-09-27「图2图3 平台侧学生作品都失效，而且不要拉到下面才能看，只有操作那给个预览按钮，弹窗查看就行了」。
//
// 两条要点（别再退回旧写法）：
//   ① **弹窗**（原生 `<dialog>` + `showModal()`，与 `.admin-confirm` 同一套）：原来它是个渲染在
//      表格**下面**的 Panel —— 列表一长就得往下拉，用户看不到；
//   ② 图片一律**经带 token 的接口取成 data:**（`api.fetchDataUrl`），**不靠 cookie**：
//      平台端的会话在 localStorage（Bearer），而 `<img src>` 发不出 Authorization 头 ——
//      2026-09-27 生产实测：`/api/admin/works/<id>/images/<fileId>` 的 `<img>` 请求全是 **401**
//      （浏览器里根本没有平台端 cookie），列表缩略图与详情里的图因此整片失效。
//      改成 fetch → data: 之后与 cookie 无关，平台端一定能看到图。
//
// 两类作品共用这个弹窗：`kind='vibecoding'`（网页真跑 / 文档给服务端转的 PDF）与
// `kind='canvas'`（作品内容 = 图/视频/音频；创作画布 = 只读画布）。
import { useEffect, useRef, useState } from 'react';
import { CanvasEditor } from '@platform/canvas';
import {
  buildPreviewDocument, Empty, ErrorState, formatDate, Loading, Notice,
  ReplayDocument, ReplayPreview, WorkMediaGallery, useData,
} from '@platform/shared';

/** 弹窗外壳（原生 dialog + 遮罩，与 AdminConfirm 同一套样式）。 */
function PreviewDialog({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return <dialog ref={ref} className="admin-confirm admin-work-preview"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === ref.current) onClose(); }}>
    <h2>作品预览 · {title || '未命名作品'}</h2>
    <div className="admin-work-preview__body">{children}</div>
    <div className="row-actions"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
  </dialog>;
}

/** 快照里的学生域地址 / 服务端给的代理地址 → 已经取到手的 data:（取不到返回 null，别发必败的请求）。 */
function makeImageResolver({ workId, kind, images, imageUrls }) {
  const proxyPrefix = kind === 'canvas'
    ? `/api/admin/works/${encodeURIComponent(workId)}/images/`
    : `/api/admin/vibecoding-works/${encodeURIComponent(workId)}/images/`;
  return (value) => {
    const raw = String(value || '');
    const studentDomain = raw.match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:[?#].*)?$/);
    if (studentDomain) return images[studentDomain[1]] || null;
    if (raw.startsWith(proxyPrefix)) {
      const fileId = raw.slice(proxyPrefix.length);
      return images[fileId] || null;
    }
    const entry = Object.entries(imageUrls || {}).find(([, path]) => path === raw);
    if (entry) return images[entry[0]] || null;
    return /^data:/i.test(raw) || /^https:\/\//i.test(raw) ? raw : null;
  };
}

/** 画布作品：作品内容（媒体卡）+ 创作画布（只读）。 */
function CanvasWorkPreview({ api, workId, detail, images, imageError }) {
  const [view, setView] = useState('media');
  const data = detail.data;
  const resolveSrc = makeImageResolver({ workId, kind: 'canvas', images, imageUrls: data?.imageUrls });
  return <>
    {imageError ? <Notice tone="warning">{imageError}</Notice> : null}
    <div className="row-actions work-detail__views">
      <button type="button" className={'text-button' + (view === 'media' ? ' is-on' : '')} onClick={() => setView('media')}>作品内容</button>
      <button type="button" className={'text-button' + (view === 'canvas' ? ' is-on' : '')} onClick={() => setView('canvas')}>创作画布</button>
    </div>
    {view === 'canvas'
      ? <div className="work-detail__canvas"><CanvasEditor key={workId} initialSnapshot={data.canvasSnapshot} readOnly showStarter={false} resolveAssetUrl={resolveSrc} /></div>
      : <WorkMediaGallery media={data.media} assets={data.assets} resolveSrc={(item) => resolveSrc(item?.url) || ''} />}
    <details className="top-gap"><summary>画布快照（原始 JSON，排查用）</summary>
      <pre style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(data.canvasSnapshot, null, 2)}</pre>
    </details>
    <details><summary>提交历史（只读） · {data.submissions?.length || 0}</summary>
      {data.submissions?.map((item) => <p key={item.id}>第 {item.round} 次 · {item.title} · {formatDate(item.submittedAt)}</p>)}
    </details>
  </>;
}

export function WorkPreview({ api, workId, title, kind = 'vibecoding', onClose }) {
  const isCanvas = kind === 'canvas';
  // ⚠️ admin 应用的接口路径要带 `admin/` 前缀（这个页面别处的调用都长这样：
  //    `admin/works/...` / `admin/vibecoding-works/...`）。少写这一段就会打到 `/api/vibecoding-works/...`，
  //    界面报的是「接口不存在」——2026-09-20 我第一版就是这么漏的。
  const detail = useData(() => api.get(isCanvas
    ? `admin/works/${encodeURIComponent(workId)}/detail`
    : `admin/vibecoding-works/${encodeURIComponent(workId)}`), [api, workId, isCanvas]);
  const [activeName, setActiveName] = useState('');
  const [images, setImages] = useState({});
  const [imageError, setImageError] = useState('');
  const data = detail.data;
  useEffect(() => {
    let cancelled = false;
    setImages({}); setImageError('');
    const prefix = isCanvas
      ? `/api/admin/works/${encodeURIComponent(workId)}/images/`
      : `/api/admin/vibecoding-works/${encodeURIComponent(workId)}/images/`;
    Promise.allSettled(Object.entries(data?.imageUrls || {}).map(async ([id, path]) => {
      if (typeof path !== 'string' || !path.startsWith(prefix)) throw new Error('图片地址不属于此作品。');
      return [id, await api.fetchDataUrl(path)];
    })).then((entries) => {
      if (cancelled) return;
      setImages(Object.fromEntries(entries.filter((entry) => entry.status === 'fulfilled' && entry.value?.[1]).map((entry) => entry.value)));
      if (entries.some((entry) => entry.status === 'rejected')) setImageError('部分作品图片不可用，已保留其余内容。');
    });
    return () => { cancelled = true; };
  }, [api, data, isCanvas, workId]);

  const snapshotImage = makeImageResolver({ workId, kind, images, imageUrls: data?.imageUrls });
  const files = Object.fromEntries(Object.entries(data?.files || {}).map(([name, content]) => {
    let resolved = String(content ?? '');
    for (const [id, url] of Object.entries(images)) resolved = resolved.split(`/api/student/file-assets/${id}/download`).join(url);
    return [name, resolved];
  }));
  const artifacts = data?.artifacts || [];
  const views = artifacts.filter((item) => item.document
    || ['pptx', 'docx', 'xlsx', 'html', 'htm'].includes(String(item.kind).toLowerCase())
    || /\.html?$/i.test(String(item.name || '')));
  const selected = views.find((item) => item.name === activeName)
    || views.find((item) => item.name === data?.preview?.name)
    || views.find((item) => item.name === data?.entryFile)
    || views[0];
  const entry = selected?.name || data?.entryFile;
  const isDocument = Boolean(selected) && (selected.document || ['pptx', 'docx', 'xlsx'].includes(String(selected.kind).toLowerCase()));
  const documentFile = isDocument ? (data?.fileUrls?.[selected.name] || null) : null;
  // 学生代码跑在不带 allow-same-origin 的沙箱里（口径⑧），网络一律禁掉
  const html = !isDocument && entry && Object.hasOwn(files, entry)
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">${buildPreviewDocument(files, entry)}`
    : '';

  return <PreviewDialog title={title || data?.title} onClose={onClose}>
    {detail.loading ? <Loading label="正在读取作品内容…" />
      : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} />
        : data ? <>
          <p className="muted">
            {data.title || '未命名作品'} · {isCanvas ? `学生：${data.studentName || '—'}（${data.studentLogin || '—'}）` : `提交于 ${formatDate(data.submittedAt)}`}
            {isCanvas && data.organizationName ? ` · ${data.organizationName}` : ''}
            {isCanvas && data.courseLessonTitle ? ` · ${data.courseLessonTitle}` : ''}
          </p>
          {isCanvas
            ? <CanvasWorkPreview api={api} workId={workId} detail={detail} images={images} imageError={imageError} />
            : <>
              {imageError ? <Notice tone="warning">{imageError}</Notice> : null}
              {views.length > 1 ? <label>作品文件<select value={entry || ''} onChange={(event) => setActiveName(event.target.value)}>
                {views.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
              </select></label> : null}
              {documentFile ? <iframe className="c-replay__doc" src={documentFile.preview} title={selected.name} />
                : isDocument ? <ReplayDocument artifact={{ ...selected, content: String(files[selected.name] ?? selected.content ?? '') }} resolveImage={(slide, slideIndex) => {
                const generated = selected.generatedImages?.find((item) => Number(item.slideIndex) === slideIndex && images[item.fileId]);
                if (generated) return images[generated.fileId];
                const ordinal = Number(slide?.image?.attachment ?? slide?.imageAttachment);
                const attachment = ordinal > 0 && selected.attachmentImages?.find((item) => Number(item.index) === ordinal && images[item.fileId]);
                if (attachment) return images[attachment.fileId];
                const reference = typeof slide?.image === 'string' ? slide.image : slide?.image?.url || slide?.image?.src;
                const embedded = selected.embeddedImages?.find((item) => item.fileId === slide?.image?.fileId && images[item.fileId]);
                return (embedded && images[embedded.fileId]) || snapshotImage(reference);
              }} />
                : html ? <ReplayPreview html={html} title={data.title || '学生作品'} />
                  : <Empty title="这件作品没有可预览的产物" body="没有网页入口、也没有可预览的文档产物。" />}
              {documentFile?.download ? <p className="muted top-gap"><a href={documentFile.download}>下载原文件</a>（预览是服务端转出来的 PDF）</p> : null}
            </>}
        </> : null}
  </PreviewDialog>;
}
