/**
 * 作品广场的**文档产物**链路守卫（2026-09-11 新增）。
 *
 * 为什么单独立一条：学生交上来的是一份 PPT 时，广场此前会显示成
 * 「你好，AI 魔法学院」起始页（种子 index.html 一直在会话里，按文件名优先挑入口就挑到它），
 * 或者一段 JSON 原文，而且**没有任何地方能下载到真正的 .pptx**。这条链路里连着四处，
 * 任何一处断掉都不报错、只是「广场显示的不是那个东西」：
 *   ① 提交要把产物清单（含配图引用）定格成快照 —— 否则广场不知道「最近产出的是哪份」；
 *   ② 广场要按「最近产出的那份」选预览目标 —— 按 entry_file 选就会挑到种子 index.html；
 *   ③ 公开下载要能从**快照**渲染出真文件（学生自己下载走的是活会话那条，两条不能混）；
 *   ④ 学生上传的图不是公开素材，得有一个**只认这份作品快照内 fileId** 的代理地址。
 * 另外钉住一个真 bug：提交快照里的文件名允许中文，读回时用写侧的 ASCII 路径校验会抛错
 * —— 表现成「作品已经交上去了、学生却收到 400」。
 *
 * 使用临时 SQLite 与临时上传目录，不碰默认库/生产库。断言按真实 HTTP 打，含 admin 发布与公开端。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p51-public-doc-'));
const dbPath = path.join(temp, 'platform.db');
const uploadRoot = path.join(temp, 'uploads');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  FILE_UPLOAD_ROOT: uploadRoot,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * 从 zip（pptx 就是 zip）里取一个条目的文本。
 * 为什么要真解开：幻灯片 XML 是**压缩**的，直接在上层字节里搜中文是搜不到的
 * （第一版断言就是这么假失败的）。条目名和图片能直接搜到，正文必须解压。
 */
function readZipEntry(buffer, entryName) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === entryName) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      return method === 0 ? raw.toString('utf8') : zlib.inflateRawSync(raw).toString('utf8');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

// 学生上传的图（PRIVATE：普通公开素材口取不到，只能靠作品快照的代理口）
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x0a]);
const PHOTO_KEY = '2026/09/p51-photo.png';
const PHOTO_ID = 'file_p51_photo';
fs.mkdirSync(path.dirname(path.join(uploadRoot, PHOTO_KEY)), { recursive: true });
fs.writeFileSync(path.join(uploadRoot, PHOTO_KEY), PNG);
// 平台生成的插画（公开素材，-1 = 封面）：广场那一版的封面图也要能拿到
const COVER_KEY = '2026/09/p51-cover.png';
const COVER_ID = 'file_p51_cover';
fs.mkdirSync(path.dirname(path.join(uploadRoot, COVER_KEY)), { recursive: true });
fs.writeFileSync(path.join(uploadRoot, COVER_KEY), PNG);

const DECK_TITLE = '去新疆旅游';
const DECK = {
  title: DECK_TITLE,
  subtitle: '五年级三班 · 研学汇报',
  theme: 'sky',
  slides: [
    { title: '天山天池', bullets: ['海拔 1910 米', '夏天也很凉快'], image: { attachment: 1 } },
    { title: '好吃的', bullets: ['烤包子', '大盘鸡'] },
    { layout: 'thanks' },
  ],
};
const DECK_NAME = '去新疆旅游.pptx';
// 种子产物：学生进了课堂就有它，交作品时它还在（这正是广场显示错东西的根源）
const SEED_HTML = '<!doctype html><html><head><title>我的第一个网页</title></head><body><h1>你好，AI 魔法学院！</h1></body></html>';

