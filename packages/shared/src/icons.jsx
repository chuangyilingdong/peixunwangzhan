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
};

export function Icon({ name, size = 16, strokeWidth = 1.7, className }) {
  const path = PATHS[name];
  if (!path) return null;
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
