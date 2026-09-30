// 官网 - **学生个人主页**（对外公开，路由 `/u/<token>`）
//
// ⚠️ 2026-09-27 用户口径（第三、四轮）：
//   ·「学生创建了账号应该就有个主页的专属链接。对外公开并且可以分享。」→ 有了这一页；
//   ·「主页把全部作品都列出来」→ 列**全部**（含没公开的），与服务端同一套筛选；
//   ·「**现在不需要这个 my-home 了。直接跳转到对外主页就行了**」→ `/my-home` 已改成跳到这一页，
//     原来那一页（我的主页·控制台）和它的单件详情页**都删掉了**；
//   ·「头像修改要加上」「学生可以自行修改照片」→ 头像设置搬到这一页的**主人模式**里（见下）；
//   ·「改成弹窗那样的」→ 点作品卡**弹窗看**（不再跳详情页）。
//
// 「主人模式」怎么认：这一页是公开的、不需要登录，但**如果登录者本人就是主页的主人**，
// 就多显示管理入口（改头像 / 分享）。判据是"学生口的 `/api/student/home` 返回的 homeToken
// 等于路由里这个 token" —— 不需要给公开接口加任何"我是谁"的字段。
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AVATAR_KEYS, avatarGlyph } from '@platform/shared';
// ⭐ 2026-09-30：二维码用仓库里 vendored 的那份实现（`packages/shared/src/vendor/qrcode-generator.mjs`，
//    MIT，Kazuhiko Arase）—— **零依赖**：服务器没有 npm，发版不该为了一个二维码去下载新包。
//    ⚠️ 它的正确性是**比对过**的：同一段文本与 npm 上成熟的 `qrcode` 生成结果逐格一致（33×33、0 处不同）。
//    用法：typeNumber=0（自动选版本）+ 纠错级 M；我们自己按 getModuleCount/isDark 渲染 SVG（不依赖它的渲染 API）。
import qrcode from '@platform/shared/vendor/qrcode-generator.mjs';

/** 二维码 SVG（黑白两色、带静默边）—— 用来给「分享」弹窗显示。 */
function qrSvgText(text, { cell = 4, margin = 2 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + margin * 2) * cell;
  let rects = '';
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (qr.isDark(r, c)) rects += `<rect x="${(c + margin) * cell}" y="${(r + margin) * cell}" width="${cell}" height="${cell}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="分享二维码">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><g fill="#111">${rects}</g></svg>`;
}

/**
 * 一件作品里的**每一件产出物**（主页上要**逐件**分享 —— 用户口径：「这节课有 1 个图片和 1 个视频，
 * 每个都可以独立去分享」）。`pieceKey` 是**服务端算好的**（画布 `media:…` / VibeCoding `artifact:…`），
 * 前端别自己拼 —— 两边口径飘了就会出现"主页看得见却分享不了"。
 */
function shareablePiecesOf(work) {
  if ((work.source || 'CANVAS') === 'VIBECODING') {
    return (work.artifacts || []).filter((item) => item?.pieceKey).map((item) => ({ pieceKey: item.pieceKey, label: item.name || '' }));
  }
  const labels = { IMAGE: '图片', VIDEO: '视频', AUDIO: '音频' };
  return (work.media || []).filter((item) => item?.pieceKey).map((item) => ({ pieceKey: item.pieceKey, label: item.caption || labels[item.modality] || '这一件' }));
}
import { WorkCover, workType } from '../components/workCard.jsx';
import { absoluteUrl, copyToClipboard } from '../components/clipboard.js';
import { WorkPreviewModal } from '../components/WorkPreviewModal.jsx';

