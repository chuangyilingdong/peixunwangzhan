// 教学素材查看器（2026-09-17）。
//
// 用户口径：老师只用在线看，**不能有任何下载/导出/打印的口子**，而且要能全屏讲课。
//
// 为什么不是「把 PDF 塞进 iframe」：那样渲染的是**浏览器内置 PDF 阅读器**，它是插件 ——
// 工具栏按钮不在我们的 DOM 里（`#toolbar=0` 只能让它们不出现），更要紧的是
// **Ctrl+P / Ctrl+S / 右键菜单都不经过我们的页面**，事件收不到也就拦不住。
// 所以要真堵死，只能自己渲染：用 pdf.js 把每页画到 <canvas> 上，DOM 全归我们。
//
// 于是这里能做三件 iframe 时代做不到的事：
//   ① 拦掉 Ctrl/Cmd + P / S / U（capture 阶段 preventDefault，抢在浏览器默认行为之前）；
//   ② 右键菜单直接 preventDefault，画布上没有「图片另存为」；
//   ③ 打印样式里把查看器整个藏掉 —— 万一从浏览器菜单走打印，打出来也是白纸。
//
// ⚠️ 说清楚边界：这样堵住的是「界面上的口子」。**截屏与录屏在 web 上无法阻止**
//    （能看见就能被拍下来），拿到文件字节也能靠开 DevTools 做到。这是物理限制，
//    不是实现没做到 —— 用户口径里要的就是「界面上没有下载入口、快捷键也不好使」。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Empty, Notice } from '@platform/shared';

// pdf.js 只在**真的打开素材**时才加载（动态 import → 单独的 chunk），
// 免得每个进机构端的老师都为它付带宽。worker 是个静态 URL，很小。
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
  }
  return pdfjsPromise;
}

const DOCUMENT_KINDS = new Set(['PDF', 'OFFICE']);

