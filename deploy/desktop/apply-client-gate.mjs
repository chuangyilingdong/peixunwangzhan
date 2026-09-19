#!/usr/bin/env node
/**
 * 把「灵动ai 登录门 + 只走我们网关」接进上游 deepseek-harness 的桌面端检出（2026-09-19）。
 *
 * 为什么是构建期打补丁：我们维护的是**一份钉住版本的上游检出**，改动集中在少数几处，
 * 上游升级时重跑这个脚本即可，冲突一眼可见。与 `deploy/dsh-student/rebrand.mjs` 同一套思路。
 *
 * 改了五处（都能在执行输出里看到是否命中）：
 *   ① apps/desktop/resources/gate/ ← 我们的三个页面 + 补丁层 YAML（随包分发）
 *   ② apps/desktop/src/platform-gate.ts ← 登录门主进程逻辑（新文件）
 *   ③ apps/desktop/src/preload-app.ts ← 暴露 window.lingdong.gate（登录/刷新/退出）
 *   ④ apps/desktop/src/main.ts ← 在 `reconcileBackend()` **之前**插登录门
 *   ⑤ apps/desktop/scripts/electron-builder-config.mjs ← 把 gate/ 打进 extraResources
 *   ⑥ apps/desktop-host/src/index.ts ← `patchFiles` 挂上我们的补丁层
 *      （⚠️ 桌面宿主显式传的是空数组，所以 profile 里的 cordis.patch.yml 永远不会被读 ——
 *        根因见 platform-gate.ts 文件头）
 *
 * 用法：node deploy/desktop/apply-client-gate.mjs --checkout .tmp/dsh-harness [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, 'client-patch')
function arg(name, fallback = '') {
  const index = process.argv.indexOf(name)
  return index >= 0 ? (process.argv[index + 1] || fallback) : fallback
}
const dryRun = process.argv.includes('--dry-run')
const checkout = resolve(arg('--checkout', '.'))
if (!existsSync(join(checkout, 'apps/desktop/package.json'))) throw new Error(`这不像上游检出：${checkout}`)

const report = []
const write = (file, text) => { if (!dryRun) writeFileSync(join(checkout, file), text); }
/** 精确替换；命中 0 次或已改过都要看得见（上游升级后锚点可能漂）。
 *  ⚠️ `marker` 是**这条补丁的特征串**，用来判断是否已打过 —— 不能用"文件里有灵动ai"这种松散判断：
 *     加新补丁时会被误判成"已打过"而整个跳过（踩过）。 */
const patch = (file, anchor, replacement, note, marker = replacement.slice(0, 60)) => {
  const full = join(checkout, file)
  if (!existsSync(full)) { report.push(`!! ${file}：文件不存在`); return }
  const before = readFileSync(full, 'utf8')
  if (before.includes(marker)) {
    report.push(`·  ${file}：已打过（跳过）`)
    return
  }
  if (!before.includes(anchor)) { report.push(`!! ${file}：锚点没找到 —— ${note}`); return }
  write(file, before.replace(anchor, replacement))
  report.push(`✓  ${file}：${note}`)
}

// ① 随包分发的页面与补丁层
const gateSource = join(patchDir, 'gate')
const gateTarget = join(checkout, 'apps/desktop/resources/gate')
if (!dryRun) {
  mkdirSync(gateTarget, { recursive: true })
  for (const name of readdirSync(gateSource)) copyFileSync(join(gateSource, name), join(gateTarget, name))
  copyFileSync(join(patchDir, 'lingdong.patch.yml'), join(gateTarget, 'lingdong.patch.yml'))
}
report.push(`✓  apps/desktop/resources/gate/：${dryRun ? '（--dry-run 未写入）' : readdirSync(gateTarget).join(' ')}`)

// ② 登录门主进程模块
if (!dryRun) mkdirSync(join(checkout, 'apps/desktop/src'), { recursive: true })
if (!dryRun) copyFileSync(join(patchDir, 'platform-gate.ts'), join(checkout, 'apps/desktop/src/platform-gate.ts'))
report.push('✓  apps/desktop/src/platform-gate.ts：已放入')

// ③ preload：给页面一个 lingdong.gate()
patch('apps/desktop/src/preload-app.ts',
  "contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' ? product : { protocolVersion: 1 })",
  `contextBridge.exposeInMainWorld('dshDesktop', location.protocol === \`\${SCHEME}:\` && location.hostname === 'app' ? product : { protocolVersion: 1 })
// 灵动ai 登录门：登录 / 刷新 / 退出（主进程侧见 src/platform-gate.ts）
contextBridge.exposeInMainWorld('lingdong', {
  gate: (payload: unknown) => ipcRenderer.invoke('lingdong:gate', payload) as Promise<{ ok: boolean; message?: string }>,
})`,
  '暴露 window.lingdong.gate')

