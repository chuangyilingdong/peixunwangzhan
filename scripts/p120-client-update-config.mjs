/**
 * 客户端更新配置守卫（平台仓，2026-09-20）。
 * 只验证平台侧清单读写、策略字段和后台入口，不启动生产服务。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readClientUpdateManifest, updateClientUpdateManifest } from '../apps/server/src/services/clientUpdateManifest.js'

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

  console.log(JSON.stringify({ name: 'p120-client-update-config', pass: true, checks: checks.length }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}