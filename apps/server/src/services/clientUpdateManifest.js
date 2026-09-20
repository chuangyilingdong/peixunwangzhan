import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

const DEFAULT_MANIFEST_PATH = '/srv/ai-kids-platform/downloads/manifest.json'
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function manifestPath(env = process.env) {
  const configured = String(env.CLIENT_UPDATE_MANIFEST || DEFAULT_MANIFEST_PATH).trim()
  if (!isAbsolute(configured)) throw new Error('CLIENT_UPDATE_MANIFEST must be an absolute path')
  return configured
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
  const next = {
    ...value,
    enabled: booleanValue(body.enabled, value.enabled !== false),
    mandatory: booleanValue(body.mandatory, value.mandatory === true),
    minVersion,
    note,
    channel,
    updatedAt: new Date().toISOString(),
  }
  const path = current.path
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return readClientUpdateManifest(env)
}