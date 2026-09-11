// 学生代码的运行外壳 + 控制台桥。
//
// 为什么不能直接 srcdoc：主站 CSP 是 script-src 'self'，srcdoc/blob 文档会继承
// 父页 CSP，学生代码里的内联脚本会被直接拦掉。所以把学生页面 postMessage 给
// /vibe-preview.html（nginx 单独给它的宽松 CSP），由它写进内层 sandbox iframe。
// 这条路径依赖服务器上的 `location = /vibe-preview.html`，改路径要同步改 nginx。
import { useEffect, useRef, useState } from 'react';

export const PREVIEW_SHELL_URL = '/vibe-preview.html';

/**
 * 预览 iframe。
 * @param html 完整的 HTML 文档字符串
 * @param onConsole 可选：(line) => void，接收学生页面里的 console 输出
 * @param reloadKey 变化即重新投递（用于「重新运行」）
 */
export function PreviewFrame({ html, className = '', title = '预览', onConsole, reloadKey = 0 }) {
  const frameRef = useRef(null);
  const [ready, setReady] = useState(0);
  const consoleRef = useRef(onConsole);
  consoleRef.current = onConsole;

  useEffect(() => {
    function onMessage(event) {
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

  return (
    <iframe
      ref={frameRef}
      className={className}
      title={title}
      sandbox="allow-scripts"
      src={PREVIEW_SHELL_URL}
    />
  );
}
