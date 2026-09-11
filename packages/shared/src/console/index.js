// 控制台设计系统入口。
// CSS 在这里按层导入：令牌 → 原语 → 外壳 → 对话 → 工作台（顺序即层叠顺序）。
// 所有样式都作用在 [data-console] 下，不会影响官网/后台的浅色页面。
import './tokens.css';
import './kit.css';
import './shell.css';
import './chat.css';
import './workbench.css';
import './pages.css';

export * from './icons.jsx';
// 逐个具名导出而不是 `export *`：浅色 UI 套件已经有一个 Empty，两个 `export *`
// 撞名会让这个名字在共享桶里直接不可用。控制台这一侧对外叫 ConsoleEmpty。
export {
  Button, IconButton, Pill, Dot, Spinner, Kbd, useCopy, CopyButton,
  ToastProvider, useToast, PopoverMenu, ConfirmDialog,
} from './primitives.jsx';
export { Empty as ConsoleEmpty } from './primitives.jsx';
export * from './format.js';
export * from './attachments.js';
export * from './PreviewFrame.jsx';
export * from './ConsoleShell.jsx';
export * from './ChatThread.jsx';
export * from './Composer.jsx';
export * from './Workbench.jsx';
export * from './Replay.jsx';
export * from './useFollowScroll.js';
