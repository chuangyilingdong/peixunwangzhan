// 官网 - 公开作品详情（作品广场「打开体验」的落地页）
// 画布作品用只读画布渲染，保持站点的浅色观感；
// VibeCoding 作品（token 前缀 vbt_）用控制台的深色「舞台」承载——它是要动手玩的东西，
// 独立成一块暗色播放区比塞进浅色正文更合适。学生不手写代码，所以这里给的是
// 「成品预览 + 它是怎么写出来的（只读产物）」，不公开学生的创作对话。
//
// ⚠️ 显示哪一份产物由服务端按提交时的 entryFile 决定；每条提交只包含该主产物及必要依赖。
// 文档产物（PPT/Word/Excel）在这里先预览、再下载真文件（下载走公开地址）。
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { artifactGroup, buildPreviewDocument, ConsoleEmpty, ConsoleIcon, ReplayDocument, ReplayFilePreview, ReplayPanel, ReplayPreview, ReplayShell, WorkMediaGallery, resolveWorkMediaUrl } from '@platform/shared';

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 预览目标：一份产物（文档或网页）+ 它的正文 */
function withContent(item, files) {
  return { ...item, content: String(files?.[item.name] ?? '') };
}

/**
 * ⭐ 2026-09-27：这一页现在有**两条入口**，靠路由参数自己分辨（不用调用方传标志位）：
 *   · `/works/:token`（作品广场）—— 按作品分享码取数（只可能是已公开的）；
 *   · `/u/:token/w/:source/:id`（学生个人主页里点开一件）—— 按**主页 token + 作品 id** 取数。
 *     为什么要第二条：个人主页要列**全部**作品（含未公开的，它们没有 share_token，按分享码取不到）。
 */
