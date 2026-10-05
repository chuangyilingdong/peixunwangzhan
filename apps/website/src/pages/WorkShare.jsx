// 作品分享页（`/s/<分享码>`）—— 2026-09-30 用户口径：
//   「点击分享后有个二维码，扫这个二维码，就对应这个图1 可以展示这个学生来自于 XXX 机构，学生头像与姓名，
//     然后就是作品展示，点击后如果是网页可以直接玩，如果是视频可以看，音频可以听，图片可以看等等，
//     作品简介就是这节课的标题。点击分享作品可以分享到微信朋友圈或者微信好友，点击查看官网可以跳转到我们的官网页面」
//
// ⚠️ 这一页**只服务"学生主页侧"的分享**（`work_share_links` 发的码），与**作品广场**（`/works/<码>`）
//    是两条互不相干的链路：广场那套绑着审核/上下架，这里的码"想分享就分享"、不改变任何公开状态。
// ⚠️ 所以这里的键叫 `piece`（**一件产出物** = 一张图 / 一段视频 / 一个网页 …），不是"一件作品"。
//
// 微信分享：**目前没有公众号**（用户 2026-09-30 确认）→ 不做 JS-SDK，页面里给"点右上角 ···"的引导
// + 复制链接兜底（有公众号之后再接 `wx.config` + `updateAppMessageShareData` 即可，结构不用改）。
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { avatarGlyph, BrandLogo, buildPreviewDocument, createApiClient, Icon, Notice, ReplayPreview } from '@platform/shared';

const api = createApiClient();

/**
 * 「分享作品」：**不再调系统分享**（2026-10-03 用户实测：微信里那条链路走不通 ——
 * 点分享作品 → 跳到系统分享 → 选微信 → 转发给朋友 → 又回到"已唤起系统分享"，绕一圈没发出去）。
 * 改成：**复制链接 + 教一句点右上角 ···**（用户原话：「不如提示点击右上角的···，3个点」）——
 * 微信/手机浏览器里唯一真正有效的路径就是它自己的右上角菜单。
 */
async function sharePiece(url) {
  try {
    await navigator.clipboard.writeText(url);
    return '链接已复制。微信里请点右上角 ··· 转发给朋友或分享到朋友圈。';
  } catch {
    return '微信里请点右上角 ···，选「发送给朋友」或「分享到朋友圈」。';
  }
}

export function WorkSharePage() {
  const { code } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get(`public/share-links/${encodeURIComponent(code)}`);
        if (!cancelled) setState({ loading: false, data, error: '' });
      } catch (error) {
        if (!cancelled) setState({ loading: false, data: null, error: error?.message || '分享链接打不开' });
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  const shareUrl = `${window.location.origin}/s/${code}`;

  if (state.loading) return <main className="inner"><div className="student-page-state">正在打开分享…</div></main>;
  if (state.error || !state.data) {
    return <main className="inner"><div className="student-page-state is-error">
      ⚠ {state.error || '这个分享链接不存在。'}
      <div className="student-page-actions"><Link className="button soft" to="/">回官网看看 <b>↗</b></Link></div>
    </div></main>;
  }

  const { student, org, lessonTitle, piece, work } = state.data;
  const missingAssets = Array.isArray(state.data.missingAssets) ? state.data.missingAssets : [];
  const glyph = avatarGlyph(student?.avatarKey);
  const initial = String(student?.name || '同学').slice(0, 1);

  return <main className="inner share-page">
    {/* 移动端分享页只保留一处品牌标识：扫码页不再渲染官网完整顶栏。 */}
    <header className="share-page__head">
      <Link className="share-page__brand" to="/" aria-label="返回灵动 AI 首页"><BrandLogo height={28} /></Link>
      {org?.name ? <p className="share-page__from"><Icon name="book" /> 学生来自：{org.name}</p> : null}
    </header>

    <section className="share-card">
      <div className="share-card__who">
        <div className="sw-avatar" aria-hidden="true">
          {student?.avatarUrl ? <img src={student.avatarUrl} alt="" /> : (glyph || initial)}
        </div>
        <h1>{student?.name || '同学'}</h1>
      </div>

      {/* ⭐ 2026-10-05 用户口径：老师在机构端改了作品名称后，**分享页也要同步** ——
          所以这里把作品名称单独显示出来（「作品简介」那一行按老口径仍是这节课的标题）。 */}
      {work?.title ? <h2 className="share-card__title">{work.title}</h2> : null}

      <div className="share-card__piece">
        <PieceView piece={piece} document={state.data.document} />
        {missingAssets.length ? <Notice tone="warning">
          这件作品里有 {missingAssets.length} 个本地素材（{missingAssets.slice(0, 3).join('、')}{missingAssets.length > 3 ? ' 等' : ''}）
          没有随作品一起提交上来 —— 让 ta 用最新版客户端重新提交一次，这里就能看到图和视频了。
        </Notice> : null}
      </div>

      <h2 className="share-card__label">作品简介</h2>
      <p className="share-card__desc">{lessonTitle || work?.title || '这节课的作品'}</p>

      <div className="share-page__actions">
        <button type="button" className="share-page__btn is-primary"
          onClick={async () => setNotice(await sharePiece(shareUrl))}>
          <Icon name="share" /> 分享作品
        </button>
        <a className="share-page__btn is-site" href="/">查看官网</a>
      </div>
      {notice ? <p className="share-page__notice">{notice}</p> : null}
      {/* ⚠️ 2026-09-30 用户口径：「分享按钮这些多余的文案全部删除」——
          这里原来有两行：微信里"点右上角 ···"的引导（没有公众号、也不该教用户点哪里），
          和「看 TA 的主页 · 更多作品」的跳转。**两张卡都不是这一页要干的事**，已删。
          这一页只做三件：看这一件 → 分享这一件 → 回官网。 */}
    </section>
  </main>;
}

