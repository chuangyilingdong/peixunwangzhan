// 官网 - 我的作品
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pagination, workPlazaLabel } from '@platform/shared';

// 状态话术统一走 @platform/shared 的 worksState（两条链路一套词，这里不再自己维护一份）

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MyWorksPage({ api }) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, error: null, items: [], summary: null, page: 1, totalPages: 1 });

  useEffect(() => {
    let live = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    api.get(`student/works?page=${page}`)
      .then((payload) => { if (live) setState({ loading: false, error: null, items: payload?.items || [], summary: payload?.summary || null, page: payload?.page || 1, totalPages: payload?.totalPages || 1 }); })
      .catch((error) => { if (live) setState({ loading: false, error: error.message, items: [], summary: null, page: 1, totalPages: 1 }); });
    return () => { live = false; };
  }, [api, page]);

  const items = state.items;
  const summary = state.summary || { total: items.length, published: items.filter((item) => item.plazaPublished).length };

  return <div className="student-page">
    <header className="student-page-head">
      <h1>我的作品</h1>
      <p>这里是你提交过的课堂作品。作品由平台挑选发布到作品广场。</p>
    </header>

    <div className="student-summary">
      <div className="student-summary-card"><span>作品总数</span><strong>{summary.total}</strong></div>
      <div className="student-summary-card"><span>已上作品广场</span><strong>{summary.published}</strong></div>
    </div>

    {state.loading ? <div className="student-page-state">正在加载作品…</div> : null}
    {state.error ? <div className="student-page-state is-error">⚠ {state.error}<button type="button" onClick={() => setState((current) => ({ ...current, error: null }))}>知道了</button></div> : null}

    {!state.loading && !state.error && items.length === 0 ? <div className="student-page-state">
      ✦ 还没有提交过作品。<br />进入学习，完成一节课后把作品提交上来吧。
      <div className="student-page-actions"><Link className="button" to="/learn">进入学习 <b>↗</b></Link></div>
    </div> : null}

    {items.length ? <div className="student-card-grid">{items.map((work) => <article className="student-card" key={work.id}>
      <div className="student-card__head">
        <h3>{work.title}</h3>
        <span className={`student-badge ${work.plazaPublished ? 'is-ok' : ''}`}>{workPlazaLabel(work)}</span>
      </div>
      <p className="student-card__meta">{work.courseLessonTitle || '未绑定课时'} · {work.className || '未绑定班级'}</p>
      {work.description ? <p className="student-card__desc">{work.description}</p> : null}
      {work.status === 'REJECTED' && work.unpublishReason ? <p className="student-card__desc" data-testid="unpublish-reason"><strong>下架原因：</strong>{work.unpublishReason}</p> : null}
      <p className="student-card__foot">提交于 {formatDate(work.submittedAt)}</p>
    </article>)}</div> : null}

    <Pagination page={state.page} totalPages={state.totalPages} onChange={setPage} disabled={state.loading} />

    {items.length ? <div className="student-page-actions"><Link className="button soft" to="/works">去作品广场看看 <b>↗</b></Link></div> : null}
  </div>;
}
