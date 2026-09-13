import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'vite';

const root = process.cwd();
const classroomSource = fs.readFileSync(path.join(root, 'apps/org/src/pages/Classrooms.jsx'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'apps/org/src/main.jsx'), 'utf8');
const selectSource = fs.readFileSync(path.join(root, 'packages/shared/src/SearchSelect.jsx'), 'utf8');

assert.match(mainSource, /path="\/classrooms\/:sessionId"/);
assert.match(classroomSource, /useParams\(\)/);
assert.match(classroomSource, /navigate\('\/classrooms\/'/);
assert.match(classroomSource, /navigate\(-1\)/);
assert.match(classroomSource, /navigate\('\/classrooms', \{ replace: true \}\)/);
assert.doesNotMatch(classroomSource, />入口类型<select/);
assert.match(classroomSource, /lessonModes\.length > 1/);
assert.match(classroomSource, /SearchSelect/);
assert.match(classroomSource, /<SearchSelect ariaLabel="搜索课包"/);
assert.match(classroomSource, /<SearchSelect ariaLabel="搜索负责老师"/);
assert.match(selectSource, /role="combobox"/);
assert.match(selectSource, /role="listbox"/);
assert.match(selectSource, /aria-activedescendant/);
assert.match(selectSource, /aria-selected/);
assert.match(selectSource, /aria-disabled/);
assert.match(selectSource, /role="status"/);
assert.match(selectSource, /import '\.\/search-select\.css'/);

const ssrParent = path.join(root, '.tmp');
fs.mkdirSync(ssrParent, { recursive: true });
const ssrTemp = fs.mkdtempSync(path.join(ssrParent, 'p81-ssr-'));
const entry = path.join(ssrTemp, 'entry.jsx');
fs.writeFileSync(entry, `
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Classrooms } from ${JSON.stringify(path.join(root, 'apps/org/src/pages/Classrooms.jsx').split(path.sep).join('/'))};
import { SearchSelect, getSearchSelectKeyAction } from ${JSON.stringify(path.join(root, 'packages/shared/src/SearchSelect.jsx').split(path.sep).join('/'))};
const api = { get: () => Promise.resolve({ items: [] }), post: () => Promise.resolve({}), delete: () => Promise.resolve({}) };
const detail = renderToString(<MemoryRouter initialEntries={['/classrooms/session-deep']}><Routes><Route path="/classrooms/:sessionId" element={<Classrooms api={api} user={{ role: 'TEACHER' }} />} /></Routes></MemoryRouter>);
if (!detail.includes('返回课堂列表')) throw new Error('deep link did not render detail route');
const select = renderToString(<SearchSelect value="" onChange={() => {}} options={[]} ariaLabel="课包" />);
if (!select.includes('aria-expanded="false"') || !select.includes('aria-haspopup="listbox"')) throw new Error('closed selector aria missing');
const expected = [['ArrowDown',false,'OPEN',1],['ArrowUp',false,'OPEN',-1],['ArrowDown',true,'MOVE',1],['ArrowUp',true,'MOVE',-1],['Enter',true,'SELECT',null],['Escape',true,'CLOSE',null]];
for (const [key, open, type, direction] of expected) { const action = getSearchSelectKeyAction(key, open); if (action?.type !== type || (direction !== null && action.direction !== direction)) throw new Error('keyboard action failed: '+key); }
console.log('P81 SSR and SearchSelect keyboard passed');
`);
const outDir = path.join(ssrTemp, 'out');
await build({ root, configFile: path.join(root, 'apps/org/vite.config.mjs'), logLevel: 'error', ssr: { noExternal: true }, build: { ssr: entry, outDir, emptyOutDir: true, minify: false } });
const ssrFile = fs.readdirSync(outDir).find((name) => /\.(?:m?js)$/.test(name));
assert.ok(ssrFile, 'P81 SSR bundle missing');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(outDir, ssrFile)], { cwd: root, stdio: 'inherit' });
  child.on('close', (code) => code ? reject(new Error(`P81 SSR exited ${code}`)) : resolve());
});

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p81-api-'));
const dbPath = path.join(temp, 'platform.db');
const env = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'), DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('close', (code) => code ? reject(new Error(output)) : resolve(output));
});
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const db = new DatabaseSync(dbPath);
const lesson = db.prepare("SELECT id FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1").get();
const forged = db.prepare("SELECT id FROM users WHERE role='TEACHER' AND login<>'teacher-1' LIMIT 1").get();
const actual = db.prepare("SELECT id FROM users WHERE login='teacher-1'").get();
assert.ok(lesson && forged && actual, 'P81 fixture missing lesson or teachers');
db.close();
const port = 19081;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });
const api = async (pathname, init = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const body = await response.json();
  return { status: response.status, data: body.data ?? body, error: body.error };
};
try {
  for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'teacher-1', password: 'teach123' } });
  assert.ok(login.data.token, 'teacher login failed');
  const created = await api('/api/org/sessions', { method: 'POST', token: login.data.token, body: { lessonId: lesson.id, teacherId: forged.id, title: 'P81 teacher spoof guard' } });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal(created.data.teacherId, actual.id, 'teacherId spoof was not ignored');
  assert.notEqual(created.data.teacherId, forged.id, 'forged teacherId accepted');
} catch (error) {
  console.error(serverLog.slice(-2500));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log('P81 passed: classroom deep-link SSR, SearchSelect keyboard/ARIA, teacherId spoof API guard.');
fs.rmSync(ssrTemp, { recursive: true, force: true });
