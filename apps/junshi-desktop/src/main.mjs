import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  session,
  shell,
} from 'electron';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  douyinProfileUrl,
  extractDouyinWorkDetail,
  extractDouyinWorks,
  isDouyinDetailResponse,
  isDouyinProfileResponse,
  mergeDouyinSnapshots,
  normalizeSecUserId,
  secUserIdFromResponseUrl,
  snapshotWorks,
} from './douyin-data.mjs';

const require = createRequire(import.meta.url);

const APP_NAME = '招生军师';
const API_BASE = String(process.env.JUNSHI_SITE_URL || 'https://aicyld.com').replace(/\/+$/, '');
const WORKBENCH_URL = String(process.env.JUNSHI_WORKBENCH_URL || `${API_BASE}/junshi/index.html`);
const SESSION_KEY = 'ai-kids-platform.session.v1.org';
const WORKBENCH_PARTITION = 'persist:junshi-content-workbench';
const LOGIN_PARTITION = 'persist:junshi-login';
const DOUYIN_PARTITION = 'persist:junshi-douyin';
const DOUYIN_HOME = 'https://www.douyin.com/';
const START_HIDDEN = process.argv.includes('--hidden');
const TEST_OPEN_COLLECTOR = !app.isPackaged && process.env.JUNSHI_TEST_OPEN_COLLECTOR === '1';
const WORKBENCH_THEME_CSS = await readFile(new URL('./workbench-dark.css', import.meta.url), 'utf8');
const DOUYIN_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const MAX_DOUYIN_VIDEO_BYTES = Math.max(120 * 1024 * 1024, Math.min(200 * 1024 * 1024, Number(process.env.JUNSHI_DOUYIN_MAX_BYTES) || 200 * 1024 * 1024));

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.aicyld.junshi');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let loginWindow = null;
let workbenchWindow = null;
let collectorWindow = null;
let collectorGuest = null;
let syncWindow = null;
let linkResolveWindow = null;
let tray = null;
let storedSession = null;
let assistantCredential = null;
let assistantPairingPromise = null;
let ipcReady = false;
let isQuitting = false;
let syncPromise = null;
let autoSyncTimer = null;
let autoUpdateTimer = null;
let updater = null;
let settingsWriteChain = Promise.resolve();
let pendingCollectorUrl = '';
let broadcastTimer = null;
let collecting = false;
let selfProfileArmedAt = 0;
let selfSecUserId = '';
let selfRedirectWindowUntil = 0;
const chatControllers = new Map();

const captureStates = new WeakMap();
const DEFAULT_SETTINGS = {
  autoSyncEnabled: false,
  intervalHours: 24,
  launchAtLogin: false,
  notificationsEnabled: true,
  closeToTray: true,
  autoUpdateEnabled: true,
  lastCollectorUrl: DOUYIN_HOME,
  lastAutoSyncAt: null,
};
let settings = { ...DEFAULT_SETTINGS };
const runtime = {
  pairing: { connected: false, connecting: false, error: '' },
  browser: { url: DOUYIN_HOME, title: '', loading: false },
  capture: { count: 0, secUserId: '', nickname: '', updatedAt: 0, collecting: false },
  sync: { running: false, message: '等待同步任务', done: 0, total: 0, source: '' },
  lastSync: null,
  update: { status: 'idle', message: '自动检查已开启', version: '' },
  refsCount: 0,
};

class DesktopApiError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'DesktopApiError';
    this.status = status;
    this.code = code;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}
function sessionFilePath() {
  return path.join(app.getPath('userData'), 'account-session.bin');
}
function assistantFilePath() {
  return path.join(app.getPath('userData'), 'douyin-assistant.bin');
}

function normalizeSettings(input = {}) {
  const interval = Math.max(6, Math.min(168, Math.round(Number(input.intervalHours) || 24)));
  return {
    autoSyncEnabled: input.autoSyncEnabled === true,
    intervalHours: interval,
    launchAtLogin: input.launchAtLogin === true,
    notificationsEnabled: input.notificationsEnabled !== false,
    closeToTray: input.closeToTray !== false,
    autoUpdateEnabled: input.autoUpdateEnabled !== false,
    lastCollectorUrl: String(input.lastCollectorUrl || DOUYIN_HOME).slice(0, 2000),
    lastAutoSyncAt: input.lastAutoSyncAt ? String(input.lastAutoSyncAt) : null,
  };
}

async function loadSettings() {
  try {
    settings = normalizeSettings(JSON.parse(await readFile(settingsFilePath(), 'utf8')));
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  settingsWriteChain = settingsWriteChain
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(settingsFilePath()), { recursive: true });
      await writeFile(settingsFilePath(), JSON.stringify(settings, null, 2), 'utf8');
    });
  return settingsWriteChain;
}

async function updateSettings(patch = {}) {
  const previous = settings;
  settings = normalizeSettings({ ...settings, ...patch });
  if (!previous.autoSyncEnabled && settings.autoSyncEnabled) settings.lastAutoSyncAt = new Date().toISOString();
  await saveSettings().catch((error) => console.warn('[junshi-desktop] 保存设置失败:', error?.message || error));
  applyLaunchAtLogin();
  rebuildTrayMenu();
  installMenu();
  startAutoScheduler();
  broadcastCollectorStatus(true);
  return { ok: true, settings };
}

function sessionIsUsable(value) {
  if (!value || typeof value !== 'object' || !value.token) return false;
  if (!value.expiresAt) return true;
  const expires = Date.parse(value.expiresAt);
  return Number.isFinite(expires) && expires > Date.now() + 60_000;
}

async function readStoredSession() {
  try {
    const encrypted = await readFile(sessionFilePath());
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    return sessionIsUsable(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function persistSession(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统安全存储不可用，客户端不会以明文保存登录凭据。');
  }
  await writeFile(sessionFilePath(), safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
}

async function readAssistantCredential() {
  try {
    const encrypted = await readFile(assistantFilePath());
    const value = JSON.parse(safeStorage.decryptString(encrypted));
    if (!value?.token || value.base !== API_BASE) return null;
    return value;
  } catch {
    return null;
  }
}

async function persistAssistantCredential(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统安全存储不可用，无法安全保存抖音采集凭证。');
  }
  assistantCredential = { ...value, base: API_BASE };
  await writeFile(assistantFilePath(), safeStorage.encryptString(JSON.stringify(assistantCredential)), { mode: 0o600 });
}

async function clearAssistantCredential() {
  assistantCredential = null;
  await rm(assistantFilePath(), { force: true }).catch(() => {});
  runtime.pairing = { connected: false, connecting: false, error: '' };
  broadcastCollectorStatus(true);
}

async function clearStoredSession() {
  storedSession = null;
  await rm(sessionFilePath(), { force: true }).catch(() => {});
  await clearAssistantCredential();
  await session.fromPartition(WORKBENCH_PARTITION).clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
  }).catch(() => {});
  installMenu();
  rebuildTrayMenu();
}

function publicUser(value) {
  return value?.user
    ? {
        displayName: value.user.displayName || value.user.login || '',
        login: value.user.login || '',
        role: value.user.role || '',
        orgName: value.organization?.name || value.user.orgName || '',
      }
    : null;
}

async function loginWithPlatform(login, password, mfaCode = '') {
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password, clientType: 'org', ...(mfaCode ? { mfaCode } : {}) }),
    signal: AbortSignal.timeout(25_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data?.token) {
    const message = payload?.error?.message || payload?.message || (response.status === 401 ? '账号或密码错误' : `登录失败（HTTP ${response.status}）`);
    const code = String(payload?.error?.code || '');
    return {
      ok: false,
      message,
      mfaRequired: code === 'MFA_REQUIRED' || code === 'MFA_INVALID_CODE',
      mfaInvalid: code === 'MFA_INVALID_CODE',
    };
  }
  const data = payload.data;
  const value = { token: data.token, expiresAt: data.expiresAt || null, user: data.user || null, organization: data.organization || null };
  if (!sessionIsUsable(value)) return { ok: false, message: '平台没有返回有效登录会话' };
  storedSession = value;
  await persistSession(value);
  runtime.pairing = { connected: false, connecting: false, error: '' };
  installMenu();
  rebuildTrayMenu();
  void primeAssistantPairing();
  return { ok: true, user: publicUser(value) };
}

async function parseApiResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    const error = payload?.error;
    throw new DesktopApiError(
      error?.message || payload?.message || `请求失败（HTTP ${response.status}）`,
      response.status,
      String(error?.code || ''),
    );
  }
  return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

