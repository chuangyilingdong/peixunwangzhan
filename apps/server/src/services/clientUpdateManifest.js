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
 * 安装包落哪个目录：**清单的同目录**（生产 = /srv/ai-kids-platform/downloads/，nginx 的 `/downloads/` 就是它）。
 * 不另配一个目录 —— 清单里写的文件名和 `publish-client.sh` 放的、以及后台传的，必须是同一处，
 * 否则会出现"清单说 377MB 的新包，下载口给的还是上一版"这种最难查的不一致。
 */
export function clientUpdateDir(env = process.env) {
  return dirname(manifestPath(env))
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

/**
 * 平台键：与客户端 `LingdongUpdater.updateTarget()` 认的两个目标一致。
 * ⚠️ 2026-09-28 客户端团队口径：**双端必须同版本发布**（客户端读的是清单顶层的 `version`，
 *    只抬 Mac 的版本会让老 Windows 客户端以为有新版本、下下来还是旧的，来回更新不上去）。
 *    将来若改成每平台独立版本，客户端读的是 `files[target].version ?? manifest.version`。
 */
export const CLIENT_PLATFORMS = ['win-x64', 'mac-arm64']

/** 文件名里那个版本（清单顶层 `version` 是"这次发布的版本"；两者不一致 = 这个平台的文件是旧的）。 */
function installerVersion(name) {
  try { return parseClientInstallerName(name).version } catch { return '' }
}

/** 把清单里一个平台条目读成视图；没有 / 没名字 → null。 */
function fileView(entry) {
  const item = object(entry)
  const name = typeof item.name === 'string' ? item.name : ''
  if (!name) return null
  return {
    name,
    size: Number.isSafeInteger(item.size) ? item.size : 0,
    sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
    url: typeof item.url === 'string' ? item.url : '',
    version: installerVersion(name),
  }
}

export function readClientUpdateManifest(env = process.env) {
  const { path, exists, value } = readManifest(env)
  const files = object(value.files)
  const version = typeof value.version === 'string' ? value.version : ''
  const platforms = Object.fromEntries(CLIENT_PLATFORMS.map((key) => [key, fileView(files[key])]))
  return {
    exists,
    enabled: value.enabled !== false,
    version,
    channel: typeof value.channel === 'string' ? value.channel : 'stable',
    mandatory: value.mandatory === true,
    minVersion: typeof value.minVersion === 'string' ? value.minVersion : '',
    note: typeof value.note === 'string' ? value.note : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : '',
    // ⚠️ 保留 `file`（= Windows 那一条）：后台与既有调用方读的是它，Windows 自动更新的身份也在里面。
    file: platforms['win-x64'],
    // 两个平台都给（后台「客户端更新」页要同时展示 Win / Mac 的文件名、大小、SHA256）。
    files: platforms,
    /**
     * 「声明了新版、但这个平台的文件还是旧的」的平台列表（拿文件名里的版本与顶层 version 比）。
     * ⚠️ 非空就是危险状态：Windows 客户端会看到新版本 → 下到的还是旧包 → 装完还是旧的 → 反复提示更新。
     * 所以发布时**两个平台要一起发**（客户端仓 `deploy/desktop/publish-client.sh <win> <mac>` 一次写两条）。
     */
    stale: CLIENT_PLATFORMS.filter((key) => {
      const view = platforms[key]
      return Boolean(view && view.version && version && view.version !== version)
    }),
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

/**
 * 安装包文件名 → `{ version, platform }`。
 *
 * ⚠️ 文件名是**客户端硬校验的**（`LingdongUpdater.ts` 要求恰好
 * `lingdong-client-${version}-win-x64.exe`，还对 sha256 长度与字节数做比对），
 * 所以这里不是"随便取个后缀"，而是把客户端的契约在**上传入口**先拦一道：
 * 名字不合规的包就算传上来，客户端也永远更新不过去。
 * Mac 包客户端目前**不参与自动更新**（updater 只认 win32+x64），但官网下载页要能列出它。
 */
const INSTALLER_NAME = /^lingdong-client-(.+)-(win-x64\.exe|mac-arm64\.dmg)$/

export function parseClientInstallerName(fileName) {
  const name = String(fileName || '').trim()
  const match = INSTALLER_NAME.exec(name)
  if (!match) throw new Error('安装包文件名必须是 lingdong-client-<版本>-win-x64.exe 或 lingdong-client-<版本>-mac-arm64.dmg')
  const version = match[1]
  if (!VERSION_PATTERN.test(version)) throw new Error(`版本号格式不正确：${version}`)
  return { version, platform: match[2] === 'win-x64.exe' ? 'win-x64' : 'mac-arm64' }
}

/**
 * 发布一个**刚上传的安装包**：写清单里的身份字段（版本/文件名/字节数/sha256），
 * 并把后台配过的策略字段一起带上（否则这一写会把 enabled/mandatory/minVersion 抹掉）。
 *
 * ⚠️ 身份字段的所有权在这里与 `publish-client.sh` 是**同一份**（谁最后发布谁说了算），
 * 而清单里**别的平台**的条目（比如这次发 win、上次发过 mac）要原样留着。
 */
export function publishClientInstaller({ fileName, size, sha256, env = process.env, now = new Date() } = {}) {
  const { version, platform } = parseClientInstallerName(fileName)
  if (!Number.isSafeInteger(Number(size)) || Number(size) <= 0) throw new Error('安装包字节数不合法')
  const digest = String(sha256 || '')
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('安装包 sha256 不合法')
  const current = readManifest(env)
  const value = object(current.value)
  const files = object(value.files)
  const stamp = now.toISOString()
  const next = {
    ...value,
    version,
    channel: typeof value.channel === 'string' && value.channel ? value.channel : 'stable',
    publishedAt: stamp,
    updatedAt: stamp,
    files: {
      ...files,
      // ⚠️ 条目里**带上这个平台自己的版本**（客户端读 `files[target].version ?? manifest.version`，
      //    客户端团队 2026-09-28 给的形状）。今天两端同版本，它是冗余的；但一旦哪天只发了一个平台，
      //    另一个平台的老客户端比的是**自己那条**版本 → 不会被顶层 version 误判成"有新版本"。
      //    ⚠️ 别的平台的条目照旧一个字节都不动（没写过 version 的老条目就让它缺着，客户端会回落顶层）。
      [platform]: { name: String(fileName), size: Number(size), sha256: digest, version },
    },
  }
  // 策略字段以"后台存过的那份"为准（客户端的发布脚本也是这个口径，见 applyStoredPolicy）
  const policy = readStoredPolicy(env)
  if (policy) for (const key of POLICY_KEYS) if (key in policy) next[key] = policy[key]
  writeAtomic(current.path, `${JSON.stringify(next, null, 2)}\n`)
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