let serverLog = '';
let server = null;
try {
  const { DatabaseSync } = await import('node:sqlite');
  const seedDb = new DatabaseSync(dbPath);
  const lesson = seedDb.prepare('SELECT id, title FROM course_lessons ORDER BY sort LIMIT 1').get();
  seedDb.prepare("UPDATE course_lessons SET delivery_mode='VIBECODING' WHERE id=?").run(lesson.id);
  seedDb.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(lesson.id);
  seedDb.exec('PRAGMA foreign_keys = OFF');
  const now = new Date().toISOString();
  seedDb.prepare(
    `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(PHOTO_ID, 'USER', 'org-1', 'student-2', 'INTERNAL_PROXY', null, PHOTO_KEY, null, null, '天山.png', 'image/png', PNG.length, 'x', 'MEDIA_ASSET', 'PRIVATE', 'ACTIVE', 'NOT_REQUIRED', null, '{}', 'student-2', now, now);
  seedDb.prepare(
    `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(COVER_ID, 'PLATFORM', null, null, 'INTERNAL_PROXY', null, COVER_KEY, null, null, '封面插画.png', 'image/png', PNG.length, 'x', 'MEDIA_ASSET', 'PUBLIC_PLATFORM', 'ACTIVE', 'NOT_REQUIRED', null, '{"generated":true}', null, now, now);
  seedDb.close();

  const port = 18897;
  server = spawn(process.execPath, ['apps/server/src/index.js'], {
    cwd: root,
    env: { ...baseEnv, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (x) => { serverLog += x; });
  server.stdout.on('data', (x) => { serverLog += x; });

  async function api(pathname, { method = 'GET', token, body } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, data: payload?.data ?? payload, headers: response.headers };
  }
  const login = (loginName, password) => api('/api/auth/login', { method: 'POST', body: { login: loginName, password } });

  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
  // 批次 B：门禁要求「许可 + 课堂名单」，先把这个学生放进一个进行中的课堂
  ensureClassroom(dbPath);
    await sleep(100);
  }

  const student = (await login('student-2', 'study123')).data.token;
  const rootAdmin = (await login('root', 'admin123')).data.token;
  assert.ok(student && rootAdmin, '登录失败');

  const created = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: lesson.id, title: 'P51 新疆研学 PPT' } });
  assert.equal(created.status, 200, `新建会话失败: ${JSON.stringify(created.data)}`);
  const conversationId = created.data.id;
  check('起始会话自带种子产物（index.html 是平台给的脚手架）', (created.data.artifacts || []).some((item) => item.name === 'index.html'));

  // 造出「学生做了一份 PPT」的状态：种子产物 + 学生要的中文名文档 + 一张这一轮传的图。
  // 学生不能手写代码了，所以直接写产物表（与 p25 同一套做法）；本脚本验的是提交之后的链路。
  {
    const driver = new DatabaseSync(dbPath);
    const at = new Date();
    const old = new Date(at.getTime() - 60000).toISOString();
    const recent = at.toISOString();
    driver.prepare('DELETE FROM vibecoding_artifacts WHERE conversation_id=?').run(conversationId);
    const insertArtifact = (id, messageId, name, kind, content, updatedAt) => driver.prepare(
      'INSERT INTO vibecoding_artifacts(id,conversation_id,message_id,name,kind,content,bytes,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(id, conversationId, messageId, name, kind, content, Buffer.byteLength(content), 1, old, updatedAt);
    insertArtifact('vibeart_p51_seed', null, 'index.html', 'html', SEED_HTML, old);
    driver.prepare("INSERT INTO vibecoding_messages(id,conversation_id,role,content,status,attachments,created_at) VALUES ('p51_m_user',?,'user','用这张图做 PPT','SUCCEEDED',?,?)")
      .run(conversationId, JSON.stringify([{ id: PHOTO_ID, name: '天山.png', url: `/api/student/file-assets/${PHOTO_ID}/download`, mime: 'image/png', inline: '' }]), old);
    driver.prepare("INSERT INTO vibecoding_messages(id,conversation_id,role,content,status,attachments,created_at) VALUES ('p51_m_ai',?,'assistant','好的，这是一份新疆研学 PPT','SUCCEEDED',NULL,?)")
      .run(conversationId, recent);
    insertArtifact('vibeart_p51_deck', 'p51_m_ai', DECK_NAME, 'pptx', JSON.stringify(DECK), recent);
    // 平台为封面生成的插画（-1 是封面，与 pptx.js 的 COVER_IMAGE_KEY 一致）
    driver.prepare('UPDATE vibecoding_artifacts SET generated_images=? WHERE id=?')
      .run(JSON.stringify([{ slideIndex: -1, prompt: '天山草原全景', fileId: COVER_ID, url: `/api/public/file-assets/${COVER_ID}/download` }]), 'vibeart_p51_deck');
    driver.prepare('UPDATE vibecoding_conversations SET entry_file=? WHERE id=?').run('index.html', conversationId);
    driver.close();
  }

  // 1) 提交：中文产物名不能让读回抛错（写侧那条 ASCII 路径校验曾在这里误伤，
  //    表现成「已经落库了、学生却收到 400」）
  const submitted = await api(`/api/student/vibecoding/conversations/${conversationId}/submit`, { method: 'POST', token: student, body: { copyrightConfirmed: true, description: '新疆研学汇报' } });
  check('带中文文件名的作品能提交成功', submitted.status === 200, `status=${submitted.status} ${JSON.stringify(submitted.data).slice(0, 200)}`);
  assert.equal(submitted.status, 200);
  const submissionId = submitted.data.id;
  check('提交快照带回了两个产物', (submitted.data.artifacts || []).length === 2, `artifacts=${(submitted.data.artifacts || []).map((item) => item.name).join(',')}`);
  check('主产物 = 最近产出的那份 PPT（不是种子 index.html）', submitted.data.preview?.name === DECK_NAME && submitted.data.preview?.document === true, JSON.stringify(submitted.data.preview));
  check('快照里记下了这一轮的配图引用', (submitted.data.artifacts || []).find((item) => item.name === DECK_NAME)?.attachmentImages?.length === 1, JSON.stringify((submitted.data.artifacts || []).find((item) => item.name === DECK_NAME)?.attachmentImages));
  check('提交快照里的正文按内容读得回来', String(submitted.data.files?.[DECK_NAME] || '').includes(DECK_TITLE));

  // 2) 平台发布（点评删掉之后只剩这一环，学生侧状态恒为 PENDING，不该卡住发布）
  const published = await api(`/api/admin/vibecoding-works/${submissionId}/plaza`, { method: 'PUT', token: rootAdmin, body: { published: true } });
  assert.equal(published.status, 200, `发布失败: ${JSON.stringify(published.data)}`);
  const shareToken = published.data.shareToken;
  check('PENDING 的作品也能发布到作品广场（不再要求「老师已通过」）', published.data.isPublic === true && /^vbt_/.test(String(shareToken)));

  // 3) 公开列表：卡片说得出「这是一份 PPT」
  const publicList = await api('/api/public/vibecoding-works');
  const card = (publicList.data.items || []).find((item) => item.publicUrl === `/works/${shareToken}`);
  check('广场列表里能找到这份作品', Boolean(card));
  check('卡片的主产物是 PPT（不是入口 HTML）', card?.preview?.name === DECK_NAME && card?.preview?.document === true, JSON.stringify(card?.preview));

  // 4) 公开详情：产物清单 + 下载地址 + 配图地址
  const detail = await api(`/api/public/vibecoding-works/${shareToken}`);
  assert.equal(detail.status, 200, `公开详情失败: ${JSON.stringify(detail.data)}`);
  check('入口文件仍然是 index.html（文件清单不骗人）', detail.data.entryFile === 'index.html');
  const catalog = detail.data.artifacts || [];
  const deck = catalog.find((item) => item.name === DECK_NAME);
  check('清单里那份 PPT 标成「可下载的文档」', deck?.document === true && deck?.kind === 'pptx', JSON.stringify(deck));
  check('清单给出了下载地址（编码过的中文名）', String(deck?.downloadUrl || '').includes(encodeURIComponent(DECK_NAME)), String(deck?.downloadUrl));
  check('清单给出了附件图地址（学生传的图走限定代理）', deck?.images?.attachment?.['1'] === `/api/public/vibecoding-works/${shareToken}/images/${PHOTO_ID}`, JSON.stringify(deck?.images));
  check('清单给出了封面插画地址（平台生成的图按幻灯片下标，-1 是封面）', deck?.images?.generated?.['-1'] === `/api/public/file-assets/${COVER_ID}/download`, JSON.stringify(deck?.images?.generated));
  const htmlEntry = catalog.find((item) => item.name === 'index.html');
  check('非文档产物不给下载地址（前端据此走网页预览）', htmlEntry && !htmlEntry.document && !htmlEntry.downloadUrl);

  // 5) 真下载：拿到的必须是能打开的 .pptx，而且用到了那张图（不能静默丢图）
  const download = await fetch(`http://127.0.0.1:${port}${deck.downloadUrl}`);
  const bytes = Buffer.from(await download.arrayBuffer());
  check('公开下载 200', download.status === 200, `status=${download.status}`);
  check('下发的是 pptx（content-type + PK 头）', String(download.headers.get('content-type')).includes('presentationml') && bytes.subarray(0, 2).toString() === 'PK');
  check('下载文件名带得回去（中文名）', decodeURIComponent(String(download.headers.get('content-disposition')).match(/filename\*=UTF-8''([^;]+)/)?.[1] || '') === DECK_NAME, String(download.headers.get('content-disposition')));
  const zipText = bytes.toString('latin1');
  check('pptx 里有幻灯片与图（图没被静默丢掉）', zipText.includes('ppt/slides/slide1.xml') && zipText.includes('ppt/media/'), zipText.includes('ppt/media/') ? '' : '没有 ppt/media/');
  const slideText = (buffer) => [1, 2, 3, 4, 5].map((n) => readZipEntry(buffer, `ppt/slides/slide${n}.xml`) || '').join('\n');
  const slides = slideText(bytes);
  check('标题与要点写进了幻灯片正文', slides.includes(DECK_TITLE) && slides.includes('天山天池'), slides.slice(0, 160));

  // 5b) 广场给的必须是**交上来的那一版**：提交后学生还能接着改（不再锁创作），
  //     改活会话里的产物不能把广场上的作品一起改掉。
  {
    const driver = new DatabaseSync(dbPath);
    driver.prepare('UPDATE vibecoding_artifacts SET content=? WHERE id=?').run(JSON.stringify({ ...DECK, title: '改版之后的标题' }), 'vibeart_p51_deck');
    driver.close();
  }
  const reDownload = Buffer.from(await (await fetch(`http://127.0.0.1:${port}${deck.downloadUrl}`)).arrayBuffer());
  const reSlides = slideText(reDownload);
  check('提交后继续改作品，广场那一版不变（快照生效）', reSlides.includes('天山天池') && !reSlides.includes('改版之后的标题'));

  // 6) 图片代理的准入：只认这份作品快照里出现过的 fileId
  const viaProxy = await fetch(`http://127.0.0.1:${port}/api/public/vibecoding-works/${shareToken}/images/${PHOTO_ID}`);
  check('作品里用到的学生图能公开取到', viaProxy.status === 200 && Buffer.from(await viaProxy.arrayBuffer()).equals(PNG), `status=${viaProxy.status}`);
  const plainPublic = await fetch(`http://127.0.0.1:${port}/api/public/file-assets/${PHOTO_ID}/download`);
  check('同一张图走普通公开素材口取不到（PRIVATE 素材不因代理而变成公开资源）', plainPublic.status === 403, `status=${plainPublic.status}`);
  const notMine = await fetch(`http://127.0.0.1:${port}/api/public/vibecoding-works/${shareToken}/images/file_not_in_this_work`);
  check('不在快照里的 fileId 一律 404（不能拿作品链接当素材探针）', notMine.status === 404, `status=${notMine.status}`);

  // 7) 下架后三样一起消失（列表 / 详情 / 下载 / 配图）
  await api(`/api/admin/vibecoding-works/${submissionId}/plaza`, { method: 'PUT', token: rootAdmin, body: { published: false, reason: 'P51 下架测试：清理测试作品（下架必须给原因）' } });
  const afterDownload = await fetch(`http://127.0.0.1:${port}${deck.downloadUrl}`);
  check('下架后下载地址 404', afterDownload.status === 404, `status=${afterDownload.status}`);
  const afterImage = await fetch(`http://127.0.0.1:${port}/api/public/vibecoding-works/${shareToken}/images/${PHOTO_ID}`);
  check('下架后配图地址 404', afterImage.status === 404, `status=${afterImage.status}`);

  console.log(JSON.stringify({
    name: 'public-document-work', pass: failures === 0,
    preview: { name: DECK_NAME, document: true },
    download: { bytes: bytes.length, mime: download.headers.get('content-type') },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  if (server) server.kill('SIGTERM');
}

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
