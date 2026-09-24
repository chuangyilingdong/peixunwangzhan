// 官网 - 我的作品 · 单件详情（学生看**自己**的作品）
//
// 为什么要有这一页：「我的作品」原来只能显示状态 —— 卡片上写「平台发布后可查看」，
// 作品没上广场就**打不开**（学生做完的东西自己看不到，用户报的「要实际能用」）。
// 现在每件都能打开：走学生口 `/api/student/works/:source/:id`，那条**只校验「是不是你自己的」，
// 不看发布状态**。
//
// 浏览方式（用户口径 2026-09-20）：
//   · **一件作品可能有多种看法**，摆成一排视图让学生自己切：网页（能直接点开玩）/
//     图片（这节课出的图，一张张选着看）/ 文档（PPT/Word/Excel）/ 画布（整幅创作）。
//   · 默认停在**能玩能看**的那个（网页 > 图片 > 文档 > 画布）——学生点开自己的作品，
//     第一眼该看到东西，而不是一个空的壳。
//   · 顶部必须写明**哪门课包、哪一节**（学生要一眼看出这是哪节课做的）。
//
// 渲染与公开作品页（WorkDetail.jsx）同一套组件，所以「我自己看」和「广场上别人看」长得一样：
//   画布 → 只读 CanvasEditor；产物 → ReplayShell + ReplayDocument / ReplayPreview。
// ⚠️ 与 org 端 ClassroomWork 是同一件事的两个视角（老师看课堂作品 / 学生看自己的作品），
//    拿数据的形状是同一套（服务端两处对齐了），改渲染时**两边一起想**。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { buildPreviewDocument, ConsoleEmpty, ConsoleIcon, ReplayDocument, ReplayFilePreview, ReplayFiles, ReplayPanel, ReplayPreview, ReplayShell, WorkMediaGallery, artifactGroup, formatDate, workPlazaLabel } from '@platform/shared';

