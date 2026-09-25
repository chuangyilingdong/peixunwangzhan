// 教学素材查看器（2026-09-17；2026-09-25 加"放映形态"）。
//
// 用户口径：老师只用在线看，**不能有任何下载/导出/打印的口子**，而且要能全屏讲课。
//
// 为什么不用「把 PDF 塞进 iframe」：那样渲染的是**浏览器内置 PDF 阅读器**，它是插件 ——
// 工具栏按钮不在我们的 DOM 里，更要紧的是 **Ctrl+P / Ctrl+S / 右键菜单都不经过我们的页面**，
// 事件收不到也就拦不住。所以要真堵死，只能自己渲染：pdf.js 把页面画到 <canvas>。
//
// 两种形态（2026-09-25 按用户口径拆开）：
//   · **DOCUMENT（Word / PDF）**：所有页纵向连续排列、按容器宽度铺满，滚轮就是往下滑 ——
//     这是阅读器该有的手感（用户原话「文档应该是有那种慢慢滑下去的感觉」）。
//   · **SLIDES（PPT）**：**一屏一张、整张适应窗口**，配一条缩略图条 + 键盘/点击翻页 ——
//     用户口径「能否真的就是 PPT 形式」：PPT 该像放映一样翻，不该像文档那样滚。
//     两种形态读的是同一份服务端转出来的 PDF（原始 .pptx 仍旧不下发，见 materialPreview.js），
//     差别只在怎么排、怎么翻。
//
// 内存：只渲染**看得见的那几页**（滚动窗口 / 当前这张 + 视口内的缩略图），
// 离得远的 canvas 直接把 backing store 释放掉（width=0），回来再画。
// 一份 30 页文档若全渲染，dpr=2 时能吃掉几百 MB，那是不能接受的。
//
// ⚠️ 边界：截屏与录屏在 web 上拦不住（能看见就能被拍下来），开 DevTools 也能拿到字节 ——
//    这是物理限制，不是实现没做到。界面上做到的是：没有下载入口、快捷键被拦、右键没菜单、打印出白纸。
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

const PDF_KINDS = new Set(['PDF', 'OFFICE']);
const PAGE_GAP = 16;       // 页间距（px），与 CSS 的 gap 保持一致
const RENDER_BUFFER = 1;   // 视口前后各多画一页
const SLIDE_PADDING = 36;  // 放映台上下的留白（与 .ta-slide-stage 的 padding 对齐）
const THUMB_WIDTH = 132;   // 缩略图条的宽度（px）

