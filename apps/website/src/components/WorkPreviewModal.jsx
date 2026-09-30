// 作品预览**弹窗**（2026-09-27 用户口径：「改成弹窗那样的。」）
//
// 用在学生个人主页上：点一张作品卡 → 弹出一屏大预览（关掉回列表），不再跳到另一个页面。
// 样式直接复用广场那个查看层的类（`.pl-viewer*`，在 styles.css 里，全局可用）——
// ⚠️ 广场那个 `WorkViewer` 写死在 main.jsx 里、和一堆广场助手耦合很深，这次没搬它；
//    这里复用它的**样式**、复用它同款的**渲染器**（只读画布 / 网页预览 / 图片），
//    所以两边看起来是一套。哪天要合并成一个组件，动的是 main.jsx，别把这份也拆开。
import { useEffect, useMemo, useState } from 'react';
import { CanvasEditor } from '@platform/canvas';
import { buildPreviewDocument, ReplayPreview } from '@platform/shared';
import { workType } from './workCard.jsx';
// ⭐ 2026-09-30：作品分享的二维码 —— 用仓库里 vendored 的那份实现（零依赖；正确性已与 npm 成熟库逐格比对）。
import qrcode from '@platform/shared/vendor/qrcode-generator.mjs';

/** 二维码 SVG（黑白两色、带静默边）。 */
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
 * 这件作品里的**每一件产出物**（分享面板里"选哪一件"用的那份下拉 —— 一节课出 1 张图 + 1 段视频时有两个选项）。
 * `pieceKey` 是**服务端算好的**（画布 `media:…` / VibeCoding `artifact:…`），前端别自己拼。
 */
function piecesOf(detail, source) {
  if (source === 'VIBECODING') {
    return (detail?.artifacts || []).filter((item) => item?.pieceKey).map((item) => ({ pieceKey: item.pieceKey, label: item.name || '这一件' }));
  }
  const labels = { IMAGE: '图片', VIDEO: '视频', AUDIO: '音频' };
  return (detail?.media || []).filter((item) => item?.pieceKey).map((item) => ({ pieceKey: item.pieceKey, label: item.caption || labels[item.modality] || '这一件' }));
}

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
 * @param studentApi / isOwner 主人才能分享（发码要走学生会话）—— 访客看不到那个按钮
 */
export function WorkPreviewModal({ api, studentApi = null, isOwner = false, creatorToken, source, work, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, detail: null });
  // ⭐ 2026-09-30（用户口径）：分享入口在**作品详情右上角**（不是列表卡片上）——
  //    多件产出物时在面板里"选哪一件"（一节课出 1 张图 + 1 段视频就是两个选项），各自独立分享。
  const [share, setShare] = useState(null);   // { pieces, pieceKey, url, svg }
  const [shareBusy, setShareBusy] = useState(false);
  const [shareNotice, setShareNotice] = useState('');

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
  const pieces = useMemo(() => piecesOf(detail, source), [detail, source]);

  /** 发码 + 生成二维码（码是幂等的：同一件反复选给的是同一枚）。 */
  async function sharePiece(pieceKey) {
    if (!studentApi || shareBusy) return;
    setShareBusy(true); setShareNotice('');
    try {
      const saved = await studentApi.post('student/share-links', { source, workId: work.id, pieceKey });
      const url = `${window.location.origin}/s/${saved.code}`;
      setShare((current) => ({ pieces, pieceKey, url, svg: qrSvgText(url), open: current?.open ?? true }));
    } catch (error) { setShareNotice(`分享没成功：${error.message}`); }
    finally { setShareBusy(false); }
  }

  return <div className="pl-viewer" role="dialog" aria-modal="true" aria-label={`查看作品：${work.title || ''}`} data-testid="work-modal" onClick={onClose}>
    <div className='pl-viewer-box has-frame' onClick={(event) => event.stopPropagation()}>
      <div className="pl-viewer-head">
        <div><span className="pl-badge">{type.label}</span><h3>{work.title}</h3></div>
        <div className="pl-viewer-head__actions">
          {/* 分享：主人可见（访客没有学生会话，发不了码）。点开 → 选哪一件 + 二维码 */}
          {isOwner && detail ? <button type="button" className="pl-viewer-share" data-testid="work-share"
            disabled={shareBusy || !pieces.length}
            onClick={() => (pieces.length ? sharePiece(pieces[0].pieceKey) : setShareNotice('这件作品还没有可分享的产出物'))}>
            分享
          </button> : null}
          <button type="button" className="pl-viewer-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
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

    {/* 分享面板：选哪一件（多件时）+ 二维码 + 复制链接。
        ⚠️ 目前**没有公众号** → 不做微信 JS-SDK，给"复制链接" + "微信里点右上角 ···"的手动路径。 */}
    {share ? <div className="share-modal" role="dialog" aria-modal="true" data-testid="share-modal" onClick={(event) => event.stopPropagation()}>
      <div className="share-modal__panel">
        <div className="share-modal__head"><strong>分享作品</strong><button type="button" className="text-button" onClick={() => { setShare(null); setShareNotice(''); }}>关闭</button></div>
        <p className="share-modal__title">{work.title}{share.pieces.find((piece) => piece.pieceKey === share.pieceKey)?.label ? ` · ${share.pieces.find((piece) => piece.pieceKey === share.pieceKey).label}` : ''}</p>
        {share.pieces.length > 1 ? <label className="share-modal__pick">选哪一件
          <select value={share.pieceKey} onChange={(event) => sharePiece(event.target.value)} data-testid="share-piece-select">
            {share.pieces.map((piece) => <option key={piece.pieceKey} value={piece.pieceKey}>{piece.label}</option>)}
          </select>
        </label> : null}
        <div className="share-modal__qr" dangerouslySetInnerHTML={{ __html: share.svg }} />
        <p className="share-modal__hint">用手机扫这个二维码，就能看到这一件。</p>
        <div className="share-modal__actions">
          <button type="button" className="button" onClick={async () => {
            try { await navigator.clipboard.writeText(share.url); setShareNotice(`链接已复制：${share.url}`); }
            catch { setShareNotice(`请手动复制：${share.url}`); }
          }}>复制链接</button>
          <a className="button soft" href={share.url} target="_blank" rel="noreferrer">先看看分享页</a>
        </div>
        {shareNotice ? <p className="share-modal__hint">{shareNotice}</p> : null}
        <p className="share-modal__hint">在微信里打开时，点右上角「···」也能发给朋友或分享到朋友圈。</p>
      </div>
    </div> : null}
  </div>;
}
