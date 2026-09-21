/**
 * 客户端更新配置守卫（平台仓，2026-09-20）。
 * 只验证平台侧清单读写、策略字段和后台入口，不启动生产服务。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { readClientUpdateManifest, updateClientUpdateManifest, applyStoredPolicy } from '../apps/server/src/services/clientUpdateManifest.js'

const root = process.cwd()
const checks = []
const check = (name, fn) => { fn(); checks.push(name); console.log(`✓ ${name}`) }
const dir = mkdtempSync(join(tmpdir(), 'p120-client-update-'))
const manifest = join(dir, 'manifest.json')
const env = { ...process.env, CLIENT_UPDATE_MANIFEST: manifest }

try {
  writeFileSync(manifest, JSON.stringify({
    version: '0.1.7',
    channel: 'stable',
    enabled: true,
    mandatory: false,
    minVersion: '',
    note: '旧说明',
    files: { 'win-x64': { name: 'lingdong-client-0.1.7-win-x64.exe', size: 123, sha256: 'a'.repeat(64) }, 'mac-arm64': null },
  }, null, 2))

  check('读取发布包身份', () => {
    const value = readClientUpdateManifest(env)
    assert.equal(value.version, '0.1.7')
    assert.equal(value.file.name, 'lingdong-client-0.1.7-win-x64.exe')
  })

  check('后台只改策略并保留安装包身份', () => {
    const value = updateClientUpdateManifest({ enabled: true, mandatory: true, minVersion: '0.1.6-alpha.2', note: '修复课堂工作区', channel: 'stable' }, env)
    assert.equal(value.mandatory, true)
    assert.equal(value.minVersion, '0.1.6-alpha.2')
    const raw = JSON.parse(readFileSync(manifest, 'utf8'))
    assert.equal(raw.files['win-x64'].sha256, 'a'.repeat(64))
    assert.equal(raw.note, '修复课堂工作区')
  })

  check('拒绝非法最低版本', () => {
    assert.throws(() => updateClientUpdateManifest({ minVersion: 'latest' }, env), /最低支持版本格式不正确/)
  })

  check('后台页面、路由和权限入口已接上', () => {
    const nav = readFileSync(join(root, 'apps/admin/src/shared.jsx'), 'utf8')
    const routes = readFileSync(join(root, 'apps/admin/src/main.jsx'), 'utf8')
    const permissions = readFileSync(join(root, 'apps/server/src/lib.js'), 'utf8')
    assert.match(nav, /to: '\/client-update'/)
    assert.match(routes, /ClientUpdate/)
    assert.match(permissions, /\/api\/admin\/client-update/)
  })

  check('写入是原子的：先写同目录临时文件再 rename（客户端随时在读，不能出现半截 JSON）', () => {
    const source = readFileSync(join(root, 'apps/server/src/services/clientUpdateManifest.js'), 'utf8')
    assert.match(source, /function writeAtomic\(path, text\)/)
    assert.match(source, /const tempPath = `\$\{path\}\.tmp-/)
    assert.match(source, /renameSync\(tempPath, path\)/)
    assert.match(source, /fsyncSync\(handle\)/)
    // 反向自检：把 rename 换掉之后，上面那两条必须不再成立（免得检测写法失效了还一路绿）
    const tampered = source.replace('renameSync(tempPath, path)', 'writeFileSync(path, text)')
    assert.ok(!/renameSync\(tempPath, path\)/.test(tampered), '反向自检没生效：替换没改到那段代码')
    assert.throws(() => { assert.match(tampered, /renameSync\(tempPath, path\)/) })
  })

  check('客户端契约要求的字段都落进了清单文件（它读的是这个静态文件，不是后台 API）', () => {
    updateClientUpdateManifest({ enabled: false, mandatory: true, minVersion: '0.1.6-alpha.2', note: '契约字段', channel: 'stable' }, env)
    const raw = JSON.parse(readFileSync(manifest, 'utf8'))
    for (const key of ['version', 'channel', 'enabled', 'mandatory', 'minVersion', 'note', 'updatedAt', 'files']) {
      assert.ok(key in raw, `清单缺字段 ${key}`)
    }
    assert.equal(raw.enabled, false)
    assert.equal(raw.mandatory, true)
    assert.equal(raw.minVersion, '0.1.6-alpha.2')
    assert.equal(raw.files['win-x64'].name, 'lingdong-client-0.1.7-win-x64.exe')
  })

  check('策略另存 + 清单被发布脚本整体覆盖后能复写回去（否则每次发客户端版本都会静默重置后台策略）', () => {
    updateClientUpdateManifest({ enabled: true, mandatory: true, minVersion: '0.1.6', note: '别丢', channel: 'beta' }, env)
    // 模拟客户端发布脚本：整体覆盖 manifest.json（只写身份字段）
    writeFileSync(manifest, JSON.stringify({
      version: '0.1.8', channel: 'stable', enabled: true, mandatory: false, minVersion: '',
      publishedAt: '2026-09-21T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z', note: '新版本已发布。',
      files: { 'win-x64': { name: 'lingdong-client-0.1.8-win-x64.exe', size: 999, sha256: 'b'.repeat(64) }, 'mac-arm64': null },
    }, null, 2))
    assert.equal(applyStoredPolicy(env).applied, true, '复写没有发生')
    const raw = JSON.parse(readFileSync(manifest, 'utf8'))
    assert.equal(raw.mandatory, true, '后台策略被覆盖丢了')
    assert.equal(raw.minVersion, '0.1.6')
    assert.equal(raw.note, '别丢')
    assert.equal(raw.channel, 'beta')
    assert.equal(raw.files['win-x64'].sha256, 'b'.repeat(64), '身份字段必须由发布脚本说了算')
    assert.equal(applyStoredPolicy(env).applied, false, '已经是目标状态时不该重复写')
  })

  // 原子写要有**可复跑的证据**：另起一个进程一边猛读一边解析，同时这边反复写 ——
  // 一次半截 JSON 都不许出现。（同一进程里 setInterval 没用：同步写循环把事件循环占死了，
  // 读的人一次都跑不到 —— 这条防空转是写完才发现的第一版毛病。）
  // ⚠️ Windows 上跳过：**rename 覆盖一个正被别的进程打开的文件**在 Windows 会 EPERM，
  //    而生产是 Linux（POSIX 下 rename 覆盖是原子的、读的人拿到旧 inode，不受影响）。
  //    机制本身已由上面那条源码断言钉住，这里是补充的行为证据。
  if (process.platform === 'win32') {
    console.log('· 跳过「并发写不断半截 JSON」：Windows 的文件锁会挡住 rename 覆盖（生产是 Linux）')
  } else {
    const readerCode = [
      'const { readFileSync } = require("node:fs");',
      'let reads = 0, bad = 0;',
      'const until = Date.now() + 1500;',
      'while (Date.now() < until) { try { JSON.parse(readFileSync(process.argv[1], "utf8")); reads += 1 } catch { bad += 1 } }',
      'console.log(JSON.stringify({ reads, bad }));',
    ].join('\n')
    const reader = spawn(process.execPath, ['-e', readerCode, manifest], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    reader.stdout.on('data', (chunk) => { output += chunk })
    await new Promise((resolve) => setTimeout(resolve, 150))
    for (let index = 0; index < 300; index += 1) updateClientUpdateManifest({ note: `连写 ${index}`, enabled: true, mandatory: false, minVersion: '', channel: 'stable' }, env)
    await new Promise((resolve) => reader.on('close', resolve))
    const result = JSON.parse(output || '{}')
    check(`并发读时没有读到半截 JSON（写了 300 次、另一进程读了 ${result.reads ?? 0} 次）`, () => {
      assert.ok((result.reads ?? 0) > 0, '读的人一次都没读到？这条断言等于空转')
      assert.equal(result.bad ?? 0, 0, `读到了 ${result.bad} 次半截 JSON`)
    })
  }

  console.log(JSON.stringify({ name: 'p120-client-update-config', pass: true, checks: checks.length }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}