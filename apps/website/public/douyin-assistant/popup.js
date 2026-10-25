const $ = (s) => document.querySelector(s);
function say(text, kind) { const el = $('#msg'); el.textContent = text || ''; el.className = kind || ''; }

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  $('#paired-view').classList.toggle('hide', !status.paired);
  $('#pair-view').classList.toggle('hide', !!status.paired);
}

$('#pair').addEventListener('click', async () => {
  const code = ($('#code').value || '').trim().toUpperCase();
  if (code.length !== 6) { say('配对码是 6 位', 'err'); return; }
  $('#pair').disabled = true;
  say('正在配对…');
  const result = await chrome.runtime.sendMessage({ type: 'pair', code, device: navigator.userAgent.slice(0, 120) });
  $('#pair').disabled = false;
  if (result.ok) { say('配对成功', 'ok'); await refresh(); } else say(result.error, 'err');
});

async function collect(mode) {
  const isSelf = mode === 'self';
  const button = isSelf ? $('#collect-self') : $('#collect');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.douyin\.com\//.test(tab.url || '')) {
    say(isSelf ? '请先在抖音网页打开你自己的主页（点右下角「我」）' : '请先在抖音网页打开一个同行主页', 'err');
    return;
  }
  button.disabled = true;
  say('正在读取本页作品…');
  let payload = null;
  try {
    payload = await chrome.tabs.sendMessage(tab.id, { type: 'collect' });
  } catch (error) {
    say('这个页面还没加载采集脚本，刷新一下抖音页面再试', 'err');
    button.disabled = false;
    return;
  }
  if (!payload || payload.error || !(payload.works || []).length) {
    say(isSelf ? '没读到作品：确认已进入自己的主页并往下滚动加载一些作品后重试' : '没读到作品：确认已打开「主页」并往下滚动加载一些作品后重试', 'err');
    button.disabled = false;
    return;
  }
  payload.mode = mode;
  say('读到 ' + payload.works.length + ' 条，正在同步…');
  const result = await chrome.runtime.sendMessage({ type: 'ingest', payload });
  button.disabled = false;
  if (result.ok) {
    if (isSelf) say('已同步 ' + result.data.accepted + ' 条作品数据（新增 ' + result.data.created + ' / 更新 ' + result.data.updated + '），数据复盘已更新', 'ok');
    else say('已同步 ' + result.data.accepted + ' 条，服务器正在下载转写', 'ok');
  } else say(result.error, 'err');
}
$('#collect').addEventListener('click', () => collect('peer'));
$('#collect-self').addEventListener('click', () => collect('self'));

$('#unpair').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token']);
  say('已断开', 'ok');
  await refresh();
});

refresh();
