/**
 * 在页面主世界（MAIN world）里旁路抖音自己的作品列表请求：
 * 页面会自己发 /aweme/v1/web/aweme/post（带签名），我们只旁路读取响应，
 * 不伪造请求、不改动页面行为。
 */
(function () {
  if (window.__zcodeDouyinAssistant) return;
  window.__zcodeDouyinAssistant = true;

  var captured = { secUserId: '', nickname: '', works: [], at: 0 };

  function pickProfile(data, accountId) {
    var author = (data && data.author) || {};
    var list = (data && data.aweme_list) || [];
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (!item || !item.aweme_id) continue;
      if (accountId && (item.author || {}).sec_uid && (item.author || {}).sec_uid !== accountId) continue;
      var video = item.video || {};
      var play = (video.play_addr || video.playAddr || {}).url_list || [];
      var stats = item.statistics || {};
      out.push({
        awemeId: String(item.aweme_id),
        desc: String(item.desc || '').slice(0, 300),
        playUrl: String(play[0] || ''),
        durationMs: Number(video.duration) || null,
        stats: {
          digg: Number(stats.digg_count) || 0,
          comment: Number(stats.comment_count) || 0,
          share: Number(stats.share_count) || 0,
          collect: Number(stats.collect_count) || 0
        }
      });
    }
    if (!out.length) return;
    captured.secUserId = String(accountId || '');
    captured.nickname = String(author.nickname || window.__zcodeDouyinNickname || '');
    // 合并多页：同一 awemeId 只留一份
    var seen = {};
    var merged = [];
    var all = out.concat(captured.works);
    for (var k = 0; k < all.length; k += 1) {
      if (!seen[all[k].awemeId]) { seen[all[k].awemeId] = 1; merged.push(all[k]); }
    }
    captured.works = merged.slice(0, 60);
    captured.at = Date.now();
  }

  function matchSecUserId(url) {
    try {
      var parsed = new URL(url, location.origin);
      // 真实路径带尾斜杠（/aweme/v1/web/aweme/post/），别用精确相等（2026-10-25 踩到）
      if (parsed.pathname.replace(/\/+$/, '') !== '/aweme/v1/web/aweme/post') return '';
      return parsed.searchParams.get('sec_user_id') || '';
    } catch (error) { return ''; }
  }

  // 拦截 fetch
  var rawFetch = window.fetch;
  if (rawFetch) {
    window.fetch = function () {
      var args = arguments;
      var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
      var promise = rawFetch.apply(this, args);
      var accountId = matchSecUserId(url);
      if (accountId) {
        promise.then(function (response) {
          try {
            response.clone().json().then(function (data) { pickProfile(data, accountId); }).catch(function () {});
          } catch (error) { /* ignore */ }
        }).catch(function () {});
      }
      return promise;
    };
  }

  // 拦截 XHR（抖音部分版本走 XHR）
  var rawOpen = XMLHttpRequest.prototype.open;
  var rawSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__zcodeUrl = url;
    return rawOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var accountId = matchSecUserId(xhr.__zcodeUrl || '');
    if (accountId) {
      xhr.addEventListener('load', function () {
        try {
          if (xhr.responseType === '' || xhr.responseType === 'text') {
            pickProfile(JSON.parse(xhr.responseText), accountId);
          } else if (xhr.responseType === 'json') {
            pickProfile(xhr.response, accountId);
          }
        } catch (error) { /* ignore */ }
      });
    }
    return rawSend.apply(this, arguments);
  };

  // 页面里的昵称（用于自动建同行记录）
  function rememberNickname() {
    try {
      var el = document.querySelector('[data-e2e="user-title"], h1');
      if (el && el.textContent) window.__zcodeDouyinNickname = el.textContent.trim().slice(0, 60);
    } catch (error) { /* ignore */ }
  }
  window.addEventListener('DOMContentLoaded', rememberNickname);
  setTimeout(rememberNickname, 2500);

  // 给 content script（隔离世界）取数据用
  window.addEventListener('zcode-douyin-collect', function () {
    window.dispatchEvent(new CustomEvent('zcode-douyin-result', {
      detail: JSON.stringify({
        secUserId: captured.secUserId,
        nickname: captured.nickname || (window.__zcodeDouyinNickname || ''),
        works: captured.works,
        at: captured.at
      })
    }));
  });
})();