export function WorkDetailPage({ api }) {
  const { token, source, id } = useParams();
  const creatorScoped = Boolean(source && id);
  // 「是不是 VibeCoding」在主页那条路上由路由里的 source 决定，普通公开页仍按 token 前缀判
  const vibe = creatorScoped
    ? String(source || '').toUpperCase() === 'VIBECODING'
    : String(token).startsWith('vbt_');
  const [state, setState] = useState({ loading: true, error: null, work: null });
  const [activeName, setActiveName] = useState('');
  // 作品先用**媒体**看（图/视频/音频），画布放到第二个标签（用户 2026-09-21 口径）。
  const [view, setView] = useState('media');
  // 站内素材（`/api/student/file-assets/…`）要转成 data: 才显示得出（<img> 发不出 Authorization 头）；
  // 上游图床的 https 外链原样用（与「我的作品」那一屏同一条规则）。
  const [imageData, setImageData] = useState({});

  useEffect(() => {
    let live = true;
    setState({ loading: true, error: null, work: null });
    const path = creatorScoped
      ? `public/creators/${encodeURIComponent(token)}/works/${encodeURIComponent(String(source || 'CANVAS').toUpperCase())}/${encodeURIComponent(id)}`
      : (vibe ? 'public/vibecoding-works/' : 'public/works/') + encodeURIComponent(token);
    api.get(path)
      .then((payload) => { if (live) setState({ loading: false, error: null, work: payload || null }); })
      .catch((error) => { if (live) setState({ loading: false, error: error.message, work: null }); });
    return () => { live = false; };
  }, [api, token, source, id, creatorScoped, vibe]);

  const work = state.work;
  // 作品里挂的站内素材 → data:（拿得到就换，拿不到就让 <img> 拿原地址试 —— 公开作品的外链本来就能显示）
  useEffect(() => {
    let cancelled = false;
    const entries = Object.entries(work?.imageUrls || {});
    if (!entries.length) { setImageData({}); return () => { cancelled = true; }; }
    Promise.allSettled(entries.map(async ([fileId, path]) => {
      if (typeof path !== 'string' || !path.startsWith('/api/student/file-assets/')) throw new Error('图片地址不属于这个作品。');
      return [fileId, await api.fetchDataUrl(path)];
    })).then((results) => {
      if (cancelled) return;
      setImageData(Object.fromEntries(results.filter((item) => item.status === 'fulfilled' && item.value).map((item) => item.value)));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, work]);
  // 媒体网格的地址解析表（2026-09-27 修「图片已失效」）：
  //   公开作品的 `media` 里，服务端**已经把站内素材换成了这份作品专属的公开代理地址**
  //   （见 routes/communication/public.js），但这里原来只认 `imageUrls` 那份映射 ——
  //   公开接口根本不返回 imageUrls → 每张图都解析成空串 → 整片「图片已失效」（用户 2026-09-27 报的图1）。
  //   现在交给共享的 `resolveWorkMediaUrl`：只有**学生域**地址才需要映射（映射不到返回 null，
  //   画廊显示占位），公开代理 / 同源相对地址 / https 外链一律原样放行。
  //   ⚠️ `imageData`（老的学生域→data: 那条路）放最后：它要是真有值，说明字节已经拿在手上，优先用它。
  const mediaImageUrls = useMemo(() => {
    const map = { ...(work?.imageUrls || {}) };
    for (const item of work?.media || []) if (item?.fileId && item.url) map[item.fileId] = item.url;
    return { ...map, ...imageData };
  }, [work, imageData]);
  const isVibeCoding = work?.type === 'VIBECODING';
  // 「创作画布」那一档也要把快照里的地址换掉，否则访客看到的是**整屏破图**：
  // 快照里存的是学生域地址 `/api/student/file-assets/<id>/download`，访客没登录、那条路必然 401
  // （2026-09-25 生产实测：画布上那张图 naturalWidth=0）。换成这份作品专属的公开代理 ——
  // 服务端已经在 `media` 里给了同样的地址（见 routes/communication/public.js 那段说明），照着映射即可。
  const canvasImage = (value) => {
    const raw = String(value || '');
    const match = raw.match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:[?#].*)?$/);
    if (!match) return raw;   // 上游图床的外链、data:、站内相对地址都原样用
    return (work?.media || []).find((item) => item.fileId === match[1])?.url || null;
  };
  // 加载中也要先定好外壳：主页那条路用路由里的 source，普通公开页按 token 前缀判，
  // 不然深色页会先闪一下浅色版式。
  const isVibeToken = vibe;

  const files = work?.files || {};
  const catalog = useMemo(() => (Array.isArray(work?.artifacts) ? work.artifacts : []), [work]);
  // 能预览的产物：文档（PPT/Word/Excel）与可运行的网页。其它文件只在右边列源码。
  const views = useMemo(() => catalog
    .filter((item) => item.document || /^html?$/i.test(String(item.kind)))
    .map((item) => withContent(item, files)), [catalog, files]);
  const current = useMemo(
    () => views.find((item) => item.name === activeName)
      || views.find((item) => item.name === work?.preview?.name)
      || views.find((item) => item.document)
      || views[0]
      || null,
    [views, activeName, work],
  );
  // （原来这里还有一个 `sourceDefault`：「它是怎么写出来的」那个源码清单默认停在哪个文件。
  //   2026-09-27 用户口径把那块删掉之后它没有调用方了，一并删。）

  if (isVibeToken) {
    const label = current?.document ? artifactGroup(current.kind).label : '互动网页';
    return <main className="inner">
      <ReplayShell
        embedded
        eyebrow={`${work?.featured ? '精选作品' : '学生作品'} · ${label}`}
        title={work?.title || '学生作品'}
        meta={work ? (
          <>
            {work.studentName ? <span>{work.studentName}</span> : null}
            {work.orgName ? <span>{work.orgName}</span> : null}
            {work.submittedAt ? <span>提交于 {formatDate(work.submittedAt)}</span> : null}
            <span>{current?.document ? '右边可以先预览，也能下载原文件' : '右边可以直接点着玩'}</span>
          </>
        ) : null}
        actions={<Link className="button soft" to="/works">← 返回作品广场</Link>}
      >
        {state.loading ? <ConsoleEmpty icon="sparkle" title="正在打开作品…" /> : null}
        {state.error ? <ConsoleEmpty icon="alert" title="打不开这个作品" body={state.error} /> : null}
        {work ? <>
          {work.description ? <p className="c-page__sub">{work.description}</p> : null}
          {/* 用户口径 2026-09-25：「网页展示应该是直接显示作品啊」——原来预览与源码**并排**，
              作品只占一半宽（截图里右边半屏全是源码）。现在作品占满整行，源码收进下面的折叠区
              （与「我的作品」页同一套做法，.mw-source）；想看过程仍然点得开。 */}
          <div className="c-replay__grid is-focus">
            {/* 一件作品可能既有网页又有文档（学生后面又让 AI 做了份 PPT），
                所以可预览的产物不止一份时才摆切换条 —— 否则另一半东西在广场上就摸不到了。 */}
            {/* ⚠️ 网页作品这一档外面还要 `--flow`：`.c-replay__stage` 默认是**固定 62vh + overflow:hidden**
                （文档预览那档要它），用在自适应网页上就把作品裁在 595px 高的小框里 ——
                用户 2026-09-30 报的"那么小的界面"就是它。文档/空态那一档保持原样。 */}
            {/* ⭐ 2026-10-03 用户口径：「我不希望网页作品可滚动，体验非常差……必须是自适应的，
                不要有滚动」—— 网页作品这一档改 `--screen`：**占满一屏**（视口高 − 这一页的头尾），
                里面 `fill` 铺满、原生比例、无缩放；作品自身按容器自适应、滚动条只在作品**内部**
                （页面本身不再滚）。文档/空态那一档保持原来的 62vh 固定舞台。 */}
            <div className={`c-replay__stage${current && !current.document ? ' c-replay__stage--screen' : ''}`}>
              {views.length > 1 ? (
                <div className="c-file-tabs">
                  {views.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      className={`c-file-tab${item.name === current.name ? ' is-active' : ''}`}
                      onClick={() => setActiveName(item.name)}
                      title={item.name}
                    >
                      {item.document ? artifactGroup(item.kind).label : '网页'}
                    </button>
                  ))}
                </div>
              ) : null}
              {!current ? (
                <ReplayPanel title="作品预览" icon="eye" className="c-replay__preview">
                  <div className="c-replay__files"><ConsoleEmpty icon="file" title="这份作品没有可预览的产物" body="交上来的文件只能在右边看源码。" /></div>
                </ReplayPanel>
              ) : current.document && current.storage === 'FILE' ? (
                // 存的是**真文件**（学生创作环境交上来的 PPT/Word/Excel 原文件）：
                // 服务端已经把它转成 PDF，这里只负责显示；下载仍给原文件。
                <ReplayFilePreview url={current.previewUrl} name={current.name} />
              ) : current.document ? (
                <ReplayPanel title="作品预览" icon="eye" className="c-replay__preview">
                  <ReplayDocument
                    artifact={current}
                    downloadLabel="下载文件"
                    // 配图地址由服务端按提交快照拼好：平台插画按幻灯片下标（-1 是封面），
                    // 学生传的图按序号（规格里的 {"attachment": N}）。与工作台同一个口径。
                    resolveImage={(slide, slideIndex) => {
                      const images = current.images || {};
                      const generated = images.generated?.[String(slideIndex)];
                      if (generated) return generated;
                      const ordinal = Number(slide?.image?.attachment ?? slide?.imageAttachment);
                      return ordinal ? (images.attachment?.[String(ordinal)] || null) : null;
                    }}
                    onDownload={current.downloadUrl ? () => window.location.assign(current.downloadUrl) : null}
                  />
                </ReplayPanel>
              ) : (
                // ⭐ 2026-09-30 用户口径：「怎么玩？那么小的界面……为什么非要用作品预览把作品框上呢？不需要这些东西」
                //    → 看作品这一档**去掉面板、去掉缩放**：宽度＝容器真实宽度（学生页自己的媒体查询生效，
                //      电脑端与手机端各自长成它自己的样子），高度跟着内容走。见 PreviewFrame 的 responsive。
                <ReplayPreview html={buildPreviewDocument(files, current.name)} title={work.title} chrome={false} fill />
              )}
            </div>
          </div>
          {/* ⚠️ 2026-09-27 用户口径：「代码作品这里是无限延长的，很难看，这块直接删除」——
              原来这里是一个 `<details>它是怎么写出来的（N 个文件）</details>` 的**源码清单**
              （`ReplayFiles` 把每个文件的正文整段铺开，一个 HTML 就是几屏）。
              成品预览（上面那个 iframe / PDF）与「下载《文件名》」都还在，改代码想看正文就下载。
              `ReplayFiles` 这个组件本身还给别处用（机构端/学生端），没删。 */}
          <div className="c-replay__actions">
            {current?.downloadUrl ? (
              <button type="button" className="button soft" onClick={() => window.location.assign(current.downloadUrl)}>
                <ConsoleIcon name="download" size={14} /> 下载《{current.name}》
              </button>
            ) : null}
            <Link className="button soft" to="/works">看看更多作品</Link>
          </div>
        </> : null}
      </ReplayShell>
    </main>;
  }

  return <main className="inner work-detail">
    <div className="work-detail__bar"><Link className="button soft" to="/works">← 返回作品广场</Link></div>

    {state.loading ? <div className="note">✦ <p>正在打开作品…</p></div> : null}
    {state.error ? <div className="note">✦ <p>⚠ {state.error}</p></div> : null}

    {work && !isVibeCoding ? <>
      <header className="work-detail__head">
        <p className="work-detail__eyebrow">{work.featured ? '精选作品' : '学生作品'}</p>
        <h1>{work.title}</h1>
        {work.description ? <p className="work-detail__desc">{work.description}</p> : null}
        <p className="work-detail__meta">
          {work.studentName}
          {work.orgName ? ` · ${work.orgName}` : ''}
          {work.submittedAt ? ` · 提交于 ${formatDate(work.submittedAt)}` : ''}
        </p>
      </header>
      {/* 作品先给人看**做出来的东西**（图/视频/音频），画布只是过程（想看点一下切过去）。
          用户 2026-09-21：「图4 作品发布后，网站显示的是画布内容，应该显示的是图片/视频/音频等等，
          而不是画布」。 */}
      <div className="work-detail__views" role="tablist">
        <button type="button" role="tab" aria-selected={view === 'media'} className={'work-detail__tab' + (view === 'media' ? ' is-active' : '')} onClick={() => setView('media')}>作品内容</button>
        <button type="button" role="tab" aria-selected={view === 'canvas'} className={'work-detail__tab' + (view === 'canvas' ? ' is-active' : '')} onClick={() => setView('canvas')}>创作画布</button>
      </div>
      {view === 'canvas'
        ? <div className="work-detail__canvas"><CanvasEditor key={work.id} initialSnapshot={work.canvasSnapshot} readOnly showStarter={false} resolveAssetUrl={canvasImage} /></div>
        : <WorkMediaGallery media={work.media} assets={work.assets} resolveSrc={(item) => resolveWorkMediaUrl(item?.url, mediaImageUrls) || ''} />}
      <div className="work-detail__foot"><Link className="button soft" to="/works">看看更多作品</Link></div>
    </> : null}
  </main>;
}
