// 成员头像：8 个预设键（2026-09-27，用户口径「头像修改要加上」）。
//
// 为什么是**预设键**而不是上传图片：
//   · `users.avatar_key` 这一列**本来就是这么设计的**（`packages/database/src/schema.js` 里带 CHECK 白名单），
//     只是一直没有任何界面渲染它 —— 全仓唯一的写点还是"注销学生时置 NULL"；
//   · 这是未成年人平台：把学生的**真人照片**传到对外公开的主页上，还要配内容安全与审核，是另一件事
//     （学生上传口目前是 PRIVATE 可见性、还要占上传配额，做成公开头像得再开一条路）；
//   · 预设头像**不需要任何图片资源**：下面的 emoji 直接塞进既有的圆形头像位 ——
//     那个位置本来就渲染"一个字符"（原来是 displayName 的首字），所以零资源、三端（含公开主页）天然一致。
//
// ⚠️ 这份清单必须与 `packages/database/src/schema.js` 里 `users.avatar_key` 的 CHECK 白名单**逐字一致**
//    （守卫 p158 会对着那行 CHECK 断言，别只改一处）。
// ⚠️ 服务端**直接 import 这个文件**（不是走 @platform/shared 入口）—— 与 canvasOutput.js 同款用法。
export const AVATAR_KEYS = Object.freeze(['star', 'rocket', 'cat', 'fox', 'robot', 'panda', 'owl', 'whale']);

const AVATAR_EMOJI = Object.freeze({
  star: '⭐',
  rocket: '🚀',
  cat: '🐱',
  fox: '🦊',
  robot: '🤖',
  panda: '🐼',
  owl: '🦉',
  whale: '🐳',
});

/** 头像键 → 显示用的那个字符。传 null / 未知键时返回 null（调用方自己退回"首字圆形"）。 */
export function avatarGlyph(key) {
  return AVATAR_EMOJI[String(key ?? '')] || null;
}

export function isAvatarKey(key) {
  return AVATAR_KEYS.includes(String(key ?? ''));
}
