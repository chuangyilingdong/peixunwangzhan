/**
 * P70 三端页面「真渲染」守卫（2026-09-13）
 *
 * 为什么需要它：2026-09-13 我把 `PlatformBilling` 里的 `filters.days` 误写成裸 `days`，
 * 渲染期直接 ReferenceError → **用户点「计费与模型」整页白屏**。
 * 而当时手里所有检查都拦不住这一类错：
 *   - 冒烟守卫打的是**接口**（p4-o11 之类），页面渲染根本不在覆盖范围里；
 *   - `vite build` 只做语法/打包检查，`days` 是合法标识符；
 *   - 服务端守卫全绿，也不影响前端白屏。
 * 所以补这一道：把三端页面用 react-dom/server 真渲染一遍，任何「渲染期抛错」
 * （未定义变量、空数据上 .map、坏 JSX 分支）立刻现形。
 * 已自证能拦住那个 bug：故意把 days 放回去 → `✗ PlatformBilling — days is not defined`。
 *
 * 两种渲染方式，合起来才有覆盖：
 *   ① 单页渲染：pages/ 与 components/ 下的独立组件（stub api，渲染 loading 首屏）；
 *   ② 整 App 渲染：三个 App 内**内联**的页面（org 绝大多数页面就写在内联的 App 里，
 *      不导出根本渲染不到）——假 session + MemoryRouter 逐个路由渲染；
 *      路由清单从各自 main.jsx 的 <Route path="..."> 解析，新增页面自动进覆盖。
 *      为此三个 main.jsx 都把 App 导出了（本来就该导，便于测试）。
 *
 * ⚠️ 两个实现坑（都踩过）：
 *   1. 临时入口必须放在**仓库内**：放 os.tmpdir() 里 rollup 解析不到 node_modules；
 *   2. 必须把 `react-dom/client` 换成空壳 —— main.jsx 在模块顶层就会 createRoot().render()。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const tempRoot = path.join(root, '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, 'p70-render-'));

const asModule = (rel) => JSON.stringify(path.join(root, rel).split(path.sep).join('/'));

// ① 独立页面 / 组件
const SCAN_DIRS = [
  ['admin', 'apps/admin/src/pages'],
  ['admin', 'apps/admin/src/components'],
  ['org', 'apps/org/src/pages'],
  ['website', 'apps/website/src/pages'],
];
const standalone = [];
for (const [app, dir] of SCAN_DIRS) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs).filter((item) => item.endsWith('.jsx')).sort()) {
    standalone.push({ name: `${app}/${name.replace(/\.jsx$/, '')}`, rel: `${dir}/${name}` });
  }
}

// ② 三个 App（内联页面靠它覆盖）
const APPS = [
  { name: 'admin', rel: 'apps/admin/src/main.jsx', basename: '/admin' },
  { name: 'org', rel: 'apps/org/src/main.jsx', basename: '/org' },
  { name: 'website', rel: 'apps/website/src/main.jsx', basename: '' },
];
const appMeta = APPS.map((app, index) => {
  const source = fs.readFileSync(path.join(root, app.rel), 'utf8');
  const routes = [...new Set([...source.matchAll(/<Route\s+path=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value) => value && value !== '*' && !value.includes(':')))];
  return { index, name: app.name, basename: app.basename, routes };
});

const entry = path.join(temp, 'entry.jsx');
const stub = path.join(temp, 'react-dom-client-stub.js');
const setup = path.join(temp, 'setup-stubs.js');
fs.writeFileSync(stub, "export const createRoot = () => ({ render() {}, unmount() {} });\nexport default { createRoot };\n");
// ⚠️ 全局桩必须单独成一个模块，并作为**第一个 import**：
//    ESM 的 import 会先于本模块的所有语句求值，写在 entry 顶部当语句执行根本来不及 ——
//    main.jsx 在模块顶层就调 createRoot(document.getElementById('root'))。
fs.writeFileSync(setup, [
  // 权限要给全：管理端路由是 <AdminPermissionGate>{element}</AdminPermissionGate>，
  // 不给权限的话页面元素根本不会被真正渲染 —— 那这一层覆盖就是假的（自证时发现的）。
  "const session = { token: 'render-guard', expiresAt: null, user: { id: 'u1', login: 'render-guard', displayName: '渲染守卫', role: 'SUPER_ADMIN', orgId: 'org1', status: 'ACTIVE', permissions: ['ADMIN_ANALYTICS', 'ADMIN_ORGANIZATIONS', 'ADMIN_COURSES', 'ADMIN_WORKS', 'ADMIN_BILLING', 'ADMIN_CONTENT', 'ADMIN_AUDIT'], privacy: {} }, organization: { id: 'org1', name: '渲染守卫机构' } };",
  'const store = {};',
  'for (const key of ["ai-kids-platform.session.v1.admin", "ai-kids-platform.session.v1.org", "ai-kids-platform.session.v1.student"]) store[key] = JSON.stringify(session);',
  "globalThis.localStorage = { getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = String(value); }, removeItem: (key) => { delete store[key]; }, clear: () => {}, key: () => null, length: 0 };",
  'globalThis.window = globalThis.window || {};',
  'globalThis.window.localStorage = globalThis.localStorage;',
  'globalThis.window.location = { pathname: "/admin/billing", href: "https://example.invalid/admin/billing", search: "", hash: "", origin: "https://example.invalid", assign() {}, replace() {} };',
  'globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });',
  'globalThis.window.addEventListener = () => {}; globalThis.window.removeEventListener = () => {};',
  'globalThis.window.requestAnimationFrame = (fn) => setTimeout(fn, 0); globalThis.window.cancelAnimationFrame = () => {};',
  'globalThis.window.getComputedStyle = () => ({ getPropertyValue: () => "" });',
  'globalThis.location = globalThis.window.location;',
  'globalThis.document = { getElementById: () => ({}), querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), addEventListener() {}, removeEventListener() {}, body: { style: {}, appendChild() {} }, documentElement: { style: {} }, title: "" };',
  // Node 24 里 navigator 是**只读 getter**，直接赋值会 TypeError —— 必须 defineProperty
  "Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'render-guard', language: 'zh-CN' }, configurable: true, writable: true });",
  'globalThis.__renderGuardSession = session;',
].join('\n') + '\n');

const lines = [
  `import ${JSON.stringify(setup.split(path.sep).join('/'))};`,
  "import { renderToString } from 'react-dom/server';",
  "import { MemoryRouter } from 'react-router-dom';",
];
standalone.forEach((item, index) => {
  lines.push(`import * as Standalone${index} from ${asModule(item.rel)};`);
  lines.push(`globalThis.__standalone${index} = Standalone${index};`);
});
appMeta.forEach((app, index) => {
  lines.push(`import { App as App${index} } from ${asModule(APPS[index].rel)};`);
  lines.push(`globalThis.__app${index} = App${index};`);
});
lines.push(
  'const stubApi = {',
  "  get: () => Promise.resolve({ items: [], data: {}, total: 0, totalPages: 1, summary: {} }),",
  "  post: () => Promise.resolve({}), put: () => Promise.resolve({}), patch: () => Promise.resolve({}), delete: () => Promise.resolve({}),",
  "  baseUrl: '/api',",
  '};',
  "const session = globalThis.__renderGuardSession;",
  'const results = [];',
  `const standaloneTargets = ${JSON.stringify(standalone.map((item, index) => ({ index, name: item.name })))};`,
  'for (const target of standaloneTargets) {',
  '  const mod = globalThis[`__standalone${target.index}`];',
  '  const Component = mod?.default || Object.values(mod || {}).find((value) => typeof value === "function" && /^[A-Z]/.test(value.name || ""));',
  '  if (!Component) { results.push({ name: target.name, ok: false, message: "没有导出可渲染的组件" }); continue; }',
  '  try {',
  '    renderToString(<MemoryRouter><Component api={stubApi} session={session} user={session.user} onLogout={() => {}} /></MemoryRouter>);',
  '    results.push({ name: target.name, ok: true });',
  '  } catch (error) { results.push({ name: target.name, ok: false, message: String(error?.message || error).slice(0, 300) }); }',
  '}',
  `const appTargets = ${JSON.stringify(appMeta)};`,
  'for (const app of appTargets) {',
  '  const App = globalThis[`__app${app.index}`];',
  '  for (const route of app.routes) {',
  '    const name = `${app.name}${route === "/" ? "" : route}`;',
  '    try {',
  '      renderToString(<MemoryRouter basename={app.basename || undefined} initialEntries={[(app.basename || "") + route]}><App api={stubApi} /></MemoryRouter>);',
  '      results.push({ name, ok: true });',
  '    } catch (error) { results.push({ name, ok: false, message: String(error?.message || error).slice(0, 300) }); }',
  '  }',
  '}',
  'console.log(JSON.stringify(results));',
  'process.exit(results.some((item) => !item.ok) ? 1 : 0);',
);
fs.writeFileSync(entry, lines.join('\n'));

const outDir = path.join(temp, 'out');
const { build } = await import('vite');
await build({
  root,
  configFile: path.join(root, 'apps/admin/vite.config.mjs'),
  logLevel: 'error',
  plugins: [{
    name: 'stub-react-dom-client',
    enforce: 'pre',
    resolveId(id) { return id === 'react-dom/client' ? stub : null; },
  }],
  build: { ssr: entry, outDir, emptyOutDir: true, minify: false, write: true },
});

const bundled = fs.readdirSync(outDir).find((name) => name.endsWith('.js') || name.endsWith('.mjs'));
if (!bundled) throw new Error(`SSR 构建没产出文件：${fs.readdirSync(outDir).join(', ')}`);

const run = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(outDir, bundled)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (value) => resolve({ value, out, err }));
});

let results = [];
try {
  const line = run.out.trim().split('\n').filter((item) => item.startsWith('[')).pop();
  results = JSON.parse(line);
} catch {
  console.error(run.err.slice(-2500) || run.out.slice(-2500));
  throw new Error('渲染进程没有输出可解析的结果');
}

const failed = results.filter((item) => !item.ok);
console.log(`三端页面渲染（含内联页面）：${results.length} 个，失败 ${failed.length} 个`);
for (const item of failed) console.log(`  ✗ ${item.name} — ${item.message}`);
console.log(JSON.stringify({ name: 'pages-render', pass: failed.length === 0, failures: failed.length, checked: results.length }, null, 2));
process.exit(failed.length ? 1 : 0);
