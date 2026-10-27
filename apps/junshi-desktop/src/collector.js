const api = window.junshiCollector;
const $ = (selector) => document.querySelector(selector);
const browser = $('#douyin-browser');

let state = null;
let toastTimer = null;

function toast(message, kind = '') {
  const node = $('#toast');
  node.textContent = message || '';
  node.className = `toast ${kind} show`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 4200);
}

function formatTime(value) {
  if (!value) return '还没有运行过';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function setPageState(url) {
  if (!url) return;
  $('#target-input').value = url;
  try {
    $('#address-host').textContent = new URL(url).hostname;
  } catch {
    $('#address-host').textContent = 'www.douyin.com';
  }
  $('#go-back').disabled = !browser.canGoBack?.();
  $('#go-forward').disabled = !browser.canGoForward?.();
}

function applyStatus(next) {
  if (!next) return;
  state = next;
  const pairing = next.pairing || {};
  const sync = next.sync || {};
  const capture = next.capture || {};
  const settings = next.settings || {};
  const update = next.update || {};

  $('#version-chip').textContent = `v${next.version || '0.1.0'}`;
  const pairingChip = $('#pairing-chip');
  if (pairing.connected) {
    pairingChip.textContent = '平台已连接';
    pairingChip.className = 'chip';
  } else if (pairing.connecting) {
    pairingChip.textContent = '正在连接平台…';
    pairingChip.className = 'chip warn';
  } else {
    pairingChip.textContent = pairing.error ? '连接异常' : '尚未连接';
    pairingChip.className = `chip ${pairing.error ? 'bad' : 'warn'}`;
  }
  pairingChip.title = pairing.error || '';

  $('#capture-count').textContent = `${Number(capture.count || 0)} 条作品`;
  $('#capture-dot').className = `dot ${capture.count ? 'live' : ''}`.trim();
  $('#capture-summary').textContent = capture.count
    ? `${capture.nickname || '当前主页'} · ${capture.count} 条，最近 ${formatTime(capture.updatedAt)}`
    : '还没有读取到作品';

  $('#auto-sync').checked = Boolean(settings.autoSyncEnabled);
  $('#launch-at-login').checked = Boolean(settings.launchAtLogin);
  $('#notifications').checked = settings.notificationsEnabled !== false;
  $('#close-to-tray').checked = settings.closeToTray !== false;
  $('#interval-hours').value = String(settings.intervalHours || 24);

  const syncDot = $('#sync-dot');
  syncDot.className = `status-dot ${sync.running ? 'running' : (next.lastSync?.ok === false ? 'bad' : next.lastSync ? 'ok' : '')}`.trim();
  $('#last-sync-text').textContent = next.lastSync?.at ? `${formatTime(next.lastSync.at)} · ${next.lastSync.ok ? '成功' : '失败'}` : '还没有运行过';
  $('#sync-message').textContent = sync.message || next.lastSync?.message || '等待同步任务';
  const pct = sync.total ? Math.min(100, Math.round((Number(sync.done || 0) / Number(sync.total || 1)) * 100)) : (sync.running ? 8 : 0);
  $('#sync-progress').style.width = `${pct}%`;

  const busy = Boolean(sync.running || capture.collecting);
  ['#collect-peer', '#open-self', '#collect-self', '#sync-all'].forEach((selector) => { $(selector).disabled = busy; });
  $('#open-target').disabled = Boolean(sync.running);
  $('#sync-all').textContent = sync.running ? `同步中 ${Number(sync.done || 0)}/${Number(sync.total || 0)}` : '同步工作台里的全部同行';

  $('#update-text').textContent = update.message || '自动检查已开启';
  $('#install-update').classList.toggle('hidden', update.status !== 'downloaded');
  $('#check-update').disabled = update.status === 'checking' || update.status === 'downloading';

  if (next.browser?.url) setPageState(next.browser.url);
  if (next.browser?.loading) $('#loading-indicator').textContent = '加载中…';
  else $('#loading-indicator').textContent = '';
}

async function runAction(button, action, successText, followupText = '') {
  if (button) button.disabled = true;
  try {
    const result = await action();
    if (result?.ok === false) throw new Error(result.message || '操作失败');
    if (successText || followupText) toast([result?.message || successText, followupText].filter(Boolean).join(' '), 'success');
    if (result?.status) applyStatus(result.status);
    return result;
  } catch (error) {
    toast(String(error?.message || error), 'error');
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function bindBrowserEvents() {
  browser.addEventListener('dom-ready', () => {
    $('#browser-overlay').classList.add('hidden');
    setPageState(browser.getURL());
  });
  browser.addEventListener('did-start-loading', () => {
    $('#loading-indicator').textContent = '加载中…';
    $('#browser-overlay').classList.remove('hidden');
  });
  browser.addEventListener('did-stop-loading', () => {
    $('#loading-indicator').textContent = '';
    $('#browser-overlay').classList.add('hidden');
    setPageState(browser.getURL());
  });
  browser.addEventListener('did-navigate', (event) => setPageState(event.url));
  browser.addEventListener('did-navigate-in-page', (event) => setPageState(event.url));
  browser.addEventListener('did-fail-load', (event) => {
    if (event.errorCode === -3) return;
    $('#browser-overlay').classList.add('hidden');
    toast(`页面加载失败：${event.errorDescription || event.errorCode}`, 'error');
  });
  browser.addEventListener('page-title-updated', (event) => {
    $('#page-state').textContent = String(event.title || '').slice(0, 80) || '抖音';
  });
}

function bindControls() {
  $('#open-target').addEventListener('click', () => runAction($('#open-target'), () => api.openUrl($('#target-input').value), '已打开主页'));
  $('#target-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#open-target').click();
  });
  $('#go-back').addEventListener('click', () => browser.canGoBack?.() && browser.goBack());
  $('#go-forward').addEventListener('click', () => browser.canGoForward?.() && browser.goForward());
  $('#reload').addEventListener('click', () => browser.reload());
  $('#collect-peer').addEventListener('click', () => runAction($('#collect-peer'), () => api.collect('peer'), '同行作品已上报。', '正在后台下载和转写；完成后回工作台点“参考这条写一条”。'));
  $('#open-self').addEventListener('click', () => runAction($('#open-self'), () => api.openSelf(), '已打开我的主页。', '下一步：点“采集我的作品”。'));
  $('#collect-self').addEventListener('click', () => runAction($('#collect-self'), () => api.collect('self'), '自己的作品已上报。', '回到工作台「我的数据」后点“生成数据建议”。'));
  $('#sync-all').addEventListener('click', () => runAction($('#sync-all'), () => api.syncAll(), '已开始同步。', '完成后回工作台查看转写结果。'));
  $('#open-workbench').addEventListener('click', () => api.openWorkbench());

  $('#auto-sync').addEventListener('change', (event) => api.updateSettings({ autoSyncEnabled: event.target.checked }));
  $('#launch-at-login').addEventListener('change', (event) => api.updateSettings({ launchAtLogin: event.target.checked }));
  $('#notifications').addEventListener('change', (event) => api.updateSettings({ notificationsEnabled: event.target.checked }));
  $('#close-to-tray').addEventListener('change', (event) => api.updateSettings({ closeToTray: event.target.checked }));
  $('#interval-hours').addEventListener('change', (event) => api.updateSettings({ intervalHours: Number(event.target.value) }));
  $('#check-update').addEventListener('click', () => runAction($('#check-update'), () => api.checkForUpdates(), '正在检查更新'));
  $('#install-update').addEventListener('click', () => api.installUpdate());
}

async function bootstrap() {
  if (!api) {
    toast('客户端桥接未加载，请重新安装客户端', 'error');
    return;
  }
  bindBrowserEvents();
  bindControls();
  api.onStatus((next) => applyStatus(next));
  try {
    applyStatus(await api.getStatus());
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

bootstrap();




