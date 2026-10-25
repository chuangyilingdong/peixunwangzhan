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
    // 七期 · 视频完整工作台（对齐原版 video_workspace / voice_library，作者本人授权复刻）
    videoWorks: [],
    workRenders: {},
    videoQueue: [],
    voiceSamples: [],
    videoWorkTimer: null,
    videoShotEditing: null,
    videoShotEdits: {},
    // 八期 · 内容计划/周期日历（对齐原版 content-cycles，作者本人授权复刻）
    cycles: [],
    currentCycle: null,
    cycleTimer: null,
    cycleSlotEditing: null,
    cycleForm: { count: 7, brief: '' },
    cycleRequirements: '',
    reviewInsight: null,
    // 十期 · 素材库（树形/分析队列/成片画廊）
    assetView: 'grid',
    assetAnalysisFilter: '',
    assetTimer: null,
    // 十一期 · 同行观察管线（同步队列/自动同步设置）
    peerSyncs: [],
    peerSyncSettings: { autoEnabled: false, intervalHours: 24 },
    // 十二期 · 抖音账号连接
    douyinConnection: { connected: false },
    douyinEnabled: true,
    douyinLoginSession: null,
    douyinPollTimer: null,
    douyinAssistant: { paired: false },
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
    if (tab !== 'video') { stopRenderPolling(); stopAvatarPolling(); stopVideoWorkPolling(); }
    if (tab !== 'chat') stopWfPolling();
    if (tab !== 'plan') stopCyclePolling();
    if (tab !== 'assets') stopAssetPolling();
    if (tab === 'plan') void loadCycles();
    if (tab !== 'references') { stopTsPolling(); stopPeerSyncPolling(); }
    if (tab === 'references') void loadPeerSyncs(true);
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
      if (state.tab === 'video') { state.selectedVideo = null; state.videoShotEditing = null; state.videoShotEdits = {}; void loadVideoData(true); }
      if (state.tab === 'plan') { state.cycleSlotEditing = null; void loadCycles(true); }
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
      void loadVideoData(true);
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
  /* ───────────── 十一期 · 同行观察管线（筛选下载队列 / 更新全部 / 自动同步） ───────────── */
  var peerSyncTimer = null;
  function stopPeerSyncPolling() {
    if (peerSyncTimer) { clearInterval(peerSyncTimer); peerSyncTimer = null; }
  }
  function startPeerSyncPolling() {
    var busy = (state.peerSyncs || []).some(function (row) { return row.status === 'queued' || row.status === 'running'; });
    if (!busy) { stopPeerSyncPolling(); return; }
    if (peerSyncTimer) return;
    peerSyncTimer = setInterval(function () {
      if (state.tab !== 'references') { stopPeerSyncPolling(); return; }
      void loadPeerSyncs(true);
    }, 3000);
  }
  async function loadPeerSyncs(silent) {
    var results = await Promise.all([
      call('/refs/syncs').catch(function () { return { items: [] }; }),
      call('/refs/sync-settings').catch(function () { return { settings: { autoEnabled: false, intervalHours: 24 } }; }),
    ]);
    state.peerSyncs = results[0].items || [];
    state.peerSyncSettings = results[1].settings || { autoEnabled: false, intervalHours: 24 };
    if (state.tab === 'references') renderReferences();
    startPeerSyncPolling();
  }
  function peerSyncFor(refId) {
    return (state.peerSyncs || []).filter(function (row) { return row.refId === refId; })[0] || null;
  }
  function peerSyncProgressHtml(sync) {
    if (!sync) return '';
    var busy = sync.status === 'queued' || sync.status === 'running';
    var total = Math.max(1, sync.selectedCount || 0);
    return '<div class="wb-peer-sync">' +
      '<div class="wb-v-shot-head"><b>' + esc(sync.stageLabel) + '</b><span>' + sync.doneCount + '/' + (sync.selectedCount || 0) + '</span></div>' +
      (busy ? '<progress max="' + total + '" value="' + Math.min(sync.doneCount, total) + '"></progress>' : '') +
      '<p class="wb-v-shot-line muted">' + esc(sync.message || (sync.status === 'failed' ? '同步失败' : '已完成')) + '</p>' +
      (sync.failedCount ? '<p class="wb-v-error">失败 ' + sync.failedCount + ' 条</p>' : '') +
      '</div>';
  }
  function peerFilterInputs(idPrefix, filter) {
    var f = filter || {};
    var fields = [
      ['targetCount', '目标条数', f.targetCount != null ? f.targetCount : 5, 1, 20],
      ['minLikes', '最低赞', f.minLikes || 0, 0, 10000000],
      ['minComments', '最低评', f.minComments || 0, 0, 1000000],
      ['minCollects', '最低藏', f.minCollects || 0, 0, 1000000],
      ['minShares', '最低转', f.minShares || 0, 0, 1000000],
    ];
    return '<div class="wb-peer-filter">' + fields.map(function (row) {
      return '<label><span>' + row[1] + '</span><input type="number" min="' + row[3] + '" max="' + row[4] +
        '" data-peer-filter="' + row[0] + '" data-prefix="' + esc(idPrefix) + '" value="' + esc(row[2]) + '"></label>';
    }).join('') + '</div>';
  }
  function peerFilterValues(idPrefix) {
    var out = {};
    $$('[data-peer-filter][data-prefix="' + idPrefix + '"]').forEach(function (input) {
      out[input.dataset.peerFilter] = Number(input.value) || 0;
    });
    return out;
  }

  /* ───────────── 十二期 · 抖音账号连接（扫码登录，登录态共用） ───────────── */
  async function loadDouyinConnection(silent) {
    var results = await Promise.all([
      call('/douyin/connect').catch(function () { return null; }),
      call('/douyin/assistant').catch(function () { return null; }),
    ]);
    if (results[0]) {
      state.douyinConnection = results[0].connection || { connected: false };
      state.douyinEnabled = results[0].enabled !== false;
    }
    if (results[1]) state.douyinAssistant = results[1];
    if (state.tab === 'references' || state.tab === 'settings') render();
  }
  function douyinConnectionBarHtml() {
    var assistant = state.douyinAssistant || { paired: false };
    if (assistant.paired) {
      return '<div class="wb-douyin-bar connected"><span class="wb-dy-dot"></span>' +
        '<div><b>采集助手已连接</b>' +
        '<small>在抖音网页打开任意同行主页 → 点浏览器上的采集助手图标 → 「采集当前主页」，作品会自动下载并转写（' +
        (assistant.assistants || []).length + ' 台设备已配对）。</small></div>' +
        '<div class="wb-actions"><button class="btn" type="button" data-douyin-action="repair">换一台电脑</button>' +
        '<button class="btn" type="button" data-douyin-action="unpair">断开</button></div></div>';
    }
    return '<div class="wb-douyin-bar"><span class="wb-dy-dot"></span>' +
      '<div><b>还没连接抖音</b>' +
      '<small>服务器读不到抖音作品列表（平台限制），改由你的浏览器来读：装一次「采集助手」，之后在抖音主页点一下图标就能同步。</small></div>' +
      '<div class="wb-actions"><button class="btn primary" type="button" data-douyin-action="pair">' + ic('link', 13) + '连接采集助手</button></div></div>';
  }
  function openAssistantPairDialog() {
    showDialog('连接采集助手', '<div id="wb-assistant-body"><p class="wb-muted">' + ic('loader', 13) + ' 正在生成配对码…</p></div>');
    void startAssistantPairing();
  }
  async function startAssistantPairing() {
    var body = $('#wb-assistant-body');
    try {
      var data = await call('/douyin/assistant/pairing', { method: 'POST', body: {} });
      var code = data.code;
      var expireAt = Date.parse(data.expiresAt) || (Date.now() + 600000);
      body.innerHTML =
        '<p class="wb-note">配对码 <b class="wb-pair-code">' + esc(code) + '</b>（10 分钟内有效，输进扩展里）</p>' +
        '<ol class="wb-assistant-steps">' +
        '<li><a class="btn" href="/assets/junshi/douyin-assistant.zip?v=20261025" download>下载采集助手（zip）</a>并解压到一个固定文件夹</li>' +
        '<li>Edge 打开 <code>edge://extensions</code>（Chrome 是 <code>chrome://extensions</code>）→ 打开「开发人员模式」→ 点「加载解压缩的扩展」→ 选刚解压的文件夹</li>' +
        '<li>点浏览器工具栏上的助手图标 → 输入上面的配对码 → 配对</li>' +
        '</ol>' +
        '<p class="wb-muted" id="wb-assistant-countdown">配对码 10 分钟内有效；过期了关掉重来即可。</p>' +
        '<div class="wb-actions"><button class="btn" type="button" data-douyin-action="pair-again">刷新配对码</button></div>';
      // 倒计时 + 自动检测配对成功
      var tick = setInterval(async function () {
        if (!$('#wb-assistant-body')) { clearInterval(tick); return; }
        var left = Math.max(0, Math.round((expireAt - Date.now()) / 1000));
        var el = $('#wb-assistant-countdown');
        if (el) el.textContent = left > 0 ? ('配对码剩余 ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0')) : '配对码已过期，点「刷新配对码」重新生成';
        var status = await call('/douyin/assistant').catch(function () { return null; });
        if (status && status.paired) {
          clearInterval(tick);
          state.douyinAssistant = status;
          closeDialog();
          toast('采集助手已连接，可以去抖音主页采集了', 'success');
          render();
        }
      }, 3000);
    } catch (error) {
      if (body) body.innerHTML = '<p class="wb-v-error">' + esc(error.message) + '</p>';
    }
  }
  function openDouyinConnectDialog() {
    bindDouyinActions();
    showDialog('连接抖音', '<div id="wb-dy-connect-body"><p class="wb-muted">' + ic('loader', 13) + ' 正在启动登录窗口并生成二维码（约 10-20 秒）…</p></div>');
    startDouyinConnectFlow();
  }
  async function startDouyinConnectFlow() {
    var body = $('#wb-dy-connect-body');
    try {
      var started = await call('/douyin/connect/start', { method: 'POST', body: {} });
      state.douyinLoginSession = started.sessionId;
      state.douyinPollTimer = setInterval(pollDouyinConnect, 2000);
      pollDouyinConnect();
    } catch (error) {
      if (body) body.innerHTML = '<p class="wb-v-error">' + esc(error.message) + '</p>' +
        '<div class="wb-actions"><button class="btn primary" type="button" data-douyin-action="connect">重试</button></div>';
    }
  }
  async function pollDouyinConnect() {
    bindDouyinActions();
    var body = $('#wb-dy-connect-body');
    if (!body) { stopDouyinConnectPolling(); return; }
    var result = await call('/douyin/connect/poll', { method: 'POST', body: { sessionId: state.douyinLoginSession || '' } }).catch(function (error) { return { status: 'error', error: error.message }; });
    if (result.status === 'waiting') {
      if (result.qr) {
        if (body.dataset.qrShown !== '1') {
          body.innerHTML = '<div class="wb-dy-qr-wrap"><img class="wb-dy-qr" alt="抖音登录二维码" src="data:image/png;base64,' + result.qr + '"></div>' +
            '<p class="wb-note" style="text-align:center">打开手机「抖音」→ 左上角 <b>☰</b> → 扫一扫</p>' +
            '<div class="wb-actions" style="justify-content:center"><button class="btn" type="button" data-douyin-action="restart">刷新二维码</button>' +
            '<button class="btn" type="button" data-douyin-action="cancel">取消</button></div>' +
            '<p class="wb-muted" style="text-align:center">' + ic('loader', 11) + ' 等待扫码…二维码 5 分钟内有效</p>';
          body.dataset.qrShown = '1';
        }
      }
      return;
    }
    if (result.status === 'connected') {
      stopDouyinConnectPolling();
      closeDialog();
      state.douyinConnection = result.connection || { connected: true };
      var name = (result.connection || {}).nickname || '';
      toast('抖音已连接' + (name ? '：' + name : '') + '，现在可以读取同行作品了', 'success');
      render();
      return;
    }
    if (result.status === 'expired' || result.status === 'error') {
      stopDouyinConnectPolling();
      var map = { qr_not_found: '没能生成二维码，请重试', login_timeout: '二维码已过期，请刷新', browser_missing: '服务器上没有可用浏览器，请联系平台管理员安装 Chromium', browser_launch_failed: '浏览器启动失败，请重试', xvfb_missing: '服务器缺少虚拟显示组件（xvfb），请联系平台管理员', worker_spawn_failed: '登录进程启动失败，请重试' };
      body.innerHTML = '<p class="wb-v-error">' + esc(map[result.error] || ('连接失败：' + (result.error || '未知原因'))) + '</p>' +
        '<div class="wb-actions"><button class="btn primary" type="button" data-douyin-action="connect">重新生成二维码</button></div>';
      return;
    }
  }
  function stopDouyinConnectPolling() {
    if (state.douyinPollTimer) { clearInterval(state.douyinPollTimer); state.douyinPollTimer = null; }
    state.douyinLoginSession = null;
  }
  function bindDouyinActions() {
    // 事件委托：弹窗内容是动态重建的（刷新二维码会替换 innerHTML），逐次绑定会丢。
    if (root.__douyinActionsBound) return;
    root.__douyinActionsBound = true;
    root.addEventListener('click', async function (event) {
      var button = event.target.closest && event.target.closest('[data-douyin-action]');
      if (!button) return;
      var action = button.dataset.douyinAction;
      if (action === 'pair' || action === 'repair' || action === 'pair-again') { openAssistantPairDialog(); return; }
      if (action === 'unpair') {
        if (!window.confirm('断开采集助手？断开后需要重新配对才能采集。')) return;
        button.disabled = true;
        try {
          await call('/douyin/assistant', { method: 'DELETE' });
          state.douyinAssistant = { paired: false };
          toast('已断开采集助手', 'success');
          render();
        } catch (error) { toast(error.message, 'error'); button.disabled = false; }
        return;
      }
      if (action === 'connect' || action === 'reconnect') { openDouyinConnectDialog(); return; }
      if (action === 'restart') { stopDouyinConnectPolling(); openDouyinConnectDialog(); return; }
      if (action === 'cancel') {
        stopDouyinConnectPolling();
        void call('/douyin/connect/cancel', { method: 'POST', body: {} }).catch(function () {});
        closeDialog();
        return;
      }
      if (action === 'disconnect') {
        if (!window.confirm('断开抖音连接？断开后 作品读取会退回到游客模式（可能读不全），直到重新扫码。')) return;
        button.disabled = true;
        try {
          await call('/douyin/connect', { method: 'DELETE' });
          state.douyinConnection = { connected: false };
          toast('已断开抖音连接', 'success');
          render();
        } catch (error) { toast(error.message, 'error'); button.disabled = false; }
      }
    });
  }


  function renderReferences() {
    var items = state.refs;
    var settings = state.peerSyncSettings || { autoEnabled: false, intervalHours: 24 };
    var syncableCount = items.filter(function (item) { return item.secUserId || /douyin\.com\/user\//.test(item.url || ''); }).length;
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      douyinConnectionBarHtml() +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>同行观察</h3><p>记录同行 → 按筛选条件同步作品（下载+转写带时间码）→ 生成研究简报。同步和转写按次计费；只读公开数据、每机构每小时限 40 次。</p></div>' +
      '<div class="wb-actions"><label class="wb-inline"><span>账号</span>' + accountSelectHtml('id="wb-dy-account"') + '</label>' +
      '<button class="btn primary" type="button" data-peer-action="sync-all"' + (syncableCount ? '' : ' disabled') + '>' + ic('refresh', 13) + '更新全部同行' + (syncableCount ? '（' + syncableCount + '）' : '') + '</button></div></div>' +
      '<div class="wb-peer-auto"><label class="wb-inline"><input type="checkbox" id="wb-peer-auto"' + (settings.autoEnabled ? ' checked' : '') + '><span>自动同步</span></label>' +
      '<label class="wb-inline"><span>间隔</span><select id="wb-peer-auto-interval">' + [6, 12, 24, 48, 72, 168].map(function (h) {
        return '<option value="' + h + '"' + (Number(settings.intervalHours) === h ? ' selected' : '') + '>' + (h >= 24 ? (h / 24) + ' 天' : h + ' 小时') + '</option>';
      }).join('') + '</select></label>' +
      '<span class="wb-note">' + (settings.autoEnabled ? '已开启：每 ' + (Number(settings.intervalHours) >= 24 ? (Number(settings.intervalHours) / 24) + ' 天' : Number(settings.intervalHours) + ' 小时') + ' 自动同步全部同行（' + (settings.nextRunAt ? '下次 ' + fmtDate(settings.nextRunAt) : '待排期') + '）。' : '默认关闭：每个周期会自动下载并转写新作品，按次计费。') + '</span></div>' +
      '<div class="wb-composer" style="padding:10px 2px 0"><textarea id="wb-dy-input" placeholder="粘贴同行的「分享→复制链接」内容或主页链接，例如：https://www.douyin.com/user/MS4wLj..."></textarea>' +
      '<button class="btn primary" type="button" id="wb-dy-go">' + ic('search', 13) + '解析</button></div>' +
      '<div id="wb-dy-result"></div></div>' +
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
        var sync = peerSyncFor(item.id);
        var homeReady = !!(item.secUserId || /douyin\.com\/user\//.test(item.url || ''));
        var nextStep = !homeReady ? '补上主页链接或主页 ID，才能按条件同步作品'
          : sync && (sync.status === 'queued' || sync.status === 'running') ? '正在同步：' + sync.stageLabel
          : count >= 2 ? '已采集 ' + count + ' 条口播，可以生成研究简报'
          : count ? '已采集 1 条，再同步或采集 1-2 条就可以生成研究简报'
          : '按筛选条件同步几条作品，或粘贴单条作品分享';
        var report = (state.brains || []).filter(function (brain) { return brain.kind === 'peer_report' && brain.name === item.name && brain.status === 'ready'; })[0];
        var busy = sync && (sync.status === 'queued' || sync.status === 'running');
        return '<article class="wb-item"><div class="wb-card-head"><h4>' + esc(item.name) + '</h4>' +
          '<div class="wb-actions">' + (item.lastSyncStatus ? '<span class="wb-tag' + (item.lastSyncStatus === 'failed' ? ' warn' : '') + '">' + esc(item.lastSyncStatus === 'failed' ? '上次同步失败' : '已同步') + '</span>' : '') +
          '<button class="btn" type="button" data-ref-del="' + esc(item.id) + '">' + ic('trash', 12) + '</button></div></div>' +
          (item.url ? '<p><a href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">' + esc(item.url) + '</a></p>' : '') +
          (!homeReady ? '<label class="wb-field"><span>主页 ID / 主页链接（同步需要）</span><input data-ref-home="' + esc(item.id) + '" placeholder="https://www.douyin.com/user/MS4wLj... 或 MS4wLj..." value=""></label>' : '') +
          '<p class="wb-preview" style="-webkit-line-clamp:4">' + esc(item.notes || '还没有观察笔记。') + '</p>' +
          '<div class="wb-meta">已采集口播 <b>' + count + '</b> 条' + (item.lastSyncAt ? ' · 上次同步 ' + fmtDate(item.lastSyncAt) : '') + ' · 下一步：' + esc(nextStep) + '</div>' +
          (item.lastSyncMessage ? '<p class="wb-v-shot-line muted">' + esc(item.lastSyncMessage) + '</p>' : '') +
          peerSyncProgressHtml(sync && (busy || sync.status === 'failed') ? sync : null) +
          '<details class="wb-peer-filter-box"><summary>筛选条件（目标条数 / 最低赞评藏转）</summary>' + peerFilterInputs(item.id, item.downloadFilter) + '</details>' +
          '<div class="wb-actions">' +
          '<button class="btn primary" type="button" data-peer-sync="' + esc(item.id) + '"' + (homeReady && !busy ? '' : ' disabled') + '>' + ic('refresh', 12) + (busy ? '同步中…' : '同步最新作品') + '</button>' +
          (homeReady ? '' : '<button class="btn" type="button" data-peer-save-home="' + esc(item.id) + '">保存主页</button>') +
          (report ? '<button class="btn primary" type="button" data-ref-report="' + esc(report.id) + '">查看研究简报</button>' : '<button class="btn" type="button" data-ref-report-new="' + esc(item.name) + '"' + (count ? '' : ' disabled') + '>生成研究简报</button>') +
          '</div></article>';
      }).join('') + '</div>' : '<div class="wb-card"><p class="wb-muted">还没有同行记录。</p></div>') +
      '</div></div>';
    bindAccountSwitch('#wb-dy-account');
    bindDouyinActions();
    if (!state.douyinLoaded) { state.douyinLoaded = true; void loadDouyinConnection(true); }
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
    // ── 十一期 · 同步最新作品 / 保存主页 / 更新全部 / 自动同步设置 ──
    $$('[data-peer-sync]').forEach(function (button) {
      button.onclick = async function () {
        // 不在这里拦「未连接」：真实浏览器以游客身份也能读公开主页作品（十二期实测 21 条）。
        // 只有真被抖音要求登录/验证时，服务端才回明确的连接引导。
        var refId = button.dataset.peerSync;
        var filter = peerFilterValues(refId);
        button.disabled = true; button.innerHTML = ic('loader', 12) + '排队中…';
        try {
          var result = await call('/refs/' + encodeURIComponent(refId) + '/sync', { method: 'POST', body: { filter: filter } });
          state.peerSyncs.unshift(result.sync);
          toast('已加入同步队列：读主页 → 按条件筛选 → 下载并转写', 'success');
          startPeerSyncPolling();
          void loadPeerSyncs(true);
        } catch (error) { toast(error.message, 'error'); button.disabled = false; button.innerHTML = ic('refresh', 12) + '同步最新作品'; }
      };
    });
    $$('[data-peer-save-home]').forEach(function (button) {
      button.onclick = async function () {
        var refId = button.dataset.peerSaveHome;
        var input = $('[data-ref-home="' + refId + '"]');
        var value = String((input || {}).value || '').trim();
        if (!value) { toast('先填主页链接或主页 ID', 'error'); return; }
        button.disabled = true;
        try {
          await call('/refs/' + encodeURIComponent(refId) + '/sync-settings', { method: 'PUT', body: { secUserId: value, filter: peerFilterValues(refId) } });
          toast('主页已保存，现在可以同步了', 'success');
          var refreshed = await call('/refs');
          state.refs = refreshed.items || state.refs;
          renderReferences();
        } catch (error) { toast(error.message, 'error'); button.disabled = false; }
      };
    });
    var syncAll = $('[data-peer-action="sync-all"]');
    if (syncAll) {
      syncAll.onclick = async function () {
        syncAll.disabled = true; syncAll.innerHTML = ic('loader', 12) + '排队中…';
        try {
          var result = await call('/refs/sync-all', { method: 'POST', body: {} });
          toast('已把 ' + result.queued + ' 个同行排进同步队列', 'success');
          startPeerSyncPolling();
          void loadPeerSyncs(true);
        } catch (error) { toast(error.message, 'error'); syncAll.disabled = false; syncAll.innerHTML = ic('refresh', 13) + '更新全部同行'; }
      };
    }
    var autoToggle = $('#wb-peer-auto');
    var saveAutoSettings = async function () {
      try {
        var result = await call('/refs/sync-settings', {
          method: 'PUT',
          body: { autoEnabled: !!autoToggle.checked, intervalHours: Number(($('#wb-peer-auto-interval') || {}).value || 24) },
        });
        state.peerSyncSettings = result.settings;
        renderReferences();
        toast(result.settings.autoEnabled ? '自动同步已开启：会按周期自动下载并转写新作品（按次计费）' : '自动同步已关闭', 'success');
      } catch (error) { toast(error.message, 'error'); }
    };
    if (autoToggle) autoToggle.onchange = saveAutoSettings;
    var autoInterval = $('#wb-peer-auto-interval');
    if (autoInterval) autoInterval.onchange = saveAutoSettings;
    startPeerSyncPolling();
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
        render();
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
  /* ───────────── 八期 · 内容计划/周期日历（对齐原版 content-cycles，作者本人授权复刻） ───────────── */
  var CYCLE_PURPOSES = ['涨粉', '互动', '种草', '转化', '建立信任'];
  var CYCLE_STATUS = { generating: '生成中', proposed: '待确认', confirmed: '已确认', failed: '生成失败' };
  var CYCLE_SLOT_STATUS = { planned: '待创作', in_progress: '创作中', done: '已创作', regenerating: '重新生成中' };
  var cycleSlotEdits = {};

  function stopCyclePolling() {
    if (state.cycleTimer) { clearInterval(state.cycleTimer); state.cycleTimer = null; }
  }
  function cycleBusy(cycle) {
    if (!cycle) return false;
    if (cycle.status === 'generating') return true;
    return (cycle.slots || []).some(function (slot) { return slot.status === 'regenerating'; });
  }
  function startCyclePolling() {
    var busy = state.cycles.some(cycleBusy);
    if (!busy) { stopCyclePolling(); return; }
    if (state.cycleTimer) return;
    state.cycleTimer = setInterval(function () {
      if (state.tab !== 'plan') { stopCyclePolling(); return; }
      void loadCycles(true);
    }, 3000);
  }
  async function loadCycles(silent) {
    var accountId = state.accountId;
    var data = await call('/cycles?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [], current: null }; });
    if (state.accountId !== accountId) return;
    state.cycles = data.items || [];
    state.currentCycle = data.current || null;
    if (state.tab === 'plan') renderPlan();
    startCyclePolling();
  }
  function activeCycle() {
    // 对齐原版规则：只有比当前已确认计划更新的 proposed 才顶到前台，否则展示当前已确认计划。
    var current = state.currentCycle;
    var currentCreated = Date.parse((current && current.createdAt) || 0) || 0;
    var proposed = state.cycles.filter(function (item) {
      if (item.status !== 'proposed') return false;
      if (!current) return true;
      return (Date.parse(item.createdAt || 0) || 0) > currentCreated;
    })[0] || null;
    return proposed || current;
  }
  function cycleDistributionChips(cycle) {
    var entries = Object.keys(cycle.distribution || {}).filter(function (key) { return cycle.distribution[key]; });
    if (!entries.length) return '';
    return '<div class="wb-chips">' + entries.map(function (key) {
      return '<span class="chip">' + esc(key) + ' ' + esc(cycle.distribution[key]) + ' 条</span>';
    }).join('') + '</div>';
  }
  function cycleSlotCard(cycle, slot) {
    var key = cycle.id + ':' + slot.id;
    var editing = state.cycleSlotEditing === key;
    if (editing) {
      var edits = cycleSlotEdits[key] || {};
      return '<article class="wb-card wb-cycle-slot editing">' +
        '<div class="wb-v-shot-head"><b>' + esc(slot.day) + ' · 编辑</b></div>' +
        '<label class="wb-field"><span>内容类型</span><input data-cycle-edit="contentType" data-key="' + esc(key) + '" value="' + esc(edits.contentType !== undefined ? edits.contentType : slot.contentType) + '"></label>' +
        '<label class="wb-field"><span>选题内容</span><textarea data-cycle-edit="topic" data-key="' + esc(key) + '">' + esc(edits.topic !== undefined ? edits.topic : slot.topic) + '</textarea></label>' +
        '<label class="wb-field"><span>选题目的</span><select data-cycle-edit="purpose" data-key="' + esc(key) + '">' +
        CYCLE_PURPOSES.map(function (value) { return '<option value="' + esc(value) + '"' + ((edits.purpose !== undefined ? edits.purpose : slot.purpose) === value ? ' selected' : '') + '>' + esc(value) + '</option>'; }).join('') + '</select></label>' +
        '<label class="wb-field"><span>推荐原因和依据</span><textarea data-cycle-edit="recommendationReason" data-key="' + esc(key) + '">' + esc(edits.recommendationReason !== undefined ? edits.recommendationReason : slot.recommendationReason) + '</textarea></label>' +
        '<div class="wb-actions"><button class="btn primary" type="button" data-cycle-action="save-slot" data-cycle="' + esc(cycle.id) + '" data-slot="' + esc(slot.id) + '">保存修改</button>' +
        '<button class="btn" type="button" data-cycle-action="cancel-slot">取消</button></div></article>';
    }
    var regenerating = slot.status === 'regenerating';
    return '<article class="wb-card wb-cycle-slot" data-cycle-slot="' + esc(key) + '">' +
      '<div class="wb-v-shot-head"><b>' + esc(slot.day) + ' · ' + esc(slot.contentType || '内容类型') + '</b><span>' + esc(CYCLE_SLOT_STATUS[slot.status] || slot.status) + '</span></div>' +
      '<p class="wb-cycle-topic">' + esc(slot.topic || '待生成选题') + '</p>' +
      '<p class="wb-v-shot-line muted">目的：' + esc(slot.purpose || '待确定') + '</p>' +
      '<p class="wb-v-shot-line"><b>推荐原因：</b>' + esc(slot.recommendationReason || '待补充') + '</p>' +
      (regenerating ? '<p class="wb-muted">' + ic('loader', 12) + ' 小铃铛正在重新生成这一条…</p>' : '') +
      '<div class="wb-actions">' +
      (cycle.status === 'confirmed' ? '<button class="btn primary" type="button" data-cycle-action="start-slot" data-cycle="' + esc(cycle.id) + '" data-slot="' + esc(slot.id) + '" data-version="' + cycle.version + '">从这一项开始创作</button>' : '') +
      '<button class="btn" type="button" data-cycle-action="regen-slot" data-cycle="' + esc(cycle.id) + '" data-slot="' + esc(slot.id) + '" data-version="' + cycle.version + '"' + (regenerating ? ' disabled' : '') + '>重新生成这一条</button>' +
      '<button class="btn" type="button" data-cycle-action="edit-slot" data-cycle="' + esc(cycle.id) + '" data-slot="' + esc(slot.id) + '">' + ic('pen', 11) + '编辑</button>' +
      '<button class="btn" type="button" data-cycle-action="remove-slot" data-cycle="' + esc(cycle.id) + '" data-slot="' + esc(slot.id) + '" data-version="' + cycle.version + '">移除</button>' +
      '</div></article>';
  }
  function renderPlan() {
    var active = activeCycle();
    var generating = state.cycles.filter(function (item) { return item.status === 'generating'; })[0] || null;
    var failed = state.cycles.filter(function (item) { return item.status === 'failed'; })[0] || null;
    var form = state.cycleForm || {};
    var head = '<div class="wb-card"><div class="wb-card-head"><div><h3>周期计划</h3><p>一次排好几天的选题节奏：每天发什么、讲什么、为什么这么排；确认后可以逐槽开始创作。</p></div>' +
      '<label class="wb-inline"><span>账号</span>' + accountSelectHtml('id="wb-plan-account"') + '</label></div>' +
      '<div class="wb-field full wb-actions">' +
      '<label class="wb-inline"><span>条数</span><select id="wb-plan-count">' + [4, 5, 6, 7, 10].map(function (n) { return '<option value="' + n + '"' + (Number(form.count) === n ? ' selected' : '') + '>' + n + ' 条</option>'; }).join('') + '</select></label>' +
      '<input id="wb-plan-brief" placeholder="方向要求（可选）：例如主打暑期班，穿插学员案例" value="' + esc(form.brief || '') + '" maxlength="120">' +
      '<button class="btn primary" type="button" data-cycle-action="generate"' + (generating ? ' disabled' : '') + '>' + ic('sparkle', 13) + (state.cycles.length ? '重新生成周期计划' : '生成周期计划') + '</button>' +
      '</div>' +
      (generating ? '<p class="wb-note">' + ic('loader', 12) + ' 正在排日期、内容类型和选题，通常十几秒到一分钟…</p>' : '') +
      (failed ? '<p class="wb-v-error">' + esc(failed.error || '这次周期计划没有生成完整，请重新生成。') + '</p>' : '') +
      '</div>';
    var current = state.currentCycle && active && state.currentCycle.id !== active.id
      ? '<div class="wb-card"><div class="wb-card-head"><div><h3>当前已确认计划</h3><p><b>' + esc(state.currentCycle.period) + '</b>　共 ' + (state.currentCycle.contentCount || state.currentCycle.slots.length) + ' 条（第 ' + state.currentCycle.version + ' 版）</p></div></div>' +
        '<p class="wb-v-message">' + esc(state.currentCycle.notice || '') + '</p></div>'
      : '';
    var activeHtml = '';
    if (active) {
      var slotCards = active.slots.map(function (slot) { return cycleSlotCard(active, slot); }).join('');
      var proposedBar = active.status === 'proposed'
        ? '<div class="wb-field full wb-actions">' +
          '<button class="btn primary" type="button" data-cycle-action="confirm" data-cycle="' + esc(active.id) + '" data-version="' + active.version + '">确认这份计划</button>' +
          '<button class="btn" type="button" data-cycle-action="export" data-cycle="' + esc(active.id) + '">' + ic('download', 12) + '导出文稿</button>' +
          '<button class="btn" type="button" data-cycle-action="delete-cycle" data-cycle="' + esc(active.id) + '">放弃这份</button></div>' +
          '<div class="wb-field full wb-actions"><input id="wb-cycle-requirements" placeholder="调整要求：例如把促销往后放、多排学员案例" value="' + esc(state.cycleRequirements || '') + '" maxlength="200">' +
          '<button class="btn" type="button" data-cycle-action="adjust" data-cycle="' + esc(active.id) + '" data-version="' + active.version + '">按要求调整</button></div>'
        : '<div class="wb-field full wb-actions">' +
          '<button class="btn" type="button" data-cycle-action="export" data-cycle="' + esc(active.id) + '">' + ic('download', 12) + '导出文稿</button>' +
          '<button class="btn" type="button" data-cycle-action="regenerate" data-cycle="' + esc(active.id) + '">重新生成周期计划</button></div>';
      activeHtml = '<div class="wb-card"><div class="wb-card-head"><div><h3>' + (active.status === 'confirmed' ? '本周期计划（已确认）' : '这份计划待确认') + '</h3>' +
        '<p>' + esc(active.period) + ' · 共 ' + (active.contentCount || active.slots.length) + ' 条 · 第 ' + active.version + ' 版</p></div>' +
        '<span class="wb-tag">' + esc(CYCLE_STATUS[active.status] || active.status) + '</span></div>' +
        cycleDistributionChips(active) +
        (active.notice ? '<p class="wb-v-message">' + esc(active.notice) + '</p>' : '') +
        (active.error ? '<p class="wb-v-error">' + esc(active.error) + '</p>' : '') +
        '<div class="wb-cycle-slots">' + slotCards + '</div>' + proposedBar + '</div>';
    } else if (!generating) {
      activeHtml = '<div class="wb-card"><p class="wb-muted">还没有周期计划。先确定条数和方向，生成第一份。</p></div>';
    }
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' + head + current + activeHtml + '</div></div>';
    bindAccountSwitch('#wb-plan-account');
    $$('[data-cycle-action]').forEach(function (button) {
      button.onclick = async function () {
        var action = button.dataset.cycleAction;
        var cycleId = button.dataset.cycle || '';
        var slotId = button.dataset.slot || '';
        var version = Number(button.dataset.version) || undefined;
        var original = button.innerHTML;
        if (action === 'generate' || action === 'regenerate' || action === 'adjust') {
          if (action === 'generate') {
            state.cycleForm = { count: Number(($('#wb-plan-count') || {}).value || 7), brief: ($('#wb-plan-brief') || {}).value || '' };
          } else {
            state.cycleRequirements = ($('#wb-cycle-requirements') || {}).value || '';
          }
          button.disabled = true; button.innerHTML = ic('loader', 12) + '提交中…';
          try {
            if (action === 'generate') {
              await call('/cycles', { method: 'POST', body: { count: state.cycleForm.count, brief: state.cycleForm.brief, accountId: state.accountId } });
            } else if (action === 'adjust') {
              await call('/cycles/' + encodeURIComponent(cycleId) + '/adjustments', { method: 'POST', body: { requirements: state.cycleRequirements, version: version } });
            } else {
              await call('/cycles/' + encodeURIComponent(cycleId) + '/regenerate', { method: 'POST', body: {} });
            }
            toast('周期计划生成中，这一页会自动刷新', 'success');
            startCyclePolling();
            void loadCycles(true);
          } catch (error) { toast(error.message, 'error'); button.disabled = false; button.innerHTML = original; }
          return;
        }
        if (action === 'confirm') {
          button.disabled = true;
          try {
            await call('/cycles/' + encodeURIComponent(cycleId) + '/confirm', { method: 'POST', body: { version: version } });
            toast('计划已确认，可以逐槽开始创作了', 'success');
          } catch (error) { toast(error.message, 'error'); button.disabled = false; }
          void loadCycles(true);
          return;
        }
        if (action === 'delete-cycle') {
          if (!window.confirm('放弃这份待确认的计划？')) return;
          button.disabled = true;
          try { await call('/cycles/' + encodeURIComponent(cycleId), { method: 'DELETE' }); } catch (error) { toast(error.message, 'error'); button.disabled = false; }
          void loadCycles(true);
          return;
        }
        if (action === 'export') {
          button.disabled = true;
          try {
            var blob = await fetchBlob(API + '/cycles/' + encodeURIComponent(cycleId) + '/export');
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = '周期计划-' + cycleId.slice(0, 12) + '.md';
            link.click();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          } catch (error) { toast(error.message, 'error'); }
          button.disabled = false;
          return;
        }
        if (action === 'edit-slot') {
          state.cycleSlotEditing = cycleId + ':' + slotId;
          renderPlan();
          return;
        }
        if (action === 'cancel-slot') {
          state.cycleSlotEditing = null;
          delete cycleSlotEdits[cycleId + ':' + slotId];
          renderPlan();
          return;
        }
        if (action === 'save-slot') {
          var key = cycleId + ':' + slotId;
          var edits = cycleSlotEdits[key] || {};
          var card = button.closest('.wb-cycle-slot');
          var collected = {
            contentType: (card.querySelector('[data-cycle-edit="contentType"]') || {}).value,
            topic: (card.querySelector('[data-cycle-edit="topic"]') || {}).value,
            purpose: (card.querySelector('[data-cycle-edit="purpose"]') || {}).value,
            recommendationReason: (card.querySelector('[data-cycle-edit="recommendationReason"]') || {}).value,
          };
          button.disabled = true; button.innerHTML = ic('loader', 12) + '保存中…';
          try {
            await call('/cycles/' + encodeURIComponent(cycleId) + '/slots/' + encodeURIComponent(slotId), { method: 'PUT', body: { slot: collected, version: version } });
            state.cycleSlotEditing = null;
            delete cycleSlotEdits[key];
            toast('这一槽已保存', 'success');
          } catch (error) { toast(error.message, 'error'); button.disabled = false; button.innerHTML = original; }
          void loadCycles(true);
          return;
        }
        if (action === 'regen-slot') {
          button.disabled = true; button.innerHTML = ic('loader', 12) + '提交中…';
          try {
            await call('/cycles/' + encodeURIComponent(cycleId) + '/slots/' + encodeURIComponent(slotId) + '/regenerate', { method: 'POST', body: { version: version } });
            toast('正在重新生成这一条…', 'success');
            startCyclePolling();
          } catch (error) { toast(error.message, 'error'); button.disabled = false; button.innerHTML = original; }
          void loadCycles(true);
          return;
        }
        if (action === 'remove-slot') {
          if (!window.confirm('移除这一天的选题？条数会减一。')) return;
          button.disabled = true;
          try {
            await call('/cycles/' + encodeURIComponent(cycleId) + '/slots/' + encodeURIComponent(slotId), { method: 'DELETE', body: { version: version } });
          } catch (error) { toast(error.message, 'error'); button.disabled = false; }
          void loadCycles(true);
          return;
        }
        if (action === 'start-slot') {
          button.disabled = true; button.innerHTML = ic('loader', 12) + '准备中…';
          try {
            var result = await call('/cycles/' + encodeURIComponent(cycleId) + '/slots/' + encodeURIComponent(slotId) + '/start', { method: 'POST', body: { version: version } });
            toast('已从这条选题创建视频任务，编导稿生成中', 'success');
            setTab('video');
            void loadVideoData(true);
          } catch (error) { toast(error.message, 'error'); button.disabled = false; button.innerHTML = original; }
          return;
        }
      };
    });
    $$('[data-cycle-edit]').forEach(function (control) {
      control.addEventListener('input', function () {
        var key = control.dataset.key;
        cycleSlotEdits[key] = cycleSlotEdits[key] || {};
        cycleSlotEdits[key][control.dataset.cycleEdit] = control.value;
      });
    });
    $$('[data-cycle-slot]').forEach(function (card) {
      card.ondblclick = function () {
        var key = card.dataset.cycleSlot;
        if (state.cycleSlotEditing === key) return;
        state.cycleSlotEditing = key;
        renderPlan();
      };
    });
  }

  /* ───────────── 七期 · 视频完整工作台（对齐原版 video_workspace / voice_library，作者本人授权复刻） ───────────── */
  var WB_VIDEO_TYPES = {
    ecommerce: { label: '电商带货', subtypes: [['口播带货', '真人推荐，建立购买信任'], ['促销转化', '突出优惠，推动立即下单'], ['场景种草', '植入场景，激发使用需求'], ['痛点解决', '直击痛点，展示解决效果'], ['功能演示', '演示功能，证明产品价值']] },
    local_store: { label: '同城到店', subtypes: [['门店发现', '突出特色，制造到店理由'], ['到店实录', '真实体验，建立消费信任'], ['招牌体验', '聚焦招牌，证明门店价值'], ['同城团购', '突出优惠，推动到店核销']] },
    brand: { label: '品牌广告', subtypes: [['品牌主张', '传递理念，建立价值认同'], ['品牌故事', '讲述故事，强化品牌信任'], ['生活方式', '塑造场景，建立品牌向往'], ['创意概念', '创意表达，强化品牌记忆']] },
    drama: { label: '剧情短片', subtypes: [['对话短剧', '人物冲突，推动剧情发展'], ['反转短剧', '剧情反转，制造传播记忆'], ['悬念短剧', '设置悬念，持续吸引观看'], ['情绪短片', '情绪共鸣，强化内容感染'], ['产品植入', '融入剧情，自然传递价值']] },
  };
  var WB_VIDEO_HOOKS = [['auto', '由素材推荐开场'], ['pain_point', '直击产品核心痛点'], ['novel_scene', '利用新奇场景开场'], ['emotional_reversal', '制造强烈情绪反转'], ['contrarian', '用反常识观点开场'], ['real_need', '真实痛点引出需求'], ['strong_contrast', '强烈对比突出差异']];
  var WB_VIDEO_MODES = { generate: '生成', replicate: '复刻', auto: '自动' };
  var WB_WORK_STATUS = { planning: '写编导稿中', draft: '待确认', rendering: '渲染中', succeeded: '已完成', failed: '失败' };
  var WB_SHOT_ROLES = { hook: '钩子', pain: '痛点', proof: '证明', turn: '转折', cta: '行动' };
  var WB_REF_ROLES = ['人物', '场景', '道具', '音色'];
  // 生产视频渠道（MiniMax-H3 外部适配器）实测：分辨率只认 480P/768P（720p 会被拒），单次成片上限 30 秒。
  var WB_DURATIONS = [5, 10, 15, 20, 25, 30];
  var WB_RESOLUTIONS = ['480P', '768P'];
  var WB_RATIOS = ['9:16', '16:9', '1:1'];

  function wbWorkStatusText(value) { return WB_WORK_STATUS[value] || value || '—'; }
  function wbTypeMeta(type) { return WB_VIDEO_TYPES[type] || WB_VIDEO_TYPES.ecommerce; }
  function wbSubtypeName(type, subtype) {
    var found = (wbTypeMeta(type).subtypes || []).filter(function (row) { return row[0] === subtype; })[0];
    return found ? found[0] : (subtype || '');
  }
  function wbHookLabel(value) {
    var found = WB_VIDEO_HOOKS.filter(function (row) { return row[0] === value; })[0];
    return found ? found[1] : '由素材推荐开场';
  }
  function wbShotRoleLabel(value) { return WB_SHOT_ROLES[value] || value || '分镜'; }

  function videoDraftKey() { return 'wb-video-drafts:' + state.accountId; }
  function loadVideoDrafts() {
    try {
      var rows = JSON.parse(localStorage.getItem(videoDraftKey()) || '[]');
      state.videoDrafts = Array.isArray(rows) ? rows : [];
    } catch (e) { state.videoDrafts = []; }
  }
  function saveVideoDrafts() {
    try { localStorage.setItem(videoDraftKey(), JSON.stringify(state.videoDrafts.slice(-8))); } catch (e) { /* 隐私模式忽略 */ }
  }
  function newVideoDraft(mode) {
    var draft = {
      id: 'draft-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), mode: mode, status: 'configuring',
      type: 'ecommerce', subtype: '口播带货', hookStrategy: 'auto', model: '', durationSeconds: 15,
      resolution: '768P', ratio: '9:16', brief: '', assetRefs: [], reference: '', sourceKind: 'text',
      sourceId: '',
    };
    state.videoDrafts.push(draft);
    saveVideoDrafts();
    return draft;
  }
  function findVideoDraft(id) { return state.videoDrafts.filter(function (row) { return row.id === id; })[0] || null; }
  function updateVideoDraft(id, patch) {
    var draft = findVideoDraft(id);
    if (!draft) return;
    Object.keys(patch || {}).forEach(function (key) { draft[key] = patch[key]; });
    saveVideoDrafts();
  }
  function removeVideoDraft(id) {
    state.videoDrafts = state.videoDrafts.filter(function (row) { return row.id !== id; });
    saveVideoDrafts();
  }
  /** @引用显示序号：同角色按出现顺序编号（@人物1、@人物2…），与后端提示词口径一致。 */
  function wbRefSeq(refs, index) {
    var seq = 1;
    for (var i = 0; i < index; i++) if (refs[i] && refs[i].role === refs[index].role) seq += 1;
    return seq;
  }
  function wbRefChips(refs, removable, draftId) {
    if (!refs || !refs.length) return '';
    return '<div class="wb-v-refs">' + refs.map(function (ref, index) {
      return '<span class="chip">' + esc('@' + ref.role + wbRefSeq(refs, index) + ' ' + (ref.label || '素材')) +
        (removable ? '<button type="button" class="wb-chip-x" data-wb-v-unref="' + esc(draftId) + '" data-index="' + index + '" aria-label="移除引用">×</button>' : '') + '</span>';
    }).join('') + '</div>';
  }

  async function loadVideoData(silent) {
    var accountId = state.accountId;
    var results = await Promise.all([
      call('/video/works?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [] }; }),
      call('/video/renders').catch(function () { return { items: [] }; }),
      call('/voice-samples?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [] }; }),
    ]);
    if (state.accountId !== accountId) return;
    state.videoWorks = results[0].items || [];
    state.videoQueue = results[1].items || [];
    state.voiceSamples = results[2].items || [];
    var bucket = {};
    state.videoQueue.forEach(function (item) { if (item.workId) { (bucket[item.workId] = bucket[item.workId] || []).push(item); } });
    state.workRenders = bucket;
    if (state.tab === 'video' && !state.videoShotEditing) { renderVideo(); hydrateWorkVideos(); }
    startVideoWorkPolling();
  }
  async function loadVideoWorks() {
    var results = await Promise.all([
      call('/video/works?accountId=' + encodeURIComponent(state.accountId)).catch(function () { return { items: [] }; }),
      call('/video/renders').catch(function () { return { items: [] }; }),
    ]);
    state.videoWorks = results[0].items || [];
    state.videoQueue = results[1].items || [];
    var bucket = {};
    state.videoQueue.forEach(function (item) { if (item.workId) { (bucket[item.workId] = bucket[item.workId] || []).push(item); } });
    state.workRenders = bucket;
    if (state.tab === 'video' && !state.videoShotEditing) { renderVideo(); hydrateWorkVideos(); }
    startVideoWorkPolling();
  }
  function startVideoWorkPolling() {
    var busy = state.videoWorks.some(function (item) { return item.status === 'planning' || item.status === 'rendering'; });
    if (!busy) { stopVideoWorkPolling(); return; }
    if (state.videoWorkTimer) return;
    state.videoWorkTimer = setInterval(function () {
      if (state.tab !== 'video') { stopVideoWorkPolling(); return; }
      void loadVideoWorks();
    }, 3000);
  }
  function stopVideoWorkPolling() {
    if (state.videoWorkTimer) { clearInterval(state.videoWorkTimer); state.videoWorkTimer = null; }
  }
  async function hydrateWorkVideos() {
    var videos = $$('[data-work-video]');
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      if (video.dataset.loaded) continue;
      video.dataset.loaded = '1';
      try {
        var blob = await fetchBlob(API + '/assets/' + encodeURIComponent(video.dataset.workVideo) + '/file');
        video.src = URL.createObjectURL(blob);
      } catch (e) { /* 视频加载失败保留外壳 */ }
    }
  }

  /* ── 配置卡（生成 / 复刻） ── */
  function wbTypeTabs(draft) {
    return Object.keys(WB_VIDEO_TYPES).map(function (value) {
      return '<button type="button" class="chip' + (draft.type === value ? ' on' : '') + '" data-wb-v-choice="type" data-draft="' + esc(draft.id) + '" data-value="' + esc(value) + '">' + esc(WB_VIDEO_TYPES[value].label) + '</button>';
    }).join('');
  }
  function wbSubtypeChips(draft) {
    return (wbTypeMeta(draft.type).subtypes || []).map(function (row) {
      return '<button type="button" class="chip' + (draft.subtype === row[0] ? ' on' : '') + '" data-wb-v-choice="subtype" data-draft="' + esc(draft.id) + '" data-value="' + esc(row[0]) + '" title="' + esc(row[1]) + '">' + esc(row[0]) + '</button>';
    }).join('');
  }
  function wbHookChips(draft) {
    return WB_VIDEO_HOOKS.map(function (row) {
      return '<button type="button" class="chip' + (draft.hookStrategy === row[0] ? ' on' : '') + '" data-wb-v-choice="hookStrategy" data-draft="' + esc(draft.id) + '" data-value="' + esc(row[0]) + '" title="' + esc(row[1]) + '">' + esc(row[1]) + '</button>';
    }).join('');
  }
  function wbParamRow(draft, withDuration) {
    return '<div class="wb-v-params">' +
      '<label><span>时长</span><select data-wb-v-field="durationSeconds" data-draft="' + esc(draft.id) + '"' + (withDuration ? '' : ' disabled') + '>' +
      WB_DURATIONS.map(function (n) { return '<option value="' + n + '"' + (Number(draft.durationSeconds) === n ? ' selected' : '') + '>' + n + ' 秒</option>'; }).join('') + '</select></label>' +
      '<label><span>分辨率</span><select data-wb-v-field="resolution" data-draft="' + esc(draft.id) + '">' +
      WB_RESOLUTIONS.map(function (r) { return '<option value="' + r + '"' + (draft.resolution === r ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select></label>' +
      '<label><span>画幅</span><select data-wb-v-field="ratio" data-draft="' + esc(draft.id) + '">' +
      WB_RATIOS.map(function (r) { return '<option value="' + r + '"' + (draft.ratio === r ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select></label>' +
      '</div>';
  }
  function renderVideoDraftCard(draft) {
    var head = '<div class="wb-card-head"><div><h3>' + esc(WB_VIDEO_MODES[draft.mode] || '生成') + '模式 · 新任务</h3><p>内容方向、开场方式和参数一次选完；素材和音色从下方添加。</p></div>' +
      '<button class="btn" type="button" data-wb-v-draft="discard" data-id="' + esc(draft.id) + '">取消</button></div>';
    var types = '<div class="wb-field full"><span>内容方向</span><div class="wb-chips">' + wbTypeTabs(draft) + '</div></div>' +
      '<div class="wb-field full"><span>细分方向</span><div class="wb-chips">' + wbSubtypeChips(draft) + '</div></div>' +
      '<div class="wb-field full"><span>开场方式（只控制前段切入）</span><div class="wb-chips">' + wbHookChips(draft) + '</div></div>';
    var body = '';
    if (draft.mode === 'generate') {
      body = head + types +
        '<label class="wb-field full"><span>想做什么（卖点、人物、台词、画面要求）</span><textarea data-wb-v-field="brief" data-draft="' + esc(draft.id) + '" placeholder="例如：主打美术体验课，妈妈带孩子出镜，结尾引导评论区领体验名额">' + esc(draft.brief || '') + '</textarea></label>';
    } else if (draft.mode === 'replicate') {
      var transcriptOptions = state.transcripts.map(function (item) {
        return '<option value="' + esc(item.id) + '"' + (draft.sourceId === item.id ? ' selected' : '') + '>' + esc(item.title || item.nickname || '转写档案') + '（' + esc(fmtDate(item.createdAt)) + '）</option>';
      }).join('');
      var sourceBody = draft.sourceKind === 'transcript'
        ? '<select data-wb-v-field="sourceId" data-draft="' + esc(draft.id) + '">' + (transcriptOptions || '<option value="">（还没有转写档案，先去「素材」采集或上传）</option>') + '</select>'
        : '<textarea data-wb-v-field="reference" data-draft="' + esc(draft.id) + '" placeholder="粘贴抖音分享内容/作品链接，或参考视频的口播文字与结构说明">' + esc(draft.reference || '') + '</textarea>';
      body = head + types +
        '<div class="wb-field full"><span>参考来源</span><div class="wb-chips">' +
        '<button type="button" class="chip' + (draft.sourceKind === 'transcript' ? ' on' : '') + '" data-wb-v-choice="sourceKind" data-draft="' + esc(draft.id) + '" data-value="transcript">转写档案</button>' +
        '<button type="button" class="chip' + (draft.sourceKind === 'text' ? ' on' : '') + '" data-wb-v-choice="sourceKind" data-draft="' + esc(draft.id) + '" data-value="text">链接 / 文字</button></div></div>' +
        '<label class="wb-field full"><span>' + (draft.sourceKind === 'transcript' ? '选择已转写的参考视频' : '参考内容') + '</span>' + sourceBody + '</label>' +
        '<label class="wb-field full"><span>补充要求（可选：要替换的产品、必须保留的内容）</span><textarea data-wb-v-field="brief" data-draft="' + esc(draft.id) + '" placeholder="把参考里的产品换成我们的体验课；开头钩子保持原样">' + esc(draft.brief || '') + '</textarea></label>';
    }
    return '<article class="wb-card wb-v-config" data-wb-v-draft-card="' + esc(draft.id) + '">' + body +
      '<div class="wb-field full"><span>参考素材（@人物/@场景/@道具）与音色</span>' + wbRefChips(draft.assetRefs, true, draft.id) +
      '<div class="wb-actions"><button class="btn" type="button" data-wb-v-action="pick-assets" data-id="' + esc(draft.id) + '">' + ic('image', 12) + '添加素材</button>' +
      '<button class="btn" type="button" data-wb-v-action="open-voices" data-id="' + esc(draft.id) + '">' + ic('music', 12) + '音色库</button></div></div>' +
      wbParamRow(draft, draft.mode !== 'replicate') +
      '<div class="wb-field full wb-actions">' +
      '<button class="btn primary" type="button" data-wb-v-action="start" data-id="' + esc(draft.id) + '">' + (draft.mode === 'replicate' ? '开始复刻' : '开始创作') + '</button>' +
      '<span class="wb-note">先出编导稿（可逐镜修改），确认后再提交视频渲染。</span></div></article>';
  }

  /* ── 任务行（编导稿分镜 + 渲染队列） ── */
  function wbRenderRow(item) {
    var status = { running: '生成中', succeeded: '完成', failed: '失败' }[item.status] || item.status;
    var chip = '<span class="wb-tag">' + esc(status) + '</span>';
    var video = item.assetId && item.status === 'succeeded'
      ? '<video class="wb-render-video" controls preload="metadata" data-work-video="' + esc(item.assetId) + '"></video>' : '';
    var error = item.status === 'failed' && item.error ? '<p class="wb-v-error">' + esc(item.error) + '</p>' : '';
    var retry = (item.status === 'failed')
      ? '<button class="btn" type="button" data-wb-v-retry="' + esc(item.id) + '">重试</button>' : '';
    var label = item.kind === 'shot' ? '第 ' + item.shotIndex + ' 镜' : (item.kind === 'main' ? '整片' : '单条');
    return '<div class="wb-v-render"><div class="wb-v-render-head"><b>' + esc(label) + ' · ' + esc(fmtDate(item.createdAt)) + '</b>' + chip + retry + '</div>' + video + error + '</div>';
  }
  function wbShotCard(work, shot, shotRender) {
    var key = work.id + ':' + shot.index;
    var editing = state.videoShotEditing && state.videoShotEditing === key;
    var edits = state.videoShotEdits[key] || {};
    var scene = editing ? (edits.scene !== undefined ? edits.scene : shot.scene) : shot.scene;
    var voiceover = editing ? (edits.voiceover !== undefined ? edits.voiceover : shot.voiceover) : shot.voiceover;
    var prompt = editing ? (edits.renderPrompt !== undefined ? edits.renderPrompt : shot.renderPrompt) : shot.renderPrompt;
    var overlay = editing ? (edits.overlay !== undefined ? edits.overlay : shot.overlay) : shot.overlay;
    var body = editing
      ? '<label class="wb-field"><span>画面</span><textarea data-wb-v-edit="scene" data-key="' + esc(key) + '">' + esc(scene || '') + '</textarea></label>' +
        '<label class="wb-field"><span>口播</span><textarea data-wb-v-edit="voiceover" data-key="' + esc(key) + '">' + esc(voiceover || '') + '</textarea></label>' +
        '<label class="wb-field"><span>画面提示词（给视频模型）</span><textarea data-wb-v-edit="renderPrompt" data-key="' + esc(key) + '">' + esc(prompt || '') + '</textarea></label>' +
        '<label class="wb-field"><span>字幕/花字（可空）</span><input data-wb-v-edit="overlay" data-key="' + esc(key) + '" value="' + esc(overlay || '') + '"></label>' +
        '<div class="wb-actions"><button class="btn primary" type="button" data-wb-v-shot="save-edit" data-id="' + esc(work.id) + '" data-index="' + shot.index + '">保存本镜</button>' +
        '<button class="btn" type="button" data-wb-v-shot="cancel-edit" data-id="' + esc(work.id) + '">取消</button></div>'
      : '<p class="wb-v-shot-line">' + esc(scene || '（无画面描述）') + '</p>' +
        (voiceover ? '<p class="wb-v-shot-line voice">「' + esc(voiceover) + '」</p>' : '') +
        (overlay ? '<p class="wb-v-shot-line muted">字幕：' + esc(overlay) + '</p>' : '') +
        (prompt ? '<details class="wb-v-shot-prompt"><summary>画面提示词</summary><p>' + esc(prompt) + '</p></details>' : '');
    var actions = editing ? '' : '<div class="wb-actions">' +
      '<button class="btn" type="button" data-wb-v-shot="edit" data-id="' + esc(work.id) + '" data-index="' + shot.index + '">' + ic('pen', 11) + '改这镜</button>' +
      '<button class="btn" type="button" data-wb-v-shot="render" data-id="' + esc(work.id) + '" data-index="' + shot.index + '">单镜试渲染</button></div>';
    var renderHtml = shotRender ? wbRenderRow(shotRender) : '';
    return '<article class="wb-v-shot' + (editing ? ' editing' : '') + '"><div class="wb-v-shot-head"><b>镜 ' + shot.index + ' · ' + esc(wbShotRoleLabel(shot.role)) + '</b><span>' + Number(shot.seconds) + ' 秒</span></div>' + body + actions + renderHtml + '</article>';
  }
  function renderVideoWorkCard(work) {
    var renders = state.workRenders[work.id] || [];
    var mainRender = renders.filter(function (item) { return item.kind === 'main'; })[0] || null;
    var busy = work.status === 'planning' || work.status === 'rendering';
    var script = work.directorScript;
    var head = '<div class="wb-card-head"><div><h3>' + esc(work.title || '未命名任务') + '</h3><p>' +
      '<span class="wb-tag">' + esc(WB_VIDEO_MODES[work.mode] || work.mode) + '</span> ' +
      esc(work.mode === 'replicate' ? '复刻' : (work.typeLabel + ' · ' + wbSubtypeName(work.type, work.subtype))) +
      ' · ' + esc(wbHookLabel(work.hookStrategy)) + ' · ' + work.durationSeconds + ' 秒 · ' + esc(work.ratio || '9:16') +
      (work.resolution ? ' · ' + esc(work.resolution) : '') + ' · ' + esc(accountName(work.accountId)) + '</p></div>' +
      '<div class="wb-v-headside"><span class="wb-tag' + (work.status === 'failed' ? ' warn' : '') + '">' + esc(wbWorkStatusText(work.status)) + '</span>' +
      '<button class="btn" type="button" data-wb-v-work="delete" data-id="' + esc(work.id) + '" title="删除任务">×</button></div></div>';
    var message = work.message ? '<p class="wb-v-message">' + esc(work.message) + '</p>' : '';
    var error = work.status === 'failed' && work.error ? '<p class="wb-v-error">' + esc(work.error) + '</p>' : '';
    var refs = wbRefChips(work.assetRefs, false, '');
    var scriptHtml = '';
    if (script && Array.isArray(script.shots) && script.shots.length) {
      var shotRendersByKey = {};
      renders.forEach(function (item) { if (item.kind === 'shot') shotRendersByKey[item.shotIndex] = shotRendersByKey[item.shotIndex] || item; });
      scriptHtml = '<div class="wb-v-script"><div class="wb-v-script-head"><b>编导稿' + (work.scriptEdited ? '（已人工修改）' : '') + '</b>' +
        '<span>' + (script.strategy ? esc(script.strategy) : '') + '</span></div>' +
        script.shots.map(function (shot) { return wbShotCard(work, shot, shotRendersByKey[shot.index]); }).join('') +
        (script.notes ? '<p class="wb-v-shot-line muted">' + esc(script.notes) + '</p>' : '') + '</div>';
    } else if (busy) {
      scriptHtml = '<p class="wb-muted">' + ic('loader', 12) + ' 编导稿生成中，通常十几秒到一分钟…</p>';
    }
    var rendersHtml = mainRender ? wbRenderRow(mainRender) : '';
    var output = work.status === 'succeeded' && work.outputUrl
      ? '<video class="wb-render-video" controls preload="metadata" data-work-video="' + esc(work.outputAssetId) + '"></video>' : '';
    var actions = '<div class="wb-field full wb-actions">';
    if (work.status === 'draft' || work.status === 'failed') {
      if (work.status === 'failed' && !script) actions += '<button class="btn primary" type="button" data-wb-v-work="regenerate" data-id="' + esc(work.id) + '">重新生成脚本</button>';
      else actions += '<button class="btn primary" type="button" data-wb-v-work="confirm" data-id="' + esc(work.id) + '">确认生成视频</button>' +
        '<button class="btn" type="button" data-wb-v-work="regenerate" data-id="' + esc(work.id) + '">换一版</button>';
    }
    if (script && !busy) actions += '<button class="btn" type="button" data-wb-v-work="save-script" data-id="' + esc(work.id) + '">保存编导稿修改</button>';
    actions += '</div>';
    return '<article class="wb-card wb-v-work' + (busy ? ' busy' : '') + '" data-wb-v-work-card="' + esc(work.id) + '">' + head + message + error + refs + scriptHtml + rendersHtml + output + actions + '</article>';
  }
  function renderVideoQueue() {
    var items = state.videoQueue.slice(0, 20);
    if (!items.length) return '<div class="wb-card"><div class="wb-card-head"><div><h3>渲染队列</h3><p>还没有渲染记录。确认编导稿后，这里会出现整片和单镜的渲染任务。</p></div></div></div>';
    return '<div class="wb-card"><div class="wb-card-head"><div><h3>渲染队列</h3><p>最近 20 条视频渲染任务；失败的可以重试，不需要重新写稿。</p></div></div>' +
      items.map(wbRenderRow).join('') + '</div>';
  }
  function renderLegacyVideoProjects() {
    if (!state.videos.length) return '';
    var selected = state.selectedVideo;
    var list = '<details class="wb-v-legacy"><summary>历史分镜脚本（一期，' + state.videos.length + ' 条）</summary><div class="wb-cards">' +
      state.videos.map(function (item) {
        return '<article class="wb-item click' + (selected && selected.id === item.id ? ' current' : '') + '" data-video-open="' + esc(item.id) + '">' +
          '<div class="wb-card-head"><h4>' + esc(item.title) + '</h4><span class="wb-tag">' + esc(item.mode) + '</span></div>' +
          '<div class="wb-meta">' + fmtDate(item.createdAt) + ' · ' + esc(videoStatusText(item.status)) + '</div>' +
          '<p class="wb-preview">' + esc(String(item.script || '').replace(/[#*|>`-]/g, ' ').replace(/\s+/g, ' ').slice(0, 100)) + '</p></article>';
      }).join('') + '</div>';
    if (selected) {
      list += '<div class="wb-card wb-detail"><div class="wb-card-head"><div><h3>' + esc(selected.title) + '</h3><p>' + esc(selected.mode) + ' · ' + fmtDate(selected.createdAt) + '</p></div>' +
        '<div class="wb-actions"><button class="btn" type="button" id="wb-close-video">收起</button></div></div>' +
        '<label class="wb-field"><span>口播/分镜脚本</span><textarea class="wb-script" id="wb-script-editor">' + esc(selected.script) + '</textarea></label>' +
        '<div class="wb-export"><button class="btn" type="button" data-export="md">导出 Markdown</button>' +
        '<button class="btn" type="button" data-export="srt">导出 SRT</button>' +
        '<button class="btn" type="button" data-export="json">导出 JSON</button>' +
        '<button class="btn primary" type="button" id="wb-save-video">保存修改</button></div>' +
        '<div class="wb-card"><div class="wb-card-head"><div><h3>单条直出视频（一期）</h3><p>把一段画面描述或口播直接交给视频渠道，几分钟后成片进素材库「AI 生成」。</p></div></div>' +
        '<form id="wb-render-form" class="wb-form">' +
        '<label class="wb-field full"><span>画面描述 / 口播</span><textarea name="prompt" required placeholder="复制脚本里某一段的画面与口播"></textarea></label>' +
        '<label class="wb-field"><span>时长</span><select name="durationSeconds">' + [5, 10, 15].map(function (n) { return '<option value="' + n + '">' + n + ' 秒</option>'; }).join('') + '</select></label>' +
        '<label class="wb-field"><span>画幅</span><select name="aspectRatio">' + ['9:16', '16:9', '1:1'].map(function (a) { return '<option value="' + a + '">' + a + '</option>'; }).join('') + '</select></label>' +
        '<div class="wb-field full wb-actions"><button class="btn primary" type="submit">提交生成</button></div></form>' +
        '<div id="wb-render-list" style="margin-top:10px"></div></div></div>';
    }
    return list + '</details>';
  }
  function bindLegacyVideoHandlers() {
    $$('[data-video-open]').forEach(function (card) {
      card.onclick = function () {
        var project = state.videos.filter(function (item) { return item.id === card.dataset.videoOpen; })[0];
        if (!project) return;
        state.selectedVideo = project;
        renderVideo();
      };
    });
    var close = $('#wb-close-video');
    if (close) close.onclick = function () { state.selectedVideo = null; stopRenderPolling(); renderVideo(); };
    var save = async function (button) {
      button.disabled = true;
      try {
        var editor = $('#wb-script-editor');
        var project = await call('/videos/' + encodeURIComponent(state.selectedVideo.id), { method: 'PUT', body: editor && editor.value ? { script: editor.value } : {} });
        state.selectedVideo = project.project;
        state.videos = state.videos.map(function (item) { return item.id === project.project.id ? project.project : item; });
        renderVideo();
        toast('脚本已保存', 'success');
      } catch (error) { toast(error.message, 'error'); button.disabled = false; }
    };
    if ($('#wb-save-video')) $('#wb-save-video').onclick = function () { save(this); };
    $$('[data-export]').forEach(function (button) {
      button.onclick = function () { downloadExport(state.selectedVideo.id, button.dataset.export, state.selectedVideo.title); };
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
          data.projectId = state.selectedVideo.id;
          data.accountId = state.accountId;
          await call('/video/render', { method: 'POST', body: data });
          toast('已提交视频生成，通常几分钟内完成', 'success');
          loadRenders(state.selectedVideo.id, true);
          renderForm.prompt.value = '';
        } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; button.innerHTML = original; }
      };
      renderRenderList();
      loadRenders(state.selectedVideo.id, true);
    }
  }

  /* ── 弹窗：素材 @引用 选择器 + 音色库 ── */
  function openVideoAssetPicker(draftId) {
    var assets = state.assets;
    var groups = [
      { kind: 'image', label: '图片（人物/场景/道具）', roles: ['人物', '场景', '道具'] },
      { kind: 'video', label: '视频（场景参考）', roles: ['场景'] },
      { kind: 'audio', label: '音频（音色参考）', roles: ['音色'] },
    ];
    var rows = groups.map(function (group) {
      var items = assets.filter(function (item) { return item.kind === group.kind; }).slice(0, 30);
      if (!items.length) return '';
      return '<div class="wb-field full"><span>' + esc(group.label) + '</span>' + items.map(function (item) {
        return '<div class="wb-v-pick-row"><b title="' + esc(item.fileName) + '">' + esc(item.fileName) + '</b>' +
          '<select data-wb-v-pick-role="' + esc(item.id) + '">' + group.roles.map(function (role) {
            return '<option value="' + esc(role) + '">' + esc(role) + '</option>';
          }).join('') + '</select>' +
          '<button class="btn" type="button" data-wb-v-pick-add="' + esc(item.id) + '" data-draft="' + esc(draftId) + '" data-file="' + esc(item.fileName) + '">添加</button></div>';
      }).join('') + '</div>';
    }).join('');
    showDialog('添加 @引用素材', '<p class="wb-note">素材会以「@人物1 @场景1」写进编导稿；编导稿会按素材内容安排画面。音频选「音色」后进音色参考。</p>' + (rows || '<p class="wb-muted">素材库还是空的，先去「素材」上传。</p>'));
    $$('[data-wb-v-pick-add]').forEach(function (button) {
      button.onclick = function () {
        var draft = findVideoDraft(button.dataset.draft);
        if (!draft) return;
        var roleSelect = $('[data-wb-v-pick-role="' + button.dataset.wbVPickAdd + '"]');
        var role = roleSelect ? roleSelect.value : '场景';
        if (draft.assetRefs.some(function (ref) { return ref.assetId === button.dataset.wbVPickAdd; })) { toast('这个素材已经加过了', 'error'); return; }
        draft.assetRefs.push({ assetId: button.dataset.wbVPickAdd, role: role, label: button.dataset.file || '', notes: '' });
        saveVideoDrafts();
        closeDialog();
        renderVideo();
        toast('已添加 @' + role + ' 引用', 'success');
      };
    });
  }
  async function openVoiceLibraryDialog(draftId) {
    var accountId = state.accountId;
    showDialog('音色库', '<div id="wb-voice-lib-body"><p class="wb-muted">' + ic('loader', 12) + ' 正在读取音色…</p></div>' +
      '<div class="wb-actions" style="margin-top:10px"><label class="btn primary" for="wb-voice-lib-file">' + ic('plus', 12) + '上传新音色（2–15 秒）</label>' +
      '<input id="wb-voice-lib-file" type="file" hidden accept=".mp3,.m4a,.wav,audio/*"></div>');
    var input = $('#wb-voice-lib-file');
    input.onchange = async function () {
      var file = (input.files || [])[0];
      if (!file) return;
      try {
        var form = new FormData();
        form.append('file', file);
        form.append('accountId', state.accountId);
        form.append('folder', '音色库');
        var uploaded = await call('/assets', { method: 'POST', body: form });
        var duration = await new Promise(function (resolve) {
          try {
            var url = URL.createObjectURL(file);
            var audio = new Audio(url);
            audio.addEventListener('loadedmetadata', function () { resolve(audio.duration); URL.revokeObjectURL(url); });
            audio.addEventListener('error', function () { resolve(0); URL.revokeObjectURL(url); });
            setTimeout(function () { resolve(audio.duration || 0); }, 3000);
          } catch (e) { resolve(0); }
        });
        var name = file.name.replace(/\.[^.]+$/, '');
        var result = await call('/voice-samples', { method: 'POST', body: { assetId: uploaded.asset.id, name: name, durationSeconds: duration || 0 } });
        state.voiceSamples.unshift(result.sample);
        renderVoiceLibRows(draftId);
        toast('音色已保存', 'success');
      } catch (error) { toast(error.message, 'error'); }
    };
    var refresh = await call('/voice-samples?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [] }; });
    if (accountId !== state.accountId) return;
    state.voiceSamples = refresh.items || state.voiceSamples;
    renderVoiceLibRows(draftId);
  }
  function renderVoiceLibRows(draftId) {
    var box = $('#wb-voice-lib-body');
    if (!box) return;
    if (!state.voiceSamples.length) { box.innerHTML = '<p class="wb-muted">还没有保存的音色，上传一段 2–15 秒的人声就能反复使用。</p>'; return; }
    box.innerHTML = state.voiceSamples.map(function (sample) {
      return '<div class="wb-v-voice-row"><button class="btn" type="button" data-wb-voice-play="' + esc(sample.assetId) + '" aria-label="试听">' + ic('play', 12) + '</button>' +
        '<div class="wb-v-voice-copy"><b>' + esc(sample.name) + '</b><small>' + (sample.durationSeconds ? Number(sample.durationSeconds).toFixed(1) + ' 秒' : '时长未知') + ' · 用过 ' + sample.useCount + ' 次' + (sample.missing ? ' · 原文件缺失' : '') + '</small></div>' +
        '<button class="btn primary" type="button" data-wb-voice-use="' + esc(sample.id) + '" data-draft="' + esc(draftId || '') + '">使用</button>' +
        '<button class="btn" type="button" data-wb-voice-rename="' + esc(sample.id) + '">改名</button>' +
        '<button class="btn" type="button" data-wb-voice-del="' + esc(sample.id) + '">删除</button>' +
        '<audio preload="none" hidden data-wb-voice-audio="' + esc(sample.assetId) + '"></audio></div>';
    }).join('');
    $$('[data-wb-voice-play]').forEach(function (button) {
      button.onclick = async function () {
        var audio = $('audio[data-wb-voice-audio="' + button.dataset.wbVoicePlay + '"]');
        if (!audio) return;
        if (!audio.src) {
          try {
            var blob = await fetchBlob(API + '/assets/' + encodeURIComponent(button.dataset.wbVoicePlay) + '/file');
            audio.src = URL.createObjectURL(blob);
          } catch (e) { toast('音色暂时无法播放', 'error'); return; }
        }
        if (audio.paused) { void audio.play().catch(function () { toast('音色暂时无法播放', 'error'); }); }
        else audio.pause();
      };
    });
    $$('[data-wb-voice-use]').forEach(function (button) {
      button.onclick = async function () {
        var sample = state.voiceSamples.filter(function (item) { return item.id === button.dataset.wbVoiceUse; })[0];
        if (!sample) return;
        var draftId = button.dataset.draft;
        var draft = draftId ? findVideoDraft(draftId) : null;
        if (!draft) { draft = state.videoDrafts.filter(function (row) { return row.mode !== 'auto'; }).slice(-1)[0] || newVideoDraft('generate'); }
        if (draft.assetRefs.some(function (ref) { return ref.assetId === sample.assetId; })) { toast('这条音色已经在引用里了', 'error'); return; }
        draft.assetRefs.push({ assetId: sample.assetId, role: '音色', label: sample.name, notes: '口播音色参考' });
        saveVideoDrafts();
        try { await call('/voice-samples/' + encodeURIComponent(sample.id) + '/use', { method: 'POST' }); } catch (e) { /* 计数失败不影响使用 */ }
        closeDialog();
        renderVideo();
        toast('已把「' + sample.name + '」加为 @音色 引用', 'success');
      };
    });
    $$('[data-wb-voice-rename]').forEach(function (button) {
      button.onclick = async function () {
        var sample = state.voiceSamples.filter(function (item) { return item.id === button.dataset.wbVoiceRename; })[0];
        if (!sample) return;
        var name = window.prompt('新的音色名称', sample.name);
        if (!name || name === sample.name) return;
        try {
          var result = await call('/voice-samples/' + encodeURIComponent(sample.id), { method: 'PUT', body: { name: name } });
          state.voiceSamples = state.voiceSamples.map(function (item) { return item.id === sample.id ? result.sample : item; });
          renderVoiceLibRows(draftId);
        } catch (error) { toast(error.message, 'error'); }
      };
    });
    $$('[data-wb-voice-del]').forEach(function (button) {
      button.onclick = async function () {
        if (!window.confirm('从音色库删除这条音色？')) return;
        try {
          await call('/voice-samples/' + encodeURIComponent(button.dataset.wbVoiceDel), { method: 'DELETE' });
          state.voiceSamples = state.voiceSamples.filter(function (item) { return item.id !== button.dataset.wbVoiceDel; });
          renderVoiceLibRows(draftId);
        } catch (error) { toast(error.message, 'error'); }
      };
    });
  }

  /* ── 页面组装 ── */
  function renderVideo() {
    loadVideoDrafts();
    var launcher = '<div class="wb-card"><div class="wb-card-head"><div><h3>开始一个视频任务</h3><p>像发消息一样创建任务；生成模式从需求创作，复刻模式参考现有内容，自动模式按周期日更。</p></div>' +
      '<label class="wb-inline"><span>账号</span>' + accountSelectHtml('id="wb-video-account"') + '</label></div>' +
      '<div class="wb-actions">' +
      '<button class="btn primary" type="button" data-wb-v-launch="generate">' + ic('sparkle', 13) + '生成模式</button>' +
      '<button class="btn primary" type="button" data-wb-v-launch="replicate">' + ic('copy', 13) + '复刻模式</button>' +
      '<button class="btn" type="button" data-wb-v-action="open-voices" data-id="">' + ic('music', 13) + '音色库</button>' +
      '</div></div>';
    var draftCards = state.videoDrafts.map(renderVideoDraftCard).join('');
    var workCards = state.videoWorks.map(renderVideoWorkCard).join('');
    var emptyWork = state.videoWorks.length || draftCards ? '' : '<div class="wb-card"><p class="wb-muted">还没有视频任务。选一种模式开始：生成或复刻。</p></div>';
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      launcher + draftCards + workCards + emptyWork + renderLegacyVideoProjects() + renderVideoQueue() +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>数字人口播（五期）</h3><p>用自己的音色和形象照，把文案直接变成对口型口播视频；也可以直接在下方继续使用。</p></div></div><div id="wb-avatar-panel"></div></div>' +
      '</div></div>';
    bindAccountSwitch('#wb-video-account');
    renderAvatarPanel();
    refreshAvatarRuns(true);
    bindLegacyVideoHandlers();
    hydrateWorkVideos();

    $$('[data-wb-v-launch]').forEach(function (button) {
      button.onclick = function () {
        var draft = newVideoDraft(button.dataset.wbVLaunch);
        renderVideo();
        requestAnimationFrame(function () {
          var card = $('[data-wb-v-draft-card="' + draft.id + '"]');
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      };
    });
    $$('[data-wb-v-choice]').forEach(function (button) {
      button.onclick = function () {
        var draft = findVideoDraft(button.dataset.draft);
        if (!draft) return;
        var field = button.dataset.wbVChoice;
        var patch = {};
        patch[field] = button.dataset.value;
        if (field === 'type') patch.subtype = (wbTypeMeta(button.dataset.value).subtypes[0] || [])[0] || '';
        updateVideoDraft(draft.id, patch);
        renderVideo();
      };
    });
    $$('[data-wb-v-field]').forEach(function (control) {
      var handler = function () {
        var draft = findVideoDraft(control.dataset.draft);
        if (!draft) return;
        var field = control.dataset.wbVField;
        var value = control.value;
        if (['durationSeconds', 'intervalDays', 'count'].indexOf(field) >= 0) value = Number(value);
        updateVideoDraft(draft.id, (function () { var patch = {}; patch[field] = value; return patch; })());
      };
      if (control.tagName === 'TEXTAREA' || control.tagName === 'INPUT') control.addEventListener('input', handler);
      else control.addEventListener('change', handler);
    });
    $$('[data-wb-v-unref]').forEach(function (button) {
      button.onclick = function () {
        var draft = findVideoDraft(button.dataset.wbVUnref);
        if (!draft) return;
        draft.assetRefs.splice(Number(button.dataset.index), 1);
        saveVideoDrafts();
        renderVideo();
      };
    });
    $$('[data-wb-v-draft]').forEach(function (button) {
      button.onclick = function () {
        if (button.dataset.wbVDraft === 'discard') { removeVideoDraft(button.dataset.id); renderVideo(); }
      };
    });
    $$('[data-wb-v-action]').forEach(function (button) {
      button.onclick = async function () {
        var action = button.dataset.wbVAction;
        var draftId = button.dataset.id;
        if (action === 'pick-assets') { openVideoAssetPicker(draftId); return; }
        if (action === 'open-voices') { void openVoiceLibraryDialog(draftId); return; }
        if (action !== 'start') return;
        var draft = findVideoDraft(draftId);
        if (!draft) return;
        var original = button.innerHTML;
        button.disabled = true; button.innerHTML = ic('loader', 12) + '提交中…';
        try {
          if (draft.mode === 'replicate' && draft.sourceKind === 'transcript' && !draft.sourceId) {
            toast('先选一条转写档案作为参考', 'error'); button.disabled = false; button.innerHTML = original; return;
          }
          var reference = draft.sourceKind === 'transcript'
            ? (state.transcripts.filter(function (item) { return item.id === draft.sourceId; })[0] || {}).text || ''
            : draft.reference;
          var result = await call('/video/works', {
            method: 'POST',
            body: {
              mode: draft.mode, type: draft.type, subtype: draft.subtype, hookStrategy: draft.hookStrategy,
              durationSeconds: draft.durationSeconds, resolution: draft.resolution, ratio: draft.ratio,
              brief: draft.brief, reference: reference, assetRefs: draft.assetRefs, accountId: state.accountId,
            },
          });
          state.videoWorks.unshift(result.work);
          removeVideoDraft(draft.id);
          renderVideo();
          startVideoWorkPolling();
          toast('编导稿生成中，十几秒后刷新', 'success');
        } catch (error) {
          toast(error.message, 'error');
          button.disabled = false; button.innerHTML = original;
        }
      };
    });
    $$('[data-wb-v-work]').forEach(function (button) {
      button.onclick = async function () {
        var action = button.dataset.wbVWork;
        var workId = button.dataset.id;
        var original = button.innerHTML;
        button.disabled = true;
        try {
          if (action === 'confirm') {
            await call('/video/works/' + encodeURIComponent(workId) + '/confirm', { method: 'POST', body: {} });
            toast('已提交视频渲染，这一页会自动刷新进度', 'success');
          } else if (action === 'regenerate') {
            await call('/video/works/' + encodeURIComponent(workId) + '/regenerate', { method: 'POST', body: {} });
            toast('正在换一版编导稿…', 'success');
          } else if (action === 'save-script') {
            var work = state.videoWorks.filter(function (item) { return item.id === workId; })[0];
            if (!work || !work.directorScript) throw new Error('还没有编导稿可保存');
            var result = await call('/video/works/' + encodeURIComponent(workId), { method: 'PUT', body: { directorScript: work.directorScript, scriptEdited: true } });
            state.videoWorks = state.videoWorks.map(function (item) { return item.id === workId ? result.work : item; });
            toast('编导稿已保存', 'success');
          } else if (action === 'delete') {
            if (!window.confirm('删除这条视频任务及其渲染记录？')) { button.disabled = false; return; }
            await call('/video/works/' + encodeURIComponent(workId), { method: 'DELETE' });
            state.videoWorks = state.videoWorks.filter(function (item) { return item.id !== workId; });
          }
        } catch (error) { toast(error.message, 'error'); }
        button.disabled = false; button.innerHTML = original;
        void loadVideoWorks();
      };
    });
    $$('[data-wb-v-shot]').forEach(function (button) {
      button.onclick = async function () {
        var action = button.dataset.wbVShot;
        var workId = button.dataset.id;
        var index = Number(button.dataset.index);
        var key = workId + ':' + index;
        if (action === 'edit') { state.videoShotEditing = key; renderVideo(); return; }
        if (action === 'cancel-edit') { state.videoShotEditing = null; delete state.videoShotEdits[key]; renderVideo(); return; }
        if (action === 'save-edit') {
          var work = state.videoWorks.filter(function (item) { return item.id === workId; })[0];
          if (!work || !work.directorScript) return;
          var edits = state.videoShotEdits[key] || {};
          work.directorScript.shots = work.directorScript.shots.map(function (shot) {
            if (Number(shot.index) !== index) return shot;
            return {
              index: shot.index, seconds: shot.seconds, role: shot.role,
              scene: edits.scene !== undefined ? edits.scene : shot.scene,
              voiceover: edits.voiceover !== undefined ? edits.voiceover : shot.voiceover,
              overlay: edits.overlay !== undefined ? edits.overlay : shot.overlay,
              renderPrompt: edits.renderPrompt !== undefined ? edits.renderPrompt : shot.renderPrompt,
            };
          });
          state.videoShotEditing = null;
          delete state.videoShotEdits[key];
          renderVideo();
          try {
            var result = await call('/video/works/' + encodeURIComponent(workId), { method: 'PUT', body: { directorScript: work.directorScript, scriptEdited: true } });
            state.videoWorks = state.videoWorks.map(function (item) { return item.id === workId ? result.work : item; });
            renderVideo();
            toast('本镜已保存', 'success');
          } catch (error) { toast(error.message, 'error'); }
          return;
        }
        if (action === 'render') {
          button.disabled = true; button.innerHTML = ic('loader', 11) + '提交中…';
          try {
            await call('/video/works/' + encodeURIComponent(workId) + '/shots/' + index + '/render', { method: 'POST', body: {} });
            toast('单镜渲染已提交，成片会出现在本镜下方和渲染队列', 'success');
            void loadVideoWorks();
          } catch (error) { toast(error.message, 'error'); button.disabled = false; button.innerHTML = '单镜试渲染'; }
        }
      };
    });
    $$('[data-wb-v-edit]').forEach(function (control) {
      var handler = function () {
        var key = control.dataset.key;
        var edits = state.videoShotEdits[key] = state.videoShotEdits[key] || {};
        edits[control.dataset.wbVEdit] = control.value;
      };
      control.addEventListener('input', handler);
    });
    $$('[data-wb-v-retry]').forEach(function (button) {
      button.onclick = async function () {
        button.disabled = true; button.innerHTML = ic('loader', 11) + '重试中…';
        try {
          await call('/video/renders/' + encodeURIComponent(button.dataset.wbVRetry) + '/retry', { method: 'POST', body: {} });
          toast('已重新提交渲染', 'success');
          void loadVideoWorks();
        } catch (error) { toast(error.message, 'error'); button.disabled = false; button.innerHTML = '重试'; }
      };
    });
  }

  /* ───────────── 素材库（账号 + 文件夹） ───────────── */
  /* ───────────── 十期 · 素材库（树形文件夹 + 分析队列 + 成片画廊，对齐原版 assets） ───────────── */
  function stopAssetPolling() {
    if (state.assetTimer) { clearInterval(state.assetTimer); state.assetTimer = null; }
  }
  async function loadAssets(silent) {
    var accountId = state.accountId;
    var query = '?accountId=' + encodeURIComponent(accountId) + (state.assetFolder ? '&folder=' + encodeURIComponent(state.assetFolder) : '');
    var data = await call('/assets' + query).catch(function () { return { items: [], folders: [] }; });
    if (state.accountId !== accountId) return;
    state.assets = data.items || [];
    state.assetFolders = data.folders || [];
    if (state.tab === 'assets') renderAssets();
    startAssetPolling();
  }
  function startAssetPolling() {
    var busy = state.assets.some(function (item) { return item.analysis && (item.analysis.status === 'queued' || item.analysis.status === 'running'); });
    if (!busy) { stopAssetPolling(); return; }
    if (state.assetTimer) return;
    state.assetTimer = setInterval(function () {
      if (state.tab !== 'assets') { stopAssetPolling(); return; }
      void loadAssets(true);
    }, 3000);
  }
  function assetFolderChildren() {
    var prefix = state.assetFolder ? state.assetFolder + '/' : '';
    var seen = {};
    (state.assetFolders || []).forEach(function (row) {
      var path = row.folder || '';
      if (!prefix) {
        if (!path) return;
        seen[path.split('/')[0]] = (seen[path.split('/')[0]] || 0) + row.count;
      } else if (path.indexOf(prefix) === 0) {
        var next = path.slice(prefix.length).split('/')[0];
        if (next) seen[next] = (seen[next] || 0) + row.count;
      }
    });
    return Object.keys(seen).sort().map(function (name) {
      return { name: name, path: prefix + name, count: seen[name] };
    });
  }
  function assetBreadcrumb() {
    if (!state.assetFolder) return '<button class="chip on" type="button" data-asset-folder="">全部</button>' +
      '<button class="chip" type="button" data-asset-folder="__none__">未分类</button>';
    var parts = state.assetFolder.split('/');
    var crumbs = ['<button class="chip" type="button" data-asset-folder="">全部</button>'];
    for (var i = 0; i < parts.length; i++) {
      var path = parts.slice(0, i + 1).join('/');
      crumbs.push('<button class="chip' + (i === parts.length - 1 ? ' on' : '') + '" type="button" data-asset-folder="' + esc(path) + '">' + esc(parts[i]) + '</button>');
    }
    crumbs.push('<button class="chip" type="button" data-asset-folder="__none__">未分类</button>');
    return crumbs.join('<span class="wb-crumb-sep">›</span>');
  }
  var GALLERY_FOLDERS = ['成片', 'AI 生成', '数字人'];
  function assetAnalysisChip(item) {
    var a = item.analysis;
    if (!a) return item.kind === 'image' ? '<span class="wb-tag">待分析</span>' : '';
    var map = { queued: '排队中', running: '分析中', succeeded: a.reusable ? '可复用' : '已分析', failed: '分析失败' };
    return '<span class="wb-tag' + (a.status === 'failed' ? ' warn' : a.reusable ? ' ok' : '') + '">' + esc(map[a.status] || a.status) + '</span>';
  }
  function openAssetMoveDialog(asset) {
    var paths = (state.assetFolders || []).filter(function (row) { return row.folder; }).map(function (row) { return row.folder; });
    var options = ['<option value=""' + (!asset.folder ? ' selected' : '') + '>不分组（未分类）</option>']
      .concat(paths.map(function (path) {
        return '<option value="' + esc(path) + '"' + (asset.folder === path ? ' selected' : '') + '>' + esc(path) + '</option>';
      }));
    showDialog('移动素材', '<p class="wb-note">「' + esc(asset.fileName) + '」移到哪个文件夹？也可以输入新文件夹名（用 / 建层级）。</p>' +
      '<label class="wb-field full"><span>目标文件夹</span><input id="wb-asset-move-target" list="wb-asset-move-paths" value="' + esc(asset.folder || '') + '" maxlength="120" placeholder="如：课堂实拍/体验课"></label>' +
      '<datalist id="wb-asset-move-paths">' + paths.map(function (path) { return '<option value="' + esc(path) + '">'; }).join('') + '</datalist>' +
      '<div class="wb-actions"><button class="btn primary" type="button" id="wb-asset-move-go">移动</button></div>');
    $('#wb-asset-move-go').onclick = async function () {
      var target = String(($('#wb-asset-move-target') || {}).value || '').trim();
      this.disabled = true; this.innerHTML = ic('loader', 12) + '移动中…';
      try {
        await call('/assets/' + encodeURIComponent(asset.id), { method: 'PUT', body: { folder: target } });
        closeDialog();
        toast('已移动到「' + (target || '未分类') + '」', 'success');
        void loadAssets(true);
      } catch (error) {
        toast(error.message, 'error');
        this.disabled = false; this.innerHTML = '移动';
      }
    };
  }
  function renderAssets() {
    var galleryView = state.assetView === 'gallery';
    var filter = state.assetAnalysisFilter || '';
    var allItems = state.assets;
    var items = allItems;
    if (galleryView) {
      items = allItems.filter(function (item) { return item.kind === 'video' && GALLERY_FOLDERS.indexOf(item.folder || '') >= 0; });
    } else if (filter === 'pending') {
      items = allItems.filter(function (item) { return item.kind === 'image' && (!item.analysis || item.analysis.status === 'queued' || item.analysis.status === 'running'); });
    } else if (filter === 'failed') {
      items = allItems.filter(function (item) { return item.analysis && item.analysis.status === 'failed'; });
    } else if (filter === 'reusable') {
      items = allItems.filter(function (item) { return item.analysis && item.analysis.reusable; });
    }
    var pendingCount = allItems.filter(function (item) { return item.kind === 'image' && (!item.analysis || item.analysis.status !== 'succeeded'); }).length;
    var filterChips = [
      ['', '不限'], ['pending', '待分析' + (pendingCount ? ' ' + pendingCount : '')], ['failed', '分析失败'], ['reusable', '可复用'],
    ].map(function (row) {
      if (galleryView && row[0]) return '';
      return '<button class="chip' + (filter === row[0] ? ' on' : '') + '" type="button" data-asset-filter="' + row[0] + '">' + row[1] + '</button>';
    }).join('');
    var children = assetFolderChildren();
    var childChips = galleryView ? '' : children.map(function (child) {
      return '<button class="chip" type="button" data-asset-folder="' + esc(child.path) + '">' + esc(child.name) + '<small> ' + child.count + '</small></button>';
    }).join('');
    var cards;
    if (galleryView) {
      cards = items.length ? '<div class="wb-gallery-grid">' + items.map(function (item) {
        return '<article class="wb-gallery-card"><video class="wb-render-video" controls preload="metadata" data-work-video="' + esc(item.id) + '"></video>' +
          '<div class="wb-asset-info"><b title="' + esc(item.fileName) + '">' + esc(item.fileName) + '</b>' +
          '<small>生成于 ' + fmtDate(item.createdAt) + ' · ' + esc(item.folder || '未分组') + ' · ' + esc(accountName(item.accountId)) + '</small>' +
          '<div class="wb-actions"><button class="btn" type="button" data-asset-open="' + esc(item.id) + '">打开</button>' +
          '<button class="btn" type="button" data-asset-move="' + esc(item.id) + '">移动</button></div></div></article>';
      }).join('') + '</div>' : '<p class="wb-muted">还没有成片。视频工作台确认渲染或数字人口播完成后，成片会自动进画廊（历史「AI 生成」文件夹的也算）。</p>';
    } else {
      cards = items.length ? '<div class="wb-asset-grid">' + items.map(function (item) {
        var thumb = item.kind === 'image'
          ? '<img data-asset-img="' + esc(item.id) + '" alt="' + esc(item.fileName) + '" loading="lazy">'
          : ic(item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'music' : 'folder', 28);
        var analysis = item.analysis && (item.analysis.description || item.analysis.error)
          ? '<p class="wb-asset-analysis">' + esc(item.analysis.description || item.analysis.error) +
            (item.analysis.tags && item.analysis.tags.length ? ' <small>' + esc(item.analysis.tags.join('、')) + '</small>' : '') + '</p>'
          : '';
        return '<article class="wb-asset"><div class="wb-thumb">' + thumb + '</div><div class="wb-asset-info">' +
          '<div class="wb-v-shot-head"><b title="' + esc(item.fileName) + '">' + esc(item.fileName) + '</b>' + assetAnalysisChip(item) + '</div>' +
          '<small>' + esc(item.kind) + ' · ' + fmtSize(item.size) + ' · ' + fmtDate(item.createdAt) +
          (item.folder ? ' · 📁 ' + esc(item.folder) : '') + ' · ' + esc(accountName(item.accountId)) + '</small>' +
          analysis +
          '<div class="wb-actions">' +
          (item.kind === 'image' ? '<button class="btn" type="button" data-asset-analyze="' + esc(item.id) + '">' + (item.analysis && item.analysis.status === 'succeeded' ? '重新分析' : '分析') + '</button>' : '') +
          '<button class="btn" type="button" data-asset-open="' + esc(item.id) + '">打开</button>' +
          '<button class="btn" type="button" data-asset-move="' + esc(item.id) + '">移动</button>' +
          '<button class="btn" type="button" data-asset-del="' + esc(item.id) + '">' + ic('trash', 12) + '</button></div></div></article>';
      }).join('') + '</div>' : '<p class="wb-muted">这个筛选下还没有素材。上传课程图、课堂视频、参考音频或口播文本。</p>';
    }
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>素材库</h3><p>树形文件夹整理素材；图片可进分析队列（画面描述/标签/可复用判定，关页继续跑）；AI 生成的成片自动进「成片」文件夹和画廊。</p></div>' +
      '<label class="wb-inline"><span>账号</span>' + accountSelectHtml('id="wb-asset-account"') + '</label></div>' +
      '<div class="chips" style="margin:2px 0 6px">' + assetBreadcrumb() + '</div>' +
      (childChips ? '<div class="chips" style="margin:0 0 6px">' + childChips + '</div>' : '') +
      '<div class="chips" style="margin:0 0 10px">' +
      '<button class="chip' + (!galleryView ? ' on' : '') + '" type="button" data-asset-view="grid">素材网格</button>' +
      '<button class="chip' + (galleryView ? ' on' : '') + '" type="button" data-asset-view="gallery">成片画廊</button>' +
      filterChips +
      (!galleryView && pendingCount ? '<button class="chip" type="button" data-asset-analyze-batch>' + ic('loader', 11) + ' 分析全部待分析图片</button>' : '') +
      '</div>' +
      '<div class="wb-account-bar"><label class="btn primary" for="wb-asset-input">' + ic('upload', 13) + '上传素材</label>' +
      '<input id="wb-asset-input" type="file" multiple hidden accept=".jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.webm,.m4v,.mp3,.m4a,.wav,.aac,.txt,.md">' +
      '<label class="wb-inline"><span>新建子文件夹（可选）</span><input id="wb-asset-newfolder" placeholder="上传时即创建，如：课堂实拍" maxlength="60" style="max-width:200px"></label>' +
      '<span class="wb-note">当前：' + (state.assetFolder === '__none__' ? '未分类' : (state.assetFolder || '全部')) + '</span></div>' +
      cards +
      '</div></div></div>';
    bindAccountSwitch('#wb-asset-account');
    $$('[data-asset-folder]').forEach(function (chip) {
      chip.onclick = function () {
        state.assetFolder = chip.dataset.assetFolder;
        stopAssetPolling();
        void loadAssets(true);
      };
    });
    $$('[data-asset-view]').forEach(function (chip) {
      chip.onclick = function () {
        state.assetView = chip.dataset.assetView;
        renderAssets();
        hydrateWorkVideos();
      };
    });
    $$('[data-asset-filter]').forEach(function (chip) {
      chip.onclick = function () {
        state.assetAnalysisFilter = chip.dataset.assetFilter;
        renderAssets();
      };
    });
    var input = $('#wb-asset-input');
    input.onchange = async function () {
      var files = Array.prototype.slice.call(input.files || []);
      if (!files.length) return;
      var newFolder = String(($('#wb-asset-newfolder') || {}).value || '').trim();
      var folder = state.assetFolder === '__none__' ? '' : (state.assetFolder ? (newFolder ? state.assetFolder + '/' + newFolder : state.assetFolder) : newFolder);
      for (var i = 0; i < files.length; i++) {
        var form = new FormData();
        form.append('file', files[i]);
        if (folder) form.append('folder', folder);
        form.append('accountId', state.accountId);
        try {
          await call('/assets', { method: 'POST', body: form });
          toast(files[i].name + ' 已上传', 'success');
        } catch (error) { toast(files[i].name + '：' + error.message, 'error'); }
      }
      void loadAssets(true);
    };
    $$('[data-asset-open]').forEach(function (button) {
      button.onclick = function () { openAsset(button.dataset.assetOpen); };
    });
    $$('[data-asset-move]').forEach(function (button) {
      button.onclick = function () {
        var asset = state.assets.filter(function (item) { return item.id === button.dataset.assetMove; })[0];
        if (asset) openAssetMoveDialog(asset);
      };
    });
    $$('[data-asset-analyze]').forEach(function (button) {
      button.onclick = async function () {
        button.disabled = true; button.innerHTML = ic('loader', 11) + '排队中…';
        try {
          await call('/assets/' + encodeURIComponent(button.dataset.assetAnalyze) + '/analyze', { method: 'POST', body: { accountId: state.accountId } });
          toast('已加入分析队列，关页也会继续跑', 'success');
          startAssetPolling();
          void loadAssets(true);
        } catch (error) { toast(error.message, 'error'); button.disabled = false; }
      };
    });
    var batch = $('[data-asset-analyze-batch]');
    if (batch) {
      batch.onclick = async function () {
        batch.disabled = true; batch.innerHTML = ic('loader', 11) + '排队中…';
        try {
          var result = await call('/assets/analyze-batch', { method: 'POST', body: { accountId: state.accountId } });
          toast('已把 ' + result.queued + ' 张图片排进分析队列', 'success');
          startAssetPolling();
          void loadAssets(true);
        } catch (error) { toast(error.message, 'error'); batch.disabled = false; }
      };
    }
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
    hydrateWorkVideos();
    startAssetPolling();
  }

  /* ───────────── 报表 / 任务 ───────────── */
  function renderReports() {
    // 九期 · 数据复盘：数据来自五期截图回填（文案草稿 stats），这里聚合成页 + AI 洞察。
    var published = state.copy.filter(function (item) { return item.stats && (item.stats.backfilledAt || item.stats.plays != null); });
    var totals = published.reduce(function (acc, item) {
      ['plays', 'likes', 'comments', 'shares', 'saves'].forEach(function (key) {
        acc[key] += Number(item.stats[key]) || 0;
      });
      return acc;
    }, { plays: 0, likes: 0, comments: 0, shares: 0, saves: 0 });
    var pending = state.copy.length - published.length;
    var reviewCards = [['已回填', published.length, '条'], ['总播放', totals.plays, ''], ['总点赞', totals.likes, ''], ['总评论', totals.comments, ''], ['总分享', totals.shares, ''], ['总收藏', totals.saves, '']];
    var insight = state.reviewInsight;
    var head = '<div class="wb-card"><div class="wb-card-head"><div><h3>发布数据复盘</h3><p>发布后在抖音作者端截图，回来一键识别回填；积累几条后让小铃铛出复盘洞察。</p></div>' +
      '<label class="wb-inline"><span>账号</span>' + accountSelectHtml('id="wb-reports-account"') + '</label></div>' +
      '<div class="wb-stats">' + reviewCards.map(function (item) { return '<div class="wb-stat"><span>' + item[0] + '</span><b>' + item[1] + '<small style="font-size:11px;color:var(--text-3);font-weight:400"> ' + item[2] + '</small></b></div>'; }).join('') + '</div>' +
      '<div class="wb-field full wb-actions">' +
      '<button class="btn primary" type="button" data-review-action="insight"' + (published.length ? '' : ' disabled') + '>' + ic('bulb', 13) + '生成复盘洞察</button>' +
      (pending > 0 ? '<button class="btn" type="button" data-review-action="go-copy">' + pending + ' 条还没回填，去文案草稿</button>' : '') +
      '</div>' +
      (insight ? '<div class="wb-copy-body wb-review-insight">' + md(insight) + '</div>' : '') +
      '</div>';
    var listHtml;
    if (published.length) {
      listHtml = '<div class="wb-card"><div class="wb-card-head"><div><h3>已发布内容数据</h3><p>按回填时间倒序；数据来自作者端截图识别，可随时更新。</p></div></div>' +
        '<table class="wb-table"><thead><tr><th>主题</th><th>发布</th><th>播放</th><th>赞</th><th>评</th><th>转</th><th>藏</th><th>回填</th><th></th></tr></thead><tbody>' +
        published.map(function (item) {
          var s = item.stats;
          return '<tr><td title="' + esc(item.topic) + '">' + esc(String(item.topic || '').slice(0, 26)) + '</td>' +
            '<td>' + esc(s.publishedAt || '—') + '</td>' +
            [s.plays, s.likes, s.comments, s.shares, s.saves].map(function (value) { return '<td>' + (Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—') + '</td>'; }).join('') +
            '<td>' + fmtDate(s.backfilledAt) + '</td>' +
            '<td><button class="btn" type="button" data-review-backfill="' + esc(item.id) + '">更新数据</button></td></tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      listHtml = '<div class="wb-card"><p class="wb-muted">还没有回填过发布数据。在文案草稿里点「回填数据」，或发布后回来补。</p></div>';
    }
    var stats = (state.summary && state.summary.stats) || {};
    var cards = [['对话消息', stats.messages || 0, '条'], ['文案草稿', stats.copy_drafts || 0, '条'], ['视频项目', stats.videos || 0, '个'], ['素材', stats.assets || 0, '份'], ['同行观察', stats.references || 0, '条'], ['生成任务', stats.jobs || 0, '次']];
    var jobs = (state.summary && state.summary.jobs) || state.jobs.slice(0, 8);
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' + head + listHtml +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>账号资产概览</h3><p>当前机构的内容资产与最近任务。</p></div></div>' +
      '<div class="wb-stats">' + cards.map(function (item) { return '<div class="wb-stat"><span>' + item[0] + '</span><b>' + item[1] + '<small style="font-size:11px;color:var(--text-3);font-weight:400"> ' + item[2] + '</small></b></div>'; }).join('') + '</div></div>' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>最近任务</h3><p>生成成功或失败都会记录。</p></div><button class="btn" type="button" data-wb-go="jobs">查看全部</button></div>' +
      (jobs.length ? '<table class="wb-table"><thead><tr><th>类型</th><th>状态</th><th>说明</th><th>时间</th></tr></thead><tbody>' +
        jobs.map(function (job) { return '<tr><td>' + esc(job.kind) + '</td><td>' + esc(jobStatusText(job.status)) + '</td><td>' + esc(job.detail) + '</td><td>' + fmtDate(job.createdAt) + '</td></tr>'; }).join('') + '</tbody></table>' : '<p class="wb-muted">还没有任务。</p>') +
      '</div></div></div>';
    bindAccountSwitch('#wb-reports-account');
    $$('[data-wb-go]').forEach(function (button) { button.onclick = function () { setTab(button.dataset.wbGo); }; });
    $$('[data-review-action]').forEach(function (button) {
      button.onclick = async function () {
        if (button.dataset.reviewAction === 'go-copy') { setTab('copy'); return; }
        var original = button.innerHTML;
        button.disabled = true; button.innerHTML = ic('loader', 12) + '分析中…';
        try {
          var result = await call('/reviews/insights', { method: 'POST', body: { accountId: state.accountId } });
          state.reviewInsight = result.insight;
          renderReports();
          toast('复盘洞察已生成', 'success');
        } catch (error) { toast(error.message, 'error'); button.disabled = false; button.innerHTML = original; }
      };
    });
    $$('[data-review-backfill]').forEach(function (button) {
      button.onclick = function () { backfillStats(button.dataset.reviewBackfill); };
    });
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
    else if (state.tab === 'plan') renderPlan();
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
