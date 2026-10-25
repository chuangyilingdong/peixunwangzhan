/* 招生军师 · 内容工作台前端（2026-10-24）
 * 挂在 #scr-workbench 里，由 prototype.js 的 INIT.workbench 调 mount()。
 * 认证与 junshi 主页面完全一致：localStorage 会话 + Authorization: Bearer。
 */
(function () {
  var root = document.getElementById('js-app');
  if (!root) return;
  var $ = function (s) { return root.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(root.querySelectorAll(s)); };
  var API = '/api/junshi/workbench';
  var AUTH_KEYS = ['ai-kids-platform.session.v1.org', 'ai-kids-platform.session.v1.student', 'ai-kids-platform.session.v1.admin'];

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function authSession() {
    for (var i = 0; i < AUTH_KEYS.length; i++) {
      try {
        var s = JSON.parse(localStorage.getItem(AUTH_KEYS[i]) || 'null');
        if (s && s.token && (!s.expiresAt || new Date(s.expiresAt).getTime() > Date.now() + 60000)) return s;
      } catch (e) { /* ignore */ }
    }
    return null;
  }
  function authToken() { var s = authSession(); return s ? s.token : null; }
  function sessionLost() {
    for (var i = 0; i < AUTH_KEYS.length; i++) { try { localStorage.removeItem(AUTH_KEYS[i]); } catch (e) { /* ignore */ } }
    location.reload();
    throw new Error('登录状态已过期，请重新登录。');
  }
  function ic(name, size) {
    var px = size || 14;
    return '<svg class="ic" width="' + px + '" height="' + px + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtSize(bytes) {
    var n = Number(bytes || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  var JOB_STATUS = { running: '进行中', succeeded: '完成', failed: '失败' };
  var VIDEO_STATUS = { draft: '草稿', ready: '就绪', rendering: '生成中', published: '已发布' };
  function jobStatusText(value) { return JOB_STATUS[value] || value || '—'; }
  function videoStatusText(value) { return VIDEO_STATUS[value] || value || '—'; }

  /** 轻量 Markdown：先转义，只认标题、列表、引用、表格、代码块、加粗/行内代码/链接。 */
  function md(src) {
    var text = esc(src).replace(/\r/g, '');
    var blocks = [];
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, _lang, code) {
      blocks.push('<pre><code>' + code.trim() + '</code></pre>');
      return '\n@@B' + (blocks.length - 1) + '@@\n';
    });
    var out = []; var para = []; var list = null; var tableRows = [];
    function inline(s) {
      return s
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    }
    function flushPara() { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } }
    function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }
    function flushTable() {
      if (!tableRows.length) return;
      var rows = tableRows.filter(function (row) { return !/^\|?[\s:|-]+\|?$/.test(row); })
        .map(function (row) { return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) { return cell.trim(); }); });
      tableRows = [];
      if (!rows.length) return;
      var head = rows.shift();
      out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rows.map(function (row) { return '<tr>' + row.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; }).join('') +
        '</tbody></table>');
    }
    text.split('\n').forEach(function (raw) {
      var line = raw.trim();
      var block = line.match(/^@@B(\d+)@@$/);
      if (block) { flushPara(); closeList(); flushTable(); out.push(blocks[Number(block[1])] || ''); return; }
      if (!line) { flushPara(); closeList(); flushTable(); return; }
      var heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) { flushPara(); closeList(); flushTable(); out.push('<h4>' + inline(heading[2]) + '</h4>'); return; }
      if (/^[-*]\s+/.test(line)) {
        flushPara(); flushTable();
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + inline(line.replace(/^[-*]\s+/, '')) + '</li>'); return;
      }
      if (/^\d+[.)]\s+/.test(line)) {
        flushPara(); flushTable();
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + inline(line.replace(/^\d+[.)]\s+/, '')) + '</li>'); return;
      }
      if (line.indexOf('> ') === 0) { flushPara(); closeList(); flushTable(); out.push('<blockquote>' + inline(line.slice(2)) + '</blockquote>'); return; }
      if (/^\|.*\|$/.test(line)) { flushPara(); closeList(); tableRows.push(line); return; }
      flushTable(); para.push(line);
    });
    flushPara(); closeList(); flushTable();
    return out.join('');
  }

  async function requestJson(url, options) {
    var opt = options || {};
    var headers = Object.assign({}, opt.headers || {});
    var token = authToken();
    if (token) headers.authorization = 'Bearer ' + token;
    var body = opt.body;
    if (body && !(body instanceof FormData) && typeof body !== 'string') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }
    var res = await fetch(url, { method: opt.method || 'GET', headers: headers, body: body, credentials: 'same-origin' });
    if (res.status === 401 && token) sessionLost();
    var payload = await res.json().catch(function () { return null; });
    if (!res.ok) {
      var msg = (payload && (payload.message || (payload.error && payload.error.message))) || ('请求失败（HTTP ' + res.status + '）');
      throw new Error(msg);
    }
    return payload && payload.data !== undefined ? payload.data : payload;
  }
  function call(path, options) { return requestJson(API + path, options); }

  async function fetchBlob(url) {
    var headers = {};
    var token = authToken();
    if (token) headers.authorization = 'Bearer ' + token;
    var res = await fetch(url, { headers: headers, credentials: 'same-origin' });
    if (res.status === 401 && token) sessionLost();
    if (!res.ok) throw new Error('文件读取失败（HTTP ' + res.status + '）');
    return res.blob();
  }

  async function hydrateAssetThumbs() {
    var images = $$('[data-asset-img]');
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      if (img.dataset.loaded) continue;
      img.dataset.loaded = '1';
      try {
        var blob = await fetchBlob(API + '/assets/' + encodeURIComponent(img.dataset.assetImg) + '/file');
        img.src = URL.createObjectURL(blob);
      } catch (e) {
        var thumb = img.parentNode;
        if (thumb) thumb.innerHTML = ic('image', 28);
      }
    }
  }
  async function openAsset(id) {
    try {
      var blob = await fetchBlob(API + '/assets/' + encodeURIComponent(id) + '/file');
      var url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (error) { toast(error.message, 'error'); }
  }
  async function downloadExport(id, format, title) {
    try {
      var blob = await fetchBlob(API + '/videos/' + encodeURIComponent(id) + '/export?format=' + encodeURIComponent(format));
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = String(title || id).replace(/[\\/:*?"<>|]/g, '_') + '.' + format;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    } catch (error) { toast(error.message, 'error'); }
  }

  var toastTimer = null;
  function toast(message, kind) {
    var el = $('#wb-toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'wb-toast ' + (kind || '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }
  function showDialog(title, html) {
    var dialog = $('#wb-dialog');
    var body = $('#wb-dialog-body');
    if (!dialog || !body) return;
    body.innerHTML = '<h3>' + esc(title) + '</h3>' + html;
    dialog.hidden = false;
  }
  function closeDialog() { var d = $('#wb-dialog'); if (d) d.hidden = true; }

  var state = {
    mounted: false,
    loaded: false,
    tab: 'chat',
    profile: null,
    messages: [],
    copy: [],
    videos: [],
    assets: [],
    assetFolders: [],
    refs: [],
    jobs: [],
    summary: null,
    busy: false,
    abort: null,
    selectedVideo: null,
    videoForm: null,
    copyForm: null,
    // 多创作账号：当前选中的账号 id（'default' = 默认账号）；文案/视频/素材/档案都跟着它走。
    accounts: [],
    accountId: 'default',
    assetFolder: '',
    renders: [],
    renderTimer: null,
    wfPollTimer: null,
    // 引导式创作工作流（今日选题/爆款复刻/热点结合，参考原版 XiaoLingDang 的顶栏工作流）
    workflow: null,
    workflowMeta: null,
    memories: [],
    brains: [],
    brainPollTimer: null,
    chatAttachments: [],
    chatTier: 'fast',
    transcripts: [],
    tsTimer: null,
    douyinPanel: null,
    voices: [],
    avatarRuns: [],
    avatarTimer: null,
  };

  function accountName(accountId) {
    if (!accountId || accountId === 'default') return '默认账号';
    var found = state.accounts.filter(function (item) { return item.id === accountId; })[0];
    return found ? found.name : accountId;
  }
  function accountSelectHtml(attrs) {
    var extra = attrs || '';
    return '<select ' + extra + '>' + state.accounts.map(function (item) {
      return '<option value="' + esc(item.id) + '"' + (item.id === state.accountId ? ' selected' : '') + '>' + esc(item.name) + '</option>';
    }).join('') + '</select>';
  }

  function stopRenderPolling() {
    if (state.renderTimer) { clearInterval(state.renderTimer); state.renderTimer = null; }
  }

  function setTab(tab) {
    state.tab = tab;
    if (tab !== 'video') { stopRenderPolling(); stopAvatarPolling(); }
    if (tab !== 'chat') stopWfPolling();
    if (tab !== 'references') stopTsPolling();
    if (tab !== 'copybrains' && state.brainPollTimer) { clearInterval(state.brainPollTimer); state.brainPollTimer = null; }
    if (tab === 'copybrains') void refreshBrains(true);
    if (tab === 'settings') void renderSettings();
    $$('#wb-tabs [data-wb]').forEach(function (button) {
      if (button.dataset.wb === tab) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    if (tab === 'reports' || tab === 'jobs') {
      call('/summary').then(function (data) {
        state.summary = Object.assign({}, state.summary, data);
        state.jobs = data.jobs || state.jobs;
        render();
      }).catch(function () { render(); });
    } else {
      render();
    }
  }

  /** 切换当前创作账号：档案、文案、视频、素材都按账号重新拉一遍。 */
  async function switchAccount(accountId) {
    if (!accountId || accountId === state.accountId) return;
    state.accountId = accountId;
    state.assetFolder = '';
    try {
      var results = await Promise.all([
        call('/profile?accountId=' + encodeURIComponent(accountId)).catch(function () { return null; }),
        call('/copy?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [] }; }),
        call('/videos?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [] }; }),
        call('/assets?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [], folders: [] }; }),
      ]);
      if (results[0]) state.profile = results[0].profile || state.profile;
      state.copy = results[1].items || [];
      state.videos = results[2].items || [];
      state.assets = results[3].items || [];
      state.assetFolders = results[3].folders || [];
      if (state.tab === 'video') state.selectedVideo = null;
    } catch (e) { /* 保持旧数据 */ }
    render();
  }

  async function loadAll() {
    var view = $('#wb-view');
    if (view) view.innerHTML = '<div class="loading">' + ic('loader', 14) + '正在读取工作台…</div>';
    try {
      var boot = await call('/bootstrap');
      state.profile = boot.profile || null;
      state.summary = boot;
      state.accounts = boot.accounts || [{ id: 'default', name: '默认账号', platform: '抖音', note: '', createdAt: null }];
      var results = await Promise.all([
        call('/chat').catch(function () { return { messages: [] }; }),
        call('/copy').catch(function () { return { items: [] }; }),
        call('/videos').catch(function () { return { items: [] }; }),
        call('/assets').catch(function () { return { items: [], folders: [] }; }),
        call('/refs').catch(function () { return { items: [] }; }),
        call('/jobs').catch(function () { return { items: [] }; }),
        call('/workflows').catch(function () { return { items: [], styles: [], angles: [], strengths: [] }; }),
        call('/memories').catch(function () { return { items: [] }; }),
        call('/transcripts').catch(function () { return { items: [] }; }),
        call('/voices').catch(function () { return { items: [] }; }),
        call('/avatar/runs').catch(function () { return { items: [] }; }),
        call('/brains').catch(function () { return { items: [] }; }),
      ]);
      state.messages = results[0].messages || [];
      state.copy = results[1].items || [];
      state.videos = results[2].items || [];
      state.assets = results[3].items || [];
      state.assetFolders = results[3].folders || [];
      state.refs = results[4].items || [];
      state.jobs = results[5].items || [];
      var wfData = results[6];
      state.workflow = (wfData.items || []).filter(function (item) { return item.status === 'active'; })[0] || null;
      state.workflowMeta = { styles: wfData.styles || [], angles: wfData.angles || [], strengths: wfData.strengths || [] };
      state.memories = results[7].items || [];
      state.transcripts = results[8].items || [];
      state.voices = results[9].items || [];
      state.avatarRuns = results[10].items || [];
      state.brains = results[11].items || [];
      state.loaded = true;
      render();
    } catch (error) {
      if (view) view.innerHTML = '<div class="wb-page"><div class="wb-card"><p class="err">' + ic('alert', 14) + '<span>' + esc(error.message || '工作台加载失败') + '</span></p></div></div>';
    }
  }

  /* ───────────── 对话 ───────────── */
  function chatEmpty() {
    return '<div class="wb-suggest"><div class="orb">' + ic('sparkle', 24) + '</div>' +
      '<h3>今天想做什么内容？</h3>' +
      '<p>我会先查你自己的资料库和机构画像，再给能直接拍、能直接发的东西。你可以直接说目标，或从下面选一个。</p>' +
      '<div class="wb-suggest-list">' +
      '<button class="wb-suggestion" type="button" data-wb-prompt="帮我按这个账号做 3 个今天能拍的选题，并说明每个选题的钩子。">今日选题<small>3 个能拍的方向</small></button>' +
      '<button class="wb-suggestion" type="button" data-wb-prompt="围绕我的课程写 5 条 30 秒口播文案，开头要有钩子。">写 5 条口播<small>直接能开拍</small></button>' +
      '<button class="wb-suggestion" type="button" data-wb-prompt="帮我拆解一个同行的爆款，先告诉我应该按哪几层拆，再给我一个拆解模板。">拆同行爆款<small>拆结构，不抄内容</small></button>' +
      '<button class="wb-suggestion" type="button" data-wb-prompt="帮我做一条 45 秒视频的脚本和分镜，课程、人群和目标都按我的账号档案来。">做一条分镜<small>含口播和拍摄清单</small></button>' +
      '</div></div>';
  }
  function messageHtml(message, index) {
    var me = message.role === 'user';
    var content = message.content || '';
    var body = me ? esc(content).replace(/\n/g, '<br>') : (content ? md(content) : '<span class="loading">正在写…</span>');
    var saveMem = '';
    if (!me && content && !message.pending) {
      saveMem = '<button class="wb-mini-btn" type="button" data-mem-save="' + index + '" title="把这条回答里值得长期记住的事实或偏好存进记忆">' + ic('quote', 11) + '记为长期记忆</button>';
    }
    var sources = '';
    var chunks = message.citations && message.citations.chunks;
    if (!me && chunks && chunks.length) {
      sources = '<details class="wb-src"><summary>引用了你的资料（' + chunks.length + '）</summary>' +
        chunks.map(function (chunk) { return '<p>' + esc(chunk.title) + (chunk.domain && chunk.domain.length ? ' · ' + esc(chunk.domain.join(' / ')) : '') + '</p>'; }).join('') +
        '</details>';
    }
    return '<div class="wb-msg' + (me ? ' me' : '') + '"><div class="wb-msg-meta">' + (me ? '你' : '小铃铛') + (message.pending ? ' · 正在写' : '') + '</div>' +
      '<div class="wb-bubble">' + body + '</div>' + saveMem + sources + '</div>';
  }
  function renderMessages(forceBottom) {
    var box = $('#wb-msgs');
    if (!box) return;
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    box.innerHTML = state.messages.length ? state.messages.map(messageHtml).join('') : chatEmpty();
    bindMemSaveButtons();
    // 工作流卡片嵌在消息流末尾（对齐原版 viral/creative 会话卡片）
    if (state.workflow && state.workflow.status === 'active') {
      var card = workflowCardHtml(state.workflow);
      if (card) box.insertAdjacentHTML('beforeend', '<div data-wb-flow>' + card + '</div>');
    }
    bindWorkflowCard();
    if (forceBottom || near) box.scrollTop = box.scrollHeight;
  }
  function bindMemSaveButtons() {
    $$('[data-mem-save]').forEach(function (button) {
      button.onclick = async function () {
        var message = state.messages[Number(button.dataset.memSave)];
        if (!message || !message.content) return;
        try {
          var result = await call('/memories', { method: 'POST', body: { kind: 'memory', content: String(message.content).replace(/[#*`>]/g, '').trim().slice(0, 1200), source: '小铃铛对话', accountId: state.accountId } });
          state.memories.unshift((result.data || result).memory);
          var counter = $('#wb-mem-open');
          if (counter) counter.innerHTML = ic('quote', 12) + '记忆(' + state.memories.length + ')';
          toast('已记入长期记忆，小铃铛之后的回答会参考它', 'success');
        } catch (error) { toast(error.message, 'error'); }
      };
    });
  }
  function bindPromptButtons() {
    $$('[data-wb-prompt]').forEach(function (button) {
      button.onclick = function () {
        var input = $('#wb-input');
        if (input) { input.value = button.dataset.wbPrompt; input.focus(); }
      };
    });
  }
  function renderChat() {
    var chips = [];
    if (state.profile) {
      if (state.profile.product) chips.push('产品：' + state.profile.product);
      if (state.profile.audience) chips.push('人群：' + state.profile.audience);
      if (state.profile.goal) chips.push('目标：' + state.profile.goal);
    }
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-chat">' +
      '<div class="wb-chat-head"><b>小铃铛</b><span class="wb-note">' + esc(chips.join(' · ') || '先补账号档案，建议会更具体') + '</span>' +
      '<div class="wb-flow-entry">' +
      '<button class="btn" type="button" id="wb-flow-today">' + ic('bulb', 12) + '今日选题</button>' +
      '<button class="btn" type="button" id="wb-flow-viral">' + ic('copy', 12) + '爆款复刻</button>' +
      '<button class="btn" type="button" id="wb-flow-hotspot">' + ic('sparkle', 12) + '热点结合</button>' +
      '<button class="btn" type="button" id="wb-mem-open">' + ic('quote', 12) + '记忆(' + state.memories.length + ')</button>' +
      '<button class="btn" type="button" id="wb-clear-chat">清空对话</button></div></div>' +
      '<div class="wb-msgs" id="wb-msgs"></div>' +
      '<div><div class="wb-quick">' +
      '<button class="chip" type="button" data-wb-prompt="给我 3 个今天能拍的选题">今日选题</button>' +
      '<button class="chip" type="button" data-wb-prompt="写 5 条 30 秒口播文案">写口播</button>' +
      '<button class="chip" type="button" data-wb-prompt="帮我按钩子、痛点、证明、转折、行动拆解这个同行内容">拆同行</button>' +
      '<button class="chip" type="button" data-wb-prompt="把今天的热点和我的课程结合起来，给我 3 个选题">热点结合</button>' +
      '</div><div class="wb-chat-attach" id="wb-chat-attach"></div>' +
      '<div class="wb-composer"><textarea id="wb-input" placeholder="说说你今天想做什么，或贴一段同行口播…（可直接粘贴截图）"></textarea>' +
      '<button class="btn primary" type="button" id="wb-send">' + (state.busy ? ic('stop', 14) + '停止' : ic('arrow-up', 15) + '发送') + '</button></div>' +
      '<div class="wb-composer-foot"><button class="btn" type="button" id="wb-chat-attach-btn">' + ic('image', 12) + '添加图片</button>' +
      '<input id="wb-chat-file" type="file" accept="image/*" multiple hidden>' +
      '<span class="wb-note" style="margin-left:auto">模型：</span>' +
      '<button class="chip' + (state.chatTier === 'fast' ? ' on' : '') + '" type="button" data-tier="fast">标准</button>' +
      '<button class="chip' + (state.chatTier === 'deep' ? ' on' : '') + '" type="button" data-tier="deep">深度</button>' +
      '</div></div></div></div>';
    renderMessages(true);
    bindPromptButtons();
    bindWorkflowCard();
    $('#wb-flow-today').onclick = function () { openFlowStartDialog('today'); };
    $('#wb-flow-viral').onclick = function () { openFlowStartDialog('viral'); };
    $('#wb-flow-hotspot').onclick = function () { openFlowStartDialog('hotspot'); };
    $('#wb-mem-open').onclick = openMemoriesDialog;
    bindChatComposerExtras();
    var input = $('#wb-input');
    var send = $('#wb-send');
    function doSend() {
      if (state.busy) { if (state.abort) state.abort.abort(); return; }
      sendChat(input.value);
    }
    send.onclick = doSend;
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); doSend(); }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(160, input.scrollHeight) + 'px';
    });
    $('#wb-clear-chat').onclick = async function () {
      if (!confirm('清空当前机构的内容工作台对话？')) return;
      try {
        await call('/chat', { method: 'DELETE' });
        state.messages = [];
        renderMessages(true);
        bindPromptButtons();
        toast('对话已清空');
      } catch (error) { toast(error.message, 'error'); }
    };
  }
  function bindChatComposerExtras() {
    var attachBtn = $('#wb-chat-attach-btn');
    var fileInput = $('#wb-chat-file');
    if (attachBtn && fileInput) {
      attachBtn.onclick = function () { fileInput.click(); };
      fileInput.onchange = function () { void addChatAttachmentFiles(Array.prototype.slice.call(fileInput.files || [])); fileInput.value = ''; };
    }
    $$('[data-tier]').forEach(function (button) {
      button.onclick = function () {
        state.chatTier = button.dataset.tier;
        $$('[data-tier]').forEach(function (item) { item.classList.toggle('on', item.dataset.tier === state.chatTier); });
      };
    });
    renderChatAttachments();
    var input = $('#wb-input');
    if (input && !input.dataset.pasteBound) {
      input.dataset.pasteBound = '1';
      input.addEventListener('paste', function (event) {
        var files = Array.prototype.slice.call((event.clipboardData || {}).files || []).filter(function (file) { return file.type.indexOf('image/') === 0; });
        if (files.length) { event.preventDefault(); void addChatAttachmentFiles(files); }
      });
    }
  }
  async function addChatAttachmentFiles(files) {
    for (var i = 0; i < files.length; i++) {
      if (state.chatAttachments.length >= 4) { toast('一条消息最多带 4 张图片', 'error'); break; }
      var chip = { id: 'pending' + Date.now() + i, name: files[i].name, status: 'uploading' };
      state.chatAttachments.push(chip);
      renderChatAttachments();
      try {
        var form = new FormData();
        form.append('file', files[i]);
        form.append('accountId', state.accountId);
        var result = await call('/assets', { method: 'POST', body: form });
        chip.id = result.asset.id;
        chip.status = 'ready';
        state.assets.unshift(result.asset);
      } catch (error) {
        chip.status = 'failed';
        toast(files[i].name + '：' + error.message, 'error');
      }
      renderChatAttachments();
    }
  }
  function renderChatAttachments() {
    var box = $('#wb-chat-attach');
    if (!box) return;
    box.innerHTML = state.chatAttachments.map(function (chip, index) {
      return '<span class="wb-attach-chip">' + ic(chip.status === 'ready' ? 'image' : 'loader', 11) + ' 图片' + (index + 1) +
        (chip.status === 'failed' ? '（上传失败）' : '') +
        '<button type="button" data-attach-del="' + index + '" aria-label="移除">×</button></span>';
    }).join('');
    $$('[data-attach-del]').forEach(function (button) {
      button.onclick = function () { state.chatAttachments.splice(Number(button.dataset.attachDel), 1); renderChatAttachments(); };
    });
  }
  function creativeIntentOf(text) {
    if (/开始今天的选题|开始选题|帮我(想|做|搞|选).{0,8}(选题|文案|口播)|给我(想|做|写).{0,8}(选题|文案|口播)|我想(做|写|开始).{0,8}(选题|文案|口播)/.test(text)) return 'today';
    return '';
  }
  async function sendChat(raw) {
    var text = String(raw || '').trim();
    if (!text || state.busy) return;
    var input = $('#wb-input');
    if (input) input.value = '';
    // 意图识别（对齐原版 isCreativeStartIntent）
    var intent = creativeIntentOf(text);
    if (intent && !state.workflow) {
      showDialog('今天想从哪里开始？', '<p>可以先给一个大致方向，也可以让小铃铛根据账号资料推荐三个选题。</p>' +
        '<label class="wb-field full"><span>我有大致想法</span><input id="wb-today-idea" placeholder="例如：想讲客户总觉得服务贵"></label>' +
        '<div class="wb-actions"><button class="btn primary" type="button" id="wb-today-with">按这个想法推荐 3 个选题</button>' +
        '<button class="btn" type="button" id="wb-today-no">我没头绪，推荐 3 个选题</button></div>');
      var startToday = function (withIdea) {
        var idea = String(($('#wb-today-idea') || {}).value || '').trim();
        if (withIdea && !idea) { toast('先写一句大致想法，或选「我没头绪」', 'error'); return; }
        closeDialog();
        launchWorkflow('today', { goal: withIdea ? idea : '' }, '今日选题', 'idea',
          { goal: withIdea ? idea : '', ideaOptions: [], message: '正在根据账号资料推荐选题…', copyOptions: [] });
      };
      $('#wb-today-with').onclick = function () { startToday(true); };
      $('#wb-today-no').onclick = function () { startToday(false); };
      return;
    }
    var attachmentIds = state.chatAttachments.filter(function (chip) { return chip.status === 'ready'; }).map(function (chip) { return chip.id; });
    state.chatAttachments = [];
    renderChatAttachments();
    state.busy = true;
    state.abort = new AbortController();
    state.messages.push({ role: 'user', content: text });
    var assistant = { role: 'assistant', content: '', pending: true, citations: null };
    state.messages.push(assistant);
    renderMessages(true);
    var send = $('#wb-send');
    if (send) send.innerHTML = ic('stop', 14) + '停止';
    try {
      var token = authToken();
      var headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = 'Bearer ' + token;
      var res = await fetch(API + '/chat/stream', {
        method: 'POST', headers: headers, credentials: 'same-origin',
        body: JSON.stringify({ message: text, accountId: state.accountId, tier: state.chatTier || 'fast', attachments: attachmentIds }), signal: state.abort.signal,
      });
      if (res.status === 401 && token) sessionLost();
      if (!res.ok || !res.body) throw new Error('生成失败（HTTP ' + res.status + '）');
      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buffer = ''; var event = '';
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('event: ') === 0) { event = line.slice(7).trim(); continue; }
          if (line.indexOf('data: ') !== 0) continue;
          var data; try { data = JSON.parse(line.slice(6)); } catch (e) { continue; }
          if (event === 'citations') { assistant.citations = data; }
          else if (event === 'delta') { assistant.pending = false; assistant.content += data.text || ''; renderMessages(); }
          else if (event === 'reset') { assistant.content = ''; renderMessages(); }
          else if (event === 'error') throw new Error(data.message || '生成失败');
          else if (event === 'done') {
            assistant.pending = false;
            if (data.message) { assistant.content = data.message.content || assistant.content; assistant.citations = data.message.citations || assistant.citations; }
            if (!assistant.content) assistant.content = '（这次没有生成内容，请重试。）';
            renderMessages();
          } else if (event === 'stopped') {
            assistant.pending = false;
            if (!assistant.content) assistant.content = '（已停止生成）';
          }
        }
      }
    } catch (error) {
      assistant.pending = false;
      if (error.name === 'AbortError') assistant.content = assistant.content || '（已停止生成）';
      else { assistant.content = assistant.content || ('生成失败：' + (error.message || error)); toast(error.message || '生成失败', 'error'); }
    } finally {
      state.busy = false;
      state.abort = null;
      renderMessages();
      var button = $('#wb-send');
      if (button) button.innerHTML = ic('arrow-up', 15) + '发送';
    }
  }

  /* ───────────── 账号档案（多创作账号：每个账号一份档案） ───────────── */
  function bindAccountSwitch(id) {
    var select = $(id);
    if (!select) return;
    select.onchange = function () { switchAccount(select.value); };
  }
  function renderAccount() {
    var p = state.profile || {};
    var fields = [
      ['name', '账号名称', 'input', '例如：某某教育抖音号'],
      ['platform', '平台', 'select', ''],
      ['product', '产品/服务', 'input', '你具体卖什么、解决什么问题'],
      ['audience', '目标人群', 'input', '越具体越好'],
      ['goal', '当前目标', 'input', '到店 / 私信 / 涨粉 / 成交'],
      ['tone', '表达风格', 'input', '真实、口语化、有信息量'],
      ['boundaries', '内容边界', 'input', '不能承诺什么、不能碰什么'],
      ['positioning', '账号定位', 'textarea', '一句话说清：你是谁、帮谁、解决什么问题'],
    ];
    var extra = state.accounts.filter(function (item) { return item.id !== 'default'; });
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>创作账号</h3><p>一个机构可以管多个号：每个账号一份档案、文案、视频和素材。默认账号继承原有数据。</p></div></div>' +
      '<div class="wb-account-bar"><label class="wb-inline"><span>当前账号</span>' + accountSelectHtml('id="wb-account-switch"') + '</label>' +
      '<form id="wb-account-new" class="wb-inline"><input name="name" required placeholder="新账号名称，如：少儿美术主号" maxlength="60">' +
      '<button class="btn" type="submit">' + ic('plus', 12) + '新增账号</button></form></div>' +
      (extra.length ? '<table class="wb-table"><thead><tr><th>账号</th><th>平台</th><th>备注</th><th></th></tr></thead><tbody>' +
        extra.map(function (item) {
          return '<tr><td><b>' + esc(item.name) + '</b></td><td>' + esc(item.platform || '—') + '</td><td>' + esc(item.note || '—') + '</td>' +
            '<td><button class="btn" type="button" data-account-del="' + esc(item.id) + '">' + ic('trash', 12) + '</button></td></tr>';
        }).join('') + '</tbody></table>' : '<p class="wb-muted">目前只有默认账号。要分开管几个抖音号，就在上面新增。</p>') +
      '</div>' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>账号档案 · ' + esc(accountName(state.accountId)) + '</h3><p>这些信息会进入每次对话、文案和分镜的上下文；切换账号后档案各自独立。</p></div></div>' +
      '<form id="wb-account-form" class="wb-form">' +
      fields.map(function (field) {
        var key = field[0], label = field[1], type = field[2], placeholder = field[3];
        var full = (key === 'positioning' || key === 'product') ? ' full' : '';
        var value = p[key] || '';
        if (type === 'textarea') {
          return '<label class="wb-field' + full + '"><span>' + label + '</span><textarea name="' + key + '" placeholder="' + esc(placeholder) + '">' + esc(value) + '</textarea></label>';
        }
        if (type === 'select') {
          return '<label class="wb-field' + full + '"><span>' + label + '</span><select name="' + key + '">' +
            ['抖音', '视频号', '小红书', '快手'].map(function (item) { return '<option' + (item === value ? ' selected' : '') + '>' + item + '</option>'; }).join('') +
            '</select></label>';
        }
        return '<label class="wb-field' + full + '"><span>' + label + '</span><input name="' + key + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '"></label>';
      }).join('') +
      '<div class="wb-field full wb-actions"><button class="btn primary" type="submit">保存档案</button><span class="wb-note">保存后，小铃铛会按这份档案回答。</span></div>' +
      '</form></div></div></div>';
    bindAccountSwitch('#wb-account-switch');
    $('#wb-account-new').onsubmit = async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var name = String(form.name.value || '').trim();
      if (!name) return;
      try {
        var result = await call('/accounts', { method: 'POST', body: { name: name } });
        state.accounts.push(result.account);
        toast('已新增账号「' + result.account.name + '」，可开始补它的档案', 'success');
        await switchAccount(result.account.id);
        var profileName = $('#wb-account-form [name="name"]');
        if (profileName) { profileName.value = result.account.name; }
      } catch (error) { toast(error.message, 'error'); }
    };
    $$('[data-account-del]').forEach(function (button) {
      button.onclick = async function () {
        if (!confirm('删除这个账号？它名下的文案、视频和素材会并回默认账号，不会丢。')) return;
        try {
          await call('/accounts/' + encodeURIComponent(button.dataset.accountDel), { method: 'DELETE' });
          state.accounts = state.accounts.filter(function (item) { return item.id !== button.dataset.accountDel; });
          if (state.accountId === button.dataset.accountDel) await switchAccount('default');
          renderAccount();
          toast('账号已删除，内容已并回默认账号', 'success');
        } catch (error) { toast(error.message, 'error'); }
      };
    });
    $('#wb-account-form').onsubmit = async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        var data = Object.fromEntries(new FormData(form).entries());
        var saved = await call('/profile', { method: 'PUT', body: { accountId: state.accountId, profile: data } });
        state.profile = saved.profile;
        toast('「' + accountName(state.accountId) + '」的档案已保存', 'success');
      } catch (error) { toast(error.message, 'error'); }
      finally { button.disabled = false; }
    };
  }

  /* ───────────── 同行观察（含抖音采集 + 转写档案） ───────────── */
  function stopTsPolling() {
    if (state.tsTimer) { clearInterval(state.tsTimer); state.tsTimer = null; }
  }
  async function refreshTranscripts(silent) {
    try {
      var data = await call('/transcripts');
      state.transcripts = data.items || [];
    } catch (error) {
      if (!silent) toast(error.message, 'error');
      return;
    }
    if (state.tab === 'references') renderTranscriptList();
    var running = state.transcripts.some(function (item) { return item.status === 'running'; });
    if (running && !state.tsTimer) {
      state.tsTimer = setInterval(function () {
        if (state.tab !== 'references') { stopTsPolling(); return; }
        refreshTranscripts(true);
      }, 3000);
    } else if (!running) {
      stopTsPolling();
    }
  }
  function fmtDuration(seconds) {
    var n = Math.round(Number(seconds) || 0);
    var m = Math.floor(n / 60); var s = n % 60;
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }
  function transcriptCardHtml(item) {
    var body = '';
    if (item.status === 'running') body = '<p class="wb-note">' + ic('loader', 12) + ' 正在转写（whisper），通常几十秒；这一页会自动刷新。</p>';
    else if (item.status === 'failed') body = '<p class="err">' + ic('alert', 13) + '<span>' + esc(item.error || '转写失败') + '</span></p>';
    else {
      body = '<p class="wb-preview" style="-webkit-line-clamp:3">' + esc(item.text.slice(0, 200)) + '</p>' +
        '<div class="wb-actions"><button class="btn primary" type="button" data-ts-recreate="' + esc(item.id) + '">' + ic('copy', 12) + '用它复刻</button>' +
        '<button class="btn" type="button" data-ts-detail="' + esc(item.id) + '">看时间码</button></div>';
    }
    return '<article class="wb-item"><div class="wb-card-head"><div><h4>' + esc(item.title || '转写档案') + '</h4>' +
      '<div class="wb-meta">' + esc(item.nickname || (item.source === 'douyin' ? '抖音采集' : '素材转写')) +
      ' · ' + fmtDuration(item.durationSeconds) + ' · ' + (item.segmentCount || 0) + ' 段 · ' + fmtDate(item.createdAt) + '</div></div>' +
      '<span class="wb-tag ' + (item.status === 'succeeded' ? 'ok' : item.status === 'failed' ? 'bad' : '') + '">' + esc(item.status === 'running' ? '转写中' : item.status === 'succeeded' ? '已转写' : item.status === 'failed' ? '失败' : item.status) + '</span></div>' +
      body + '</article>';
  }
  function renderTranscriptList() {
    var box = $('#wb-ts-list');
    if (!box) return;
    box.innerHTML = state.transcripts.length
      ? '<h4 style="margin:14px 0 8px">转写档案（' + state.transcripts.length + '）</h4><div class="wb-cards">' + state.transcripts.map(transcriptCardHtml).join('') + '</div>'
      : '<p class="wb-muted" style="margin-top:12px">还没有转写档案。粘贴同行分享链接，下载并转写第一条。</p>';
    $$('[data-ts-recreate]').forEach(function (button) {
      button.onclick = async function () {
        try {
          var result = await call('/workflows', { method: 'POST', body: { kind: 'viral', accountId: state.accountId, input: { transcriptId: button.dataset.tsRecreate } } });
          state.workflow = (result.data || result).workflow;
          setTab('chat');
          toast('已带入原文，确认后选改造强度', 'success');
        } catch (error) { toast(error.message, 'error'); }
      };
    });
    $$('[data-ts-detail]').forEach(function (button) {
      button.onclick = async function () {
        try {
          var data = await call('/transcripts/' + encodeURIComponent(button.dataset.tsDetail));
          var t = (data.data || data).transcript;
          var segs = (t.segments || []).slice(0, 60).map(function (s) {
            return '<p><b>' + fmtDuration(s.start) + '-' + fmtDuration(s.end) + '</b> ' + esc(s.text) + '</p>';
          }).join('');
          showDialog('时间码 · ' + (t.title || ''), segs || '<p class="wb-muted">没有分段信息。</p>');
        } catch (error) { toast(error.message, 'error'); }
      };
    });
  }
  async function douyinCollect(text) {
    var button = $('#wb-dy-go');
    var original = button.innerHTML;
    button.disabled = true; button.innerHTML = ic('loader', 12) + '解析中…';
    try {
      var resolved = await call('/douyin/resolve', { method: 'POST', body: { text: text } });
      var target = (resolved.data || resolved).target;
      if (target.kind === 'video') {
        button.innerHTML = ic('loader', 12) + '下载中…';
        var result = await call('/douyin/video', { method: 'POST', body: { awemeId: target.id, accountId: state.accountId } });
        var data = result.data || result;
        toast('已下载进素材库（抖音采集），开始转写', 'success');
        state.douyinPanel = { video: data.video };
        renderDouyinPanel();
        refreshTranscripts(true);
      } else {
        button.innerHTML = ic('loader', 12) + '读取主页…';
        var profileResult = await call('/douyin/profile', { method: 'POST', body: { secUserId: target.id } });
        state.douyinPanel = { profile: (profileResult.data || profileResult).profile };
        renderDouyinPanel();
        toast('已读到主页和最近作品', 'success');
      }
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false; button.innerHTML = original;
    }
  }
  function renderDouyinPanel() {
    var box = $('#wb-dy-result');
    if (!box) return;
    var panel = state.douyinPanel;
    if (!panel) { box.innerHTML = ''; return; }
    if (panel.video) {
      var v = panel.video;
      box.innerHTML = '<div class="wb-dy-video"><b>' + esc(v.desc || '抖音视频') + '</b>' +
        '<div class="wb-meta">' + esc(v.nickname || '') + ' · 赞 ' + (v.stats.digg || 0) + ' · 评论 ' + (v.stats.comment || 0) + '</div>' +
        '<p class="wb-note">' + ic('check', 11) + ' 已存入素材库并开始转写，档案出现在下方「转写档案」。</p></div>';
      return;
    }
    var p = panel.profile || {};
    var works = p.works || [];
    box.innerHTML = '<div class="wb-dy-profile"><div class="wb-card-head"><div><h4>' + esc(p.nickname || '同行主页') + '</h4>' +
      '<div class="wb-meta">粉丝 ' + (p.followerCount || 0) + ' · 获赞 ' + (p.totalFavorited || 0) + ' · 作品 ' + works.length + ' 条</div></div></div>' +
      (p.signature ? '<p class="wb-note">' + esc(p.signature.slice(0, 120)) + '</p>' : '') +
      (works.length ? '<div class="wb-dy-works">' + works.map(function (work) {
        return '<article class="wb-item"><div class="wb-card-head"><h4>' + esc(work.desc || work.awemeId) + '</h4></div>' +
          '<div class="wb-meta">' + fmtDuration((work.durationMs || 0) / 1000) + ' · 赞 ' + (work.stats.digg || 0) + ' · 分享 ' + (work.stats.share || 0) + '</div>' +
          '<div class="wb-actions"><button class="btn primary" type="button" data-dy-video="' + esc(work.awemeId) + '">下载并转写</button></div></article>';
      }).join('') + '</div>' : '<p class="wb-muted">这个主页没有读到作品（可能被抖音限制），稍后再试。</p>') + '</div>';
    $$('[data-dy-video]').forEach(function (button) {
      button.onclick = function () { douyinCollectVideo(button.dataset.dyVideo, button); };
    });
  }
  async function douyinCollectVideo(awemeId, button) {
    button.disabled = true; button.innerHTML = ic('loader', 12) + '下载中…';
    try {
      await call('/douyin/video', { method: 'POST', body: { awemeId: awemeId, accountId: state.accountId } });
      toast('已下载进素材库，开始转写', 'success');
      button.innerHTML = ic('check', 12) + '转写中';
      refreshTranscripts(true);
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false; button.innerHTML = '下载并转写';
    }
  }
  function renderReferences() {
    var items = state.refs;
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>抖音采集</h3><p>粘贴同行的「分享→复制链接」内容或主页链接：读公开主页与作品，下载视频并自动转写带时间码的口播档案。只读公开数据、每机构每小时限 40 次。</p></div>' +
      '<label class="wb-inline"><span>账号</span>' + accountSelectHtml('id="wb-dy-account"') + '</label></div>' +
      '<div class="wb-composer" style="padding:0 2px"><textarea id="wb-dy-input" placeholder="例如：8.xx 复制打开抖音 https://v.douyin.com/xxxx/ 或 https://www.douyin.com/user/xxxx"></textarea>' +
      '<button class="btn primary" type="button" id="wb-dy-go">' + ic('search', 13) + '解析</button></div>' +
      '<div id="wb-dy-result"></div></div>' +
      '<div id="wb-ts-list"></div>' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>记录同行</h3><p>拆结构，不抄内容。手动记录仍然可用；也可以把采集到的主页直接加进来。</p></div></div>' +
      '<form id="wb-ref-form" class="wb-form">' +
      '<label class="wb-field"><span>名称</span><input name="name" required placeholder="例如：某某教育号"></label>' +
      '<label class="wb-field"><span>链接</span><input name="url" type="url" placeholder="https://..."></label>' +
      '<label class="wb-field full"><span>观察笔记</span><textarea name="notes" placeholder="钩子、结构、证据、转化方式…"></textarea></label>' +
      '<div class="wb-field full wb-actions"><button class="btn primary" type="submit">加入观察</button></div></form></div>' +
      (items.length ? '<div class="wb-cards">' + items.map(function (item) {
        var linked = (state.transcripts || []).filter(function (ts) {
          return ts.status === 'succeeded' && (
            (item.url && ts.sourceUrl && ts.sourceUrl.indexOf(item.url.replace(/\/user\/.*/, '')) >= 0) ||
            (item.name && ts.nickname && ts.nickname.indexOf(item.name) >= 0));
        });
        var count = linked.length;
        var nextStep = count >= 2 ? '已采集 ' + count + ' 条口播，可以生成研究简报' : count ? '已采集 1 条，再采集 1-2 条就可以生成研究简报' : '先粘贴这个同行的作品分享，采集 2-3 条口播';
        var report = (state.brains || []).filter(function (brain) { return brain.kind === 'peer_report' && brain.name === item.name && brain.status === 'ready'; })[0];
        return '<article class="wb-item"><div class="wb-card-head"><h4>' + esc(item.name) + '</h4><button class="btn" type="button" data-ref-del="' + esc(item.id) + '">' + ic('trash', 12) + '</button></div>' +
          (item.url ? '<p><a href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">' + esc(item.url) + '</a></p>' : '') +
          '<p class="wb-preview" style="-webkit-line-clamp:4">' + esc(item.notes || '还没有观察笔记。') + '</p>' +
          '<div class="wb-meta">已采集口播 <b>' + count + '</b> 条 · 下一步：' + esc(nextStep) + '</div>' +
          '<div class="wb-actions">' + (report ? '<button class="btn primary" type="button" data-ref-report="' + esc(report.id) + '">查看研究简报</button>' : '<button class="btn" type="button" data-ref-report-new="' + esc(item.name) + '"' + (count ? '' : ' disabled') + '>生成研究简报</button>') + '</div></article>';
      }).join('') + '</div>' : '<div class="wb-card"><p class="wb-muted">还没有同行记录。</p></div>') +
      '</div></div>';
    bindAccountSwitch('#wb-dy-account');
    var go = $('#wb-dy-go');
    go.onclick = function () {
      var value = String(($('#wb-dy-input') || {}).value || '').trim();
      if (!value) { toast('先粘贴分享内容或链接', 'error'); return; }
      douyinCollect(value);
    };
    renderDouyinPanel();
    renderTranscriptList();
    refreshTranscripts(true);
    $$('[data-ref-report]').forEach(function (button) {
      button.onclick = async function () {
        try {
          var data = await call('/brains/' + encodeURIComponent(button.dataset.refReport));
          var brain = (data.data || data).brain;
          showDialog(brain.name + ' · 研究简报', brainArchiveHtml(brain));
        } catch (error) { toast(error.message, 'error'); }
      };
    });
    $$('[data-ref-report-new]').forEach(function (button) {
      button.onclick = function () { openPeerReportDialog(button.dataset.refReportNew); };
    });
    $('#wb-ref-form').onsubmit = async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        var data = Object.fromEntries(new FormData(form).entries());
        var result = await call('/refs', { method: 'POST', body: data });
        state.refs.unshift(result.ref);
        renderReferences();
        toast('已加入观察', 'success');
      } catch (error) { toast(error.message, 'error'); button.disabled = false; }
    };
    $$('[data-ref-del]').forEach(function (button) {
      button.onclick = async function () {
        if (!confirm('删除这条观察记录？')) return;
        try {
          await call('/refs/' + encodeURIComponent(button.dataset.refDel), { method: 'DELETE' });
          state.refs = state.refs.filter(function (item) { return item.id !== button.dataset.refDel; });
          renderReferences();
        } catch (error) { toast(error.message, 'error'); }
      };
    });
  }

  /* ───────────── 文案大脑 ───────────── */
  function renderCopy() {
    var formState = state.copyForm || {};
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>生成新文案</h3><p>围绕一个主题，一次给你多条不同角度的口播。</p></div>' +
      '<label class="wb-inline"><span>账号</span>' + accountSelectHtml('id="wb-copy-account"') + '</label></div>' +
      '<form id="wb-copy-form" class="wb-form">' +
      '<label class="wb-field full"><span>主题</span><input name="topic" required placeholder="例如：寒假班怎么选、体验课怎么开口" value="' + esc(formState.topic || '') + '"></label>' +
      '<label class="wb-field"><span>条数</span><select name="count">' + [3, 5, 7, 10].map(function (n) { return '<option' + (Number(formState.count || 5) === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<label class="wb-field"><span>风格</span><select name="style">' + ['口语化', '专业理性', '故事感', '犀利反常识'].map(function (s) { return '<option' + (formState.style === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></label>' +
      '<div class="wb-field full wb-actions"><button class="btn primary" type="submit">生成文案</button><span class="wb-note">使用平台模型渠道；模型返回空时会给出演示样本。</span></div></form></div>' +
      (state.copy.length ? '<div class="wb-cards wb-copy-grid">' + state.copy.map(function (item) {
        var stats = item.stats || null;
        var statsHtml = stats ? '<div class="wb-meta" style="color:var(--text-2)">📊 发布数据：播放 ' + (stats.plays ?? '—') + ' · 赞 ' + (stats.likes ?? '—') + ' · 评 ' + (stats.comments ?? '—') + ' · 藏 ' + (stats.saves ?? '—') + (stats.publishedAt ? ' · ' + esc(stats.publishedAt) : '') + '</div>' : '';
        return '<article class="wb-item"><div class="wb-card-head"><div><h4>' + esc(item.topic) + '</h4><div class="wb-meta">' + esc(item.style) + ' · ' + esc(accountName(item.accountId)) + ' · ' + fmtDate(item.createdAt) + '</div></div></div>' +
          '<div class="wb-copy-body">' + md(item.content) + '</div>' + statsHtml +
          '<div class="wb-actions"><button class="btn" type="button" data-copy-content="' + esc(item.id) + '">' + ic('copy', 12) + '复制</button>' +
          '<button class="btn" type="button" data-copy-check="' + esc(item.id) + '">' + ic('shield', 12) + '合规体检</button>' +
          '<button class="btn" type="button" data-copy-stats="' + esc(item.id) + '">' + ic('chart', 12) + (stats ? '更新数据' : '回填数据') + '</button>' +
          '<button class="btn" type="button" data-copy-del="' + esc(item.id) + '">' + ic('trash', 12) + '</button></div></article>';
      }).join('') + '</div>' : '<div class="wb-card"><p class="wb-muted">这个账号还没有文案。输入一个主题，先生成 5 条。</p></div>') +
      '</div></div>';
    bindAccountSwitch('#wb-copy-account');
    $('#wb-copy-form').onsubmit = async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var button = form.querySelector('[type="submit"]');
      var original = button.innerHTML;
      button.disabled = true; button.innerHTML = ic('loader', 13) + '生成中…';
      try {
        var data = Object.fromEntries(new FormData(form).entries());
        data.count = Number(data.count || 5);
        data.accountId = state.accountId;
        state.copyForm = { topic: data.topic, count: data.count, style: data.style };
        var result = await call('/copy', { method: 'POST', body: data });
        state.copy.unshift(result.draft);
        renderCopy();
        toast(result.demo ? '已生成演示文案（模型未返回正文）' : '文案已生成', 'success');
      } catch (error) { toast(error.message, 'error'); button.disabled = false; button.innerHTML = original; }
    };
    $$('[data-copy-content]').forEach(function (button) {
      button.onclick = function () {
        var item = state.copy.filter(function (row) { return row.id === button.dataset.copyContent; })[0];
        if (!item) return;
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(item.content).then(function () { toast('已复制', 'success'); }, function () { toast('复制失败', 'error'); });
        else toast('当前浏览器不支持自动复制', 'error');
      };
    });
    $$('[data-copy-check]').forEach(function (button) {
      button.onclick = function () {
        var item = state.copy.filter(function (row) { return row.id === button.dataset.copyCheck; })[0];
        if (item) checkCompliance(item.content);
      };
    });
    $$('[data-copy-stats]').forEach(function (button) {
      button.onclick = function () { backfillStats(button.dataset.copyStats); };
    });
    $$('[data-copy-del]').forEach(function (button) {
      button.onclick = async function () {
        if (!confirm('删除这条文案？')) return;
        try {
          await call('/copy/' + encodeURIComponent(button.dataset.copyDel), { method: 'DELETE' });
          state.copy = state.copy.filter(function (row) { return row.id !== button.dataset.copyDel; });
          renderCopy();
        } catch (error) { toast(error.message, 'error'); }
      };
    });
  }

  /* ───────────── 数字人口播（音色克隆 + 对口型） ───────────── */
  function stopAvatarPolling() {
    if (state.avatarTimer) { clearInterval(state.avatarTimer); state.avatarTimer = null; }
  }
  async function refreshAvatarRuns(silent) {
    try {
      var data = await call('/avatar/runs?accountId=' + encodeURIComponent(state.accountId));
      state.avatarRuns = data.items || [];
      var voiceData = await call('/voices');
      state.voices = voiceData.items || [];
    } catch (error) {
      if (!silent) toast(error.message, 'error');
      return;
    }
    if (state.tab === 'video') renderAvatarList();
    var busy = state.avatarRuns.some(function (item) { return item.status === 'running'; })
      || state.voices.some(function (item) { return item.status === 'training'; });
    if (busy && !state.avatarTimer) {
      state.avatarTimer = setInterval(function () {
        if (state.tab !== 'video') { stopAvatarPolling(); return; }
        refreshAvatarRuns(true);
      }, 4000);
    } else if (!busy) {
      stopAvatarPolling();
    }
  }
  function avatarStepHtml(step) {
    var icon = step.status === 'done' ? '✓' : step.status === 'running' ? '●' : '○';
    return '<span class="' + (step.status === 'done' ? 'done' : step.status === 'running' ? 'current' : '') + '">' + icon + ' ' + esc(step.label) + '</span>';
  }
  function renderAvatarList() {
    var box = $('#wb-avatar-list');
    if (!box) return;
    box.innerHTML = state.avatarRuns.length ? state.avatarRuns.map(function (run) {
      var body = '';
      if (run.status === 'running') body = '<div class="wb-flow-steps">' + (run.steps || []).map(avatarStepHtml).join('') + '</div>';
      if (run.status === 'failed') body = '<p class="err">' + ic('alert', 13) + '<span>' + esc(run.error || '合成失败') + '</span></p>';
      if (run.status === 'succeeded' && run.videoAssetId) body = '<video class="wb-render-video" controls preload="metadata" data-avatar-video="' + esc(run.videoAssetId) + '"></video>';
      return '<div class="wb-render"><div class="wb-card-head"><div><b>' + esc((run.text || '').slice(0, 40)) + '</b>' +
        '<span class="wb-tag ' + (run.status === 'succeeded' ? 'ok' : run.status === 'failed' ? 'bad' : '') + '">' + esc(run.status === 'running' ? '合成中' : run.status === 'succeeded' ? '完成' : '失败') + '</span>' +
        '<div class="wb-meta">' + fmtDate(run.createdAt) + '</div></div></div>' + body + '</div>';
    }).join('') : '<p class="wb-muted">还没有数字人口播记录。</p>';
    (function () {
      var videos = $$('[data-avatar-video]');
      for (var i = 0; i < videos.length; i++) {
        (function (video) {
          if (video.dataset.loaded) return;
          video.dataset.loaded = '1';
          fetchBlob(API + '/assets/' + encodeURIComponent(video.dataset.avatarVideo) + '/file').then(function (blob) {
            video.src = URL.createObjectURL(blob);
          }).catch(function () { /* 播放器外壳保留 */ });
        })(videos[i]);
      }
    })();
  }
  function openCloneVoiceDialog() {
    var audioAssets = state.assets.filter(function (item) { return item.kind === 'audio'; });
    showDialog('克隆我的音色', '<p class="wb-note">先上传一段 10-30 秒清晰人声到素材库（mp3/wav），再选它克隆。克隆出的音色用于数字人口播。</p>' +
      (audioAssets.length ? '<label class="wb-field full"><span>音频样本</span><select id="wb-voice-sample">' +
        audioAssets.map(function (item) { return '<option value="' + esc(item.id) + '">' + esc(item.fileName) + '</option>'; }).join('') + '</select></label>' : '<p class="wb-muted">素材库里还没有音频。先去「素材库」上传一段录音。</p>') +
      '<label class="wb-field full"><span>音色名称</span><input id="wb-voice-name" placeholder="例如：校长本人" maxlength="30"></label>' +
      '<label class="wb-field full"><span>试听文本（克隆完会生成一段试听）</span><input id="wb-voice-audition" value="大家好，欢迎关注我们的账号。" maxlength="120"></label>' +
      '<div class="wb-actions"><button class="btn primary" type="button" id="wb-voice-clone-go"' + (audioAssets.length ? '' : ' disabled') + '>开始克隆</button></div>');
    var go = $('#wb-voice-clone-go');
    if (!go || go.disabled) return;
    go.onclick = async function () {
      go.disabled = true; go.innerHTML = ic('loader', 12) + '提交中…';
      try {
        await call('/voices', { method: 'POST', body: { assetId: $('#wb-voice-sample').value, name: ($('#wb-voice-name') || {}).value || '', auditionText: ($('#wb-voice-audition') || {}).value || '' } });
        closeDialog();
        toast('克隆已开始，通常几分钟；完成后会出现在音色下拉里', 'success');
        refreshAvatarRuns(true);
      } catch (error) {
        toast(error.message, 'error');
        go.disabled = false; go.innerHTML = '开始克隆';
      }
    };
  }
  function renderAvatarPanel() {
    var box = $('#wb-avatar-panel');
    if (!box) return;
    var readyVoices = state.voices.filter(function (item) { return item.status === 'ready'; });
    var training = state.voices.filter(function (item) { return item.status === 'training'; });
    var imageAssets = state.assets.filter(function (item) { return item.kind === 'image'; });
    box.innerHTML = '<div class="wb-card-head"><div><h3>数字人口播</h3><p>用自己的音色和形象照，把文案直接变成对口型口播视频（音色克隆 → 语音合成 → 对口型）。成片进素材库「数字人」文件夹。</p></div></div>' +
      '<form id="wb-avatar-form" class="wb-form">' +
      '<label class="wb-field"><span>音色</span><select name="voiceId">' + (readyVoices.length ? readyVoices.map(function (v) { return '<option value="' + esc(v.id) + '">' + esc(v.name) + '</option>'; }).join('') : '<option value="">（先克隆一个音色）</option>') + '</select></label>' +
      '<label class="wb-field"><span>形象照（正面人脸清晰）</span><select name="imageAssetId">' + (imageAssets.length ? imageAssets.slice(0, 30).map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.fileName) + '</option>'; }).join('') : '<option value="">（素材库里还没有图片）</option>') + '</select></label>' +
      '<label class="wb-field full"><span>口播文案</span><textarea name="text" placeholder="把要口播的文案粘进来（建议 200 字内一段）"></textarea></label>' +
      '<div class="wb-field full wb-actions"><button class="btn primary" type="submit"' + (readyVoices.length && imageAssets.length ? '' : ' disabled') + '>' + ic('video', 13) + '生成口播视频</button>' +
      '<button class="btn" type="button" id="wb-voice-clone-open">' + ic('plus', 12) + '克隆新音色</button>' +
      (training.length ? '<span class="wb-note">' + ic('loader', 11) + ' ' + training.length + ' 个音色克隆中…</span>' : '') +
      '<span class="wb-note">按次计费（克隆/合成/对口型各一步）；20 次/小时。</span></div></form>' +
      '<div id="wb-avatar-list" style="margin-top:10px"></div>';
    renderAvatarList();
    $('#wb-voice-clone-open').onclick = openCloneVoiceDialog;
    var form = $('#wb-avatar-form');
    form.onsubmit = async function (event) {
      event.preventDefault();
      var button = form.querySelector('[type="submit"]');
      var original = button.innerHTML;
      button.disabled = true; button.innerHTML = ic('loader', 12) + '提交中…';
      try {
        var data = Object.fromEntries(new FormData(form).entries());
        data.accountId = state.accountId;
        await call('/avatar/run', { method: 'POST', body: data });
        toast('已提交，全流程通常 3-6 分钟；这一页会自动刷新', 'success');
        refreshAvatarRuns(true);
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false; button.innerHTML = original;
      }
    };
  }
  async function backfillStats(draftId) {
    showDialog('回填发布数据', '<p class="wb-note">上传这条文案发布后的抖音作者端数据截图（播放/点赞/评论等），系统自动识别存档。</p>' +
      '<label class="btn primary" for="wb-stats-input">选择截图</label>' +
      '<input id="wb-stats-input" type="file" hidden accept=".jpg,.jpeg,.png,.webp">' +
      '<p class="wb-note" id="wb-stats-msg" style="margin-top:8px"></p>');
    var input = $('#wb-stats-input');
    input.onchange = async function () {
      var file = (input.files || [])[0];
      if (!file) return;
      var msg = $('#wb-stats-msg');
      msg.textContent = '上传并识别中…';
      try {
        var form = new FormData();
        form.append('file', file);
        form.append('accountId', state.accountId);
        var uploaded = await call('/assets', { method: 'POST', body: form });
        var result = await call('/copy/' + encodeURIComponent(draftId) + '/stats', { method: 'POST', body: { assetId: uploaded.asset.id } });
        var stats = (result.data || result).stats || {};
        msg.textContent = '已识别：播放 ' + (stats.plays ?? '—') + ' · 赞 ' + (stats.likes ?? '—') + ' · 评论 ' + (stats.comments ?? '—') + (stats.publishedAt ? ' · ' + stats.publishedAt : '');
        toast('发布数据已回填', 'success');
        var refreshed = await call('/copy');
        state.copy = refreshed.items || state.copy;
        if (state.tab === 'copy') renderCopy();
        setTimeout(closeDialog, 1200);
      } catch (error) {
        msg.textContent = '';
        toast(error.message, 'error');
      }
    };
  }

  /* ───────────── 视频创作（脚本 + 真实渲染） ───────────── */
  function focusDetail() {
    requestAnimationFrame(function () {
      var detail = $('.wb-detail');
      if (detail) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  var RENDER_STATUS = { running: '生成中', succeeded: '完成', failed: '失败' };
  function renderStatusText(value) { return RENDER_STATUS[value] || value || '—'; }
  async function loadRenders(projectId, silent) {
    if (!projectId) return;
    try {
      var data = await call('/video/renders?projectId=' + encodeURIComponent(projectId));
      state.renders = data.items || [];
    } catch (error) {
      if (!silent) toast(error.message, 'error');
      return;
    }
    if (state.tab === 'video' && state.selectedVideo && state.selectedVideo.id === projectId) renderRenderList();
    var running = state.renders.some(function (item) { return item.status === 'running'; });
    if (running && !state.renderTimer) {
      state.renderTimer = setInterval(function () {
        if (state.tab !== 'video') { stopRenderPolling(); return; }
        loadRenders(projectId, true);
      }, 5000);
    } else if (!running) {
      stopRenderPolling();
    }
  }
  function renderStatusChip(item) {
    return '<span class="wb-tag ' + (item.status === 'succeeded' ? 'ok' : item.status === 'failed' ? 'bad' : '') + '">' + esc(renderStatusText(item.status)) + '</span>';
  }
  function renderRenderList() {
    var box = $('#wb-render-list');
    if (!box) return;
    var renders = state.renders;
    box.innerHTML = renders.length ? renders.map(function (item) {
      var video = '';
      if (item.status === 'succeeded' && item.assetId) {
        video = '<video class="wb-render-video" controls preload="metadata" data-render-video="' + esc(item.assetId) + '"></video>';
      }
      return '<div class="wb-render">' +
        '<div class="wb-card-head"><div><b>' + esc(item.title || '视频渲染') + '</b>' + renderStatusChip(item) +
        '<div class="wb-meta">' + fmtDate(item.createdAt) + (item.durationSeconds ? ' · ' + item.durationSeconds + ' 秒' : '') + (item.aspectRatio ? ' · ' + esc(item.aspectRatio) : '') + '</div></div></div>' +
        (item.status === 'failed' ? '<p class="err">' + ic('alert', 13) + '<span>' + esc(item.error || '生成失败') + '</span></p>' : '') +
        (item.status === 'running' ? '<p class="wb-note">' + ic('loader', 12) + ' 已提交到平台视频渠道，通常要几分钟；这一页会自动刷新，也可以先去做别的。</p>' : '') +
        video + '</div>';
    }).join('') : '<p class="wb-muted">还没有渲染记录。把要生成的画面描述或口播填在下面提交。</p>';
    hydrateRenderVideos();
  }
  async function hydrateRenderVideos() {
    var videos = $$('[data-render-video]');
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      if (video.dataset.loaded) continue;
      video.dataset.loaded = '1';
      try {
        var blob = await fetchBlob(API + '/assets/' + encodeURIComponent(video.dataset.renderVideo) + '/file');
        video.src = URL.createObjectURL(blob);
      } catch (e) { /* 视频加载失败时保留播放器外壳，控制台可见 */ }
    }
  }
  function renderVideo() {
    var formState = state.videoForm || {};
    var selected = state.selectedVideo;
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>新建视频项目</h3><p>从需求到分镜、口播和 SRT；复刻模式先拆参考结构，再给替换点。</p></div>' +
      '<label class="wb-inline"><span>账号</span>' + accountSelectHtml('id="wb-video-account"') + '</label></div>' +
      '<form id="wb-video-form" class="wb-form">' +
      '<label class="wb-field full"><span>视频主题</span><input name="title" required placeholder="例如：为什么体验课要这样上" value="' + esc(formState.title || '') + '"></label>' +
      '<label class="wb-field"><span>模式</span><select name="mode">' + ['原创', '复刻'].map(function (m) { return '<option' + (formState.mode === m ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></label>' +
      '<label class="wb-field"><span>目标时长</span><input value="30-60 秒" disabled></label>' +
      '<label class="wb-field full"><span>需求说明</span><textarea name="brief" placeholder="课程、人群、想引导的动作，或想保留/替换的部分">' + esc(formState.brief || '') + '</textarea></label>' +
      '<label class="wb-field full"><span>参考内容（复刻模式）</span><textarea name="referenceText" placeholder="粘贴参考视频的口播文字、结构说明或链接">' + esc(formState.referenceText || '') + '</textarea></label>' +
      '<div class="wb-field full wb-actions"><button class="btn primary" type="submit">生成分镜脚本</button><span class="wb-note">脚本用平台模型渠道；真实成片在下方「AI 生成视频」提交。</span></div></form></div>' +
      '<div id="wb-avatar-panel"></div>' +
      (state.videos.length ? '<div class="wb-cards">' + state.videos.map(function (item) {
        return '<article class="wb-item click' + (selected && selected.id === item.id ? ' current' : '') + '" data-video-open="' + esc(item.id) + '">' +
          '<div class="wb-card-head"><h4>' + esc(item.title) + '</h4><span class="wb-tag">' + esc(item.mode) + '</span></div>' +
          '<div class="wb-meta">' + fmtDate(item.createdAt) + ' · ' + esc(videoStatusText(item.status)) + ' · ' + esc(accountName(item.accountId)) + '</div>' +
          '<p class="wb-preview">' + esc(String(item.script || '').replace(/[#*|>`-]/g, ' ').replace(/\s+/g, ' ').slice(0, 150)) + '</p></article>';
      }).join('') + '</div>' : '<div class="wb-card"><p class="wb-muted">这个账号还没有视频项目。写一个主题和需求，先生成一版分镜。</p></div>') +
      (selected ? '<div class="wb-card wb-detail"><div class="wb-card-head"><div><h3>' + esc(selected.title) + '</h3><p>' + esc(selected.mode) + ' · 创建于 ' + fmtDate(selected.createdAt) + '</p></div>' +
        '<div class="wb-actions"><button class="btn primary" type="button" id="wb-save-video-top">保存修改</button><button class="btn" type="button" id="wb-close-video">收起</button></div></div>' +
        '<label class="wb-field"><span>口播/分镜脚本</span><textarea class="wb-script" id="wb-script-editor">' + esc(selected.script) + '</textarea></label>' +
        '<div class="wb-export"><button class="btn" type="button" data-export="md">导出 Markdown</button>' +
        '<button class="btn" type="button" data-export="srt">导出 SRT</button>' +
        '<button class="btn" type="button" data-export="json">导出 JSON</button>' +
        '<button class="btn primary" type="button" id="wb-save-video">保存修改</button>' +
        '<button class="btn" type="button" id="wb-video-check">' + ic('shield', 12) + '合规体检</button></div>' +
        '<p class="wb-note" style="margin-top:9px">状态：' + esc(videoStatusText(selected.status)) + ' · 保存后再导出，导出的是最新脚本。</p></div>' +
        '<div class="wb-card"><div class="wb-card-head"><div><h3>AI 生成视频</h3><p>把一个分镜的画面描述或口播交给平台的视频渠道，几分钟出片，成片自动进素材库（文件夹「AI 生成」）。</p></div></div>' +
        '<form id="wb-render-form" class="wb-form">' +
        '<label class="wb-field full"><span>画面描述 / 口播</span><textarea name="prompt" required placeholder="从左边脚本里复制一个分镜的画面与口播，例如：画室里孩子低头画画，镜头缓推，口播：很多家长问，几岁适合开始学美术……"></textarea></label>' +
        '<label class="wb-field"><span>时长</span><select name="durationSeconds">' + [5, 10, 15].map(function (n) { return '<option value="' + n + '">' + n + ' 秒</option>'; }).join('') + '</select></label>' +
        '<label class="wb-field"><span>画幅</span><select name="aspectRatio">' + ['9:16', '16:9', '1:1', 'auto'].map(function (a) { return '<option value="' + a + '"' + (a === '9:16' ? ' selected' : '') + '>' + (a === 'auto' ? '自动（跟首帧/默认）' : a) + '</option>'; }).join('') + '</select></label>' +
        '<div class="wb-field full wb-actions"><button class="btn primary" type="submit">' + ic('video', 13) + '提交生成</button><span class="wb-note">走平台已有视频渠道，按机构限 20 次/小时；数字人口播与 1:1 复刻仍是二期外。</span></div></form>' +
        '<div id="wb-render-list" style="margin-top:10px"></div></div>' : '') +
      '</div></div>';
    bindAccountSwitch('#wb-video-account');
    renderAvatarPanel();
    refreshAvatarRuns(true);
    $('#wb-video-form').onsubmit = async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var button = form.querySelector('[type="submit"]');
      var original = button.innerHTML;
      button.disabled = true; button.innerHTML = ic('loader', 13) + '生成中…';
      try {
        var data = Object.fromEntries(new FormData(form).entries());
        data.accountId = state.accountId;
        state.videoForm = { title: data.title, mode: data.mode, brief: data.brief, referenceText: data.referenceText };
        var result = await call('/videos', { method: 'POST', body: data });
        state.videos.unshift(result.project);
        state.selectedVideo = result.project;
        renderVideo();
        focusDetail();
        toast(result.demo ? '已生成演示分镜（模型未返回正文）' : '分镜已生成', 'success');
      } catch (error) { toast(error.message, 'error'); button.disabled = false; button.innerHTML = original; }
    };
    $$('[data-video-open]').forEach(function (card) {
      card.onclick = function () {
        var project = state.videos.filter(function (item) { return item.id === card.dataset.videoOpen; })[0];
        if (!project) return;
        state.selectedVideo = project;
        renderVideo();
        focusDetail();
      };
    });
    var close = $('#wb-close-video');
    if (close) close.onclick = function () { state.selectedVideo = null; stopRenderPolling(); renderVideo(); };
    var save = async function (button) {
      button.disabled = true;
      try {
        var project = await call('/videos/' + encodeURIComponent(selected.id), { method: 'PUT', body: $('#wb-script-editor').value ? { script: $('#wb-script-editor').value } : {} });
        state.selectedVideo = project.project;
        state.videos = state.videos.map(function (item) { return item.id === project.project.id ? project.project : item; });
        renderVideo();
        focusDetail();
        toast('脚本已保存', 'success');
      } catch (error) { toast(error.message, 'error'); button.disabled = false; }
    };
    if ($('#wb-save-video')) $('#wb-save-video').onclick = function () { save(this); };
    if ($('#wb-save-video-top')) $('#wb-save-video-top').onclick = function () { save(this); };
    if ($('#wb-video-check')) $('#wb-video-check').onclick = function () { checkCompliance($('#wb-script-editor').value); };
    $$('[data-export]').forEach(function (button) {
      button.onclick = function () { downloadExport(selected.id, button.dataset.export, selected.title); };
    });
    var renderForm = $('#wb-render-form');
    if (renderForm) {
      renderForm.onsubmit = async function (event) {
        event.preventDefault();
        var button = renderForm.querySelector('[type="submit"]');
        var original = button.innerHTML;
        button.disabled = true; button.innerHTML = ic('loader', 13) + '提交中…';
        try {
          var data = Object.fromEntries(new FormData(renderForm).entries());
          data.projectId = selected.id;
          data.accountId = state.accountId;
          var result = await call('/video/render', { method: 'POST', body: data });
          state.renders.unshift(result.render);
          renderRenderList();
          renderForm.prompt.value = '';
          if (!state.renderTimer) loadRenders(selected.id, true);
          toast('已提交视频生成，通常几分钟内完成', 'success');
        } catch (error) {
          toast(error.message, 'error');
        } finally { button.disabled = false; button.innerHTML = original; }
      };
      renderRenderList();
      loadRenders(selected.id, true);
    }
  }

  /* ───────────── 素材库（账号 + 文件夹） ───────────── */
  function renderAssets() {
    var items = state.assets;
    var folders = [{ folder: '', count: items.length }].concat(
      (state.assetFolders || []).filter(function (row) { return row.folder; })
    );
    var folderChips = folders.map(function (row) {
      var active = (state.assetFolder || '') === row.folder;
      return '<button class="chip' + (active ? ' on' : '') + '" type="button" data-folder="' + esc(row.folder) + '">' +
        (row.folder ? esc(row.folder) : '全部') + '<small> ' + row.count + '</small></button>';
    }).join('');
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>素材库</h3><p>图片、视频、音频和文本保存在本机/机构文件存储；不会上传到第三方。AI 生成的视频会自动进「AI 生成」文件夹。</p></div>' +
      '<label class="wb-inline"><span>账号</span>' + accountSelectHtml('id="wb-asset-account"') + '</label></div>' +
      '<div class="chips" style="margin:2px 0 10px">' + folderChips + '</div>' +
      '<div class="wb-account-bar"><label class="btn primary" for="wb-asset-input">' + ic('upload', 13) + '上传素材</label>' +
      '<input id="wb-asset-input" type="file" multiple hidden accept=".jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.webm,.m4v,.mp3,.m4a,.wav,.aac,.txt,.md">' +
      '<label class="wb-inline"><span>放入文件夹</span><input id="wb-asset-folder" placeholder="留空=不分组，如：课堂实拍" maxlength="60" style="max-width:200px"></label></div>' +
      (items.length ? '<div class="wb-asset-grid">' + items.map(function (item) {
        var thumb = item.kind === 'image'
          ? '<img data-asset-img="' + esc(item.id) + '" alt="' + esc(item.fileName) + '" loading="lazy">'
          : ic(item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'music' : 'folder', 28);
        return '<article class="wb-asset"><div class="wb-thumb">' + thumb + '</div><div class="wb-asset-info"><b title="' + esc(item.fileName) + '">' + esc(item.fileName) + '</b>' +
          '<small>' + esc(item.kind) + ' · ' + fmtSize(item.size) + ' · ' + fmtDate(item.createdAt) +
          (item.folder ? ' · 📁 ' + esc(item.folder) : '') + ' · ' + esc(accountName(item.accountId)) + '</small>' +
          '<div class="wb-actions"><button class="btn" type="button" data-asset-open="' + esc(item.id) + '">打开</button>' +
          '<button class="btn" type="button" data-asset-move="' + esc(item.id) + '">移动</button>' +
          '<button class="btn" type="button" data-asset-del="' + esc(item.id) + '">' + ic('trash', 12) + '</button></div></div></article>';
      }).join('') + '</div>' : '<p class="wb-muted">这个筛选下还没有素材。上传课程图、课堂视频、参考音频或口播文本。</p>') +
      '</div></div></div>';
    bindAccountSwitch('#wb-asset-account');
    $$('[data-folder]').forEach(function (chip) {
      chip.onclick = async function () {
        state.assetFolder = chip.dataset.folder;
        try {
          var query = '?accountId=' + encodeURIComponent(state.accountId) + (state.assetFolder ? '&folder=' + encodeURIComponent(state.assetFolder) : '');
          var data = await call('/assets' + query);
          state.assets = data.items || [];
          state.assetFolders = data.folders || state.assetFolders;
        } catch (error) { toast(error.message, 'error'); }
        renderAssets();
      };
    });
    var input = $('#wb-asset-input');
    input.onchange = async function () {
      var files = Array.prototype.slice.call(input.files || []);
      if (!files.length) return;
      var folder = String(($('#wb-asset-folder') || {}).value || '').trim();
      for (var i = 0; i < files.length; i++) {
        var form = new FormData();
        form.append('file', files[i]);
        if (folder) form.append('folder', folder);
        form.append('accountId', state.accountId);
        try {
          var result = await call('/assets', { method: 'POST', body: form });
          state.assets.unshift(result.asset);
          state.assetFolders = null; // 重新拉文件夹计数
          try {
            var fresh = await call('/assets?accountId=' + encodeURIComponent(state.accountId));
            state.assetFolders = fresh.folders || [];
          } catch (e) { /* 忽略 */ }
          renderAssets();
          toast(files[i].name + ' 已上传', 'success');
        } catch (error) { toast(files[i].name + '：' + error.message, 'error'); }
      }
    };
    $$('[data-asset-open]').forEach(function (button) {
      button.onclick = function () { openAsset(button.dataset.assetOpen); };
    });
    $$('[data-asset-move]').forEach(function (button) {
      button.onclick = async function () {
        var current = (state.assets.filter(function (item) { return item.id === button.dataset.assetMove; })[0] || {}).folder || '';
        var folder = prompt('移动到文件夹（留空 = 不分组）：', current);
        if (folder === null) return;
        try {
          var result = await call('/assets/' + encodeURIComponent(button.dataset.assetMove), { method: 'PUT', body: { folder: folder } });
          state.assets = state.assets.map(function (item) { return item.id === result.asset.id ? result.asset : item; });
          renderAssets();
          toast('已移动', 'success');
        } catch (error) { toast(error.message, 'error'); }
      };
    });
    $$('[data-asset-del]').forEach(function (button) {
      button.onclick = async function () {
        if (!confirm('删除这份素材？文件也会一起删除。')) return;
        try {
          await call('/assets/' + encodeURIComponent(button.dataset.assetDel), { method: 'DELETE' });
          state.assets = state.assets.filter(function (item) { return item.id !== button.dataset.assetDel; });
          renderAssets();
        } catch (error) { toast(error.message, 'error'); }
      };
    });
    hydrateAssetThumbs();
  }

  /* ───────────── 报表 / 任务 ───────────── */
  function renderReports() {
    var stats = (state.summary && state.summary.stats) || {};
    var cards = [['对话消息', stats.messages || 0, '条'], ['文案草稿', stats.copy_drafts || 0, '条'], ['视频项目', stats.videos || 0, '个'], ['素材', stats.assets || 0, '份'], ['同行观察', stats.references || 0, '条'], ['生成任务', stats.jobs || 0, '次']];
    var jobs = (state.summary && state.summary.jobs) || state.jobs.slice(0, 8);
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>账号资产概览</h3><p>当前机构的内容资产与最近任务。</p></div></div>' +
      '<div class="wb-stats">' + cards.map(function (item) { return '<div class="wb-stat"><span>' + item[0] + '</span><b>' + item[1] + '<small style="font-size:11px;color:var(--text-3);font-weight:400"> ' + item[2] + '</small></b></div>'; }).join('') + '</div></div>' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>最近任务</h3><p>生成成功或失败都会记录。</p></div><button class="btn" type="button" data-wb-go="jobs">查看全部</button></div>' +
      (jobs.length ? '<table class="wb-table"><thead><tr><th>类型</th><th>状态</th><th>说明</th><th>时间</th></tr></thead><tbody>' +
        jobs.map(function (job) { return '<tr><td>' + esc(job.kind) + '</td><td>' + esc(jobStatusText(job.status)) + '</td><td>' + esc(job.detail) + '</td><td>' + fmtDate(job.createdAt) + '</td></tr>'; }).join('') + '</tbody></table>' : '<p class="wb-muted">还没有任务。</p>') +
      '</div></div></div>';
    $$('[data-wb-go]').forEach(function (button) { button.onclick = function () { setTab(button.dataset.wbGo); }; });
  }
  function renderJobs() {
    var jobs = state.jobs;
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll"><div class="wb-card"><div class="wb-card-head"><div><h3>任务流水</h3><p>文案/视频生成的每次状态。</p></div></div>' +
      (jobs.length ? '<table class="wb-table"><thead><tr><th>类型</th><th>状态</th><th>说明</th><th>创建</th><th>更新</th></tr></thead><tbody>' +
        jobs.map(function (job) { return '<tr><td>' + esc(job.kind) + '</td><td>' + esc(jobStatusText(job.status)) + '</td><td>' + esc(job.detail) + '</td><td>' + fmtDate(job.createdAt) + '</td><td>' + fmtDate(job.updatedAt) + '</td></tr>'; }).join('') + '</tbody></table>' : '<p class="wb-muted">还没有历史任务。</p>') +
      '</div></div></div>';
  }

  /* ───────────── 引导式创作工作流（消息流卡片 · 乐观 UI · 流式预览 · 双击改稿） ───────────── */
  function wfStageSteps(wf) {
    var stepsByKind = {
      today: ['选题', '写作大脑', '改写', '完成'],
      viral: ['来源', '提取原文', '原文确认', '改写', '完成'],
      hotspot: ['找热点', '选热点', '结合方式', '写作大脑', '改写', '完成'],
    };
    var order = {
      idea: 0, brain: 1, rewriting: 2, copy: 2, ready: 2,
      transcript: 2, extracting: 1, extract_failed: 1,
      searching: 0, hotspots_ready: 1, angle: 2,
    };
    var list = stepsByKind[wf.kind] || [];
    var current = order[wf.stage] != null ? order[wf.stage] : 0;
    if (wf.stage === 'done') return list.map(function (label) { return '<span class="done">✓ ' + label + '</span>'; }).join('');
    return list.map(function (label, index) {
      return '<span class="' + (index < current ? 'done' : index === current ? 'current' : '') + '">' + (index < current ? '✓ ' : index === current ? '● ' : '') + label + '</span>';
    }).join('');
  }
  function wfOptionCard(wf, option, index, preview) {
    var isIdea = wf.stage === 'idea';
    var body = isIdea
      ? '<p><b>' + esc(option.title || '') + '</b></p><p>钩子：' + esc(option.hook || '') + '</p><p class="wb-note">为什么今天发：' + esc(option.why || '') + '</p>'
      : '<h4>' + esc(option.title || '版本' + (index + 1)) + '</h4><div class="wb-copy-body">' + md(option.content || '') + '</div>';
    var actions = '<div class="wb-actions">' +
      '<button class="btn primary" type="button" data-wf-select="' + esc(option.id) + '">' + (isIdea ? '用这个选题' : '选择这个版本') + '</button>' +
      (isIdea ? '<button class="btn" type="button" data-wf-inspire="' + esc(option.id) + '">存为灵感</button>' : '') +
      (!isIdea ? '<button class="btn" type="button" data-wf-copy-text="' + esc(option.id) + '">' + ic('copy', 12) + '复制</button>' : '') +
      '</div>';
    var hint = preview ? '<small class="wb-option-hint">已成型，后续版本继续生成中；双击卡片可直接修改</small>' : '<small class="wb-option-hint">双击这张卡片可直接修改后使用</small>';
    return '<article class="wb-item wb-flow-option" data-wf-option="' + esc(option.id) + '">' + body + hint + actions + '</article>';
  }
  function wfBlueprintHtml(blueprint) {
    if (!blueprint || (!blueprint.hook && !blueprint.turn && !blueprint.closing && !(blueprint.progression || []).length)) return '';
    return '<details class="wb-blueprint"><summary>查看这条爆款的复刻蓝图</summary><div class="wb-blueprint-grid">' +
      (blueprint.hook ? '<p><b>开头机制：</b>' + esc(blueprint.hook) + '</p>' : '') +
      ((blueprint.progression || []).length ? '<p><b>信息推进：</b>' + esc((blueprint.progression || []).join(' → ')) + '</p>' : '') +
      (blueprint.turn ? '<p><b>转折：</b>' + esc(blueprint.turn) + '</p>' : '') +
      (blueprint.closing ? '<p><b>收束：</b>' + esc(blueprint.closing) + '</p>' : '') +
      '</div></details>';
  }
  function workflowCardHtml(wf) {
    if (!wf || wf.status !== 'active') return '';
    var head = '<div class="wb-card-head"><h3>' + esc(wf.kindLabel) + '</h3>' +
      '<button class="btn" type="button" data-wf-cancel="' + esc(wf.id) + '">放弃</button></div>' +
      '<div class="wb-flow-steps">' + wfStageSteps(wf) + '</div>';
    var body = '';
    if (wf.stage === 'extracting') {
      body = '<p>' + esc(wf.state.message || '正在提取原视频口播文案…') + '</p><progress></progress>';
    } else if (wf.stage === 'extract_failed') {
      body = '<p class="err">' + ic('alert', 13) + '<span>' + esc(wf.state.extractError || '提取没有成功') + '</span></p>' +
        '<div class="wb-actions"><button class="btn primary" type="button" data-wf-restart-viral>重新选择来源</button></div>';
    } else if (wf.stage === 'transcript') {
      body = '<label class="wb-note">提取到的原始文案（可直接修改错字、品牌名或转写错误；确认后才开始结合账号资料改写）</label>' +
        '<textarea id="wb-wf-transcript" class="wb-script" style="min-height:120px">' + esc(wf.state.transcript || '') + '</textarea>' +
        '<div class="wb-actions"><button class="btn primary" type="button" data-wf-action="confirm_transcript">确认原文，开始复刻</button>' +
        '<button class="btn" type="button" data-wf-copy-transcript>复制原文</button></div>';
    } else if (wf.kind === 'hotspot' && wf.stage === 'searching') {
      body = '<p class="wb-note">关键词：' + esc(wf.state.keyword || '') + ' · 正在用 DeepSeek 搜索近 3 天新闻并按你的账号挑热点，通常十几秒。</p><progress></progress>';
    } else if (wf.kind === 'hotspot' && wf.stage === 'hotspots_ready') {
      var found = wf.state.hotspots || [];
      body = '<h4>最值得这个账号结合的 ' + found.length + ' 个热点</h4>' +
        '<p class="wb-note">来自 DeepSeek 联网搜索（近 3 天），已按账号相关性筛选。</p>' +
        '<div class="wb-news-list">' + found.map(function (item) {
          return '<article class="wb-news-card"><div class="wb-news-head"><b>' + esc(item.title || '') + '</b>' +
            (item.recommendedAngle ? '<span class="wb-tag ok">建议：' + esc(item.recommendedAngle) + '</span>' : '') + '</div>' +
            '<p>' + esc(item.fact || '') + '</p>' +
            (item.relation ? '<p class="wb-note">与你的账号：' + esc(item.relation) + '</p>' : '') +
            '<small>' + esc(item.source || '') + (item.publishedAt ? ' · ' + esc(String(item.publishedAt).slice(0, 10)) : '') + '</small>' +
            '<div class="wb-actions"><button class="btn primary" type="button" data-wf-hotspot="' + esc(item.id) + '">用这个热点创作</button>' +
            (item.sourceUrl ? '<a class="btn" href="' + esc(item.sourceUrl) + '" target="_blank" rel="noopener noreferrer">查看来源 ↗</a>' : '') +
            '</div></article>';
        }).join('') + '</div>';
    } else if (wf.kind === 'hotspot' && wf.stage === 'search_failed') {
      body = '<p class="err">' + ic('alert', 13) + '<span>' + esc(wf.state.searchError || '搜索没有成功') + '</span></p>' +
        '<div class="wb-actions"><button class="btn primary" type="button" data-wf-search-retry>' + ic('refresh', 12) + '重新搜索</button>' +
        '<button class="btn" type="button" data-wf-search-manual>改用手动填写</button></div>';
    } else if (wf.stage === 'brain') {
      var context = wf.kind === 'today'
        ? '选题：<b>' + esc((wf.state.selectedIdea || {}).title || '') + '</b>'
        : wf.kind === 'hotspot'
          ? '热点：<b>' + esc((wf.state.hotspot || {}).title || '') + '</b> · 结合方式：<b>' + esc(wf.state.angle || '') + '</b>'
          : '原文已确认';
      var brains = (state.workflowMeta.brains || []);
      body = '<p class="wb-note">' + context + '</p><h4>这次怎么写？</h4><p class="wb-note">账号档案负责事实和相关性；写作大脑只负责借方法，不模仿原作者身份。</p><div class="wb-choice-grid">' +
        '<button class="wb-choice" type="button" data-wf-brain=""><b>系统基础表达</b><small>不套用任何大脑，用自然、清楚、有观点的口播表达。可选表达风格。</small></button>' +
        brains.map(function (brain) {
          return '<button class="wb-choice" type="button" data-wf-brain="' + esc(brain.id) + '"><b>' + esc(brain.name) + '</b><small>借用这个大脑的结构、节奏和表达方法' + (brain.kind === 'peer_report' ? '（来自同行研究）' : '') + '。</small></button>';
        }).join('') + '</div>' +
        '<details style="margin-top:8px"><summary>不用大脑，选一种表达风格</summary><div class="wb-choice-grid" style="margin-top:8px">' +
        (state.workflowMeta.styles || []).map(function (style) {
          return '<button class="wb-choice" type="button" data-wf-style="' + esc(style) + '"><b>' + esc(style) + '</b></button>';
        }).join('') + '</div></details>' +
        (brains.length ? '' : '<p class="wb-note" style="margin-top:6px">还没有写作大脑？去「文案大脑」页签，用已转写的档案蒸馏一个。</p>');
    } else if (wf.stage === 'idea') {
      var options = wf.state.ideaOptions || [];
      body = '<h4>今天最值得拍的 ' + options.length + ' 个选题</h4>' +
        '<div class="wb-cards">' + options.map(function (option, index) { return wfOptionCard(wf, option, index, false); }).join('') + '</div>' +
        '<div class="wb-actions"><button class="btn" type="button" data-wf-action="regenerate">' + ic('refresh', 12) + '换一批</button></div>';
    } else if (wf.stage === 'rewriting' || wf.stage === 'copy' || wf.stage === 'ready') {
      var copyOptions = wf.state.copyOptions || [];
      var isReady = wf.stage === 'ready';
      var previews = copyOptions.filter(function (item) { return item.content || item.title; });
      body = (isReady
        ? wfBlueprintHtml(wf.state.blueprint) + '<h4>3 个版本：选择、双击修改或直接复制</h4>'
        : '<p>' + esc(wf.state.message || '正在拆解结构并结合账号资料改写 3 个版本…') + '</p>' + (previews.length ? '<p class="wb-note">已经完成 ' + previews.length + ' / 3 个版本，先展示写好的：</p>' : '<progress></progress>')) +
        '<div class="wb-cards">' + previews.map(function (option, index) { return wfOptionCard(wf, option, index, !isReady); }).join('') + '</div>' +
        (isReady ? '<div class="wb-actions"><button class="btn" type="button" data-wf-action="regenerate">' + ic('refresh', 12) + '换一批</button><small>不会做自动复刻校验；请人工看一遍再发布。</small></div>' : '');
    } else if (wf.stage === 'failed') {
      body = '<p class="err">' + ic('alert', 13) + '<span>' + esc(wf.error || '这次没有正常完成。') + '</span></p>';
    }
    if (!body) return '';
    return '<div class="wb-card wb-flow-card">' + head + body + '</div>';
  }
  function stopWfPolling() {
    if (state.wfPollTimer) { clearInterval(state.wfPollTimer); state.wfPollTimer = null; }
  }
  /** 工作流进行中就快速轮询（对齐原版 320ms 高频；这里 900ms，兼顾服务器压力）。 */
  function ensureWfPolling() {
    if (state.wfPollTimer) return;
    state.wfPollTimer = setInterval(async function () {
      if (state.tab !== 'chat' || !state.workflow || state.workflow.status !== 'active') { stopWfPolling(); return; }
      var wfId = state.workflow.id;
      if (String(wfId).indexOf('optimistic-') === 0) return;
      try {
        var data = await call('/workflows?accountId=' + encodeURIComponent(state.workflow.accountId || state.accountId));
        var latest = (data.items || []).filter(function (item) { return item.id === wfId; })[0];
        if (!latest) { stopWfPolling(); return; }
        var before = JSON.stringify([state.workflow.stage, state.workflow.updatedAt, (state.workflow.state || {}).copyOptions]);
        state.workflow = latest;
        if (latest.status !== 'active') stopWfPolling();
        if (before !== JSON.stringify([latest.stage, latest.updatedAt, (latest.state || {}).copyOptions])) renderMessages(true);
      } catch (error) { /* 轮询失败静默 */ }
    }, 900);
    if (state.wfPollTimer.unref) state.wfPollTimer.unref();
  }
  function refreshWorkflowCard() {
    renderMessages(true);
    ensureWfPolling();
  }
  function bindWorkflowCard() {
    $$('[data-wf-cancel]').forEach(function (button) {
      button.onclick = async function () {
        if (!confirm('放弃当前创作流程？')) return;
        try { await call('/workflows/' + encodeURIComponent(button.dataset.wfCancel) + '/action', { method: 'POST', body: { action: 'cancel' } }); } catch (error) { toast(error.message, 'error'); }
        state.workflow = null;
        renderMessages(true);
      };
    });
    $$('[data-wf-restart-viral]').forEach(function (button) {
      button.onclick = function () { state.workflow = null; renderMessages(true); openViralSourceChooser(); };
    });
    var actionButton = $('[data-wf-action]');
    if (actionButton) {
      actionButton.onclick = async function () {
        var action = actionButton.dataset.wfAction;
        var payload = { action: action };
        if (action === 'confirm_transcript') {
          var textarea = $('#wb-wf-transcript');
          if (!textarea || !textarea.value.trim()) { toast('原文不能为空', 'error'); return; }
          payload.text = textarea.value;
        }
        var original = actionButton.innerHTML;
        actionButton.disabled = true; actionButton.innerHTML = ic('loader', 12) + '提交中…';
        try {
          if (action === 'regenerate' && state.workflow && ['rewriting', 'copy', 'ready'].includes(state.workflow.stage)) {
            await call('/workflows/' + encodeURIComponent(state.workflow.id) + '/action', { method: 'POST', body: { action: 'regenerate' } });
            state.workflow.stage = 'rewriting';
            state.workflow.state.copyOptions = [];
            state.workflow.state.message = '正在重新生成 3 个版本…';
            renderMessages(true); ensureWfPolling();
          } else {
            var result = await call('/workflows/' + encodeURIComponent(state.workflow.id) + '/action', { method: 'POST', body: payload });
            state.workflow = (result.data || result).workflow;
            renderMessages(true); ensureWfPolling();
          }
        } catch (error) {
          toast(error.message, 'error');
          actionButton.disabled = false; actionButton.innerHTML = original;
        }
      };
    }
    $$('[data-wf-copy-transcript]').forEach(function (button) {
      button.onclick = function () {
        var value = (state.workflow && state.workflow.state.transcript) || '';
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(function () { toast('原文已复制', 'success'); });
      };
    });
    $$('[data-wf-hotspot]').forEach(function (button) {
      button.onclick = function () { wfChoose({ action: 'select_hotspot', hotspotId: button.dataset.wfHotspot }, button); };
    });
    var retryButton = $('[data-wf-search-retry]');
    if (retryButton) {
      retryButton.onclick = async function () {
        try {
          var result = await call('/workflows/' + encodeURIComponent(state.workflow.id) + '/action', { method: 'POST', body: { action: 'search_retry' } });
          state.workflow = (result.data || result).workflow;
          renderMessages(true); ensureWfPolling();
        } catch (error) { toast(error.message, 'error'); }
      };
    }
    var manualButton = $('[data-wf-search-manual]');
    if (manualButton) {
      manualButton.onclick = async function () {
        try { await call('/workflows/' + encodeURIComponent(state.workflow.id) + '/action', { method: 'POST', body: { action: 'search_switch_manual' } }); } catch (error) { /* 忽略 */ }
        state.workflow = null;
        renderMessages(true);
        openFlowStartDialog('hotspot');
      };
    }
    $$('[data-wf-strength]').forEach(function (button) {
      button.onclick = function () { wfChoose({ action: 'choose_strength', strength: button.dataset.wfStrength }, button); };
    });
    $$('[data-wf-angle]').forEach(function (button) {
      button.onclick = function () { wfChoose({ action: 'select_angle', angle: button.dataset.wfAngle }, button); };
    });
    $$('[data-wf-brain]').forEach(function (button) {
      button.onclick = function () { wfChoose({ action: 'select_brain', brainId: button.dataset.wfBrain }, button); };
    });
    $$('[data-wf-style]').forEach(function (button) {
      button.onclick = function () { wfChoose({ action: 'select_brain', brainId: '', style: button.dataset.wfStyle }, button); };
    });
    $$('[data-wf-select]').forEach(function (button) {
      var optionId = button.dataset.wfSelect;
      var isIdea = state.workflow && state.workflow.stage === 'idea';
      button.onclick = function () {
        wfChoose(isIdea ? { action: 'select_idea', optionId: optionId } : { action: 'select_copy', optionId: optionId }, button);
      };
    });
    $$('[data-wf-copy-text]').forEach(function (button) {
      button.onclick = function () {
        var wfState = (state.workflow && state.workflow.state) || {};
        var options = wfState.copyOptions || [];
        var option = options.filter(function (item) { return item.id === button.dataset.wfCopyText; })[0];
        if (option && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(option.content || '').then(function () { toast('已复制', 'success'); });
        }
      };
    });
    $$('[data-wf-inspire]').forEach(function (button) {
      button.onclick = async function () {
        var options = (state.workflow && state.workflow.state.ideaOptions) || [];
        var option = options.filter(function (item) { return item.id === button.dataset.wfInspire; })[0];
        if (!option) return;
        try {
          var saved = await call('/memories', { method: 'POST', body: { kind: 'inspiration', content: (option.title || '') + '——' + (option.hook || ''), source: '今日选题', accountId: state.accountId } });
          state.memories.unshift((saved.data || saved).memory);
          toast('已存为灵感', 'success');
        } catch (error) { toast(error.message, 'error'); }
      };
    });
    bindWorkflowOptionEdit();
  }
  /** 双击选项卡直接改稿（对齐原版：改稿不调模型，直接成为终稿）。 */
  function bindWorkflowOptionEdit() {
    $$('.wb-flow-option[data-wf-option]').forEach(function (card) {
      card.ondblclick = function (event) {
        if (event.target.closest('button,textarea,input,a,select')) return;
        if (!state.workflow || !['ready', 'copy'].includes(state.workflow.stage)) return;
        var option = (state.workflow.state.copyOptions || []).filter(function (item) { return item.id === card.dataset.wfOption; })[0];
        if (!option) return;
        showDialog('修改文案', '<p class="wb-note">修改后点击「确定并使用」，这份修改稿会直接成为最终文案，不会重新调用模型。</p>' +
          '<textarea id="wb-edit-copy" class="wb-script" style="min-height:180px">' + esc(option.content || '') + '</textarea>' +
          '<div class="wb-actions"><button class="btn primary" type="button" id="wb-edit-use">确定并使用</button><button class="btn" type="button" id="wb-edit-cancel">退出编辑</button></div>');
        $('#wb-edit-use').onclick = function () {
          var edited = String(($('#wb-edit-copy') || {}).value || '').trim();
          if (!edited) { toast('修改后的文案不能为空', 'error'); return; }
          closeDialog();
          wfChoose({ action: 'select_copy', optionId: option.id, editedContent: edited }, null);
        };
        $('#wb-edit-cancel').onclick = closeDialog;
      };
    });
  }
  async function wfChoose(payload, button) {
    if (button) { button.disabled = true; }
    try {
      var result = await call('/workflows/' + encodeURIComponent(state.workflow.id) + '/action', { method: 'POST', body: payload });
      var data = result.data || result;
      if (data.workflow) state.workflow = data.workflow;
      if (data.draft) {
        state.copy.unshift(data.draft);
        toast('已选定，文案已存入「文案草稿」', 'success');
      }
      if (data.switchToManual) {
        state.workflow = null;
        renderMessages(true);
        openFlowStartDialog('hotspot');
        return;
      }
      renderMessages(true);
      ensureWfPolling();
    } catch (error) {
      toast(error.message, 'error');
      if (button) button.disabled = false;
    }
  }
  /** 来源选择（爆款复刻，对齐原版 4 来源 + 我们的转写档案入口）。 */
  function openViralSourceChooser() {
    if (state.workflow && state.workflow.status === 'active') { toast('先完成或放弃当前的创作流程', 'error'); return; }
    showDialog('爆款复刻', '<p class="wb-note">选择一种来源。视频类会先提取口播原文；现有文案直接进入原文确认。</p>' +
      '<div class="wb-viral-grid">' +
      '<button class="wb-choice" type="button" data-viral-source="peer"><b>◎ 同行爆款</b><small>从「同行观察」的同行账号里选一条作品。</small></button>' +
      '<button class="wb-choice" type="button" data-viral-source="link"><b>↗ 爆款链接</b><small>直接粘贴抖音分享文字或单条作品链接。</small></button>' +
      '<button class="wb-choice" type="button" data-viral-source="upload"><b>＋ 上传视频</b><small>从本地选择一个视频，提取口播后作为参考。</small></button>' +
      '<button class="wb-choice" type="button" data-viral-source="text"><b>¶ 现有文案</b><small>已经有原文时直接粘贴，跳过视频提取。</small></button>' +
      ((state.transcripts || []).filter(function (item) { return item.status === 'succeeded'; }).length
        ? '<button class="wb-choice" type="button" data-viral-source="transcript"><b>▤ 从转写档案</b><small>用已采集/已转写的带时间码档案（' + state.transcripts.filter(function (item) { return item.status === 'succeeded'; }).length + ' 条）。</small></button>'
        : '') +
      '</div>');
    $$('[data-viral-source]').forEach(function (button) {
      button.onclick = function () { openViralSourceInput(button.dataset.viralSource); };
    });
  }
  function openViralSourceInput(source) {
    if (source === 'peer') return openViralPeerList();
    if (source === 'transcript') return openViralTranscriptPicker();
    var titles = { link: '爆款链接', upload: '上传视频', text: '现有文案' };
    var form = '';
    if (source === 'link') {
      form = '<label class="wb-field full"><span>抖音分享内容 / 作品链接</span><textarea id="wb-viral-share" placeholder="例如：复制打开抖音，看看… https://v.douyin.com/xxxx/"></textarea></label>';
    } else if (source === 'upload') {
      form = '<label class="btn primary" for="wb-viral-file">选择一个视频</label>' +
        '<input id="wb-viral-file" type="file" hidden accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm">' +
        '<p class="wb-note" id="wb-viral-file-name" style="margin-top:8px">支持 MP4 / MOV / WebM；上传后会提取口播原文，先确认再改写。</p>';
    } else {
      form = '<label class="wb-field full"><span>爆款原文</span><textarea id="wb-viral-text" placeholder="把原文粘进来…"></textarea></label>';
    }
    showDialog(titles[source], '<div class="wb-form">' + form +
      '<div class="wb-actions"><button class="btn primary" type="button" id="wb-viral-go">' + ic('sparkle', 12) + (source === 'text' ? '使用这段文案' : '读取并提取文案') + '</button></div></div>');
    var fileInput = $('#wb-viral-file');
    if (fileInput) {
      fileInput.onchange = function () {
        var file = (fileInput.files || [])[0];
        if (file) $('#wb-viral-file-name').textContent = '已选择：' + file.name + '（' + fmtSize(file.size) + '）';
      };
    }
    $('#wb-viral-go').onclick = async function () {
      var button = this;
      button.disabled = true; button.innerHTML = ic('loader', 12) + '提交中…';
      try {
        if (source === 'text') {
          var value = String(($('#wb-viral-text') || {}).value || '').trim();
          if (!value) { toast('请先粘贴一段现有文案', 'error'); button.disabled = false; button.innerHTML = ic('sparkle', 12) + '使用这段文案'; return; }
          startViralWorkflow({ sourceType: 'text', sourceText: value }, '现有文案', 'transcript');
        } else if (source === 'link') {
          var share = String(($('#wb-viral-share') || {}).value || '').trim();
          if (!share) { toast('请先粘贴抖音分享内容', 'error'); button.disabled = false; button.innerHTML = ic('sparkle', 12) + '读取并提取文案'; return; }
          startViralWorkflow({ sourceType: 'link', shareText: share }, '抖音爆款链接', 'extracting');
        } else if (source === 'upload') {
          var file = (fileInput.files || [])[0];
          if (!file) { toast('请先选择一个本地视频', 'error'); button.disabled = false; button.innerHTML = ic('sparkle', 12) + '读取并提取文案'; return; }
          button.innerHTML = ic('loader', 12) + '上传中…';
          var form = new FormData();
          form.append('file', file);
          form.append('folder', '复刻参考');
          form.append('accountId', state.accountId);
          var uploaded = await call('/assets', { method: 'POST', body: form });
          state.assets.unshift(uploaded.asset);
          startViralWorkflow({ sourceType: 'upload', assetId: uploaded.asset.id }, file.name || '本地上传视频', 'extracting');
        }
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false; button.innerHTML = ic('sparkle', 12) + '读取并提取文案';
      }
    };
  }
  function openViralPeerList() {
    var peers = state.refs || [];
    showDialog('同行爆款', '<p class="wb-note">先选择同行，再进入该同行的作品列表（读公开主页）。</p>' +
      '<div class="wb-news-list">' + (peers.length ? peers.map(function (ref) {
        var douyinUser = String(ref.url || '').match(/douyin\.com\/user\/([A-Za-z0-9_-]{20,120})/);
        return '<article class="wb-news-card"><div class="wb-news-head"><b>' + esc(ref.name) + '</b></div>' +
          '<small>' + esc(ref.url || '没有链接；编辑这条同行，填上抖音主页链接后可用') + '</small>' +
          '<div class="wb-actions"><button class="btn primary" type="button" data-viral-peer-url="' + esc(ref.url || '') + '"' + (douyinUser ? '' : ' disabled') + '>查看作品</button></div></article>';
      }).join('') : '<p class="wb-muted">「同行观察」里还没有同行账号，请先添加（要带抖音主页链接）。</p>') + '</div>');
    $$('[data-viral-peer-url]').forEach(function (button) {
      button.onclick = async function () {
        var url = button.dataset.viralPeerUrl;
        var match = url.match(/douyin\.com\/user\/([A-Za-z0-9_-]{20,120})/);
        if (!match) return;
        button.disabled = true; button.innerHTML = ic('loader', 12) + '读取中…';
        try {
          var result = await call('/douyin/profile', { method: 'POST', body: { secUserId: match[1] } });
          var profile = (result.data || result).profile;
          openViralPeerWorks((state.refs.filter(function (item) { return item.url === url; })[0] || {}).name || '同行作品', profile);
        } catch (error) {
          toast(error.message, 'error');
          button.disabled = false; button.innerHTML = '查看作品';
        }
      };
    });
  }
  function openViralPeerWorks(peerName, profile) {
    var works = (profile && profile.works) || [];
    showDialog(peerName || '同行作品', '<p class="wb-note">选择一条作品作为本次爆款复刻来源；选择后自动下载并提取口播。</p>' +
      '<div class="wb-news-list">' + (works.length ? works.map(function (work) {
        return '<article class="wb-news-card"><div class="wb-news-head"><b>' + esc(work.desc || work.awemeId) + '</b></div>' +
          '<small>赞 ' + ((work.stats || {}).digg || 0) + ' · 评 ' + ((work.stats || {}).comment || 0) + ' · ' + fmtDuration((work.durationMs || 0) / 1000) + '</small>' +
          '<div class="wb-actions"><button class="btn primary" type="button" data-viral-work="' + esc(work.awemeId) + '">选择这条</button></div></article>';
      }).join('') : '<p class="wb-muted">这个同行当前没有可选择的视频作品。</p>') + '</div>');
    $$('[data-viral-work]').forEach(function (button) {
      button.onclick = async function () {
        button.disabled = true; button.innerHTML = ic('loader', 12) + '下载中…';
        try {
          var result = await call('/douyin/video', { method: 'POST', body: { awemeId: button.dataset.viralWork, accountId: state.accountId } });
          var data = result.data || result;
          closeDialog();
          toast('已下载并开始转写，完成后进入原文确认', 'success');
          startViralWorkflowFromExtracting(data.transcriptId, peerName || '同行爆款');
        } catch (error) {
          toast(error.message, 'error');
          button.disabled = false; button.innerHTML = '选择这条';
        }
      };
    });
  }
  function openViralTranscriptPicker() {
    var done = (state.transcripts || []).filter(function (item) { return item.status === 'succeeded'; });
    showDialog('从转写档案', '<p class="wb-note">用已采集/已转写的档案作为复刻原文。</p>' +
      '<div class="wb-news-list">' + (done.length ? done.slice(0, 12).map(function (item) {
        return '<article class="wb-news-card"><div class="wb-news-head"><b>' + esc(item.title || '档案') + '</b></div>' +
          '<small>' + esc(item.nickname || '') + ' · ' + fmtDuration(item.durationSeconds) + '</small>' +
          '<div class="wb-actions"><button class="btn primary" type="button" data-viral-ts="' + esc(item.id) + '">用这条档案</button></div></article>';
      }).join('') : '<p class="wb-muted">还没有已完成的转写档案。先去「同行观察」采集。</p>') + '</div>');
    $$('[data-viral-ts]').forEach(function (button) {
      button.onclick = function () {
        startViralWorkflow({ sourceType: 'transcript', transcriptId: button.dataset.viralTs }, '转写档案', null);
      };
    });
  }
  function startViralWorkflow(input, sourceLabel, optimisticStage) {
    if (state.workflow && state.workflow.status === 'active') { toast('先完成或放弃当前的创作流程', 'error'); return; }
    closeDialog();
    // 乐观卡片：立即出现在消息流里（对齐原版 optimistic session）
    state.workflow = {
      id: 'optimistic-' + Date.now(), status: 'active', kind: 'viral', kindLabel: '爆款复刻',
      accountId: state.accountId, stage: optimisticStage || 'transcript',
      input: input, state: Object.assign({ sourceLabel: sourceLabel, copyOptions: [] },
        input.sourceType === 'text' ? { transcript: input.sourceText } : { message: '正在建立爆款复刻任务并提取口播文案…' }),
      error: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    if (state.tab !== 'chat') setTab('chat'); else renderMessages(true);
    var box = $('#wb-msgs');
    if (box) box.scrollIntoView({ behavior: 'smooth', block: 'end' });
    call('/workflows', { method: 'POST', body: { kind: 'viral', accountId: state.accountId, input: input } }).then(function (result) {
      state.workflow = (result.data || result).workflow;
      renderMessages(true);
      ensureWfPolling();
    }).catch(function (error) {
      state.workflow = null;
      renderMessages(true);
      toast(error.message, 'error');
    });
  }
  /** 走「下载+转写」的来源（同行作品）：先建 optimistic extracting 卡，转写好自动进原文确认。 */
  async function startViralWorkflowFromExtracting(transcriptId, sourceLabel) {
    state.workflow = {
      id: 'optimistic-' + Date.now(), status: 'active', kind: 'viral', kindLabel: '爆款复刻',
      accountId: state.accountId, stage: 'extracting',
      input: { sourceType: 'transcript', transcriptId: transcriptId },
      state: { sourceLabel: sourceLabel, transcriptId: transcriptId, message: '正在提取这条作品的口播文案…', copyOptions: [] },
      error: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    if (state.tab !== 'chat') setTab('chat'); else renderMessages(true);
    try {
      // 转写档案可能还在跑：先轮询档案完成，再建工作流
      var deadline = Date.now() + 300000;
      var transcript = null;
      while (Date.now() < deadline) {
        var data = await call('/transcripts/' + encodeURIComponent(transcriptId));
        transcript = (data.data || data).transcript;
        if (transcript.status !== 'running') break;
        await new Promise(function (resolve) { setTimeout(resolve, 2500); });
      }
      if (!transcript || transcript.status !== 'succeeded') throw new Error(transcript && transcript.error ? transcript.error : '转写没有完成');
      var result = await call('/workflows', { method: 'POST', body: { kind: 'viral', accountId: state.accountId, input: { sourceType: 'transcript', transcriptId: transcriptId } } });
      state.workflow = (result.data || result).workflow;
      renderMessages(true);
      ensureWfPolling();
    } catch (error) {
      state.workflow = null;
      renderMessages(true);
      toast(error.message, 'error');
    }
  }
  function openFlowStartDialog(kind) {
    if (state.workflow && state.workflow.status === 'active') { toast('先完成或放弃当前的创作流程', 'error'); return; }
    if (kind === 'viral') return openViralSourceChooser();
    var titles = { today: '今日选题', hotspot: '热点结合' };
    var form = '';
    if (kind === 'today') {
      // 对齐原版 creativeBrainChoiceDialog：两按钮点击即开始
      showDialog('今天想从哪里开始？', '<p>可以先给一个大致方向，也可以让小铃铛根据账号资料推荐三个选题。' +
        (state.workflow && state.workflow.status === 'active' ? '</p>' : '</p><p class="wb-note">开始新创作后，原来的未完成创作仍可在列表中查看。</p>') +
        '<label class="wb-field full"><span>我有大致想法</span><input id="wb-flow-goal" placeholder="例如：想讲家长总觉得课贵"></label>' +
        '<div class="wb-actions"><button class="btn primary" type="button" id="wb-today-go">' + ic('bulb', 12) + '按这个想法推荐 3 个选题</button>' +
        '<button class="btn" type="button" id="wb-today-noidea">我没头绪，推荐 3 个选题</button></div>');
      var startTodayFlow = function () {
        var goal = String(($('#wb-flow-goal') || {}).value || '').trim();
        closeDialog();
        launchWorkflow('today', { goal: goal }, '今日选题', 'idea',
          { goal: goal, ideaOptions: [], message: '正在根据账号资料推荐选题…', copyOptions: [] });
      };
      $('#wb-today-go').onclick = startTodayFlow;
      $('#wb-today-noidea').onclick = startTodayFlow;
      return;
    }
    if (false) {
      form = '<div class="wb-choice-grid">' +
        '<button class="wb-choice recommended" type="button" id="wb-flow-hotspot-auto"><b>关键词联网搜索 · 推荐</b><small>输入一个方向，系统用 DeepSeek 搜索近 3 天新闻，挑出 3 条最值得结合的热点。</small></button>' +
        '<button class="wb-choice" type="button" id="wb-flow-hotspot-manual"><b>手动填写热点</b><small>把你刷到的新闻填进来，系统只引用你写的事实。</small></button></div>' +
        '<div id="wb-flow-hotspot-manual-form" hidden><p class="wb-note">把你今天刷到、想借的热点填进来（手机上看到的新闻即可）。系统只引用你写的事实，不编造细节。</p>' +
        '<label class="wb-field full"><span>热点标题</span><input id="wb-flow-title" placeholder="例如：多地推行寒假托管"></label>' +
        '<label class="wb-field full"><span>事实描述</span><textarea id="wb-flow-fact" placeholder="这条新闻说了什么（1-3 句）"></textarea></label>' +
        '<label class="wb-field full"><span>来源链接（可留空）</span><input id="wb-flow-url" placeholder="https://…"></label></div>' +
        '<div id="wb-flow-hotspot-key-form"><label class="wb-field full"><span>搜索关键词</span><input id="wb-flow-keyword" placeholder="例如：寒假托管 / 素质教育新政 / 校外培训监管"></label></div>';
    }
    showDialog(titles[kind], '<div class="wb-form">' + form +
      '<div class="wb-actions"><button class="btn primary" type="button" id="wb-flow-start">' + ic('sparkle', 12) + '开始</button></div></div>');
    var hotspotMode = { mode: 'keyword' };
    var autoCard = $('#wb-flow-hotspot-auto');
    var manualCard = $('#wb-flow-hotspot-manual');
    if (autoCard && manualCard) {
      var paintHotspotMode = function (mode) {
        hotspotMode.mode = mode;
        autoCard.classList.toggle('recommended', mode === 'keyword');
        manualCard.classList.toggle('recommended', mode === 'manual');
        $('#wb-flow-hotspot-key-form').hidden = mode !== 'keyword';
        $('#wb-flow-hotspot-manual-form').hidden = mode !== 'manual';
      };
      autoCard.onclick = function () { paintHotspotMode('keyword'); };
      manualCard.onclick = function () { paintHotspotMode('manual'); };
    }
    $('#wb-flow-start').onclick = async function () {
      var button = this;
      button.disabled = true; button.innerHTML = ic('loader', 12) + '生成中…';
      var input = {};
      if (kind === 'today') input.goal = ($('#wb-flow-goal') || {}).value || '';
      if (kind === 'hotspot') {
        if (hotspotMode.mode === 'keyword') {
          input.mode = 'keyword';
          input.keyword = ($('#wb-flow-keyword') || {}).value || '';
        } else {
          input.mode = 'manual';
          input.title = ($('#wb-flow-title') || {}).value || '';
          input.fact = ($('#wb-flow-fact') || {}).value || '';
          input.sourceUrl = ($('#wb-flow-url') || {}).value || '';
        }
      }
      launchWorkflow(kind, input, titles[kind], 'searching',
        { keyword: input.keyword || '', message: '正在联网搜索今天的热点…', copyOptions: [] });
    };
  }
  /** 统一乐观启动：立即出卡片 → POST → 换成服务端状态（对齐原版 optimistic session）。 */
  function launchWorkflow(kind, input, kindLabel, optimisticStage, optimisticState) {
    if (state.workflow && state.workflow.status === 'active') { toast('先完成或放弃当前的创作流程', 'error'); return; }
    state.workflow = {
      id: 'optimistic-' + Date.now(), status: 'active', kind: kind, kindLabel: kindLabel,
      accountId: state.accountId, stage: optimisticStage,
      input: input, state: Object.assign({ copyOptions: [] }, optimisticState),
      error: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    if (state.tab !== 'chat') setTab('chat'); else renderMessages(true);
    call('/workflows', { method: 'POST', body: { kind: kind, accountId: state.accountId, input: input } }).then(function (result) {
      state.workflow = (result.data || result).workflow;
      renderMessages(true);
      ensureWfPolling();
    }).catch(function (error) {
      state.workflow = null;
      renderMessages(true);
      toast(error.message, 'error');
    });
  }

  function openPeerReportDialog(peerName) {
    var done = (state.transcripts || []).filter(function (item) { return item.status === 'succeeded'; });
    showDialog('生成研究简报 · ' + peerName, '<p class="wb-note">勾选这个同行的口播档案（按昵称/标题找），系统总结它的内容结构、表达特点与值得学习的优点。</p>' +
      '<div class="wb-news-list" style="max-height:280px;overflow:auto">' + (done.length ? done.map(function (item) {
        return '<label class="wb-news-card" style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" data-peer-ts value="' + esc(item.id) + '">' +
          '<span style="flex:1"><b>' + esc(item.title || '档案') + '</b><br><small>' + esc(item.nickname || '') + ' · ' + fmtDuration(item.durationSeconds) + '</small></span></label>';
      }).join('') : '<p class="wb-muted">还没有已转写的档案。</p>') + '</div>' +
      '<div class="wb-actions"><button class="btn primary" type="button" id="wb-peer-report-go"' + (done.length ? '' : ' disabled') + '>开始生成</button></div>');
    $('#wb-peer-report-go').onclick = async function () {
      var ids = $$('[data-peer-ts]:checked').map(function (input) { return input.value; });
      if (!ids.length) { toast('请至少选 1 条档案', 'error'); return; }
      var button = this;
      button.disabled = true; button.innerHTML = ic('loader', 12) + '提交中…';
      try {
        await call('/brains', { method: 'POST', body: { kind: 'peer_report', name: peerName, transcriptIds: ids, accountId: state.accountId } });
        closeDialog();
        toast('研究简报生成中，一两分钟后在本页查看', 'success');
        refreshBrains(true);
        setTimeout(function () { void refreshBrains(true); }, 8000);
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false; button.innerHTML = '开始生成';
      }
    };
  }

  /* ───────────── 文案大脑页签（蒸馏档案） ───────────── */
  async function refreshBrains(silent) {
    try {
      var data = await call('/brains');
      state.brains = data.items || [];
    } catch (error) {
      if (!silent) toast(error.message, 'error');
      return;
    }
    if (state.tab === 'copybrains') renderBrains();
    if (state.brains.some(function (item) { return item.status === 'running'; }) && !state.brainPollTimer) {
      state.brainPollTimer = setInterval(async function () {
        if (!state.brains.some(function (item) { return item.status === 'running'; })) { clearInterval(state.brainPollTimer); state.brainPollTimer = null; return; }
        refreshBrains(true);
      }, 4000);
    }
  }
  function brainArchiveHtml(brain) {
    var profile = brain.profile || {};
    var parts = [];
    Object.keys(profile).forEach(function (key) {
      if (profile[key]) parts.push('<p><b>' + esc({ thinking_framework: '思考框架', topic_approach: '选题切入', positioning: '账号定位', cadence: '选题节奏', tone: '表达风格' }[key] || key) + '：</b>' + esc(profile[key]) + '</p>');
    });
    (brain.sections || []).forEach(function (section) {
      if (section && section.title) parts.push('<h4>' + esc(section.title) + '</h4><p>' + esc(section.content || '') + '</p>');
    });
    return parts.join('') || '<p class="wb-muted">档案还没有内容。</p>';
  }
  function renderBrains() {
    var brains = state.brains;
    var groups = [
      ['copy_brain', '写作大脑', '在创作流程的「写作大脑」一步选用；借它的结构、节奏和表达方法，不模仿原作者身份。'],
      ['peer_report', '同行研究简报', '总结同行的内容结构、表达特点与值得学习的优点；在同行观察页生成。'],
    ];
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>蒸馏新大脑</h3><p>从「同行观察」已转写的口播档案里，提炼创作者讲的方法和实际写法（带证据）。</p></div>' +
      '<button class="btn primary" type="button" id="wb-brain-new">' + ic('plus', 12) + '添加大脑</button></div>' +
      (brains.length ? '' : '<p class="wb-muted">还没有档案。先去「同行观察」采集几条同行的口播（自动转写），再来蒸馏。</p>') + '</div>' +
      groups.map(function (group) {
        var list = brains.filter(function (item) { return item.kind === group[0]; });
        return '<div class="wb-card"><div class="wb-card-head"><div><h3>' + group[1] + '</h3><p>' + group[2] + '</p></div></div>' +
          (list.length ? '<div class="wb-cards">' + list.map(function (brain) {
            var profile = brain.profile || {};
            var preview = profile.thinking_framework || profile.positioning || profile.tone || (brain.status === 'running' ? '正在蒸馏…' : brain.error || '');
            return '<article class="wb-item"><div class="wb-card-head"><div><h4>' + esc(brain.name) + '</h4><div class="wb-meta">' + (brain.status === 'ready' ? (brain.sections || []).length + ' 个板块 · ' : '') + fmtDate(brain.createdAt) + '</div></div>' +
              '<span class="wb-tag ' + (brain.status === 'ready' ? 'ok' : brain.status === 'failed' ? 'bad' : '') + '">' + esc(brain.status === 'ready' ? '可用' : brain.status === 'running' ? '蒸馏中' : '失败') + '</span></div>' +
              '<p class="wb-preview" style="-webkit-line-clamp:3">' + esc(String(preview).slice(0, 160)) + '</p>' +
              '<div class="wb-actions"><button class="btn" type="button" data-brain-view="' + esc(brain.id) + '">查看档案</button>' +
              '<button class="btn" type="button" data-brain-del="' + esc(brain.id) + '">' + ic('trash', 12) + '</button></div></article>';
          }).join('') + '</div>' : '<p class="wb-muted">还没有。</p>') + '</div>';
      }).join('') + '</div></div>';
    $('#wb-brain-new').onclick = openBrainCreateDialog;
    $$('[data-brain-view]').forEach(function (button) {
      button.onclick = async function () {
        try {
          var data = await call('/brains/' + encodeURIComponent(button.dataset.brainView));
          var brain = (data.data || data).brain;
          showDialog(brain.name + ' · 方法档案', brainArchiveHtml(brain));
        } catch (error) { toast(error.message, 'error'); }
      };
    });
    $$('[data-brain-del]').forEach(function (button) {
      button.onclick = async function () {
        if (!confirm('删除这份档案？')) return;
        try {
          await call('/brains/' + encodeURIComponent(button.dataset.brainDel), { method: 'DELETE' });
          state.brains = state.brains.filter(function (item) { return item.id !== button.dataset.brainDel; });
          renderBrains();
        } catch (error) { toast(error.message, 'error'); }
      };
    });
  }
  function openBrainCreateDialog() {
    var done = (state.transcripts || []).filter(function (item) { return item.status === 'succeeded'; });
    showDialog('添加写作大脑', '<p class="wb-note">选 2 条以上已转写的口播档案作为语料（先去「同行观察」采集）。系统会分开提炼「创作者明确讲授的方法」和「作品里反复出现的写作习惯」，并给出可直接借用的综合规则。</p>' +
      '<label class="wb-field full"><span>大脑名称</span><input id="wb-brain-name" placeholder="例如：某某校长的口播方法" maxlength="60"></label>' +
      '<div class="wb-news-list" style="max-height:280px;overflow:auto">' + (done.length ? done.map(function (item) {
        return '<label class="wb-news-card" style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" data-brain-ts value="' + esc(item.id) + '">' +
          '<span style="flex:1"><b>' + esc(item.title || '档案') + '</b><br><small>' + esc(item.nickname || '') + ' · ' + fmtDuration(item.durationSeconds) + '</small></span></label>';
      }).join('') : '<p class="wb-muted">还没有已转写的档案。先去「同行观察」采集。</p>') + '</div>' +
      '<div class="wb-actions"><button class="btn primary" type="button" id="wb-brain-go"' + (done.length ? '' : ' disabled') + '>开始蒸馏</button></div>');
    $('#wb-brain-go').onclick = async function () {
      var name = String(($('#wb-brain-name') || {}).value || '').trim();
      var ids = $$('[data-brain-ts]:checked').map(function (input) { return input.value; });
      if (!name) { toast('请填写大脑名称', 'error'); return; }
      if (ids.length < 1) { toast('请至少选 1 条档案', 'error'); return; }
      var button = this;
      button.disabled = true; button.innerHTML = ic('loader', 12) + '提交中…';
      try {
        await call('/brains', { method: 'POST', body: { kind: 'copy_brain', name: name, transcriptIds: ids, accountId: state.accountId } });
        closeDialog();
        toast('蒸馏已开始，通常一两分钟', 'success');
        refreshBrains(true);
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false; button.innerHTML = '开始蒸馏';
      }
    };
  }

  /* ───────────── 使用设置页签（只读状态） ───────────── */
  async function renderSettings() {
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll"><div class="wb-card"><div class="wb-card-head"><div><h3>渠道与依赖</h3><p>API Key 统一在' + esc('平台管理后台（AI 渠道设置）') + '配置；这里只看当前状态。</p></div></div><div id="wb-settings-body"><p class="wb-muted">读取中…</p></div></div>' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>工作台口径</h3></div></div>' +
      '<p class="wb-note">· 对话/文案/蒸馏走平台 TEXT 渠道；模型档位「深度」会换用渠道里的另一个模型，成本更高。<br>· 视频渲染/数字人走平台视频渠道，按次计费（成本观测记录在任务里）。<br>· 抖音采集只读公开数据，每机构每小时限 40 次；转写走渠道 ASR。</p></div></div></div>';
    try {
      var data = await call('/settings-status');
      var s = data.data || data;
      var row = function (label, ok, detail) {
        return '<tr><td>' + esc(label) + '</td><td><span class="wb-tag ' + (ok ? 'ok' : 'bad') + '">' + (ok ? '可用' : '未就绪') + '</span></td><td>' + esc(detail || '') + '</td></tr>';
      };
      $('#wb-settings-body').innerHTML = '<table class="wb-table"><thead><tr><th>能力</th><th>状态</th><th>说明</th></tr></thead><tbody>' +
        row('对话 / 文案（TEXT 渠道）', s.text && s.text.configured && s.text.mode !== 'mock', (s.text ? s.text.provider + ' · ' + s.text.model : '')) +
        row('视频渲染 / 数字人（VIDEO 渠道）', s.video && s.video.configured && s.video.mode !== 'mock', (s.video ? s.video.provider + ' · ' + s.video.model : '')) +
        row('口播转写（ASR）', s.asr, s.asr ? '走渠道 whisper' : '需要 seedance.nz 渠道') +
        row('抖音采集（F2 运行时）', s.douyinWorker, s.douyinWorker ? '隔离 Python 运行时就绪' : '服务器未安装 f2 运行时') +
        row('写作大脑', (s.brains || 0) > 0, '已蒸馏 ' + (s.brains || 0) + ' 个可用档案') +
        '</tbody></table>';
    } catch (error) {
      $('#wb-settings-body').innerHTML = '<p class="err">' + esc(error.message) + '</p>';
    }
  }

  function openMemoriesDialog() {
    var groups = [
      ['长期记忆', state.memories.filter(function (item) { return item.kind === 'memory'; })],
      ['灵感收藏', state.memories.filter(function (item) { return item.kind === 'inspiration'; })],
    ];
    showDialog('记忆与灵感', '<p class="wb-note">长期记忆会进入小铃铛的每次回答；灵感是存下来的选题。</p>' +
      '<div class="wb-mem-add"><input id="wb-mem-new" placeholder="手动记一条：例如「我们体验课转化率 40%，主打寒暑假」"><button class="btn" type="button" id="wb-mem-add-btn">记一条</button></div>' +
      groups.map(function (group) {
        return '<h4 style="margin:12px 0 6px">' + group[0] + '（' + group[1].length + '）</h4>' +
          (group[1].length ? group[1].map(function (item) {
            return '<div class="wb-mem-item"><p>' + esc(item.content) + '</p><small>' + esc(item.source || '') + ' · ' + fmtDate(item.createdAt) + '</small>' +
              '<button class="btn" type="button" data-mem-del="' + esc(item.id) + '">' + ic('trash', 11) + '</button></div>';
          }).join('') : '<p class="wb-muted">还没有。</p>');
      }).join(''));
    $('#wb-mem-add-btn').onclick = async function () {
      var value = String(($('#wb-mem-new') || {}).value || '').trim();
      if (!value) return;
      try {
        var result = await call('/memories', { method: 'POST', body: { kind: 'memory', content: value, source: '手动添加', accountId: state.accountId } });
        state.memories.unshift((result.data || result).memory);
        openMemoriesDialog();
        toast('已记下', 'success');
      } catch (error) { toast(error.message, 'error'); }
    };
    $$('[data-mem-del]').forEach(function (button) {
      button.onclick = async function () {
        try {
          await call('/memories/' + encodeURIComponent(button.dataset.memDel), { method: 'DELETE' });
          state.memories = state.memories.filter(function (item) { return item.id !== button.dataset.memDel; });
          openMemoriesDialog();
        } catch (error) { toast(error.message, 'error'); }
      };
    });
  }

  /* ───────────── 合规体检（复用 junshi 的规则引擎） ───────────── */  /* ───────────── 合规体检（复用 junshi 的规则引擎） ───────────── */
  async function checkCompliance(content) {
    if (!String(content || '').trim()) { toast('没有可检查的文本', 'error'); return; }
    toast('正在做合规体检…');
    try {
      var data = await requestJson('/api/junshi/compliance', { method: 'POST', body: { content: content } });
      var hits = (data.hits || []).map(function (hit) {
        return '<div class="wb-hit"><b>' + esc(hit.word) + '</b> <span style="color:var(--text-3)">' + esc(hit.category) + ' · ' + esc(hit.severity) + '</span><br>' +
          '<span style="color:var(--text-2)">改成：' + esc(hit.replace) + '</span></div>';
      }).join('');
      var risky = (data.risky || []).map(function (item) { return '<p>还需人工确认：' + esc(item) + '</p>'; }).join('');
      showDialog('合规体检', '<p><b>' + esc(data.verdict && data.verdict.text || '') + '</b>（词表命中 ' + (data.total || 0) + ' 处）</p>' +
        '<p class="wb-note">词表是确定性快检，可能把「第一步」「最卡」这类非极限语境误判；正式发布前建议再做一次 AI 语境审读。</p>' +
        (hits || '<p>词表没有命中。仍建议人工读一遍语境。</p>') + risky +
        '<div class="wb-actions"><button class="btn primary" type="button" id="wb-compliance-ai">去 AI 深度审读</button></div>');
      var aiButton = $('#wb-compliance-ai');
      if (aiButton) {
        aiButton.onclick = function () {
          closeDialog();
          var textarea = $('#cs-text');
          if (textarea) textarea.value = content;
          var nav = document.querySelector('.navitem[data-screen="compliance"]');
          if (nav) nav.click();
          setTimeout(function () { var run = $('#cs-run'); if (run) run.click(); }, 180);
        };
      }
    } catch (error) { toast(error.message, 'error'); }
  }

  /* ───────────── 渲染入口 ───────────── */
  function render() {
    if (!state.loaded) return;
    if (state.tab === 'chat') renderChat();
    else if (state.tab === 'account') renderAccount();
    else if (state.tab === 'references') renderReferences();
    else if (state.tab === 'copy') renderCopy();
    else if (state.tab === 'video') renderVideo();
    else if (state.tab === 'assets') renderAssets();
    else if (state.tab === 'copybrains') renderBrains();
    else if (state.tab === 'reports') renderReports();
    else if (state.tab === 'jobs') renderJobs();
    else if (state.tab === 'settings') renderSettings();
    else renderChat();
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    var toastEl = document.createElement('div');
    toastEl.id = 'wb-toast';
    toastEl.className = 'wb-toast';
    toastEl.hidden = true;
    $('#scr-workbench').appendChild(toastEl);
    $$('#wb-tabs [data-wb]').forEach(function (button) {
      button.addEventListener('click', function () { setTab(button.dataset.wb); });
    });
    var close = $('#wb-dialog-close');
    if (close) close.onclick = closeDialog;
    var dialog = $('#wb-dialog');
    if (dialog) dialog.addEventListener('click', function (event) { if (event.target === dialog) closeDialog(); });
    loadAll();
  }

  window.JunshiWorkbench = { mount: mount };
})();