export function TeachingAssetViewer({ api, asset, onClose }) {
  const [state, setState] = useState({ loading: true, error: '', previewUrl: '', previewKind: asset?.previewKind || null, previewMode: asset?.previewMode || null });
  const [pages, setPages] = useState([]);        // 每页的原始尺寸（PDF 单位）
  const [zoom, setZoom] = useState(1);           // 文档：1 = 按容器宽度铺满；放映：1 = 整张适应窗口
  const [current, setCurrent] = useState(1);     // 当前可见页 / 当前这张幻灯片
  const [scaleBase, setScaleBase] = useState(1); // 文档形态「铺满宽度」对应的缩放比
  const [slideBox, setSlideBox] = useState({ width: 0, height: 0 }); // 放映台的可用尺寸
  const [renderingPage, setRenderingPage] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const pdfRef = useRef(null);
  const canvasRefs = useRef(new Map());          // 页码 → canvas（文档形态）
  const renderTasksRef = useRef(new Map());      // 页码 → 正在跑的 pdf.js 渲染任务（文档形态）
  const slideCanvasRef = useRef(null);           // 放映形态唯一的那块画布
  const slideTaskRef = useRef(null);             // 放映形态正在跑的渲染任务
  const slideStampRef = useRef(0);               // 翻页令牌：晚到的旧渲染结果不许上屏
  const railRef = useRef(null);
  const thumbCanvasRefs = useRef(new Map());
  const thumbDoneRef = useRef(new Set());
  const thumbQueueRef = useRef(Promise.resolve());
  const wrapRef = useRef(null);
  const stageBoxRef = useRef(null);
  const panelRef = useRef(null);
  const scrollTokenRef = useRef(0);

  const kind = state.previewKind;
  const mode = state.previewMode === 'SLIDES' ? 'SLIDES' : 'DOCUMENT';
  const isSlides = mode === 'SLIDES' && PDF_KINDS.has(kind);
  const isDocument = mode === 'DOCUMENT' && PDF_KINDS.has(kind);
  const isPdfBacked = PDF_KINDS.has(kind);
  const scale = scaleBase * zoom;
  // 放映形态按**当前这张**的原始比例算"整张适应窗口"（同一份课件各张尺寸一般一致，
  // 但混排的课件也照样对）。倍率之外再乘老师的缩放。
  const slidePage = pages[current - 1] || null;
  const slideScale = slidePage && slideBox.width && slideBox.height
    ? Math.min((slideBox.width - SLIDE_PADDING) / slidePage.width, (slideBox.height - SLIDE_PADDING) / slidePage.height) * zoom
    : 0;

  /* ① 取一张**现签**的预览票据：抽屉可能是几小时前打开的，它那份 payload 里的票据早过期了。 */
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: '', previewUrl: '', previewKind: asset?.previewKind || null, previewMode: asset?.previewMode || null });
    setPages([]); setZoom(1); setCurrent(1);
    thumbDoneRef.current.clear();
    thumbCanvasRefs.current.clear();
    if (!asset?.fileAssetId) {
      setState({ loading: false, error: '这份素材没有可预览的文件。', previewUrl: '', previewKind: null, previewMode: null });
      return () => { cancelled = true; };
    }
    api.get(`org/file-assets/${encodeURIComponent(asset.fileAssetId)}/preview-ticket`)
      .then((data) => {
        if (cancelled) return;
        setState({
          loading: false,
          error: data?.previewUrl ? '' : '平台暂时无法预览这份素材。',
          previewUrl: data?.previewUrl || '',
          previewKind: data?.previewKind || asset?.previewKind || null,
          previewMode: data?.previewMode || asset?.previewMode || null,
        });
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, error: error?.message || '预览票据获取失败，请重试。', previewUrl: '', previewKind: null, previewMode: null });
      });
    return () => { cancelled = true; };
  }, [api, asset?.fileAssetId]);

  /* ② 文档/放映都交给 pdf.js（同一个票据地址）。
     ⚠️ 不要先 api.fetchBlobUrl 再喂 blob: 地址 —— 生产 CSP 是 `connect-src 'self'`，
        而 Chrome **不把 'self' 算作覆盖 blob:**（img-src / media-src 里我们当初为画布素材
        显式加了 blob:，connect-src 没有），于是 pdf.js 的请求状态是 0，界面报
        「Unexpected server response (0) while retrieving PDF "blob:…"」。
        票据就在查询串里，同源请求本来就带得上凭据，根本不需要那个 blob。
     ⭐ 2026-09-25 起这个地址对 OSS 上的课件是 **302 到 OSS 签名地址**（字节不再走这台机的
        5 Mbps 出口）；pdf.js 走 fetch、桶上有 CORS，跨域照样读得到 —— CSP 的 connect-src
        里那条 OSS 域就是为它留的。 */
  useEffect(() => {
    if (!state.previewUrl || !isPdfBacked) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const pdf = await pdfjs.getDocument({ url: state.previewUrl }).promise;
        if (cancelled) { pdf.destroy?.(); return; }
        pdfRef.current = pdf;
        // 先把每页尺寸量出来：占位块要按真实比例撑开，否则滚动条会一直跳；
        // 放映形态也靠它算"整张适应窗口"的比例。
        const sizes = [];
        for (let index = 1; index <= pdf.numPages; index += 1) {
          const pdfPage = await pdf.getPage(index);
          const viewport = pdfPage.getViewport({ scale: 1 });
          sizes.push({ width: viewport.width, height: viewport.height });
        }
        if (cancelled) return;
        setPages(sizes);
      } catch (error) {
        if (!cancelled) setState((old) => ({ ...old, error: `文档解析失败：${error?.message || '未知错误'}` }));
      }
    })();
    return () => {
      cancelled = true;
      scrollTokenRef.current += 1;
      slideStampRef.current += 1;
      // 先把在跑的任务全取消（否则 pdf destroy 时它们还在往画布上画）
      for (const task of renderTasksRef.current.values()) { try { task.cancel(); } catch { /* ignore */ } }
      renderTasksRef.current.clear();
      if (slideTaskRef.current) { try { slideTaskRef.current.cancel(); } catch { /* ignore */ } slideTaskRef.current = null; }
      pdfRef.current?.destroy?.().catch?.(() => {});
      pdfRef.current = null;
      canvasRefs.current.clear();
    };
  }, [state.previewUrl, isPdfBacked]);

  /* ③-1 文档形态「铺满宽度」的基准比例：按容器可用宽度算；全屏、改窗口、换文档都要重算。 */
  const recompute = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || !pages.length) return;
    const available = Math.max(320, wrap.clientWidth - 36);
    setScaleBase(available / pages[0].width);
  }, [pages]);

  useEffect(() => {
    if (!isDocument) return undefined;
    recompute();
    const onResize = () => recompute();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [recompute, fullscreen, isDocument]);

  /* ③-2 放映形态的可用台面：量出来才能算"整张适应窗口"。 */
  useEffect(() => {
    if (!isSlides) return undefined;
    const node = stageBoxRef.current;
    if (!node) return undefined;
    const measure = () => setSlideBox({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [isSlides, fullscreen, pages.length]);

  /* ④-1 文档形态：按滚动位置算「该画哪几页」：只画窗口内的，离得远的释放掉。 */

  /**
   * 取消某页正在跑的渲染任务，并**等它真正结束**。
   * pdf.js 不允许同一块 canvas 上并存两个渲染任务 —— 旧任务还在画的时候开新任务，
   * 缓冲区会被写花（用户看到的就是「全屏之后画面倒着、内容对不上」）。
   */
  const cancelRender = useCallback(async (pageNumber) => {
    const task = renderTasksRef.current.get(pageNumber);
    if (!task) return;
    renderTasksRef.current.delete(pageNumber);
    try { task.cancel(); await task.promise; } catch { /* 取消会 reject，属正常 */ }
  }, []);

  const renderWindow = useCallback(async () => {
    const pdf = pdfRef.current;
    const wrap = wrapRef.current;
    if (!pdf || !wrap || !pages.length || !scale || !isDocument) return;
    const token = ++scrollTokenRef.current;
    const tops = [];
    let offset = 0;
    for (const page of pages) { tops.push(offset); offset += page.height * scale + PAGE_GAP; }
    const viewTop = wrap.scrollTop;
    const viewBottom = viewTop + wrap.clientHeight;
    const firstTop = tops.findIndex((top, index) => top + pages[index].height * scale >= viewTop);
    const first = Math.max(0, (firstTop < 0 ? 0 : firstTop) - RENDER_BUFFER);
    const lastTop = tops.findIndex((top) => top > viewBottom);
    const last = lastTop < 0 ? pages.length - 1 : Math.min(pages.length - 1, lastTop + RENDER_BUFFER);
    // 释放窗口外的 canvas：只清 backing store，占位高度不变，滚回来会重画
    for (const [pageNumber, canvas] of [...canvasRefs.current]) {
      const index = pageNumber - 1;
      if (index < first || index > last) {
        await cancelRender(pageNumber);
        if (canvas.width) { canvas.width = 0; canvas.height = 0; }
        canvasRefs.current.delete(pageNumber);
      }
    }
    // 视口中心所在页 = 页码显示的那一页
    const middle = viewTop + wrap.clientHeight / 2;
    let visibleIndex = 0;
    for (let index = 0; index < tops.length; index += 1) if (tops[index] <= middle) visibleIndex = index;
    setCurrent(visibleIndex + 1);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (let index = first; index <= last; index += 1) {
      const canvas = wrap.querySelector(`[data-page-canvas="${index + 1}"]`);
      if (!canvas) continue;
      // ⚠️ 不能只判断「在 map 里就跳过」：容器宽度变了（首次算出铺满比例、进出全屏、改窗口、缩放）
      //    之后，已经画过的页必须按**新比例**重画，否则页面还是老尺寸、四周留一圈白
      //    —— 用户看到的「全屏还是这么小 / 文档好像也没全屏」就是这个。
      const targetWidth = Math.floor(pages[index].width * scale);
      if (canvasRefs.current.has(index + 1) && canvas.style.width === `${targetWidth}px`) continue;
      try {
        const pdfPage = await pdf.getPage(index + 1);
        if (token !== scrollTokenRef.current) return;
        const viewport = pdfPage.getViewport({ scale });
        // ⚠️ 同一块 canvas 上**绝不允许两个渲染任务并存**：pdf.js 会明确拒绝，
        //    而如果有旧任务还在往这块画布上画，缓冲区就会被写花 ——
        //    表现出来就是全屏之后画面「倒着 / 内容对不上」。所以每次重画前先把旧任务取消并等它结束。
        await cancelRender(index + 1);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvasRefs.current.set(index + 1, canvas);
        setRenderingPage(index + 1);
        const task = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
        renderTasksRef.current.set(index + 1, task);
        try {
          await task.promise;
        } finally {
          if (renderTasksRef.current.get(index + 1) === task) renderTasksRef.current.delete(index + 1);
        }
      } catch (error) {
        if (!/cancel/i.test(String(error?.name || error?.message || ''))) {
          setState((old) => ({ ...old, error: `第 ${index + 1} 页渲染失败：${error?.message || '未知错误'}` }));
        }
      } finally {
        setRenderingPage(0);
      }
    }
  }, [pages, scale, cancelRender, isDocument]);

  useEffect(() => { if (pages.length && scale && isDocument) renderWindow(); }, [pages, scale, fullscreen, renderWindow, isDocument]);

  const scrollToPage = useCallback((pageNumber) => {
    const wrap = wrapRef.current;
    if (!wrap || !pages.length) return;
    let offset = 0;
    for (let index = 0; index < pageNumber - 1; index += 1) offset += pages[index].height * scale + PAGE_GAP;
    wrap.scrollTo({ top: offset, behavior: 'smooth' });
  }, [pages, scale]);

  /* ④-2 放映形态：**一次只画一张**（当前这张），翻页才画下一张。 */
  const goSlide = useCallback((target) => {
    setCurrent((oldValue) => {
      const total = pages.length || 1;
      const next = Math.max(1, Math.min(total, Number(target) || 1));
      return next === oldValue ? oldValue : next;
    });
  }, [pages.length]);

  useEffect(() => {
    const pdf = pdfRef.current;
    const canvas = slideCanvasRef.current;
    if (!isSlides || !pdf || !canvas || !pages.length || !slideScale) return undefined;
    let cancelled = false;
    const stamp = ++slideStampRef.current;
    (async () => {
      try {
        // 先取消上一张还没画完的任务，并等它结束 —— 同一块画布上并存两个任务会被 pdf.js 拒绝
        const running = slideTaskRef.current;
        if (running) { slideTaskRef.current = null; try { running.cancel(); await running.promise; } catch { /* 取消属正常 */ } }
        const pdfPage = await pdf.getPage(current);
        if (cancelled || stamp !== slideStampRef.current) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const viewport = pdfPage.getViewport({ scale: slideScale });
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        setRenderingPage(current);
        const task = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
        slideTaskRef.current = task;
        try {
          await task.promise;
        } finally {
          if (slideTaskRef.current === task) slideTaskRef.current = null;
        }
      } catch (error) {
        if (!/cancel/i.test(String(error?.name || error?.message || ''))) {
          setState((old) => ({ ...old, error: `第 ${current} 张渲染失败：${error?.message || '未知错误'}` }));
        }
      } finally {
        if (!cancelled && stamp === slideStampRef.current) setRenderingPage(0);
      }
    })();
    return () => { cancelled = true; };
  }, [isSlides, current, slideScale, pages.length]);

  /* ④-3 放映形态的缩略图条：**进入视口才画**（几十页的课件不为看不见的缩略图买单），
     且一张一张排队画 —— 一屏 20 张同时开画会把主幻灯片挤到后面。 */
  useEffect(() => {
    if (!isSlides || !pages.length) return undefined;
    const rail = railRef.current;
    const pdf = pdfRef.current;
    if (!rail || !pdf || typeof IntersectionObserver !== 'function') return undefined;
    const paint = (pageNumber) => {
      if (thumbDoneRef.current.has(pageNumber)) return;
      const canvas = thumbCanvasRefs.current.get(pageNumber);
      if (!canvas) return;
      thumbDoneRef.current.add(pageNumber);
      thumbQueueRef.current = thumbQueueRef.current.then(async () => {
        try {
          const pdfPage = await pdf.getPage(pageNumber);
          const base = pdfPage.getViewport({ scale: 1 });
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const viewport = pdfPage.getViewport({ scale: THUMB_WIDTH / base.width });
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise;
        } catch { thumbDoneRef.current.delete(pageNumber); }
      });
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) paint(Number(entry.target.dataset.slideNumber));
    }, { root: rail, rootMargin: '240px' });
    for (const node of rail.querySelectorAll('[data-slide-number]')) observer.observe(node);
    return () => observer.disconnect();
  }, [isSlides, pages.length]);

  /* ⑤ 堵快捷键：Ctrl/Cmd + P（打印）/ S（保存）/ U（查看源码）。capture 阶段抢在默认行为之前。 */
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

  /* ⑥ 键盘翻页（跳页而不是滚动一格，讲课时更利落）；Esc 在全屏时只退全屏。
     放映形态多两个键：空格 = 下一张、F = 切全屏（讲课时的肌肉记忆）。 */
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (document.fullscreenElement) return;   // 交给浏览器退全屏
        onClose?.();
        return;
      }
      if (isSlides && pages.length) {
        const key = String(event.key || '').toLowerCase();
        if (key === 'f') { event.preventDefault(); toggleFullscreen(); return; }
        if (['ArrowRight', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); goSlide(current + 1); return; }
        if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); goSlide(current - 1); return; }
        if (event.key === 'Home') { event.preventDefault(); goSlide(1); return; }
        if (event.key === 'End') { event.preventDefault(); goSlide(pages.length); return; }
        return;
      }
      if (!isDocument || !pages.length) return;
      if (['ArrowRight', 'PageDown'].includes(event.key)) { event.preventDefault(); scrollToPage(Math.min(pages.length, current + 1)); }
      if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); scrollToPage(Math.max(1, current - 1)); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isDocument, isSlides, pages.length, current, scrollToPage, goSlide, onClose]);

  /* ⑦ 缩略图条跟着当前这张走：翻到第 20 张时把它滚进视野（长课件用得上）。 */
  useEffect(() => {
    if (!isSlides) return;
    const rail = railRef.current;
    const active = rail?.querySelector('[data-slide-number].on');
    active?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [isSlides, current]);

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

  const totalPages = pages.length;
  const slideSlotStyle = slidePage && slideScale
    ? { width: `${Math.floor(slidePage.width * slideScale)}px`, height: `${Math.floor(slidePage.height * slideScale)}px` }
    : undefined;

  return <div className="preview-overlay" onClick={() => { if (!document.fullscreenElement) onClose?.(); }}>
    <div className="preview-panel ta-panel" ref={panelRef} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
      <header className="preview-head">
        <div>
          <span className="eyebrow">在线预览（不提供下载）</span>
          <h3>{asset?.title || '教学素材'}</h3>
        </div>
        <div className="row-actions">
          <button type="button" className="secondary-button" onClick={toggleFullscreen}>
            {fullscreen ? '退出全屏' : isSlides ? '全屏放映' : '全屏观看'}
          </button>
          <button type="button" className="drawer-close" onClick={() => { if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); onClose?.(); }} aria-label="关闭预览">×</button>
        </div>
      </header>

      <div className="preview-stage">
        <div className="preview-watermark" aria-hidden="true">内部备课资料 · 请勿外传 · {new Date().toLocaleString('zh-CN')}</div>
        {state.loading ? <p className="ta-state">正在准备预览…</p>
          : state.error && !isPdfBacked ? <div className="ta-state"><Notice tone="warning">{state.error}</Notice></div>
            : kind === 'VIDEO' ? <video src={state.previewUrl} controls controlsList="nodownload noplaybackrate noremoteplayback" disablePictureInPicture />
              : kind === 'AUDIO' ? <audio src={state.previewUrl} controls controlsList="nodownload" />
                : kind === 'IMAGE' ? <img className="ta-image" src={state.previewUrl} alt={asset?.title || '教学素材'} draggable="false" />
                  : kind === 'OTHER' ? <div className="ta-state"><Empty title="这种格式无法在线预览" body="请联系平台把它转成 PDF、图片或视频。" /></div>
                    : isSlides ? <div className="ta-slide-stage" ref={stageBoxRef}>
                      {pages.length ? <>
                        <button type="button" className="ta-slide-nav prev" disabled={current <= 1} onClick={() => goSlide(current - 1)} aria-label="上一张">‹</button>
                        <div className="ta-slide-slot" style={slideSlotStyle}>
                          <canvas className="ta-canvas" ref={slideCanvasRef} />
                        </div>
                        <button type="button" className="ta-slide-nav next" disabled={current >= pages.length} onClick={() => goSlide(current + 1)} aria-label="下一张">›</button>
                      </> : <p className="ta-state">正在读取课件…</p>}
                      {state.error ? <div className="ta-render-error"><Notice tone="warning">{state.error}</Notice></div> : null}
                    </div>
                      : isDocument ? <div className="ta-scroll" ref={wrapRef} onScroll={renderWindow}>
                        {pages.length ? pages.map((page, index) => <div className="ta-page-slot" key={index}
                          data-page-number={index + 1}
                          style={{ width: `${Math.floor(page.width * scale)}px`, height: `${Math.floor(page.height * scale)}px` }}>
                          <canvas data-page-canvas={index + 1} className="ta-canvas" />
                        </div>) : <p className="ta-state">正在读取文档…</p>}
                        {state.error ? <div className="ta-render-error"><Notice tone="warning">{state.error}</Notice></div> : null}
                      </div>
                        : <div className="ta-state"><Empty title="暂无可预览内容" body="这份素材没有可以展示的正文。" /></div>}
      </div>

      {/* 放映形态：缩略图条（点哪张跳哪张）。画布是懒加载的，进视口才画。 */}
      {isSlides && pages.length ? <div className="ta-rail" ref={railRef}>
        {pages.map((page, index) => <button type="button" key={index}
          className={'ta-thumb' + (current === index + 1 ? ' on' : '')}
          data-slide-number={index + 1}
          onClick={() => goSlide(index + 1)}
          aria-label={`第 ${index + 1} 张`}>
          <canvas ref={(node) => { if (node) thumbCanvasRefs.current.set(index + 1, node); else thumbCanvasRefs.current.delete(index + 1); }}
            style={{ width: `${THUMB_WIDTH}px`, height: `${Math.max(1, Math.round((page.height / page.width) * THUMB_WIDTH))}px` }} />
          <span>{index + 1}</span>
        </button>)}
      </div> : null}

      <footer className="ta-toolbar">
        {isSlides ? <>
          <button type="button" className="secondary-button" disabled={current <= 1} onClick={() => goSlide(current - 1)}>‹ 上一张</button>
          <span className="ta-page">第 {current}{totalPages ? ` / 共 ${totalPages}` : ''} 张</span>
          <button type="button" className="secondary-button" disabled={!totalPages || current >= totalPages} onClick={() => goSlide(current + 1)}>下一张 ›</button>
          <span className="ta-zoom">
            <button type="button" className="secondary-button" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.25).toFixed(2))))} aria-label="缩小">−</button>
            <span className="ta-page">{Math.round(zoom * 100)}%</span>
            <button type="button" className="secondary-button" disabled={zoom >= 4} onClick={() => setZoom((value) => Math.min(4, Number((value + 0.25).toFixed(2))))} aria-label="放大">＋</button>
            <button type="button" className="text-button" disabled={zoom === 1} onClick={() => setZoom(1)}>适应窗口</button>
          </span>
          {renderingPage ? <span className="ta-hint muted">正在渲染第 {renderingPage} 张…</span> : null}
        </> : isDocument ? <>
          <button type="button" className="secondary-button" disabled={current <= 1} onClick={() => scrollToPage(Math.max(1, current - 1))}>‹ 上一页</button>
          <span className="ta-page">第 {current}{totalPages ? ` / 共 ${totalPages}` : ''} 页</span>
          <button type="button" className="secondary-button" disabled={Boolean(totalPages) && current >= totalPages} onClick={() => scrollToPage(Math.min(totalPages, current + 1))}>下一页 ›</button>
          <span className="ta-zoom">
            <button type="button" className="secondary-button" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.25).toFixed(2))))} aria-label="缩小">−</button>
            <span className="ta-page">{Math.round(zoom * 100)}%</span>
            <button type="button" className="secondary-button" disabled={zoom >= 4} onClick={() => setZoom((value) => Math.min(4, Number((value + 0.25).toFixed(2))))} aria-label="放大">＋</button>
            <button type="button" className="text-button" disabled={zoom === 1} onClick={() => setZoom(1)}>适应宽度</button>
          </span>
          {renderingPage ? <span className="ta-hint muted">正在渲染第 {renderingPage} 页…</span> : null}
        </> : <span className="ta-page">{kind === 'VIDEO' ? '视频' : kind === 'AUDIO' ? '音频' : kind === 'IMAGE' ? '图片' : '素材'}预览</span>}
        <span className="ta-hint muted">{isSlides
          ? '本课件由平台在服务端转换后逐张放映（原始 PPT 文件不会下发）：← → 或空格翻页，F 切全屏。素材仅可在本页查看，请勿截屏外传。'
          : 'PPT / Word 已由平台转换成 PDF 后展示，原始文件不会下发；素材仅可在本页查看，请勿截屏外传。'}</span>
      </footer>
    </div>
  </div>;
}
