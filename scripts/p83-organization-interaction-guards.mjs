import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(root, '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, 'p83-organizations-'));
const entry = path.join(temp, 'entry.jsx');
const outDir = path.join(temp, 'out');
const modulePath = path.join(root, 'apps/admin/src/pages/Organizations.jsx').split(path.sep).join('/');

fs.writeFileSync(entry, `
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Organizations } from ${JSON.stringify(modulePath)};
const api = { get: () => new Promise(() => {}), post: () => Promise.resolve({}), put: () => Promise.resolve({}) };
export const html = renderToStaticMarkup(<MemoryRouter><Organizations api={api} /></MemoryRouter>);
`);

await build({
  root,
  configFile: path.join(root, 'apps/admin/vite.config.mjs'),
  logLevel: 'silent',
  build: { ssr: entry, outDir, emptyOutDir: true, minify: false },
});
const bundle = fs.readdirSync(outDir).find((name) => name.endsWith('.js') || name.endsWith('.mjs'));
assert.ok(bundle, 'organization render guard did not produce a module');
const { html } = await import(pathToFileURL(path.join(outDir, bundle)).href);
assert.match(html, />创建机构<\/button>/, 'organization list must render a create button');
assert.doesNotMatch(html, /管理员初始密码|create-organization-title/, 'creation form must not render in the initial list view');

process.env.PLATFORM_DATA_DIR = path.join(temp, 'data');
process.env.PLATFORM_DB_PATH = path.join(temp, 'data', 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';
const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
const { row, q } = await import('../apps/server/src/lib.js');
const ctx = (pathname, method = 'GET', body = null) => ({
  pathname, method, body, search: new URLSearchParams(),
  req: { socket: { remoteAddress: '127.0.0.1' } },
  auth: { user: { id: 'root', login: 'root', role: 'SUPER_ADMIN', orgId: null, permissions: [] }, rawUser: { permissions: '[]' } },
});
const admin = (pathname, method, body) => handleAdmin(ctx('/api/admin' + pathname, method, body));
const rejects = (fn, code) => assert.rejects(fn, (error) => error.code === code, code);

const created = await admin('/organizations', 'POST', {
  name: 'P83 机构',
  contact: { name: '王老师', phone: '13800138000', email: 'teacher@example.com', contractNotes: '年度合作' },
  contractStartAt: '2026-09-01', contractExpiresAt: '2027-08-31',
  isTrial: true, teacherSeats: 12, studentSeats: 180,
  adminLogin: 'p83-admin', adminDisplayName: '机构管理员', adminPassword: 'secret123',
});
assert.equal(created.status, 'TRIAL');
assert.equal(created.teacherSeats, 12);
assert.equal(created.studentSeats, 180);
assert.deepEqual(created.contact, { name: '王老师', phone: '13800138000', email: 'teacher@example.com', contractNotes: '年度合作' });
assert.equal(row("SELECT display_name FROM users WHERE org_id=? AND role='ORG_ADMIN'", [created.id]).display_name, '机构管理员');

q('UPDATE organizations SET purchased_teacher_seats=4,base_teacher_seats=8 WHERE id=?', [created.id]);
const updated = await admin(`/organizations/${created.id}`, 'PUT', { teacherSeats: 15, studentSeats: 200 });
assert.equal(updated.teacherSeats, 15);
assert.equal(updated.baseTeacherSeats, 11);
assert.equal(updated.purchasedTeacherSeats, 4);
await rejects(() => admin(`/organizations/${created.id}`, 'PUT', { teacherSeats: 3 }), 'TEACHER_SEATS_BELOW_PURCHASED');
await rejects(() => admin(`/organizations/${created.id}`, 'PUT', { status: 'DISABLED' }), 'ORG_STATUS_ACTION_REQUIRED');

const source = fs.readFileSync(path.join(root, 'apps/admin/src/pages/Organizations.jsx'), 'utf8').split('export function Authorizations')[0];
assert.doesNotMatch(source, /window\.confirm/, 'organization actions must use accessible confirmation dialogs');
assert.match(source, /authorizations\?orgId=/, 'authorization next step must carry the created organization id');

console.log('P83 passed: create button without initial form, complete organization creation fields, unified capacity updates, status guard, accessible confirmations, authorization next step');
