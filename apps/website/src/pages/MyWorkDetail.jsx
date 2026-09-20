// 官网 - 我的作品 · 单件详情（学生看**自己**的作品）
//
// 为什么要有这一页：「我的作品」原来只能显示状态 —— 卡片上写「平台发布后可查看」，
// 作品没上广场就**打不开**（学生做完的东西自己看不到，这正是用户报的「要实际能用」）。
// 现在每件都能打开：走学生口 `/api/student/works/:source/:id`，那条**只校验「是不是你自己的」，
// 不看发布状态**。
//
// 渲染与公开作品页（WorkDetail.jsx）同一套组件，所以「我自己看」和「广场上别人看」长得一样：
//   · 画布作品 → 只读 CanvasEditor（快照里的私有素材要换成能显示的地址，见下）
//   · VibeCoding → ReplayShell + 产物预览（网页 / 文档 / 真文件转的 PDF）
// ⚠️ 与 org 端 ClassroomWork 是同一件事的两个视角（老师看课堂作品 / 学生看自己的作品），
//    拿数据的形状是同一套（服务端两处对齐了），改渲染时**两边一起想**。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { buildPreviewDocument, ConsoleEmpty, ConsoleIcon, ReplayDocument, ReplayFilePreview, ReplayFiles, ReplayPanel, ReplayPreview, ReplayShell, artifactGroup, formatDate, workPlazaLabel } from '@platform/shared';

// 受鉴权保护的素材（`/api/**`）怎么变成能显示的地址，见共享 api 客户端的 fetchDataUrl
// （要点：<img>/<iframe> 发不出 Authorization 头；而 blob: 在生产的 connect-src 里是被拦的，
//  沙箱 iframe 也拿不到父页面的 blob: —— 所以那两个场合都必须走 data:）。

