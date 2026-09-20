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
// `hue` / `art` 是给下面的自动封面用的：类型决定配色家族与插画，所以一排作品看着是一套。
function workType(work) {
  const name = String(work.entryFile || '').toLowerCase();
  if (name) {
    if (/\.pptx?$/.test(name)) return { key: 'DECK', label: 'VibeCoding · 演示文稿', icon: '📊', hue: 28, art: 'deck' };
    if (/\.docx?$/.test(name)) return { key: 'DOC', label: 'VibeCoding · 文档', icon: '📄', hue: 168, art: 'doc' };
    if (/\.xlsx?$/.test(name)) return { key: 'SHEET', label: 'VibeCoding · 表格', icon: '📈', hue: 212, art: 'sheet' };
    return { key: 'WEB', label: 'VibeCoding · 网页应用', icon: '💻', hue: 262, art: 'web' };
  }
  return { key: 'CANVAS', label: '画布作品', icon: '🎨', hue: 322, art: 'canvas' };
}

/**
 * **作品封面**（用户口径 2026-09-20：「学生发布的作品应该自动生成个封面」）。
 *
 * 学生不会自己传封面，所以封面必须**自己长出来**。两层：
 *   ① 服务端给了真封面（`coverUrl`，将来是作品的截图）→ 直接用它；
 *   ② 没有 → 用作品自身的信息**当场画一张**：类型定色系与插画，标题哈希做小幅色相偏移
 *      （同一类型的几个作品互相区分得开），标题首字当水印。
 * 刻意不引入任何图片资源：SVG 是内联的，不占带宽、不产生 404，也不依赖服务端。
 *
 * ⚠️ 为什么不用"猜内容"的花活（比如按标题选吉祥物）：猜错比留个中性的封面更糟。
 */
function coverSeed(work) {
  const text = String(work.id || work.title || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 100003;
  return hash;
}

function CoverArt({ art }) {
  switch (art) {
    case 'web': return <g><rect x="0" y="0" width="30" height="21" rx="3" /><rect x="11" y="23" width="8" height="3" rx="1.5" /><rect x="6" y="27" width="18" height="2.4" rx="1.2" /></g>;
    case 'deck': return <g><rect x="0" y="1" width="30" height="19" rx="3" /><rect x="5" y="6" width="12" height="2.6" rx="1.3" /><rect x="5" y="11" width="18" height="2.6" rx="1.3" /><rect x="5" y="16" width="8" height="2.6" rx="1.3" /></g>;
    case 'doc': return <g><rect x="1" y="0" width="26" height="30" rx="3" /><rect x="6" y="7" width="16" height="2.4" rx="1.2" /><rect x="6" y="13" width="16" height="2.4" rx="1.2" /><rect x="6" y="19" width="10" height="2.4" rx="1.2" /></g>;
    case 'sheet': return <g><rect x="0" y="2" width="30" height="26" rx="3" /><rect x="0" y="10" width="30" height="2" /><rect x="0" y="18" width="30" height="2" /><rect x="15" y="2" width="2" height="26" /></g>;
    case 'canvas': return <g><circle cx="15" cy="15" r="14" /><circle cx="10" cy="11" r="2.6" fill="#00000055" /><circle cx="20" cy="11" r="2.6" fill="#00000055" /><circle cx="10" cy="20" r="2.6" fill="#00000055" /><circle cx="20" cy="20" r="2.6" fill="#00000055" /></g>;
    default: return null;
  }
}

function WorkCover({ work, type }) {
  if (work.coverUrl) return <img src={work.coverUrl} alt="" loading="lazy" />;
  const seed = coverSeed(work);
  // ⚠️ 色相要**拉得开**：第一版只抖 ±12°，一排作品全是同一个粉色，等于还是"一个样"
  //    （实测 15 张画布作品的封面几乎分不出来）。现在在类型色系左右各 45° 里取，
  //    既看得出是同一类、又能一眼区分 — 同一份种子还决定下面用哪种构图。
  const hue = ((type.hue + (seed % 91) - 45) % 360 + 360) % 360;
  const gradientId = `workcover-${String(work.id || 'x').replace(/[^A-Za-z0-9_-]/g, '')}`;
  const mark = String(work.title || '作').trim().charAt(0) || '作';
  const layout = seed % 3;
  return <svg className="student-work-card__art" viewBox="0 0 320 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={`hsl(${hue} 56% ${50 + (seed % 9)}%)`} />
        <stop offset="1" stopColor={`hsl(${(hue + 26) % 360} 70% ${70 + (seed % 7)}%)`} />
      </linearGradient>
    </defs>
    <rect width="320" height="150" fill={`url(#${gradientId})`} />
    {/* 三种构图轮着来：圆环 / 斜带 / 点阵 —— 同一份种子决定，所以同一件作品永远同一张 */}
    {layout === 0 ? <g fill="#ffffff" opacity="0.12">
      <circle cx={276} cy={22} r={62} />
      <circle cx={30} cy={140} r={48} />
    </g> : null}
    {layout === 1 ? <g fill="#ffffff" opacity="0.10" transform="rotate(-18 160 75)">
      <rect x={-40} y={22} width={420} height={26} rx={13} />
      <rect x={-40} y={72} width={420} height={14} rx={7} />
      <rect x={-40} y={104} width={420} height={20} rx={10} />
    </g> : null}
    {layout === 2 ? <g fill="#ffffff" opacity="0.13">
      {[0, 1, 2, 3].map((row) => [0, 1, 2, 3, 4].map((col) => <circle key={`${row}-${col}`} cx={252 + col * 18} cy={28 + row * 18} r={3.4} />))}
    </g> : null}
    <text x="22" y="128" fill="#ffffff" opacity="0.22" fontSize={96 + (seed % 18)} fontWeight="900" fontFamily="inherit">{mark}</text>
    <g transform="translate(266,86) scale(1.7)" fill="#ffffff" opacity="0.92"><CoverArt art={type.art} /></g>
  </svg>;
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
          <WorkCover work={work} type={type} />
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
