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
import { avatarGlyph, BrandLogo, createApiClient, Icon } from '@platform/shared';

const api = createApiClient();

/** 「分享作品」：优先用系统分享面板（手机浏览器支持），否则复制链接并给出微信里的手动路径。 */
async function sharePiece(url, title) {
  try {
    if (navigator.share) { await navigator.share({ title, url }); return '已唤起系统分享'; }
  } catch { /* 用户取消或浏览器不支持 → 走复制 */ }
  try {
    await navigator.clipboard.writeText(url);
    return '链接已复制：发给微信好友或贴进朋友圈即可';
  } catch {
    return `请手动复制这个地址：${url}`;
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

  const { student, org, lessonTitle, piece, work, homeUrl } = state.data;
  const glyph = avatarGlyph(student?.avatarKey);
  const initial = String(student?.name || '同学').slice(0, 1);

  return <main className="inner share-page">
    {/* 头：品牌 + 「学生来自：X机构」（用户口径点名要这一行） */}
    <header className="share-page__head">
      <BrandLogo height={30} />
      {org?.name ? <p className="share-page__from"><Icon name="book" /> 学生来自：{org.name}</p> : null}
    </header>

    <section className="share-card">
      <div className="share-card__who">
        <div className="sw-avatar" aria-hidden="true">
          {student?.avatarUrl ? <img src={student.avatarUrl} alt="" /> : (glyph || initial)}
        </div>
        <h1>{student?.name || '同学'}</h1>
      </div>

      <div className="share-card__piece">
        <PieceView piece={piece} />
      </div>

      <h2 className="share-card__label">作品简介</h2>
      <p className="share-card__desc">{lessonTitle || work?.title || '这节课的作品'}</p>

      <div className="share-page__actions">
        <button type="button" className="share-page__btn is-primary"
          onClick={async () => setNotice(await sharePiece(shareUrl, `${student?.name || '同学'}的作品`))}>
          <Icon name="share" /> 分享作品
        </button>
        <a className="share-page__btn is-site" href="/">查看官网</a>
      </div>
      {notice ? <p className="share-page__notice">{notice}</p> : null}
      {/* 没有公众号 → 不做 JS-SDK，给一条手动路径（微信里右上角就是分享入口） */}
      <p className="share-page__hint">在微信里打开时，点右上角「···」也可以发给朋友或分享到朋友圈。</p>
      {homeUrl ? <p className="share-page__home"><Link to={homeUrl}>看 TA 的主页 · 更多作品 <b>↗</b></Link></p> : null}
    </section>
  </main>;
}

/**
 * 那一件产出物怎么显示（按服务端给的 `render` 分派）：
 *   IMAGE/VIDEO/AUDIO → 就地看/听；HTML → **直接玩**（沙箱 iframe，与作品广场同一套口径）；
 *   DOC（PPT/Word/Excel）→ 给封面 + 「打开体验」/「下载原件」（转 PDF 预览那条路广场已有，这里先不重复造）。
 */
function PieceView({ piece }) {
  if (!piece) return <p className="muted">这一件已经不在最新版本里了。</p>;
  const { render, mediaUrl, coverUrl, openUrl, name } = piece;
  if (render === 'IMAGE' && mediaUrl) return <img className="share-piece__media" src={mediaUrl} alt={name || '作品'} />;
  if (render === 'VIDEO' && mediaUrl) return <video className="share-piece__media" src={mediaUrl} controls playsInline />;
  if (render === 'AUDIO' && mediaUrl) return <audio className="share-piece__audio" src={mediaUrl} controls />;
  if (render === 'HTML') {
    return <>
      {coverUrl ? <img className="share-piece__media" src={coverUrl} alt={name || '网页作品'} /> : null}
      {openUrl ? <p className="share-piece__play"><Link className="button" to={openUrl}>打开体验 · 直接玩 <b>↗</b></Link></p> : <p className="muted">这一件是网页作品，用电脑/手机打开就能玩。</p>}
    </>;
  }
  // 文档类（PPT / Word / Excel）
  return <>
    {coverUrl ? <img className="share-piece__media" src={coverUrl} alt={name || '文档作品'} /> : null}
    <p className="share-piece__play">
      {openUrl ? <Link className="button soft" to={openUrl}>打开体验 <b>↗</b></Link> : null}
      {mediaUrl ? <a className="button soft" href={mediaUrl}>下载原件</a> : null}
    </p>
  </>;
}
