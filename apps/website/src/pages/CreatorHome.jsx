// 官网 - **学生个人主页**（对外公开，路由 `/u/<token>`）
//
// ⚠️ 2026-09-27 用户口径：「学生创建了账号应该就有个主页的专属链接。现在需要把『我的作品』改成
//    主页的概念。对外公开并且可以分享。」于是有了这一页 —— 它是「我的作品」的**对外那一面**：
//    同一种视觉（复用 `components/workCard.jsx` 的封面与类型标签、同一套 `.sw-*` 样式），
//    但**只显示这个学生已公开的作品**（服务端 `GET /api/public/creators/:token` 按广场那套判据过滤）。
//
// 三条硬口径（都**不能**在这一页上放宽）：
//   · 名字是**服务端脱敏后**的（匿名 → 「小创作者」；非匿名 → 首字 + 同学）。这一页**拿不到**完整姓名，
//     也不该去要 —— 对外可见的信息量与作品广场保持一致（未成年人平台）。
//   · 没公开的作品**一条都不出现**（服务端过滤，前端不做二次判断）。
//   · 未登录可访问（和 `/works/:token` 一样是公开页，不需要 session）。
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { avatarGlyph } from '@platform/shared';
import { WorkCover, workType } from '../components/workCard.jsx';
import { absoluteUrl, copyToClipboard } from '../components/clipboard.js';

export function CreatorHomePage({ api }) {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, error: null, creator: null });
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let live = true;
    setState({ loading: true, error: null, creator: null });
    api.get(`public/creators/${encodeURIComponent(token)}`)
      .then((payload) => { if (live) setState({ loading: false, error: null, creator: payload || null }); })
      .catch((error) => { if (live) setState({ loading: false, error: error.message, creator: null }); });
    return () => { live = false; };
  }, [api, token]);

  const creator = state.creator;
  const items = creator?.items || [];
  const initial = String(creator?.name || '小创作者').trim().charAt(0) || '小';
  const glyph = avatarGlyph(creator?.avatarKey);

  async function share() {
    const url = absoluteUrl(`/u/${token}`);
    const copied = await copyToClipboard(url);
    setNotice(copied ? `链接已复制：${url}` : `请手动复制这个地址：${url}`);
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
      {/* 这一页是**只读展示**：头像不是按钮（改头像只在学生自己的「我的作品」页上）。
          三级优先：学生上传的照片 > 预设头像 > 名字首字。 */}
      <div className="sw-avatar" data-testid="home-avatar-readonly" aria-hidden="true">
        {creator.avatarUrl ? <img src={creator.avatarUrl} alt="" /> : (glyph || initial)}
      </div>
      <div className="sw-profile-main">
        <h1 data-testid="home-name">{creator.name}</h1>
        <p className="sw-stats">
          <span><strong>{Number(creator.workCount) || 0}</strong> 件公开作品</span>
          {Number(creator.featuredCount) > 0 ? <span><strong>{Number(creator.featuredCount)}</strong> 件精选</span> : null}
        </p>
        <p className="sw-bio">这是 {creator.name} 的主页，只显示 TA 已公开到作品广场的作品。</p>
        <p className="sw-home-actions">
          <button type="button" className="button soft" data-testid="share-home-public" onClick={share}>分享这个主页</button>
        </p>
        {notice ? <p className="sw-home-panel__notice" data-testid="home-public-notice">{notice}</p> : null}
      </div>
    </header>

    {items.length ? <div className="student-card-grid sw-grid">{items.map((work) => {
      const type = workType(work);
      return <article className="student-card sw-card" key={work.id}>
        <Link className="sw-card__link" to={work.publicUrl || '/works'}>
          <div className="student-work-card__cover">
            <WorkCover work={work} type={type} />
            <span className="student-work-card__type">{type.label}</span>
          </div>
          <h3 className="sw-card__title">{work.title}</h3>
          <div className="sw-card__foot">
            {work.featured ? <span className="student-badge is-ok">精选</span> : null}
            <span className="sw-card__from">{work.orgName || '灵动ai学院'}</span>
          </div>
        </Link>
      </article>;
    })}</div> : <div className="student-page-state">
      ✦ 这个主页上还没有公开的作品。<br />学生把作品公开到作品广场之后，就会出现在这里。
      <div className="student-page-actions"><Link className="button soft" to="/works">去作品广场看看 <b>↗</b></Link></div>
    </div>}

    <div className="student-page-actions"><Link className="button soft" to="/works">看看更多作品 <b>↗</b></Link></div>
  </main>;
}
