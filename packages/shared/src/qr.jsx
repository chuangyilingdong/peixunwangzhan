// 二维码组件（渲染成 SVG，零依赖、零外站素材）。
//
// 用法：`<QrCode value="https://aicyld.com/" size={168} />`
// 生成逻辑全在 `qr.js`（自带自查 `qrSelfCheck`），这里只管画：
//   · 一个 `<path>` 画所有黑点（比几十个 `<rect>` 轻），`shape-rendering: crispEdges` 保证放大不糊；
//   · 白底自带（二维码规范要求四周留白，外面的容器再留一圈 padding）；
//   · `role="img"` + `aria-label`：屏幕阅读器读一句人话，而不是一串路径。
import { useMemo } from 'react';
import { qrMatrix } from './qr.js';

export function QrCode({ value, size = 160, ec = 'M', className = '', label = '' }) {
  const text = String(value || '');
  const { modules, size: count } = useMemo(() => qrMatrix(text, { ec }), [text, ec]);
  const path = useMemo(() => {
    let d = '';
    for (let y = 0; y < count; y += 1) {
      for (let x = 0; x < count; x += 1) if (modules[y][x]) d += `M${x} ${y}h1v1h-1z`;
    }
    return d;
  }, [modules, count]);
  return <svg className={className} viewBox={`0 0 ${count} ${count}`} width={size} height={size}
    role="img" aria-label={label || `二维码：${text}`} shapeRendering="crispEdges">
    <rect width={count} height={count} fill="#fff" />
    <path d={path} fill="#171326" />
  </svg>;
}
