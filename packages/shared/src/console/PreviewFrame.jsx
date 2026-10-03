// 学生代码的运行外壳 + 控制台桥。
//
// 为什么不能直接 srcdoc：主站 CSP 是 script-src 'self'，srcdoc/blob 文档会继承
// 父页 CSP，学生代码里的内联脚本会被直接拦掉。所以把学生页面 postMessage 给
// /vibe-preview.html（nginx 单独给它的宽松 CSP），由它写进内层 sandbox iframe。
// 这条路径依赖服务器上的 `location = /vibe-preview.html`，改路径要同步改 nginx。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export const PREVIEW_SHELL_URL = '/vibe-preview.html';

/**
 * 查看层里学生页的**逻辑视口下界**（口径㉕：与广场的 `PL_FRAME_MIN` 同一套数）。
 *
 * 为什么是"视口下界"而不是"框体高度"：内层页面按**不小于这个尺寸**的逻辑视口渲染，
 * 再整体等比缩放到可用空间 —— 这样无论面板多窄多矮，学生页都是**完整可见、内层没有滚动条**。
 * 实测学生作品里"最高"的那类（打地鼠/贪吃蛇都要 ~600px）在这个高度里装得下。
 * ⚠️ 别退回用 CSS 把 iframe 写死成某个 `vh` 或 `100%`：那样"内层视口"就等于框体，
 *    比 768 矮的时候就又滚起来了 —— 用户报的「作品预览里出现滚动条」正是这么来的。
 */
export const PREVIEW_LOGICAL_MIN = { w: 640, h: 768 };

/**
 * 「跟着内容长」时的**高度上限**（2026-09-27）。
 * 为什么需要：上报告内容高度的页面里，有一类会"内容随视口一起长"（例如写死 `100vh + 200px`）——
 * 那样框每长高一点、内容又更高一点，会一直涨。所以设个上限，到顶就不再长（内层最多回到可滚动，
 * 退化成老行为，不会把页面撑爆）。
 */
export const PREVIEW_MAX_HEIGHT = 4000;

/**
 * ⭐ `responsive` 模式的高度下界（2026-09-30 用户口径）。
 *
 * 用户原话：「图1 不管是电脑端还是手机端，**有办法自适应吗**？像图2 这种界面，怎么玩？那么小的界面。
 * 为什么非要用作品预览把作品框上呢？**不需要这些东西**。」
 *
 * 图2 就是老口径的产物：学生页按 640×768 的逻辑视口渲染、再整体缩放到面板里 —— 面板越宽越扁，
 * 缩放比越小（实测 0.52），字小到点不着。现在这一档改成**不缩放**：iframe 宽度＝容器真实宽度
 * （学生页自己的媒体查询因此真正生效 → 电脑端/手机端各自的样子），高度＝内层自报的内容高度
 * （`PREVIEW_HEIGHT_BRIDGE`），下界用下面这个值、上界仍是 PREVIEW_MAX_HEIGHT。
 *
 * 下界为什么给 600：① 学生游戏类作品大量用 `100vh`，视口太矮就没法玩；② 页面自报的高度对
 * `100vh` 型页面等于当前框高，有下界才不会塌成一条。
 */
export const PREVIEW_RESPONSIVE_MIN_H = 600;

/**
 * 预览 iframe。
 * @param html 完整的 HTML 文档字符串
 * @param onConsole 可选：(line) => void，接收学生页面里的 console 输出
 * @param reloadKey 变化即重新投递（用于「重新运行」）
 * @param fitContent 可选：**按"这份文档有多高"来缩放**（见下）
 * @param responsive 可选：**不缩放、按容器宽度自适应**（见 PREVIEW_RESPONSIVE_MIN_H 的注释）
 */
let pdfjsPromise = null;
/** 懒惰加载 pdf.js（**legacy 构建** —— 老浏览器缺 `Iterator` 的那个坑见 TeachingAssetViewer 的注释）。 */
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
  }
  return pdfjsPromise;
}

const OSS_HOST = /(^|\.)oss-[a-z0-9-]+\.aliyuncs\.com$/i;
/**
 * **取字节的地址白名单**（PDF 桥与素材 fetch 桥共用）：只允许
 * ① data:application/pdf（字节本来就在学生页里，只有 PDF 那条用得上）；
 * ② 本站根路径 `/…`（作品素材的公开代理口）；③ 本站同源地址；④ 我们的 OSS 桶（签名直链）。
 * 其余一律拒绝 —— 学生代码不能借平台的 fetch 去打内网或第三方。
 */
function safeAssetUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^data:application\/pdf/i.test(value)) return value;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin === window.location.origin) return parsed.href;
    if (OSS_HOST.test(parsed.hostname)) return parsed.href;
  } catch { /* 解析不了就是不合法 */ }
  return '';
}

/** 素材 fetch 桥的单次上限（解出字节后算）：8MB 的 pptx 完全够用，别让一次预览吃掉几百 MB 内存。 */
const ASSET_MAX_BYTES = 32 * 1024 * 1024;
/** ArrayBuffer → base64（分块拼，几十 MB 也不会把调用栈撑爆）。 */
function bytesToBase64(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

/**
 * 把学生页里的 blob PDF 渲染成图片（PDF 桥的服务端……其实是我们这一层）。
 * 规格：最多 `pages` 页、按宽度 1000px 渲染、逐页 dataURL —— 学生文档那边直接 `<img>` 铺开。
 * 返回值带 `totalPages`：学生侧要在"只渲染了前 N 页"时说一句（2026-10-03）。
 */
async function renderPdfImages(base64, pageLimit) {
  const pdfjs = await loadPdfjs();
  const bytes = Uint8Array.from(atob(String(base64 || '')), (character) => character.charCodeAt(0));
  const document_ = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const total = Math.min(Number(pageLimit) || 12, document_.numPages);
  const images = [];
  for (let number = 1; number <= total; number += 1) {
    const page = await document_.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, Math.max(0.6, 1000 / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    images.push(canvas.toDataURL('image/png'));
    page.cleanup();
  }
  return { images, totalPages: document_.numPages };
}

export function PreviewFrame({ html, className = '', stageClassName = '', title = '预览', onConsole, reloadKey = 0, fitToLogical = false, fitContent = false, responsive = false, fill = false }) {
  const frameRef = useRef(null);
  const boxRef = useRef(null);
  const [fit, setFit] = useState(null);
  const [ready, setReady] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const consoleRef = useRef(onConsole);
  consoleRef.current = onConsole;

  // PDF 桥的应答路径：渲染好 → 发回**外壳**（它会转进学生文档的 stage 里）
  const renderPdfBridge = useCallback(async (payload) => {
    const frame = frameRef.current;
    const id = String(payload?.id || '');
    if (!frame?.contentWindow || !id) return;
    const reply = (body) => { try { frame.contentWindow.postMessage({ source: 'vibecoding-pdf-rendered', id, ...body }, '*'); } catch { /* 外壳没了就算了 */ } };
    try {
      // ⭐ 2026-10-03：两种来源 —— 学生页直接给了字节（base64），或者给了一个**PDF 地址**
      //    （学生页写 `iframe.src = "…/x.pdf"` 那种）。地址这条必须**白名单**：
      //    学生代码递上来的 url 绝不能变成"让平台去请求任意地址"的口子。
      let base64 = String(payload.base64 || '');
      if (!base64 && payload.url) {
        const target = safeAssetUrl(String(payload.url));
        if (!target) { reply({ error: '这个 PDF 地址不在允许的范围内' }); return; }
        const response = await fetch(target, { credentials: 'include' });
        if (!response.ok) { reply({ error: `取 PDF 失败（HTTP ${response.status}）` }); return; }
        const bytes = new Uint8Array(await response.arrayBuffer());
        base64 = bytesToBase64(bytes);
      }
      const rendered = await renderPdfImages(base64, payload.pages);
      if (!rendered.images.length) { reply({ error: '这份 PDF 没有可显示的页面' }); return; }
      reply({ images: rendered.images, total: rendered.totalPages });
    } catch (error) {
      reply({ error: String(error?.message || error).slice(0, 120) });
    }
  }, []);

  /**
   * ⭐ 素材 fetch 桥的应答路径（2026-10-03，见 vibecodingProject.js 的 ASSET_FETCH_BRIDGE）。
   * 学生页里 `fetch(src)` 取 docx/pptx 这类**文档字节**时，沙箱里两道墙：既禁网（connect-src blob:），
   * 又过不了 CORS（opaque origin ⇒ `Origin: null`，我们的 OSS 不给它 ACAO —— 生产实测原话见那处注释）。
   * 所以由我们这一层代取（同源、带 cookie、OSS 对我们放行），把字节回贴成 base64；
   * 学生页那边用 `new Response(bytes)` 还原成一个正常的 fetch 响应 —— 页面代码一行都不用改。
   * 白名单与 PDF 桥同一份（safeAssetUrl），学生页不能拿它当跳板。
   */
  const fetchAssetBridge = useCallback(async (payload) => {
    const frame = frameRef.current;
    const id = String(payload?.id || '');
    if (!frame?.contentWindow || !id) return;
    const reply = (body) => { try { frame.contentWindow.postMessage({ source: 'vibecoding-asset-fetched', id, ...body }, '*'); } catch { /* 外壳没了就算了 */ } };
    try {
      const target = safeAssetUrl(String(payload.url));
      if (!target) { reply({ error: '这个地址不在允许的范围内' }); return; }
      const response = await fetch(target, { credentials: 'include' });
      if (!response.ok) { reply({ error: `HTTP ${response.status}` }); return; }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) { reply({ error: '文件是空的' }); return; }
      if (bytes.length > ASSET_MAX_BYTES) { reply({ error: `文件太大（${Math.round(bytes.length / 1048576)}MB）` }); return; }
      reply({ base64: bytesToBase64(bytes), contentType: response.headers.get('content-type') || '' });
    } catch (error) {
      reply({ error: String(error?.message || error).slice(0, 120) });
    }
  }, []);

  useEffect(() => {
    function onMessage(event) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const payload = event?.data;
      if (!payload || typeof payload !== 'object') return;
      if (payload.source === 'vibecoding-preview-ready') { setReady((value) => value + 1); return; }
      // ⭐ 内层自报的高度（见 vibecodingProject.js 的 PREVIEW_HEIGHT_BRIDGE；外壳原样转发，
      //   所以 event.source 仍是外壳窗口，与上面那条判断一致）
      if (payload.source === 'vibecoding-preview-height') {
        const height = Number(payload.height);
        if (Number.isFinite(height) && height > 0) setContentHeight(height);
        return;
      }
      if (payload.source === 'vibecoding-console') {
        consoleRef.current?.({
          level: payload.level || 'log',
          text: String(payload.text ?? ''),
          source: '浏览器',
        });
      }
      // ⭐ PDF 桥（2026-10-02，见 vibecodingProject.js 的 PDF_BRIDGE）：学生页里
      //    `iframe.src = createObjectURL(pdfBlob)` 在沙箱里 Chrome 不启用 PDF 查看器，
      //    由**我们这一层**（不在沙箱里、自带 pdf.js）渲染成图片再送回去。
      if (payload.source === 'vibecoding-pdf-render') void renderPdfBridge(payload);
      // ⭐ 素材 fetch 桥（2026-10-03）：学生页 fetch 文档字节（docx/pptx 那种页面自己解析的）——
      //    沙箱里禁网 + CORS（Origin: null）两道墙，只能由我们代取，见 fetchAssetBridge 的注释。
      if (payload.source === 'vibecoding-asset-fetch') void fetchAssetBridge(payload);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage({ source: 'vibecoding-preview', html: String(html || '') }, '*');
  }, [html, ready, reloadKey]);

  // 量可用空间 → 算出「至少 PREVIEW_LOGICAL_MIN」的逻辑视口 → 整体缩放（口径㉕）。
  // 量不到（老浏览器 / DOM 桩里没有 ResizeObserver）就不设样式，退回原来的"铺满框体"。
  //
  // ⭐ `fitContent`（2026-09-27 用户口径「做成图2这样……大大方方的。自适应。」）：
  //    **逻辑视口高度改用"内层自报的真实内容高度"**，缩放仍然**同时受宽度和高度约束** ——
  //    于是整份作品都装得进这个框（内层不会出现滚动条），而框本身**不长大**（页面不会变成几千像素、
  //    把下面的按钮顶出首屏）。
  //
  //    ⚠️ 这里踩过一次：第一版做成"框跟着内容长"，结果一个 1400px 高的作品把页面撑到 1400px，
  //    底下的按钮全在首屏之外（用户报「下方的按钮都看不到了」）。**"整幅装下"和"框长大"是两回事**，
  //    要的是前者。
  useLayoutEffect(() => {
    if (!fitToLogical) return undefined;
    const box = boxRef.current;
    if (!box || typeof ResizeObserver !== 'function') return undefined;
    const measure = () => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (!w || !h) return;
      // fitContent：高度按内层自报的内容高度（至少 768、至多 PREVIEW_MAX_HEIGHT ——
      // 上限是给"内容随视口一起长"的那类页面兜底的）；其余情况沿用老口径（高度就取框高）。
      const logicalH = fitContent ? Math.min(PREVIEW_MAX_HEIGHT, Math.max(PREVIEW_LOGICAL_MIN.h, contentHeight || 0)) : h;
      const scale = Math.min(1, w / PREVIEW_LOGICAL_MIN.w, h / logicalH);
      const next = { scale, w: w / scale, h: logicalH, boxW: w, boxH: h };
      // 值没变就别 setState：ResizeObserver 触发很密
      setFit((current) => (current && current.scale === next.scale && current.w === next.w && current.h === next.h
        && current.boxW === next.boxW && current.boxH === next.boxH ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [fitToLogical, fitContent, contentHeight, html, reloadKey]);

  // ⚠️ fitContent 下框要**居中**，但**不能让框参与舞台的布局**：
  //    第一版把 iframe 改成 `position:static` + grid 居中，结果框的宽度反过来把舞台撑大 →
  //    ResizeObserver 又量到更大的宽 → 逻辑视口算出 64868900px（正反馈，实测踩到）。
  //    现在框仍是绝对定位（CSS 里那条），居中靠 transform 的 translate 自己算 —— 不参与布局就没有反馈。
  // responsive 模式：不缩放、跟随容器宽度，高度用内层自报的内容高度（有下界、有上限）。
  const responsiveHeight = Math.max(PREVIEW_RESPONSIVE_MIN_H, Math.min(PREVIEW_MAX_HEIGHT, contentHeight || 0));
  // fill 模式（2026-10-02 用户口径「作品预览为什么不能自适应，交互一下还需要滚轮条么」）：
  // **铺满给定容器**（容器自己要有确定高度，弹窗里是 flex:1 那一格）、原生比例不缩放、
  // 滚动条在 iframe 内部 —— 像一扇小浏览器窗口。弹窗预览用它：外层弹窗不再滚，
  // 页眉（含分享按钮）与页脚常驻可见。
  const frameStyle = fill
    ? { width: '100%', height: '100%' }
    : (responsive
      ? { width: '100%', height: `${responsiveHeight}px` }
      : (!fit ? undefined : (fitContent
        ? {
          width: `${fit.w}px`,
          height: `${fit.h}px`,
          transform: `translate(${Math.round((fit.boxW - fit.w * fit.scale) / 2)}px, ${Math.round((fit.boxH - fit.h * fit.scale) / 2)}px) scale(${fit.scale})`,
          transformOrigin: 'top left',
        }
        : { width: `${fit.w}px`, height: `${fit.h}px`, transform: `scale(${fit.scale})`, transformOrigin: 'top left' })));

  const frame = (
    <iframe
      ref={frameRef}
      className={className}
      title={title}
      sandbox="allow-scripts"
      src={PREVIEW_SHELL_URL}
      style={frameStyle}
    />
  );
  // fill 走**铺满容器**：舞台高度由布局给（flex:1），iframe 绝对定位铺满、内部滚动。
  if (fill) return <div ref={boxRef} className={`c-preview__stage c-preview__stage--fill ${stageClassName}`.trim()}>{frame}</div>;
  // responsive 走**流动容器**（高度跟着内容长、没有固定舞台高度）—— 见 .c-preview__stage--flow
  if (responsive) return <div ref={boxRef} className={`c-preview__stage c-preview__stage--flow ${stageClassName}`.trim()}>{frame}</div>;
  // 不开适配时保持**原样结构**（工作台的编辑预览与手机模拟器自己有 stage，别动它们）
  if (!fitToLogical) return frame;
  return <div ref={boxRef} className={`c-preview__stage ${stageClassName}`.trim()}>{frame}</div>;
}