/** 快照里的私有素材地址 → fileId（服务端拼的 imageUrls 用的就是这个地址）。 */
function fileIdOfAssetUrl(value) {
  return String(value || '').match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:[?#].*)?$/)?.[1] || '';
}

const isHtmlArtifact = (item) => /^html?$/i.test(String(item?.kind || '')) || /\.html?$/i.test(String(item?.name || ''));
const isDocumentArtifact = (item) => Boolean(item?.document) || ['pptx', 'docx', 'xlsx'].includes(String(item?.kind || '').toLowerCase());

/** 图片相册：大图 + 缩略图条（广场那套「点开大图、多张能翻」的用法）。 */
function ImageGallery({ list, src }) {
  const [active, setActive] = useState(0);
  const index = Math.min(active, Math.max(0, list.length - 1));
  const current = list[index];
  if (!current) return null;
  return <div className="mw-gallery">
    <div className="mw-gallery__stage"><img src={src(current)} alt={current.caption || '作品图片'} /></div>
    {current.caption ? <p className="mw-gallery__caption">{current.caption}</p> : null}
    {list.length > 1 ? <div className="mw-gallery__thumbs">
      {list.map((item, position) => <button
        key={`${item.url}-${position}`}
        type="button"
        className={'mw-gallery__thumb' + (position === index ? ' is-active' : '')}
        onClick={() => setActive(position)}
        aria-label={`第 ${position + 1} 张`}
        title={item.caption || `第 ${position + 1} 张`}
      ><img src={src(item)} alt="" loading="lazy" /></button>)}
    </div> : null}
  </div>;
}

export function MyWorkDetailPage({ api }) {
  const { source, id } = useParams();
  // 路由上的 source 只认这两个值（写成别的就当画布作品，不让拼出乱七八糟的请求）
  const workSource = String(source || '').toUpperCase() === 'VIBECODING' ? 'VIBECODING' : 'CANVAS';
  const [state, setState] = useState({ loading: true, error: null, work: null });
  const [imageData, setImageData] = useState({});
  const [imageError, setImageError] = useState('');
  const [activeView, setActiveView] = useState('');
  const [activeName, setActiveName] = useState('');

  useEffect(() => {
    let live = true;
    setState({ loading: true, error: null, work: null });
    api.get(`student/works/${workSource}/${encodeURIComponent(id)}`)
      .then((payload) => { if (live) setState({ loading: false, error: null, work: payload || null }); })
      .catch((error) => { if (live) setState({ loading: false, error: error.message, work: null }); });
    return () => { live = false; };
  }, [api, workSource, id]);

  const work = state.work;

  // 受鉴权保护的素材统一转 data:（见共享 api 的 fetchDataUrl：<img> 发不出 Authorization 头；
  // 生产的 connect-src 也拦 blob:，沙箱 iframe 更拿不到父页面的 blob:）。
  useEffect(() => {
    let cancelled = false;
    setImageData({});
    setImageError('');
    const entries = Object.entries(work?.imageUrls || {});
    if (!entries.length) return () => { cancelled = true; };
    Promise.allSettled(entries.map(async ([fileId, path]) => {
      if (typeof path !== 'string' || !path.startsWith('/api/student/file-assets/')) throw new Error('图片地址不属于这个作品。');
      return [fileId, await api.fetchDataUrl(path)];
    })).then((results) => {
      if (cancelled) return;
      setImageData(Object.fromEntries(results.filter((item) => item.status === 'fulfilled' && item.value).map((item) => item.value)));
      if (results.some((item) => item.status === 'rejected')) setImageError('部分作品图片不可用，已保留其余图片。');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, work]);

  // 画布节点的素材地址 → data:（CanvasEditor 收同步值或 Promise 都行，见它的 useDisplayUrl）
  const resolveAssetUrl = useCallback((value) => imageData[fileIdOfAssetUrl(value)] || null, [imageData]);
  const resolveImageSrc = useCallback((item) => (item?.fileId
    ? (imageData[item.fileId] || work?.imageUrls?.[item.fileId] || item.url || '')
    : String(item?.url || '')), [imageData, work]);
  const resolveMediaSrc = useCallback((item) => (item?.fileId
    ? (imageData[item.fileId] || work?.imageUrls?.[item.fileId] || '')
    : ''), [imageData, work]);

  // 产物正文里对私有素材的引用也要一起换掉，否则网页预览里全是裂图
  const files = useMemo(() => Object.fromEntries(Object.entries(work?.files || {}).map(([name, content]) => {
    let resolved = String(content ?? '');
    for (const [fileId, url] of Object.entries(imageData)) {
      resolved = resolved.split(`/api/student/file-assets/${fileId}/download`).join(url);
    }
    return [name, resolved];
  })), [work, imageData]);

  const images = useMemo(() => (Array.isArray(work?.images) ? work.images : []), [work]);
  // 做出来的媒体（图/视频/音频）：服务端从画布快照提的那份
  const media = useMemo(() => (Array.isArray(work?.media) ? work.media : []), [work]);
  const artifacts = useMemo(() => (Array.isArray(work?.artifacts) ? work.artifacts : []), [work]);
  const webArtifact = useMemo(() => artifacts.find(isHtmlArtifact) || null, [artifacts]);
  const documentArtifacts = useMemo(() => artifacts.filter(isDocumentArtifact), [artifacts]);
  const selectedDocument = documentArtifacts.find((item) => item.name === activeName)
    || documentArtifacts.find((item) => item.name === work?.preview?.name)
    || documentArtifacts[0]
    || null;
  // 真文件产物（学生创作环境交上来的 PPT/Word/Excel 原文件）：地址由服务端拼好，
  // 预览是服务端转出来的 PDF —— 这类产物没有「规格文本」，客户端渲染不了。
  const documentFile = selectedDocument ? (work?.fileUrls?.[selectedDocument.name] || null) : null;

  // 视图清单：能玩能看优先（用户口径 2026-09-20）。
  const views = useMemo(() => {
    const list = [];
    if (workSource === 'VIBECODING' && webArtifact && Object.hasOwn(files, webArtifact.name)) {
      list.push({ key: 'web', label: '网页', hint: '直接点开玩' });
    }
    // 作品内容（图/视频/音频）：用户 2026-09-21 口径 —— 作品读面要看成出来的东西，画布只是过程。
    // ⚠️ 只用媒体清单（`work.media`）；服务端没给（老 payload）时退回老那套「图片」清单。
    if (media.length) list.push({ key: 'images', label: media.length > 1 ? `作品内容 ${media.length}` : '作品内容' });
    else if (images.length) list.push({ key: 'images', label: images.length > 1 ? `图片 ${images.length}` : '图片' });
    if (documentArtifacts.length) list.push({ key: 'doc', label: '文档' });
    if (workSource === 'CANVAS') list.push({ key: 'canvas', label: '画布' });
    return list;
  }, [workSource, webArtifact, documentArtifacts, images.length, media.length, files]);
  const currentView = views.some((item) => item.key === activeView) ? activeView : (views[0]?.key || '');

  // 网页产物跑在与公开页同一个不透明起源沙箱里，外网一律掐掉（学生代码不该联网）
  const webHtml = webArtifact
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">${buildPreviewDocument(files, webArtifact.name)}`
    : '';

  const back = <Link className="button soft" to="/my-works">← 返回我的作品</Link>;
  const plazaLink = work?.publicUrl ? <Link className="button soft" to={work.publicUrl}>在作品广场看 <ConsoleIcon name="external" size={14} /></Link> : null;
  const status = work ? <span className={`student-badge ${work.plazaPublished ? 'is-ok' : ''}`}>{workPlazaLabel(work)}</span> : null;
  // 「哪门课包的哪一节」——学生要一眼看出来（用户口径 2026-09-20）
  const provenance = work
    ? `${work.seriesTitle || '未绑定课包'} › ${work.courseLessonTitle || '未绑定课时'}`
    : '';
  const viewTabs = views.length > 1 ? <div className="mw-views" role="tablist">
    {views.map((item) => <button
      key={item.key}
      type="button"
      role="tab"
      aria-selected={item.key === currentView}
      className={'mw-view' + (item.key === currentView ? ' is-active' : '')}
      onClick={() => setActiveView(item.key)}
      title={item.hint || item.label}
    >{item.label}</button>)}
  </div> : null;

  if (state.loading) return <main className="inner"><div className="note">✦ <p>正在打开作品…</p></div></main>;
  if (state.error) return <main className="inner"><div className="note">✦ <p>⚠ {state.error}</p></div><div className="work-detail__bar">{back}</div></main>;
  if (!work) return <main className="inner"><div className="note">✦ <p>没有这件作品。</p></div><div className="work-detail__bar">{back}</div></main>;

  const notice = imageError ? <div className="note">✦ <p>{imageError}</p></div> : null;

  if (workSource === 'CANVAS') {
    return <main className="inner work-detail">
      <div className="work-detail__bar">{back}{plazaLink}</div>
      <header className="work-detail__head">
        <p className="work-detail__eyebrow">我的作品 · 画布作品</p>
        <h1>{work.title}</h1>
        {work.description ? <p className="work-detail__desc">{work.description}</p> : null}
        <p className="work-detail__meta">{status}<span className="mw-provenance">{provenance}</span>{work.submittedAt ? <span>提交于 {formatDate(work.submittedAt)}</span> : null}</p>
      </header>
      {notice}
      {viewTabs}
      {currentView === 'images' ? (media.length
        ? <WorkMediaGallery media={media} assets={work?.assets} resolveSrc={resolveMediaSrc} />
        : <ImageGallery list={images} src={resolveImageSrc} />)
        : <div className="work-detail__canvas"><CanvasEditor key={work.id} initialSnapshot={work.canvasSnapshot} readOnly showStarter={false} resolveAssetUrl={resolveAssetUrl} /></div>}
      <div className="work-detail__foot">{plazaLink}{back}</div>
    </main>;
  }

  return <main className="inner">
    <ReplayShell
      embedded
      eyebrow="我的作品 · VibeCoding 作品"
      title={work.title || '未命名作品'}
      meta={<>
        {status}
        <span className="mw-provenance">{provenance}</span>
        {work.submittedAt ? <span>提交于 {formatDate(work.submittedAt)}</span> : null}
      </>}
      actions={<>{plazaLink}{back}</>}
    >
      {work.description ? <p className="c-page__sub">{work.description}</p> : null}
      {notice}
      {viewTabs}
      <div className="mw-stage">
        {currentView === 'web' && webArtifact ? <ReplayPreview html={webHtml} title={work.title || '我的作品'} />
          : currentView === 'images' ? (media.length
            ? <WorkMediaGallery media={media} assets={work?.assets} resolveSrc={resolveMediaSrc} />
            : <ImageGallery list={images} src={resolveImageSrc} />)
            : currentView === 'doc' && selectedDocument ? (documentFile
              ? <ReplayFilePreview url={documentFile.preview} name={selectedDocument.name} />
              // 一件作品里的文档不止一份时才摆切换条 —— 否则另一半东西在这里就摸不到了。
              : <>
                {documentArtifacts.length > 1 ? <div className="c-file-tabs">
                  {documentArtifacts.map((item) => <button
                    key={item.name}
                    type="button"
                    className={`c-file-tab${item.name === selectedDocument.name ? ' is-active' : ''}`}
                    onClick={() => setActiveName(item.name)}
                    title={item.name}
                  >{artifactGroup(item.kind).label}</button>)}
                </div> : null}
                <ReplayPanel title="作品预览" icon="eye" className="c-replay__preview">
                  <ReplayDocument
                    artifact={{ ...selectedDocument, content: String(files[selectedDocument.name] ?? selectedDocument.content ?? '') }}
                    // 配图只在**这份作品快照里出现过的那几张**里找：按幻灯片生成图（下标匹配）、
                    // 学生传的附件图（序号匹配）、内嵌图（fileId 匹配）—— 找不到就留空，不抓任意一张顶上。
                    resolveImage={(slide, slideIndex) => {
                      const generated = selectedDocument.generatedImages?.find((item) => Number(item.slideIndex) === slideIndex && imageData[item.fileId]);
                      if (generated) return imageData[generated.fileId];
                      const ordinal = Number(slide?.image?.attachment ?? slide?.imageAttachment);
                      const attachment = ordinal > 0 && selectedDocument.attachmentImages?.find((item) => Number(item.index) === ordinal && imageData[item.fileId]);
                      if (attachment) return imageData[attachment.fileId];
                      const embedded = selectedDocument.embeddedImages?.find((item) => item.fileId === slide?.image?.fileId && imageData[item.fileId]);
                      if (embedded) return imageData[embedded.fileId];
                      const reference = typeof slide?.image === 'string' ? slide.image : slide?.image?.url || slide?.image?.src;
                      return imageData[fileIdOfAssetUrl(reference)] || null;
                    }}
                    onDownload={selectedDocument.downloadUrl ? () => window.location.assign(selectedDocument.downloadUrl) : null}
                  />
                </ReplayPanel>
              </>)
              : <ReplayPanel title="作品预览" icon="eye" className="c-replay__preview">
                <div className="c-replay__files"><ConsoleEmpty icon="file" title="这份作品没有可预览的产物" body="交上来的文件在下面列着。" /></div>
              </ReplayPanel>}
      </div>
      <div className="c-replay__actions">
        {documentFile?.download ? <button type="button" className="button soft" onClick={() => window.location.assign(documentFile.download)}>
          <ConsoleIcon name="download" size={14} /> 下载原文件《{selectedDocument.name}》
        </button> : null}
      </div>
      {Object.keys(files).length ? <details className="mw-source">
        <summary>它是怎么写出来的（{Object.keys(files).length} 个文件）</summary>
        <ReplayFiles files={files} entryFile={webArtifact?.name || work.entryFile} />
      </details> : null}
    </ReplayShell>
  </main>;
}
