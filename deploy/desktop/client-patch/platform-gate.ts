import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'

/**
 * 灵动ai 创作客户端的「登录门」（2026-09-19）。
 *
 * 三件事，都必须在 **dsh 启动之前** 完成：
 *   ① 让学生用**我们的账号密码**登录 —— dsh 自己没有用户体系（只有一个进程级 cookie、没有 logout，
 *      官方注明 identity 包里的 UUID「Do not use it to identify a user」），账号体系只能是我们的；
 *   ② 向我们的服务端要这节课的上下文（`GET /api/student/runtime/client-context`）：
 *      **运行时密钥** + 网关地址 + 预设提示词 + 剩余发送次数；
 *   ③ **没有正在进行的课堂就不启动 dsh**（老师没点「立即上课」→ 学生只看到「等老师开始上课」）。
 *      这不只是"不让进"：没有密钥，dsh 就算起来了也调不动网关（网关每次调用重新过门禁）。
 *
 * 网关注入的两个落点（都已验证可行）：
 *   · **环境变量**：Electron 主进程的 `process.env` 会被 `desktopNodeEnvironment()` 原样传给 dsh，
 *     所以这里把 `PLATFORM_GATEWAY_KEY` / `PLATFORM_GATEWAY_BASE_URL` 写进 `process.env`；
 *   · **补丁层**：把随包的 `lingdong.patch.yml` 写到 `$DSH_HOME/lingdong.patch.yml`，由桌面宿主
 *     放进 `patchFiles`（见 apps/desktop-host/src/index.ts 的三行改动）。
 *     ⚠️ **不要写 profile 里的 `cordis.patch.yml`**：桌面宿主显式传的是 `patchFiles: []`，而
 *        `profile-context.ts` 是 `initialProfile?.patches ?? loadOptionalPatches(...)` ——
 *        空数组不是 undefined，所以那个文件**永远不会被读**；而且 app 的恢复流程还会把它重置并备份掉。
 */
const GATE_DIR = app.isPackaged
  ? join(process.resourcesPath, 'gate')
  : join(app.getAppPath(), 'resources', 'gate')
const API_BASE = String(process.env.LINGDONG_API_BASE || 'https://iicili.cyou').replace(/\/$/, '')

interface LingdongUser { readonly displayName?: string; readonly login?: string }
interface LingdongSession { readonly token: string; readonly user?: LingdongUser }
interface LingdongContext {
  readonly classroom: { readonly id: string; readonly lessonId?: string; readonly title?: string } | null
  readonly gateway?: { readonly baseUrl?: string; readonly key?: string }
  readonly presets?: readonly { readonly title: string; readonly text: string }[]
  readonly sends?: { readonly limit: number | null; readonly used: number; readonly remaining: number | null }
  readonly message?: string
}
type GateAction = { action: 'login' } | { action: 'refresh' } | { action: 'logout' }
type GateOutcome = { kind: 'enter' } | { kind: 'quit' }

/**
 * 深链 `lingdong://open` 的落点（官网点「进入课堂 / 打开客户端」时由系统拉起）。
 * 作用只有一个：**把客户端叫到前台并让等待页重新问一次"现在有没有课"** ——
 * 学生不用自己去点刷新。登录页时它什么都不做（得先把账号登进去）。
 */
let notifyDeepLink: (() => void) | null = null
export function lingdongDeepLink(): void {
  try { notifyDeepLink?.() } catch { /* 深链只是便利，出错不该影响客户端 */ }
}

const sessionFile = (): string => join(app.getPath('userData'), 'lingdong-session.json')

function readJson<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8').trim()
    return text ? (JSON.parse(text) as T) : null
  } catch { return null }
}
function readSession(): LingdongSession | null {
  const session = readJson<LingdongSession>(sessionFile())
  return session && typeof session.token === 'string' && session.token ? session : null
}
function writeSession(session: LingdongSession | null): void {
  try { writeFileSync(sessionFile(), session === null ? '' : JSON.stringify(session, null, 2)) } catch { /* 存不下就当没登录 */ }
}