// ④ main.ts：在启动后端之前过登录门 + 注册深链协议
// 先去重：早期版本只插过 `import { runLingdongGate }`，加 deepLink 后会与新的那条并存（踩过）
const mainFile = join(checkout, 'apps/desktop/src/main.ts')
if (existsSync(mainFile)) {
  const stale = "import { runLingdongGate } from './platform-gate.ts'\n"
  const current = readFileSync(mainFile, 'utf8')
  if (current.includes(stale)) {
    write('apps/desktop/src/main.ts', current.replace(stale, ''))
    report.push('✓  apps/desktop/src/main.ts：清掉重复的旧 import')
  }
}
patch('apps/desktop/src/main.ts',
  "import { fileURLToPath } from 'node:url'",
  "import { fileURLToPath } from 'node:url'\nimport { lingdongDeepLink, runLingdongGate } from './platform-gate.ts'",
  '引入登录门模块', 'lingdongDeepLink, runLingdongGate')
patch('apps/desktop/src/main.ts',
  '  automaticCheck()\n  await reconcileBackend().catch(() => undefined)',
  `  automaticCheck()
  // 灵动ai 登录门：没有我们的账号、或这节课还没开始上课，就**不启动**创作环境。
  // 学生登录后这里会向平台要这节课的运行时密钥与预设提示词（见 src/platform-gate.ts 文件头）。
  if ((await runLingdongGate(createMainWindow, isQuitting)).kind === 'quit') { app.quit(); return }
  await reconcileBackend().catch(() => undefined)`,
  '在 reconcileBackend 之前插登录门', 'if ((await runLingdongGate(createMainWindow, isQuitting))')
// 深链协议：安装器写进注册表，系统才知道怎么用 lingdong:// 拉起本客户端。
// ⚠️ 单独一条、挂在 automaticCheck() 上 —— 挂在上面那个锚点上的话，登录门一插好锚点就没了。
patch('apps/desktop/src/main.ts',
  '  automaticCheck()\n',
  `  automaticCheck()
  // 深链协议（2026-09-19）：官网点「打开客户端」→ 系统拉起 lingdong://open → second-instance
  // → focusPrimaryWindow() 里调 lingdongDeepLink()，让「等老师开始上课」那一页立刻重问一次。
  app.setAsDefaultProtocolClient('lingdong')
`,
  '注册 lingdong://（main）', "setAsDefaultProtocolClient('lingdong')")
patch('apps/desktop/src/main.ts',
  '  focusPrimaryWindow = () => {\n    if (quitting) return\n',
  '  focusPrimaryWindow = () => {\n    if (quitting) return\n    // 深链/第二次启动都走到这里：让等待页立刻重问一次「现在有没有课」\n    lingdongDeepLink()\n',
  '深链落到 focusPrimaryWindow', '深链/第二次启动都走到这里')

// ④b 打包：注册 lingdong:// 协议（安装器写进注册表，系统才知道怎么拉起客户端）
patch('apps/desktop/scripts/electron-builder-config.mjs',
  '    ],\n    mac: {',
  `    ],
    // 深链协议：官网「打开客户端」链接用 lingdong://open 拉起本客户端
    protocols: [{ name: '灵动ai创作客户端', schemes: ['lingdong'] }],
    mac: {`,
  '注册 lingdong:// 协议', 'protocols: [{ name: ')

// ⑤ 打包：把 gate/ 打进 extraResources
patch('apps/desktop/scripts/electron-builder-config.mjs',
  "      { from: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)), to: 'icon.png' },",
  `      { from: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)), to: 'icon.png' },
      // 灵动ai 登录门的页面与补丁层（运行时从 process.resourcesPath/gate 读）
      { from: fileURLToPath(new URL('../resources/gate', import.meta.url)), to: 'gate' },`,
  'gate/ 进 extraResources')

// ⑥ 桌面宿主：patchFiles 挂上我们的补丁层
patch('apps/desktop-host/src/index.ts',
  "import { delimiter, join } from 'node:path'",
  "import { existsSync } from 'node:fs'\nimport { delimiter, join } from 'node:path'",
  '引入 existsSync')
patch('apps/desktop-host/src/index.ts',
  '    patchFiles: [],',
  `    patchFiles: ((): string[] => {
      // 灵动ai：随客户端分发的补丁层（模型调用只走我们自己的网关）。登录门在拿到运行时密钥后
      // 把它写到 $DSH_HOME/lingdong.patch.yml；这里只在文件存在时挂上。
      // ⚠️ 不能改成"让 profile 的 cordis.patch.yml 生效"：那是空数组与 undefined 的区别，
      //    见 src/platform-gate.ts 文件头（initialProfile?.patches ?? loadOptionalPatches(...)）。
      const lingdong = join(resolveDshHome(), 'lingdong.patch.yml')
      return existsSync(lingdong) ? [lingdong] : []
    })(),`,
  'patchFiles 挂上 lingdong.patch.yml')

console.log(`检出：${checkout}${dryRun ? '（--dry-run）' : ''}`)
for (const line of report) console.log('  ' + line)
const failed = report.filter((line) => line.startsWith('!!'))
console.log(failed.length ? `\n!! ${failed.length} 处需要人工看一眼（多半是上游漂了）` : '\n登录门已接入。')
