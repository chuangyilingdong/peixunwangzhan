import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

const DEFAULT_MANIFEST_PATH = '/srv/ai-kids-platform/downloads/manifest.json'
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
// 策略字段（后台可改）与文件身份字段（发布脚本写、后台只读）。两边的边界就是这份契约。
const POLICY_KEYS = ['enabled', 'mandatory', 'minVersion', 'note', 'channel']

function manifestPath(env = process.env) {
  const configured = String(env.CLIENT_UPDATE_MANIFEST || DEFAULT_MANIFEST_PATH).trim()
  if (!isAbsolute(configured)) throw new Error('CLIENT_UPDATE_MANIFEST must be an absolute path')
  return configured
}

/** 后台设置的策略落在清单**旁边**（同一个目录，同一套权限）——清单被发布脚本整体覆盖后还能复写回去。 */
function policyPath(env = process.env) {
  return `${manifestPath(env)}.policy.json`
}

/**
 * 原子写：先写同目录临时文件 → fsync → rename 覆盖。
 *
 * 客户端随时可能来读这份清单（它带 `?t=` 绕缓存），而契约明确要求「清单更新过程中不能出现半截 JSON」
 * —— 直接 writeFileSync 会出现「文件被截断到一半」的窗口。rename 在同一文件系统内是原子的，
 * 所以临时文件必须放在**同目录**（跨设备 rename 会退化成拷贝）。fsync 是防"rename 先落盘、
 * 内容还在页缓存里"导致崩溃后出现空文件。
 */
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = openSync(tempPath, 'w')
  try {
    writeSync(handle, text)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  try {
    renameSync(tempPath, path)
  } catch (error) {
    try { unlinkSync(tempPath) } catch { /* 临时文件没留下就算了 */ }
    throw error
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function readManifest(env = process.env) {
  const path = manifestPath(env)
  if (!existsSync(path)) return { path, exists: false, value: {} }
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { throw new Error(`客户端更新清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`) }
  return { path, exists: true, value: object(value) }
}

function stringValue(value, max, field) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  const text = value.trim()
  if (text.length > max) throw new Error(`${field} 最多 ${max} 个字符`)
  return text
}

function booleanValue(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error('布尔配置必须是 true 或 false')
  return value
}

export function readClientUpdateManifest(env = process.env) {
  const { path, exists, value } = readManifest(env)
  const files = object(value.files)
  const windows = object(files['win-x64'])
  return {
    exists,
    enabled: value.enabled !== false,
    version: typeof value.version === 'string' ? value.version : '',
    channel: typeof value.channel === 'string' ? value.channel : 'stable',
    mandatory: value.mandatory === true,
    minVersion: typeof value.minVersion === 'string' ? value.minVersion : '',
    note: typeof value.note === 'string' ? value.note : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : '',
    file: Object.keys(windows).length === 0 ? null : {
      name: typeof windows.name === 'string' ? windows.name : '',
      size: Number.isSafeInteger(windows.size) ? windows.size : 0,
      sha256: typeof windows.sha256 === 'string' ? windows.sha256 : '',
      url: typeof windows.url === 'string' ? windows.url : '',
    },
  }
}

/**
 * Update only release policy fields. Package identity remains owned by publish-client.sh.
 * @param {unknown} input - Admin form values.
 * @param {NodeJS.ProcessEnv} env - Server environment.
 * @returns {ReturnType<typeof readClientUpdateManifest>} Persisted public view.
 */
export function updateClientUpdateManifest(input, env = process.env) {
  const body = object(input)
  const current = readManifest(env)
  const value = object(current.value)
  const files = object(value.files)
  const windows = object(files['win-x64'])
  if (Object.keys(windows).length === 0 || typeof windows.name !== 'string' || windows.name === '') {
    throw new Error('当前没有已上传的 Windows 安装包，不能启用客户端更新')
  }

  const minVersion = stringValue(body.minVersion, 64, '最低支持版本')
  if (minVersion !== '' && !VERSION_PATTERN.test(minVersion)) throw new Error('最低支持版本格式不正确')
  const note = stringValue(body.note, 2000, '更新说明')
  const channel = stringValue(body.channel, 40, '更新通道') || 'stable'
  const policy = {
    enabled: booleanValue(body.enabled, value.enabled !== false),
    mandatory: booleanValue(body.mandatory, value.mandatory === true),
    minVersion,
    note,
    channel,
  }
  // 策略另存一份（清单旁边）：客户端发布新包时那条流水线是**整体覆盖** manifest.json 的，
  // 只写进清单的话，下一次发版会把后台刚配的策略静默重置成发布脚本里的默认值。
  writeAtomic(policyPath(env), `${JSON.stringify(policy, null, 2)}\n`)
  writeAtomic(current.path, `${JSON.stringify({ ...value, ...policy, updatedAt: new Date().toISOString() }, null, 2)}\n`)
  return readClientUpdateManifest(env)
}

/** 后台存过的策略（没有就返回 null —— 老部署或从没配过）。 */
export function readStoredPolicy(env = process.env) {
  const path = policyPath(env)
  if (!existsSync(path)) return null
  try {
    const parsed = object(JSON.parse(readFileSync(path, 'utf8')))
    return Object.fromEntries(POLICY_KEYS.filter((key) => key in parsed).map((key) => [key, parsed[key]]))
  } catch {
    return null
  }
}

/**
 * 把存过的策略复写回清单（服务启动时调一次）。
 *
 * 为什么需要：客户端发布流水线是整体覆盖 manifest.json 的（它只负责身份字段），
 * 覆盖之后后台配的 enabled/mandatory/minVersion 就没了 —— 不自动复写的话，
 * **每次发客户端版本都会静默重置后台策略**。这里只补差异，且任何失败都不该影响服务启动。
 * @returns {{applied: boolean, reason?: string}}
 */
export function applyStoredPolicy(env = process.env) {
  try {
    const policy = readStoredPolicy(env)
    if (!policy) return { applied: false, reason: '没有存过的策略' }
    const current = readManifest(env)
    if (!current.exists) return { applied: false, reason: '清单不存在' }
    const value = object(current.value)
    const changed = POLICY_KEYS.some((key) => key in policy && JSON.stringify(value[key]) !== JSON.stringify(policy[key]))
    if (!changed) return { applied: false, reason: '清单里的策略已是最新' }
    writeAtomic(current.path, `${JSON.stringify({ ...value, ...policy, updatedAt: new Date().toISOString() }, null, 2)}\n`)
    return { applied: true }
  } catch (error) {
    return { applied: false, reason: error instanceof Error ? error.message : String(error) }
  }
}