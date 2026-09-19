/**
 * 官网内容（website_contents）的 key 白名单。
 * 只列「官网真的有页面在读」的区块。2026-09-18 起官网新增/接管的三个页面都读 CMS：
 *   HANDBOOK（机构手册）、FAQ（常见问题）——后台可编辑即对官网生效。
 * ⚠️ 2026-09-19：**INTRO（灵动介绍）已整页删除**（用户口径），所以它的 key 也从这个白名单里撤了 ——
 *   页面/导航/页脚/路由/CMS 一起撤；旧内容留底见 docs/operations/灵动介绍-旧内容留底-20260919.md。
 * 2026-09-18 晚追加 MARKETPLACE（灵动课程页头的大标题 / 副标题，用户口径「最好是可以后台配置」）。
 * ORG（机构方案）/ COMPARE（选型对比）仍是静态页，保留 key 但不进管理端列表
 * （避免运营改了却对官网无效）。
 * ⚠️ 加一个 key 要同时动四处，漏一处就是「后台看不到 / 改了对官网无效」：
 *    这里 + apps/admin/src/shared.jsx 的 WEBSITE_CONTENT_LABELS +
 *    packages/database/src/websiteContentDefaults.js 的默认内容 +
 *    apps/admin/src/pages/WebsiteContent.jsx 的结构化表单（不加就只能走 JSON 编辑）。
 *    另外存量库要靠 deploy/production/migrate-website-content-20260918.mjs 补种出这一行
 *    （管理端只列库里已有的行；没有行 = 后台看不到）。
 */
export const WEBSITE_CONTENT_KEYS = new Set(['HOME', 'ORG', 'HANDBOOK', 'COMPARE', 'FAQ', 'BRAND', 'MARKETPLACE']);
