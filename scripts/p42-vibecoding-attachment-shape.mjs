// 验证 conversationHistory 的产出形状：带内联附件的用户消息必须发成内容块，
// 且图片用的是 **inline**（外链会让上游抓不到而报错）；没有 inline 的附件不进请求。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p42-attach-'));
const dbPath = path.join(temp, 'platform.db');
fs.writeFileSync(path.join(temp, 'marker'), '');
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
await run(['packages/database/src/db.js', '--init']);

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = OFF');
db.prepare("INSERT INTO vibecoding_conversations(id,org_id,student_id,title,files,entry_file,status,created_at,updated_at) VALUES('c1','o1','u1','t','{}','index.html','DRAFT',?,?)").run(new Date().toISOString(), new Date().toISOString());
const now = new Date().toISOString();
const inline = 'data:image/png;base64,iVBORw0KGgo=';
db.prepare("INSERT INTO vibecoding_messages(id,conversation_id,role,content,status,attachments,created_at) VALUES('m1','c1','user','看看这张图','SUCCEEDED',?,?)")
  .run(JSON.stringify([{ id: 'a1', name: 'x.png', url: 'https://iicili.cyou/api/public/file-assets/a1/download', inline }]), now);
db.prepare("INSERT INTO vibecoding_messages(id,conversation_id,role,content,status,attachments,created_at) VALUES('m2','c1','user','这张太大','SUCCEEDED',?,?)")
  .run(JSON.stringify([{ id: 'a2', name: 'big.png', url: 'https://iicili.cyou/api/public/file-assets/a2/download', inline: '' }]), new Date(Date.now() + 1000).toISOString());
db.close();

const { conversationHistory } = await import(pathToFileURL(path.join(root, 'apps/server/src/routes/vibecoding.js')).href);
const history = conversationHistory('c1');

let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

console.log('拼出来的历史：', JSON.stringify(history).slice(0, 260));
const first = history[0];
const second = history[1];
check('带内联附件的消息是「内容块」（array）', Array.isArray(first?.content), typeof first?.content);
check('第一块是文本', first?.content?.[0]?.type === 'text');
check('第二块是图片，且用 inline 而不是外链',
  first?.content?.[1]?.image_url?.url === inline,
  String(first?.content?.[1]?.image_url?.url).slice(0, 40));
check('没有 inline 的附件不进请求（保持纯文本）', typeof second?.content === 'string', typeof second?.content);

// 模拟渠道（本地开发的默认）拿到内容块消息时，不能把数组 String() 成 "[object Object]" ——
// 上一版就是这样：带图发一句，回复里出现 "[object Object],[object Object]"。
{
  const { getGenerationProvider } = await import(pathToFileURL(path.join(root, 'apps/server/src/services/generationProvider.js')).href);
  const mock = getGenerationProvider({ provider: 'local-mock', model: 'canvas-mock-v1' });
  // 只喂**内容块那条**：模拟渠道取的是"最后一条用户消息"，混着喂会挑到纯文本那条、测不到这个坑。
  let reply = '';
  await mock.generateStream({ messages: [history[0]], onDelta: (_delta, full) => { reply = full; } });
  check('模拟渠道对内容块消息不吐 [object Object]',
    !reply.includes('[object Object]') && reply.includes('看看这张图'), reply.replace(/\s+/g, ' ').slice(0, 80));
}

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
