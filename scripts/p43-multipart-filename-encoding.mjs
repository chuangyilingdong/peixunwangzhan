// 上传文件名的编码回归：浏览器发的 multipart 头里，中文文件名是 **UTF-8 字节**，
// 而我们是按 latin1 把这串头读出来的 —— 不在解析处还原一次，学生看到的就是「æˆªå›¾.png」。
// 2026-09-11 实测发现并修复（学生传「截图.png」必中），这里把口径钉住。
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'ai-kids-p43-'));
process.env.FILE_UPLOAD_ROOT = root;
process.env.FILE_UPLOAD_REQUIRE_SCANNER = 'false';
process.env.NODE_ENV = 'test';
const { parseMultipartFormData, persistSecureUpload } = await import('../apps/server/src/services/fileUploadSecurity.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// filename 传字符串＝按 UTF-8 落字节（浏览器的行为）；传 Buffer＝原样落字节（用来造别的编码）
function multipart({ filename, mime = 'image/png', buffer = PNG, extraDisposition = '' }) {
  const boundary = '----p43-boundary';
  const name = Buffer.isBuffer(filename) ? filename : Buffer.from(filename, 'utf8');
  return {
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="`),
      name,
      Buffer.from(`"${extraDisposition}\r\nContent-Type: ${mime}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const parsed = (form) => parseMultipartFormData(form.body, form.contentType).file.fileName;

const cases = [
  ['纯 ASCII 不变', 'safe.png', 'safe.png'],
  ['中文名按 UTF-8 还原', '我的照片.png', '我的照片.png'],
  ['中英混排', 'photo-测试-2.png', 'photo-测试-2.png'],
  ['中文全角括号（NFKC 归一化后仍应是中文）', '画画（1）.png', '画画（1）.png'],
  ['四字节 UTF-8（emoji）', '作品🎨.png', '作品🎨.png'],
];
for (const [label, sent, expected] of cases) {
  assert.equal(parsed(multipart({ filename: sent })), expected, label);
}

// 本来就是 latin1 的名字（é = 单字节 0xE9）不该被"还原"坏掉
assert.equal(parsed(multipart({ filename: Buffer.from('caf\xe9.png', 'latin1') })), 'café.png', 'latin1 名字保持原样');

// RFC 5987 的 filename* 优先于 filename
assert.equal(
  parsed(multipart({ filename: 'fallback.png', extraDisposition: `; filename*=UTF-8''${encodeURIComponent('中文名.png')}` })),
  '中文名.png',
  'filename* 优先',
);

// 还原之后，扩展名校验必须仍然生效（别因为解码把安全校验绕过去）
await assert.rejects(
  () => persistSecureUpload({ fileName: parsed(multipart({ filename: '脚本.exe' })), mimeType: 'image/png', buffer: PNG }),
  (error) => error.code === 'FILE_EXTENSION_BLOCKED',
  '中文名 + 被禁扩展名仍要拒',
);

// 落库用的名字也要是还原后的
const stored = await persistSecureUpload({ fileName: parsed(multipart({ filename: '我的照片.png' })), mimeType: 'image/png', buffer: PNG });
assert.equal(stored.fileName, '我的照片.png', '落库文件名');

console.log('P43 multipart filename encoding guard passed');
