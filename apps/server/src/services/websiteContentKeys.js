/**
 * 官网内容（website_contents）的 key 白名单。
 * 只列「官网真的有页面在读」的区块。2026-09-18 起官网新增/接管的三个页面都读 CMS：
 *   INTRO（灵动介绍，新增）、HANDBOOK（机构手册）、FAQ（常见问题）——后台可编辑即对官网生效。
 * ORG（机构方案）/ COMPARE（选型对比）仍是静态页，保留 key 但不进管理端列表
 * （避免运营改了却对官网无效）。
 */
export const WEBSITE_CONTENT_KEYS = new Set(['HOME', 'INTRO', 'ORG', 'HANDBOOK', 'COMPARE', 'FAQ', 'BRAND']);
