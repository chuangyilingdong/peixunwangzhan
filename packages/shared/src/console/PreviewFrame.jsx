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
 * 预览 iframe。
 * @param html 完整的 HTML 文档字符串
 * @param onConsole 可选：(line) => void，接收学生页面里的 console 输出
 * @param reloadKey 变化即重新投递（用于「重新运行」）
 */
export function PreviewFrame({ html, className = '', title = '预览', onConsole, reloadKey = 0, fitToLogical = false }) {
  const frameRef = useRef(null);
  const boxRef = useRef(null);
  const [fit, setFit] = useState(null);
  const [ready, setReady] = useState(0);
  const consoleRef = useRef(onConsole);
  consoleRef.current = onConsole;

  useEffect(() => {
    function onMessage(event) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const payload = event?.data;
      if (!payload || typeof payload !== 'object') return;
      if (payload.source === 'vibecoding-preview-ready') { setReady((value) => value + 1); return; }
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
  useLayoutEffect(() => {
    if (!fitToLogical) return undefined;
    const box = boxRef.current;
    if (!box || typeof ResizeObserver !== 'function') return undefined;
    const measure = () => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (!w || !h) return;
      const scale = Math.min(1, w / PREVIEW_LOGICAL_MIN.w, h / PREVIEW_LOGICAL_MIN.h);
      setFit({ scale, w: w / scale, h: h / scale });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [fitToLogical, html, reloadKey]);

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
  return <div ref={boxRef} className="c-preview__stage">{frame}</div>;
}
