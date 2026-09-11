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
  .run(JSON.stringify([{ id: 'a2', name: 'big.png', url: 'https://iicili.cyou/api/public/file-assets/a2/download', mime: 'image/png', inline: '' }]), new Date(Date.now() + 1000).toISOString());
// 非图片附件（2026-09-11 起支持文档/音视频）：同样不能变成 image_url，但必须如实告诉模型"看不到"
db.prepare("INSERT INTO vibecoding_messages(id,conversation_id,role,content,status,attachments,created_at) VALUES('m3','c1','user','帮我看看这篇','SUCCEEDED',?,?)")
  .run(JSON.stringify([{ id: 'a3', name: '作文.pdf', url: 'https://iicili.cyou/api/public/file-assets/a3/download', mime: 'application/pdf', inline: '' }]), new Date(Date.now() + 2000).toISOString());
db.close();

const { conversationHistory } = await import(pathToFileURL(path.join(root, 'apps/server/src/routes/vibecoding.js')).href);
const history = conversationHistory('c1');

let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); } };

console.log('拼出来的历史：', JSON.stringify(history).slice(0, 260));
const first = history[0];
const second = history[1];
const third = history[2];
check('带内联附件的消息是「内容块」（array）', Array.isArray(first?.content), typeof first?.content);
check('第一块是学生的原话', first?.content?.[0]?.type === 'text' && first.content[0].text === '看看这张图');
// 图是按顺序发过去的，模型不知道我们给它们编了号 —— 做 PPT 引用「第几张图」时要靠这条提示
check('带图的用户消息会告知图片编号（模型才能引用"第 1 张"）',
  first?.content?.some((block) => block.type === 'text' && block.text.includes('编号为 1')) === true,
  JSON.stringify(first?.content));
// 图片块不再固定在下标 1（前面可能有提示块），按类型找，别按位置找
const imageBlocks = (first?.content || []).filter((block) => block.type === 'image_url');
check('图片块用 inline 而不是外链',
  imageBlocks.length === 1 && imageBlocks[0].image_url?.url === inline,
  String(imageBlocks[0]?.image_url?.url).slice(0, 40));

const noImage = (message) => Array.isArray(message?.content) && message.content.every((block) => block.type !== 'image_url');
const noteOf = (message) => (message?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join(' ');
check('没有 inline 的图不产生 image_url（模型看不到它）', noImage(second), JSON.stringify(second?.content));
check('并且如实告诉模型「这个文件你看不到」',
  noteOf(second).includes('big.png') && noteOf(second).includes('读不到'), noteOf(second).slice(0, 80));
check('非图片附件（pdf）同样不产生 image_url', noImage(third), JSON.stringify(third?.content));
check('pdf 也被如实告知（学生原文保留在第一块）',
  third?.content?.[0]?.text === '帮我看看这篇' && noteOf(third).includes('作文.pdf'), JSON.stringify(third?.content).slice(0, 140));

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
