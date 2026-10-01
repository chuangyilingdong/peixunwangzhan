// 课堂里「只读作品预览」弹窗（2026-09-17 从 pages/Classrooms.jsx 原样搬进来，逻辑未改）。
import { useEffect, useState } from 'react';
import { CanvasEditor } from '@platform/canvas';
import { buildPreviewDocument, Empty, ErrorState, formatDate, Loading, Notice, ReplayDocument, ReplayFiles, ReplayPreview, WorkMediaGallery, resolveWorkMediaUrl, useData, WorkSharePanel, shareablePiecesOf } from '@platform/shared';
import { Modal } from './ui.jsx';

export function previewHref(value) {
  if (!value || typeof value !== 'string') return null;
  return /^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value) ? value : null;
}

// 作品图片直接从鉴权接口转 data:；不再 fetch blob:（生产 CSP 不允许 connect-src blob:）。

/**
 * 只读作品预览弹窗（画布 / VibeCoding 产物都走它）。
 *
 * `workBase` 是接口前缀，**两种作用域共用这一个组件**（2026-09-20）：
 *   · 课堂详情里：`org/sessions/<sessionId>/works` —— 只认挂在这堂课里的作品；
 *   · 作品管理里：`org/works` —— 按机构看，**不要求作品有课堂**（有的提交没挂课堂，
 *     用课堂作用域根本打不开）。
 * 服务端两种作用域返回同一套图片 / 文件地址前缀，所以这里只换前缀、渲染逻辑一个字不动。
 */