async function call(path: string, { method = 'GET', body, token }: { method?: string; body?: unknown; token?: string } = {}): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const init: RequestInit = { method, headers }
  // ⚠️ 上游开了 `exactOptionalPropertyTypes`：不能写成 `body: undefined`，要按需赋值。
  if (body !== undefined) init.body = JSON.stringify(body)
  const response = await fetch(`${API_BASE}${path}`, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(String(payload?.error?.message || payload?.message || `平台请求失败（HTTP ${response.status}）`))
  return payload?.data ?? payload
}

/**
 * 把 dsh 的默认模型指到我们网关（写 `$DSH_HOME/settings.yaml`）。
 *
 * ⚠️ **必须改这里，不能只靠补丁层的 `agent-default-model`**：用户层设置盖过补丁层。
 *    学生机器上那份 settings 里存着**上游模型**（`deepseek-official/deepseek-v4-pro`），
 *    而官方渠道已被我们禁用 —— 一发就 `NO_ADAPTER: no adapter registered for provider "deepseek-official"`
 *    （实测报错）。这正是客户端界面显示「当前模型不可用」的原因。
 * ⚠️ **不能带 `reasoningEffort`**：手写声明的渠道不认它 —— 带上会报
 *    `UNSUPPORTED_REASONING_EFFORT: provider "platform-gateway" model "deepseek-flash"
 *     does not support reasoning effort "low"`（实测），去掉才回落到渠道默认。
 * 只改这一个键，其余设置原样保留；改前留一份 .lingdong-backup。
 */
