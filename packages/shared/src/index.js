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
// 搜索防抖（自由输入的"查询值"）—— 见该文件头的注释：列表页原来"每敲一个字重取一次"
export * from './useDebounced.js';
export * from './canvasWorkspace.jsx';
// 画布「可提交产出」判定（前端与服务端共用同一套算法，服务端直接 import 这个文件而不是本入口）
export * from './canvasOutput.js';
export { Icon } from './icons.jsx';
export { materialVisual, materialToneClass } from './materialTypes.js';
export * from './markdown.jsx';
export * from './vibecodingProject.js';
export * from './workMedia.jsx';
// 控制台设计系统（含 CSS）。组件会被 tree-shake，但 CSS 是副作用导入会留在包里，
// 所以没用到控制台的那一端会多背约 8.5KB gzip 的样式——换来的是不用谁单独记着引 CSS。
export * from './console/index.js';
