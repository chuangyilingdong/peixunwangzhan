import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowed = fs.realpathSync(path.join(root, '.tmp'));
const dbPath = fs.realpathSync(path.resolve(process.argv[2] || path.join(allowed, 'classroom-detail-qa/platform.db')));
assert.ok(dbPath.startsWith(allowed + path.sep), 'Fixture only permits existing databases inside this repository .tmp');
const uploads = path.join(path.dirname(dbPath), 'uploads');
fs.mkdirSync(uploads, { recursive: true });
assert.ok(fs.realpathSync(uploads).startsWith(allowed + path.sep), 'Upload directory must remain inside .tmp');
const db = new DatabaseSync(dbPath);
const admin = db.prepare("SELECT * FROM users WHERE login='org-admin' AND role='ORG_ADMIN'").get();
const session = db.prepare("SELECT * FROM class_sessions WHERE teacher_id=? AND org_id=? ORDER BY created_at DESC LIMIT 1").get(admin.id, admin.org_id);
assert.ok(session, 'Requires an existing org-admin classroom; no reset or global seed');
const student = db.prepare("SELECT * FROM users WHERE org_id=? AND role='STUDENT' ORDER BY login LIMIT 1").get(admin.org_id);
const now = new Date().toISOString();
const prefix = 'qa_detail_';
const imageId = prefix + 'image';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
fs.writeFileSync(path.join(uploads, 'classroom-detail.png'), png);
const imageUrl = `/api/student/file-assets/${imageId}/download`;
const snapshot = { nodes: [{ id: 'note', type: 'prompt', position: { x: 30, y: 30 }, data: { title: 'Submitted Canvas snapshot', text: 'Read-only classroom work' } }, { id: 'image', type: 'image', position: { x: 430, y: 30 }, data: { title: 'Private image', assetUrl: imageUrl } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:32px}img{width:80px;height:80px;background:#18a46a}button{padding:12px}</style></head><body><h1>Private submitted Vibe work</h1><img src="${imageUrl}" alt="Private fixture image"><p id="count">0</p><button onclick="document.getElementById('count').textContent=++window.count">Add one</button><script>window.count=0</script></body></html>`;
db.exec('BEGIN');
try {
  db.prepare("INSERT OR IGNORE INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_key,file_name,mime_type,visibility,status,created_at,updated_at) VALUES (?,'USER',?,?,'INTERNAL_PROXY','classroom-detail.png','classroom-detail.png','image/png','PRIVATE','ACTIVE',?,?)").run(imageId, admin.org_id, student.id, now, now);
  db.prepare("INSERT OR IGNORE INTO student_projects(id,student_id,org_id,class_session_id,title,last_saved_at,created_at,updated_at) VALUES (?,?,?,?,'QA Canvas',?,?,?)").run(prefix+'project', student.id, admin.org_id, session.id, now, now, now);
  db.prepare("INSERT OR IGNORE INTO works(id,project_id,student_id,org_id,class_session_id,title,canvas_snapshot,submitted_at) VALUES (?,?,?,?,?,'QA private Canvas',?,?)").run(prefix+'canvas', prefix+'project', student.id, admin.org_id, session.id, JSON.stringify(snapshot), now);
  db.prepare("INSERT OR IGNORE INTO vibecoding_conversations(id,org_id,student_id,class_session_id,title,created_at,updated_at) VALUES (?,?,?,?,'QA Vibe live conversation',?,?)").run(prefix+'conversation', admin.org_id, student.id, session.id, now, now);
  db.prepare("INSERT OR IGNORE INTO vibecoding_submissions(id,conversation_id,student_id,org_id,title,files,artifacts,submitted_at,created_at,updated_at) VALUES (?,?,?,?,'QA private Vibe',?,?,?,?,?)").run(prefix+'vibe', prefix+'conversation', student.id, admin.org_id, JSON.stringify({ 'index.html': html }), JSON.stringify([{ name: 'index.html', kind: 'html', embeddedImages: [{ fileId: imageId }] }]), now, now, now);
  // Clone one lesson locally, preserving its published snapshot except the two-mode declaration.
  const lesson = db.prepare('SELECT * FROM course_lessons WHERE id=?').get(session.lesson_id);
  const clone = { ...lesson, id: prefix+'dual_lesson', title: 'QA dual environment', delivery_mode: 'CANVAS', delivery_modes: JSON.stringify(['CANVAS','VIBECODING']) };
  if (clone.published_content) { const published = JSON.parse(clone.published_content); published.title = clone.title; published.deliveryMode = 'CANVAS'; published.deliveryModes = ['CANVAS','VIBECODING']; clone.published_content = JSON.stringify(published); }
  const keys = Object.keys(clone);
  db.prepare(`INSERT OR IGNORE INTO course_lessons (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((key) => clone[key]));
  db.exec('COMMIT');
  console.log(JSON.stringify({ dbPath, sessionId: session.id, canvasId: prefix+'canvas', vibeId: prefix+'vibe', dualLessonId: clone.id, FILE_UPLOAD_ROOT: uploads, note: 'Restart QA server with this FILE_UPLOAD_ROOT; private fixture works are not published.' }, null, 2));
} catch (error) { db.exec('ROLLBACK'); throw error; }
finally { db.close(); }
