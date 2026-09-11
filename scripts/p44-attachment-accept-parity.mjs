// 前端「上传附件」能选的文件类型，不能超出服务端真正放行的白名单。
//
// 为什么要盯这个：`console/attachments.js` 的 ATTACHMENT_ACCEPT 只是给文件选择器的**提示**
// （让学生选之前就知道哪些能传），权威在 `fileUploadSecurity.js` 的 MIME_EXTENSIONS。
// 两边一旦漂移，表现是「学生能选中、点了却被服务端拒」，而且只在真机上传时才暴露 ——
// 典型的静默失败。这里做静态对表，改任一边忘了改另一边就会红。
import { strict as assert } from 'node:assert';

const server = await import('../apps/server/src/services/fileUploadSecurity.js');
const shared = await import('../packages/shared/src/console/attachments.js');

const allowed = new Set(server.allowedUploadExtensions());
const accept = String(shared.ATTACHMENT_ACCEPT || '').split(',').map((item) => item.trim()).filter(Boolean);

assert.ok(accept.length > 0, 'ATTACHMENT_ACCEPT 不能为空');
for (const extension of accept) {
  assert.ok(extension.startsWith('.'), `accept 项要以点开头：${extension}`);
  assert.ok(allowed.has(extension), `accept 里有服务端不接受的扩展名：${extension}`);
}

// 图片必须都在（这是聊天的核心用法）
for (const extension of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
  assert.ok(accept.includes(extension), `accept 缺了图片类型 ${extension}`);
}
// 危险类型任何时候都不许进 accept
for (const extension of ['.exe', '.js', '.sh', '.svg', '.html']) {
  assert.ok(!accept.includes(extension), `accept 里不该有 ${extension}`);
}

// 上限的口径也要能对上：图片 4MB、其他跟随平台上传上限
assert.equal(shared.attachmentSizeLimit({ mime: 'image/png' }), shared.MAX_IMAGE_BYTES, '图片走的应是 4MB 那道闸');
assert.equal(shared.attachmentSizeLimit({ mime: 'application/pdf' }), shared.MAX_ATTACHMENT_BYTES, '非图片走的是平台上限');
assert.ok(shared.MAX_ATTACHMENT_BYTES <= server.maxUploadBytes(), '非图片上限不能超过服务端上传上限');

console.log(`P44 attachment accept parity guard passed（accept ${accept.length} 项，服务端放行 ${allowed.size} 项）`);
