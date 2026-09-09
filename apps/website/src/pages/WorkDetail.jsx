// 官网 - 公开作品详情（作品广场「打开体验」的落地页）
// 画布作品用只读画布渲染；VibeCoding 作品（token 前缀 vbt_）用 sandbox iframe 直接运行，能玩。
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { buildPreviewDocument, VibePreviewFrame } from '@platform/shared';

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

  return <main className="inner work-detail">
    <div className="work-detail__bar"><Link className="button soft" to="/works">← 返回作品广场</Link></div>

    {state.loading ? <div className="note">✦ <p>正在打开作品…</p></div> : null}
    {state.error ? <div className="note">✦ <p>⚠ {state.error}</p></div> : null}

    {work ? <>
      <header className="work-detail__head">
        <p className="work-detail__eyebrow">{work.featured ? '精选作品' : '学员作品'}{isVibeCoding ? ' · 互动网页' : ''}</p>
        <h1>{work.title}</h1>
        {work.description ? <p className="work-detail__desc">{work.description}</p> : null}
        <p className="work-detail__meta">
          {work.studentName}
          {work.orgName ? ` · ${work.orgName}` : ''}
          {work.submittedAt ? ` · 提交于 ${formatDate(work.submittedAt)}` : ''}
        </p>
      </header>
      {isVibeCoding
        ? <div className="work-detail__play"><VibePreviewFrame html={buildPreviewDocument(work.files, work.entryFile)} title={work.title} /></div>
        : <div className="work-detail__canvas"><CanvasEditor key={work.id} initialSnapshot={work.canvasSnapshot} readOnly showStarter={false} /></div>}
      <div className="work-detail__foot"><Link className="button soft" to="/works">看看更多作品</Link></div>
    </> : null}
  </main>;
}
