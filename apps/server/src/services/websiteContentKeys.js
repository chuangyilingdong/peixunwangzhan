/**
 * 官网内容（website_contents）的 key 白名单。
 * 只列「官网真的有页面在读」的区块；ORG / HANDBOOK / COMPARE 目前仍是静态页，
 * 因此保留 key 但不进管理端列表（避免运营改了却对官网无效）。
 */
export const WEBSITE_CONTENT_KEYS = new Set(['HOME', 'ORG', 'HANDBOOK', 'COMPARE', 'FAQ', 'BRAND']);