async function apiFetch(apiPath, options = {}) {
  const auth = options.auth || 'none';
  const token = auth === 'session' ? storedSession?.token : auth === 'assistant' ? assistantCredential?.token : '';
  if (auth === 'session' && !sessionIsUsable(storedSession)) throw new DesktopApiError('机构登录已过期，请重新登录', 401, 'SESSION_EXPIRED');
  if (auth === 'assistant' && !token) throw new DesktopApiError('本地采集助手尚未配对', 401, 'DOUYIN_ASSISTANT_UNAUTHORIZED');
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const body = options.body;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${API_BASE}/api/junshi/workbench${apiPath}`, {
    method: options.method || 'GET',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout || 30_000),
  });
  return await parseApiResponse(response);
}

function assistantDeviceName() {
  return `Electron ${app.getVersion()} · ${String(os.hostname() || '').slice(0, 80)}`;
}

async function ensureAssistantCredential(force = false) {
  if (!force && assistantCredential?.token) {
    runtime.pairing = { connected: true, connecting: false, error: '' };
    return assistantCredential;
  }
  if (assistantPairingPromise) return await assistantPairingPromise;
  assistantPairingPromise = (async () => {
    if (!sessionIsUsable(storedSession)) throw new DesktopApiError('请先登录机构账号，再连接本地抖音采集', 401, 'SESSION_EXPIRED');
    runtime.pairing = { connected: false, connecting: true, error: '' };
    broadcastCollectorStatus(true);
    try {
      const pairing = await apiFetch('/douyin/assistant/pairing', { method: 'POST', auth: 'session', body: { accountId: 'default' } });
      const paired = await apiFetch('/douyin/assistant/pair', {
        method: 'POST',
        auth: 'none',
        body: { code: pairing.code, device: assistantDeviceName() },
      });
      await persistAssistantCredential({ token: paired.token, pairedAt: new Date().toISOString() });
      runtime.pairing = { connected: true, connecting: false, error: '' };
      broadcastCollectorStatus(true);
      return assistantCredential;
    } catch (error) {
      runtime.pairing = { connected: false, connecting: false, error: String(error?.message || error) };
      broadcastCollectorStatus(true);
      throw error;
    } finally {
      assistantPairingPromise = null;
    }
  })();
  return await assistantPairingPromise;
}

async function primeAssistantPairing() {
  if (!sessionIsUsable(storedSession)) return;
  if (assistantCredential?.token) {
    runtime.pairing = { connected: true, connecting: false, error: '' };
    broadcastCollectorStatus(true);
    return;
  }
  try {
    await ensureAssistantCredential();
  } catch (error) {
    console.warn('[junshi-desktop] 自动连接抖音采集失败:', error?.message || error);
  }
}

async function ingestDouyinWorks(payload) {
  await ensureAssistantCredential();
  const send = () => apiFetch('/douyin/assistant/ingest', { method: 'POST', auth: 'assistant', body: payload, timeout: 45_000 });
  try {
    return await send();
  } catch (error) {
    if (error?.status !== 401 && error?.code !== 'DOUYIN_ASSISTANT_UNAUTHORIZED') throw error;
    await clearAssistantCredential();
    await ensureAssistantCredential(true);
    return await send();
  }
}

function isAllowedDouyinUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname === 'douyin.com' || parsed.hostname.endsWith('.douyin.com');
  } catch {
    return false;
  }
}

function normalizeCollectorUrl(input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('请输入抖音主页链接或 sec_uid');
  const secUserId = normalizeSecUserId(value);
  if (secUserId) return douyinProfileUrl(secUserId);
  let candidate = value;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate.replace(/^\/+/, '')}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { throw new Error('链接格式不正确'); }
  if (!isAllowedDouyinUrl(parsed.href)) throw new Error('这里只能打开 douyin.com 的页面');
  return parsed.href;
}

function captureStateFor(webContents) {
  let state = captureStates.get(webContents);
  if (!state) {
    state = {
      works: new Map(),
      secUserId: '',
      nickname: '',
      expectedSecUserId: '',
      expectedAwemeId: '',
      updatedAt: 0,
      requestUrls: new Map(),
      attached: false,
      listenerAttached: false,
      error: '',
    };
    captureStates.set(webContents, state);
    void attachCaptureDebugger(webContents, state);
  }
  return state;
}

async function attachCaptureDebugger(webContents, state) {
  if (state.attached || webContents.isDestroyed()) return;
  try {
    if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3');
    state.attached = true;
    if (!state.listenerAttached) {
      state.listenerAttached = true;
      webContents.debugger.on('message', (_event, method, params) => {
        if (method === 'Network.responseReceived') {
          const url = String(params?.response?.url || '');
          if (isDouyinProfileResponse(url) || isDouyinDetailResponse(url)) state.requestUrls.set(String(params.requestId || ''), url);
          return;
        }
        if (method === 'Network.loadingFailed') {
          state.requestUrls.delete(String(params?.requestId || ''));
          return;
        }
        if (method !== 'Network.loadingFinished') return;
        const requestId = String(params?.requestId || '');
        const url = state.requestUrls.get(requestId);
        if (!url) return;
        state.requestUrls.delete(requestId);
        void readCapturedResponse(webContents, state, requestId, url);
      });
      webContents.once('destroyed', () => {
        try { if (webContents.debugger.isAttached()) webContents.debugger.detach(); } catch {}
      });
    }
    await webContents.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize: 100 * 1024 * 1024,
      maxResourceBufferSize: 50 * 1024 * 1024,
      maxPostDataSize: 1024 * 1024,
    });
  } catch (error) {
    state.error = String(error?.message || error);
    console.warn('[junshi-desktop] 抖音网络旁路不可用:', state.error);
  }
}

async function readCapturedResponse(webContents, state, requestId, url) {
  if (webContents.isDestroyed()) return;
  try {
    const result = await webContents.debugger.sendCommand('Network.getResponseBody', { requestId });
    const raw = result?.base64Encoded ? Buffer.from(result.body || '', 'base64').toString('utf8') : String(result?.body || '');
    if (!raw) return;
    const payload = JSON.parse(raw);
    if (isDouyinDetailResponse(url)) {
      const detail = extractDouyinWorkDetail(payload, state.expectedAwemeId);
      if (!detail?.work) return;
      mergeDouyinSnapshots(state, { secUserId: detail.secUserId, nickname: detail.nickname, works: [detail.work] });
      state.updatedAt = Date.now();
      updateVisibleCaptureStatus();
      return;
    }
    const responseSecUserId = secUserIdFromResponseUrl(url);
    const expected = state.expectedSecUserId || state.secUserId;
    if (expected && responseSecUserId && responseSecUserId !== expected) return;
    const snapshot = extractDouyinWorks(payload, { expectedSecUserId: expected });
    if (!snapshot.works.length) return;
    if (expected && snapshot.secUserId && snapshot.secUserId !== expected) return;
    mergeDouyinSnapshots(state, snapshot);
    updateVisibleCaptureStatus();
  } catch (error) {
    if (!/No resource with given identifier|Cannot find context|Inspected target navigated/i.test(String(error?.message || error))) {
      console.warn('[junshi-desktop] 解析抖音主页响应失败:', error?.message || error);
    }
  }
}

function resetCapture(webContents, expectedSecUserId = '') {
  const state = captureStateFor(webContents);
  state.works.clear();
  state.secUserId = String(expectedSecUserId || '');
  state.nickname = '';
  state.expectedSecUserId = String(expectedSecUserId || '');
  state.expectedAwemeId = '';
  state.updatedAt = 0;
  state.requestUrls.clear();
  return state;
}

function captureSummary(webContents) {
  if (!webContents || webContents.isDestroyed()) return null;
  const state = captureStates.get(webContents);
  if (!state) return null;
  return { count: state.works.size, secUserId: state.secUserId || '', nickname: state.nickname || '', updatedAt: state.updatedAt || 0 };
}

function updateVisibleCaptureStatus() {
  const summary = captureSummary(collectorGuest);
  if (!summary) return;
  if (selfProfileArmedAt && summary.secUserId && !selfSecUserId) selfSecUserId = summary.secUserId;
  runtime.capture = { ...runtime.capture, ...summary };
  broadcastCollectorStatus();
}

function rememberVisibleNavigation(url) {
  if (!collectorGuest || collectorGuest.isDestroyed()) return;
  let pathname = '';
  try { pathname = new URL(String(url || '')).pathname.replace(/\/+$/, '') || '/'; } catch { return; }
  if (pathname === '/user/self') {
    selfProfileArmedAt = Date.now();
    selfRedirectWindowUntil = Date.now() + 120_000;
    selfSecUserId = '';
    resetCapture(collectorGuest, '');
    runtime.capture = { count: 0, secUserId: '', nickname: '', updatedAt: 0, collecting };
    return;
  }
  if (!pathname.startsWith('/user/')) return;
  const secUserId = normalizeSecUserId(url);
  if (!secUserId) return;
  if (selfProfileArmedAt && selfRedirectWindowUntil && Date.now() <= selfRedirectWindowUntil) {
    selfSecUserId = secUserId;
    selfRedirectWindowUntil = 0;
    resetCapture(collectorGuest, '');
    runtime.capture = { count: 0, secUserId, nickname: '', updatedAt: 0, collecting };
    return;
  }
  if (selfProfileArmedAt && selfSecUserId && secUserId === selfSecUserId) return;
  selfProfileArmedAt = 0;
  selfRedirectWindowUntil = 0;
  selfSecUserId = '';
  const state = captureStateFor(collectorGuest);
  if (state.expectedSecUserId !== secUserId) {
    resetCapture(collectorGuest, secUserId);
    runtime.capture = { count: 0, secUserId, nickname: '', updatedAt: 0, collecting };
    broadcastCollectorStatus();
  }
}

function buildCollectorStatus() {
  const visibleCapture = captureSummary(collectorGuest);
  return {
    version: app.getVersion(),
    settings: { ...settings },
    pairing: { ...runtime.pairing },
    browser: { ...runtime.browser },
    capture: { ...(visibleCapture || runtime.capture), collecting },
    sync: { ...runtime.sync },
    lastSync: runtime.lastSync ? { ...runtime.lastSync } : null,
    update: { ...runtime.update },
    refsCount: runtime.refsCount,
    signedIn: sessionIsUsable(storedSession),
  };
}

function broadcastCollectorStatus(immediate = false) {
  if (broadcastTimer && !immediate) return;
  if (broadcastTimer) clearTimeout(broadcastTimer);
  const send = () => {
    broadcastTimer = null;
    const status = buildCollectorStatus();
    for (const win of [collectorWindow, workbenchWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send('junshi:collector-status-event', status);
    }
  };
  if (immediate) send();
  else broadcastTimer = setTimeout(send, 100);
}

function updateBrowserRuntime(webContents, patch = {}) {
  if (!webContents || webContents.isDestroyed()) return;
  runtime.browser = {
    url: webContents.getURL() || runtime.browser.url,
    title: webContents.getTitle() || runtime.browser.title,
    loading: runtime.browser.loading,
    ...patch,
  };
  broadcastCollectorStatus();
}

function openExternalUrl(url) {
  if (/^https?:\/\//i.test(String(url || ''))) void shell.openExternal(url);
}

function configureDouyinContents(webContents, { visible = false } = {}) {
  if (!webContents || webContents.isDestroyed()) return;
  webContents.setAudioMuted(!visible);
  webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedDouyinUrl(url)) {
      setTimeout(() => { if (!webContents.isDestroyed()) void webContents.loadURL(url); }, 0);
    } else {
      openExternalUrl(url);
    }
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (isAllowedDouyinUrl(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  if (visible) {
    webContents.on('did-start-loading', () => updateBrowserRuntime(webContents, { loading: true }));
    webContents.on('did-stop-loading', () => updateBrowserRuntime(webContents, { loading: false }));
    webContents.on('did-navigate', (_event, url) => {
      updateBrowserRuntime(webContents, { url, loading: false });
      rememberVisibleNavigation(url);
    });
    webContents.on('did-navigate-in-page', (_event, url) => {
      updateBrowserRuntime(webContents, { url, loading: false });
      rememberVisibleNavigation(url);
    });
    webContents.on('page-title-updated', (_event, title) => updateBrowserRuntime(webContents, { title }));
    webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      updateBrowserRuntime(webContents, { loading: false });
      console.warn('[junshi-desktop] 抖音页面加载失败:', code, description, url);
    });
  }
  captureStateFor(webContents);
}

async function scrollForMoreWorks(webContents, options = {}) {
  const maxRounds = Math.max(1, Number(options.maxRounds) || 8);
  const settleRoundsLimit = Math.max(1, Number(options.settleRounds) || 2);
  let settleRounds = 0;
  let previousCount = captureStateFor(webContents).works.size;
  for (let round = 0; round < maxRounds; round += 1) {
    if (webContents.isDestroyed()) break;
    try {
      await webContents.executeJavaScript(`(() => {
        const nodes = [document.scrollingElement, ...document.querySelectorAll('main, [class*="scroll"], [class*="feed"], [class*="list"]')];
        for (const node of nodes) {
          if (!node) continue;
          try {
            if (node.scrollHeight > node.clientHeight + 120) node.scrollTop = node.scrollHeight;
          } catch {}
        }
        window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
        return true;
      })()`, true);
    } catch {}
    try {
      webContents.sendInputEvent({ type: 'mouseWheel', x: 900, y: 720, deltaX: 0, deltaY: -1000, canScroll: true });
    } catch {}
    await delay(950 + round * 80);
    const currentCount = captureStateFor(webContents).works.size;
    if (currentCount === previousCount) settleRounds += 1;
    else settleRounds = 0;
    previousCount = currentCount;
    if (currentCount >= 60) break;
    if (settleRounds >= settleRoundsLimit && round >= 1) break;
  }
  return captureStateFor(webContents);
}

async function loadUrlWithTimeout(webContents, url, timeoutMs = 35_000) {
  await Promise.race([
    webContents.loadURL(url),
    delay(timeoutMs).then(() => { throw new Error('抖音页面加载超时'); }),
  ]);
}

async function getSyncBrowser() {
  if (syncWindow && !syncWindow.isDestroyed()) return syncWindow;
  const win = new BrowserWindow({
    width: 1420,
    height: 980,
    show: false,
    skipTaskbar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: DOUYIN_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  syncWindow = win;
  win.on('closed', () => { if (syncWindow === win) syncWindow = null; });
  configureDouyinContents(win.webContents, { visible: false });
  return win;
}

function destroySyncBrowser() {
  if (syncWindow && !syncWindow.isDestroyed()) syncWindow.destroy();
  syncWindow = null;
}

function destroyLinkResolveBrowser() {
  if (linkResolveWindow && !linkResolveWindow.isDestroyed()) linkResolveWindow.destroy();
  linkResolveWindow = null;
}

async function getLinkResolveBrowser() {
  if (linkResolveWindow && !linkResolveWindow.isDestroyed()) return linkResolveWindow;
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    skipTaskbar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: DOUYIN_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  linkResolveWindow = win;
  win.on('closed', () => { if (linkResolveWindow === win) linkResolveWindow = null; });
  configureDouyinContents(win.webContents, { visible: false });
  return win;
}

async function resolveDouyinLinkWork(raw) {
  const candidates = String(raw || '').match(/https?:\/\/[^\s]+/g) || [];
  const targetUrl = candidates.find((value) => isAllowedDouyinUrl(value));
  if (!targetUrl) throw new Error('请粘贴完整的抖音作品链接或分享内容');
  const win = await getLinkResolveBrowser();
  const state = resetCapture(win.webContents, '');
  state.expectedAwemeId = '';
  try {
    void win.webContents.loadURL(targetUrl).catch(() => {});
    const deadline = Date.now() + 60000;
    while (!state.works.size && Date.now() < deadline) await delay(500);
    const pageUrl = win.webContents.getURL();
    const pageAwemeId = (pageUrl.match(/\/video\/(\d{6,25})/) || [])[1] || '';
    const work = Array.from(state.works.values()).find((item) => !pageAwemeId || item.awemeId === pageAwemeId) || Array.from(state.works.values())[0];
    if (!work) {
      let pageText = '';
      try {
        pageText = await Promise.race([
          win.webContents.executeJavaScript('document.body?.innerText || ""'),
          delay(3000).then(() => ''),
        ]);
      } catch {}
      if (/验证|登录后|请登录|访问受限/.test(pageText)) {
        throw new Error('抖音要求登录或安全验证，请先在「本地抖音采集」窗口完成登录/验证后再试');
      }
      throw new Error('没有读到这条抖音作品的详情，请确认链接可公开访问后再试');
    }
    if (!/^https?:\/\//i.test(work.playUrl || '')) throw new Error('抖音没有返回可下载的视频地址');
    return { work, pageUrl };
  } finally {
    destroyLinkResolveBrowser();
  }
}

async function importDouyinLink(raw) {
  if (!sessionIsUsable(storedSession)) throw new Error('机构登录已过期，请重新登录');
  const { work, pageUrl } = await resolveDouyinLinkWork(raw);
  const assetList = await apiFetch('/assets?accountId=default', { auth: 'session' });
  const cacheName = `douyin-${work.awemeId}.mp4`;
  const cached = (assetList?.items || []).find((item) => item.kind === 'video' && (item.fileName === cacheName || item.file_name === cacheName));
  if (cached) return { ok: true, work: { ...work, pageUrl }, asset: cached, message: '已复用这条链接之前上传的视频素材' };
  const response = await fetch(work.playUrl, {
    headers: { 'user-agent': DOUYIN_USER_AGENT, referer: 'https://www.douyin.com/' },
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`抖音视频下载失败（HTTP ${response.status}）`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_DOUYIN_VIDEO_BYTES) throw new Error(`这条视频超过 ${Math.floor(MAX_DOUYIN_VIDEO_BYTES / 1024 / 1024)}MB，超出平台单素材上限`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('抖音视频下载为空');
  if (buffer.length > MAX_DOUYIN_VIDEO_BYTES) throw new Error(`这条视频超过 ${Math.floor(MAX_DOUYIN_VIDEO_BYTES / 1024 / 1024)}MB，超出平台单素材上限`);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'video/mp4' }), `douyin-${work.awemeId}.mp4`);
  form.append('accountId', 'default');
  form.append('folder', '复刻参考');
  const uploaded = await fetch(`${API_BASE}/api/junshi/workbench/assets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${storedSession.token}` },
    body: form,
    signal: AbortSignal.timeout(600000),
  });
  const data = await parseApiResponse(uploaded);
  if (!data?.asset?.id) throw new Error('链接视频上传后没有返回素材编号');
  return { ok: true, work: { ...work, pageUrl, nickname: work.nickname || '' }, asset: data.asset, message: '已从本地浏览器读取链接视频并上传素材' };
}

async function collectPeerWithHiddenBrowser(ref) {
  const secUserId = normalizeSecUserId(ref.secUserId || ref.url || ref.notes || '');
  if (!secUserId) throw new Error(`同行「${ref.name || '未命名'}」没有主页 ID`);
  const win = await getSyncBrowser();
  const state = resetCapture(win.webContents, secUserId);
  await loadUrlWithTimeout(win.webContents, douyinProfileUrl(secUserId));
  await delay(1200);
  await scrollForMoreWorks(win.webContents, { maxRounds: 10, settleRounds: 2 });
  const snapshot = snapshotWorks(state);
  if (!snapshot.works.length) {
    const currentUrl = win.webContents.getURL();
    throw new Error(`没有读到「${ref.name || secUserId}」的作品，请先在本地采集窗口打开抖音并完成登录/验证${currentUrl ? `（当前 ${currentUrl}）` : ''}`);
  }
  return snapshot;
}

async function fetchPeerRefs() {
  const result = await apiFetch('/refs', { auth: 'session' });
  const items = Array.isArray(result?.items) ? result.items : [];
  runtime.refsCount = items.length;
  return items
    .map((item) => ({
      ...item,
      secUserId: normalizeSecUserId(item.secUserId || item.url || item.notes || ''),
    }))
    .filter((item) => item.secUserId)
    .slice(0, 50);
}

function notify(title, body, onClick) {
  if (!settings.notificationsEnabled || !Notification.isSupported()) return;
  if ((workbenchWindow?.isFocused() || collectorWindow?.isFocused()) && !String(title).includes('已下载')) return;
  const notification = new Notification({ title: `${APP_NAME} · ${title}`, body: String(body || '').slice(0, 240), icon: path.join(import.meta.dirname, '..', 'assets', 'icon.png') });
  notification.on('click', () => {
    if (typeof onClick === 'function') onClick();
    else void openCollectorWindow();
  });
  notification.show();
}

async function runSyncAll(source = 'manual') {
  if (!sessionIsUsable(storedSession)) {
    await showLoginWindow({ force: true });
    return { ok: false, message: '请先登录机构账号' };
  }
  if (collecting) return { ok: false, message: '当前页正在采集，请稍后再同步全部同行' };
  runtime.sync = { running: true, message: '正在连接采集助手…', done: 0, total: 0, source };
  broadcastCollectorStatus(true);
  rebuildTrayMenu();
  try {
    await ensureAssistantCredential();
    const refs = await fetchPeerRefs();
    if (!refs.length) {
      runtime.sync = { running: false, message: '还没有可同步的同行', done: 0, total: 0, source };
      runtime.lastSync = { at: new Date().toISOString(), ok: true, message: '还没有可同步的同行' };
      broadcastCollectorStatus(true);
      return { ok: true, message: '还没有可同步的同行' };
    }
    runtime.sync = { running: true, message: `准备同步 ${refs.length} 个同行`, done: 0, total: refs.length, source };
    broadcastCollectorStatus(true);
    let succeeded = 0;
    const failures = [];
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      runtime.sync.message = `正在读取 ${ref.name || ref.secUserId}（${index + 1}/${refs.length}）`;
      broadcastCollectorStatus(true);
      try {
        const snapshot = await collectPeerWithHiddenBrowser(ref);
        const result = await ingestDouyinWorks({ mode: 'peer', ...snapshot });
        if (!result?.accepted) throw new Error('平台没有接收作品数据');
        succeeded += 1;
      } catch (error) {
        failures.push(`${ref.name || ref.secUserId}: ${error?.message || error}`);
      }
      runtime.sync.done = index + 1;
      runtime.sync.message = failures.length
        ? `已处理 ${index + 1}/${refs.length}，${failures.length} 个失败`
        : `已同步 ${index + 1}/${refs.length}`;
      broadcastCollectorStatus(true);
      if (index < refs.length - 1) await delay(1400 + Math.floor(Math.random() * 700));
    }
    const message = failures.length ? `同步完成：成功 ${succeeded}，失败 ${failures.length}` : `同步完成：${succeeded} 个同行`;
    runtime.sync = { running: false, message, done: refs.length, total: refs.length, source };
    runtime.lastSync = { at: new Date().toISOString(), ok: failures.length === 0, message: failures[0] || message };
    settings.lastAutoSyncAt = runtime.lastSync.at;
    await saveSettings().catch(() => {});
    broadcastCollectorStatus(true);
    rebuildTrayMenu();
    notify(failures.length ? '同行同步有失败' : '同行同步完成', message, () => void openCollectorWindow());
    return { ok: failures.length === 0, message, status: buildCollectorStatus() };
  } catch (error) {
    const message = String(error?.message || error);
    runtime.sync = { running: false, message, done: 0, total: 0, source };
    runtime.lastSync = { at: new Date().toISOString(), ok: false, message };
    settings.lastAutoSyncAt = runtime.lastSync.at;
    await saveSettings().catch(() => {});
    broadcastCollectorStatus(true);
    rebuildTrayMenu();
    notify('同行同步失败', message, () => void openCollectorWindow());
    if (error?.status === 401 && error?.code === 'SESSION_EXPIRED') {
      await clearStoredSession();
      await showLoginWindow({ force: true });
    }
    return { ok: false, message, status: buildCollectorStatus() };
  } finally {
    destroySyncBrowser();
    runtime.sync.running = false;
  }
}

function syncAllPeers(source = 'manual') {
  if (syncPromise) return syncPromise.then(() => ({ ok: false, message: '同步任务正在进行中' }));
  syncPromise = runSyncAll(source).finally(() => {
    syncPromise = null;
    rebuildTrayMenu();
  });
  return syncPromise;
}

async function collectVisiblePage(mode = 'peer') {
  if (!collectorGuest || collectorGuest.isDestroyed()) throw new Error('抖音浏览器还没有准备好');
  if (syncPromise) throw new Error('后台同步正在进行，请稍后再采集当前页');
  if (collecting) throw new Error('当前页正在采集');
  const currentUrl = collectorGuest.getURL() || '';
  if (!isAllowedDouyinUrl(currentUrl)) throw new Error('请先在右侧打开抖音主页');
  const pageSecUserId = normalizeSecUserId(currentUrl);
  if (mode === 'peer' && !pageSecUserId) throw new Error('请先打开一个同行「主页」，不是作品详情页');
  if (mode === 'self') {
    const state = captureStateFor(collectorGuest);
    const knownSelfSecUserId = selfSecUserId || state.secUserId;
    if (!selfProfileArmedAt) throw new Error('请先点「打开我的主页」，确认抖音已登录后再采集自己的作品');
    if (pageSecUserId && knownSelfSecUserId && pageSecUserId !== knownSelfSecUserId) {
      throw new Error('当前不是刚才打开的自己的主页，请重新点「打开我的主页」');
    }
  }
  collecting = true;
  runtime.capture.collecting = true;
  broadcastCollectorStatus(true);
  try {
    let state = captureStateFor(collectorGuest);
    if (mode === 'peer' && state.expectedSecUserId !== pageSecUserId) state = resetCapture(collectorGuest, pageSecUserId);
    await scrollForMoreWorks(collectorGuest, { maxRounds: 6, settleRounds: 2 });
    const snapshot = snapshotWorks(state);
    if (!snapshot.works.length) {
      throw new Error(mode === 'self'
        ? '没有读到作品：请先进入自己的抖音主页，往下滚动加载作品后重试'
        : '没有读到作品：请确认当前是同行主页，往下滚动加载作品后重试');
    }
    const result = await ingestDouyinWorks({ mode, ...snapshot });
    const accepted = Number(result?.accepted || snapshot.works.length);
    const message = mode === 'self'
      ? `已同步 ${accepted} 条作品（新增 ${Number(result?.created || 0)} / 更新 ${Number(result?.updated || 0)}）`
      : `已上报 ${accepted} 条作品，服务器开始下载和转写`;
    runtime.lastSync = { at: new Date().toISOString(), ok: true, message };
    broadcastCollectorStatus(true);
    notify('本地采集完成', message, () => void openCollectorWindow());
    return { ok: true, message, accepted, status: buildCollectorStatus() };
  } catch (error) {
    const message = String(error?.message || error);
    runtime.lastSync = { at: new Date().toISOString(), ok: false, message };
    broadcastCollectorStatus(true);
    notify('本地采集失败', message, () => void openCollectorWindow());
    return { ok: false, message, status: buildCollectorStatus() };
  } finally {
    collecting = false;
    runtime.capture.collecting = false;
    broadcastCollectorStatus(true);
  }
}

async function openSelfProfile() {
  const url = 'https://www.douyin.com/user/self';
  selfProfileArmedAt = Date.now();
  selfRedirectWindowUntil = Date.now() + 120_000;
  selfSecUserId = '';
  if (!collectorWindow || collectorWindow.isDestroyed()) {
    pendingCollectorUrl = url;
    await openCollectorWindow();
    return { ok: true, message: '已打开我的抖音主页', status: buildCollectorStatus() };
  }
  collectorWindow.show();
  collectorWindow.focus();
  if (!collectorGuest || collectorGuest.isDestroyed()) {
    pendingCollectorUrl = url;
    return { ok: true, message: '正在打开我的抖音主页', status: buildCollectorStatus() };
  }
  resetCapture(collectorGuest, '');
  runtime.capture = { count: 0, secUserId: '', nickname: '', updatedAt: 0, collecting: false };
  broadcastCollectorStatus(true);
  await collectorGuest.loadURL(url);
  return { ok: true, message: '已打开我的抖音主页，登录后点「采集我的作品」', status: buildCollectorStatus() };
}

async function openCollectorUrl(input) {
  const url = normalizeCollectorUrl(input);
  try {
    if (new URL(url).pathname.replace(/\/+$/, '') === '/user/self') return await openSelfProfile();
  } catch {}
  selfProfileArmedAt = 0;
  selfRedirectWindowUntil = 0;
  selfSecUserId = '';
  settings.lastCollectorUrl = url;
  void saveSettings();
  const expected = normalizeSecUserId(url);
  if (!collectorWindow || collectorWindow.isDestroyed()) {
    pendingCollectorUrl = url;
    await openCollectorWindow();
    return { ok: true, message: '已打开本地采集窗口', status: buildCollectorStatus() };
  }
  collectorWindow.show();
  collectorWindow.focus();
  if (!collectorGuest || collectorGuest.isDestroyed()) {
    pendingCollectorUrl = url;
    return { ok: true, message: '正在打开抖音', status: buildCollectorStatus() };
  }
  resetCapture(collectorGuest, expected);
  runtime.capture = { count: 0, secUserId: expected, nickname: '', updatedAt: 0, collecting: false };
  broadcastCollectorStatus(true);
  await collectorGuest.loadURL(url);
  return { ok: true, message: '已打开主页', status: buildCollectorStatus() };
}

function attachTrayCloseBehavior(win) {
  win.on('close', (event) => {
    if (isQuitting || !settings.closeToTray || !sessionIsUsable(storedSession)) return;
    event.preventDefault();
    win.hide();
  });
}

function menuTemplate() {
  return [
    {
      label: APP_NAME,
      submenu: [
        { label: '打开内容工作台', accelerator: 'CmdOrCtrl+1', click: () => void openWorkbenchWindow() },
        { label: '本地抖音采集', accelerator: 'CmdOrCtrl+2', click: () => void openCollectorWindow() },
        { label: '立即同步全部同行', accelerator: 'CmdOrCtrl+Shift+S', click: () => void syncAllPeers('manual') },
        { type: 'separator' },
        { label: '账号登录', click: () => void showLoginWindow({ force: true }) },
        {
          label: '退出登录',
          click: async () => {
            await clearStoredSession();
            if (workbenchWindow && !workbenchWindow.isDestroyed()) workbenchWindow.close();
            if (collectorWindow && !collectorWindow.isDestroyed()) collectorWindow.close();
            await showLoginWindow({ force: true });
          },
        },
        { type: 'separator' },
        { label: '检查更新', click: () => void checkForUpdates({ manual: true }) },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '恢复默认缩放', role: 'resetZoom' },
        { type: 'separator' },
        { label: '工作台开发者工具', click: () => workbenchWindow?.webContents?.openDevTools({ mode: 'detach' }) },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开招生军师官网', click: () => void shell.openExternal(`${API_BASE}/junshi/`) },
        { label: '关于', click: () => void showAbout() },
      ],
    },
  ];
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
}

async function showAbout() {
  await dialog.showMessageBox({
    type: 'info',
    title: `关于${APP_NAME}`,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: '独立内容工作台客户端\n账号与数据统一由招生军师平台提供。\n本地抖音采集不上传 Cookie。',
  });
}

function wireExternalNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      try {
        const target = new URL(url);
        const allowed = new URL(API_BASE);
        if (target.hostname === allowed.hostname) return { action: 'allow' };
      } catch {}
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      const allowed = new URL(API_BASE);
      if (target.hostname === allowed.hostname) return;
    } catch {}
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
}

function injectWorkbenchSession(win, value) {
  const script = `(() => {
    const value = ${JSON.stringify(value)};
    localStorage.setItem(${JSON.stringify(SESSION_KEY)}, JSON.stringify(value));
    window.__JUNSHI_DESKTOP__ = { version: ${JSON.stringify(app.getVersion())} };
    return true;
  })()`;
  return win.webContents.executeJavaScript(script, true);
}

function workbenchDesktopScript() {
  return `(() => {
    window.__JUNSHI_DESKTOP__ = { version: ${JSON.stringify(app.getVersion())} };
    window.__JUNSHI_COLLECTOR_STATE__ = null;
    const labels = { chat: '灵动Agent', plan: '内容计划', video: '视频创作', account: '账号档案', references: '同行观察', copybrains: '文案大脑', assets: '素材库', reports: '数据报表', jobs: '历史任务' };
    const decorate = () => {
      const brand = document.querySelector('.wb-title b');
      const sub = document.querySelector('.wb-title span');
      if (brand && brand.textContent !== '招生军师') brand.textContent = '招生军师';
      if (sub && sub.textContent !== 'CONTENT WORKSPACE') sub.textContent = 'CONTENT WORKSPACE';
      const active = document.querySelector('#wb-tabs [data-wb][aria-current="true"]');
      const key = active?.dataset?.wb || 'chat';
      const view = document.querySelector('#wb-view');
      if (!view) return;
      const existing = view.querySelector(':scope > .desktop-page-head');
      if (key === 'chat') existing?.remove();
      else {
        let head = existing;
        if (!head) {
          head = document.createElement('div');
          head.className = 'desktop-page-head';
          view.prepend(head);
        }
        const title = labels[key] || active?.textContent?.trim() || '内容工作台';
        if (head.dataset.title !== title) {
          head.dataset.title = title;
          head.innerHTML = '<span>CONTENT WORKSPACE</span><h1></h1>';
          head.querySelector('h1').textContent = title;
        }
      }
      ensureCollectorButton();
      patchConnectionBar();
      patchDesktopActions();
    };
    const patchConnectionBar = () => {
      const bar = document.querySelector('.wb-douyin-bar');
      if (!bar) return;
      const small = bar.querySelector('small');
      if (small && /浏览器上的采集助手图标|装一次.*采集助手/.test(small.textContent || '')) {
        small.textContent = '点左侧「本地抖音采集」，在内置浏览器打开同行主页后点「采集当前主页」；作品会自动下载和转写。';
      }
      const actions = bar.querySelector('.wb-actions');
      if (actions && !actions.querySelector('[data-desktop-open-collector]')) {
        actions.innerHTML = '<button class="btn primary" type="button" data-desktop-open-collector>打开本地采集</button>';
        actions.querySelector('[data-desktop-open-collector]')?.addEventListener('click', () => window.junshiDesktop?.openCollector?.());
      }
    };
    const patchDesktopActions = () => {
      if (window.__JUNSHI_DESKTOP_ACTIONS__) return;
      window.__JUNSHI_DESKTOP_ACTIONS__ = true;
      document.addEventListener('click', (event) => {
        const selfHelp = event.target?.closest?.('[data-review-action="self-help"]');
        if (selfHelp && window.junshiDesktop?.openCollectorSelf) {
          event.preventDefault();
          event.stopImmediatePropagation();
          window.junshiDesktop.openCollectorSelf();
        }
      }, true);
    };
    const paintCollectorState = (status) => {
      window.__JUNSHI_COLLECTOR_STATE__ = status;
      const button = document.querySelector('#desktop-local-collector');
      if (!button) return;
      const dot = button.querySelector('.desktop-collector-dot');
      const text = button.querySelector('.desktop-collector-text');
      if (dot) dot.className = 'desktop-collector-dot' + (status?.sync?.running ? ' running' : status?.pairing?.connected ? ' ready' : '');
      if (text) text.textContent = status?.sync?.running ? '本地同步中' : '本地抖音采集';
      button.title = status?.sync?.message || '打开本地抖音采集';
    };
    const ensureCollectorButton = () => {
      const tabs = document.querySelector('#wb-tabs');
      if (!tabs) return;
      let button = document.querySelector('#desktop-local-collector');
      if (!button) {
        button = document.createElement('button');
        button.id = 'desktop-local-collector';
        button.type = 'button';
        button.className = 'desktop-collector-button';
        button.innerHTML = '<span class="desktop-collector-dot"></span><span class="desktop-collector-text">本地抖音采集</span><span class="desktop-collector-spark">↗</span>';
        button.addEventListener('click', () => window.junshiDesktop?.openCollector?.());
        tabs.insertAdjacentElement('afterend', button);
        window.junshiDesktop?.onCollectorStatus?.((status) => paintCollectorState(status));
        window.junshiDesktop?.getCollectorStatus?.().then(paintCollectorState).catch(() => {});
      }
      if (window.__JUNSHI_COLLECTOR_STATE__) paintCollectorState(window.__JUNSHI_COLLECTOR_STATE__);
    };
    decorate();
    let scheduled = false;
    const scheduleDecorate = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; decorate(); });
    };
    const observer = new MutationObserver(scheduleDecorate);
    observer.observe(document.body, { childList: true, subtree: true });
    let tries = 0;
    const timer = setInterval(() => {
      const nav = document.querySelector('.navitem[data-screen="workbench"]');
      if (nav) nav.click();
      decorate();
      const screen = document.querySelector('#scr-workbench');
      tries += 1;
      if ((screen && !screen.hidden) || tries >= 40) clearInterval(timer);
    }, 250);
    return true;
  })()`;
}

async function openWorkbenchWindow() {
  if (!sessionIsUsable(storedSession)) {
    await showLoginWindow({ force: true });
    return;
  }
  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    if (workbenchWindow.isMinimized()) workbenchWindow.restore();
    workbenchWindow.show();
    workbenchWindow.focus();
    return workbenchWindow;
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#07111d',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'app-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  workbenchWindow = win;
  attachTrayCloseBehavior(win);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (workbenchWindow === win) workbenchWindow = null;
    for (const controller of chatControllers.values()) controller.abort();
    chatControllers.clear();
  });
  await win.loadFile(path.join(import.meta.dirname, 'app.html'));
  return win;
}

async function openCollectorWindow() {
  if (!sessionIsUsable(storedSession)) {
    await showLoginWindow({ force: true });
    return;
  }
  if (collectorWindow && !collectorWindow.isDestroyed()) {
    if (collectorWindow.isMinimized()) collectorWindow.restore();
    collectorWindow.show();
    collectorWindow.focus();
    return collectorWindow;
  }
  const win = new BrowserWindow({
    width: 1480,
    height: 930,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#050d17',
    title: `${APP_NAME} · 本地抖音采集`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'collector-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  collectorWindow = win;
  win.removeMenu();
  attachTrayCloseBehavior(win);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (collectorWindow === win) collectorWindow = null;
    collectorGuest = null;
  });
  win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    params.partition = DOUYIN_PARTITION;
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    collectorGuest = guest;
    configureDouyinContents(guest, { visible: true });
    const target = pendingCollectorUrl || settings.lastCollectorUrl || DOUYIN_HOME;
    pendingCollectorUrl = '';
    if (target && target !== guest.getURL()) {
      resetCapture(guest, normalizeSecUserId(target));
      void guest.loadURL(target).catch((error) => console.warn('[junshi-desktop] 打开抖音失败:', error?.message || error));
    }
  });
  await win.loadFile(path.join(import.meta.dirname, 'collector.html'));
  return win;
}

async function showLoginWindow({ force = false } = {}) {
  if (!force && sessionIsUsable(storedSession)) {
    await openWorkbenchWindow();
    return;
  }
  if (loginWindow && !loginWindow.isDestroyed()) {
    if (loginWindow.isMinimized()) loginWindow.restore();
    loginWindow.show();
    loginWindow.focus();
    return loginWindow;
  }
  const win = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#111827',
    title: `${APP_NAME} · 账号登录`,
    autoHideMenuBar: true,
    webPreferences: {
      partition: LOGIN_PARTITION,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  loginWindow = win;
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (loginWindow === win) loginWindow = null;
    if (!workbenchWindow && !sessionIsUsable(storedSession)) app.quit();
  });
  await win.loadFile(path.join(import.meta.dirname, 'login.html'));
  return win;
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: storedSession ? '打开内容工作台' : '登录招生军师', click: () => void (storedSession ? openWorkbenchWindow() : showLoginWindow({ force: true })) },
    { label: '本地抖音采集', click: () => void openCollectorWindow() },
    { label: runtime.sync.running ? `同步中 ${runtime.sync.done}/${runtime.sync.total}` : '立即同步全部同行', enabled: Boolean(storedSession) && !runtime.sync.running, click: () => void syncAllPeers('manual') },
    { type: 'separator' },
    { label: '定时同步同行', type: 'checkbox', checked: settings.autoSyncEnabled, enabled: Boolean(storedSession), click: (item) => void updateSettings({ autoSyncEnabled: item.checked }) },
    { label: '开机启动', type: 'checkbox', checked: settings.launchAtLogin, click: (item) => void updateSettings({ launchAtLogin: item.checked }) },
    { label: '同步完成通知', type: 'checkbox', checked: settings.notificationsEnabled, click: (item) => void updateSettings({ notificationsEnabled: item.checked }) },
    { type: 'separator' },
    { label: '检查更新', click: () => void checkForUpdates({ manual: true }) },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.setToolTip(`${APP_NAME}${runtime.sync.running ? ' · 同步中' : ''}`);
}

function ensureTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(import.meta.dirname, '..', 'assets', 'icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.on('click', () => void (sessionIsUsable(storedSession) ? openWorkbenchWindow() : showLoginWindow({ force: true })));
  tray.on('double-click', () => void openWorkbenchWindow());
  rebuildTrayMenu();
}

function applyLaunchAtLogin() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchAtLogin), path: process.execPath, args: ['--hidden'] });
  } catch (error) {
    console.warn('[junshi-desktop] 设置开机启动失败:', error?.message || error);
  }
}

function nextAutoSyncAt() {
  if (!settings.autoSyncEnabled) return null;
  const base = Date.parse(settings.lastAutoSyncAt || '') || Date.now();
  return base + Math.max(6, Number(settings.intervalHours) || 24) * 3600 * 1000;
}

function startAutoScheduler() {
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  autoSyncTimer = setInterval(() => {
    if (!settings.autoSyncEnabled || !sessionIsUsable(storedSession) || syncPromise) return;
    const next = nextAutoSyncAt();
    if (next && Date.now() >= next) void syncAllPeers('auto');
  }, 60_000);
  setTimeout(() => {
    if (!settings.autoSyncEnabled || !sessionIsUsable(storedSession) || syncPromise) return;
    const next = nextAutoSyncAt();
    if (next && Date.now() >= next) void syncAllPeers('auto');
  }, 35_000).unref?.();
}

function friendlyUpdateError(error) {
  const raw = String(error?.message || error || '未知错误');
  if (/404|Cannot find channel|latest\.yml/i.test(raw)) return '更新源尚未配置（latest.yml 404）';
  return `更新检查失败：${raw.split(/\r?\n/)[0].slice(0, 180)}`;
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('checking-for-update', () => {
      runtime.update = { status: 'checking', message: '正在检查更新…', version: runtime.update.version };
      broadcastCollectorStatus(true);
    });
    updater.on('update-available', (info) => {
      runtime.update = { status: 'available', message: `发现 v${info.version}，正在下载`, version: info.version };
      broadcastCollectorStatus(true);
      rebuildTrayMenu();
    });
    updater.on('update-not-available', () => {
      runtime.update = { status: 'idle', message: '已是最新版本', version: '' };
      broadcastCollectorStatus(true);
    });
    updater.on('download-progress', (progress) => {
      runtime.update = { status: 'downloading', message: `正在下载更新 ${Math.round(progress.percent || 0)}%`, version: runtime.update.version };
      broadcastCollectorStatus();
    });
    updater.on('update-downloaded', (info) => {
      runtime.update = { status: 'downloaded', message: `v${info.version} 已下载，重启后安装`, version: info.version };
      broadcastCollectorStatus(true);
      notify('更新已下载', `v${info.version} 重启后自动安装`, () => void openCollectorWindow());
    });
    updater.on('error', (error) => {
      console.warn('[junshi-desktop] 自动更新失败:', error?.message || error);
      runtime.update = { status: 'error', message: friendlyUpdateError(error), version: runtime.update.version };
      broadcastCollectorStatus(true);
    });
    setTimeout(() => void checkForUpdates({ manual: false }), 15_000).unref?.();
    autoUpdateTimer = setInterval(() => {
      if (settings.autoUpdateEnabled) void checkForUpdates({ manual: false });
    }, 6 * 3600 * 1000);
    autoUpdateTimer.unref?.();
  } catch (error) {
    runtime.update = { status: 'error', message: `更新组件不可用：${error?.message || error}`, version: '' };
  }
}

async function checkForUpdates({ manual = false } = {}) {
  if (!app.isPackaged) {
    runtime.update = { status: 'dev', message: '开发模式不检查更新', version: '' };
    broadcastCollectorStatus(true);
    return { ok: true, message: runtime.update.message };
  }
  if (!updater) {
    runtime.update = { status: 'error', message: '更新组件未初始化', version: '' };
    broadcastCollectorStatus(true);
    return { ok: false, message: runtime.update.message };
  }
  try {
    await updater.checkForUpdates();
    return { ok: true, message: '正在检查更新' };
  } catch (error) {
    console.warn('[junshi-desktop] 更新检查失败:', error?.message || error);
    runtime.update = { status: 'error', message: friendlyUpdateError(error), version: runtime.update.version };
    broadcastCollectorStatus(true);
    if (manual) notify('更新检查失败', runtime.update.message, () => void openCollectorWindow());
    return { ok: false, message: runtime.update.message };
  }
}

function isAppSender(event) {
  return Boolean(workbenchWindow && !workbenchWindow.isDestroyed() && event.sender === workbenchWindow.webContents);
}

function sendAppChatEvent(sender, requestId, type, data = null) {
  try {
    if (!sender.isDestroyed()) sender.send('junshi:app-chat-event', { requestId, type, data });
  } catch {}
}

function parseSseBlock(block) {
  let eventType = 'message';
  const dataLines = [];
  for (const line of String(block || '').split(/\r?\n/)) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join('\n');
  try { return { type: eventType, data: JSON.parse(raw) }; }
  catch { return { type: eventType, data: { text: raw } }; }
}

async function streamWorkbenchChat(event, payload = {}) {
  const requestId = String(payload.requestId || '').slice(0, 80);
  const message = String(payload.message || '').trim();
  if (!requestId) throw new Error('缺少请求编号');
  if (!message) throw new Error('请先输入你想做什么');
  if (!sessionIsUsable(storedSession)) throw new Error('登录已过期，请重新登录');
  const controller = new AbortController();
  chatControllers.set(requestId, controller);
  const sender = event.sender;
  void (async () => {
    try {
      const response = await fetch(`${API_BASE}/api/junshi/workbench/chat/stream`, {
        method: 'POST',
        headers: { authorization: `Bearer ${storedSession.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          accountId: String(payload.accountId || 'default'),
          tier: payload.tier === 'deep' ? 'deep' : 'standard',
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let detail = '';
        try { detail = JSON.parse(text)?.error?.message || JSON.parse(text)?.message || ''; } catch {}
        throw new Error(detail || `生成失败（HTTP ${response.status}）`);
      }
      if (!response.body) throw new Error('生成服务没有返回内容');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let splitAt = buffer.indexOf('\n\n');
        while (splitAt >= 0) {
          const block = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt + 2);
          const parsed = parseSseBlock(block);
          if (parsed) sendAppChatEvent(sender, requestId, parsed.type, parsed.data);
          splitAt = buffer.indexOf('\n\n');
        }
      }
      const tail = parseSseBlock(buffer.replace(/\r\n/g, '\n'));
      if (tail) sendAppChatEvent(sender, requestId, tail.type, tail.data);
    } catch (error) {
      if (controller.signal.aborted) sendAppChatEvent(sender, requestId, 'stopped', { partial: true });
      else sendAppChatEvent(sender, requestId, 'error', { message: String(error?.message || error) });
    } finally {
      chatControllers.delete(requestId);
      sendAppChatEvent(sender, requestId, 'closed');
    }
  })();
  return { ok: true, requestId };
}
function isCollectorSender(event) {
  return Boolean(collectorWindow && !collectorWindow.isDestroyed() && event.sender === collectorWindow.webContents);
}

