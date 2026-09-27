// 官网 - 我的作品
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pagination, readSession, workPlazaLabel } from '@platform/shared';

// 状态话术统一走 @platform/shared 的 worksState（两条链路一套词，这里不再自己维护一份）

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

/**
 * 学生端「我的作品」——**个人主页 + 卡片网格**的展示形式（2026-09-27 用户口径）。
 *
 * 用户原话：「图2 是手机页面打开『我的作品』的展示样式，能否做成像图3 这样的样式……当然图2 有些
 * 没用的可以不要，我说的是整体展示形式。也可以有头像这些在。」（图3 是社区类 App 的个人主页）
 *
 * 于是这一版：
 *   · 顶部换成**头像 + 名字 + 一行统计**（N 个作品 / 已上广场 M），不再是孤零零一行大标题；
 *   · 主体是**封面优先的两列网格**（手机两列，宽屏三到四列），整张卡可点开；
 *   · 砍掉三个下拉筛选（课包 / 课程 / 类型）与卡上「来自：… / 创建时间 …」这类次要信息；
 *     搜索保留（作品一多就得靠它，而且它只筛当前页、不假装跨页）。
 *   ⚠️ 这几条**不能动**（守卫 `p115` 钉着）：每张卡必有封面（`student-work-card__art` /
 *      `student-work-card__cover img` 二者之一）、类型标签 `student-work-card__type`、
 *      以及「下架原因」那段（`data-testid="unpublish-reason"`，`p63`/`p152` 钉着）。
 */
export function MyWorksPage({ api }) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, error: null, items: [], summary: null, page: 1, totalPages: 1 });
  const [search, setSearch] = useState('');

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
  const total = Number(summary.total ?? items.length) || 0;
  const published = Number(summary.published ?? 0) || 0;

  // 筛选只在**当前这一页**上做（分页由服务端管）：原来那三个下拉也守这条规矩，现在只留搜索。
  const keyword = search.trim().toLowerCase();
  const visible = items.filter((work) => !keyword
    || `${work.title || ''} ${work.courseLessonTitle || ''} ${work.sessionTitle || ''}`.toLowerCase().includes(keyword));

  // 头像与名字取当前登录会话（学生端与官网共用一份 session —— 见 ⭐1 的 cookie 口径）。
  // 还没有头像图（`avatarKey` 目前没有任何界面在渲染），所以按惯例用**首字圆形头像**。
  const session = readSession();
  const displayName = session?.user?.displayName || session?.user?.login || '我的作品';
  const initial = String(displayName).trim().charAt(0) || '我';

  return <div className="student-page student-works-page">
    <header className="sw-profile">
      <div className="sw-avatar" aria-hidden="true">{initial}</div>
      <div className="sw-profile-main">
        <h1>{displayName}</h1>
        <p className="sw-stats"><span><strong>{total}</strong> 个作品</span><span><strong>{published}</strong> 已上广场</span></p>
        <p className="sw-bio">查看你在课程中生成与归档的作品。</p>
      </div>
    </header>

    <div className="sw-toolbar">
      <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索作品" placeholder="搜索作品名称、关键词（如：海报、代码、视频…）" />
    </div>

    {state.loading ? <div className="student-page-state">正在加载作品…</div> : null}
    {state.error ? <div className="student-page-state is-error">⚠ {state.error}<button type="button" onClick={() => setState((current) => ({ ...current, error: null }))}>知道了</button></div> : null}

    {!state.loading && !state.error && items.length === 0 ? <div className="student-page-state">
      ✦ 还没有提交过作品。<br />进入学习，完成一节课后把作品提交上来吧。
      <div className="student-page-actions"><Link className="button" to="/learn">进入学习 <b>↗</b></Link></div>
    </div> : null}

    {items.length && !visible.length ? <div className="student-page-state">这一页里没有符合条件的作品。换一个关键词试试。</div> : null}

    {visible.length ? <div className="student-card-grid sw-grid">{visible.map((work) => {
      const type = workType(work);
      return <article className="student-card sw-card" key={work.id}>
        <Link className="sw-card__link" to={`/my-works/${work.source || 'CANVAS'}/${encodeURIComponent(work.id)}`}>
          <div className="student-work-card__cover">
            <WorkCover work={work} type={type} />
            <span className="student-work-card__type">{type.label}</span>
          </div>
          <h3 className="sw-card__title">{work.title}</h3>
          <div className="sw-card__foot">
            <span className={`student-badge ${work.plazaPublished ? 'is-ok' : ''}`}>{workPlazaLabel(work)}</span>
            <span className="sw-card__from">{work.seriesTitle || '未绑定课包'}</span>
          </div>
        </Link>
        {/* ⚠️ 2026-09-26 全站审计：原来只认旧枚举 REJECTED，而 C2 起下架写的是 UNPUBLISHED ——
            新下架的作品徽标显示「已下架」、原因却看不到（学生申诉就靠这句）。改按"有原因且当前不在广场上"。 */}
        {work.unpublishReason && !work.plazaPublished ? <p className="student-card__desc" data-testid="unpublish-reason"><strong>下架原因：</strong>{work.unpublishReason}</p> : null}
      </article>;
    })}</div> : null}

    <Pagination page={state.page} totalPages={state.totalPages} onChange={setPage} disabled={state.loading} />

    {items.length ? <div className="student-page-actions"><Link className="button soft" to="/works">去作品广场看看 <b>↗</b></Link></div> : null}
  </div>;
}
