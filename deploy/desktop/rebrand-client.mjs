#!/usr/bin/env node
/**
 * 把上游 deepseek-harness 的桌面端检出**改成我们的品牌**（2026-09-19）。
 *
 * 为什么是"构建期打补丁"而不是改上游源码再提交：我们维护的是**一份钉住版本的上游检出**，
 * 品牌只在这一层覆盖 —— 上游升级时重跑这个脚本即可，冲突一眼可见。
 * 与 `deploy/dsh-student/rebrand.mjs`（那份改的是 dsh 的 Web UI）同一套思路。
 *
 * ⚠️ 品牌合规（上游 BRAND_GUIDELINES.zh.md，2026-09-19 读过）：
 *   · MIT 允许再分发与换牌；描述性文字可以写「基于 DeepSeek Harness 构建」；
 *   · 但**项目名里不能用 "DeepSeek Harness" 全称**（是注册商标），建议用缩写 DSH；
 *   · 不得让人误以为有官方背书。所以这里把所有对外可见的名字换成我们的，
 *     并在 About/关于里保留一句"基于 DSH 构建"的如实说明（见 SHOW_ATTRIBUTION）。
 *
 * 用法（在检出根目录跑）：
 *   node <我们的仓库>/deploy/desktop/rebrand-client.mjs --checkout <上游检出目录>
 *   # 只预览不改：追加 --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] || fallback) : fallback;
}
const dryRun = process.argv.includes('--dry-run');
const checkout = path.resolve(arg('--checkout', '.'));
if (!fs.existsSync(path.join(checkout, 'apps/desktop/package.json'))) {
  throw new Error(`这不像上游检出（缺 apps/desktop/package.json）：${checkout}`);
}

// ── 我们的品牌 ────────────────────────────────────────────────────────────
const BRAND = {
  // 产品名：Windows 程序名 / 安装目录 / 开始菜单 / 卸载项都用它。
  // ⚠️ 不能用 "DeepSeek Harness"（上游商标），也不能暗示官方背书。
  productName: '灵动ai创作客户端',
  // 安装包文件名（Latin，避免中文文件名在某些分发/更新通道上出问题）
  artifactName: 'lingdong-client-${version}-${os}-${arch}.${ext}',
  // 外壳文案里出现的名字（英文界面用这个）
  productNameEn: 'LingdongAI Studio',
  // 如实说明（上游要求：可以说明关系，但不能暗示背书）
  attribution: '基于 DSH（DeepSeek Harness）构建',
};
const LEGACY_NAMES = ['DeepSeek Harness'];

const changes = [];
const edit = (file, transform) => {
  const full = path.join(checkout, file);
  if (!fs.existsSync(full)) { changes.push([file, '缺失，跳过']); return; }
  const before = fs.readFileSync(full, 'utf8');
  const after = transform(before);
  if (after === before) { changes.push([file, '无变化']); return; }
  if (!dryRun) fs.writeFileSync(full, after);
  changes.push([file, `已改（${before.length} → ${after.length} 字节）`]);
};

// ① 打包身份：productName 与安装包文件名（这两处是硬编码在上游配置里的）
edit('apps/desktop/scripts/electron-builder-config.mjs', (text) => text
  .replace("productName: 'DeepSeek Harness'", `productName: '${BRAND.productName}'`)
  .replace("artifactName: 'deepseek-harness-${version}-${os}-${arch}.${ext}'", `artifactName: '${BRAND.artifactName}'`));

// ② Electron 主进程里的应用名（窗口/协议/单实例标识都读它）
edit('apps/desktop/src/main.ts', (text) => text
  .replace("applicationName: 'DeepSeek Harness'", `applicationName: '${BRAND.productName}'`));

// ③ 外壳文案（菜单、启动失败、更新提示…）：中英文各一份，直接换名字。
//    ⚠️ 只替换**展示名**，不动标识符（如 DSH_* 环境变量、包名）。
edit('apps/desktop/src/locale.ts', (text) => {
  let next = text;
  for (const legacy of LEGACY_NAMES) next = next.split(legacy).join(BRAND.productName);
  return next;
});

// ④ dsh 界面里的品牌串（**在源码里替换**，编译时进 bundle）。
//    与 `deploy/dsh-student/rebrand.mjs` 对 Linux 镜像做的事一样 —— 那一步只服务服务器上的学生环境，
//    客户端里的 dsh 是**另一棵树**（检出源码 → app.asar），所以这里要再来一遍，
//    否则学生打开客户端看到的第一屏还写着 "deepseek HARNESS"。
const UI_BRAND = '灵动ai';
const UI_ROOTS = ['packages', 'apps/desktop/renderer'];
const UI_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|jsx|html|webmanifest|json|css)$/u;
const UI_REPLACEMENTS = [['DeepSeek Harness', UI_BRAND], ['Deepseek Harness', UI_BRAND], ['deepseek harness', UI_BRAND]];
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'coverage', '.desktop-build']);

function walkSource(root, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walkSource(full, out); continue; }
    if (UI_EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

let uiChanged = 0;
let uiScanned = 0;
for (const root of UI_ROOTS) {
  for (const file of walkSource(path.join(checkout, root))) {
    uiScanned += 1;
    let source = '';
    try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!UI_REPLACEMENTS.some(([from]) => source.includes(from))) continue;
    let next = source;
    for (const [from, to] of UI_REPLACEMENTS) next = next.split(from).join(to);
    if (next === source) continue;
    if (!dryRun) fs.writeFileSync(file, next);
    uiChanged += 1;
  }
}
changes.push([`${UI_ROOTS.join(' + ')} 里的 dsh 界面品牌串`, `扫 ${uiScanned} 个文件，命中并替换 ${uiChanged} 个`]);

console.log(`检出：${checkout}${dryRun ? '（--dry-run，不写入）' : ''}`);
console.log(`品牌：${BRAND.productName}（英文 ${BRAND.productNameEn}）/ 安装包 ${BRAND.artifactName}`);
for (const [file, result] of changes) console.log(`  · ${file} —— ${result}`);
console.log('\n⚠️ 还要手工确认的两件（本脚本不动二进制资源）：');
console.log('   ① 图标：apps/desktop/resources/icon-windows.png（换我们的 1024×1024 PNG）');
console.log('   ② 安装器侧栏图：apps/desktop/installer/assets/brand*.png 与 uninstaller-sidebar.png');
console.log(`   ③ 关于/署名：请在 About 里保留一句「${BRAND.attribution}」`);
