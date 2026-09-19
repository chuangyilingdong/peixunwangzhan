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
import { fileURLToPath } from 'node:url';

/** 本脚本所在目录（deploy/desktop）：⑤ 的图标源与 apply-client-gate.mjs 共用 client-patch/。 */
const here = path.dirname(fileURLToPath(import.meta.url));

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
/** 整份覆盖（用于"上游那份是矢量稿、字符串替换一处也改不到"的文件）。 */
const overwrite = (file, content) => {
  const full = path.join(checkout, file);
  if (!fs.existsSync(full)) { changes.push([file, '缺失，跳过']); return; }
  if (fs.readFileSync(full, 'utf8') === content) { changes.push([file, '已是我们的牌（跳过）']); return; }
  if (!dryRun) fs.writeFileSync(full, content);
  changes.push([file, `整份换掉（${content.length} 字节）`]);
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

// ⑤ 应用图标：把 gate/ 里那张 1024×1024 铺到上游的三个图标位。
//    ⚠️ 这一步以前是**手工复制**的（脚本末尾只留了一句提示），实测漏过一次 ——
//       安装包里的图标与登录页/官网不是同一张图，很难发现，所以改成脚本自动铺。
//    `macos` 那份上游本来就与 Windows 同图（历史遗留），这里保持一致。
const iconSource = path.join(here, 'client-patch', 'gate', 'app-icon-1024.png');
for (const name of ['icon-windows.png', 'icon-macos.png', 'icon.png']) {
  const full = path.join(checkout, 'apps/desktop/resources', name);
  if (!fs.existsSync(path.dirname(full))) { changes.push([`resources/${name}`, '目录不存在，跳过']); continue; }
  const before = fs.existsSync(full) ? fs.readFileSync(full) : null;
  const after = fs.readFileSync(iconSource);
  if (before !== null && before.equals(after)) { changes.push([`resources/${name}`, '已是我们的图标（跳过）']); continue; }
  if (!dryRun) fs.writeFileSync(full, after);
  changes.push([`resources/${name}`, `已换成灵动ai图标（${after.length} 字节）`]);
}

// ⑥ dsh 界面里的字标：**字符串替换改不动** —— 上游那幅字标是矢量稿，
//    "deepseek" 那几个字母是 SVG path 而不是文本节点（上一轮就是卡在这：扫了 4470 个文件、
//    命中 150 个，学生打开客户端看到的还是上游字标）。所以直接换"字标产地"：
//      · web/boot-page.ts —— 启动页（framework-free，dsh 起来前第一眼看到的那屏）；
//      · ui-brand-official/Brand.tsx —— 侧栏品牌位（mark + name 两个 slot 的占用者）；
//      · locale 里的 `brand.localBuild` —— 非 official 构建时侧栏回退显示的那个名字。
//    ⚠️ 侧栏显示哪套由 `DSH_CLIENT_BUILD_PROFILE` 决定（见 ui-brand-official/README）：
//      official → Brand.tsx 那两个组件；其它取值 → 回退成 `brand.localBuild` 这个名字。
//      两条路都要是我们的牌，所以两边都换 —— 只换一边的话换个构建档就露馅。
const UI_WORDMARK = '灵动ai';
edit('packages/client/web/src/boot-page.ts', (text) =>
  text.replace("div(css.wordmark, 'HARNESS')", `div(css.wordmark, '${UI_WORDMARK}')`));
edit('packages/client/locale/src/locales/zh.ts', (text) =>
  text.replace("'brand.localBuild': 'DSH 本地构建',", `'brand.localBuild': '${UI_WORDMARK}',`));
edit('packages/client/locale/src/locales/en.ts', (text) =>
  text.replace("'brand.localBuild': 'DSH Local Build',", "'brand.localBuild': 'LingdongAI',"));
overwrite('packages/client/ui-brand-official/src/client/Brand.tsx', `/**
 * 灵动ai 的品牌位（2026-09-19 起由本仓库的 deploy/desktop/rebrand-client.mjs 整份覆盖）。
 *
 * 为什么整份换掉：上游这份字标是**矢量稿** —— "deepseek" 那几个字母是 SVG path，
 * 不是文本节点，所以 \`DeepSeek Harness → 灵动ai\` 那种字符串替换一处也改不到。
 * 这里保持同名同签名，只换实现：调用方（同包 index.ts 的 slot 注册）一行都不用改。
 */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * 侧栏品牌图标：红底圆角方 + 橙色 Ai（与登录页、应用图标同一支红）。
 * 用内联 SVG 而不是图片资源：客户端里没有现成的静态资源目录可挂，且这个尺寸下
 * 矢量比位图稳。
 * @param props - 宿主给的尺寸（正方形，px）
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <svg width={size} height={size} viewBox='0 0 32 32' aria-hidden='true' role='presentation'>
      <rect width='32' height='32' rx='9' fill='#7e1123' />
      <text x='16' y='22' textAnchor='middle' fontFamily='system-ui, sans-serif' fontSize='13' fontWeight='700' fill='#ff8a00'>Ai</text>
    </svg>
  )
}

/**
 * 侧栏品牌名：我们的字标。中文字用 \`currentColor\` 跟着侧栏主题走（深色底上是白字），
 * 只有 \`ai\` 用品牌橙 —— 侧栏有深/浅两套主题，写死蓝色会在深色底上糊成一片。
 */
export function OfficialBrandName() {
  return (
    <span style={{ fontWeight: 800, letterSpacing: '-.02em' }}>
      灵动<span style={{ color: '#ff8a00' }}>ai</span>
    </span>
  )
}
`);

// ⑥b 窗口标题与 PWA 名：dsh 的**官方构建档**把标题钉在一个常量里，而且构建会**断言**这个值
//     （`assertClientBuildEnvironment`），所以不能只在生成时传环境变量 —— 必须改常量本身，
//     两处一起改（常量 + 断言里那份期望），否则下一次构建直接报错。
//     实测：不改的话客户端窗口标题栏写着 "DeepSeek Harness"（品牌合规也不允许用全称）。
edit('scripts/client-build-environment.ts', (text) =>
  text.replace("  DSH_CLIENT_TITLE: 'DeepSeek Harness',", `  DSH_CLIENT_TITLE: '${BRAND.productName}',`));
edit('scripts/client-build-environment.client.spec.ts', (text) =>
  text.split("DSH_CLIENT_TITLE: 'DeepSeek Harness'").join(`DSH_CLIENT_TITLE: '${BRAND.productName}'`));
edit('apps/web/vite.config.ts', (text) =>
  text.replace("const DEFAULT_CLIENT_TITLE = 'DSH Local Build'", `const DEFAULT_CLIENT_TITLE = '${BRAND.productName}'`));
edit('apps/web/public/manifest.webmanifest', (text) => text
  .replace('"name": "DeepSeek Harness"', `"name": "${BRAND.productName}"`)
  .replace('"short_name": "DSH"', '"short_name": "灵动ai"'));

console.log(`检出：${checkout}${dryRun ? '（--dry-run，不写入）' : ''}`);
console.log(`品牌：${BRAND.productName}（英文 ${BRAND.productNameEn}）/ 安装包 ${BRAND.artifactName}`);
for (const [file, result] of changes) console.log(`  · ${file} —— ${result}`);
console.log('\n⚠️ 还要手工确认的：');
console.log('   ① 关于/署名：请在 About 里保留一句「' + BRAND.attribution + '」');
console.log('   ② 安装器侧栏图：apps/desktop/installer/assets/brand*.png 与 uninstaller-sidebar.png（本脚本不动安装器资源）');
