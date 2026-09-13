import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const helperSource = fs.readFileSync(new URL('../apps/server/src/routes/admin/helpers.js', import.meta.url), 'utf8');
const routeSource = fs.readFileSync(new URL('../apps/server/src/routes/admin/works.js', import.meta.url), 'utf8');
const pageSource = fs.readFileSync(new URL('../apps/admin/src/pages/PlatformWorks.jsx', import.meta.url), 'utf8');
const helper = helperSource.slice(helperSource.indexOf('function platformWorkFilters('), helperSource.indexOf('\nfunction buildOrganizationDetail('));
const platformWorkFilters = new Function(`${helper}; return platformWorkFilters;`)();
const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE users(id TEXT, display_name TEXT, login TEXT);
CREATE TABLE organizations(id TEXT, name TEXT);
CREATE TABLE classes(id TEXT, name TEXT);
CREATE TABLE course_series(id TEXT, title TEXT);
CREATE TABLE course_lessons(id TEXT, series_id TEXT, title TEXT);
CREATE TABLE class_sessions(id TEXT, title TEXT);
CREATE TABLE vibecoding_conversations(id TEXT, class_session_id TEXT);
CREATE TABLE work_reports(work_id TEXT, status TEXT);
CREATE TABLE works(id TEXT, student_id TEXT, org_id TEXT, class_id TEXT, course_lesson_id TEXT, class_session_id TEXT, title TEXT, status TEXT, is_public INTEGER, unpublish_reason TEXT, submitted_at TEXT, featured_at TEXT, reviewed_by TEXT);
CREATE TABLE vibecoding_submissions(id TEXT, student_id TEXT, org_id TEXT, class_id TEXT, lesson_id TEXT, conversation_id TEXT, title TEXT, status TEXT, is_public INTEGER, unpublish_reason TEXT, submitted_at TEXT);
INSERT INTO users VALUES ('s1','同名学生','student_100%'),('s2','同名学生','studentX100A');
INSERT INTO organizations VALUES ('o1','机构一'),('o2','机构二');
INSERT INTO course_series VALUES ('p1','创作_100%'),('p2','另一课包');
INSERT INTO course_lessons VALUES ('l1','p1','课时一'),('l2','p2','课时二');
INSERT INTO class_sessions VALUES ('c1','周末课堂');
INSERT INTO vibecoding_conversations VALUES ('v1','c1');
`);
for (const [id, student, org, lesson, status, published, reason] of [
  ['a', 's1', 'o1', 'l1', 'PENDING', 0, null],
  ['b', 's1', 'o1', 'l1', 'PUBLISHED', 1, null],
  ['c', 's2', 'o2', 'l2', 'UNPUBLISHED', 0, '已下架'],
  ['d', 's2', 'o2', 'l2', 'PUBLISHED', 0, null],
]) {
  db.prepare('INSERT INTO works VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, student, org, null, lesson, 'c1', '作品'+id, status, published, reason, '2026-09-13', null, null);
  db.prepare('INSERT INTO vibecoding_submissions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, student, org, null, lesson, 'v1', '作品'+id, 'PENDING', published, reason, '2026-09-13');
}
const rows = (sql, params = []) => db.prepare(sql).all(...params);
const row = (sql, params = []) => db.prepare(sql).get(...params);
const requireRole = (ctx) => assert.equal(ctx.role, 'SUPER_ADMIN');
const normalize = (value) => ({ id: value.id, title: value.title });
const integer = (value, label, opts) => value ? Number(value) : opts.fallback;
const route = new Function('platformWorkFilters', 'rows', 'row', 'requireRole', 'integer', 'normalizeWork', 'normalizeSubmission', 'csvDocument', 'csvFileName', 'audit', routeSource.slice(routeSource.indexOf('export async function handleWorks')).replace('export async function', 'async function') + '; return handleWorks;')(
  platformWorkFilters, rows, row, requireRole, integer, normalize, normalize, (headers, items) => JSON.stringify(items), () => 'works.csv', () => {},
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
