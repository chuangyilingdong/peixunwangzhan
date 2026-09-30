export * from './SearchSelect.jsx';
export * from './api.js';
export * from './auth.js';
export * from './ui.jsx';
export * from './account.jsx';
export * from './siteDefaults.js';
export * from './notice.js';
export * from './worksState.js';
export * from './worksState.jsx';
// 头像的 8 个预设键 + 显示字符（2026-09-27）。服务端直接 import 那个文件去校验白名单，前端用这里这份渲染。
export * from './avatars.js';
export * from './classroom.jsx';
// 客户端深链常量（`lingdong://…`）—— 机构端「VibeCoding备课」按钮也发同一条（别各写一份字面量）
export * from './clientEntry.jsx';
// 三端入口的**渲染兜底**（2026-09-29）：渲染期抛错时换成兜底页，不再整页白 —— 见该文件头的三条边界。
export * from './errorBoundary.jsx';
// 搜索防抖（自由输入的"查询值"）—— 见该文件头的注释：列表页原来"每敲一个字重取一次"
export * from './useDebounced.js';
export * from './canvasWorkspace.jsx';
// 画布「可提交产出」判定（前端与服务端共用同一套算法，服务端直接 import 这个文件而不是本入口）
export * from './canvasOutput.js';
// 「框体 → 画布节点」的唯一一份实现（学生画布与机构端备课画布共用；2026-09-30 抽出来）
export * from './canvasBoxNode.js';
export { Icon } from './icons.jsx';
export { materialVisual, materialToneClass } from './materialTypes.js';
export * from './markdown.jsx';
export * from './vibecodingProject.js';
export * from './workMedia.jsx';
// 作品分享面板（二维码 + 选哪一件）：学生端与机构/老师端**同一套 UI**（2026-09-30）
export { WorkSharePanel, qrSvgText, shareablePiecesOf } from './workShare.jsx';
// 控制台设计系统（含 CSS）。组件会被 tree-shake，但 CSS 是副作用导入会留在包里，
// 所以没用到控制台的那一端会多背约 8.5KB gzip 的样式——换来的是不用谁单独记着引 CSS。
export * from './console/index.js';