function registerIpc() {
  if (ipcReady) return;
  ipcReady = true;
  ipcMain.handle('junshi:bootstrap', async () => ({
    appVersion: app.getVersion(),
    siteUrl: API_BASE,
    signedIn: sessionIsUsable(storedSession),
    user: publicUser(storedSession),
  }));
  ipcMain.handle('junshi:login', async (_event, payload) => {
    const login = String(payload?.login || '').trim();
    const password = String(payload?.password || '');
    const mfaCode = String(payload?.mfaCode || '').trim();
    if (!login || !password) return { ok: false, message: '请输入账号和密码' };
    try {
      const result = await loginWithPlatform(login, password, mfaCode);
      if (!result.ok) return result;
      const loginWin = loginWindow;
      loginWindow = null;
      if (loginWin && !loginWin.isDestroyed()) loginWin.close();
      await openWorkbenchWindow();
      return result;
    } catch (error) {
      const reason = error?.cause?.code ? `${error.message} (${error.cause.code})` : String(error?.message || error);
      return { ok: false, message: reason };
    }
  });
  ipcMain.handle('junshi:app-bootstrap', async (event) => {
    if (!isAppSender(event)) throw new Error('无权读取客户端状态');
    return {
      signedIn: sessionIsUsable(storedSession),
      version: app.getVersion(),
      user: publicUser(storedSession),
      organization: storedSession?.organization || null,
      expiresAt: storedSession?.expiresAt || null,
    };
  });
  ipcMain.handle('junshi:app-api', async (event, payload) => {
    if (!isAppSender(event)) throw new Error('无权访问平台数据');
    const apiPath = String(payload?.path || '');
    if (!apiPath.startsWith('/') || apiPath.includes('..') || /:\/\//.test(apiPath)) throw new Error('接口地址不合法');
    const options = payload?.options && typeof payload.options === 'object' ? payload.options : {};
    const method = ['GET', 'POST', 'PUT', 'DELETE'].includes(String(options.method || 'GET').toUpperCase())
      ? String(options.method || 'GET').toUpperCase() : 'GET';
    try {
      const data = await apiFetch(apiPath, {
        method,
        auth: 'session',
        body: method === 'GET' ? undefined : options.body,
        timeout: Math.max(10_000, Math.min(120_000, Number(options.timeout) || 45_000)),
      });
      return { ok: true, data };
    } catch (error) {
      return { ok: false, message: String(error?.message || error), status: Number(error?.status) || 0, code: String(error?.code || '') };
    }
  });
  ipcMain.handle('junshi:app-resolve-douyin-link', async (event, payload) => {
    if (!isAppSender(event)) throw new Error('无权解析抖音链接');
    try {
      return await importDouyinLink(payload?.shareText);
    } catch (error) {
      return { ok: false, message: String(error?.message || error) };
    }
  });
  ipcMain.handle('junshi:app-upload-asset', async (event, payload) => {
    if (!isAppSender(event)) throw new Error('无权上传制作素材');
    if (!sessionIsUsable(storedSession)) return { ok: false, message: '登录已过期，请重新登录' };
    const kind = ['image', 'audio', 'video'].includes(String(payload?.kind || '')) ? String(payload.kind) : 'image';
    const filters = kind === 'image'
      ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
      : kind === 'audio'
        ? [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg'] }]
        : [{ name: '视频', extensions: ['mp4', 'mov', 'webm'] }];
    const picked = await dialog.showOpenDialog(workbenchWindow, { title: kind === 'image' ? '选择形象照' : kind === 'audio' ? '选择音色参考音频' : '选择视频', properties: ['openFile'], filters });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: true, canceled: true };
    const filePath = picked.filePaths[0];
    try {
      const buffer = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' })[ext] || 'application/octet-stream';
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mime }), path.basename(filePath));
      form.append('accountId', 'default');
      form.append('folder', String(payload?.folder || (kind === 'image' ? '形象照' : kind === 'audio' ? '音色参考' : '本地上传')).slice(0, 120));
      const response = await fetch(`${API_BASE}/api/junshi/workbench/assets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${storedSession.token}` },
        body: form,
        signal: AbortSignal.timeout(600_000),
      });
      const data = await parseApiResponse(response);
      return { ok: true, canceled: false, asset: data?.asset || null, path: filePath };
    } catch (error) {
      return { ok: false, message: String(error?.message || error) };
    }
  });
  ipcMain.handle('junshi:app-download-asset', async (event, payload) => {
    if (!isAppSender(event)) throw new Error('无权下载制作文件');
    if (!sessionIsUsable(storedSession)) return { ok: false, message: '登录已过期，请重新登录' };
    const assetId = String(payload?.assetId || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(assetId)) return { ok: false, message: '素材编号不合法' };
    const fallbackName = `junshi-${assetId}`;
    const requestedName = String(payload?.filename || fallbackName).replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 180) || fallbackName;
    try {
      const response = await fetch(`${API_BASE}/api/junshi/workbench/assets/${encodeURIComponent(assetId)}/file`, {
        headers: { authorization: `Bearer ${storedSession.token}` },
        signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let message = '';
        try { message = JSON.parse(text)?.error?.message || JSON.parse(text)?.message || ''; } catch {}
        throw new Error(message || `下载失败（HTTP ${response.status}）`);
      }
      const name = /\.[A-Za-z0-9]{2,6}$/.test(requestedName) ? requestedName : `${requestedName}.mp4`;
      const picked = await dialog.showSaveDialog(workbenchWindow, {
        title: '保存制作文件',
        defaultPath: path.join(app.getPath('downloads'), name),
      });
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(picked.filePath, buffer);
      return { ok: true, canceled: false, path: picked.filePath, size: buffer.length };
    } catch (error) {
      return { ok: false, message: String(error?.message || error) };
    }
  });
  ipcMain.handle('junshi:app-chat', async (event, payload) => {
    if (!isAppSender(event)) throw new Error('无权发起生成');
    try {
      return await streamWorkbenchChat(event, payload || {});
    } catch (error) {
      return { ok: false, message: String(error?.message || error) };
    }
  });
  ipcMain.handle('junshi:app-chat-cancel', async (event, payload) => {
    if (!isAppSender(event)) throw new Error('无权取消生成');
    const controller = chatControllers.get(String(payload?.requestId || ''));
    if (controller) controller.abort();
    return { ok: true };
  });
  ipcMain.handle('junshi:open-workbench', async () => { await openWorkbenchWindow(); return { ok: true }; });
  ipcMain.handle('junshi:open-collector', async () => { await openCollectorWindow(); return { ok: true }; });
  ipcMain.handle('junshi:open-collector-self', async () => { await openCollectorWindow(); return await openSelfProfile(); });
  ipcMain.handle('junshi:clear-session', async () => {
    await clearStoredSession();
    for (const controller of chatControllers.values()) controller.abort();
    chatControllers.clear();
    if (workbenchWindow && !workbenchWindow.isDestroyed()) workbenchWindow.close();
    if (collectorWindow && !collectorWindow.isDestroyed()) collectorWindow.close();
    await showLoginWindow({ force: true });
    return { ok: true };
  });
  ipcMain.handle('junshi:collector-status', async (event) => {
    if (event.sender !== collectorWindow?.webContents && event.sender !== workbenchWindow?.webContents) throw new Error('无权读取采集状态');
    return buildCollectorStatus();
  });
  ipcMain.handle('junshi:collector-open-url', async (event, payload) => {
    if (!isCollectorSender(event) && !isAppSender(event)) throw new Error('无权操作本地浏览器');
    try {
      return await openCollectorUrl(payload?.url);
    } catch (error) {
      return { ok: false, message: String(error?.message || error), status: buildCollectorStatus() };
    }
  });
  ipcMain.handle('junshi:collector-open-self', async (event) => {
    if (!isCollectorSender(event)) throw new Error('无权操作本地浏览器');
    try {
      return await openSelfProfile();
    } catch (error) {
      return { ok: false, message: String(error?.message || error), status: buildCollectorStatus() };
    }
  });
  ipcMain.handle('junshi:collector-capture', async (event, payload) => {
    if (!isCollectorSender(event)) throw new Error('无权操作本地浏览器');
    const mode = payload?.mode === 'self' ? 'self' : 'peer';
    try {
      return await collectVisiblePage(mode);
    } catch (error) {
      return { ok: false, message: String(error?.message || error), status: buildCollectorStatus() };
    }
  });
  ipcMain.handle('junshi:collector-sync-all', async (event) => {
    if (event.sender !== collectorWindow?.webContents && event.sender !== workbenchWindow?.webContents) throw new Error('无权触发同步');
    return await syncAllPeers('manual');
  });
  ipcMain.handle('junshi:collector-update-settings', async (event, patch) => {
    if (!isCollectorSender(event) && !isAppSender(event)) throw new Error('无权修改本地设置');
    return await updateSettings(patch || {});
  });
  ipcMain.handle('junshi:check-updates', async (event, payload) => {
    if (event.sender !== collectorWindow?.webContents && event.sender !== workbenchWindow?.webContents) throw new Error('无权检查更新');
    return await checkForUpdates({ manual: payload?.manual !== false });
  });
  ipcMain.handle('junshi:install-update', async (event) => {
    if (event.sender !== collectorWindow?.webContents && event.sender !== workbenchWindow?.webContents) throw new Error('无权安装更新');
    if (!updater || runtime.update.status !== 'downloaded') return { ok: false, message: '还没有下载好的更新' };
    isQuitting = true;
    updater.quitAndInstall(false, true);
    return { ok: true };
  });
}