function pointDefaultModelToGateway(home: string): void {
  const file = join(home, 'settings.yaml')
  let text = ''
  try { text = existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { return }
  const block = 'agent-default-model:\n  provider: platform-gateway\n  model: deepseek-flash\n'
  const next = /^agent-default-model:\n(?:[ \t]+.*\n)*/mu.test(text)
    ? text.replace(/^agent-default-model:\n(?:[ \t]+.*\n)*/mu, block)
    : block + text
  if (next === text) return
  try {
    const backup = `${file}.lingdong-backup`
    if (existsSync(file) && !existsSync(backup)) writeFileSync(backup, text)
    writeFileSync(file, next)
  } catch (error) { console.error('灵动ai：写入默认模型失败（不影响登录）', error) }
}

/**
 * 把运行时密钥写进 dsh 的**凭据文件**（`$DSH_HOME/.credentials.yaml` 的 `refs`）。
 *
 * ⚠️ **为什么不能只靠环境变量**：补丁里的渠道是 `apiKeyEnv: PLATFORM_GATEWAY_KEY`，而宿主进程
 *    在启动时就把环境定下来了 —— 登录门事后往 `process.env` 里写，dsh 侧读不到。
 *    实测对照：把密钥预置在进程环境里 → 消息成功、用量进账；只靠登录门事后注入 → 每一轮
 *    「API 密钥无效」（AUTH），平台一条用量都没记到。
 *    登录门跑在宿主启动**之前**，所以写这个文件是来得及的（而且它是 dsh 自己解析凭据引用的地方）。
 *
 * 只动 `refs:` 段里的一个键，文件其余内容（如 `records` 里的浏览器会话授权）原样保留；
 * 改前留一份 .lingdong-backup。
 */
function writeGatewayCredential(home: string, key: string): void {
  const file = join(home, '.credentials.yaml')
  let text = ''
  try { text = existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { text = '' }
  const entry = `  PLATFORM_GATEWAY_KEY: ${key}`
  let next: string
  if (/^refs:\s*$/mu.test(text)) {
    next = /^ {2}PLATFORM_GATEWAY_KEY:.*$/mu.test(text)
      ? text.replace(/^ {2}PLATFORM_GATEWAY_KEY:.*$/mu, entry)
      : text.replace(/^refs:\s*$/mu, `refs:\n${entry}`)
  } else {
    next = `version: 1\nrefs:\n${entry}\n${text}`
  }
  try {
    const backup = `${file}.lingdong-backup`
    if (existsSync(file) && !existsSync(backup)) writeFileSync(backup, text)
    writeFileSync(file, next)
  } catch (error) { console.error('灵动ai：写入凭据失败', error) }
}

/** 铺好网关密钥与补丁层。**只有这节课真的在进行时**才会走到这里。 */
function applyGateway(context: LingdongContext): void {
  const key = context.gateway?.key
  const baseUrl = context.gateway?.baseUrl
  if (!key || !baseUrl) throw new Error('平台没有下发网关密钥，无法启动创作环境')
  process.env.PLATFORM_GATEWAY_KEY = String(key)
  process.env.PLATFORM_GATEWAY_BASE_URL = String(baseUrl)
  const home = String(process.env.DSH_HOME || '').trim() || join(app.getPath('home'), '.dsh')
  const patch = join(GATE_DIR, 'lingdong.patch.yml')
  if (existsSync(patch)) {
    try { writeFileSync(join(home, 'lingdong.patch.yml'), readFileSync(patch, 'utf8')) } catch (error) { console.error('灵动ai：写入补丁层失败', error) }
  }
  writeGatewayCredential(home, String(key))
  pointDefaultModelToGateway(home)
  try {
    writeFileSync(join(app.getPath('userData'), 'lingdong-classroom.json'), JSON.stringify({
      classroom: context.classroom, presets: context.presets ?? [], sends: context.sends ?? null,
      updatedAt: new Date().toISOString(),
    }, null, 2))
  } catch { /* 诊断用，写不下不影响使用 */ }
}

/**
 * 跑完登录门：返回 `enter` 才继续启动 dsh；返回 `quit` 表示该退出应用。
 * @param createWindow 应用自己的主窗口工厂（借它显示我们的页面）
 * @param isQuitting 应用是否正在退出
 */
export async function runLingdongGate(createWindow: () => BrowserWindow, isQuitting: () => boolean): Promise<GateOutcome> {
  let waiting: ((action: GateAction) => void) | null = null
  const nextAction = (): Promise<GateAction> => new Promise((resolve) => { waiting = resolve })

  ipcMain.handle('lingdong:gate', async (_event, payload: unknown) => {
    const request = (payload ?? {}) as { action?: string; login?: string; password?: string }
    if (request.action === 'refresh' || request.action === 'logout') { waiting?.(request as GateAction); return { ok: true } }
    if (request.action !== 'login') return { ok: false, message: '未知操作' }
    const login = String(request.login || '').trim()
    const password = String(request.password || '')
    if (!login || !password) return { ok: false, message: '请输入账号和密码' }
    try {
      const session = await call('/api/auth/login', { method: 'POST', body: { login, password } })
      if (!session?.token) return { ok: false, message: '账号或密码不正确' }
      writeSession({ token: session.token, user: session.user })
      waiting?.({ action: 'login' })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  const window = createWindow()
  const show = async (page: string, state: Record<string, unknown> = {}): Promise<void> => {
    await window.loadFile(join(GATE_DIR, page))
    // 页面里的脚本读这个全局拿到「谁登录了 / 为什么在这等」；不经过 IPC，避免多一轮握手。
    await window.webContents.executeJavaScript(`window.__LINGDONG_STATE__ = ${JSON.stringify(state)}; window.__lingdongRender && window.__lingdongRender();`).catch(() => undefined)
  }

  try {
    for (;;) {
      if (isQuitting()) return { kind: 'quit' }
      const session = readSession()
      if (session === null) {
        const action = await show('login.html').then(nextAction)
        if (action.action === 'logout') return { kind: 'quit' }
        continue
      }
      await show('loading.html', { name: session.user?.displayName || '' })
      let context: LingdongContext
      try {
        context = await call('/api/student/runtime/client-context', { token: session.token })
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法连接平台'
        writeSession(null)
        const action = await show('login.html', { message }).then(nextAction)
        if (action.action === 'logout') return { kind: 'quit' }
        continue
      }
      if (!context.classroom) {
        // 等老师开始上课：这里挂上深链回调 —— 官网拉起的客户端会立刻重问一次（学生不用自己点刷新）
        notifyDeepLink = () => waiting?.({ action: 'refresh' })
        const action = await show('waiting.html', { message: context.message || '老师还没有开始上课', name: session.user?.displayName || '' }).then(nextAction)
        if (action.action === 'logout') { writeSession(null); continue }
        continue // refresh：回循环顶部重新问一次「现在有没有课」
      }
      applyGateway(context)
      return { kind: 'enter' }
    }
  } finally {
    notifyDeepLink = null
    ipcMain.removeHandler('lingdong:gate')
  }
}