export function TeachingAssetViewer({ api, asset, onClose }) {
  const [state, setState] = useState({ loading: true, error: '', previewUrl: '', previewKind: asset?.previewKind || null });
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rendering, setRendering] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const pdfRef = useRef(null);
  const pdfUrlRef = useRef('');
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const panelRef = useRef(null);
  const renderTokenRef = useRef(0);

  const kind = state.previewKind;
  const isDocument = DOCUMENT_KINDS.has(kind);

  /* ① 取一张**现签**的预览票据：抽屉可能是几小时前打开的，它那份 payload 里的票据早过期了。 */
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: '', previewUrl: '', previewKind: asset?.previewKind || null });
    setPage(1); setZoom(1); setPageCount(0);
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

  /* ② 文档形态：拉字节 → 交给 pdf.js。走 fetchBlobUrl 是为了带上会话鉴权头（不必依赖票据）。 */
  useEffect(() => {
    if (!state.previewUrl || !isDocument) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const blobUrl = await api.fetchBlobUrl(state.previewUrl);
        if (cancelled) { URL.revokeObjectURL(blobUrl); return; }
        pdfUrlRef.current = blobUrl;
        const pdfjs = await loadPdfjs();
        const pdf = await pdfjs.getDocument({ url: blobUrl }).promise;
        if (cancelled) { pdf.destroy?.(); return; }
        pdfRef.current = pdf;
        setPageCount(pdf.numPages);
        setPage(1);
      } catch (error) {
        if (!cancelled) setState((old) => ({ ...old, error: `文档解析失败：${error?.message || '未知错误'}` }));
      }
    })();
    return () => {
      cancelled = true;
      renderTokenRef.current += 1;
      pdfRef.current?.destroy?.().catch?.(() => {});
      pdfRef.current = null;
      if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = ''; }
    };
  }, [api, state.previewUrl, isDocument]);

  /* ③ 画当前页。zoom=1 表示「适应宽度」，所以基准比例按容器宽度算。 */
  const draw = useCallback(async () => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;
    const token = ++renderTokenRef.current;
    setRendering(true);
    try {
      const pdfPage = await pdf.getPage(page);
      if (token !== renderTokenRef.current) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const available = Math.max(320, (stageRef.current?.clientWidth || 900) - 36);
      const scale = (available / base.width) * zoom;
      const viewport = pdfPage.getViewport({ scale });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const context = canvas.getContext('2d');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      await pdfPage.render({ canvasContext: context, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise;
    } catch (error) {
      // 快速翻页会取消上一帧，pdf.js 用 RenderingCancelledException 表达，不是错误
      if (!/cancel/i.test(String(error?.name || error?.message || ''))) {
        setState((old) => ({ ...old, error: `这一页渲染失败：${error?.message || '未知错误'}` }));
      }
    } finally {
      if (token === renderTokenRef.current) setRendering(false);
    }
  }, [page, zoom]);

  useEffect(() => { if (pageCount) draw(); }, [pageCount, draw]);

  /* ④ 堵快捷键：Ctrl/Cmd + P（打印）/ S（保存）/ U（查看源码）。capture 阶段抢在默认行为之前。 */
  useEffect(() => {
    const onKeyDown = (event) => {
      const key = String(event.key || '').toLowerCase();
      if ((event.ctrlKey || event.metaKey) && ['p', 's', 'u'].includes(key)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  /* ⑤ 键盘翻页（现在事件是我们的了，讲课时翻页顺手很多）；Esc 在全屏时只退全屏。 */
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (document.fullscreenElement) return;   // 交给浏览器退全屏
        onClose?.();
        return;
      }
      if (!isDocument) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); setPage((value) => (pageCount ? Math.min(pageCount, value + 1) : value + 1)); }
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); setPage((value) => Math.max(1, value - 1)); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isDocument, pageCount, onClose]);

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

      <div className="preview-stage" ref={stageRef}>
        <div className="preview-watermark" aria-hidden="true">内部备课资料 · 请勿外传 · {new Date().toLocaleString('zh-CN')}</div>
        {state.loading ? <p className="ta-state">正在准备预览…</p>
          : state.error && !isDocument ? <div className="ta-state"><Notice tone="warning">{state.error}</Notice></div>
            : kind === 'VIDEO' ? <video src={state.previewUrl} controls controlsList="nodownload noplaybackrate noremoteplayback" disablePictureInPicture />
              : kind === 'AUDIO' ? <audio src={state.previewUrl} controls controlsList="nodownload" />
                : kind === 'IMAGE' ? <img className="ta-image" src={state.previewUrl} alt={asset?.title || '教学素材'} draggable="false" />
                  : kind === 'OTHER' ? <div className="ta-state"><Empty title="这种格式无法在线预览" body="请联系平台把它转成 PDF、图片或视频。" /></div>
                    : isDocument ? <div className="ta-canvas-wrap">
                      <canvas ref={canvasRef} className="ta-canvas" />
                      {rendering ? <span className="ta-rendering">正在渲染第 {page} 页…</span> : null}
                      {state.error ? <div className="ta-render-error"><Notice tone="warning">{state.error}</Notice></div> : null}
                    </div>
                      : <div className="ta-state"><Empty title="暂无可预览内容" body="这份素材没有可以展示的正文。" /></div>}
      </div>

      <footer className="ta-toolbar">
        {isDocument ? <>
          <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>‹ 上一页</button>
          <span className="ta-page">第 {page}{pageCount ? ` / 共 ${pageCount}` : ''} 页</span>
          <button type="button" className="secondary-button" disabled={Boolean(pageCount) && page >= pageCount} onClick={() => setPage((value) => value + 1)}>下一页 ›</button>
          <span className="ta-zoom">
            <button type="button" className="secondary-button" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.25).toFixed(2))))} aria-label="缩小">−</button>
            <span className="ta-page">{Math.round(zoom * 100)}%</span>
            <button type="button" className="secondary-button" disabled={zoom >= 4} onClick={() => setZoom((value) => Math.min(4, Number((value + 0.25).toFixed(2))))} aria-label="放大">＋</button>
            <button type="button" className="text-button" disabled={zoom === 1} onClick={() => setZoom(1)}>适应宽度</button>
          </span>
        </> : <span className="ta-page">{kind === 'VIDEO' ? '视频' : kind === 'AUDIO' ? '音频' : kind === 'IMAGE' ? '图片' : '素材'}预览</span>}
        <span className="ta-hint muted">PPT / Word 已由平台转换成 PDF 后展示，原始文件不会下发；素材仅可在本页查看，请勿截屏外传。</span>
      </footer>
    </div>
  </div>;
}
