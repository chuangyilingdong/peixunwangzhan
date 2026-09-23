/**
 * P136 登录页的「演示账号」整块已删除（2026-09-23 用户口径）。
 *
 * 用户原话（配图1）：「演示账号这些全部删除」。图里是机构端登录页那一排：
 * 「机构管理员 org-admin / 授课教师 teacher-1」+ 每行一个「使用」按钮 —— 点一下就把
 * 登录名与口令填好。平台端登录页也有一排（平台超管 root）。
 *
 * 删掉的理由不是好不好看（守卫 p115 早就在官网那一侧写过同一条）：
 *   · 那几个口令是**明文写在前端包里**的 —— 打包出来的 .js 谁都能下载，等于把生产账号口令发给访客；
 *   · 而且它指的是**生产上真在用的账号**（seed 里那几个人就是线上账号），不是沙箱账号。
 * 官网那一侧早就传空数组了；这次把组件里的区块、prop、样式与两端的传参一起删干净。
 *
 * ⚠️ 这个守卫管的是**登录页那一排**，不是账号本身：
 *    seed 里那几个账号（root / org-admin / teacher-1）**照旧存在**，它们还要用来开发与跑守卫 ——
 *    所以下面同时钉住"口令仍然在 seed 里"，免得下一轮有人把这条误解成"删账号"。
 *    真观感由 `.tmp/then-login-no-demo.mjs` 在真浏览器里核（机构端/平台端登录页各截一张）。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// ⚠️ 判之前**必须去掉注释**：这一轮到处写着「这里原来有 demos / 演示账号…」的说明，
//    直接 grep 源码会把注释里的字样当成"功能还在"（p130 踩过同一个坑：那两个文件里恰好都写了说明）。
const readCode = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '').replace(/([^:'"])\/\/[^\n]*$/gm, '$1');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const ui = readCode('packages/shared/src/ui.jsx');
const sharedCss = read('packages/shared/src/styles.css');
const adminMain = readCode('apps/admin/src/main.jsx');
const adminShared = readCode('apps/admin/src/shared.jsx');
const orgMain = readCode('apps/org/src/main.jsx');
const siteMain = readCode('apps/website/src/main.jsx');

/* ── ① 组件里那一块没了（区块 / prop / 样式 三处一起）────────────── */
check('① LoginPanel 不再有 demos prop', !/function LoginPanel\(\{[^}]*demos/.test(ui), (ui.match(/function LoginPanel\([^)]*\)/) || [])[0] || '');
check('① 不再渲染「演示账号」区块（demo-list 那一段连同文案例句一起删掉）',
  !/demo-list/.test(ui) && !/演示账号/.test(ui));
check('① 登录框不再用演示账号预填（原来 useState(demos[0]?.login)）', !/demos\[0\]/.test(ui));
check('① 样式表里也不再有 .demo-list（留一段死样式，下一个人会以为还有这个功能）', !/\.demo-list/.test(sharedCss));

/* ── ② 三端都没人再传这一组数据进来 ─────────────────────────────── */
check('② 平台端：不再导入/传 demos', !/\bdemos\b/.test(adminMain));
check('② 平台端：shared.jsx 里不再导出那组口令', !/export const demos/.test(adminShared));
check('② 机构端：不再定义/传 demos', !/\bdemos\b/.test(orgMain));
check('② 官网：仍然传空（本来就是空的，历史口径）', /LoginPanel[^>]*demos=\{\[\]\}/.test(siteMain) === false && !/demos=/.test(siteMain),
  '官网原来写的是 demos={[]}，现在连这个 prop 都不该再出现');

/* ── ③ 三个口令不再出现在任何前端源码里 ─────────────────────────── */
const frontendFiles = [
  ['平台端', ['apps/admin/src/main.jsx', 'apps/admin/src/shared.jsx']],
  ['机构端', ['apps/org/src/main.jsx']],
  ['官网', ['apps/website/src/main.jsx']],
];
for (const [name, files] of frontendFiles) {
  const text = files.map(readCode).join('\n');
  const hits = ['admin123', 'org123', 'teach123'].filter((secret) => text.includes(secret));
  check(`③ ${name}前端源码里没有明文口令`, hits.length === 0, hits.join(','));
}

/* ── ④ 反向：账号本身还在（这条是"删登录页那一排"、不是"删账号"）──── */
const seed = read('packages/database/src/seed.js');
check('④ 账号与口径没被误删：seed 里仍然建 root / org-admin / teacher-1（开发与其它守卫要用）',
  /login: 'root'/.test(seed) && /login: 'org-admin'/.test(seed) && /login: 'teacher-1'/.test(seed));

/* ── ⑤ 官网那一侧的既有断言仍在（别把这条口径只留半边）──────────── */
const p115 = read('scripts/p115-website-ui-check.mjs');
check('⑤ 官网登录页那条浏览器断言仍在（p115：出现「演示账号」区块即失败）',
  /demoList/.test(p115) && /不应带演示账号/.test(p115));

console.log('');
if (failures) { console.log(`✗ p136 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p136 登录页演示账号已删除：全部通过');
