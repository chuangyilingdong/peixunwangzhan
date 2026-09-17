// 教学素材查看器（2026-09-17，用户口径：老师只用在线看，且要能全屏讲课）。
//
// 两件事必须在这里做，别的层做不了：
//
// ① **关掉浏览器内置 PDF 阅读器的工具栏**。那一排「下载 / 旋转 / 打印 / 保存到云端硬盘 /
//    ⋮文档属性」是 **Chrome 自己的 UI**，不在我们的 DOM 里，删不掉 —— 唯一的办法是
//    用 URL 片段 `#toolbar=0&navpanes=0` 让整条工具栏不出现（已实测，见交接文档）。
//    代价是页码控件也一起没了，所以上一页 / 下一页由我们自己给。
//
// ② **全屏**。老师上课就是打开这些素材在讲，全屏是主场景。
//    全屏的是**整个面板**（不是内容区），这样全屏里仍然够得着翻页和关闭 —— 否则
//    进了全屏就只能干看着，翻不了页。
//
// ⚠️ 票据是**点开那一刻现取**的：抽屉可能是几小时前打开的，payload 里那张早过期了。
//    「课包里的素材随时能看」靠的是每次现签，而不是发一个不过期的长链接。
import { useEffect, useRef, useState } from 'react';
import { Empty, Notice } from '@platform/shared';

/** PDF / Office：把内置阅读器的工具栏关掉，只留页面本身。 */
const documentFragment = (page) => `#page=${page}&toolbar=0&navpanes=0&view=FitH`;

export function TeachingAssetViewer({ api, asset, onClose }) {
  const [state, setState] = useState({ loading: true, error: '', previewUrl: '', previewKind: asset?.previewKind || null });
  const [page, setPage] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const panelRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: '', previewUrl: '', previewKind: asset?.previewKind || null });
    setPage(1);
    if (!asset?.fileAssetId) {
      setState({ loading: false, error: '这份素材没有可预览的文件。', previewUrl: '', previewKind: null });
      return () => { cancelled = true; };
    }
    api.get(`org/file-assets/${encodeURIComponent(asset.fileAssetId)}/preview-ticket`)
      .then((data) => {
        if (cancelled) return;
        setState({ loading: false, error: data?.previewUrl ? '' : '平台暂时无法预览这份素材。', previewUrl: data?.previewUrl || '', previewKind: data?.previewKind || asset?.previewKind || null });
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, error: error?.message || '预览票据获取失败，请重试。', previewUrl: '', previewKind: null });
      });
    return () => { cancelled = true; };
  }, [api, asset?.fileAssetId]);

  // Esc 的默认行为是退出全屏，这时别把整个查看器也关掉 —— 老师按 Esc 通常只想退出全屏
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || document.fullscreenElement) return;
      event.stopPropagation();
      onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, []);

  function toggleFullscreen() {
    const node = panelRef.current;
    if (!node) return;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else node.requestFullscreen?.().catch(() => setFullscreen(false));
  }

  const kind = state.previewKind;
  const isDocument = Boolean(state.previewUrl) && kind !== 'VIDEO' && kind !== 'AUDIO' && kind !== 'IMAGE' && kind !== 'OTHER';

  return <div className="preview-overlay" onClick={() => { if (!document.fullscreenElement) onClose?.(); }}>
    <div className="preview-panel ta-panel" ref={panelRef} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
      <header className="preview-head">
        <div>
          <span className="eyebrow">在线预览（不提供下载）</span>
          <h3>{asset?.title || '教学素材'}</h3>
        </div>
        <div className="row-actions">
          <button type="button" className="secondary-button" onClick={toggleFullscreen}>
            {fullscreen ? '退出全屏' : '全屏观看'}
          </button>
          <button type="button" className="drawer-close" onClick={() => { if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); onClose?.(); }} aria-label="关闭预览">×</button>
        </div>
      </header>

      <div className="preview-stage">
        <div className="preview-watermark" aria-hidden="true">内部备课资料 · 请勿外传 · {new Date().toLocaleString('zh-CN')}</div>
        {state.loading ? <p className="ta-state">正在准备预览…</p>
          : state.error ? <div className="ta-state"><Notice tone="warning">{state.error}</Notice></div>
            : kind === 'VIDEO' ? <video src={state.previewUrl} controls controlsList="nodownload noplaybackrate noremoteplayback" disablePictureInPicture />
              : kind === 'AUDIO' ? <audio src={state.previewUrl} controls controlsList="nodownload" />
                : kind === 'IMAGE' ? <img className="ta-image" src={state.previewUrl} alt={asset?.title || '教学素材'} />
                  : kind === 'OTHER' ? <div className="ta-state"><Empty title="这种格式无法在线预览" body="请联系平台把它转成 PDF、图片或视频。" /></div>
                    : isDocument ? <iframe key={page} className="preview-frame" title={asset?.title || '教学素材'}
                      src={`${state.previewUrl}${documentFragment(page)}`} />
                      : <div className="ta-state"><Empty title="暂无可预览内容" body="这份素材没有可以展示的正文。" /></div>}
      </div>

      {/* 工具栏留在面板内、跟着一起全屏 —— 全屏时正是最需要翻页的时候 */}
      <footer className="ta-toolbar">
        {isDocument ? <>
          <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>‹ 上一页</button>
          <span className="ta-page">第 {page} 页</span>
          <button type="button" className="secondary-button" onClick={() => setPage((value) => value + 1)}>下一页 ›</button>
        </> : <span className="ta-page">{kind === 'VIDEO' ? '视频' : kind === 'AUDIO' ? '音频' : kind === 'IMAGE' ? '图片' : '素材'}预览</span>}
        <span className="ta-hint muted">PPT / Word 已由平台转换成 PDF 后展示，原始文件不会下发；链接带时效，转发出去会失效。</span>
      </footer>
    </div>
  </div>;
}
