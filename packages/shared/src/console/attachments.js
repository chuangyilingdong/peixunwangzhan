// VibeCoding 聊天附件：类型、上限、以及「这条附件能不能给模型看」的判定，集中在这里一份。
//
// ⚠️ 真正的把关在服务端：`apps/server/src/services/fileUploadSecurity.js` 的 MIME_EXTENSIONS /
// BLOCKED_EXTENSIONS 才是权威（扩展名、魔术字节、大小、频次都在那边验）。
// 这份 ACCEPT 只是给文件选择器的**提示**，让学生在选文件时就看到哪些能传；写宽了服务端会拒、
// 写窄了学生选不到，所以 `scripts/p44-attachment-accept-parity.mjs` 拿两边对了一遍，防止漂移。
export const ATTACHMENT_ACCEPT = [
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.mp4', '.webm',
  '.mp3', '.wav', '.ogg',
  '.pdf', '.txt', '.csv', '.zip', '.pptx', '.docx', '.xlsx',
].join(',');

// 一次最多几个附件（与服务端 MAX_ATTACHMENTS 对齐）
export const MAX_ATTACHMENTS = 4;
// 单张图片的上传上限（学生端与学生约定过的闸）
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// 非图片附件的上限：跟随平台上传上限；服务端更严时会用它自己的报错文案拦下
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// 能"内联给模型看"的上限：再大的图 base64 之后太大，只能放在页面里、AI 看不到。
// 非图片附件没有内联一说（上游只收 image_url），一律走"告诉模型看不到"那条路。
export const MAX_INLINE_BYTES = 1024 * 1024;

/** 是不是图片附件：看 MIME，不看扩展名（老数据没有 mime 时退回按 url/inline 猜） */
export function isImageAttachment(item) {
  const mime = String(item?.mime || '').toLowerCase();
  if (mime) return mime.startsWith('image/');
  return Boolean(String(item?.inline || '').startsWith('data:image/'));
}

/** 给这类附件兜底的文件名（老数据可能没有 name） */
export function attachmentName(item, fallback = '附件') {
  return String(item?.name || '').trim() || fallback;
}

/** 单张附件的上传上限：图片 4MB，其他跟随平台上限 */
export function attachmentSizeLimit(item) {
  return isImageAttachment(item) ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
}

/** 超限时给学生看的文案 */
export function attachmentSizeMessage(name, limit) {
  return `${name} 超过 ${Math.round(limit / 1024 / 1024)}MB，换一个小点的`;
}