export function ClassroomWork({ api, workBase, work = {}, onClose, canShare = false, shareCreate = null }) {
  const detail = useData(() => api.get(`${workBase}/${encodeURIComponent(work.source)}/${encodeURIComponent(work.id)}`), [api, workBase, work.source, work.id]);
  const [shareOpen, setShareOpen] = useState(false);
  const [activeName, setActiveName] = useState('');
  // 作品先看**做出来的东西**（图/视频/音频）；画布放到「创作画布」那一档（用户 2026-09-21 口径）。
  const [workView, setWorkView] = useState('media');
  const [images, setImages] = useState({});
  const [imageError, setImageError] = useState('');
  const data = detail.data;
  // ⭐ 2026-10-01 用户口径：「老师预览不能走 OSS 吗？」—— 能。服务端随作品详情多给一份
  //    `ossUrls`（**直连 OSS 的签名地址**：不需要 cookie、支持 Range 流式、字节不经过我们那台机）。
  //    有直链的**根本不 fetch**（省掉 base64 与几十兆字符串），只有本地盘老数据才走 data: 兜底。
  //    ⚠️ 沙箱 iframe 的 CSP 要放行那些来源（见下面的 mediaSources）——它仍是 opaque origin，
  //       拿不到 cookie，但**签名地址本来就不需要 cookie**，所以能直接流。
  const ossUrls = data?.ossUrls || {};
  const mediaSources = [...new Set(Object.values(ossUrls).map((url) => {
    try { return new URL(url).origin; } catch { return ''; }
  }).filter(Boolean))].map((origin) => `${origin} `).join('');
  useEffect(() => {
    let cancelled = false;
    setImages({});
    setImageError('');
    const prefix = `/api/${workBase}/${encodeURIComponent(work.source)}/${encodeURIComponent(work.id)}/images/`;
    const pending = Object.entries(data?.imageUrls || {}).filter(([id]) => !ossUrls[id]);
    Promise.allSettled(pending.map(async ([id, path]) => {
      if (typeof path !== 'string' || !path.startsWith(prefix)) throw new Error('图片地址不属于此作品。');
      return [id, await api.fetchDataUrl(path)];
    })).then((entries) => {
      if (cancelled) return;
      setImages(Object.fromEntries(entries.filter((entry) => entry.status === 'fulfilled' && entry.value).map((entry) => entry.value)));
      if (entries.some((entry) => entry.status === 'rejected')) setImageError('部分作品图片不可用，已保留其余图片。');
    }).catch((error) => {
      if (!cancelled) setImageError(error.message || '作品图片读取失败。');
    });
    return () => { cancelled = true; };
  }, [api, data, workBase, work.id, work.source]);
  // ⚠️ 2026-09-25：这里原来返回的是**转好的 data: 地址**（异步、几十秒才到），拿不到就先退回原始地址 ——
  //    而原始地址是学生域的，机构端取必然 403，缩略图于是先被标成「已失效」（用户报的就是这个）。
  //    现在同步返回服务端备好的**同源代理地址**（`/api/org/works/.../images/<fileId>`）：同源、cookie 就是
  //    老师自己的会话、还能流式边下边显示。拿不到代理地址时返回 null（显示占位），不回退学生域地址。
  // 画布读面：直链优先（`resolveWorkMediaUrl` 是按 id 查表，两份表合并后 OSS 那份赢）
  const snapshotImage = (value) => resolveWorkMediaUrl(value, { ...(data?.imageUrls || {}), ...ossUrls });
  // `images`（data:）只剩**沙箱文档**那条路要用（VibeCoding 的 HTML 预览在 opaque origin 里跑，
  // 拿不到 cookie，只能把图片内联进去）—— 见下面的 files / resolveImage。
  const files = Object.fromEntries(Object.entries(data?.files || {}).map(([name, content]) => {
    let resolved = String(content ?? '');
    // 先按"直链 → data: 兜底"合成一份，再逐个替换（同一个 id 只会出现一次）
    const media = { ...images, ...ossUrls };
    for (const [id, url] of Object.entries(media)) {
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
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; ${mediaSources}img-src data: blob: ${mediaSources}; media-src data: blob: ${mediaSources}; font-src data: ${mediaSources}; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">${buildPreviewDocument(files, entry)}`
    : '';
  return <Modal title={`只读作品 · ${work.title || '未命名作品'}`} wide onClose={onClose}
    // ⭐ 2026-10-01：分享入口**从底部按钮行挪到页眉右上角**（用户口径：与作品库那处「详情右上角」
    //    以及网站端预览弹窗的 `pl-viewer-head__actions` 对齐 —— 三处同款位置）。
    headerAction={canShare && shareCreate && data
      ? <button type="button" className="secondary-button" data-testid="work-share" onClick={() => setShareOpen(true)}>分享</button>
      : null}
    footer={<>
      {documentFile?.download ? <a className="secondary-button" href={documentFile.download}>下载原文件</a> : null}
      <button className="secondary-button" onClick={onClose}>关闭预览</button>
    </>}>
    {detail.loading ? <Loading label="正在读取私有作品…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : data ? <>
      <p className="muted">{data.studentName || '—'} · {formatDate(data.submittedAt)}</p>
      {imageError ? <Notice tone="warning">{imageError}</Notice> : null}
      {/* ⭐ 2026-09-30（用户报「教师后台看作品里图片/视频显示不出来」）：这件作品引用的本地素材
          **没有随作品一起交上来**（旧客户端只传文本与封面）。平台这边拿不到字节，但必须把话说清楚 ——
          否则老师看到的就是"图裂了、视频空着"，只会以为平台坏了。见 vibecoding.js 的 missingLocalAssets。 */}
      {Array.isArray(data.missingAssets) && data.missingAssets.length
        ? <Notice tone="warning">这件作品引用了 {data.missingAssets.length} 个本地素材（{data.missingAssets.slice(0, 3).join('、')}{data.missingAssets.length > 3 ? ' 等' : ''}），但没有随作品一起提交上来 —— 让学生在最新版客户端里重新提交一次就能看到它们。</Notice>
        : null}
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
            : <WorkMediaGallery media={data.media} assets={data.assets} resolveSrc={(item) => snapshotImage(item?.url) || ''} />}
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
            const media = { ...images, ...ossUrls };
            const generated = selected.generatedImages?.find((item) => Number(item.slideIndex) === slideIndex && !item.error && media[item.fileId]);
            if (generated && media[generated.fileId]) return media[generated.fileId];
            const ordinal = Number(slide?.image?.attachment ?? slide?.imageAttachment);
            const attachment = ordinal > 0 && selected.attachmentImages?.find((item) => Number(item.index) === ordinal && media[item.fileId]);
            if (attachment) return media[attachment.fileId];
            // Embedded HTML images have only fileId; use explicit snapshot references, never an arbitrary image.
            const reference = typeof slide?.image === 'string' ? slide.image : slide?.image?.url || slide?.image?.src;
            const embedded = selected.embeddedImages?.find((item) => item.fileId === slide?.image?.fileId && media[item.fileId]);
            return (embedded && media[embedded.fileId]) || snapshotImage(reference);
          }} />
            : entry && Object.hasOwn(files, entry) ? <>
              <Notice tone="info">外部网络资源已禁用；依赖 CDN 或在线接口的内容可能无法运行。</Notice>
              {/* 老师这一档也**不套「作品预览」面板、不缩放**（2026-09-30 用户口径：那么小的界面没法玩）——
                  宽度＝弹窗宽度、高度跟着内容长；学生页自己的媒体查询因此真正生效。 */}
              <ReplayPreview html={html} title={data.title || '课堂作品'} chrome={false} responsive />
            </> : <Empty title="暂无可预览产物" />}
          <details className="top-gap"><summary>查看作品源文件</summary><ReplayFiles files={files} entryFile={entry} /></details>
        </div>}
    </> : null}

    {/* 分享面板（与网站端同一个 `@platform/shared` 组件）：选哪一件 + 二维码 */}
    {shareOpen && data && shareCreate ? <WorkSharePanel
      title={work.title || '作品'}
      pieces={shareablePiecesOf(data, data.source || work.source || 'VIBECODING')}
      createShare={shareCreate}
      onClose={() => setShareOpen(false)}
    /> : null}
  </Modal>;
}
