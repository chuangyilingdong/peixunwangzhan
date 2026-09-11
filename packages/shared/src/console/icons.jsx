// 控制台图标集：与 icons.jsx 的 Icon 同款画法（内联 SVG、stroke 跟随 currentColor、
// 24 视口、线性风格），但路径更全。单独一份是为了不动画布在用的那 16 个图标。
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M6 12h12',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.2 16.2L21 21',
  pin: 'M12 17v5M9 3h6l-1 8 3 3H7l3-3z',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  chevronLeft: 'M15 5l-7 7 7 7',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'M5 13l4 4L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  stop: 'M7 7h10v10H7z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  folder: 'M4 6h5l2 2h9v10H4z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  image: 'M4 5h16v14H4zM8.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5 17l5-5 4 4 2-2 3 3',
  code: 'M9 8l-4 4 4 4M15 8l4 4-4 4',
  terminal: 'M5 7l4 4-4 4M13 15h6',
  eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  play: 'M7 5l12 7-12 7z',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 10l5-5 5 5M5 20h14',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  panelLeft: 'M4 5h16v14H4zM10 5v14',
  trash: 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13',
  edit: 'M4 20h4l10-10-4-4L4 16zM14 6l4 4',
  clock: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 8v4.2l3 1.8',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  sparkle: 'M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z',
  wand: 'M5 19l9-9M15 5l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.7 1.3 1.3.7-1.3.7-.7 1.3-.7-1.3-1.3-.7 1.3-.7z',
  messageSquare: 'M4 5h16v11H9l-5 4z',
  bookOpen: 'M12 6.5C10.5 5.2 8.4 4.6 4 4.6V18c4.4 0 6.5.6 8 1.9 1.5-1.3 3.6-1.9 8-1.9V4.6c-4.4 0-6.5.6-8 1.9zM12 6.5v13.4',
  logOut: 'M15 5H5v14h10M18 12H9M15 9l3 3-3 3',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20c0-3.3 3.6-5 8-5s8 1.7 8 5',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  loader: 'M12 3v4M12 17v4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M3 12h4M17 12h4M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  brackets: 'M9 4H6v16h3M15 4h3v16h-3',
  info: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 11v5M12 8h.01',
  shield: 'M12 3l7 3v6c0 4-3 7.4-7 9-4-1.6-7-5-7-9V6z',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
};

export function ConsoleIcon({ name, size = 16, strokeWidth = 1.7, className }) {
  const path = PATHS[name];
  if (!path) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

export const ICON_NAMES = Object.keys(PATHS);
