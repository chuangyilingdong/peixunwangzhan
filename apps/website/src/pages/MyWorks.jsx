// 官网 - 我的作品
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pagination, workPlazaLabel } from '@platform/shared';

// 状态话术统一走 @platform/shared 的 worksState（两条链路一套词，这里不再自己维护一份）

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 作品类型只看服务端给的产物线索：VibeCoding 的看产物文件名，画布的就是画布作品。
// 不做「猜内容」的花活 —— 猜错比不显示更糟。
function workType(work) {
  const name = String(work.entryFile || '').toLowerCase();
  if (name) {
    if (/\.pptx?$/.test(name)) return { label: 'VibeCoding · 演示文稿', icon: '📊' };
    if (/\.docx?$/.test(name)) return { label: 'VibeCoding · 文档', icon: '📄' };
    if (/\.xlsx?$/.test(name)) return { label: 'VibeCoding · 表格', icon: '📈' };
    return { label: 'VibeCoding · 网页应用', icon: '💻' };
  }
  return { label: '画布作品', icon: '🎨' };
}

export function MyWorksPage({ api }) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, error: null, items: [], summary: null, page: 1, totalPages: 1 });
  const [search, setSearch] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [lessonFilter, setLessonFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

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

  // 筛选在**当前这一页**上做：分页由服务端管，这里只是把这一页看窄一点，不假装能跨页筛。
  const courses = useMemo(() => [...new Set(items.map((item) => item.seriesTitle).filter(Boolean))], [items]);
  const lessons = useMemo(() => [...new Set(items.filter((item) => !courseFilter || item.seriesTitle === courseFilter).map((item) => item.courseLessonTitle).filter(Boolean))], [items, courseFilter]);
  const types = useMemo(() => [...new Set(items.map((item) => workType(item).label))], [items]);
  const visible = items.filter((work) => {
    const keyword = search.trim().toLowerCase();
    if (keyword && !`${work.title || ''} ${work.courseLessonTitle || ''} ${work.sessionTitle || ''}`.toLowerCase().includes(keyword)) return false;
    if (courseFilter && work.seriesTitle !== courseFilter) return false;
    if (lessonFilter && work.courseLessonTitle !== lessonFilter) return false;
    if (typeFilter && workType(work).label !== typeFilter) return false;
    return true;
  });

  return <div className="student-page">
    <header className="student-page-head">
      <h1>我的作品</h1>
      <p>查看你在课程中生成与归档的作品。</p>
    </header>

    <div className="student-work-toolbar">
      <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索作品" placeholder="搜索作品名称、关键词（如：海报、代码、视频…）" />
      <select value={courseFilter} onChange={(event) => { setCourseFilter(event.target.value); setLessonFilter(''); }} aria-label="按课包筛选">
        <option value="">全部课包</option>{courses.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <select value={lessonFilter} onChange={(event) => setLessonFilter(event.target.value)} aria-label="按课程筛选">
        <option value="">全部课程</option>{lessons.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="按作品类型筛选">
        <option value="">全部作品类型</option>{types.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <span className="student-work-toolbar__count"><strong>{summary.total}</strong>个作品 · 已上广场 {summary.published}</span>
    </div>

    {state.loading ? <div className="student-page-state">正在加载作品…</div> : null}
    {state.error ? <div className="student-page-state is-error">⚠ {state.error}<button type="button" onClick={() => setState((current) => ({ ...current, error: null }))}>知道了</button></div> : null}

    {!state.loading && !state.error && items.length === 0 ? <div className="student-page-state">
      ✦ 还没有提交过作品。<br />进入学习，完成一节课后把作品提交上来吧。
      <div className="student-page-actions"><Link className="button" to="/learn">进入学习 <b>↗</b></Link></div>
    </div> : null}

    {items.length && !visible.length ? <div className="student-page-state">这一页里没有符合条件的作品。换一个关键词，或清空筛选。</div> : null}

    {visible.length ? <div className="student-card-grid">{visible.map((work) => {
      const type = workType(work);
      return <article className="student-card" key={work.id}>
        <div className="student-work-card__cover">
          <span className="student-work-card__icon">{type.icon}</span>
          <span className="student-work-card__type">{type.label}</span>
        </div>
        <div className="student-card__head">
          <h3>{work.title}</h3>
          <span className={`student-badge ${work.plazaPublished ? 'is-ok' : ''}`}>{workPlazaLabel(work)}</span>
        </div>
        <p className="student-work-card__source">来自：{work.seriesTitle || '未绑定课包'} › {work.courseLessonTitle || '未绑定课程'}</p>
        {work.description ? <p className="student-card__desc">{work.description}</p> : null}
        {work.status === 'REJECTED' && work.unpublishReason ? <p className="student-card__desc" data-testid="unpublish-reason"><strong>下架原因：</strong>{work.unpublishReason}</p> : null}
        <div className="student-work-card__foot">
          <span>创建时间 {formatDate(work.submittedAt)}</span>
          {/* ⭐ 每件作品都要能打开看（用户口径 2026-09-20：「我的作品要实际能用」）。
              原来这里只在**已上广场**时才给「查看 →」，其余写「平台发布后可查看」= 学生做完的东西自己看不到。
              现在统一进学生自己的作品页 /my-works/:source/:id —— 那条接口只校验「是不是你自己的」，
              不看发布状态；作品上了广场，详情页里另给「在作品广场看」。
              （广场页的直链收进详情页是有意的：页脚那个胶囊一多就糊成一片。） */}
          <Link to={`/my-works/${work.source || 'CANVAS'}/${encodeURIComponent(work.id)}`}>打开作品 →</Link>
        </div>
      </article>;
    })}</div> : null}

    <Pagination page={state.page} totalPages={state.totalPages} onChange={setPage} disabled={state.loading} />

    {items.length ? <div className="student-page-actions"><Link className="button soft" to="/works">去作品广场看看 <b>↗</b></Link></div> : null}
  </div>;
}