export function CreatorHomePage({ api, studentApi = null }) {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, error: null, creator: null });
  // 主人自己那份额外信息（学生口）。非主人 / 未登录时是 null。
  const [home, setHome] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [viewing, setViewing] = useState(null);
  // ⭐ 2026-09-30：「逐件分享」弹窗（二维码 + 链接）
  const [shareModal, setShareModal] = useState(null);
  const isOwner = Boolean(home && home.homeToken === token);

  useEffect(() => {
    let live = true;
    setState({ loading: true, error: null, creator: null });
    api.get(`public/creators/${encodeURIComponent(token)}`)
      .then((payload) => { if (live) setState({ loading: false, error: null, creator: payload || null }); })
      .catch((error) => { if (live) setState({ loading: false, error: error.message, creator: null }); });
    return () => { live = false; };
  }, [api, token]);

  // 主人模式探测：登录了就问一句"我的主页 token 是哪个"，对上号才多显示管理入口。
  useEffect(() => {
    if (!studentApi?.get) return undefined;
    let live = true;
    studentApi.get('student/home')
      .then((payload) => { if (live && payload?.homeToken === token) setHome(payload || null); })
      // 没登录会 401 —— 这正是"不是主人"，静静忽略
      .catch(() => { /* 不是主人，正常 */ });
    return () => { live = false; };
  }, [studentApi, token]);

  const creator = state.creator;
  const items = creator?.items || [];
  const initial = String(creator?.name || '同学').trim().charAt(0) || '同';
  const avatarPhoto = creator?.avatarUrl || '';
  const glyph = avatarGlyph(creator?.avatarKey);

  async function saveHome(patch) {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const saved = await studentApi.put('student/home', patch);
      setHome((current) => ({ ...(current || {}), ...saved }));
      // 页面上那份（公开口拿的）也跟着更新，不然改完头像看不到变化
      setState((current) => (current.creator ? { ...current, creator: { ...current.creator, avatarKey: saved?.avatarKey ?? null, avatarUrl: saved?.avatarUrl ?? null } } : current));
      setNotice('已保存');
    } catch (error) { setNotice(`没保存成功：${error.message}`); }
    finally { setBusy(false); }
  }

  // 上传自己的照片当头像。⚠️ 必须用 `PUBLIC_PLATFORM` 可见性：这一页是未登录访客在看，
  // 公开读口只放行 PUBLIC_PLATFORM/PUBLIC_RELEASE（服务端也会拦）。
  async function uploadAvatar(file) {
    if (!file || busy) return;
    setBusy(true); setNotice('');
    try {
      const asset = await studentApi.upload('student/file-assets/upload', file, { category: 'GENERAL', visibility: 'PUBLIC_PLATFORM' });
      if (!asset?.id) throw new Error('上传没有返回文件 id');
      const saved = await studentApi.put('student/home', { avatarAssetId: asset.id });
      setHome((current) => ({ ...(current || {}), ...saved }));
      setState((current) => (current.creator ? { ...current, creator: { ...current.creator, avatarUrl: saved?.avatarUrl ?? null } } : current));
      setNotice('头像已更新');
    } catch (error) { setNotice(`没换成：${error.message}`); }
    finally { setBusy(false); }
  }

  // ⭐ 「公开到广场」：学生自己的入口（原来在已删的「我的作品·单件详情」页上）。
  //    ⚠️ 按钮文案就写明公开到广场—— 点它等于公开，不做偷偷摸摸的事（孩子的作品要自己点头）。
  async function publishWork(work) {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const saved = await studentApi.put(`student/works/${encodeURIComponent(work.id)}/public`, { isPublic: true });
      const token = saved?.shareToken;
      const link = token ? absoluteUrl(`/works/${token}`) : '';
      if (link) await copyToClipboard(link);
      setState((current) => (current.creator ? { ...current, creator: { ...current.creator, items: (current.creator.items || []).map((item) => (item.id === work.id ? { ...item, isPublic: true } : item)) } } : current));
      setNotice(link ? `已公开到广场，链接已复制：${link}` : '已公开到广场');
    } catch (error) { setNotice(`没公开成功：${error.message}`); }
    finally { setBusy(false); }
  }

  async function share() {
    const url = absoluteUrl(`/u/${token}`);
    const copied = await copyToClipboard(url);
    setNotice(copied ? `链接已复制：${url}` : `请手动复制这个地址：${url}`);
  }

  // ⭐ 2026-09-30（用户口径）：「每个作品都可以有个分享……每个都可以独立去分享」——
  //    这里分享的是**一件产出物**（一张图 / 一段视频 / 一个网页…），不是整张卡片。
  //    码由服务端发（幂等：同一件反复点给的是同一枚）；拿到码后弹二维码 —— 扫它打开 `/s/<码>` 那张分享卡。
  async function sharePiece(work, piece) {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const saved = await studentApi.post('student/share-links', {
        source: work.source || 'CANVAS', workId: work.id, pieceKey: piece.pieceKey,
      });
      const url = absoluteUrl(`/s/${saved.code}`);
      setShareModal({ title: `${work.title || '作品'}${piece.label ? ' · ' + piece.label : ''}`, url, svg: qrSvgText(url) });
    } catch (error) { setNotice(`分享没成功：${error.message}`); }
    finally { setBusy(false); }
  }

  if (state.loading) return <main className="inner"><div className="student-page-state">正在打开主页…</div></main>;
  if (state.error || !creator) {
    return <main className="inner"><div className="student-page-state is-error">
      ⚠ {state.error || '这个主页不存在。'}
      <div className="student-page-actions"><Link className="button soft" to="/works">去作品广场看看 <b>↗</b></Link></div>
    </div></main>;
  }

  return <main className="inner student-page student-home-page">
    <header className="sw-profile">
      {/* 主人：头像是**按钮**（点开设置）；访客：只读展示。 */}
      {isOwner ? <button type="button" className="sw-avatar" data-testid="home-avatar" aria-expanded={panelOpen} aria-label="主页设置（改头像）" onClick={() => setPanelOpen((open) => !open)}>
        {avatarPhoto ? <img src={avatarPhoto} alt="" /> : (glyph || initial)}
      </button> : <div className="sw-avatar" data-testid="home-avatar-readonly" aria-hidden="true">
        {avatarPhoto ? <img src={avatarPhoto} alt="" /> : (glyph || initial)}
      </div>}
      <div className="sw-profile-main">
        <h1 data-testid="home-name">{creator.name}</h1>
        <p className="sw-stats">
          <span><strong>{Number(creator.workCount) || 0}</strong> 件作品</span>
          {Number(creator.featuredCount) > 0 ? <span><strong>{Number(creator.featuredCount)}</strong> 件精选</span> : null}
        </p>
        <p className="sw-bio">这是 {creator.name} 的主页，陈列 TA 的作品。</p>
        <p className="sw-home-actions">
          <button type="button" className="button soft" data-testid="share-home-public" onClick={share}>分享这个主页</button>
        </p>
        {/* ⚠️ 这条提示必须渲染在面板**外面**：面板默认收起，放里面的话点了没反应（踩过一次）。 */}
        {notice ? <p className="sw-home-panel__notice" data-testid="home-public-notice">{notice}</p> : null}
      </div>
    </header>

    {/* ⚠️ 面板**只在展开时渲染**（不要用 hidden 属性）：收起时 DOM 里不该有它 ——
        一是点了没反应那类问题看不出来，二是守卫要能一眼判断它是收起状态。 */}
    {isOwner && panelOpen ? <section className="sw-home-panel" data-testid="home-panel">
      <div className="sw-home-panel__head">
        <strong>主页设置</strong>
        <button type="button" className="text-button" onClick={() => setPanelOpen(false)}>收起</button>
      </div>
      <p className="sw-home-panel__hint">你的主页是<strong>公开的</strong>：任何拿到链接的人都能看到它，上面列着你<strong>全部</strong>的作品（含还没公开到广场的）。</p>
      <div className="sw-home-panel__block">
        <span className="sw-home-panel__label">头像</span>
        <p className="sw-home-panel__hint">可以上传你自己的照片，也可以从下面挑一个预设头像。</p>
        <div className="sw-home-panel__upload">
          <label className="inline-file-upload">{avatarPhoto ? '换一张照片' : '上传照片'}
            <input type="file" accept="image/*" data-testid="avatar-upload" disabled={busy} onChange={(event) => { uploadAvatar(event.target.files?.[0]); event.target.value = ''; }} />
          </label>
          {avatarPhoto ? <button type="button" className="text-button" data-testid="avatar-photo-remove" disabled={busy} onClick={() => saveHome({ avatarAssetId: null })}>移除照片</button> : null}
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
            disabled={busy}
            onClick={() => saveHome({ avatarKey: key })}
          >{avatarGlyph(key)}</button>)}
          <button
            type="button"
            role="radio"
            aria-checked={!home?.avatarKey}
            aria-label="不用头像，用名字首字"
            data-testid="avatar-none"
            className={`sw-avatar-option sw-avatar-option--none${!home?.avatarKey ? ' is-active' : ''}`}
            disabled={busy}
            onClick={() => saveHome({ avatarKey: null })}
          >首字</button>
        </div>
      </div>
    </section> : null}

    {items.length ? <div className="student-card-grid sw-grid">{items.map((work) => {
      const type = workType(work);
      return <article className="student-card sw-card" key={work.id}>
        <button type="button" className="sw-card__link sw-card__link--button" data-testid="home-work-card" onClick={() => setViewing(work)}>
          <div className="student-work-card__cover">
            <WorkCover work={work} type={type} />
            <span className="student-work-card__type">{type.label}</span>
          </div>
          <h3 className="sw-card__title">{work.title}</h3>
          <div className="sw-card__foot">
            {work.featured ? <span className="student-badge is-ok">精选</span> : null}
            <span className="sw-card__from">{work.orgName || '灵动ai学院'}</span>
          </div>
        </button>
        {/* ⭐ 2026-09-30（用户口径）：**逐件**给「分享」—— 这节课的 1 张图、1 段视频各自独立分享。
            码在服务端发（幂等），点完弹二维码；不是主人（访客）看不到这一排。 */}
        {isOwner ? <div className="sw-card__share" data-testid="home-work-pieces">
          {shareablePiecesOf(work).map((piece) => <button key={piece.pieceKey} type="button" className="text-button"
            disabled={busy} onClick={() => sharePiece(work, piece)}>分享{piece.label ? ` · ${piece.label}` : ''}</button>)}
        </div> : null}
        {isOwner && !work.isPublic && (work.source || 'CANVAS') === 'CANVAS' ? <button type="button" className="text-button" data-testid="publish-work" disabled={busy} onClick={() => publishWork(work)}>公开到广场</button> : null}
        {work.unpublishReason && !work.isPublic ? <p className="student-card__desc" data-testid="unpublish-reason"><strong>下架原因：</strong>{work.unpublishReason}</p> : null}
      </article>;
    })}</div> : <div className="student-page-state">
      ✦ 这个主页上还没有作品。<br />学生提交作品之后就会出现在这里。
      <div className="student-page-actions"><Link className="button soft" to="/works">去作品广场看看 <b>↗</b></Link></div>
    </div>}

    <div className="student-page-actions"><Link className="button soft" to="/works">看看更多作品 <b>↗</b></Link></div>

    {viewing ? <WorkPreviewModal api={api} creatorToken={token} source={viewing.source || 'CANVAS'} work={viewing} onClose={() => setViewing(null)} /> : null}

    {/* 分享弹窗：二维码 + 链接（扫码打开 `/s/<码>` 那张分享卡）。
        ⚠️ 目前**没有公众号** → 不做微信 JS-SDK；这里给"复制链接" + "微信里点右上角 ···"的手动路径。 */}
    {shareModal ? <div className="share-modal" role="dialog" aria-modal="true" data-testid="share-modal">
      <div className="share-modal__panel">
        <div className="share-modal__head"><strong>分享作品</strong><button type="button" className="text-button" onClick={() => setShareModal(null)}>关闭</button></div>
        <p className="share-modal__title">{shareModal.title}</p>
        <div className="share-modal__qr" dangerouslySetInnerHTML={{ __html: shareModal.svg }} />
        <p className="share-modal__hint">用手机扫这个二维码，就能看到这件作品。</p>
        <div className="share-modal__actions">
          <button type="button" className="button" onClick={async () => {
            const copied = await copyToClipboard(shareModal.url);
            setNotice(copied ? `链接已复制：${shareModal.url}` : `请手动复制：${shareModal.url}`);
          }}>复制链接</button>
          <a className="button soft" href={shareModal.url} target="_blank" rel="noreferrer">先看看分享页</a>
        </div>
        <p className="share-modal__hint">在微信里打开时，点右上角「···」也能发给朋友或分享到朋友圈。</p>
      </div>
    </div> : null}
  </main>;
}
