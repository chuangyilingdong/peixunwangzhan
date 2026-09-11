// 官网 - 公开作品详情（作品广场「打开体验」的落地页）
// 画布作品用只读画布渲染，保持站点的浅色观感；
// VibeCoding 作品（token 前缀 vbt_）用控制台的深色「舞台」承载——它是要动手玩的东西，
// 独立成一块暗色播放区比塞进浅色正文更合适。学生不手写代码，所以这里给的是
// 「成品预览 + 它是怎么写出来的（只读产物）」，不公开学生的创作对话。
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { buildPreviewDocument, ConsoleEmpty, ReplayFiles, ReplayPanel, ReplayPreview, ReplayShell } from '@platform/shared';

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function WorkDetailPage({ api }) {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, error: null, work: null });

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

  if (isVibeToken) {
    return <main className="inner">
      <ReplayShell
        embedded
        eyebrow={work?.featured ? '精选作品 · 互动网页' : '学员作品 · 互动网页'}
        title={work?.title || '学员作品'}
        meta={work ? (
          <>
            {work.studentName ? <span>{work.studentName}</span> : null}
            {work.orgName ? <span>{work.orgName}</span> : null}
            {work.submittedAt ? <span>提交于 {formatDate(work.submittedAt)}</span> : null}
            <span>右边可以直接点着玩</span>
          </>
        ) : null}
        actions={<Link className="button soft" to="/works">← 返回作品广场</Link>}
      >
        {state.loading ? <ConsoleEmpty icon="sparkle" title="正在打开作品…" /> : null}
        {state.error ? <ConsoleEmpty icon="alert" title="打不开这个作品" body={state.error} /> : null}
        {work ? <>
          {work.description ? <p className="c-page__sub">{work.description}</p> : null}
          <div className="c-replay__grid">
            <ReplayPreview html={buildPreviewDocument(work.files, work.entryFile)} title={work.title} />
            <ReplayPanel title="它是怎么写出来的" icon="code">
              <ReplayFiles files={work.files} entryFile={work.entryFile} />
            </ReplayPanel>
          </div>
          <div className="c-replay__actions">
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