/**
 * 那一件产出物怎么显示（按服务端给的 `render` 分派）：
 *   IMAGE/VIDEO/AUDIO → 就地看/听；HTML → **就地玩**（沙箱 iframe，与作品广场同一套口径）；
 *   DOC（PPT/Word/Excel）→ 能直接读的文本件**就地把正文铺开**；真文件的 Office 产物**就地 iframe 显示服务端转好的 PDF**；
 *   两者都拿不到时才退回「封面 + 打开体验」。
 *
 * ⚠️ 2026-09-30 用户口径（原话）：「手机扫码能否……**直接显示作品**，点击后立马可以在线看游玩，
 *    **而不是跳转**，跳转又各种无限跳转」。
 *    所以网页这一件不再只给一个「打开体验」的跳转按钮 —— 服务端把**这一份产物文档**一起给过来
 *    （`document.files` / `document.entry`，里面的私有素材已换成这一枚码专属的免登录代理），
 *    这里直接跑起来：扫码看到的就是作品本身，随手就能点着玩（沙箱里 localStorage 有替身、脚本能跑）。
 *    扫码页只保留就地体验，不再提供「在完整页面里打开」——手机链路里它会造成二次跳转和视觉重复。
 */
function PieceView({ piece, document: doc }) {
  if (!piece) return <p className="muted">这一件已经不在最新版本里了。</p>;
  const { render, mediaUrl, coverUrl, openUrl, name } = piece;
  if (render === 'IMAGE' && mediaUrl) return <img className="share-piece__media" src={mediaUrl} alt={name || '作品'} />;
  if (render === 'VIDEO' && mediaUrl) return <video className="share-piece__media" src={mediaUrl} controls playsInline />;
  if (render === 'AUDIO' && mediaUrl) return <audio className="share-piece__audio" src={mediaUrl} controls />;
  if (render === 'HTML') {
    const playable = doc?.files && doc?.entry && Object.hasOwn(doc.files, doc.entry);
    return <>
      {playable
        // ⭐ 与作品页同一个口径（2026-09-30 用户口径「不要固定的小框、要自适应」）：
        //    无面板 + 按容器宽度自适应 —— 手机上就是学生页自己的窄屏版式，电脑上就是宽屏版式。
        ? <div className="share-piece__stage"><ReplayPreview html={buildPreviewDocument(doc.files, doc.entry)} title={name || '作品'} chrome={false} responsive /></div>
        : (coverUrl ? <img className="share-piece__media" src={coverUrl} alt={name || '网页作品'} /> : null)}
      {playable ? null : (openUrl
        ? <p className="share-piece__play"><Link className="button" to={openUrl}>打开体验 · 直接玩 <b>↗</b></Link></p>
        : <p className="muted">这一件是网页作品，用电脑/手机打开就能玩。</p>)}
    </>;
  }
  // 文档类（PPT / Word / Excel / 文本件）
  // ⚠️ 2026-09-30 用户口径（原话）：「图3 打开体验，**应该不能这样展示，应该就直接展示**」——
  //    他截的那一件是 `notes.txt`：卡片上只有一颗「打开体验」按钮，内容一个字都看不到。
  //    服务端现在把**人读得懂**的正文一起给过来（`textContent`），这里直接铺开显示、不再给那颗按钮。
  //    ⚠️ PPT/Word/Excel 的正文是规格文本（给渲染器看的），服务端不给 —— 那三类仍是"封面 + 打开体验"。
  const text = String(piece.textContent || '');
  // 真文件类（PPT/Word/Excel）：服务端转成 PDF 再 inline 显示 —— 与作品广场同一条路
  // （浏览器渲染不了 .pptx，卡片上只给「打开体验」等于没展示）。
  const docPreview = String(piece.previewUrl || '');
  return <>
    {text
      ? <pre className="share-piece__text">{text}{piece.textTruncated ? '…（内容较长，已截断）' : ''}</pre>
      : docPreview
        ? <div className="share-piece__stage"><iframe className="share-piece__doc" src={docPreview} title={name || '文档预览'} /></div>
        : (coverUrl ? <img className="share-piece__media" src={coverUrl} alt={name || '文档作品'} /> : null)}
    <p className="share-piece__play">
      {!text && !docPreview && openUrl ? <Link className="button soft" to={openUrl}>打开体验 <b>↗</b></Link> : null}
      {mediaUrl ? <a className="button soft" href={mediaUrl}>下载原件</a> : null}
    </p>
  </>;
}
