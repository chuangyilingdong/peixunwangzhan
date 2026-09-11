// 文档产物「配图」这条链路的守卫。
//
// 为什么要单独立一条：从「规格里写了 {"attachment":1}」到「pptx 里真有一张图」中间连着三处，
// **任何一处断掉都不报错**，表现为「PPT 生成了、就是没图」：
//   ① 产物要能顺着 messageId 找到产出它的那一轮（getArtifact 返回的是驼峰 messageId，不是列名 message_id）
//   ② 用户消息的附件里要带 mime（读取端 parseAttachments 只带 id/name/url/inline 的话，
//      「这一轮有几张图」永远是 0）
//   ③ 素材要能从本地存储读回字节（storage_kind/storage_key/路径穿越检查）
// 这三处本轮全踩过（①②是真 bug，③是设计），所以这里把它们一起钉住。
// 不需要 python、不需要起服务：临时库 + 直接调导出的解析函数。
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p47-docimage-'));
const dbPath = path.join(temp, 'platform.db');
const uploadRoot = path.join(temp, 'uploads');
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;
process.env.FILE_UPLOAD_ROOT = uploadRoot;

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
await run(['packages/database/src/db.js', '--init']);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');

// 素材落盘：一份图片、一份文档（用来验证非图片附件不占编号）
function putAsset(id, key, buffer, mime, name) {
  const absolute = path.join(uploadRoot, key);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, buffer);
  return { id, key, mime, name };
}
const photo = putAsset('file_photo', '2026/09/photo.png', PNG, 'image/png', '照片.png');
const doc = putAsset('file_doc', '2026/09/notes.pdf', PDF, 'application/pdf', '笔记.pdf');

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = OFF');
const now = new Date().toISOString();
const asset = (item) => db.prepare(
  `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
).run(item.id, 'USER', 'o1', 'u1', 'INTERNAL_PROXY', null, item.key, null, null, item.name, item.mime, 8, 'x', 'MEDIA_ASSET', 'PUBLIC_PLATFORM', 'ACTIVE', 'NOT_REQUIRED', null, '{}', 'u1', now, now);
asset(photo); asset(doc);

db.prepare("INSERT INTO vibecoding_conversations(id,org_id,student_id,title,files,entry_file,status,created_at,updated_at) VALUES('c1','o1','u1','t','{}','index.html','DRAFT',?,?)").run(now, now);
const attachments = JSON.stringify([
  { id: 'file_photo', name: '照片.png', url: 'https://x/api/public/file-assets/file_photo/download', mime: 'image/png', inline: '' },
  { id: 'file_doc', name: '笔记.pdf', url: 'https://x/api/public/file-assets/file_doc/download', mime: 'application/pdf', inline: '' },
]);
db.prepare("INSERT INTO vibecoding_messages(id,conversation_id,role,content,status,attachments,created_at) VALUES('m_user','c1','user','用这张图做 PPT','SUCCEEDED',?,?)").run(attachments, now);
db.prepare("INSERT INTO vibecoding_messages(id,conversation_id,role,content,status,attachments,created_at) VALUES('m_ai','c1','assistant','好的','SUCCEEDED',NULL,?)").run(new Date(Date.now() + 1000).toISOString());
db.prepare("INSERT INTO vibecoding_artifacts(id,conversation_id,message_id,name,kind,content,bytes,revision,created_at,updated_at) VALUES('a1','c1','m_ai','演示.pptx','pptx','{}',2,1,?,?)").run(now, now);
// 一件老产物：message_id 为空（流式期间落库、还没回填就被读了）
db.prepare("INSERT INTO vibecoding_artifacts(id,conversation_id,message_id,name,kind,content,bytes,revision,created_at,updated_at) VALUES('a2','c1',NULL,'老的.pptx','pptx','{}',2,1,?,?)").run(now, now);
db.close();

const { attachmentImageMap } = await import(pathToFileURL(path.join(root, 'apps/server/src/routes/vibecoding.js')).href);

let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

const images = attachmentImageMap('c1', { messageId: 'm_ai' });
check('顺着驼峰 messageId 找得到产出那一轮的图片附件', images.size === 1, `size=${images.size}`);
check('取到的是那张图的真实字节', images.get(1)?.equals(PNG) === true, `bytes=${images.get(1)?.length}`);
check('非图片附件不占编号（序号 2 不该有东西）', images.get(2) === undefined);
// 数据库列名写法也要认（调用方可能直接传行对象）——写错就静默没图，属于同一个坑
check('直接传数据库行对象（message_id）也能取到', attachmentImageMap('c1', { message_id: 'm_ai' }).size === 1);
check('messageId 缺失时不报错、只是没有图', attachmentImageMap('c1', { name: 'x' }).size === 0 && attachmentImageMap('c1', null).size === 0);
check('不存在的那一轮不会误取别人的图', attachmentImageMap('c1', { messageId: 'm_user' }).size === 0);

// 素材被挪走/删掉：不能抛异常（下载应当降级成「这一页没有图」）
fs.rmSync(path.join(uploadRoot, photo.key));
check('素材文件不在了也只是没有图，不抛异常', attachmentImageMap('c1', { messageId: 'm_ai' }).size === 0);

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
