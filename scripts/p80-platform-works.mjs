import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// ⚠️ 这个脚本的库**永远是自己那份内存 SQLite**（下面 `new DatabaseSync(':memory:')`），
//    而 suite 在 MySQL 模式下会把 DB_DRIVER=mysql 传进来 —— 那样 lib.js 的 likeEscapeClause()
//    会给 MySQL 写法（`ESCAPE '\\'` = 两个字符），SQLite 直接拒（"ESCAPE expression must be a single character"）。
//    所以先钉死驱动再取 helper：**要的是"这段 SQL 在 SQLite 上跑得对"**，
//    MySQL 侧那套由 p149（真请求）与套件的 `--mysql` 兜。
process.env.DB_DRIVER = 'sqlite';
const { likeEscapeClause, likeKeyword, inProgressClassroomSql, vibecodingSessionIdExpr } = await import('../apps/server/src/lib.js');

const helperSource = fs.readFileSync(new URL('../apps/server/src/routes/admin/helpers.js', import.meta.url), 'utf8');
const routeSource = fs.readFileSync(new URL('../apps/server/src/routes/admin/works.js', import.meta.url), 'utf8');
const pageSource = fs.readFileSync(new URL('../apps/admin/src/pages/PlatformWorks.jsx', import.meta.url), 'utf8');
// 2026-09-23 RDS 阶段 1：被切出来的这两个函数现在是 `async function`（它们要访问数据库），
// 所以结束标记要容 `async `；否则 indexOf 返回 -1、slice 会一路切到文件末尾（把 export { 也切进去）。
const helper = helperSource.slice(
  helperSource.indexOf('function platformWorkFilters('),
  (() => { const m = helperSource.match(/\n(?:async )?function buildOrganizationDetail\(/); return m ? m.index : -1; })(),
);
// ⚠️ 切出来的这段源码里现在会调用 lib.js 的 likeEscapeClause() / likeKeyword()
//    （2026-09-26 的 LIKE 转义统一），而 `new Function` 只认自己那层参数表 —— 不注入就是
//    `ReferenceError: likeEscapeClause is not defined`（这条守卫当时就是这么被 §三十一 的修复弄红的，
//    而 MySQL 套件当时没重跑，所以谁都没看见）。
// ⚠️ 2026-09-26：这段源码现在还会调用 lib.js 的 inProgressClassroomSql() / vibecodingSessionIdExpr()
//    （「课堂还在进行中的作品不进平台后台」那条口径），同样要一起注入。
const platformWorkFilters = new Function('likeEscapeClause', 'likeKeyword', 'inProgressClassroomSql', 'vibecodingSessionIdExpr', `${helper}; return platformWorkFilters;`)(likeEscapeClause, likeKeyword, inProgressClassroomSql, vibecodingSessionIdExpr);
const db = new DatabaseSync(':memory:'); db.exec('PRAGMA busy_timeout = 5000');
db.exec(`
CREATE TABLE users(id TEXT, display_name TEXT, login TEXT);
CREATE TABLE organizations(id TEXT, name TEXT);
CREATE TABLE classes(id TEXT, name TEXT);
CREATE TABLE course_series(id TEXT, title TEXT);
CREATE TABLE course_lessons(id TEXT, series_id TEXT, title TEXT);
CREATE TABLE class_sessions(id TEXT, title TEXT, status TEXT);
CREATE TABLE vibecoding_conversations(id TEXT, class_session_id TEXT);
CREATE TABLE work_reports(work_id TEXT, status TEXT);
CREATE TABLE works(id TEXT, student_id TEXT, org_id TEXT, class_id TEXT, course_lesson_id TEXT, class_session_id TEXT, title TEXT, status TEXT, is_public INTEGER, unpublish_reason TEXT, submitted_at TEXT, featured_at TEXT, reviewed_by TEXT);
CREATE TABLE vibecoding_submissions(id TEXT, student_id TEXT, org_id TEXT, class_id TEXT, lesson_id TEXT, conversation_id TEXT, title TEXT, status TEXT, is_public INTEGER, unpublish_reason TEXT, submitted_at TEXT);
INSERT INTO users VALUES ('s1','同名学生','student_100%'),('s2','同名学生','studentX100A');
INSERT INTO organizations VALUES ('o1','机构一'),('o2','机构二');
INSERT INTO course_series VALUES ('p1','创作_100%'),('p2','另一课包');
INSERT INTO course_lessons VALUES ('l1','p1','课时一'),('l2','p2','课时二');
INSERT INTO class_sessions VALUES ('c1','周末课堂','ENDED'),('c2','进行中的课堂','ACTIVE');
INSERT INTO vibecoding_conversations VALUES ('v1','c1'),('v2','c2');
`);
// 第 8 个字段是**课堂 id**（第 9 个是 VibeCoding 的会话 id）：'e' 挂在**进行中**的 c2 上 ——
// 它按 2026-09-26 的用户口径**不该**出现在平台端任何列表里（机构端/教师端照旧看得见）。
for (const [id, student, org, lesson, status, published, reason, sessionId, conversationId] of [
  ['a', 's1', 'o1', 'l1', 'PENDING', 0, null, 'c1', 'v1'],
  ['b', 's1', 'o1', 'l1', 'PUBLISHED', 1, null, 'c1', 'v1'],
  ['c', 's2', 'o2', 'l2', 'UNPUBLISHED', 0, '已下架', 'c1', 'v1'],
  ['d', 's2', 'o2', 'l2', 'PUBLISHED', 0, null, 'c1', 'v1'],
  ['e', 's1', 'o1', 'l1', 'PENDING', 0, null, 'c2', 'v2'],
]) {
  db.prepare('INSERT INTO works VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, student, org, null, lesson, sessionId, '作品'+id, status, published, reason, '2026-09-13', null, null);
  db.prepare('INSERT INTO vibecoding_submissions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, student, org, null, lesson, conversationId, '作品'+id, 'PENDING', published, reason, '2026-09-13');
}
const rows = (sql, params = []) => db.prepare(sql).all(...params);
const row = (sql, params = []) => db.prepare(sql).get(...params);
// 2026-09-23 RDS 阶段 1：数据访问改异步（row/rows/q/transaction → arow/arows/aq/atransaction）。
// 这个脚本是把服务器函数**从源码里切出来、注入假依赖**跑单测，所以异步名也要一并注入；
// 假实现就是同步那套的 async 外壳（与 packages/database/src/schema.js 转换期完全同构）。
const arows = async (sql, params = []) => rows(sql, params);
const arow = async (sql, params = []) => row(sql, params);
const aq = async (sql, params = []) => db.prepare(sql).run(...params);
const amap = async (list, fn) => { const out = []; for (let i = 0; i < list.length; i += 1) out.push(await fn(list[i], i, list)); return out; };
const atransaction = async (fn) => { db.exec('BEGIN IMMEDIATE'); try { const result = await fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
const requireRole = (ctx) => assert.equal(ctx.role, 'SUPER_ADMIN');
const normalize = (value) => ({ id: value.id, title: value.title });
const integer = (value, label, opts) => value ? Number(value) : opts.fallback;
const route = new Function('platformWorkFilters', 'rows', 'row', 'arow', 'arows', 'aq', 'atransaction', 'amap', 'requireRole', 'integer', 'normalizeWork', 'normalizeSubmission', 'csvDocument', 'csvFileName', 'audit', 'likeEscapeClause', 'likeKeyword', 'inProgressClassroomSql', 'vibecodingSessionIdExpr', routeSource.slice(routeSource.indexOf('export async function handleWorks')).replace('export async function', 'async function') + '; return handleWorks;')(
  platformWorkFilters, rows, row, arow, arows, aq, atransaction, amap, requireRole, integer, normalize, normalize, (headers, items) => JSON.stringify(items), () => 'works.csv', () => {}, likeEscapeClause, likeKeyword, inProgressClassroomSql, vibecodingSessionIdExpr,
);
const query = (path, filters = {}, role = 'SUPER_ADMIN') => route({ search: new URLSearchParams(filters), role }, path, 'GET');
for (const path of ['/works', '/vibecoding-works']) {
  for (const [filters, ids] of [
    [{}, ['d','c','b','a']],
    [{ published: '1' }, ['b']],
    [{ published: '0' }, ['d','c','a']],
    [{ publicationState: 'SUBMITTED' }, ['d','a']],
    [{ publicationState: 'UNPUBLISHED' }, ['c']],
    [{ student: 'student_100%' }, ['b','a']],
    [{ packageName: '创作_100%' }, ['b','a']],
    [{ lesson: '课时二', orgId: 'o2' }, ['d','c']],
    [{ search: '机构一', student: 'student_100%', packageName: '创作_100%', published: '1' }, ['b']],
    [{ search: "' OR 1=1 --" }, []],
  ]) {
    const result = await query(path, filters);
    assert.deepEqual(result.items.map((item) => item.id), ids, `${path} ${JSON.stringify(filters)}`);
    assert.equal(result.total, ids.length);
  }
  const paged = await query(path, { limit: '1', page: '2', student: 'student_100%' });
  assert.equal(paged.total, 2); assert.equal(paged.totalPages, 2); assert.equal(paged.items[0].id, 'a');
  assert.equal(paged.items[0].studentLogin, 'student_100%');
  assert.equal(paged.items[0].packageName, '创作_100%');
  assert.equal(paged.items[0].sessionTitle, '周末课堂');
  assert.equal(paged.items[0].publicationState, 'SUBMITTED');
  await assert.rejects(query(path, {}, 'TEACHER'));

  /* ⭐ 2026-09-26 用户口径：**课堂还在进行中的作品不进平台后台**（它留在机构端/教师端，老师上课要讲解）。
     上面的每一条断言里都没有 'e'（它就挂在进行中的 c2 上）—— 这里再单独钉死"进行中→不出现 / 课堂结束→出现"，
     免得哪天有人嫌这条过滤碍事删掉，而上面那批断言照样全绿。 */
  const running = await query(path, {});
  assert.ok(!running.items.some((item) => item.id === 'e'), `${path} 课堂进行中的作品不该出现在平台作品库：${JSON.stringify(running.items.map((item) => item.id))}`);
  db.prepare("UPDATE class_sessions SET status='ENDED' WHERE id='c2'").run();
  const ended = await query(path, {});
  assert.ok(ended.items.some((item) => item.id === 'e'), `${path} 课堂结束后同一份作品应该进平台作品库：${JSON.stringify(ended.items.map((item) => item.id))}`);
  db.prepare("UPDATE class_sessions SET status='ACTIVE' WHERE id='c2'").run();
}
const exported = await query('/works/export', { student: 'student_100%', packageName: '创作_100%', published: '1' });
assert.equal(exported.count, 1); assert.match(exported.content, /作品b/);
assert.match(pageSource, /role="group" aria-label="作品类型"/);
assert.equal((pageSource.match(/result\.data\.items\.map/g) || []).length, 1);
assert.match(pageSource, /if \(active\) setResult/);
assert.match(pageSource, /确认发布/); assert.match(pageSource, /确认下架/);
assert.match(pageSource, /busy\.current/);
assert.match(pageSource, /历史举报记录（只读，治理暂缓）/);
assert.doesNotMatch(pageSource, /api\.put\(`admin\/work-reports/);
assert.match(pageSource, /tone: 'danger'/);
db.close();
console.log('p80 passed: both real GET branches, SQLite filters/counts/pagination/source joins, CSV parity, teacher guards, publication UI guards.');
