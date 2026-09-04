import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const dbPath = path.join(root, `.tmp-p4-03-list-${Date.now()}.db`);
const port = 8893;
process.env.PLATFORM_DB_PATH = dbPath;
const { initDatabase } = await import('./packages/database/src/schema.js');
const { seedDatabase } = await import('./packages/database/src/seed.js');
initDatabase();
seedDatabase();
const child = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), DEPLOYMENT_MODE: 'internal-test', API_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (b) => { const text=b.toString(); output += text; console.log(text.trimEnd()); });
child.stderr.on('data', (b) => { const text=b.toString(); output += text; console.error(text.trimEnd()); });
const base = `http://127.0.0.1:${port}/api`;
async function waitForServer() { for (let i = 0; i < 40; i++) { try { const r = await fetch(base + '/meta/domain-states'); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error(`server did not start: ${output}`); }
async function call(method, route, token) { const response = await fetch(base + route, { method, headers: token ? { authorization: `Bearer ${token}` } : undefined }); const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; } return { status: response.status, data }; }
let passed = 0;
function ok(name, condition, value) { if (!condition) throw new Error(`FAIL ${name}: ${JSON.stringify(value)}`); passed++; console.log(`PASS ${name}`); }
try {
  await waitForServer();
  const login = await call('POST', '/auth/login');
  const loginResponse = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'root', password: 'admin123' }) });
  const loginData = await loginResponse.json();
  const token = loginData.data.token;
  ok('root login', loginResponse.status === 200 && loginData.success === true, loginData);

  const listCases = [
    { name: '平台用户', path: '/admin/platform-users', defaultSort: 'created', sortable: 'name', label: '用户' },
    { name: '平台作品', path: '/admin/works', defaultSort: 'featured', sortable: 'title', label: '作品' },
    { name: '操作审计', path: '/admin/audit-logs', defaultSort: 'created', label: '审计记录' },
    { name: '课程广场', path: '/admin/course-marketplace', defaultSort: 'status', label: '课程' },
    { name: '机构', path: '/admin/organizations', defaultSort: 'created', sortable: 'name', filter: 'status=ACTIVE&', filterCheck: (item) => item.status === 'ACTIVE', label: '机构' },
    { name: '课程', path: '/admin/course-series', defaultSort: 'manual', sortable: 'title', filter: 'status=PUBLISHED&visibility=ALL_ORGS&', filterCheck: (item) => item.status === 'PUBLISHED' && item.visibility === 'ALL_ORGS', label: '课包' },
    { name: '平台管理员', path: '/admin/platform-admins', defaultSort: 'created', sortable: 'name', filter: 'status=ACTIVE&', filterCheck: (item) => item.status === 'ACTIVE', label: '管理员' },
    { name: '通知', path: '/admin/inbox', defaultSort: 'created', sortable: 'title', filter: 'status=PUBLISHED&', filterCheck: (item) => item.status === 'PUBLISHED', label: '通知' },
    { name: '宣传物料', path: '/admin/materials', defaultSort: 'created', sortable: 'title', filter: 'status=ACTIVE&', filterCheck: (item) => item.status === 'ACTIVE', label: '物料' },
    { name: '账务', path: '/admin/billing/usage-records', defaultSort: 'created', sortable: 'credits', filter: 'status=SUCCESS&', filterCheck: (item) => item.status === 'SUCCESS', label: '记录' },
  ];

  for (const item of listCases) {
    const normal = await call('GET', `${item.path}?page=1&limit=2${item.sortable ? `&sort=${item.sortable}` : ''}`, token);
    ok(`${item.name}列表分页协议`, normal.status === 200 && normal.data.success && Array.isArray(normal.data.data.items) && Number.isInteger(normal.data.data.total) && normal.data.data.total >= normal.data.data.items.length && normal.data.data.page === 1 && normal.data.data.limit === 2 && Number.isInteger(normal.data.data.totalPages) && normal.data.data.totalPages === Math.max(1, Math.ceil(normal.data.data.total / 2)) && normal.data.data.sort === (item.sortable || item.defaultSort), normal);
    const fallback = await call('GET', `${item.path}?page=1&limit=2&sort=not-a-column`, token);
    ok(`${item.name}列表未知排序安全回落`, fallback.status === 200 && fallback.data.data.sort === item.defaultSort, fallback);
    const invalidPage = await call('GET', `${item.path}?page=0&limit=2`, token);
    ok(`${item.name}列表非法页码拒绝`, invalidPage.status === 400, invalidPage);
    const unauthorized = await call('GET', `${item.path}?page=1&limit=2`);
    ok(`${item.name}列表未登录拒绝`, unauthorized.status === 401, unauthorized);
    if (item.filter) {
      const filtered = await call('GET', `${item.path}?${item.filter}page=1&limit=20`, token);
      ok(`${item.name}列表状态筛选`, filtered.status === 200 && filtered.data.data.items.every(item.filterCheck), filtered);
    }
  }

  const billingInvalidDate = await call('GET', '/admin/billing/usage-records?startDate=01-01-2020', token);
  ok('账务列表非法开始日期拒绝', billingInvalidDate.status === 400, billingInvalidDate);
  const billingDateRange = await call('GET', '/admin/billing/usage-records?startDate=2020-01-01&endDate=2099-12-31&page=1&limit=20', token);
  ok('账务列表日期范围筛选', billingDateRange.status === 200 && Number.isInteger(billingDateRange.data.data.total), billingDateRange);
  const marketplaceStatusAlias = await call('GET', '/admin/course-marketplace?marketplaceStatus=NONE&page=1&limit=2', token);
  ok('课程广场状态参数别名', marketplaceStatusAlias.status === 200 && marketplaceStatusAlias.data.data.sort === 'status', marketplaceStatusAlias);
  console.log(`ALL PASS ${passed}`);
} finally {
  child.kill();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(dbPath + suffix, { force: true }); } catch {} }
}
