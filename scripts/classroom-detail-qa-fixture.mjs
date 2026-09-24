import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowed = fs.realpathSync(path.join(root, '.tmp'));
const dbPath = fs.realpathSync(path.resolve(process.argv[2] || path.join(allowed, 'classroom-detail-qa/platform.db')));
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

assert.ok(dbPath.startsWith(allowed + path.sep), 'Fixture only permits existing databases inside this repository .tmp');
const uploads = path.join(path.dirname(dbPath), 'uploads');
fs.mkdirSync(uploads, { recursive: true });
assert.ok(fs.realpathSync(uploads).startsWith(allowed + path.sep), 'Upload directory must remain inside .tmp');
 
const admin = await arow("SELECT * FROM users WHERE login='org-admin' AND role='ORG_ADMIN'");
const session = await arow("SELECT * FROM class_sessions WHERE teacher_id=? AND org_id=? ORDER BY created_at DESC LIMIT 1", [admin.id, admin.org_id]);
assert.ok(session, 'Requires an existing org-admin classroom; no reset or global seed');
const student = await arow("SELECT * FROM users WHERE org_id=? AND role='STUDENT' ORDER BY login LIMIT 1", [admin.org_id]);
const now = new Date().toISOString();
const prefix = 'qa_detail_';
const imageId = prefix + 'image';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
fs.writeFileSync(path.join(uploads, 'classroom-detail.png'), png);
const imageUrl = `/api/student/file-assets/${imageId}/download`;
const snapshot = { nodes: [{ id: 'note', type: 'prompt', position: { x: 30, y: 30 }, data: { title: 'Submitted Canvas snapshot', text: 'Read-only classroom work' } }, { id: 'image', type: 'image', position: { x: 430, y: 30 }, data: { title: 'Private image', assetUrl: imageUrl } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:32px}img{width:80px;height:80px;background:#18a46a}button{padding:12px}</style></head><body><h1>Private submitted Vibe work</h1><img src="${imageUrl}" alt="Private fixture image"><p id="count">0</p><button onclick="document.getElementById('count').textContent=++window.count">Add one</button><script>window.count=0</script></body></html>`;
await aq('BEGIN');
try {
  await aq("INSERT OR IGNORE INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_key,file_name,mime_type,visibility,status,created_at,updated_at) VALUES (?,'USER',?,?,'INTERNAL_PROXY','classroom-detail.png','classroom-detail.png','image/png','PRIVATE','ACTIVE',?,?)", [imageId, admin.org_id, student.id, now, now]);
  await aq("INSERT OR IGNORE INTO student_projects(id,student_id,org_id,class_session_id,title,last_saved_at,created_at,updated_at) VALUES (?,?,?,?,'QA Canvas',?,?,?)", [prefix+'project', student.id, admin.org_id, session.id, now, now, now]);
  await aq("INSERT OR IGNORE INTO works(id,project_id,student_id,org_id,class_session_id,title,canvas_snapshot,submitted_at) VALUES (?,?,?,?,?,'QA private Canvas',?,?)", [prefix+'canvas', prefix+'project', student.id, admin.org_id, session.id, JSON.stringify(snapshot), now]);
  await aq("INSERT OR IGNORE INTO vibecoding_conversations(id,org_id,student_id,class_session_id,title,created_at,updated_at) VALUES (?,?,?,?,'QA Vibe live conversation',?,?)", [prefix+'conversation', admin.org_id, student.id, session.id, now, now]);
  await aq("INSERT OR IGNORE INTO vibecoding_submissions(id,conversation_id,student_id,org_id,title,files,artifacts,submitted_at,created_at,updated_at) VALUES (?,?,?,?,'QA private Vibe',?,?,?,?,?)", [prefix+'vibe', prefix+'conversation', student.id, admin.org_id, JSON.stringify({ 'index.html': html }), JSON.stringify([{ name: 'index.html', kind: 'html', embeddedImages: [{ fileId: imageId }] }]), now, now, now]);
  // Clone one lesson locally, preserving its published snapshot except the two-mode declaration.
  const lesson = await arow('SELECT * FROM course_lessons WHERE id=?', [session.lesson_id]);
  const clone = { ...lesson, id: prefix+'dual_lesson', title: 'QA dual environment', delivery_mode: 'CANVAS', delivery_modes: JSON.stringify(['CANVAS','VIBECODING']) };
  if (clone.published_content) { const published = JSON.parse(clone.published_content); published.title = clone.title; published.deliveryMode = 'CANVAS'; published.deliveryModes = ['CANVAS','VIBECODING']; clone.published_content = JSON.stringify(published); }
  const keys = Object.keys(clone);
  await aq(`INSERT OR IGNORE INTO course_lessons (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, [...keys.map((key) => clone[key])]);
  await aq('COMMIT');
  console.log(JSON.stringify({ dbPath, sessionId: session.id, canvasId: prefix+'canvas', vibeId: prefix+'vibe', dualLessonId: clone.id, FILE_UPLOAD_ROOT: uploads, note: 'Restart QA server with this FILE_UPLOAD_ROOT; private fixture works are not published.' }, null, 2));
} catch (error) { await aq('ROLLBACK'); throw error; }
finally {  }
