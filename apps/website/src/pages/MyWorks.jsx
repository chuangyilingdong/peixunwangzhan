// 官网 - 我的作品（**个人主页的控制台**）
//
// ⚠️ 2026-09-27 口径：这一页从"作品列表"变成**主页概念**（用户原话「现在需要把『我的作品』改成主页的
//    的概念。对外公开并且可以分享。头像修改要加上。」）：
//      · 顶部那块（头像 + 名字 + 统计）就是主页的抬头，头像**可点开改**（8 个预设头像）；
//      · 多一条「我的主页」入口 —— 对外公开的专属链接 `/u/<token>`（每个学生一个，建号时就有）；
//      · 主页设置面板里可以切"对外匿名"（默认匿名，沿用既有的隐私默认值）；
//      · 「分享主页」把那条链接复制走。
//    作品网格、封面、类型标签、下架原因这些都**没动**。
//
// ⚠️ 这几条**不能动**（守卫 `p115` 钉着）：每张卡必有封面（`student-work-card__art` /
//    `student-work-card__cover img` 二者之一）、类型标签 `student-work-card__type`、
//    `.sw-avatar` ≥1、`.sw-profile-main h1` 非空、`.sw-stats strong` ≥2 项、`.sw-grid` 手机上恰好两列、
//    以及「下架原因」那段（`data-testid="unpublish-reason"`，`p63`/`p152` 钉着）。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AVATAR_KEYS, Pagination, avatarGlyph, readSession, workPlazaBadge } from '@platform/shared';
// 类型判定与自动封面（2026-09-27 从本文件搬去 components/workCard.jsx —— 对外公开的学生主页
// `/u/<token>` 要用**同一套**封面与类型标签，抄一份出去就会漂移）
import { WorkCover, workType } from '../components/workCard.jsx';
import { absoluteUrl, copyToClipboard } from '../components/clipboard.js';

// 状态话术统一走 @platform/shared 的 worksState（两条链路一套词，这里不再自己维护一份）