app.on('second-instance', () => {
  const target = collectorWindow || workbenchWindow || loginWindow;
  if (target && !target.isDestroyed()) {
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  } else if (storedSession) void openWorkbenchWindow();
  else void showLoginWindow({ force: true });
});

app.on('before-quit', () => { isQuitting = true; });

app.whenReady().then(async () => {
  await loadSettings();
  registerIpc();
  installMenu();
  ensureTray();
  applyLaunchAtLogin();
  const douyinSession = session.fromPartition(DOUYIN_PARTITION);
  douyinSession.setUserAgent(DOUYIN_USER_AGENT, 'zh-CN,zh;q=0.9,en;q=0.8');
  douyinSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(['clipboard-sanitized-write'].includes(permission)));
  session.fromPartition(WORKBENCH_PARTITION).setPermissionRequestHandler((_webContents, permission, callback) => callback(['notifications', 'clipboard-sanitized-write'].includes(permission)));
  if (!app.isPackaged && process.env.JUNSHI_TEST_SESSION_JSON) {
    try {
      const testSession = JSON.parse(process.env.JUNSHI_TEST_SESSION_JSON);
      if (sessionIsUsable(testSession)) storedSession = testSession;
    } catch {
      console.warn('[junshi-desktop] JUNSHI_TEST_SESSION_JSON 不是有效 JSON');
    }
  }
  if (!storedSession) storedSession = await readStoredSession();
  assistantCredential = await readAssistantCredential();
  if (assistantCredential?.token) runtime.pairing = { connected: true, connecting: false, error: '' };
  setupAutoUpdater();
  startAutoScheduler();
  if (storedSession) {
    if (TEST_OPEN_COLLECTOR) await openCollectorWindow();
    else if (!START_HIDDEN) await openWorkbenchWindow();
    if (!TEST_OPEN_COLLECTOR) void primeAssistantPairing();
  } else {
    await showLoginWindow({ force: true });
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length) return;
  if (storedSession) void openWorkbenchWindow();
  else void showLoginWindow({ force: true });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !sessionIsUsable(storedSession)) app.quit();
});

















