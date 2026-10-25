/** 隔离世界：把页面主世界的采集结果转给扩展 popup（主世界没有 chrome.runtime）。 */
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'collect') return;
  var done = false;
  function onResult(event) {
    if (done) return;
    done = true;
    window.removeEventListener('zcode-douyin-result', onResult);
    try { sendResponse(JSON.parse(event.detail)); } catch (error) { sendResponse({ error: 'bad_payload' }); }
  }
  window.addEventListener('zcode-douyin-result', onResult);
  window.dispatchEvent(new CustomEvent('zcode-douyin-collect'));
  setTimeout(function () {
    if (done) return;
    done = true;
    window.removeEventListener('zcode-douyin-result', onResult);
    sendResponse({ error: 'nothing_captured' });
  }, 4000);
  return true;
});