/** 快照里的私有素材地址 → fileId（服务端拼的 imageUrls 用的就是这个地址）。 */
function fileIdOfAssetUrl(value) {
  return String(value || '').match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:[?#].*)?$/)?.[1] || '';
}

export function MyWorkDetailPage({ api }) {
  const { source, id } = useParams();
  // 路由上的 source 只认这两个值（写成别的就当画布作品，不让拼出乱七八糟的请求）
  const workSource = String(source || '').toUpperCase() === 'VIBECODING' ? 'VIBECODING' : 'CANVAS';
  const [state, setState] = useState({ loading: true, error: null, work: null });
  const [images, setImages] = useState({});
  const [imageError, setImageError] = useState('');
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

  // 作品里的私有素材统一转 data:（上文的说明）。取不到就留空，不让整页跟着挂。
  useEffect(() => {
    let cancelled = false;
    setImages({});
    setImageError('');
    const entries = Object.entries(work?.imageUrls || {});
    if (!entries.length) return () => { cancelled = true; };
    Promise.allSettled(entries.map(async ([fileId, path]) => {
      if (typeof path !== 'string' || !path.startsWith('/api/student/file-assets/')) throw new Error('图片地址不属于这个作品。');
      // ⚠️ 用 fetchDataUrl（直接出 data:），不要 fetchBlobUrl 再自己 fetch：
      //    生产 CSP 是 `connect-src 'self'`，blob: 只在 img-src 白名单里 —— 再 fetch 会被拦成 "Failed to fetch"。
      return [fileId, await api.fetchDataUrl(path)];
    })).then((results) => {
      if (cancelled) return;
      setImages(Object.fromEntries(results.filter((item) => item.status === 'fulfilled' && item.value).map((item) => item.value)));
      if (results.some((item) => item.status === 'rejected')) setImageError('部分作品图片不可用，已保留其余图片。');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, work]);

  // 画布节点的素材地址 → data:（CanvasEditor 收同步值或 Promise 都行，见它的 useDisplayUrl）
  const resolveAssetUrl = useCallback((value) => images[fileIdOfAssetUrl(value)] || null, [images]);

  // 产物正文里对私有素材的引用也要一起换掉，否则网页预览里全是裂图
  const files = useMemo(() => Object.fromEntries(Object.entries(work?.files || {}).map(([name, content]) => {
    let resolved = String(content ?? '');
    for (const [fileId, url] of Object.entries(images)) {
      resolved = resolved.split(`/api/student/file-assets/${fileId}/download`).join(url);
    }
    return [name, resolved];
  })), [work, images]);

  const artifacts = useMemo(() => (Array.isArray(work?.artifacts) ? work.artifacts : []), [work]);
  // 能预览的产物：文档（PPT/Word/Excel）与可运行的网页；其它文件只在右边列源码。
  const views = useMemo(() => artifacts.filter((item) => item.document
    || ['pptx', 'docx', 'xlsx', 'html', 'htm'].includes(String(item.kind).toLowerCase())
    || /\.html?$/i.test(item.name)), [artifacts]);
  const selected = views.find((item) => item.name === activeName)
    || views.find((item) => item.name === work?.preview?.name)
    || views.find((item) => item.name === work?.entryFile)
    || views[0]
    || null;
  const entry = selected?.name || work?.entryFile || '';
  const isDocument = Boolean(selected && (selected.document || ['pptx', 'docx', 'xlsx'].includes(String(selected.kind).toLowerCase())));
  // 真文件产物（学生创作环境交上来的 PPT/Word/Excel 原文件）：地址由服务端拼好，
  // 预览是服务端转出来的 PDF —— 这类产物没有「规格文本」，客户端渲染不了。
  const documentFile = isDocument ? (work?.fileUrls?.[selected.name] || null) : null;
  // 网页产物跑在与公开页同一个不透明起源沙箱里，外网一律掐掉（学生代码不该联网）
  const html = workSource === 'VIBECODING' && entry && !isDocument && Object.hasOwn(files, entry)
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">${buildPreviewDocument(files, entry)}`
    : '';

  const back = <Link className="button soft" to="/my-works">← 返回我的作品</Link>;
  const plazaLink = work?.publicUrl
    ? <Link className="button soft" to={work.publicUrl}>在作品广场看 <ConsoleIcon name="external" size={14} /></Link>
    : null;
  const status = work ? <span className={`student-badge ${work.plazaPublished ? 'is-ok' : ''}`}>{workPlazaLabel(work)}</span> : null;

  if (state.loading) return <main className="inner"><div className="note">✦ <p>正在打开作品…</p></div></main>;
  if (state.error) return <main className="inner"><div className="note">✦ <p>⚠ {state.error}</p></div><div className="work-detail__bar">{back}</div></main>;
  if (!work) return <main className="inner"><div className="note">✦ <p>没有这件作品。</p></div><div className="work-detail__bar">{back}</div></main>;

  if (workSource === 'CANVAS') {
    return <main className="inner work-detail">
      <div className="work-detail__bar">{back}{plazaLink}</div>
      <header className="work-detail__head">
        <p className="work-detail__eyebrow">我的作品 · 画布作品</p>
        <h1>{work.title}</h1>
        {work.description ? <p className="work-detail__desc">{work.description}</p> : null}
        <p className="work-detail__meta">{status}{work.submittedAt ? ` · 提交于 ${formatDate(work.submittedAt)}` : ''}</p>
      </header>
      {imageError ? <div className="note">✦ <p>{imageError}</p></div> : null}
      <div className="work-detail__canvas"><CanvasEditor key={work.id} initialSnapshot={work.canvasSnapshot} readOnly showStarter={false} resolveAssetUrl={resolveAssetUrl} /></div>
      <div className="work-detail__foot">{plazaLink}{back}</div>
    </main>;
  }

  return <main className="inner">
    <ReplayShell
      embedded
      eyebrow={`我的作品 · ${selected?.document ? artifactGroup(selected.kind).label : 'VibeCoding 作品'}`}
      title={work.title || '未命名作品'}
      meta={<>
        {status}
        {work.submittedAt ? <span>提交于 {formatDate(work.submittedAt)}</span> : null}
        <span>{documentFile ? '右边预览的是转出来的 PDF，原文件可下载' : isDocument ? '右边可以先预览' : '右边可以直接点着玩'}</span>
      </>}
      actions={<>{plazaLink}{back}</>}
    >
      {work.description ? <p className="c-page__sub">{work.description}</p> : null}
      {imageError ? <div className="note">✦ <p>{imageError}</p></div> : null}
      <div className="c-replay__grid">
        <div className="c-replay__stage">
          {/* 一件作品可能既有网页又有文档（学生后面又让 AI 做了份 PPT），
              可预览的产物不止一份时才摆切换条 —— 否则另一半东西在这里就摸不到了。 */}
          {views.length > 1 ? <div className="c-file-tabs">
            {views.map((item) => <button
              key={item.name}
              type="button"
              className={`c-file-tab${item.name === selected?.name ? ' is-active' : ''}`}
              onClick={() => setActiveName(item.name)}
              title={item.name}
            >{item.document ? artifactGroup(item.kind).label : '网页'}</button>)}
          </div> : null}
          {!selected ? <ReplayPanel title="作品预览" icon="eye" className="c-replay__preview">
            <div className="c-replay__files"><ConsoleEmpty icon="file" title="这份作品没有可预览的产物" body="交上来的文件只能在右边看源码。" /></div>
          </ReplayPanel>
            : documentFile ? <ReplayFilePreview url={documentFile.preview} name={selected.name} />
              : isDocument ? <ReplayPanel title="作品预览" icon="eye" className="c-replay__preview">
                <ReplayDocument
                  artifact={{ ...selected, content: String(files[selected.name] ?? selected.content ?? '') }}
                  // 配图只在**这份作品快照里出现过的那几张**里找：按幻灯片生成图（下标匹配）、
                  // 学生传的附件图（序号匹配）、内嵌图（fileId 匹配）—— 找不到就留空，不抓任意一张顶上。
                  resolveImage={(slide, slideIndex) => {
                    const generated = selected.generatedImages?.find((item) => Number(item.slideIndex) === slideIndex && images[item.fileId]);
                    if (generated) return images[generated.fileId];
                    const ordinal = Number(slide?.image?.attachment ?? slide?.imageAttachment);
                    const attachment = ordinal > 0 && selected.attachmentImages?.find((item) => Number(item.index) === ordinal && images[item.fileId]);
                    if (attachment) return images[attachment.fileId];
                    const embedded = selected.embeddedImages?.find((item) => item.fileId === slide?.image?.fileId && images[item.fileId]);
                    if (embedded) return images[embedded.fileId];
                    const reference = typeof slide?.image === 'string' ? slide.image : slide?.image?.url || slide?.image?.src;
                    return images[fileIdOfAssetUrl(reference)] || null;
                  }}
                  onDownload={selected.downloadUrl ? () => window.location.assign(selected.downloadUrl) : null}
                />
              </ReplayPanel>
                // ⚠️ ReplayPreview **自己**带「作品预览」标题栏，别再包一层 ReplayPanel ——
                //    包了就出现两层一模一样的标题（2026-09-20 线上截图里看到的）。
                : html ? <ReplayPreview html={html} title={work.title || '我的作品'} />
                  : <ReplayPanel title="作品预览" icon="eye" className="c-replay__preview">
                    <div className="c-replay__files"><ConsoleEmpty icon="file" title="这份作品没有可预览的产物" body="交上来的文件只能在右边看源码。" /></div>
                  </ReplayPanel>}
        </div>
        <ReplayPanel title="它是怎么写出来的" icon="code">
          <ReplayFiles files={files} entryFile={entry} />
        </ReplayPanel>
      </div>
      <div className="c-replay__actions">
        {documentFile?.download ? <button type="button" className="button soft" onClick={() => window.location.assign(documentFile.download)}>
          <ConsoleIcon name="download" size={14} /> 下载原文件《{selected.name}》
        </button> : null}
      </div>
    </ReplayShell>
  </main>;
}