export function MyWorksPage({ api }) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, error: null, items: [], summary: null, page: 1, totalPages: 1 });
  const [search, setSearch] = useState('');
  // 主页设置（头像 / 匿名开关 / 主页链接）。`null` = 还没取到（此时头像退回"首字圆形"，与旧版一致）。
  const [home, setHome] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [homeBusy, setHomeBusy] = useState(false);
  const [homeNotice, setHomeNotice] = useState('');

  useEffect(() => {
    let live = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    api.get(`student/works?page=${page}`)
      .then((payload) => { if (live) setState({ loading: false, error: null, items: payload?.items || [], summary: payload?.summary || null, page: payload?.page || 1, totalPages: payload?.totalPages || 1 }); })
      .catch((error) => { if (live) setState({ loading: false, error: error.message, items: [], summary: null, page: 1, totalPages: 1 }); });
    return () => { live = false; };
  }, [api, page]);

  // 主页设置只在进页面时取一次（分页变化不重取）。
  useEffect(() => {
    let live = true;
    api.get('student/home')
      .then((payload) => { if (live) setHome(payload || null); })
      // 取不到就静静地退回旧样子（首字头像、不显示主页链接）—— 别因为一个附加功能把整页搞成错误态。
      .catch(() => { if (live) setHome(null); });
    return () => { live = false; };
  }, [api]);

  const items = state.items;
  const summary = state.summary || { total: items.length, published: items.filter((item) => item.plazaPublished).length };
  const total = Number(summary.total ?? items.length) || 0;
  const published = Number(summary.published ?? 0) || 0;

  // 筛选只在**当前这一页**上做（分页由服务端管）：原来那三个下拉也守这条规矩，现在只留搜索。
  const keyword = search.trim().toLowerCase();
  const visible = items.filter((work) => !keyword
    || `${work.title || ''} ${work.courseLessonTitle || ''} ${work.sessionTitle || ''}`.toLowerCase().includes(keyword));

  // 名字取当前登录会话（学生端与官网共用一份 session —— 见 ⭐1 的 cookie 口径）。
  // 头像三级优先：**自己上传的照片** > 预设头像 > 名字首字圆形。
  const session = readSession();
  const displayName = session?.user?.displayName || session?.user?.login || '我的作品';
  const initial = String(displayName).trim().charAt(0) || '我';
  const avatarPhoto = home?.avatarUrl || '';
  const glyph = avatarGlyph(home?.avatarKey);
  const homeHref = home?.homeUrl ? absoluteUrl(home.homeUrl) : '';

  async function saveHome(patch) {
    if (homeBusy) return;
    setHomeBusy(true);
    setHomeNotice('');
    try {
      const saved = await api.put('student/home', patch);
      setHome((current) => ({ ...(current || {}), ...saved }));
      setHomeNotice('已保存');
    } catch (error) {
      setHomeNotice(`没保存成功：${error.message}`);
    } finally {
      setHomeBusy(false);
    }
  }

  // 上传自己的照片当头像（用户口径 2026-09-27：「学生可以自行修改照片」）。
  // ⚠️ 必须用 `PUBLIC_PLATFORM` 可见性上传：公开主页是未登录访客在看，公开读口只放行
  //    PUBLIC_PLATFORM/PUBLIC_RELEASE —— 用默认的 PRIVATE 传上去，学生自己那页看着正常、
  //    公开主页上却是一张 403 破图（最难查的一种）。服务端也会拦（AVATAR_ASSET_NOT_PUBLIC）。
  async function uploadAvatar(file) {
    if (!file || homeBusy) return;
    setHomeBusy(true);
    setHomeNotice('');
    try {
      const asset = await api.upload('student/file-assets/upload', file, { category: 'GENERAL', visibility: 'PUBLIC_PLATFORM' });
      if (!asset?.id) throw new Error('上传没有返回文件 id');
      const saved = await api.put('student/home', { avatarAssetId: asset.id });
      setHome((current) => ({ ...(current || {}), ...saved }));
      setHomeNotice('头像已更新');
    } catch (error) {
      setHomeNotice(`没换成：${error.message}`);
    } finally {
      setHomeBusy(false);
    }
  }

  async function shareHome() {
    if (!homeHref) { setHomeNotice('主页链接还没准备好，稍后再试。'); return; }
    const copied = await copyToClipboard(homeHref);
    setHomeNotice(copied ? `主页链接已复制：${homeHref}` : `请手动复制这个地址：${homeHref}`);
  }

  return <div className="student-page student-works-page">
    <header className="sw-profile">
      {/* 头像可点：点开主页设置（改头像 / 切匿名 / 复制主页链接）。 */}
      <button type="button" className="sw-avatar" data-testid="home-avatar" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen} aria-label="主页设置（改头像）">
        {avatarPhoto ? <img src={avatarPhoto} alt="" /> : (glyph || initial)}
      </button>
      <div className="sw-profile-main">
        <h1>{displayName}</h1>
        <p className="sw-stats"><span><strong>{total}</strong> 个作品</span><span><strong>{published}</strong> 已上广场</span></p>
        <p className="sw-bio">查看你在课程中生成与归档的作品。</p>
        {home?.homeUrl ? <p className="sw-home-actions">
          <a className="button soft" href={home.homeUrl} target="_blank" rel="noreferrer" data-testid="open-home">我的主页 <b>↗</b></a>
          <button type="button" className="button soft" data-testid="share-home" onClick={shareHome}>分享主页</button>
        </p> : null}
      </div>
    </header>

    {panelOpen ? <section className="sw-home-panel" data-testid="home-panel">
      <div className="sw-home-panel__head">
        <strong>主页设置</strong>
        <button type="button" className="text-button" onClick={() => setPanelOpen(false)}>收起</button>
      </div>
      <p className="sw-home-panel__hint">你的主页是公开的：<strong>只有你已公开的作品</strong>会出现在上面，没公开的作品任何人都看不到。</p>

      <div className="sw-home-panel__block">
        <span className="sw-home-panel__label">头像</span>
        <p className="sw-home-panel__hint">可以上传你自己的照片，也可以从下面挑一个预设头像。</p>
        <div className="sw-home-panel__upload">
          {/* ⚠️ 文件域必须包在 `.inline-file-upload` 的 label 里、文字在前、input 在后 ——
              这是三端的既有约定（裸 `<input type="file">` 会露出浏览器默认的「选择文件」控件，
              守卫 p102 扫全仓 .jsx 钉着这条）。样式在 packages/shared/src/styles.css 里把它藏起来。 */}
          <label className="inline-file-upload">{avatarPhoto ? '换一张照片' : '上传照片'}
            <input type="file" accept="image/*" data-testid="avatar-upload" disabled={homeBusy} onChange={(event) => { uploadAvatar(event.target.files?.[0]); event.target.value = ''; }} />
          </label>
          {avatarPhoto ? <button type="button" className="text-button" data-testid="avatar-photo-remove" disabled={homeBusy} onClick={() => saveHome({ avatarAssetId: null })}>移除照片</button> : null}
        </div>
        <div className="sw-avatar-picker" role="radiogroup" aria-label="选择预设头像">
          {AVATAR_KEYS.map((key) => <button
            key={key}
            type="button"
            role="radio"
            aria-checked={home?.avatarKey === key}
            aria-label={`头像 ${key}`}
            data-testid={`avatar-${key}`}
            className={`sw-avatar-option${home?.avatarKey === key ? ' is-active' : ''}`}
            disabled={homeBusy}
            onClick={() => saveHome({ avatarKey: key })}
          >{avatarGlyph(key)}</button>)}
          <button
            type="button"
            role="radio"
            aria-checked={!home?.avatarKey}
            aria-label="不用头像，用名字首字"
            data-testid="avatar-none"
            className={`sw-avatar-option sw-avatar-option--none${!home?.avatarKey ? ' is-active' : ''}`}
            disabled={homeBusy}
            onClick={() => saveHome({ avatarKey: null })}
          >首字</button>
        </div>
      </div>

      <div className="sw-home-panel__block">
        <span className="sw-home-panel__label">主页链接</span>
        <p className="sw-home-panel__link">
          <code data-testid="home-url">{homeHref || '（还没生成）'}</code>
          <button type="button" className="text-button" data-testid="copy-home" disabled={!homeHref} onClick={shareHome}>复制</button>
        </p>
      </div>
      {homeNotice ? <p className="sw-home-panel__notice" data-testid="home-notice">{homeNotice}</p> : null}
    </section> : null}

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
      const badge = workPlazaBadge(work);
      return <article className="student-card sw-card" key={work.id}>
        <Link className="sw-card__link" to={`/my-works/${work.source || 'CANVAS'}/${encodeURIComponent(work.id)}`}>
          <div className="student-work-card__cover">
            <WorkCover work={work} type={type} />
            <span className="student-work-card__type">{type.label}</span>
          </div>
          <h3 className="sw-card__title">{work.title}</h3>
          <div className="sw-card__foot">
            {/* 「已提交待发布」这一档不渲染徽标（用户 2026-09-27 口径，规则在 workPlazaBadge 里）——
                整只 span 一起不渲染；留个空 span 会变成一个空的灰底胶囊。 */}
            {badge ? <span className={`student-badge ${work.plazaPublished ? 'is-ok' : ''}`} data-testid="plaza-badge">{badge.text}</span> : null}
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
