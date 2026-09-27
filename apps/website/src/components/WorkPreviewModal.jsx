// 作品预览**弹窗**（2026-09-27 用户口径：「改成弹窗那样的。」）
//
// 用在学生个人主页上：点一张作品卡 → 弹出一屏大预览（关掉回列表），不再跳到另一个页面。
// 样式直接复用广场那个查看层的类（`.pl-viewer*`，在 styles.css 里，全局可用）——
// ⚠️ 广场那个 `WorkViewer` 写死在 main.jsx 里、和一堆广场助手耦合很深，这次没搬它；
//    这里复用它的**样式**、复用它同款的**渲染器**（只读画布 / 网页预览 / 图片），
//    所以两边看起来是一套。哪天要合并成一个组件，动的是 main.jsx，别把这份也拆开。
import { useEffect, useState } from 'react';
import { CanvasEditor } from '@platform/canvas';
import { buildPreviewDocument, ReplayPreview } from '@platform/shared';
import { workType } from './workCard.jsx';

/** 画布快照里的「学生域素材地址」→ 这份作品专属的公开代理（与详情页同一条规则）。 */
function canvasResolve(detail) {
  return (value) => {
    const raw = String(value || '');
    const match = raw.match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:[?#].*)?$/);
    if (!match) return raw;
    return (detail?.media || []).find((item) => item.fileId === match[1])?.url || null;
  };
}

/**
 * @param api 公开客户端（取作品详情走 `/api/public/creators/...`，不需要登录）
 * @param source 'CANVAS' | 'VIBECODING'（服务端在列表里带上了）
 */
export function WorkPreviewModal({ api, creatorToken, source, work, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, detail: null });

  useEffect(() => {
    let live = true;
    api.get(`public/creators/${encodeURIComponent(creatorToken)}/works/${encodeURIComponent(source)}/${encodeURIComponent(work.id)}`)
      .then((payload) => { if (live) setState({ loading: false, error: null, detail: payload || null }); })
      .catch((error) => { if (live) setState({ loading: false, error: error.message, detail: null }); });
    return () => { live = false; };
  }, [api, creatorToken, source, work.id]);

  // Esc 关闭 + 锁住背景滚动（与广场那个查看层同一套做法：不锁的话小屏上一滑动的是底下的列表）
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const detail = state.detail;
  const type = workType(work);
  const isVibe = source === 'VIBECODING';
  const entry = String(detail?.entryFile || '');

  return <div className="pl-viewer" role="dialog" aria-modal="true" aria-label={`查看作品：${work.title || ''}`} data-testid="work-modal" onClick={onClose}>
    <div className='pl-viewer-box has-frame' onClick={(event) => event.stopPropagation()}>
      <div className="pl-viewer-head">
        <div><span className="pl-badge">{type.label}</span><h3>{work.title}</h3></div>
        <button type="button" className="pl-viewer-close" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="pl-viewer-body">
        {state.loading ? <div className="c-page__center">正在打开作品…</div> : null}
        {state.error ? <div className="c-page__center">⚠ {state.error}</div> : null}
        {detail ? (isVibe
          ? <div className="creator-modal__web"><ReplayPreview html={buildPreviewDocument(detail.files, entry)} title={detail.title || '作品预览'} fitContent /></div>
          : <div className="work-detail__canvas"><CanvasEditor key={detail.id} initialSnapshot={detail.canvasSnapshot} readOnly showStarter={false} resolveAssetUrl={canvasResolve(detail)} /></div>) : null}
      </div>
      <div className="pl-viewer-foot">
        <span>{detail?.studentName || ''}</span>
        <span>{detail?.orgName || ''}</span>
      </div>
    </div>
  </div>;
}
