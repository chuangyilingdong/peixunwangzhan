/** 扩展后台：只做配对/上报的网络代理，不读任何页面内容。 */
const DEFAULT_API = 'https://aicyld.com';

async function apiBase() {
  const stored = await chrome.storage.local.get(['apiBase']);
  return (stored.apiBase || DEFAULT_API).replace(/\/+$/, '');
}
async function token() {
  const stored = await chrome.storage.local.get(['token']);
  return stored.token || '';
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return;
  (async () => {
    try {
      const base = await apiBase();
      if (message.type === 'pair') {
        const response = await fetch(base + '/api/junshi/workbench/douyin/assistant/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: message.code, device: message.device || '' })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error((data.error && data.error.message) || '配对失败');
        await chrome.storage.local.set({ token: data.data.token, apiBase: message.apiBase || base });
        sendResponse({ ok: true });
        return;
      }
      if (message.type === 'ingest') {
        const saved = await token();
        if (!saved) throw new Error('还没配对：先在扩展里输入工作台生成的配对码');
        const response = await fetch(base + '/api/junshi/workbench/douyin/assistant/ingest', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + saved },
          body: JSON.stringify(message.payload)
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error((data.error && data.error.message) || '上报失败');
        sendResponse({ ok: true, data: data.data });
        return;
      }
      if (message.type === 'status') {
        const saved = await token();
        sendResponse({ paired: !!saved, apiBase: base });
        return;
      }
    } catch (error) {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    }
  })();
  return true;
});
