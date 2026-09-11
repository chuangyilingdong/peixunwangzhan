// 文档产物的主题色板（站内预览用）。
//
// ⚠️ 必须与服务端 `apps/server/src/services/ooxml/pptx.js` 的 THEMES **逐字段一致**：
// PPT 的预览与文件是两套实现（浏览器画 HTML / 服务端生成 OOXML），色板是唯一需要手工同步的东西。
// 一旦漂移，学生看到的是「预览是蓝的、下载出来是橙的」，而且谁都不报错 ——
// `scripts/p50-theme-parity.mjs` 把两边拉平，改这里必须同时改那边。
//
// 单独放一个 .js（而不是塞在 DocumentPreview.jsx 里）是为了守卫能直接 import 它。
export const THEMES = {
  ink:    { label: '墨黑橙', bg: 'FFFFFF', ink: '1F2A44', body: '5A6785', accent: 'FF6B2C', soft: 'F3F5FA', cover: '12203F' },
  ocean:  { label: '海洋蓝', bg: 'FFFFFF', ink: '0F2B46', body: '4A6076', accent: '1B7FD4', soft: 'E8F1FA', cover: '0C2338' },
  sunset: { label: '落日橙', bg: 'FFFFFF', ink: '3A1D18', body: '6B4A3E', accent: 'E4572E', soft: 'FDEDE7', cover: '33150F' },
  forest: { label: '森林绿', bg: 'FFFFFF', ink: '12321F', body: '42604C', accent: '2E9E5B', soft: 'E9F6ED', cover: '0E2A1A' },
  candy:  { label: '糖果紫', bg: 'FFFFFF', ink: '3C1E3F', body: '6B4A6E', accent: 'D6489B', soft: 'FCEBF6', cover: '2E1430' },
};

export const DEFAULT_THEME = 'ink';

/** 取主题；名字不认识就回默认（宁可配色不对，也不能让预览出错） */
export function themeOf(name) {
  return THEMES[String(name || '').trim().toLowerCase()] || THEMES[DEFAULT_THEME];
}

/** 色值统一带 # 前缀，方便直接塞进 style */
export function themeHex(value) {
  return `#${value}`;
}
