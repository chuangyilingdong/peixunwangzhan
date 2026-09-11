// 官网 - 公开作品详情（作品广场「打开体验」的落地页）
// 画布作品用只读画布渲染，保持站点的浅色观感；
// VibeCoding 作品（token 前缀 vbt_）用控制台的深色「舞台」承载——它是要动手玩的东西，
// 独立成一块暗色播放区比塞进浅色正文更合适。学生不手写代码，所以这里给的是
// 「成品预览 + 它是怎么写出来的（只读产物）」，不公开学生的创作对话。
//
// ⚠️ 显示哪一份产物**由服务端的 preview 说了算**（最近产出的那份），不是 entryFile：
// 种子产物 index.html 永远躺在会话里，学生做的是 PPT 时按入口文件挑就会显示成
// 「你好，AI 魔法学院」起始页（这正是这一页此前显示错东西的原因）。
// 文档产物（PPT/Word/Excel）在这里先预览、再下载真文件（下载走公开地址）。
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { artifactGroup, buildPreviewDocument, ConsoleEmpty, ConsoleIcon, ReplayDocument, ReplayFiles, ReplayPanel, ReplayPreview, ReplayShell } from '@platform/shared';

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

export function WorkDetailPage({ api }) {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, error: null, work: null });
  const [activeName, setActiveName] = useState('');

  useEffect(() => {
    let live = true;
    setState({ loading: true, error: null, work: null });
    const path = String(token).startsWith('vbt_') ? 'public/vibecoding-works/' : 'public/works/';
    api.get(path + encodeURIComponent(token))
      .then((payload) => { if (live) setState({ loading: false, error: null, work: payload || null }); })
      .catch((error) => { if (live) setState({ loading: false, error: error.message, work: null }); });
    return () => { live = false; };
  }, [api, token]);

  const work = state.work;
  const isVibeCoding = work?.type === 'VIBECODING';
  // 加载中也要先定好外壳：token 前缀已经说明它是哪一类作品，
  // 不然深色页会先闪一下浅色版式。
  const isVibeToken = String(token).startsWith('vbt_');

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
  // 「它是怎么写出来的」默认停在主产物上（老记录没有产物清单 → 退回入口文件）
  const sourceDefault = current?.name || work?.preview?.name || work?.entryFile;

  if (isVibeToken) {
    const label = current?.document ? artifactGroup(current.kind).label : '互动网页';
    return <main className="inner">
      <ReplayShell
        embedded
        eyebrow={`${work?.featured ? '精选作品' : '学员作品'} · ${label}`}
        title={work?.title || '学员作品'}
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
          <div className="c-replay__grid">
            {/* 一件作品可能既有网页又有文档（学生后面又让 AI 做了份 PPT），
                所以可预览的产物不止一份时才摆切换条 —— 否则另一半东西在广场上就摸不到了。 */}
            <div className="c-replay__stage">
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
                <ReplayPreview html={buildPreviewDocument(files, current.name)} title={work.title} />
              )}
            </div>
            <ReplayPanel title="它是怎么写出来的" icon="code">
              <ReplayFiles files={files} entryFile={sourceDefault} />
            </ReplayPanel>
          </div>
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
        <p className="work-detail__eyebrow">{work.featured ? '精选作品' : '学员作品'}</p>
        <h1>{work.title}</h1>
        {work.description ? <p className="work-detail__desc">{work.description}</p> : null}
        <p className="work-detail__meta">
          {work.studentName}
          {work.orgName ? ` · ${work.orgName}` : ''}
          {work.submittedAt ? ` · 提交于 ${formatDate(work.submittedAt)}` : ''}
        </p>
      </header>
      <div className="work-detail__canvas"><CanvasEditor key={work.id} initialSnapshot={work.canvasSnapshot} readOnly showStarter={false} /></div>
      <div className="work-detail__foot"><Link className="button soft" to="/works">看看更多作品</Link></div>
    </> : null}
  </main>;
}
