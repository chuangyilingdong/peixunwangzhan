// 学生代码的运行外壳 + 控制台桥。
//
// 为什么不能直接 srcdoc：主站 CSP 是 script-src 'self'，srcdoc/blob 文档会继承
// 父页 CSP，学生代码里的内联脚本会被直接拦掉。所以把学生页面 postMessage 给
// /vibe-preview.html（nginx 单独给它的宽松 CSP），由它写进内层 sandbox iframe。
// 这条路径依赖服务器上的 `location = /vibe-preview.html`，改路径要同步改 nginx。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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
 * 预览 iframe。
 * @param html 完整的 HTML 文档字符串
 * @param onConsole 可选：(line) => void，接收学生页面里的 console 输出
 * @param reloadKey 变化即重新投递（用于「重新运行」）
 * @param growToContent 可选：**按"这份文档有多高"把框长到那么高**（见下）
 */
export function PreviewFrame({ html, className = '', stageClassName = '', title = '预览', onConsole, reloadKey = 0, fitToLogical = false, growToContent = false }) {
  const frameRef = useRef(null);
  const boxRef = useRef(null);
  const [fit, setFit] = useState(null);
  const [ready, setReady] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const consoleRef = useRef(onConsole);
  consoleRef.current = onConsole;

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
  // ⭐ `growToContent`（2026-09-27 用户口径）：「这里的展示应该是**大的作品预览**」+
  //    「点下一页 2/12 这里出现（滚动条）」—— 学生的 PPT 式网页比写死的 768 高，内层就自己滚起来。
  //    开了它就**只按宽度**定缩放，高度按内层报上来的内容高度（至少 768、至多 PREVIEW_MAX_HEIGHT）：
  //    内层永远不会出现滚动条，多出来的高度交给**外层页面**滚 —— 这才是"大预览"。
  useLayoutEffect(() => {
    if (!fitToLogical) return undefined;
    const box = boxRef.current;
    if (!box || typeof ResizeObserver !== 'function') return undefined;
    const measure = () => {
      const w = box.clientWidth;
      if (!w) return;
      const next = growToContent
        ? (() => {
          const scale = Math.min(1, w / PREVIEW_LOGICAL_MIN.w);
          const height = Math.min(PREVIEW_MAX_HEIGHT, Math.max(PREVIEW_LOGICAL_MIN.h, contentHeight || 0));
          return { scale, w: w / scale, h: height };
        })()
        : (() => {
          const h = box.clientHeight;
          if (!h) return null;
          const scale = Math.min(1, w / PREVIEW_LOGICAL_MIN.w, h / PREVIEW_LOGICAL_MIN.h);
          return { scale, w: w / scale, h: h / scale };
        })();
      // 值没变就别 setState：grow 模式下"设框高 → ResizeObserver 又触发"很容易来回抖
      if (!next) return;
      setFit((current) => (current && current.scale === next.scale && current.w === next.w && current.h === next.h ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [fitToLogical, growToContent, contentHeight, html, reloadKey]);

  const frame = (
    <iframe
      ref={frameRef}
      className={className}
      title={title}
      sandbox="allow-scripts"
      src={PREVIEW_SHELL_URL}
      style={fit ? { width: `${fit.w}px`, height: `${fit.h}px`, transform: `scale(${fit.scale})`, transformOrigin: 'top left' } : undefined}
    />
  );
  // 不开适配时保持**原样结构**（工作台的编辑预览与手机模拟器自己有 stage，别动它们）
  if (!fitToLogical) return frame;
  // grow 模式：舞台高度得**显式**写成缩放后的高度 —— 里面的 iframe 是绝对定位（不贡献高度），
  // 而 CSS 的 `transform: scale()` 又不影响布局盒，不写就会留一大截空白。
  const stageStyle = fit && growToContent ? { height: `${Math.round(fit.h * fit.scale)}px` } : undefined;
  return <div ref={boxRef} className={`c-preview__stage ${stageClassName}`.trim()} style={stageStyle}>{frame}</div>;
}
