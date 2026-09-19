// 画布工作台的线性图标（内联 SVG，不引第三方依赖；stroke 用 currentColor，跟随主题色）
const PATHS = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  sliders: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4M14 4v4M6 10v4M12 16v4',
  history: 'M4 12a8 8 0 1 0 3-6.2M4 5v4h4M12 8v4l3 2',
  sidebar: 'M4 5h16v14H4zM10 5v14',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 13l4 4L19 7',
  dash: 'M6 12h12',
  undo: 'M9 7L4 12l5 5M4 12h9a6 6 0 0 1 6 6',
  redo: 'M15 7l5 5-5 5M20 12h-9a6 6 0 0 0-6 6',
  fit: 'M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 18h16',
  plus: 'M12 5v14M5 12h14',
  locate: 'M12 4v3M12 17v3M4 12h3M17 12h3M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  // 素材类型图标（学生端左侧列表 + 老师端课包配置共用，见 materialVisual）
  image: 'M4 5h16v14H4zM8.5 9a1.5 1.5 0 1 1 3 0 1.5 1.5 0 1 1-3 0M4 16l5-4 4 3 3-2 4 3',
  video: 'M4 6h12v12H4zM16 10.5l4-2.5v8l-4-2.5z',
  music: 'M10 17V7l9-2v10M7 17a3 3 0 1 1-6 0 3 3 0 1 1 6 0M19 15a3 3 0 1 1-6 0 3 3 0 1 1 6 0',
  text: 'M5 7h14M5 12h10M5 17h7',
  spark: 'M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z',
  // 作品广场用（2026-09-19）：分类与作品类型。用户口径「网站需要用到的 icon 材质的，
  // 直接从这里取，我们的 AI 味太重了」——所以广场里**不再用 emoji**，一律用这套线性图标。
  brush: 'M9.5 14.5L4 20M14 4l6 6-8.5 8.5a3 3 0 0 1-4.2 0 3 3 0 0 1 0-4.2zM13 6.5l4.5 4.5',
  palette: 'M12 3a9 9 0 0 0 0 18c1.2 0 2-.9 2-2 0-.6-.2-1-.6-1.4-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H16a5 5 0 0 0 5-5c0-3.6-4-6.5-9-6.5zM7.5 10.5h.01M10 7.5h.01M14 7.5h.01M6.5 14.5h.01',
  code: 'M9 8l-4 4 4 4M15 8l4 4-4 4',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3M9 21h6',
  monitor: 'M4 4h16v12H4zM8 20h8M12 16v4',
  gamepad: 'M7 12h4M9 10v4M15.5 12h.01M17.5 10.5h.01M6 6h12a4 4 0 0 1 4 4v4a4 4 0 0 1-7 2.6L14 16h-4l-1 0.6A4 4 0 0 1 2 14v-4a4 4 0 0 1 4-4z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18',
  cpu: 'M6 6h12v12H6zM9.5 9.5h5v5h-5zM10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3',
  flow: 'M6 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM18 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 8v8M8 12h8',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM19 19H6M8 7h7M8 11h7',

};

export function Icon({ name, size = 16, strokeWidth = 1.7, className }) {
  const path = PATHS[name];
  if (!path) return null;
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
