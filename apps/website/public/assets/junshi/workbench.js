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
    jobFacets: [],
    jobStatusFacets: [],
    jobTotal: 0,
    jobKind: '',
    jobStatus: '',
    jobsTimer: null,
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
    videoEstimateTimer: null,
    videoTalkingHeadTimer: null,
    videoShotEditing: null,
    videoShotEdits: {},
    shotFrameUrls: {},
    // 十八期：任务列表 → 单任务专注制作。只有视频页打开具体任务时才存在。
    videoFocus: null,
    videoStep: 1,
    // 十九期：视频包装与发布包（字幕/BGM/封面/标题/zip）。
    videoPackages: {},
    videoPackageLoading: '',
    videoPackageTimer: null,
    videoPackageSweepTimer: null,
    videoPackageSweepWork: '',
    hostedAutoAdvanced: {},
    packageMediaUrls: {},
    videoAdvancedOpen: false,
    // 十六期 · 内容方案卡（对齐原版 renderPlans：聊天产出方案 → 查看/改/确认制作/导出）
    plans: [],
    // 内容计划内部两个子视图：创作方案 / 周期计划。文案草稿页已按用户口径删除。
    planView: 'plans',
    // 八期 · 内容计划/周期日历（对齐原版 content-cycles，作者本人授权复刻）
    cycles: [],
    currentCycle: null,
    cycleTimer: null,
    cycleSlotEditing: null,
    cycleForm: { count: 7, brief: '' },
    cycleRequirements: '',
    reviewInsight: null,
    // 十四期 · 数据复盘（采集助手自己作品 + 截图回填，统一由 /reports 返回）
    reports: null,
    reportsLoading: false,
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
    avatarEstimateTimer: null,
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
  function stopVideoPackagePolling() {
    if (state.videoPackageTimer) { clearInterval(state.videoPackageTimer); state.videoPackageTimer = null; }
    state.videoPackageLoading = '';
  }
  function stopVideoPackageSweep() {
    if (state.videoPackageSweepTimer) { clearInterval(state.videoPackageSweepTimer); state.videoPackageSweepTimer = null; }
    state.videoPackageSweepWork = '';
  }

  /* 一级导航按当前口径：8 个内容目的地 + 独立「历史任务」。
     使用设置从界面隐藏；文案草稿页删除；历史任务不再并入数据复盘。 */
  var TAB_META = {
    chat: { label: '灵动Agent', sub: '说目标，灵动Agent帮你查资料、把内容做出来' },
    account: { label: '账号档案', sub: '写清卖给谁、卖什么，建议才会具体' },
    references: { label: '同行观察', sub: '看同行在发什么，采集作品和口播' },
    copybrains: { label: '文案大脑', sub: '把创作者的写法提炼成可调用的方法' },
    plan: { label: '内容计划', sub: '先排做什么，再决定怎么拍' },
    video: { label: '视频创作', sub: '编导稿、成片，以及数字人口播' },
    assets: { label: '素材库', sub: '图片、视频、音色和成片都在这里' },
    reports: { label: '数据复盘', sub: '看发布效果，判断什么内容有效' },
    jobs: { label: '历史任务', sub: '每次生成任务的状态和失败原因' },
  };

  function setTab(tab) {
    if (!TAB_META[tab]) tab = 'chat';
    state.tab = tab;
    // 离开视频页就退出单任务专注；目的地导航永远回到任务列表。
    if (tab !== 'video') { state.videoFocus = null; state.videoStep = 1; }
    if (tab !== 'video') { stopRenderPolling(); stopAvatarPolling(); stopVideoWorkPolling(); stopVideoPackagePolling(); stopVideoPackageSweep(); }
    if (tab !== 'chat') stopWfPolling();
    if (tab !== 'plan') stopCyclePolling();
    if (tab !== 'assets') stopAssetPolling();
    if (tab !== 'jobs') stopJobsPolling();
    if (tab === 'jobs') void loadJobs(true);
    if (tab === 'plan') { void loadPlans(); void loadCycles(); }
    if (tab !== 'references') { stopTsPolling(); stopPeerSyncPolling(); }
    if (tab === 'references') void loadPeerSyncs(true);
    if (tab !== 'copybrains' && state.brainPollTimer) { clearInterval(state.brainPollTimer); state.brainPollTimer = null; }
    if (tab === 'copybrains') void refreshBrains(true);
    if (tab === 'reports') void loadReports(true);
    $$('#wb-tabs [data-wb]').forEach(function (button) {
      if (button.dataset.wb === tab) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    var meta = TAB_META[tab];
    var crumb = $('#wb-crumb');
    if (crumb) crumb.textContent = meta.label;
    var sub = $('#wb-title-sub');
    if (sub) sub.textContent = meta.sub;
    renderTopbar();
    try { localStorage.setItem('junshi.wb.tab', tab); } catch (e) { /* ignore */ }
    if (tab === 'jobs') {
      render();
      void loadJobs(true);
    } else if (tab === 'reports') {
      render();
      call('/summary').then(function (data) {
        state.summary = Object.assign({}, state.summary, data);
        state.jobs = data.jobs || state.jobs;
        render();
      }).catch(function () { render(); });
    } else {
      render();
    }
    syncVideoChrome();
  }

  function topbarAccountHtml() {
    var list = state.accounts && state.accounts.length ? state.accounts : [{ id: 'default', name: '默认账号' }];
    return '<label class="wb-top-account"><span>账号</span><select id="wb-global-account" aria-label="切换创作账号">' +
      list.map(function (item) {
        return '<option value="' + esc(item.id) + '"' + (item.id === state.accountId ? ' selected' : '') + '>' + esc(item.name) + '</option>';
      }).join('') + '</select></label>';
  }

  /** 顶栏只放「当前页能做的动作」：灵动Agent页是三大工作流 + 清空；视频任务页是返回列表。 */
  function renderTopbar() {
    var box = $('#wb-top-actions');
    if (!box) return;
    var html = '';
    if (state.tab === 'chat') {
      html = '<div class="wb-quick-actions" role="group" aria-label="开始创作">' +
        '<button class="btn primary" type="button" id="wb-flow-today" title="从一个目标开始，生成今日选题">' + ic('bulb', 12) + '今日选题</button>' +
        '<button class="btn" type="button" id="wb-flow-viral" title="参考一条现有内容再创作">' + ic('copy', 12) + '爆款复刻</button>' +
        '<button class="btn" type="button" id="wb-flow-hotspot" title="把热点和你的账号结合">' + ic('sparkle', 12) + '热点结合</button></div>' +
        '<button class="btn wb-icon-btn" type="button" id="wb-clear-chat" title="清空对话" aria-label="清空对话">' + ic('trash', 13) + '</button>';
    } else if (state.tab === 'video' && state.videoFocus) {
      html = '<button class="btn" type="button" id="wb-video-back"><span aria-hidden="true">←</span> 任务列表</button>';
    }
    html += topbarAccountHtml();
    box.innerHTML = html;
    var select = $('#wb-global-account');
    if (select) select.onchange = function () { switchAccount(select.value); };
    if (state.tab === 'chat') {
      $('#wb-flow-today').onclick = function () { openFlowStartDialog('today'); };
      $('#wb-flow-viral').onclick = function () { openFlowStartDialog('viral'); };
      $('#wb-flow-hotspot').onclick = function () { openFlowStartDialog('hotspot'); };
      $('#wb-clear-chat').onclick = clearChat;
    }
    var back = $('#wb-video-back');
    if (back) back.onclick = closeVideoFocus;
  }

  async function clearChat() {
    if (!confirm('清空当前机构的内容工作台对话？账号档案、素材、文案和任务都会保留。')) return;
    try {
      await call('/chat', { method: 'DELETE' });
      state.messages = [];
      renderMessages(true);
      bindPromptButtons();
      toast('对话已清空');
    } catch (error) { toast(error.message, 'error'); }
  }

  /** 切换当前创作账号：档案、文案、视频、素材都按账号重新拉一遍。 */
  async function switchAccount(accountId) {
    if (!accountId || accountId === state.accountId) return;
    state.accountId = accountId;
    try { localStorage.setItem('junshi.wb.account', accountId); } catch (e) { /* ignore */ }
    state.assetFolder = '';
    try {
      var results = await Promise.all([
        call('/profile?accountId=' + encodeURIComponent(accountId)).catch(function () { return null; }),
        call('/copy?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [] }; }),
        call('/videos?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [] }; }),
        call('/assets?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [], folders: [] }; }),
        call('/plans?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [] }; }),
      ]);
      if (results[0]) state.profile = results[0].profile || state.profile;
      state.copy = results[1].items || [];
      state.videos = results[2].items || [];
      state.assets = results[3].items || [];
      state.assetFolders = results[3].folders || [];
      state.plans = results[4].items || [];
      state.reports = null;
      state.reviewInsight = null;
      if (state.tab === 'reports') void loadReports(true);
      if (state.tab === 'video') {
        state.selectedVideo = null;
        state.videoShotEditing = null;
        state.videoShotEdits = {};
        state.videoFocus = null;
        state.videoStep = 1;
        void loadVideoData(true);
      }
      if (state.tab === 'plan') { state.cycleSlotEditing = null; void loadCycles(true); }
    } catch (e) { /* 保持旧数据 */ }
    renderTopbar();
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
      var savedAccount = '';
      try { savedAccount = localStorage.getItem('junshi.wb.account') || ''; } catch (e) { /* ignore */ }
      state.accountId = savedAccount && state.accounts.some(function (item) { return item.id === savedAccount; }) ? savedAccount : 'default';
      var results = await Promise.all([
        call('/chat').catch(function () { return { messages: [] }; }),
        call('/copy?accountId=' + encodeURIComponent(state.accountId)).catch(function () { return { items: [] }; }),
        call('/videos?accountId=' + encodeURIComponent(state.accountId)).catch(function () { return { items: [] }; }),
        call('/assets?accountId=' + encodeURIComponent(state.accountId)).catch(function () { return { items: [], folders: [] }; }),
        call('/refs').catch(function () { return { items: [] }; }),
        call('/jobs').catch(function () { return { items: [] }; }),
        call('/workflows').catch(function () { return { items: [], styles: [], angles: [], strengths: [] }; }),
        call('/memories').catch(function () { return { items: [] }; }),
        call('/transcripts').catch(function () { return { items: [] }; }),
        call('/voices').catch(function () { return { items: [] }; }),
        call('/avatar/runs').catch(function () { return { items: [] }; }),
        call('/brains').catch(function () { return { items: [] }; }),
        call('/plans?accountId=' + encodeURIComponent(state.accountId)).catch(function () { return { items: [] }; }),
        call('/profile?accountId=' + encodeURIComponent(state.accountId)).catch(function () { return null; }),
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
      state.plans = results[12].items || [];
      if (results[13] && results[13].profile) state.profile = results[13].profile;
      state.loaded = true;
      renderTopbar();
      if (state.tab === 'chat') render();
      else setTab(state.tab);
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
  function attachmentIcon(kind) {
    return kind === 'video' ? 'video' : kind === 'audio' ? 'music' : 'image';
  }
  function attachmentChipHtml(item, clickable) {
    var label = item.label || ('@' + ({ image: '图片', video: '视频', audio: '音频' }[item.kind] || '附件') + (item.index || ''));
    var tag = clickable ? 'button' : 'span';
    return '<' + tag + ' class="wb-attach-chip"' + (clickable ? ' type="button"' : '') + ' data-msg-attach="' + esc(item.id) + '" title="' + esc(item.fileName || '') + '">' +
      ic(attachmentIcon(item.kind), 11) + ' ' + esc(label) +
      (item.fileName ? '<small>' + esc(String(item.fileName).slice(0, 18)) + '</small>' : '') + '</' + tag + '>';
  }
  function messageHtml(message, index) {
    var me = message.role === 'user';
    var content = message.content || '';
    var body = me ? esc(content).replace(/\n/g, '<br>') : (content ? md(content) : '<span class="loading">' + esc(message.status || '正在写…') + '</span>');
    var attachments = me && Array.isArray(message.attachments) && message.attachments.length
      ? '<div class="wb-msg-attach">' + message.attachments.map(function (item) { return attachmentChipHtml(item, false); }).join('') + '</div>'
      : '';
    var status = !me && message.pending && message.status && content ? '<div class="wb-msg-status">' + ic('loader', 11) + ' ' + esc(message.status) + '</div>' : '';
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
    var plan = '';
    if (!me && message.plan) {
      plan = planInlineHtml(message.plan);
    } else if (!me && content && !message.pending && message.id && String(content).length > 80) {
      plan = '<button class="wb-mini-btn" type="button" data-plan-from-chat="' + index + '" title="把这条回答整理成可检查、可修改的内容方案">' + ic('sparkle', 11) + '整理成制作方案</button>';
    }
    return '<div class="wb-msg' + (me ? ' me' : '') + '"><div class="wb-msg-meta">' + (me ? '你' : '灵动Agent') + (message.pending ? ' · 正在写' : '') + '</div>' +
      '<div class="wb-bubble">' + body + attachments + status + '</div>' + saveMem + plan + sources + '</div>';
  }
  function renderMessages(forceBottom) {
    var box = $('#wb-msgs');
    if (!box) return;
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    box.innerHTML = state.messages.length ? state.messages.map(messageHtml).join('') : chatEmpty();
    bindMemSaveButtons();
    bindPlanMessageButtons();
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
          var result = await call('/memories', { method: 'POST', body: { kind: 'memory', content: String(message.content).replace(/[#*`>]/g, '').trim().slice(0, 1200), source: '灵动Agent对话', accountId: state.accountId } });
          state.memories.unshift((result.data || result).memory);
          var counter = $('#wb-mem-open');
          if (counter) counter.innerHTML = ic('quote', 12) + '记忆(' + state.memories.length + ')';
          toast('已记入长期记忆，灵动Agent之后的回答会参考它', 'success');
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
    var note = chips.length ? '已读取 ' + chips.join(' · ') : '还没填账号档案，建议会偏通用';
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-chat">' +
      '<div class="wb-chat-head"><b>灵动Agent</b><span class="wb-note">' + esc(note) + '</span>' +
      (chips.length ? '' : '<button class="wb-mini-btn" type="button" id="wb-chat-profile">去补档案 →</button>') +
      '<button class="wb-mini-btn" type="button" id="wb-mem-open">' + ic('quote', 11) + '记忆(' + state.memories.length + ')</button></div>' +
      '<div class="wb-msgs" id="wb-msgs"></div>' +
      '<div><div class="wb-chat-attach" id="wb-chat-attach"></div>' +
      '<div class="wb-composer"><textarea id="wb-input" placeholder="说说你今天想做什么，或贴一段同行口播…（可发图片/视频/音频，用 @图片1 / @视频1 / @音频1 指定）"></textarea>' +
      '<button class="btn primary" type="button" id="wb-send">' + (state.busy ? ic('stop', 14) + '停止' : ic('arrow-up', 15) + '发送') + '</button></div>' +
      '<div class="wb-composer-foot"><button class="btn" type="button" id="wb-chat-attach-btn">' + ic('plus', 12) + '添加附件</button>' +
      '<input id="wb-chat-file" type="file" accept="image/*,video/*,audio/*" multiple hidden>' +
      '<span class="wb-note" id="wb-chat-attach-hint"></span>' +
      '<span class="wb-note" style="margin-left:auto">模型：</span>' +
      '<button class="chip' + (state.chatTier === 'fast' ? ' on' : '') + '" type="button" data-tier="fast">标准</button>' +
      '<button class="chip' + (state.chatTier === 'deep' ? ' on' : '') + '" type="button" data-tier="deep">深度</button>' +
      '</div></div></div></div>';
    renderMessages(true);
    bindPromptButtons();
    bindWorkflowCard();
    $('#wb-mem-open').onclick = openMemoriesDialog;
    var profileLink = $('#wb-chat-profile');
    if (profileLink) profileLink.onclick = function () { setTab('account'); };
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
  }
  var CHAT_ATTACH_LIMITS = { image: 9, video: 3, audio: 3 };
  var CHAT_ATTACH_LABELS = { image: '图片', video: '视频', audio: '音频' };
  function chatAttachmentKindOf(file) {
    var type = String((file && file.type) || '');
    if (type.indexOf('image/') === 0) return 'image';
    if (type.indexOf('video/') === 0) return 'video';
    if (type.indexOf('audio/') === 0) return 'audio';
    return '';
  }
  function chatAttachmentCounts(extraKind) {
    var counts = { image: 0, video: 0, audio: 0 };
    state.chatAttachments.forEach(function (chip) {
      if (counts[chip.kind] !== undefined && chip.status !== 'failed') counts[chip.kind] += 1;
    });
    if (extraKind && counts[extraKind] !== undefined) counts[extraKind] += 1;
    return counts;
  }
  function chatAttachmentMeta() {
    var counts = { image: 0, video: 0, audio: 0 };
    return state.chatAttachments.map(function (chip) {
      if (chip.status !== 'ready') return null;
      counts[chip.kind] += 1;
      return {
        id: chip.id, kind: chip.kind, index: counts[chip.kind],
        label: '@' + CHAT_ATTACH_LABELS[chip.kind] + counts[chip.kind],
        fileName: chip.fileName || chip.name || '',
      };
    }).filter(Boolean);
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
    var chat = $('.wb-chat');
    if (chat && !chat.dataset.dropBound) {
      chat.dataset.dropBound = '1';
      chat.addEventListener('dragover', function (event) {
        event.preventDefault();
        chat.classList.add('dragging');
      });
      chat.addEventListener('dragleave', function (event) {
        if (!chat.contains(event.relatedTarget)) chat.classList.remove('dragging');
      });
      chat.addEventListener('drop', function (event) {
        event.preventDefault();
        chat.classList.remove('dragging');
        var files = Array.prototype.slice.call((event.dataTransfer || {}).files || []);
        if (files.length) void addChatAttachmentFiles(files);
      });
    }
  }
  async function addChatAttachmentFiles(files) {
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var kind = chatAttachmentKindOf(file);
      if (!kind) { toast(file.name + '：只支持图片、视频、音频', 'error'); continue; }
      var counts = chatAttachmentCounts(kind);
      if (counts[kind] >= CHAT_ATTACH_LIMITS[kind]) {
        toast(CHAT_ATTACH_LABELS[kind] + '最多 ' + CHAT_ATTACH_LIMITS[kind] + ' 个，已跳过 ' + file.name, 'error');
        continue;
      }
      var chip = { id: 'pending' + Date.now() + i, name: file.name, fileName: file.name, kind: kind, status: 'uploading' };
      state.chatAttachments.push(chip);
      renderChatAttachments();
      try {
        var form = new FormData();
        form.append('file', file);
        form.append('accountId', state.accountId);
        form.append('folder', '聊天附件');
        var result = await call('/assets', { method: 'POST', body: form });
        chip.id = result.asset.id;
        chip.fileName = result.asset.fileName || file.name;
        chip.status = 'ready';
        state.assets.unshift(result.asset);
      } catch (error) {
        chip.status = 'failed';
        toast(file.name + '：' + error.message, 'error');
      }
      renderChatAttachments();
    }
  }
  function renderChatAttachments() {
    var box = $('#wb-chat-attach');
    if (!box) return;
    var counts = { image: 0, video: 0, audio: 0 };
    box.innerHTML = state.chatAttachments.map(function (chip, index) {
      var label = '';
      if (chip.status === 'ready' && counts[chip.kind] !== undefined) {
        counts[chip.kind] += 1;
        label = '@' + CHAT_ATTACH_LABELS[chip.kind] + counts[chip.kind];
      }
      return '<span class="wb-attach-chip' + (chip.status === 'failed' ? ' failed' : '') + '" title="' + esc(chip.fileName || chip.name || '') + '" data-attach-chip="' + index + '" data-attach-label="' + esc(label) + '">' +
        ic(chip.status === 'uploading' ? 'loader' : attachmentIcon(chip.kind), 11) + ' ' + (chip.status === 'failed' ? esc(chip.fileName || '上传失败') : esc(label)) +
        (chip.status === 'uploading' ? '<small>上传中</small>' : '') +
        '<button type="button" data-attach-del="' + index + '" aria-label="移除">×</button></span>';
    }).join('');
    $$('[data-attach-del]').forEach(function (button) {
      button.onclick = function () {
        state.chatAttachments.splice(Number(button.dataset.attachDel), 1);
        renderChatAttachments();
      };
    });
    $$('[data-attach-chip]').forEach(function (chip) {
      chip.onclick = function (event) {
        if (event.target.closest('[data-attach-del]')) return;
        var token = String(chip.dataset.attachLabel || '').trim();
        if (!token) return;
        var input = $('#wb-input');
        if (!input) return;
        token += ' ';
        var start = input.selectionStart == null ? input.value.length : input.selectionStart;
        input.value = input.value.slice(0, start) + token + input.value.slice(start);
        input.selectionStart = input.selectionEnd = start + token.length;
        input.focus();
      };
    });
    var hint = $('#wb-chat-attach-hint');
    if (hint) {
      var total = state.chatAttachments.filter(function (chip) { return chip.status !== 'failed'; }).length;
      hint.textContent = total
        ? '已附 ' + counts.image + '/' + CHAT_ATTACH_LIMITS.image + ' 图 · ' + counts.video + '/' + CHAT_ATTACH_LIMITS.video + ' 视频 · ' + counts.audio + '/' + CHAT_ATTACH_LIMITS.audio + ' 音频；发送后自动抽帧/转写'
        : '图片 9 / 视频 3 / 音频 3，可拖入；视频会抽关键帧并转写语音';
    }
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
      showDialog('今天想从哪里开始？', '<p>可以先给一个大致方向，也可以让灵动Agent根据账号资料推荐三个选题。</p>' +
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
    var attachmentMeta = chatAttachmentMeta();
    var attachmentIds = attachmentMeta.map(function (item) { return item.id; });
    state.chatAttachments = [];
    renderChatAttachments();
    state.busy = true;
    state.abort = new AbortController();
    state.messages.push({ role: 'user', content: text, attachments: attachmentMeta });
    var assistant = { role: 'assistant', content: '', pending: true, citations: null, status: '' };
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
          else if (event === 'status') { assistant.status = data.text || ''; renderMessages(); }
          else if (event === 'delta') { assistant.pending = false; assistant.status = ''; assistant.content += data.text || ''; renderMessages(); }
          else if (event === 'reset') { assistant.content = ''; assistant.status = ''; renderMessages(); }
          else if (event === 'error') throw new Error(data.message || '生成失败');
          else if (event === 'done') {
            assistant.pending = false;
            assistant.status = '';
            if (data.message) {
              assistant.id = data.message.id || assistant.id;
              assistant.content = data.message.content || assistant.content;
              assistant.citations = data.message.citations || assistant.citations;
              if (data.message.plan) assistant.plan = data.message.plan;
            }
            if (!assistant.content) assistant.content = '（这次没有生成内容，请重试。）';
            renderMessages();
          } else if (event === 'plan') {
            var target = state.messages.filter(function (item) { return item.id === data.messageId; })[0] || assistant;
            if (data.plan) {
              target.plan = data.plan;
              if (!state.plans.some(function (item) { return item.id === data.plan.id; })) state.plans.unshift(data.plan);
              if (state.tab === 'plan') renderPlan();
              toast('已整理成制作方案，可在「内容计划」查看和修改', 'success');
            }
            renderMessages();
          } else if (event === 'stopped') {
            assistant.pending = false;
            assistant.status = '';
            if (!assistant.content) assistant.content = '（已停止生成）';
          }
        }
      }
    } catch (error) {
      assistant.pending = false;
      assistant.status = '';
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
      '<div class="wb-field full wb-actions"><button class="btn primary" type="submit">保存档案</button><span class="wb-note">保存后，灵动Agent会按这份档案回答。</span></div>' +
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
      var data = await call('/douyin/assistant/pairing', { method: 'POST', body: { accountId: state.accountId } });
      var code = data.code;
      var expireAt = Date.parse(data.expiresAt) || (Date.now() + 600000);
      body.innerHTML =
        '<p class="wb-note">配对码 <b class="wb-pair-code">' + esc(code) + '</b>（10 分钟内有效，输进扩展里）</p>' +
        '<ol class="wb-assistant-steps">' +
        '<li><a class="btn" href="/assets/junshi/douyin-assistant.zip?v=20261025-2" download>下载采集助手（zip）</a>并解压到一个固定文件夹</li>' +
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
      '<div class="wb-actions">' +
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
      var failedSegments = (run.segments || []).filter(function (segment) { return segment.status === 'failed'; });
      if (run.status === 'running') body = '<div class="wb-flow-steps">' + (run.steps || []).map(avatarStepHtml).join('') + '</div>' +
        (run.segmentCount ? '<p class="wb-note">已完成 ' + run.doneSegments + ' / ' + run.segmentCount + ' 段' + (run.failedSegments ? ' · 失败 ' + run.failedSegments + ' 段' : '') + '</p>' : '');
      if (run.status === 'failed') {
        var retryLabel = failedSegments.length ? '重试失败分段' : (run.segmentCount && run.doneSegments < run.segmentCount ? '重试未完成分段' : '重试整单');
        body = '<p class="err">' + ic('alert', 13) + '<span>' + esc(run.error || '合成失败') + '</span></p>' +
          (run.segmentCount ? '<p class="wb-note">已完成 ' + run.doneSegments + ' / ' + run.segmentCount + ' 段；已成功的段会保留。</p>' : '') +
          (failedSegments.length ? '<div class="wb-job-segments">' + failedSegments.map(function (segment) {
            return '<p><b>第 ' + segment.index + ' 段</b>：' + esc(segment.text) + '<br><span class="err">' + esc(segment.error || '失败') + '</span></p>';
          }).join('') + '</div>' : '') +
          '<button class="btn primary" type="button" data-avatar-retry="' + esc(run.id) + '">' + ic('refresh', 12) + retryLabel + '</button>';
      }
      if (run.status === 'succeeded' && run.videoAssetId) {
        body = (run.note ? '<p class="wb-note">' + esc(run.note) + '</p>' : '') +
          '<video class="wb-render-video" controls preload="metadata" data-avatar-video="' + esc(run.videoAssetId) + '"></video>';
      }
      return '<div class="wb-render"><div class="wb-card-head"><div><b>' + esc((run.text || '').slice(0, 40)) + '</b>' +
        '<span class="wb-tag ' + (run.status === 'succeeded' ? 'ok' : run.status === 'failed' ? 'bad' : '') + '">' + esc(run.status === 'running' ? '合成中' : run.status === 'succeeded' ? '完成' : '失败') + '</span>' +
        '<div class="wb-meta">' + fmtDate(run.createdAt) + ' · ' + esc(run.speedLabel || '自然') + (run.segmentCount ? ' · ' + run.segmentCount + ' 段' : '') + (run.durationSeconds ? ' · ' + run.durationSeconds + ' 秒' : '') + '</div></div></div>' + body + '</div>';
    }).join('') : '<p class="wb-muted">还没有数字人口播记录。</p>';
    $$('[data-avatar-retry]').forEach(function (button) {
      button.onclick = async function () {
        button.disabled = true; button.innerHTML = ic('loader', 12) + '重试中…';
        try {
          await call('/avatar/runs/' + encodeURIComponent(button.dataset.avatarRetry) + '/retry', { method: 'POST', body: {} });
          toast('已重新提交失败分段', 'success');
          refreshAvatarRuns(true);
        } catch (error) {
          toast(error.message, 'error');
          button.disabled = false; button.innerHTML = ic('refresh', 12) + '重试失败分段';
        }
      };
    });
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
  function scheduleAvatarEstimate() {
    if (state.avatarEstimateTimer) clearTimeout(state.avatarEstimateTimer);
    state.avatarEstimateTimer = setTimeout(function () { void updateAvatarEstimate(); }, 350);
  }
  async function updateAvatarEstimate() {
    var form = $('#wb-avatar-form');
    var box = $('#wb-avatar-estimate');
    if (!form || !box) return;
    var speech = String((form.querySelector('[name="text"]') || {}).value || '').trim();
    var speed = String((form.querySelector('[name="speed"]') || {}).value || 'natural');
    if (!speech) {
      var emptySubmit = form.querySelector('[type="submit"]');
      if (emptySubmit) emptySubmit.disabled = !((form.querySelector('[name="voiceId"]') || {}).value) || !((form.querySelector('[name="imageAssetId"]') || {}).value);
      box.innerHTML = '<span class="wb-muted">填入口播文案后，这里会显示预计时长、分段数和参考费用。</span>';
      return;
    }
    box.innerHTML = '<span class="wb-muted">' + ic('loader', 11) + ' 正在按语速估算…</span>';
    try {
      var result = await call('/estimate/avatar', { method: 'POST', body: { text: speech, speed: speed } });
      var estimate = result.estimate || {};
      var plan = estimate.plan || {};
      var items = (estimate.items || []).map(function (item) {
        return '<span>' + esc(item.label) + '：约 ' + (Number(item.fen || 0) / 100).toFixed(2) + ' 元</span>';
      }).join('');
      var overLimit = plan.overLimit || Number(plan.batchCount || 0) > Number(plan.maxSegments || 30);
      var submit = form.querySelector('[type="submit"]');
      if (submit) submit.disabled = overLimit || !((form.querySelector('[name="voiceId"]') || {}).value) || !((form.querySelector('[name="imageAssetId"]') || {}).value);
      box.innerHTML = '<div class="wb-avatar-estimate-head"><b>预计 ' + esc(plan.targetDuration || 0) + ' 秒 · ' + esc(plan.batchCount || 1) + ' 段</b>' +
        '<span class="wb-tag">预估 ' + (estimate.minFen === estimate.maxFen ? '' : '约 ') + (Number(estimate.minFen || 0) / 100).toFixed(2) +
        (estimate.minFen === estimate.maxFen ? '' : '–' + (Number(estimate.maxFen || 0) / 100).toFixed(2)) + ' 元</span></div>' +
        (overLimit ? '<p class="err">这段文案超过单次 ' + esc(plan.maxSegments || 30) + ' 段上限，请拆成多条或缩短后再提交。</p>' : '') +
        '<p class="wb-note">' + esc(estimate.note || '') + '</p>' +
        (items ? '<details class="wb-avatar-estimate-items"><summary>费用明细</summary>' + items + '</details>' : '');
    } catch (error) {
      box.innerHTML = '<span class="wb-muted">' + esc(error.message || '估价失败') + '</span>';
    }
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
    var referenceVoices = readyVoices.filter(function (item) { return item.mode === 'reference'; });
    var training = state.voices.filter(function (item) { return item.status === 'training'; });
    var imageAssets = state.assets.filter(function (item) { return item.kind === 'image'; });
    var speeds = [
      ['natural', '自然 · 约50字/10秒'],
      ['slightly_fast', '稍快 · 约60字/10秒'],
      ['fast', '较快 · 约75字/10秒'],
      ['extreme', '极快 · 约90字/10秒'],
    ];
    box.innerHTML = '<div class="wb-card-head"><div><h3>数字人口播</h3><p>用自己的音色和形象照做精准对口型口播。长文案会按标点自动分段、逐段合成后拼成一条完整视频，不用自己切；语速四档会真实改变配音速度。成片进素材库「数字人」文件夹。</p></div></div>' +
      '<form id="wb-avatar-form" class="wb-form">' +
      '<label class="wb-field"><span>音色</span><select name="voiceId">' + (readyVoices.length ? readyVoices.map(function (v) { return '<option value="' + esc(v.id) + '">' + esc(v.name) + (v.mode === 'reference' ? '（参考直出）' : '') + '</option>'; }).join('') : '<option value="">（先克隆一个音色）</option>') + '</select></label>' +
      '<label class="wb-field"><span>形象照（正面人脸清晰）</span><select name="imageAssetId">' + (imageAssets.length ? imageAssets.slice(0, 30).map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.fileName) + '</option>'; }).join('') : '<option value="">（素材库里还没有图片）</option>') + '</select></label>' +
      '<label class="wb-field"><span>语速</span><select name="speed">' + speeds.map(function (row) { return '<option value="' + row[0] + '">' + row[1] + '</option>'; }).join('') + '</select></label>' +
      '<label class="wb-field full"><span>口播文案（会自动分段，每段不超过 4 秒；不用自己切）</span><textarea name="text" maxlength="3000" placeholder="把要口播的完整文案粘进来，例如：暑期班报名开始了，前 20 名送两节体验课…"></textarea></label>' +
      '<div class="wb-field full" id="wb-avatar-estimate"></div>' +
      '<div class="wb-field full wb-actions"><button class="btn primary" type="submit"' + (readyVoices.length && imageAssets.length ? '' : ' disabled') + '>' + ic('video', 13) + '生成口播视频</button>' +
      '<button class="btn" type="button" id="wb-voice-clone-open">' + ic('plus', 12) + '克隆新音色</button>' +
      (training.length ? '<span class="wb-note">' + ic('loader', 11) + ' ' + training.length + ' 个音色克隆中…</span>' : '') +
      (referenceVoices.length ? '<span class="wb-note">' + ic('alert', 11) + ' ' + referenceVoices.length + ' 个音色为参考音频直出（非训练克隆）</span>' : '') +
      '<span class="wb-note">按次计费（底片/语音/对口型各一步）；20 次/小时。</span></div></form>' +
      '<div id="wb-avatar-list" style="margin-top:10px"></div>';
    renderAvatarList();
    $('#wb-voice-clone-open').onclick = openCloneVoiceDialog;
    var form = $('#wb-avatar-form');
    var textarea = form.querySelector('[name="text"]');
    var speedSelect = form.querySelector('[name="speed"]');
    textarea.addEventListener('input', scheduleAvatarEstimate);
    speedSelect.addEventListener('change', scheduleAvatarEstimate);
    updateAvatarEstimate();
    form.onsubmit = async function (event) {
      event.preventDefault();
      var button = form.querySelector('[type="submit"]');
      var original = button.innerHTML;
      button.disabled = true; button.innerHTML = ic('loader', 12) + '提交中…';
      try {
        var data = Object.fromEntries(new FormData(form).entries());
        data.accountId = state.accountId;
        var result = await call('/avatar/run', { method: 'POST', body: data });
        if (result.run) state.avatarRuns.unshift(result.run);
        toast(result.run && result.run.segmentCount > 1
          ? '已提交：会分 ' + result.run.segmentCount + ' 段生成后自动拼接，这一页会自动刷新'
          : '已提交，全流程通常 3-6 分钟；这一页会自动刷新', 'success');
        renderAvatarList();
        refreshAvatarRuns(true);
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false; button.innerHTML = original;
      }
    };
  }
  function openStatsBackfill(source, sourceId) {
    var updating = Boolean(source && sourceId);
    showDialog(updating ? '更新发布数据' : '截图回填', '<p class="wb-note">上传抖音作者端的作品数据截图（播放/点赞/评论/分享/收藏），系统自动识别存档。' +
      (updating ? '这次识别会覆盖这条记录原来的数字。' : '不用逐条截图，也不用回到文案草稿页。') + '</p>' +
      '<label class="wb-field full"><span>作品主题（可选，便于在复盘列表里认出来）</span><input id="wb-stats-topic" maxlength="200" placeholder="例如：暑期班探店口播"></label>' +
      '<label class="btn primary" for="wb-stats-input">' + (updating ? '选择新截图' : '选择截图') + '</label>' +
      '<input id="wb-stats-input" type="file" hidden accept=".jpg,.jpeg,.png,.webp,image/*">' +
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
        form.append('folder', '数据复盘截图');
        var uploaded = await call('/assets', { method: 'POST', body: form });
        var body = {
          assetId: uploaded.asset.id,
          accountId: state.accountId,
          topic: String(($('#wb-stats-topic') || {}).value || '').trim(),
        };
        if (updating && source === 'snapshot') body.snapshotId = sourceId;
        if (updating && source === 'copy_draft') body.draftId = sourceId;
        var result = await call('/reviews/backfill', { method: 'POST', body: body });
        var stats = (result.data || result).stats || {};
        msg.textContent = '已识别：播放 ' + (stats.plays ?? '—') + ' · 赞 ' + (stats.likes ?? '—') + ' · 评论 ' + (stats.comments ?? '—') + (stats.publishedAt ? ' · ' + stats.publishedAt : '');
        toast(updating ? '发布数据已更新' : '发布数据已回填', 'success');
        await loadReports(true);
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
  /* ───────────── 十六期 · 内容方案卡（对齐原版 renderPlans：查看 / 改 / 确认制作 / 导出） ───────────── */
  var PLAN_DURATIONS = [5, 10, 15, 20, 25, 30];
  var PLAN_RESOLUTIONS = ['480P', '768P'];
  var PLAN_RATIOS = ['9:16', '16:9', '1:1'];
  var PLAN_KIND_LABEL = { image: '图片', video: '视频', audio: '音频' };

  async function loadPlans(silent) {
    var accountId = state.accountId;
    var data = await call('/plans?accountId=' + encodeURIComponent(accountId)).catch(function () { return { items: [] }; });
    if (state.accountId !== accountId) return;
    state.plans = data.items || [];
    var byId = {};
    state.plans.forEach(function (plan) { byId[plan.id] = plan; });
    (state.messages || []).forEach(function (message) {
      if (message.plan) message.plan = byId[message.plan.id] || null;
    });
    if (state.tab === 'plan' && (state.planView || 'plans') === 'plans') renderPlan();
  }
  function planStatusLabel(plan) {
    if (plan.status === 'submitted') return '已提交制作';
    return plan.missing && plan.missing.length ? '待补 ' + plan.missing.length + ' 项素材' : '可检查并确认';
  }
  function planSourceLabel(plan) {
    if (plan.source === 'chat') return '聊天提炼';
    if (plan.source === 'copy') return '复用方案';
    return '手动创建';
  }
  function planInlineHtml(plan) {
    var submitted = plan.status === 'submitted';
    return '<div class="wb-msg-plan"><div class="wb-msg-plan-head"><span class="wb-tag ' + (submitted || !(plan.missing || []).length ? 'ok' : 'warn') + '">' + esc(planStatusLabel(plan)) + ' · 第 ' + plan.version + ' 版</span><b>' + esc(planDisplayTitle(plan)) + '</b></div>' +
      '<div class="wb-msg-plan-meta">' + plan.duration + ' 秒 · ' + esc(plan.resolution) + ' · ' + esc(plan.ratio) + '</div>' +
      '<div class="wb-actions"><button class="btn" type="button" data-plan-open="' + esc(plan.id) + '">查看 / 修改</button>' +
      (submitted
        ? (plan.videoWorkId ? '<button class="btn primary" type="button" data-plan-work="' + esc(plan.videoWorkId) + '">查看视频任务</button>' : '')
        : '<button class="btn primary" type="button" data-plan-preflight="' + esc(plan.id) + '"' + ((plan.missing || []).length ? ' disabled' : '') + '>确认制作</button>') +
      '</div></div>';
  }
  /** 聊天直接产出的方案有时会把客套话写进标题；卡片上换成可扫读的选题名。 */
  function planUsefulText(value) {
    var text = String(value || '').replace(/^收到[。.!！]?/, '')
      .replace(/为了不给你泛泛建议[，,]?/, '')
      .replace(/^我先对齐\s*\d+\s*件事[：:]?/, '')
      .trim();
    if (!text || /^(好的|可以|收到|没问题|我来|我先|稍等)/.test(text)) return '';
    return text;
  }
  function planDisplayTitle(plan) {
    var title = String((plan && plan.title) || '').trim();
    var generic = !title || /^收到[。.!！]?/.test(title) || /为了不给你泛泛建议|我先对齐\s*\d+\s*件事/.test(title) || title.length > 64;
    if (!generic) return title;
    var first = [plan.hook, plan.objective, plan.script].map(planUsefulText).filter(Boolean)
      .map(function (text) { return text.split(/[。！？!?\n]/)[0].trim(); })
      .filter(Boolean)[0] || '';
    return first ? (first.length > 34 ? first.slice(0, 34) + '…' : first) : '内容方案';
  }
  function planExcerpt(plan) {
    var text = planUsefulText(plan.hook) || planUsefulText(plan.objective) || planUsefulText(plan.script) || plan.hook || plan.script || plan.objective || '';
    text = String(text).replace(/\s+/g, ' ').trim();
    return text.length > 180 ? text.slice(0, 180) + '…' : text;
  }
  function planCardHtml(plan) {
    var submitted = plan.status === 'submitted';
    var missing = plan.missing || [];
    var recommendations = plan.materialRecommendations || [];
    var rec = recommendations.length
      ? '<details class="wb-plan-materials"><summary>智能匹配素材 ' + recommendations.length + ' 项</summary>' +
        recommendations.map(function (item) {
          return '<p>' + esc(item.name) + '<small>匹配：' + esc((item.matchedTerms || []).join('、')) + '；' + (item.usage && item.usage.submitted ? '近期方案中使用过，已适当降权。' : '可作为候选。') + '</small></p>';
        }).join('') + '<small>仅是候选，需在「查看 / 修改」中确认后才会用于制作。</small></details>'
      : '';
    return '<article class="wb-card wb-plan-card" data-plan-card="' + esc(plan.id) + '">' +
      '<div class="wb-card-head"><div><span class="wb-tag ' + (submitted || !missing.length ? 'ok' : 'warn') + '">' + esc(planStatusLabel(plan)) + ' · 第 ' + plan.version + ' 版</span><h3>' + esc(planDisplayTitle(plan)) + '</h3></div>' +
      '<span class="wb-tag">' + esc(planSourceLabel(plan)) + '</span></div>' +
      '<div class="wb-plan-meta">' + plan.duration + ' 秒 · ' + esc(plan.resolution) + ' · ' + esc(plan.ratio) + (plan.publishDate ? ' · 计划 ' + esc(plan.publishDate) : '') + ' · ' + esc(accountName(plan.accountId)) + '</div>' +
      '<p class="wb-plan-excerpt">' + esc(planExcerpt(plan)) + '</p>' + rec +
      '<div class="wb-plan-actions">' +
      '<button class="btn" type="button" data-plan-open="' + esc(plan.id) + '">查看 / 修改</button>' +
      (submitted
        ? (plan.videoWorkId ? '<button class="btn primary" type="button" data-plan-work="' + esc(plan.videoWorkId) + '">查看视频任务</button>' : '')
        : '<button class="btn primary" type="button" data-plan-preflight="' + esc(plan.id) + '"' + (missing.length ? ' disabled' : '') + '>确认制作</button>') +
      '</div>' +
      '<div class="wb-plan-tools">' +
      '<button class="wb-mini-btn" type="button" data-plan-copy="' + esc(plan.id) + '">' + ic('copy', 11) + '复制</button>' +
      '<button class="wb-mini-btn" type="button" data-plan-export="' + esc(plan.id) + '">' + ic('download', 11) + '导出文稿</button>' +
      '<button class="wb-mini-btn danger" type="button" data-plan-delete="' + esc(plan.id) + '">移除</button>' +
      '</div></article>';
  }
  function planSectionHtml() {
    var plans = state.plans || [];
    var groups = [
      { key: 'missing', label: '待补素材', sub: '补齐后才能确认制作', items: plans.filter(function (plan) { return plan.status !== 'submitted' && (plan.missing || []).length; }) },
      { key: 'ready', label: '可以确认', sub: '检查后创建视频任务', items: plans.filter(function (plan) { return plan.status !== 'submitted' && !(plan.missing || []).length; }) },
      { key: 'submitted', label: '已提交制作', sub: '已进入视频创作', items: plans.filter(function (plan) { return plan.status === 'submitted'; }) },
    ];
    var content = groups.filter(function (group) { return group.items.length; }).map(function (group) {
      return '<div class="wb-v-section wb-plan-group"><div class="wb-v-section-head"><b>' + group.label + '</b><span>' + group.items.length + ' 份 · ' + group.sub + '</span></div>' +
        '<div class="wb-plan-grid">' + group.items.map(planCardHtml).join('') + '</div></div>';
    }).join('');
    return '<div class="wb-card wb-plan-head"><div class="wb-card-head"><div><h3>创作方案</h3><p>聊天里说「做一条视频 / 分镜」会自动整理成方案，也可以手动建。确认制作只创建视频任务并生成编导稿，渲染前还会在视频创作里再确认一次。</p></div>' +
      '<button class="btn primary" type="button" data-plan-new>' + ic('plus', 12) + '手动建方案</button></div></div>' +
      (content || '<div class="wb-card"><p class="wb-muted">还没有内容方案。去「灵动Agent」说一条想做的视频，或手动建一份。</p></div>');
  }
  function planAssetRow(asset, checked) {
    return '<div class="wb-plan-asset" data-plan-asset-row="' + esc(asset.id) + '">' +
      '<label class="wb-plan-asset-main"><input type="checkbox" name="planAsset" value="' + esc(asset.id) + '"' + (checked ? ' checked' : '') + '>' +
      '<span class="wb-plan-asset-name">' + esc(asset.fileName || asset.id) + '</span></label>' +
      '<small>' + esc(PLAN_KIND_LABEL[asset.kind] || asset.kind || '素材') + '</small>' +
      '<span class="wb-plan-asset-order"><button type="button" class="wb-mini-btn" data-plan-asset-up="' + esc(asset.id) + '" aria-label="上移素材">↑</button>' +
      '<button type="button" class="wb-mini-btn" data-plan-asset-down="' + esc(asset.id) + '" aria-label="下移素材">↓</button></span></div>';
  }
  function planFormHtml(plan, locked) {
    var assets = (state.assets || []).filter(function (item) { return item.kind !== 'text'; });
    var selected = plan.assetIds || [];
    var ordered = [];
    selected.forEach(function (assetId) { var found = assets.filter(function (a) { return a.id === assetId; })[0]; if (found && ordered.indexOf(found) < 0) ordered.push(found); });
    assets.forEach(function (asset) { if (ordered.indexOf(asset) < 0) ordered.push(asset); });
    var readonly = locked ? ' readonly' : '';
    var disabled = locked ? ' disabled' : '';
    return '<div class="wb-plan-form"><div class="wb-form-grid">' +
      '<label class="wb-field full"><span>内容标题</span><input id="wb-plan-title" value="' + esc(plan.title || '') + '" maxlength="200"' + readonly + '></label>' +
      '<label class="wb-field full"><span>本条内容目标</span><input id="wb-plan-objective" value="' + esc(plan.objective || '') + '" maxlength="500"' + readonly + '></label>' +
      '<label class="wb-field full"><span>开场 / 前三秒</span><textarea id="wb-plan-hook" maxlength="1000"' + readonly + '>' + esc(plan.hook || '') + '</textarea></label>' +
      '<label class="wb-field full"><span>完整口播脚本</span><textarea id="wb-plan-script" class="wb-script" maxlength="8000"' + readonly + '>' + esc(plan.script || '') + '</textarea></label>' +
      '<label class="wb-field full"><span>视频执行提示词（实际提交内容）</span><textarea id="wb-plan-prompt" class="wb-script" maxlength="3000"' + readonly + '>' + esc(plan.prompt || '') + '</textarea></label>' +
      '<label class="wb-field"><span>视频时长</span><select id="wb-plan-duration"' + disabled + '>' + PLAN_DURATIONS.map(function (value) { return '<option value="' + value + '"' + (Number(plan.duration) === value ? ' selected' : '') + '>' + value + ' 秒</option>'; }).join('') + '</select></label>' +
      '<label class="wb-field"><span>分辨率</span><select id="wb-plan-resolution"' + disabled + '>' + PLAN_RESOLUTIONS.map(function (value) { return '<option value="' + value + '"' + (plan.resolution === value ? ' selected' : '') + '>' + value + '</option>'; }).join('') + '</select></label>' +
      '<label class="wb-field"><span>画面比例</span><select id="wb-plan-ratio"' + disabled + '>' + PLAN_RATIOS.map(function (value) { return '<option value="' + value + '"' + (plan.ratio === value ? ' selected' : '') + '>' + value + '</option>'; }).join('') + '</select></label>' +
      '<div class="wb-field full"><span>参考素材（最多 9 项，勾选顺序决定 @图片 / @视频 编号）</span>' +
      '<div class="wb-plan-assets" id="wb-plan-assets">' + (ordered.length ? ordered.map(function (asset) { return planAssetRow(asset, selected.indexOf(asset.id) >= 0); }).join('') : '<p class="wb-muted">素材库还没有图片或音视频素材。</p>') + '</div></div>' +
      '<label class="wb-field full"><span>仍需补充的素材（每行一项；填写后不能提交制作）</span><textarea id="wb-plan-missing"' + readonly + '>' + esc((plan.missing || []).join('\n')) + '</textarea></label>' +
      '<label class="wb-field full"><span>推荐理由 / 创作依据</span><textarea id="wb-plan-rationale"' + readonly + '>' + esc(plan.rationale || '') + '</textarea></label>' +
      '<label class="wb-field"><span>计划发布日期（不自动发布）</span><input id="wb-plan-publish-date" type="date" value="' + esc(plan.publishDate || '') + '"' + readonly + '></label>' +
      '<label class="wb-check"><input id="wb-plan-audio" type="checkbox"' + (plan.generateAudio === false ? '' : ' checked') + disabled + '> 生成音频；台词请写清楚</label>' +
      '</div>' +
      (locked ? '<p class="wb-note">这份方案已经提交制作，不能再改；需要调整请先点「复制」。</p>' : '') +
      '<div class="wb-actions"><button class="btn primary" type="button" id="wb-plan-save"' + (locked ? ' hidden' : '') + '>保存方案</button>' +
      '<button class="btn" type="button" id="wb-plan-cancel">关闭</button></div></div>';
  }
  function openPlanForm(id, copy) {
    var original = id ? (state.plans || []).filter(function (item) { return item.id === id; })[0] : null;
    if (id && !original) { toast('这份方案已经变化，请刷新后重试', 'error'); return; }
    var plan = original ? JSON.parse(JSON.stringify(original)) : {
      title: '', objective: '', hook: '', script: '', prompt: '', model: '', duration: 15,
      resolution: '768P', ratio: '9:16', generateAudio: true, assetIds: [], missing: [],
      rationale: '', publishDate: '', version: 0, status: 'draft',
    };
    if (copy) {
      plan.title = (plan.title || '内容方案') + '（副本）';
      plan.status = 'draft';
      plan.videoWorkId = '';
      plan.renderId = '';
    }
    var locked = Boolean(original && original.status === 'submitted' && !copy);
    showDialog(copy ? '复用内容方案' : locked ? '查看已提交的方案' : id ? '检查并修改方案' : '手动建立内容方案', planFormHtml(plan, locked));
    if (locked) {
      $('#wb-plan-cancel').onclick = closeDialog;
      return;
    }
    var assetsBox = $('#wb-plan-assets');
    function checkedCount() { return $$('[name="planAsset"]:checked').length; }
    function syncAssetState() {
      if (assetsBox) {
        $$('[name="planAsset"]', assetsBox).forEach(function (input) {
          var row = input.closest('.wb-plan-asset');
          if (row) row.classList.toggle('on', input.checked);
        });
      }
      var save = $('#wb-plan-save');
      if (save) save.disabled = checkedCount() > 9;
    }
    $$('[name="planAsset"]').forEach(function (input) {
      input.onchange = function () {
        if (checkedCount() > 9) { input.checked = false; toast('一份方案最多用 9 个参考素材', 'error'); }
        syncAssetState();
      };
    });
    function moveAsset(assetId, delta) {
      var row = assetsBox ? assetsBox.querySelector('[data-plan-asset-row="' + CSS.escape(assetId) + '"]') : null;
      if (!row) return;
      if (delta < 0 && row.previousElementSibling) assetsBox.insertBefore(row, row.previousElementSibling);
      if (delta > 0 && row.nextElementSibling) assetsBox.insertBefore(row.nextElementSibling, row);
      syncAssetState();
    }
    $$('[data-plan-asset-up]').forEach(function (button) {
      button.onclick = function (event) { event.preventDefault(); moveAsset(button.dataset.planAssetUp, -1); };
    });
    $$('[data-plan-asset-down]').forEach(function (button) {
      button.onclick = function (event) { event.preventDefault(); moveAsset(button.dataset.planAssetDown, 1); };
    });
    syncAssetState();
    $('#wb-plan-cancel').onclick = closeDialog;
    $('#wb-plan-save').onclick = async function () {
      var payload = {
        title: String(($('#wb-plan-title') || {}).value || '').trim(),
        objective: String(($('#wb-plan-objective') || {}).value || '').trim(),
        hook: String(($('#wb-plan-hook') || {}).value || '').trim(),
        script: String(($('#wb-plan-script') || {}).value || '').trim(),
        prompt: String(($('#wb-plan-prompt') || {}).value || '').trim(),
        duration: Number(($('#wb-plan-duration') || {}).value || 15),
        resolution: String(($('#wb-plan-resolution') || {}).value || '768P'),
        ratio: String(($('#wb-plan-ratio') || {}).value || '9:16'),
        generateAudio: Boolean(($('#wb-plan-audio') || {}).checked),
        assetIds: $$('[name="planAsset"]:checked').map(function (item) { return item.value; }),
        missing: String(($('#wb-plan-missing') || {}).value || '').split('\n').map(function (item) { return item.trim(); }).filter(Boolean),
        rationale: String(($('#wb-plan-rationale') || {}).value || '').trim(),
        publishDate: String(($('#wb-plan-publish-date') || {}).value || '').trim(),
        accountId: state.accountId,
      };
      if (!payload.title || !payload.objective || !payload.hook || !payload.script || !payload.prompt) {
        toast('请填写标题、目标、前三秒、完整口播和视频提示词', 'error');
        return;
      }
      if (payload.assetIds.length > 9) { toast('一份方案最多用 9 个参考素材', 'error'); return; }
      var button = this;
      button.disabled = true; button.innerHTML = ic('loader', 12) + '保存中…';
      try {
        if (id && !copy) {
          payload.version = original.version;
          await call('/plans/' + encodeURIComponent(id), { method: 'PUT', body: payload });
        } else {
          await call('/plans', { method: 'POST', body: payload });
        }
        closeDialog();
        toast(copy ? '已复制成新方案' : id ? '方案已保存' : '方案已创建', 'success');
        await loadPlans(true);
        renderPlan();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
        button.innerHTML = '保存方案';
      }
    };
  }
  async function openPlanPreflight(id) {
    var info;
    try { info = await call('/plans/' + encodeURIComponent(id) + '/preflight'); }
    catch (error) { toast(error.message, 'error'); return; }
    var plan = info.plan;
    var missing = plan.missing || [];
    var repeats = info.repeatRisks || [];
    var estimate = info.estimate;
    var estimateHtml = '';
    if (estimate) {
      var range = estimate.minFen === estimate.maxFen
        ? (Number(estimate.totalFen || 0) / 100).toFixed(2) + ' 元'
        : (Number(estimate.minFen || 0) / 100).toFixed(2) + '–' + (Number(estimate.maxFen || 0) / 100).toFixed(2) + ' 元';
      estimateHtml = '<div class="wb-plan-notice"><b>渲染预估：' + range + '</b>（' + esc(plan.duration) + ' 秒 · ' + esc(plan.resolution) + '）<br>' + esc(estimate.note || '') + '</div>';
    }
    showDialog('确认本次制作', '<p><b>' + esc(plan.title) + '</b> · 第 ' + plan.version + ' 版 · ' + plan.duration + ' 秒 · ' + esc(plan.resolution) + ' · ' + esc(plan.ratio) + '</p>' +
      '<div class="wb-plan-notice">' + esc(info.notice) + '<br>输出 ' + info.outputSeconds + ' 秒；参考视频按素材实际时长另计（编导稿阶段不扣费）。' +
      (missing.length ? '<br>尚缺素材：' + esc(missing.join('、')) : '') + '</div>' + estimateHtml +
      (repeats.length ? '<div class="wb-plan-notice warn">素材重复提醒：' + repeats.map(function (item) { return esc(item.name) + '（已用于 ' + item.usage.submitted + ' 个已提交方案）'; }).join('；') + '。这是风险提示，不保证或规避平台判重。</div>' : '') +
      (info.videoReady ? '' : '<p class="wb-note">当前视频渠道未配置；编导稿仍可先生成，渲染前需要管理员配置视频渠道。</p>') +
      '<h4>本次提交给编导的提示词</h4><pre class="wb-plan-prompt">' + esc(info.prompt) + '</pre>' +
      '<label class="wb-check"><input id="wb-plan-confirm" type="checkbox"><span>我已核对方案、时长和素材使用权限，同意创建本次视频任务并生成编导稿。</span></label>' +
      '<div class="wb-actions"><button class="btn primary" type="button" id="wb-plan-submit"' + (missing.length ? ' disabled' : '') + '>确认并创建视频任务</button>' +
      '<button class="btn" type="button" id="wb-plan-preflight-cancel">取消</button></div>');
    $('#wb-plan-preflight-cancel').onclick = closeDialog;
    $('#wb-plan-submit').onclick = async function () {
      if (!$('#wb-plan-confirm').checked) { toast('请先勾选确认', 'error'); return; }
      var button = this;
      button.disabled = true; button.innerHTML = ic('loader', 12) + '创建中…';
      try {
        var result = await call('/plans/' + encodeURIComponent(id) + '/submit', { method: 'POST', body: { version: plan.version, confirm: true } });
        closeDialog();
        toast('方案已确认，视频任务正在生成编导稿', 'success');
        if (result.plan) {
          var index = state.plans.map(function (item) { return item.id; }).indexOf(result.plan.id);
          if (index >= 0) state.plans[index] = result.plan; else state.plans.unshift(result.plan);
        }
        setTab('video');
        await loadVideoData(true);
        if (result.work && result.work.id) openVideoFocus('work', result.work.id, 2);
        else renderVideo();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
        button.innerHTML = '确认并创建视频任务';
      }
    };
  }
  async function exportPlan(id) {
    var plan = (state.plans || []).filter(function (item) { return item.id === id; })[0];
    try {
      var blob = await fetchBlob(API + '/plans/' + encodeURIComponent(id) + '/export');
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = '内容方案-' + String((plan && plan.title) || id).replace(/[\\/:*?"<>|]/g, '-').slice(0, 40) + '.md';
      link.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (error) { toast(error.message, 'error'); }
  }
  async function deletePlan(id) {
    if (!window.confirm('确认移除这份方案？已经创建的视频任务不会一起删除。')) return;
    try {
      await call('/plans/' + encodeURIComponent(id), { method: 'DELETE' });
      await loadPlans(true);
      renderPlan();
      toast('方案已移除');
    } catch (error) { toast(error.message, 'error'); }
  }
  async function planFromChat(index, button) {
    var message = state.messages[Number(index)];
    if (!message || !message.id) { toast('这条回答还在提交，稍后再试', 'error'); return; }
    button.disabled = true;
    button.innerHTML = ic('loader', 11) + '整理中…';
    try {
      var result = await call('/plans/from-chat', { method: 'POST', body: { messageId: message.id, accountId: state.accountId } });
      message.plan = result.plan;
      if (!state.plans.some(function (item) { return item.id === result.plan.id; })) state.plans.unshift(result.plan);
      if (state.tab === 'plan') renderPlan();
      renderMessages();
      toast('已整理成制作方案，可在「内容计划」查看和修改', 'success');
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
      button.innerHTML = ic('sparkle', 11) + '整理成制作方案';
    }
  }
  function bindPlanActions() {
    $$('[data-plan-new]').forEach(function (button) { button.onclick = function () { openPlanForm(''); }; });
    $$('[data-plan-open]').forEach(function (button) { button.onclick = function () { openPlanForm(button.dataset.planOpen); }; });
    $$('[data-plan-copy]').forEach(function (button) { button.onclick = function () { openPlanForm(button.dataset.planCopy, true); }; });
    $$('[data-plan-preflight]').forEach(function (button) { button.onclick = function () { if (!button.disabled) void openPlanPreflight(button.dataset.planPreflight); }; });
    $$('[data-plan-export]').forEach(function (button) { button.onclick = function () { void exportPlan(button.dataset.planExport); }; });
    $$('[data-plan-delete]').forEach(function (button) { button.onclick = function () { void deletePlan(button.dataset.planDelete); }; });
    $$('[data-plan-work]').forEach(function (button) {
      button.onclick = async function () {
        setTab('video');
        await loadVideoData(true);
        openVideoFocus('work', button.dataset.planWork, 2);
      };
    });
    $$('[data-plan-from-chat]').forEach(function (button) {
      button.onclick = function () { void planFromChat(Number(button.dataset.planFromChat), button); };
    });
  }
  function bindPlanMessageButtons() { bindPlanActions(); }

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
    if (state.tab === 'plan' && state.planView === 'cycles') renderPlan();
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
      (regenerating ? '<p class="wb-muted">' + ic('loader', 12) + ' 灵动Agent正在重新生成这一条…</p>' : '') +
      '<div class="wb-actions">' +
      (cycle.status === 'confirmed' ? '<button class="btn primary" type="button" data-cycle-action="start-slot" data-cycle="' + esc(cycle.id) + '" data-slot="' + esc(slot.id) + '" data-version="' + cycle.version + '">从这一项开始创作</button>' : '') +
      '<button class="btn" type="button" data-cycle-action="regen-slot" data-cycle="' + esc(cycle.id) + '" data-slot="' + esc(slot.id) + '" data-version="' + cycle.version + '"' + (regenerating ? ' disabled' : '') + '>重新生成这一条</button>' +
      '<button class="btn" type="button" data-cycle-action="edit-slot" data-cycle="' + esc(cycle.id) + '" data-slot="' + esc(slot.id) + '">' + ic('pen', 11) + '编辑</button>' +
      '<button class="btn" type="button" data-cycle-action="remove-slot" data-cycle="' + esc(cycle.id) + '" data-slot="' + esc(slot.id) + '" data-version="' + cycle.version + '">移除</button>' +
      '</div></article>';
  }
  function planSubtabsHtml() {
    var items = [['plans', '创作方案'], ['cycles', '周期计划']];
    return '<div class="wb-subtabs" role="tablist" aria-label="内容计划子视图">' + items.map(function (row) {
      return '<button class="wb-subtab" type="button" role="tab" data-plan-view="' + row[0] + '"' +
        ((state.planView || 'plans') === row[0] ? ' aria-current="true"' : '') + '>' + row[1] + '</button>';
    }).join('') + '</div>';
  }
  function renderPlan() {
    var view = state.planView === 'cycles' ? 'cycles' : 'plans';
    var desc = view === 'cycles'
      ? '一次排好几天的节奏；确认后可以逐槽开始创作。'
      : '聊天里提炼或手动建立的制作方案；确认后生成编导稿。';
    $('#wb-view').innerHTML = '<div class="wb-page">' +
      '<div class="wb-page-head">' + planSubtabsHtml() + '<span class="wb-note" style="margin-left:auto">' + esc(desc) + '</span></div>' +
      '<div class="wb-scroll" id="wb-plan-subview"></div></div>';
    $$('[data-plan-view]').forEach(function (button) {
      button.onclick = function () { state.planView = button.dataset.planView; renderPlan(); };
    });
    if (view === 'cycles') { renderCycleSubview(); return; }
    $('#wb-plan-subview').innerHTML = planSectionHtml();
    bindPlanActions();
  }
  function renderCycleSubview() {
    var active = activeCycle();
    var generating = state.cycles.filter(function (item) { return item.status === 'generating'; })[0] || null;
    var failed = state.cycles.filter(function (item) { return item.status === 'failed'; })[0] || null;
    var form = state.cycleForm || {};
    var head = '<div class="wb-card"><div class="wb-card-head"><div><h3>周期计划</h3><p>一次排好几天的选题节奏：每天发什么、讲什么、为什么这么排；确认后可以逐槽开始创作。</p></div></div>' +
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
    $('#wb-plan-subview').innerHTML = head + current + activeHtml;
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
            await loadVideoData(true);
            if (result.work && result.work.id) openVideoFocus('work', result.work.id, 2);
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

  var VIDEO_STEPS = [
    { key: 'brief', label: '选题与参考', desc: '目标、模式和参考内容' },
    { key: 'script', label: '编导稿与分镜', desc: '口播、分镜和逐镜修改' },
    { key: 'render', label: '确认与渲染', desc: '核对素材与参数，再提交' },
    { key: 'output', label: '包装与发布', desc: '字幕、封面、标题和发布包' },
  ];
  var TALKING_HEAD_STEPS = [
    { key: 'brief', label: '口播与出镜', desc: '文案、音色和形象照' },
    { key: 'script', label: '口播稿与分段', desc: '检查分段、时长和费用' },
    { key: 'render', label: '确认与合成', desc: '核对音色、形象与费用' },
    { key: 'output', label: '包装与发布', desc: '字幕、封面、标题和发布包' },
  ];
  function videoStepsFor(item) {
    return item && item.productionMode === 'talking_head' ? TALKING_HEAD_STEPS : VIDEO_STEPS;
  }

  function wbWorkStatusText(value) { return WB_WORK_STATUS[value] || value || '—'; }
  function videoFocusItem() {
    var focus = state.videoFocus;
    if (!focus) return null;
    if (focus.kind === 'work') return state.videoWorks.filter(function (item) { return item.id === focus.id; })[0] || null;
    if (focus.kind === 'draft') return state.videoDrafts.filter(function (item) { return item.id === focus.id; })[0] || null;
    return null;
  }
  function videoFocusWork() {
    var focus = state.videoFocus;
    return focus && focus.kind === 'work' ? videoFocusItem() : null;
  }
  function videoStepForWork(work) {
    if (!work) return 1;
    var hostedReady = Boolean(work.autoHost && work.autoHost.enabled && work.autoHost.stage === 'awaiting_confirmation');
    if (work.productionMode === 'talking_head') {
      if (work.status === 'succeeded') return 4;
      if (work.status === 'rendering' || work.status === 'failed') return 3;
      return hostedReady ? 3 : 2;
    }
    if (work.status === 'planning') return 2;
    if (work.status === 'rendering' || work.status === 'succeeded') return 4;
    if (work.status === 'failed') return work.directorScript && (work.directorScript.shots || []).length ? 4 : 2;
    return hostedReady ? 3 : 2;
  }
  /** 托管状态横幅：总是明确告诉用户现在免费/已提交/已打包，避免误以为自动扣费。 */
  function hostedBannerHtml(work) {
    var host = (work && work.autoHost) || {};
    if (!host.enabled) return '';
    var stage = host.stage || 'preparing';
    var text = '';
    if (stage === 'preparing') text = '托管正在跑免费步骤：写稿、校验音色形象、算分段和费用。';
    else if (stage === 'awaiting_confirmation') text = '托管已跑完免费步骤：' + (work.productionMode === 'talking_head' ? '口播稿、分段和费用' : '编导稿和渲染参数') + '已准备。确认后才会提交' + (work.productionMode === 'talking_head' ? '数字人合成' : '视频渲染') + '并计费。';
    else if (stage === 'submitted') text = '托管已提交付费步骤，完成后会自动生成发布包。';
    else if (stage === 'packaging') text = '成片已完成，托管正在自动生成字幕、封面和发布包。';
    else if (stage === 'ready') text = '托管已完成：发布包已生成，可以直接下载。';
    else if (stage === 'failed') text = '托管中断：' + (host.error || work.error || '请检查后重试') + '。';
    if (!text) return '';
    return '<div class="wb-host-banner' + (stage === 'failed' ? ' warn' : '') + '">' + ic('sparkle', 13) +
      '<div><b>一键托管</b><p>' + esc(text) + '</p></div></div>';
  }

  function videoStepAvailable(item, step) {
    if (!item) return false;
    if (state.videoFocus && state.videoFocus.kind === 'draft') return step === 1;
    if (item.productionMode === 'talking_head') {
      if (step === 1 || step === 2) return true;
      if (step === 3) return item.status !== 'planning';
      if (step === 4) return item.status === 'succeeded';
      return false;
    }
    if (step === 1 || step === 2) return true;
    if (step === 3) return item.status !== 'planning';
    if (step === 4) return ['rendering', 'succeeded', 'failed'].indexOf(item.status) >= 0;
    return false;
  }
  function videoStepProgress(work) {
    if (!work) return 25;
    if (work.status === 'succeeded') return 100;
    if (work.status === 'rendering') return 75;
    if (work.status === 'planning') return 50;
    if (work.status === 'draft') return 50;
    if (work.status === 'failed') return work.productionMode === 'talking_head' ? 75 : ((work.directorScript && (work.directorScript.shots || []).length) ? 75 : 50);
    return 25;
  }
  function videoStepLabel(step, item) {
    var rows = videoStepsFor(item);
    var row = rows[Number(step) - 1] || rows[0];
    return row.label;
  }
  function videoDraftTitle(draft) {
    return (draft && (draft.brief || '').trim().slice(0, 36)) || '新视频任务';
  }
  function videoWorkTitle(work) {
    return (work && work.title || '').trim() || '未命名视频任务';
  }
  function openVideoFocus(kind, id, step) {
    if (!kind || !id) return;
    if (state.tab !== 'video') setTab('video');
    stopVideoPackagePolling();
    if (kind === 'work') delete state.videoPackages[id];
    state.videoFocus = { kind: kind, id: id };
    if (kind === 'work') {
      var work = state.videoWorks.filter(function (item) { return item.id === id; })[0] || null;
      state.videoStep = step || videoStepForWork(work);
    } else {
      state.videoStep = 1;
    }
    renderTopbar();
    renderVideo();
    syncVideoChrome();
  }
  function closeVideoFocus() {
    state.videoFocus = null;
    state.videoStep = 1;
    state.videoShotEditing = null;
    stopVideoPackagePolling();
    renderTopbar();
    if (state.tab === 'video') renderVideo();
    syncVideoChrome();
  }
  function syncVideoChrome() {
    var active = state.tab === 'video' && Boolean(state.videoFocus);
    var wb = $('.wb');
    var aside = $('#wb-flow-side');
    if (wb) wb.classList.toggle('focus', active);
    if (aside) aside.hidden = !active;
    if (active) renderVideoFlowAside();
    if (state.tab !== 'video') return;
    var item = videoFocusItem();
    var crumb = $('#wb-crumb');
    var sub = $('#wb-title-sub');
    if (active && item) {
      if (crumb) crumb.textContent = '视频创作 / ' + (state.videoFocus.kind === 'draft' ? videoDraftTitle(item) : videoWorkTitle(item));
      if (sub) sub.textContent = '第 ' + state.videoStep + '/4 步 · ' + videoStepLabel(state.videoStep, item);
    } else {
      if (crumb) crumb.textContent = TAB_META.video.label;
      if (sub) sub.textContent = TAB_META.video.sub;
    }
  }
  function renderVideoFlowAside() {
    var stepsBox = $('#wb-flow-steps');
    var foot = $('#wb-flow-side-foot');
    var sub = $('#wb-flow-side-sub');
    if (!stepsBox || !foot) return;
    var item = videoFocusItem();
    if (!item) {
      stepsBox.innerHTML = '';
      foot.innerHTML = '';
      if (sub) sub.textContent = '选择一个任务后开始制作';
      return;
    }
    var isDraft = state.videoFocus.kind === 'draft';
    var work = isDraft ? null : item;
    var talking = Boolean(item.productionMode === 'talking_head');
    if (sub) sub.textContent = isDraft ? videoDraftTitle(item) : videoWorkTitle(item);
    stepsBox.innerHTML = videoStepsFor(item).map(function (row, index) {
      var step = index + 1;
      var available = videoStepAvailable(item, step);
      var done = step < state.videoStep || Boolean(work && work.status === 'succeeded' && step !== state.videoStep);
      return '<button class="wb-flow-step' + (step === state.videoStep ? ' is-current' : '') + (done ? ' done' : '') + (available ? '' : ' locked') + '" type="button" data-wb-step="' + step + '"' +
        (step === state.videoStep ? ' aria-current="step"' : '') +
        (available ? '' : ' aria-disabled="true"') + '>' +
        '<span class="num">' + (done ? '✓' : step) + '</span>' +
        '<span><span class="label">' + esc(row.label) + '</span><span class="desc">' + esc(row.desc) + '</span></span></button>';
    }).join('');
    $$('[data-wb-step]').forEach(function (button) {
      button.onclick = function () {
        var step = Number(button.dataset.wbStep);
        if (!videoStepAvailable(item, step)) {
          toast(step === 4 ? (talking ? '口播合成完成后，这里才能包装发布。' : '完成编导稿并确认渲染后，这里会出现成片。') : '先完成前面的步骤。', 'error');
          return;
        }
        state.videoStep = step;
        renderVideo();
        syncVideoChrome();
        renderTopbar();
      };
    });
    var status = isDraft ? '待配置' : wbWorkStatusText(item.status);
    var hint = isDraft
      ? (talking ? '写清口播文案，选好音色和形象照，再核对分段。' : '先写清目标、模式和参考，再生成编导稿。')
      : talking
        ? (item.status === 'draft' ? '先核对口播分段，再确认合成；这一步不扣费。'
          : item.status === 'planning' ? '正在准备口播稿。'
            : item.status === 'failed' ? '口播合成失败了，原因会显示在当前步骤。'
              : item.status === 'succeeded' ? '口播成片已完成，可以包装发布了。'
                : '正在分段合成口播，完成后自动进入第 4 步。')
        : item.status === 'planning' ? '正在写编导稿，完成后可在第 2 步修改。'
          : item.status === 'failed' ? '这一步失败了，原因会显示在当前步骤。'
            : item.status === 'succeeded' ? '成片已完成，可以预览和下载。'
              : item.status === 'rendering' ? '正在渲染，完成后自动出现在第 4 步。'
                : '核对编导稿和费用后再提交渲染。';
    foot.innerHTML = '<b>' + esc(status) + '</b><span>' + esc(hint) + '</span>';
  }
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
      state.videoDrafts = Array.isArray(rows) ? rows.map(function (row) {
        return Object.assign({ productionMode: 'storyboard', speech: '', voiceId: '', imageAssetId: '', speed: 'natural', autoHost: false, topic: '' }, row);
      }) : [];
    } catch (e) { state.videoDrafts = []; }
  }
  function saveVideoDrafts() {
    try { localStorage.setItem(videoDraftKey(), JSON.stringify(state.videoDrafts.slice(-8))); } catch (e) { /* 隐私模式忽略 */ }
  }
  function newVideoDraft(mode, productionMode, options) {
    var draft = {
      id: 'draft-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), mode: mode, status: 'configuring',
      productionMode: productionMode || 'storyboard',
      autoHost: Boolean(options && options.autoHost), topic: '',
      type: 'ecommerce', subtype: '口播带货', hookStrategy: 'auto', model: '', durationSeconds: 15,
      resolution: '768P', ratio: '9:16', brief: '', assetRefs: [], reference: '', sourceKind: 'text',
      sourceId: '', speech: '', voiceId: '', imageAssetId: '', speed: 'natural',
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
      call('/voices').catch(function () { return { items: [] }; }),
    ]);
    if (state.accountId !== accountId) return;
    var previousWorks = state.videoWorks;
    state.videoWorks = results[0].items || [];
    state.videoQueue = results[1].items || [];
    state.voiceSamples = results[2].items || [];
    state.voices = results[3].items || state.voices;
    var bucket = {};
    state.videoQueue.forEach(function (item) { if (item.workId) { (bucket[item.workId] = bucket[item.workId] || []).push(item); } });
    state.workRenders = bucket;
    maybeAdvanceHostedFocus(previousWorks);
    if (state.tab === 'video' && !state.videoShotEditing) { renderVideo(); hydrateWorkVideos(); }
    startVideoWorkPolling();
  }
  async function loadVideoWorks() {
    var results = await Promise.all([
      call('/video/works?accountId=' + encodeURIComponent(state.accountId)).catch(function () { return { items: [] }; }),
      call('/video/renders').catch(function () { return { items: [] }; }),
    ]);
    var previousWorks = state.videoWorks;
    state.videoWorks = results[0].items || [];
    state.videoQueue = results[1].items || [];
    var bucket = {};
    state.videoQueue.forEach(function (item) { if (item.workId) { (bucket[item.workId] = bucket[item.workId] || []).push(item); } });
    state.workRenders = bucket;
    maybeAdvanceHostedFocus(previousWorks);
    if (state.tab === 'video' && !state.videoShotEditing) { renderVideo(); hydrateWorkVideos(); }
    startVideoWorkPolling();
  }
  /** 托管免费步骤刚完成/成片刚完成时，自动把用户带到确认页或包装页；只推进一次。 */
  function maybeAdvanceHostedFocus(previousWorks) {
    if (state.tab !== 'video' || !state.videoFocus || state.videoFocus.kind !== 'work') return;
    var workId = state.videoFocus.id;
    var prev = (previousWorks || []).filter(function (item) { return item.id === workId; })[0] || null;
    var next = state.videoWorks.filter(function (item) { return item.id === workId; })[0] || null;
    if (!next || !next.autoHost || !next.autoHost.enabled) return;
    var key = workId + ':' + String(next.autoHost.stage || '');
    if (state.hostedAutoAdvanced[key]) return;
    if (prev && prev.status === 'planning' && next.status === 'draft' && state.videoStep < 3) {
      state.hostedAutoAdvanced[key] = true;
      state.videoStep = 3;
      toast('托管已准备好文案、分段和费用；确认后才会提交并计费', 'success');
    } else if (prev && prev.status === 'rendering' && next.status === 'succeeded' && state.videoStep === 3) {
      state.hostedAutoAdvanced[key] = true;
      state.videoStep = 4;
      toast('成片已完成，托管正在自动生成发布包', 'success');
    }
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
  async function hydratePackageMedia() {
    var images = $$('[data-pkg-cover]');
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      var coverId = img.dataset.pkgCover;
      if (!coverId || img.dataset.loaded) continue;
      img.dataset.loaded = '1';
      if (state.packageMediaUrls[coverId]) { img.src = state.packageMediaUrls[coverId]; continue; }
      try {
        var coverBlob = await fetchBlob(API + '/assets/' + encodeURIComponent(coverId) + '/file');
        var coverUrl = URL.createObjectURL(coverBlob);
        state.packageMediaUrls[coverId] = coverUrl;
        img.src = coverUrl;
      } catch (e) { /* 封面加载失败保留占位 */ }
    }
    var videos = $$('[data-pkg-video]');
    for (var j = 0; j < videos.length; j++) {
      var video = videos[j];
      var videoId = video.dataset.pkgVideo;
      if (!videoId || video.dataset.loaded) continue;
      video.dataset.loaded = '1';
      if (state.packageMediaUrls[videoId]) { video.src = state.packageMediaUrls[videoId]; continue; }
      try {
        var videoBlob = await fetchBlob(API + '/assets/' + encodeURIComponent(videoId) + '/file');
        var videoUrl = URL.createObjectURL(videoBlob);
        state.packageMediaUrls[videoId] = videoUrl;
        video.src = videoUrl;
      } catch (e) { /* 包装视频加载失败保留外壳 */ }
    }
  }
  async function hydrateShotFrames() {
    var frames = $$('[data-shot-frame]');
    for (var i = 0; i < frames.length; i++) {
      var img = frames[i];
      var assetId = img.dataset.shotFrame;
      if (!assetId || img.dataset.loaded) continue;
      img.dataset.loaded = '1';
      if (state.shotFrameUrls[assetId]) { img.src = state.shotFrameUrls[assetId]; continue; }
      try {
        var blob = await fetchBlob(API + '/assets/' + encodeURIComponent(assetId) + '/file');
        var url = URL.createObjectURL(blob);
        state.shotFrameUrls[assetId] = url;
        img.src = url;
      } catch (e) { /* 原帧加载失败保留占位 */ }
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
  function scheduleVideoEstimates() {
    if (state.videoEstimateTimer) clearTimeout(state.videoEstimateTimer);
    state.videoEstimateTimer = setTimeout(function () { void refreshVideoEstimates(); }, 300);
  }
  async function refreshVideoEstimates() {
    var nodes = $$('[data-wb-v-estimate]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var draft = findVideoDraft(node.dataset.wbVEstimate);
      if (!draft) continue;
      try {
        var result = await call('/estimate/video', {
          method: 'POST',
          body: { durationSeconds: draft.durationSeconds, resolution: draft.resolution, audio: true },
        });
        var estimate = result.estimate || {};
        var items = (estimate.items || []).map(function (item) {
          return '<span>' + esc(item.label) + '：约 ' + (Number(item.fen || 0) / 100).toFixed(2) + ' 元</span>';
        }).join('');
        var range = estimate.minFen === estimate.maxFen
          ? (Number(estimate.totalFen || 0) / 100).toFixed(2) + ' 元'
          : (Number(estimate.minFen || 0) / 100).toFixed(2) + '–' + (Number(estimate.maxFen || 0) / 100).toFixed(2) + ' 元';
        node.innerHTML = '<span class="wb-note">' + ic('bulb', 11) + ' 本次渲染预估 <b>' + range + '</b>（' + esc(draft.durationSeconds) + ' 秒 · ' + esc(draft.resolution) + '）；编导稿阶段不扣费。</span>' +
          '<details class="wb-avatar-estimate-items"><summary>费用明细与口径</summary>' + (items || '') + '<span>' + esc(estimate.note || '') + '</span></details>';
      } catch (error) {
        node.innerHTML = '<span class="wb-muted">暂时估不出价格：' + esc(error.message || '渠道未配置') + '；提交后以上游实际扣费为准。</span>';
      }
    }
  }
  async function refreshWorkEstimates() {
    var nodes = $$('[data-wb-v-work-estimate]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var work = state.videoWorks.filter(function (item) { return item.id === node.dataset.wbVWorkEstimate; })[0];
      if (!work || (work.status !== 'draft' && work.status !== 'failed')) continue;
      if (work.productionMode === 'talking_head') {
        var th = work.talkingHead || {};
        if (!th.text) continue;
        try {
          var thEstimate = await estimateTalkingHead(th.text, th.speed);
          var thPlan = thEstimate.plan || {};
          var thRange = thEstimate.minFen === thEstimate.maxFen
            ? (Number(thEstimate.totalFen || 0) / 100).toFixed(2) + ' 元'
            : (Number(thEstimate.minFen || 0) / 100).toFixed(2) + '–' + (Number(thEstimate.maxFen || 0) / 100).toFixed(2) + ' 元';
          node.innerHTML = '<span class="wb-note">' + ic('bulb', 11) + ' 口播合成预估 <b>' + thRange + '</b>（预计 ' + esc(thPlan.targetDuration || 0) + ' 秒 · ' + esc(thPlan.batchCount || 1) + ' 段）</span>' +
            '<details class="wb-avatar-estimate-items"><summary>口径</summary><span>' + esc(thEstimate.note || '') + '</span></details>';
        } catch (error) {
          node.innerHTML = '<span class="wb-muted">暂时估不出价格：' + esc(error.message || '渠道未配置') + '</span>';
        }
        continue;
      }
      try {
        var result = await call('/estimate/video', {
          method: 'POST',
          body: { durationSeconds: work.durationSeconds, resolution: work.resolution || '768P', audio: true },
        });
        var estimate = result.estimate || {};
        var range = estimate.minFen === estimate.maxFen
          ? (Number(estimate.totalFen || 0) / 100).toFixed(2) + ' 元'
          : (Number(estimate.minFen || 0) / 100).toFixed(2) + '–' + (Number(estimate.maxFen || 0) / 100).toFixed(2) + ' 元';
        node.innerHTML = '<span class="wb-note">' + ic('bulb', 11) + ' 确认渲染前预估 <b>' + range + '</b>（' + esc(work.durationSeconds) + ' 秒 · ' + esc(work.resolution || '768P') + '）</span>' +
          '<details class="wb-avatar-estimate-items"><summary>口径</summary><span>' + esc(estimate.note || '') + '</span></details>';
      } catch (error) {
        node.innerHTML = '<span class="wb-muted">暂时估不出价格：' + esc(error.message || '渠道未配置') + '</span>';
      }
    }
  }
  /* ── 二十期 · 口播成片简易模式（复用数字人链路，隐藏分镜） ── */
  function talkingHeadSpeeds() {
    return [
      ['natural', '自然 · 约50字/10秒'],
      ['slightly_fast', '稍快 · 约60字/10秒'],
      ['fast', '较快 · 约75字/10秒'],
      ['extreme', '极快 · 约90字/10秒'],
    ];
  }
  function videoReadyVoices() {
    return (state.voices || []).filter(function (item) { return item.status === 'ready'; });
  }
  function videoImageAssets() {
    return (state.assets || []).filter(function (item) { return item.kind === 'image'; });
  }
  function talkingHeadSegmentsHtml(plan) {
    var segments = (plan && plan.segments) || [];
    if (!segments.length) return '<p class="wb-muted">填入口播文案后，这里会按标点和语速预览分段。</p>';
    var cps = Number(plan.charsPerSecond || 5);
    return '<div class="wb-th-segments">' + segments.map(function (text, index) {
      var chars = String(text || '').replace(/\s/g, '').length;
      var seconds = cps > 0 ? chars / cps : 0;
      return '<div class="wb-th-segment"><b>第 ' + (index + 1) + ' 段</b><span>约 ' + seconds.toFixed(1) + ' 秒</span><p>' + esc(text) + '</p></div>';
    }).join('') + '</div>';
  }
  function talkingHeadEstimateHtml(estimate, plan, label) {
    var items = (estimate.items || []).map(function (item) {
      return '<span>' + esc(item.label) + '：约 ' + (Number(item.fen || 0) / 100).toFixed(2) + ' 元</span>';
    }).join('');
    var range = estimate.minFen === estimate.maxFen
      ? (Number(estimate.totalFen || 0) / 100).toFixed(2) + ' 元'
      : (Number(estimate.minFen || 0) / 100).toFixed(2) + '–' + (Number(estimate.maxFen || 0) / 100).toFixed(2) + ' 元';
    return '<div class="wb-avatar-estimate-head"><b>预计 ' + esc(plan.targetDuration || 0) + ' 秒 · ' + esc(plan.batchCount || 1) + ' 段</b>' +
      '<span class="wb-tag">' + esc(label || '预估') + ' ' + range + '</span></div>' +
      (plan.overLimit ? '<p class="err">超过单次 ' + esc(plan.maxSegments || 30) + ' 段上限，请拆成多条或缩短文案。</p>' : '') +
      '<p class="wb-note">' + esc(estimate.note || '') + '</p>' +
      (items ? '<details class="wb-avatar-estimate-items"><summary>费用明细与口径</summary>' + items + '</details>' : '');
  }
  async function estimateTalkingHead(text, speed) {
    var result = await call('/estimate/avatar', { method: 'POST', body: { text: text, speed: speed || 'natural' } });
    return result.estimate || {};
  }
  function scheduleTalkingHeadDraftEstimate(draftId) {
    if (state.videoTalkingHeadTimer) clearTimeout(state.videoTalkingHeadTimer);
    state.videoTalkingHeadTimer = setTimeout(function () {
      void updateTalkingHeadDraftEstimate(draftId);
    }, 350);
  }
  async function updateTalkingHeadDraftEstimate(draftId) {
    var draft = findVideoDraft(draftId);
    var node = $('[data-wb-th-draft-estimate="' + draftId + '"]');
    if (!draft || !node) return;
    var speech = String(draft.speech || '').trim();
    if (!speech) {
      node.innerHTML = '<span class="wb-muted">填入口播文案后，这里会显示预计时长、分段数和参考费用。</span>';
      return;
    }
    node.innerHTML = '<span class="wb-muted">' + ic('loader', 11) + ' 正在按语速估算…</span>';
    try {
      var estimate = await estimateTalkingHead(speech, draft.speed);
      if (!findVideoDraft(draftId)) return;
      node.innerHTML = talkingHeadEstimateHtml(estimate, estimate.plan || {}, '预估');
    } catch (error) {
      node.innerHTML = '<span class="wb-muted">暂时估不出价格：' + esc(error.message || '渠道未配置') + '；确认合成时以上游实际扣费为准。</span>';
    }
  }
  function refreshTalkingHeadDraftEstimates() {
    $$('[data-wb-th-draft-estimate]').forEach(function (node) {
      void updateTalkingHeadDraftEstimate(node.dataset.wbThDraftEstimate);
    });
  }
  function refreshTalkingHeadWorkEstimates() {
    $$('[data-wb-th-work-estimate]').forEach(function (node) {
      var work = state.videoWorks.filter(function (item) { return item.id === node.dataset.wbThWorkEstimate; })[0];
      var th = (work && work.talkingHead) || {};
      if (work && th.text) void updateTalkingHeadWorkEstimate(work.id, th.text, th.speed);
    });
  }
  function scheduleTalkingHeadWorkEstimate(workId, text, speed) {
    if (state.videoTalkingHeadTimer) clearTimeout(state.videoTalkingHeadTimer);
    state.videoTalkingHeadTimer = setTimeout(function () {
      void updateTalkingHeadWorkEstimate(workId, text, speed);
    }, 350);
  }
  async function updateTalkingHeadWorkEstimate(workId, text, speed) {
    var node = $('[data-wb-th-work-estimate="' + workId + '"]');
    var segmentsNode = $('[data-wb-th-segments="' + workId + '"]');
    if (!node) return;
    if (!String(text || '').trim()) {
      node.innerHTML = '<span class="wb-muted">填入口播文案后显示预计时长和费用。</span>';
      if (segmentsNode) segmentsNode.innerHTML = '<p class="wb-muted">还没有分段。</p>';
      return;
    }
    node.innerHTML = '<span class="wb-muted">' + ic('loader', 11) + ' 正在按语速估算…</span>';
    try {
      var estimate = await estimateTalkingHead(text, speed);
      var plan = estimate.plan || {};
      node.innerHTML = talkingHeadEstimateHtml(estimate, plan, '确认前预估');
      if (segmentsNode) segmentsNode.innerHTML = talkingHeadSegmentsHtml(plan);
    } catch (error) {
      node.innerHTML = '<span class="wb-muted">暂时估不出价格：' + esc(error.message || '渠道未配置') + '</span>';
    }
  }
  function talkingHeadVoiceOptions(selected) {
    var voices = videoReadyVoices();
    return voices.length ? voices.map(function (voice) {
      return '<option value="' + esc(voice.id) + '"' + (selected === voice.id ? ' selected' : '') + '>' + esc(voice.name || '我的音色') +
        (voice.mode === 'reference' ? '（参考直出）' : '') + '</option>';
    }).join('') : '<option value="">（先克隆一个音色）</option>';
  }
  function talkingHeadImageOptions(selected) {
    var images = videoImageAssets();
    return images.length ? images.slice(0, 50).map(function (asset) {
      return '<option value="' + esc(asset.id) + '"' + (selected === asset.id ? ' selected' : '') + '>' + esc(asset.fileName || '形象照') + '</option>';
    }).join('') : '<option value="">（素材库里还没有图片）</option>';
  }
  function renderTalkingHeadDraftCard(draft, options) {
    var focus = Boolean(options && options.focus);
    var voices = videoReadyVoices();
    var images = videoImageAssets();
    if (!voices.some(function (item) { return item.id === draft.voiceId; })) draft.voiceId = voices[0] ? voices[0].id : '';
    if (!images.some(function (item) { return item.id === draft.imageAssetId; })) draft.imageAssetId = images[0] ? images[0].id : '';
    saveVideoDrafts();
    var missing = !voices.length || !images.length;
    var typeSummary = (wbTypeMeta(draft.type).label || '内容方向') + ' · ' + (draft.subtype || '未选细分');
    var types = '<details class="wb-v-advanced"' + (state.videoAdvancedOpen ? ' open' : '') + '><summary><span>内容方向（可选，影响标签建议）</span><small>' + esc(typeSummary) + '</small></summary>' +
      '<div class="wb-form" style="margin-top:8px">' +
      '<div class="wb-field full"><span>内容方向</span><div class="wb-chips">' + wbTypeTabs(draft) + '</div></div>' +
      '<div class="wb-field full"><span>细分方向</span><div class="wb-chips">' + wbSubtypeChips(draft) + '</div></div>' +
      '</div></details>';
    var readiness = '';
    if (!voices.length) readiness += '<p class="wb-note">还没有可用音色。可以先克隆一段 10–30 秒人声；上游克隆不可用时会自动降级为参考音频直出。</p>';
    if (!images.length) readiness += '<p class="wb-note">素材库里还没有图片。上传一张正面、人脸清晰的形象照就能用。</p>';
    return '<article class="wb-card wb-v-config" data-wb-v-draft-card="' + esc(draft.id) + '">' +
      '<div class="wb-card-head"><div><span class="wb-step-kicker">第 1 步 · 口播与出镜</span><h3>口播成片 · 新任务</h3><p>不用写分镜：把口播稿粘进来，选音色和形象照，系统会按语速自动分段、逐段对口型，最后拼成一条完整视频。</p></div>' +
      '<button class="btn" type="button" data-wb-v-draft="discard" data-id="' + esc(draft.id) + '">取消</button></div>' +
      '<label class="wb-field full"><span>口播文案（会自动分段，不用自己切）</span><textarea data-wb-v-field="speech" data-draft="' + esc(draft.id) + '" maxlength="3000" rows="7" placeholder="把要口播的完整文案粘进来，例如：暑期班报名开始了，前 20 名送两节体验课…">' + esc(draft.speech || '') + '</textarea></label>' +
      '<div class="wb-form">' +
      '<label class="wb-field"><span>音色</span><select data-wb-v-field="voiceId" data-draft="' + esc(draft.id) + '">' + talkingHeadVoiceOptions(draft.voiceId) + '</select></label>' +
      '<label class="wb-field"><span>形象照（正面人脸清晰）</span><select data-wb-v-field="imageAssetId" data-draft="' + esc(draft.id) + '">' + talkingHeadImageOptions(draft.imageAssetId) + '</select></label>' +
      '<label class="wb-field"><span>语速</span><select data-wb-v-field="speed" data-draft="' + esc(draft.id) + '">' + talkingHeadSpeeds().map(function (row) {
        return '<option value="' + row[0] + '"' + (draft.speed === row[0] ? ' selected' : '') + '>' + row[1] + '</option>';
      }).join('') + '</select></label>' +
      '</div>' + readiness + types +
      '<div class="wb-field full wb-v-estimate" data-wb-th-draft-estimate="' + esc(draft.id) + '"><span class="wb-muted">填入口播文案后显示预计时长和费用。</span></div>' +
      '<div class="wb-field full wb-actions">' +
      '<button class="btn primary" type="button" data-wb-v-action="start" data-id="' + esc(draft.id) + '"' + (missing ? ' disabled' : '') + '>' + ic('video', 13) + '生成口播稿 →</button>' +
      '<button class="btn" type="button" data-th-clone-voice>克隆新音色</button>' +
      '<button class="btn" type="button" data-th-refresh-voices>刷新音色</button>' +
      '<button class="btn" type="button" data-th-goto-assets>去素材库上传形象照</button>' +
      '<span class="wb-note">这一步不扣费；下一步核对分段和费用后才开始合成。</span></div></article>';
  }

  /** 二十一期 · 一键托管：只写主题，免费步骤自动跑完并停在确认页。 */
  function renderHostedDraftCard(draft) {
    var talking = draft.productionMode === 'talking_head';
    var voices = videoReadyVoices();
    var images = videoImageAssets();
    if (talking) {
      if (!voices.some(function (item) { return item.id === draft.voiceId; })) draft.voiceId = voices[0] ? voices[0].id : '';
      if (!images.some(function (item) { return item.id === draft.imageAssetId; })) draft.imageAssetId = images[0] ? images[0].id : '';
      saveVideoDrafts();
    }
    var missing = talking && (!voices.length || !images.length);
    var typeSummary = (wbTypeMeta(draft.type).label || '内容方向') + ' · ' + (draft.subtype || '未选细分');
    var modeChips = '<div class="wb-chips">' +
      '<button type="button" class="chip' + (talking ? ' on' : '') + '" data-wb-v-choice="productionMode" data-draft="' + esc(draft.id) + '" data-value="talking_head">' + ic('video', 11) + '口播成片</button>' +
      '<button type="button" class="chip' + (!talking ? ' on' : '') + '" data-wb-v-choice="productionMode" data-draft="' + esc(draft.id) + '" data-value="storyboard">' + ic('sparkle', 11) + '分镜成片</button>' +
      '</div>';
    var assetFields = talking
      ? '<div class="wb-form">' +
        '<label class="wb-field"><span>音色</span><select data-wb-v-field="voiceId" data-draft="' + esc(draft.id) + '">' + talkingHeadVoiceOptions(draft.voiceId) + '</select></label>' +
        '<label class="wb-field"><span>形象照（正面人脸清晰）</span><select data-wb-v-field="imageAssetId" data-draft="' + esc(draft.id) + '">' + talkingHeadImageOptions(draft.imageAssetId) + '</select></label>' +
        '<label class="wb-field"><span>语速</span><select data-wb-v-field="speed" data-draft="' + esc(draft.id) + '">' + talkingHeadSpeeds().map(function (row) {
          return '<option value="' + row[0] + '"' + (draft.speed === row[0] ? ' selected' : '') + '>' + row[1] + '</option>';
        }).join('') + '</select></label></div>'
      : '<div class="wb-form">' +
        '<label class="wb-field"><span>目标时长</span><select data-wb-v-field="durationSeconds" data-draft="' + esc(draft.id) + '">' +
        [10, 15, 30, 45, 60].map(function (n) { return '<option value="' + n + '"' + (Number(draft.durationSeconds) === n ? ' selected' : '') + '>' + n + ' 秒</option>'; }).join('') +
        '</select></label>' +
        '<label class="wb-field"><span>清晰度</span><select data-wb-v-field="resolution" data-draft="' + esc(draft.id) + '">' +
        [['480P', '480P（更快）'], ['768P', '768P（推荐）'], ['1080P', '1080P（更清晰）']].map(function (row) {
          return '<option value="' + row[0] + '"' + (draft.resolution === row[0] ? ' selected' : '') + '>' + row[1] + '</option>';
        }).join('') + '</select></label></div>';
    var readiness = '';
    if (talking && !voices.length) readiness += '<p class="wb-note">还没有可用音色。先克隆一段 10–30 秒人声；上游克隆不可用时会自动降级为参考音频直出。</p>';
    if (talking && !images.length) readiness += '<p class="wb-note">素材库里还没有图片。上传一张正面、人脸清晰的形象照就能用。</p>';
    var types = '<details class="wb-v-advanced"' + (state.videoAdvancedOpen ? ' open' : '') + '><summary><span>内容方向（可选，影响写稿口径）</span><small>' + esc(typeSummary) + '</small></summary>' +
      '<div class="wb-form" style="margin-top:8px">' +
      '<div class="wb-field full"><span>内容方向</span><div class="wb-chips">' + wbTypeTabs(draft) + '</div></div>' +
      '<div class="wb-field full"><span>细分方向</span><div class="wb-chips">' + wbSubtypeChips(draft) + '</div></div>' +
      '</div></details>';
    return '<article class="wb-card wb-v-config wb-host-config" data-wb-v-draft-card="' + esc(draft.id) + '">' +
      '<div class="wb-card-head"><div><span class="wb-step-kicker">一键托管 · 自动准备</span><h3>' + (talking ? '口播成片' : '分镜成片') + ' · 托管新任务</h3>' +
      '<p>只写一个主题：托管会自动写' + (talking ? '口播稿' : '编导稿') + '、选音色和形象照、算分段和费用，然后停在确认页。确认之前不会提交渲染或数字人合成，也不会计费。</p></div>' +
      '<button class="btn" type="button" data-wb-v-draft="discard" data-id="' + esc(draft.id) + '">取消</button></div>' +
      '<div class="wb-field full"><span>制作方式</span>' + modeChips + '</div>' +
      '<label class="wb-field full"><span>这次想讲什么（主题、卖点、家长痛点都可以）</span><textarea data-wb-v-field="topic" data-draft="' + esc(draft.id) + '" maxlength="500" rows="4" placeholder="例如：暑假班体验课怎么跟家长讲清楚；主打美术课，家长总说课程贵">' + esc(draft.topic || '') + '</textarea></label>' +
      assetFields + readiness + types +
      '<div class="wb-field full wb-actions" style="margin-top:10px">' +
      '<button class="btn primary" type="button" data-wb-v-action="start" data-id="' + esc(draft.id) + '"' + (missing ? ' disabled' : '') + '>' + ic('sparkle', 13) + '开始托管 →</button>' +
      '<button class="btn" type="button" data-th-clone-voice data-draft="' + esc(draft.id) + '">克隆新音色</button>' +
      '<button class="btn" type="button" data-th-refresh-voices data-draft="' + esc(draft.id) + '">刷新音色</button>' +
      '<button class="btn" type="button" data-th-goto-assets data-draft="' + esc(draft.id) + '">去素材库上传形象照</button>' +
      '<span class="wb-note">免费步骤跑完会自动跳到确认页；只有一次付费确认。</span></div></article>';
  }

  function renderVideoDraftCard(draft, options) {
    var focus = Boolean(options && options.focus);
    var head = '<div class="wb-card-head"><div><span class="wb-step-kicker">第 1 步 · 选题与参考</span><h3>' + esc(WB_VIDEO_MODES[draft.mode] || '生成') + '模式 · 新任务</h3><p>先写想做什么；内容方向、开场方式和参数已按账号预选，展开「高级设置」可改。</p></div>' +
      '<button class="btn" type="button" data-wb-v-draft="discard" data-id="' + esc(draft.id) + '">取消</button></div>';
    var typeSummary = (wbTypeMeta(draft.type).label || '内容方向') + ' · ' + (draft.subtype || '未选细分') + ' · ' + wbHookLabel(draft.hookStrategy);
    var types = '<details class="wb-v-advanced"' + (state.videoAdvancedOpen ? ' open' : '') + '><summary><span>高级设置</span><small>' + esc(typeSummary) + '</small></summary>' +
      '<div class="wb-form" style="margin-top:8px">' +
      '<div class="wb-field full"><span>内容方向</span><div class="wb-chips">' + wbTypeTabs(draft) + '</div></div>' +
      '<div class="wb-field full"><span>细分方向</span><div class="wb-chips">' + wbSubtypeChips(draft) + '</div></div>' +
      '<div class="wb-field full"><span>开场方式（只控制前段切入）</span><div class="wb-chips">' + wbHookChips(draft) + '</div></div>' +
      '</div></details>';
    var body = '';
    if (draft.mode === 'generate') {
      body = head +
        '<label class="wb-field full"><span>想做什么（卖点、人物、台词、画面要求）</span><textarea data-wb-v-field="brief" data-draft="' + esc(draft.id) + '" placeholder="例如：主打美术体验课，妈妈带孩子出镜，结尾引导评论区领体验名额">' + esc(draft.brief || '') + '</textarea></label>' + types;
    } else if (draft.mode === 'replicate') {
      var transcriptOptions = state.transcripts.map(function (item) {
        return '<option value="' + esc(item.id) + '"' + (draft.sourceId === item.id ? ' selected' : '') + '>' + esc(item.title || item.nickname || '转写档案') + '（' + esc(fmtDate(item.createdAt)) + '）</option>';
      }).join('');
      var sourceBody = draft.sourceKind === 'transcript'
        ? '<select data-wb-v-field="sourceId" data-draft="' + esc(draft.id) + '">' + (transcriptOptions || '<option value="">（还没有转写档案，先去「素材」采集或上传）</option>') + '</select>'
        : '<textarea data-wb-v-field="reference" data-draft="' + esc(draft.id) + '" placeholder="粘贴抖音分享内容/作品链接，或参考视频的口播文字与结构说明">' + esc(draft.reference || '') + '</textarea>';
      body = head +
        '<div class="wb-field full"><span>参考来源</span><div class="wb-chips">' +
        '<button type="button" class="chip' + (draft.sourceKind === 'transcript' ? ' on' : '') + '" data-wb-v-choice="sourceKind" data-draft="' + esc(draft.id) + '" data-value="transcript">转写档案</button>' +
        '<button type="button" class="chip' + (draft.sourceKind === 'text' ? ' on' : '') + '" data-wb-v-choice="sourceKind" data-draft="' + esc(draft.id) + '" data-value="text">链接 / 文字</button></div></div>' +
        '<label class="wb-field full"><span>' + (draft.sourceKind === 'transcript' ? '选择已转写的参考视频' : '参考内容') + '</span>' + sourceBody + '</label>' +
        '<label class="wb-field full"><span>补充要求（可选：要替换的产品、必须保留的内容）</span><textarea data-wb-v-field="brief" data-draft="' + esc(draft.id) + '" placeholder="把参考里的产品换成我们的体验课；开头钩子保持原样">' + esc(draft.brief || '') + '</textarea></label>' + types;
    }
    return '<article class="wb-card wb-v-config" data-wb-v-draft-card="' + esc(draft.id) + '">' + body +
      '<div class="wb-field full"><span>参考素材（@人物/@场景/@道具）与音色</span>' + wbRefChips(draft.assetRefs, true, draft.id) +
      '<div class="wb-actions"><button class="btn" type="button" data-wb-v-action="pick-assets" data-id="' + esc(draft.id) + '">' + ic('image', 12) + '添加素材</button>' +
      '<button class="btn" type="button" data-wb-v-action="open-voices" data-id="' + esc(draft.id) + '">' + ic('music', 12) + '音色库</button></div></div>' +
      wbParamRow(draft, draft.mode !== 'replicate') +
      '<div class="wb-field full wb-v-estimate" data-wb-v-estimate="' + esc(draft.id) + '"><span class="wb-muted">正在估算这次渲染费用…</span></div>' +
      (focus ? '' : '<div class="wb-field full wb-actions">' +
      '<button class="btn primary" type="button" data-wb-v-action="start" data-id="' + esc(draft.id) + '">' + (draft.mode === 'replicate' ? '开始复刻' : '开始创作') + '</button>' +
      '<span class="wb-note">先出编导稿（可逐镜修改），确认后再提交视频渲染。</span></div>') + '</article>';
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
    var frameHtml = shot.referenceFrameAssetId
      ? '<div class="wb-shot-media"><img data-shot-frame="' + esc(shot.referenceFrameAssetId) + '" alt="第 ' + shot.index + ' 镜参考原帧"><span>参考原帧' + (shot.referenceFrameTime != null ? ' · ' + Number(shot.referenceFrameTime).toFixed(1) + 's' : '') + '</span></div>'
      : '';
    var body = frameHtml + (editing
      ? '<label class="wb-field"><span>画面</span><textarea data-wb-v-edit="scene" data-key="' + esc(key) + '">' + esc(scene || '') + '</textarea></label>' +
        '<label class="wb-field"><span>口播</span><textarea data-wb-v-edit="voiceover" data-key="' + esc(key) + '">' + esc(voiceover || '') + '</textarea></label>' +
        '<label class="wb-field"><span>画面提示词（给视频模型）</span><textarea data-wb-v-edit="renderPrompt" data-key="' + esc(key) + '">' + esc(prompt || '') + '</textarea></label>' +
        '<label class="wb-field"><span>字幕/花字（可空）</span><input data-wb-v-edit="overlay" data-key="' + esc(key) + '" value="' + esc(overlay || '') + '"></label>' +
        '<div class="wb-actions"><button class="btn primary" type="button" data-wb-v-shot="save-edit" data-id="' + esc(work.id) + '" data-index="' + shot.index + '">保存本镜</button>' +
        '<button class="btn" type="button" data-wb-v-shot="cancel-edit" data-id="' + esc(work.id) + '">取消</button></div>'
      : '<p class="wb-v-shot-line">' + esc(scene || '（无画面描述）') + '</p>' +
        (voiceover ? '<p class="wb-v-shot-line voice">「' + esc(voiceover) + '」</p>' : '') +
        (overlay ? '<p class="wb-v-shot-line muted">字幕：' + esc(overlay) + '</p>' : '') +
        (prompt ? '<details class="wb-v-shot-prompt"><summary>画面提示词</summary><p>' + esc(prompt) + '</p></details>' : ''));
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
    var estimateNode = (work.status === 'draft' || work.status === 'failed')
      ? '<div class="wb-field full wb-v-estimate" data-wb-v-work-estimate="' + esc(work.id) + '"><span class="wb-muted">正在估算这次渲染费用…</span></div>'
      : '';
    var actions = '<div class="wb-field full wb-actions">';
    if (work.status === 'draft' || work.status === 'failed') {
      if (work.status === 'failed' && !script) actions += '<button class="btn primary" type="button" data-wb-v-work="regenerate" data-id="' + esc(work.id) + '">重新生成脚本</button>';
      else actions += '<button class="btn primary" type="button" data-wb-v-work="confirm" data-id="' + esc(work.id) + '">确认生成视频</button>' +
        '<button class="btn" type="button" data-wb-v-work="regenerate" data-id="' + esc(work.id) + '">换一版</button>';
    }
    if (work.mode === 'replicate' && script && !busy) {
      var hasFrames = (script.shots || []).some(function (shot) { return shot.referenceFrameAssetId; });
      actions += '<button class="btn" type="button" data-wb-v-work="extract-frames" data-id="' + esc(work.id) + '">' + ic('image', 12) + (hasFrames ? '重新抽取原帧' : '抽取参考原帧') + '</button>';
    }
    if (script && !busy) actions += '<button class="btn" type="button" data-wb-v-work="save-script" data-id="' + esc(work.id) + '">保存编导稿修改</button>';
    actions += '</div>';
    return '<article class="wb-card wb-v-work' + (busy ? ' busy' : '') + '" data-wb-v-work-card="' + esc(work.id) + '">' + head + message + error + refs + scriptHtml + rendersHtml + output + estimateNode + actions + '</article>';
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

  /* ── 十八期：视频任务列表 / 单任务专注制作 ── */

  function wbWorkStatusChip(work) {
    var cls = work.status === 'failed' ? ' warn' : work.status === 'succeeded' ? ' ok' : '';
    return '<span class="wb-tag' + cls + '">' + esc(wbWorkStatusText(work.status)) + '</span>';
  }
  function wbWorkMetaLine(work) {
    if (work.productionMode === 'talking_head') {
      var th = work.talkingHead || {};
      return '口播成片' + (th.voiceName ? ' · ' + esc(th.voiceName) : '') +
        ' · ' + work.durationSeconds + ' 秒 · ' + esc(work.ratio || '9:16') +
        ' · ' + esc(accountName(work.accountId));
    }
    return esc(WB_VIDEO_MODES[work.mode] || work.mode) +
      (work.mode === 'replicate' ? ' · 复刻参考' : ' · ' + esc(work.typeLabel || '') + (work.subtype ? ' · ' + esc(wbSubtypeName(work.type, work.subtype)) : '')) +
      ' · ' + work.durationSeconds + ' 秒 · ' + esc(work.ratio || '9:16') + (work.resolution ? ' · ' + esc(work.resolution) : '') +
      ' · ' + esc(accountName(work.accountId));
  }
  function renderVideoTaskRow(work) {
    var step = videoStepForWork(work);
    var pct = videoStepProgress(work);
    var done = work.status === 'succeeded';
    var talking = work.productionMode === 'talking_head';
    var hosted = Boolean(work.autoHost && work.autoHost.enabled);
    var next = hosted
      ? (done ? '看发布包' : work.status === 'rendering' ? '看进度' : work.status === 'planning' ? '看准备' : (work.autoHost.stage === 'awaiting_confirmation' ? '去确认' : '继续制作'))
      : done ? (talking ? '去包装' : '看成片') : work.status === 'rendering' ? '看进度' : (talking && work.status === 'failed' ? '重试合成' : '继续制作');
    var hostBadge = hosted ? '<span class="wb-tag ok">托管</span>' : '';
    var estimate = (work.status === 'draft' || work.status === 'failed')
      ? '<div class="wb-v-task-estimate" data-wb-v-work-estimate="' + esc(work.id) + '">' + (talking ? '正在估算口播费用…' : '正在估算渲染费用…') + '</div>'
      : '';
    return '<article class="wb-v-task" data-wb-v-work-card="' + esc(work.id) + '" data-wb-v-open="' + esc(work.id) + '" tabindex="0" role="button" aria-label="打开视频任务：' + esc(videoWorkTitle(work)) + '">' +
      '<span class="wb-v-task-index">' + (done ? '✓' : step + '/4') + '</span>' +
      '<div class="wb-v-task-main">' +
      '<div class="wb-v-task-title"><b>' + esc(videoWorkTitle(work)) + '</b>' + hostBadge + wbWorkStatusChip(work) + '</div>' +
      '<div class="wb-v-task-meta">' + wbWorkMetaLine(work) + ' · ' + esc(fmtDate(work.updatedAt || work.createdAt)) + '</div>' +
      '<div class="wb-v-task-progress" aria-hidden="true"><i style="width:' + pct + '%"></i></div>' +
      '</div>' +
      '<div class="wb-v-task-side">' +
      '<button class="btn' + (done ? '' : ' primary') + '" type="button" data-wb-v-open="' + esc(work.id) + '">' + esc(next) + ' →</button>' +
      estimate +
      '</div></article>';
  }
  function renderVideoFocusHead(item, isDraft, work) {
    var title = isDraft ? videoDraftTitle(item) : videoWorkTitle(work);
    var status = isDraft ? '<span class="wb-tag">待配置</span>' : wbWorkStatusChip(work);
    if (!isDraft && work.autoHost && work.autoHost.enabled) status = '<span class="wb-tag ok">托管</span>' + status;
    var talking = Boolean(item && item.productionMode === 'talking_head');
    return '<div class="wb-focus-head"><div><span class="wb-step-kicker">第 ' + state.videoStep + ' / 4 步</span>' +
      '<h2>' + esc(videoStepLabel(state.videoStep, item)) + '</h2>' +
      '<p>' + esc(title) + ' · ' + (isDraft ? (talking ? '写口播稿，选音色和形象照' : '先写清目标和参考，再生成编导稿') : wbWorkStatusText(work.status)) + '</p></div>' +
      '<div class="wb-actions">' + status + '</div></div>';
  }
  function renderTalkingHeadFocusBrief(work) {
    var th = work.talkingHead || {};
    var plan = th.plan || {};
    return '<div class="wb-step-card"><div class="wb-card-head"><div><h3>这条口播的基本信息</h3><p>口播稿、音色和形象照在任务创建时锁定；第 2 步可以改稿，改稿后需要重新合成。</p></div></div>' +
      '<div class="wb-step-summary">' +
      '<div><small>任务</small><b>' + esc(videoWorkTitle(work)) + '</b></div>' +
      '<div><small>音色</small><b>' + esc(th.voiceName || '未记录') + '</b></div>' +
      '<div><small>形象照</small><b>' + esc(th.imageFileName || '未记录') + '</b></div>' +
      '<div><small>语速</small><b>' + esc({ natural: '自然', slightly_fast: '稍快', fast: '较快', extreme: '极快' }[th.speed] || '自然') + '</b></div>' +
      '<div><small>预计时长 / 分段</small><b>' + esc(plan.targetDuration || work.durationSeconds || 0) + ' 秒 · ' + esc(plan.batchCount || 0) + ' 段</b></div>' +
      '<div><small>账号</small><b>' + esc(accountName(work.accountId)) + '</b></div>' +
      '</div>' +
      '<div class="wb-field full" style="margin-top:12px"><span>口播文案</span><p class="wb-v-message" style="margin-top:4px;white-space:pre-wrap">' + esc(th.text || '—') + '</p></div>' +
      '<div class="wb-actions" style="margin-top:12px"><button class="btn primary" type="button" data-wb-v-goto="2">去检查口播稿 →</button>' +
      '<button class="btn" type="button" data-wb-v-work="delete" data-id="' + esc(work.id) + '">删除任务</button>' +
      '<span class="wb-note">删除任务不会影响已经生成的成片素材。</span></div></div>';
  }
  function renderTalkingHeadScriptStep(work) {
    var th = work.talkingHead || {};
    var plan = th.plan || {};
    var busy = work.status === 'rendering';
    var succeeded = work.status === 'succeeded';
    var error = work.status === 'failed' && work.error ? '<p class="wb-v-error">' + esc(work.error) + '</p>' : '';
    if (work.status === 'planning' && work.autoHost && work.autoHost.enabled) {
      return '<div class="wb-step-card"><div class="wb-card-head"><div><h3>托管正在写口播稿…</h3><p>按账号档案和主题写 120–220 字，再自动分段、算时长和费用。这一步不扣费。</p></div></div>' +
        hostedBannerHtml(work) +
        '<p class="wb-note">' + ic('loader', 12) + ' 通常十几秒到一分钟；完成后会自动跳到确认页，只有点确认才会提交合成。</p></div>';
    }
    return '<div class="wb-step-card"><div class="wb-card-head"><div><h3>口播文案与分段</h3><p>系统按标点和语速自动分段，每段单独对口型后拼接。这里不需要写分镜。</p></div></div>' +
      hostedBannerHtml(work) +
      (busy ? '<p class="wb-note">' + ic('loader', 12) + ' 正在合成，暂时不能改稿；完成后可以改稿重新合成。</p>' : '') +
      (succeeded ? '<p class="wb-note">这条已经合成完成。改稿会清空当前任务的成片关联，旧成片仍保留在素材库；需要重新合成才会扣费。</p>' : '') +
      error +
      '<div class="wb-form">' +
      '<label class="wb-field"><span>音色</span><input value="' + esc(th.voiceName || '') + '" disabled></label>' +
      '<label class="wb-field"><span>形象照</span><input value="' + esc(th.imageFileName || '') + '" disabled></label>' +
      '<label class="wb-field"><span>语速</span><input value="' + esc({ natural: '自然', slightly_fast: '稍快', fast: '较快', extreme: '极快' }[th.speed] || '自然') + '" disabled></label>' +
      '</div>' +
      '<label class="wb-field full"><span>口播文案（可改）</span><textarea id="wb-th-speech" maxlength="3000" rows="8"' + (busy ? ' disabled' : '') + ' data-th-speech="' + esc(work.id) + '">' + esc(th.text || '') + '</textarea></label>' +
      '<div class="wb-field full"><span>分段预览</span><div data-wb-th-segments="' + esc(work.id) + '">' + talkingHeadSegmentsHtml(plan) + '</div></div>' +
      '<div class="wb-field full wb-v-estimate" data-wb-th-work-estimate="' + esc(work.id) + '"><span class="wb-muted">正在按语速估算…</span></div>' +
      '<div class="wb-actions"><button class="btn" type="button" data-wb-v-work="save-talking-head" data-id="' + esc(work.id) + '"' + (busy ? ' disabled' : '') + '>保存口播稿修改</button>' +
      '<span class="wb-note">保存后进入第 3 步确认；这一步不会扣费。字幕会在第 4 步按实际分段时长生成。</span></div></div>';
  }
  function renderTalkingHeadRenderStep(work) {
    var th = work.talkingHead || {};
    var plan = th.plan || {};
    var run = work.avatarRun || null;
    var error = work.status === 'failed' && work.error ? '<p class="wb-v-error">' + esc(work.error) + '</p>' : '';
    var progress = '';
    if (run) {
      var steps = run.steps || [];
      var failedSegments = (run.segments || []).filter(function (segment) { return segment.status === 'failed'; });
      progress = '<div class="wb-th-run">' +
        (steps.length ? '<div class="wb-flow-steps">' + steps.map(avatarStepHtml).join('') + '</div>' : '') +
        (run.segmentCount ? '<p class="wb-note">已完成 ' + run.doneSegments + ' / ' + run.segmentCount + ' 段' + (run.failedSegments ? ' · 失败 ' + run.failedSegments + ' 段' : '') + (run.durationSeconds ? ' · 成片 ' + run.durationSeconds + ' 秒' : '') + '</p>' : '') +
        (failedSegments.length ? '<div class="wb-job-segments">' + failedSegments.map(function (segment) {
          return '<p><b>第 ' + segment.index + ' 段</b>：' + esc(segment.text) + '<br><span class="err">' + esc(segment.error || '失败') + '</span></p>';
        }).join('') + '</div>' : '') +
        '</div>';
    }
    var notice = work.status === 'rendering'
      ? '<p class="wb-note">' + ic('loader', 12) + ' 正在分段合成口播，通常 3–6 分钟；这一页会自动刷新，完成后进入第 4 步。</p>'
      : work.status === 'succeeded'
        ? '<p class="wb-note">合成已完成，去第 4 步包装发布。</p>'
        : work.status === 'failed'
          ? '<p class="wb-note">已成功的分段会保留，重新合成只重试失败分段。</p>'
          : '<p class="wb-note">确认后会按底片、语音、人脸分析和逐段对口型计费；这一步才会真正提交。</p>';
    var speechPreview = th.text
      ? '<div class="wb-field full" style="margin-top:10px"><span>确认前检查口播稿</span><p class="wb-v-message" style="margin-top:4px;white-space:pre-wrap">' + esc(th.text) + '</p>' +
        (plan && plan.batchCount ? '<p class="wb-note" style="margin-top:4px">按当前语速自动分 ' + esc(plan.batchCount) + ' 段，逐段对口型后拼接。</p>' : '') + '</div>'
      : '';
    return '<div class="wb-step-card"><div class="wb-card-head"><div><h3>核对音色、形象与费用</h3><p>确认后会创建一个数字人合成任务，并把成片自动挂回这条视频任务。</p></div></div>' +
      hostedBannerHtml(work) +
      '<div class="wb-step-summary">' +
      '<div><small>音色</small><b>' + esc(th.voiceName || '未记录') + '</b></div>' +
      '<div><small>形象照</small><b>' + esc(th.imageFileName || '未记录') + '</b></div>' +
      '<div><small>语速</small><b>' + esc({ natural: '自然', slightly_fast: '稍快', fast: '较快', extreme: '极快' }[th.speed] || '自然') + '</b></div>' +
      '<div><small>预计时长 / 分段</small><b>' + esc((th.plan || {}).targetDuration || work.durationSeconds || 0) + ' 秒 · ' + esc((th.plan || {}).batchCount || 0) + ' 段</b></div>' +
      '<div><small>账号</small><b>' + esc(accountName(work.accountId)) + '</b></div>' +
      '</div>' + speechPreview +
      '<div class="wb-field full wb-v-estimate" data-wb-v-work-estimate="' + esc(work.id) + '"><span class="wb-muted">' + (work.status === 'succeeded' ? '已合成完成。' : work.status === 'rendering' ? '正在合成，完成后可重新查看。' : '正在估算这次口播费用…') + '</span></div>' +
      error + notice + progress +
      '<div class="wb-actions" style="margin-top:10px"><button class="btn" type="button" data-wb-v-goto="2">回到口播稿</button>' +
      '<span class="wb-note">' + (work.avatarRunId ? '已关联口播任务，可重试失败分段。' : '还没有提交过合成。') + '</span></div></div>';
  }
  function renderVideoFocusStepBrief(item, isDraft, work) {
    if (isDraft) return item.productionMode === 'talking_head' ? renderTalkingHeadDraftCard(item, { focus: true }) : renderVideoDraftCard(item, { focus: true });
    if (work.productionMode === 'talking_head') return renderTalkingHeadFocusBrief(work);
    var refs = wbRefChips(work.assetRefs, false, '');
    return '<div class="wb-step-card"><div class="wb-card-head"><div><h3>任务目标与参考</h3><p>这些内容在任务创建时已经锁定；需要换方向请新建任务。</p></div></div>' +
      '<div class="wb-step-summary">' +
      '<div><small>任务</small><b>' + esc(videoWorkTitle(work)) + '</b></div>' +
      '<div><small>模式</small><b>' + esc(WB_VIDEO_MODES[work.mode] || work.mode) + '</b></div>' +
      '<div><small>类型</small><b>' + esc(work.typeLabel || '') + (work.subtype ? ' · ' + esc(wbSubtypeName(work.type, work.subtype)) : '') + '</b></div>' +
      '<div><small>时长 / 画幅</small><b>' + work.durationSeconds + ' 秒 · ' + esc(work.ratio || '9:16') + '</b></div>' +
      '<div><small>清晰度</small><b>' + esc(work.resolution || '默认') + '</b></div>' +
      '<div><small>账号</small><b>' + esc(accountName(work.accountId)) + '</b></div>' +
      '</div>' +
      (work.brief ? '<div class="wb-field full" style="margin-top:12px"><span>想做什么</span><p class="wb-v-message" style="margin-top:4px">' + esc(work.brief) + '</p></div>' : '') +
      (refs ? '<div class="wb-field full" style="margin-top:8px"><span>引用的素材 / 音色</span>' + refs + '</div>' : '<p class="wb-note" style="margin-top:10px">这个任务没有引用额外素材，编导稿会按账号档案和任务描述来写。</p>') +
      '<div class="wb-actions" style="margin-top:12px"><button class="btn" type="button" data-wb-v-work="delete" data-id="' + esc(work.id) + '">删除任务</button>' +
      '<span class="wb-note">删除后不会影响已生成的素材；正在渲染的任务请先等结束。</span></div></div>';
  }
  function renderVideoFocusStepScript(item, isDraft, work) {
    if (isDraft) return item.productionMode === 'talking_head' ? renderTalkingHeadDraftCard(item, { focus: true }) : renderVideoDraftCard(item, { focus: true });
    if (work.productionMode === 'talking_head') return renderTalkingHeadScriptStep(work);
    var script = work.directorScript;
    var busy = work.status === 'planning' || work.status === 'rendering';
    var head = '<div class="wb-card-head"><div><h3>' + esc(videoWorkTitle(work)) + '</h3><p>' + wbWorkMetaLine(work) + '</p></div></div>';
    var message = work.message ? '<p class="wb-v-message">' + esc(work.message) + '</p>' : '';
    var error = work.status === 'failed' && work.error ? '<p class="wb-v-error">' + esc(work.error) + '</p>' : '';
    var body = '';
    if (script && Array.isArray(script.shots) && script.shots.length) {
      var renders = state.workRenders[work.id] || [];
      var shotRendersByKey = {};
      renders.forEach(function (row) { if (row.kind === 'shot') shotRendersByKey[row.shotIndex] = shotRendersByKey[row.shotIndex] || row; });
      body = '<div class="wb-v-script"><div class="wb-v-script-head"><b>编导稿' + (work.scriptEdited ? '（已人工修改）' : '') + '</b>' +
        '<span>' + (script.strategy ? esc(script.strategy) : '按账号档案和任务目标生成') + '</span></div>' +
        script.shots.map(function (shot) { return wbShotCard(work, shot, shotRendersByKey[shot.index]); }).join('') +
        (script.notes ? '<p class="wb-v-shot-line muted">' + esc(script.notes) + '</p>' : '') + '</div>';
    } else if (work.status === 'planning') {
      body = '<p class="wb-muted">' + ic('loader', 12) + (work.autoHost && work.autoHost.enabled ? ' 托管正在写编导稿，通常十几秒到一分钟；完成后会自动跳到确认页。' : ' 编导稿生成中，通常十几秒到一分钟；完成后会自动出现在这里。') + '</p>';
    } else {
      body = '<p class="wb-muted">还没有可用的编导稿。' + (work.status === 'failed' ? '可以重新生成一版。' : '') + '</p>';
    }
    var actions = '';
    if (!busy && script && Array.isArray(script.shots) && script.shots.length) {
      actions = '<div class="wb-actions" style="margin-top:10px">' +
        '<button class="btn" type="button" data-wb-v-work="regenerate" data-id="' + esc(work.id) + '">换一版编导稿</button>' +
        (work.mode === 'replicate' ? '<button class="btn" type="button" data-wb-v-work="extract-frames" data-id="' + esc(work.id) + '">' + ic('image', 12) + ((script.shots || []).some(function (shot) { return shot.referenceFrameAssetId; }) ? '重新抽取原帧' : '抽取参考原帧') + '</button>' : '') +
        '<button class="btn" type="button" data-wb-v-work="save-script" data-id="' + esc(work.id) + '">保存编导稿修改</button></div>';
    }
    return '<div class="wb-step-card">' + head + hostedBannerHtml(work) + message + error + body + actions +
      '<p class="wb-note" style="margin-top:10px">逐镜检查口播和画面。确认后只需核对素材与费用，不会在写稿阶段扣渲染费。</p></div>';
  }
  function renderVideoFocusStepRender(item, isDraft, work) {
    if (isDraft) return item.productionMode === 'talking_head' ? renderTalkingHeadDraftCard(item, { focus: true }) : renderVideoDraftCard(item, { focus: true });
    if (work.productionMode === 'talking_head') return renderTalkingHeadRenderStep(work);
    var refs = wbRefChips(work.assetRefs, false, '');
    var error = work.status === 'failed' && work.error ? '<p class="wb-v-error">' + esc(work.error) + '</p>' : '';
    var script = work.directorScript || {};
    var shotList = Array.isArray(script.shots) ? script.shots : [];
    var scriptPreview = shotList.length
      ? '<div class="wb-v-script wb-host-confirm-script"><div class="wb-v-script-head"><b>确认前检查编导稿</b><span>' + esc(script.strategy || '按账号档案和任务目标生成') + '</span></div>' +
        shotList.map(function (shot) {
          return '<div class="wb-v-shot"><div class="wb-v-shot-head"><b>镜 ' + esc(shot.index) + ' · ' + esc(wbShotRoleLabel(shot.role)) + '</b><span>' + esc(shot.seconds) + ' 秒</span></div>' +
            (shot.scene ? '<p class="wb-v-shot-line">' + esc(shot.scene) + '</p>' : '') +
            (shot.voiceover ? '<p class="wb-v-shot-line voice">「' + esc(shot.voiceover) + '」</p>' : '') + '</div>';
        }).join('') + '</div>'
      : '';
    var notice = work.status === 'rendering' ? '<p class="wb-note">' + ic('loader', 12) + ' 已提交渲染，这一页会自动刷新进度。</p>'
      : work.status === 'succeeded' ? '<p class="wb-note">渲染已完成，去第 4 步预览和下载成片。</p>'
        : work.status === 'planning' ? '<p class="wb-note">' + ic('loader', 12) + ' 编导稿还在生成，完成后才能确认渲染。</p>'
          : '<p class="wb-note">确认后才会提交视频渲染；这一步会按秒数和清晰度计费。</p>';
    return '<div class="wb-step-card"><div class="wb-card-head"><div><h3>核对素材与渲染参数</h3><p>确认后会创建渲染任务；之后仍可在渲染队列看进度。</p></div></div>' +
      hostedBannerHtml(work) +
      '<div class="wb-step-summary">' +
      '<div><small>时长</small><b>' + work.durationSeconds + ' 秒</b></div>' +
      '<div><small>清晰度</small><b>' + esc(work.resolution || '默认') + '</b></div>' +
      '<div><small>画幅</small><b>' + esc(work.ratio || '9:16') + '</b></div>' +
      '<div><small>账号</small><b>' + esc(accountName(work.accountId)) + '</b></div>' +
      '</div>' + scriptPreview +
      '<div class="wb-field full" style="margin-top:10px"><span>本任务引用的素材 / 音色</span>' + (refs || '<p class="wb-muted">没有额外引用素材。</p>') + '</div>' +
      '<div class="wb-field full wb-v-estimate" data-wb-v-work-estimate="' + esc(work.id) + '"><span class="wb-muted">正在估算这次渲染费用…</span></div>' +
      error + notice + '</div>';
  }
  function packageSubtitleLabel(value) {
    return { none: '不烧字幕', white: '白字黑边', yellow: '黄字黑边', bold: '大字报' }[value] || '白字黑边';
  }
  function packageDefaultDescription(work, script) {
    var voice = ((script && script.shots) || []).map(function (shot) { return shot.voiceover || ''; }).filter(Boolean).slice(0, 2).join(' ');
    return [script && script.strategy, voice].filter(Boolean).join('\n').slice(0, 300);
  }
  function packageDefaultTags(work, script) {
    var tags = [];
    [work.typeLabel, work.subtype, (state.profile || {}).product, '教育', '招生', '家长必看'].forEach(function (raw) {
      var value = String(raw || '').replace(/^#/, '').trim().slice(0, 16);
      if (value && tags.indexOf(value) < 0) tags.push(value);
    });
    return tags.slice(0, 6);
  }
  function renderPackageForm(work, pkg) {
    var opts = (pkg && pkg.options) || {};
    var script = work.directorScript || {};
    var title = (pkg && pkg.title) || script.title || videoWorkTitle(work);
    var description = (pkg && pkg.description) || packageDefaultDescription(work, script);
    var tags = ((pkg && pkg.tags) || packageDefaultTags(work, script)).join(' ');
    var coverSubtitle = opts.coverSubtitle || '';
    var packageSource = work.productionMode === 'talking_head' ? '口播分段' : '编导稿分镜';
    var audioAssets = (state.assets || []).filter(function (item) { return item.kind === 'audio'; });
    var bgmOptions = '<option value="">不加背景音乐</option>' + audioAssets.map(function (item) {
      return '<option value="' + esc(item.id) + '"' + (opts.bgmAssetId === item.id ? ' selected' : '') + '>' + esc(item.fileName || '音频素材') + '</option>';
    }).join('');
    return '<p class="wb-note" style="margin:0 0 8px">不想逐项改？直接点底部「生成发布包」，字幕、封面和发布文案会按' + esc(packageSource) + '自动生成。</p>' +
      '<div class="wb-form">' +
      '<label class="wb-field"><span>字幕</span><select data-pkg-field="subtitleStyle">' +
      [['white', '白字黑边'], ['yellow', '黄字黑边'], ['bold', '大字报'], ['none', '不烧字幕']].map(function (row) {
        return '<option value="' + row[0] + '"' + (row[0] === (opts.subtitleStyle || 'white') ? ' selected' : '') + '>' + row[1] + '</option>';
      }).join('') + '</select></label>' +
      '<label class="wb-field"><span>背景音乐</span><select data-pkg-field="bgmAssetId">' + bgmOptions + '</select></label>' +
      '<label class="wb-field full"><span>标题（封面和发布共用）</span><input data-pkg-field="title" maxlength="60" value="' + esc(title) + '" placeholder="例如：家长总说课程贵，应该怎么解释"></label>' +
      '<label class="wb-field full"><span>封面副标题（可选）</span><input data-pkg-field="coverSubtitle" maxlength="30" value="' + esc(coverSubtitle) + '" placeholder="例如：3-8岁家长必看"></label>' +
      '<details class="wb-pkg-advanced"><summary>发布文案（可选，默认自动生成）</summary><div class="wb-form" style="margin-top:8px">' +
      '<label class="wb-field full"><span>发布描述</span><textarea data-pkg-field="description" rows="3" maxlength="300">' + esc(description) + '</textarea></label>' +
      '<label class="wb-field full"><span>话题标签（空格或逗号分隔）</span><input data-pkg-field="tags" value="' + esc(tags) + '" placeholder="教育 招生 家长必看"></label>' +
      '</div></details>' +
      '</div>' +
      '<div class="wb-actions" style="margin-top:10px"><button class="btn primary" type="button" data-wb-v-pkg="create" data-id="' + esc(work.id) + '">' + (pkg ? '重新生成发布包' : '生成发布包') + '</button>' +
      '<span class="wb-note">会生成包装后的 mp4、封面 jpg、字幕 srt、发布说明和 zip；原片保留。字幕按' + esc(packageSource) + '时长生成本地 SRT。</span></div>';
  }
  function renderPackageSection(work) {
    var pkg = state.videoPackages[work.id];
    if (pkg === undefined && state.videoPackageLoading === work.id) {
      return '<div class="wb-step-card"><p class="wb-muted">' + ic('loader', 12) + ' 正在读取发布包…</p></div>';
    }
    if (pkg && pkg.status === 'running') {
      return '<div class="wb-step-card"><div class="wb-card-head"><div><h3>正在生成发布包…</h3><p>烧字幕、混 BGM、生成封面和 zip；通常几十秒，可以离开这一页。</p></div></div>' +
        '<p class="wb-note">' + ic('loader', 12) + ' 生成完会自动显示封面和下载按钮。</p></div>';
    }
    if (pkg && pkg.status === 'failed') {
      return '<div class="wb-step-card"><div class="wb-card-head"><div><h3>发布包生成失败</h3><p>原片还在，改一下设置可以重试。</p></div></div>' +
        '<p class="wb-v-error">' + esc(pkg.error || '生成失败') + '</p>' + renderPackageForm(work, pkg) + '</div>';
    }
    if (pkg && pkg.status === 'ready') {
      var cover = pkg.coverAssetId
        ? '<img data-pkg-cover="' + esc(pkg.coverAssetId) + '" alt="发布封面">'
        : '<div class="wb-pkg-cover-empty">封面未生成</div>';
      var tagText = (pkg.tags || []).map(function (tag) { return '#' + tag; }).join(' ');
      var packagedVideo = pkg.videoAssetId
        ? '<div class="wb-pkg-video"><video class="wb-render-video" controls preload="metadata" data-pkg-video="' + esc(pkg.videoAssetId) + '"></video></div>'
        : '';
      return '<div class="wb-step-card"><div class="wb-card-head"><div><h3>发布包已生成</h3><p>成片、封面、字幕和发布文案都在这一个 zip 里；原片仍保留在素材库。</p></div></div>' +
        '<div class="wb-pkg-grid"><div class="wb-pkg-cover">' + cover + '</div><div class="wb-pkg-info">' +
        '<div class="wb-pkg-title">' + esc(pkg.title || videoWorkTitle(work)) + '</div>' +
        '<p class="wb-pkg-desc">' + esc(pkg.description || '—').replace(/\n/g, '<br>') + '</p>' +
        '<p class="wb-pkg-tags">' + esc(tagText || '—') + '</p>' +
        '<div class="wb-actions"><button class="btn primary" type="button" data-wb-v-pkg="download" data-id="' + esc(work.id) + '">' + ic('download', 12) + '下载发布包</button>' +
        '<button class="btn" type="button" data-wb-v-pkg="copy" data-id="' + esc(work.id) + '">复制发布文案</button></div>' +
        '<ul class="wb-pkg-checks"><li>字幕：' + esc(packageSubtitleLabel((pkg.options || {}).subtitleStyle)) + '</li>' +
        '<li>封面：已生成，可在下载后替换</li>' +
        '<li>发布包：video.mp4 / cover.jpg / subtitles.srt / publish.md / manifest.json</li>' +
        '<li>发布前请核对标题错别字、合规承诺、发布账号和时间</li></ul>' +
        '</div></div>' + packagedVideo +
        '<details class="wb-pkg-settings"><summary>修改包装设置并重新生成</summary>' + renderPackageForm(work, pkg) + '</details></div>';
    }
    return '<div class="wb-step-card"><div class="wb-card-head"><div><h3>包装与发布</h3><p>把成片补成可直接发布的一套：字幕、BGM、封面、标题/描述/标签和 zip。原片保留。</p></div></div>' +
      renderPackageForm(work, null) + '</div>';
  }
  async function ensureVideoPackage(workId) {
    if (!workId || state.videoPackages[workId] !== undefined || state.videoPackageLoading === workId) return;
    state.videoPackageLoading = workId;
    var work = state.videoWorks.filter(function (item) { return item.id === workId; })[0] || null;
    try {
      // 详情接口会顺带触发服务端托管打包补偿（重启/竞态后也能自己恢复）。
      var data = await call('/video/works/' + encodeURIComponent(workId));
      if (data.work) {
        work = data.work;
        state.videoWorks = state.videoWorks.map(function (item) { return item.id === workId ? data.work : item; });
      }
      state.videoPackages[workId] = data.package || null;
    } catch (e) {
      state.videoPackages[workId] = null;
    }
    state.videoPackageLoading = '';
    if (state.tab === 'video' && state.videoFocus && state.videoFocus.id === workId && state.videoStep === 4) renderVideo();
    var pkg = state.videoPackages[workId];
    if (pkg && pkg.status === 'running') startVideoPackagePolling(pkg.id, workId);
    else if (!pkg && work && work.autoHost && work.autoHost.enabled && work.autoHost.confirmedAt
      && work.autoHost.stage !== 'failed' && work.status === 'succeeded') {
      startVideoPackageSweep(workId);
    }
  }
  /** 托管成片刚完成、发布包还没落库时的短轮询；最多 60 秒，失败后交给第 4 步重试。 */
  function startVideoPackageSweep(workId) {
    if (state.videoPackageSweepWork === workId && state.videoPackageSweepTimer) return;
    stopVideoPackageSweep();
    state.videoPackageSweepWork = workId;
    var tries = 0;
    state.videoPackageSweepTimer = setInterval(async function () {
      tries += 1;
      if (tries > 30) { stopVideoPackageSweep(); return; }
      var work = state.videoWorks.filter(function (item) { return item.id === workId; })[0] || null;
      if (!work || !work.autoHost || !work.autoHost.enabled) { stopVideoPackageSweep(); return; }
      if (work.autoHost.stage === 'failed') {
        stopVideoPackageSweep();
        if (state.tab === 'video' && state.videoFocus && state.videoFocus.id === workId && state.videoStep === 4) renderVideo();
        return;
      }
      try {
        var data = await call('/video/works/' + encodeURIComponent(workId));
        if (data.work) {
          state.videoWorks = state.videoWorks.map(function (item) { return item.id === workId ? data.work : item; });
          work = data.work;
        }
        var pkg = data.package;
        if (pkg) {
          state.videoPackages[workId] = pkg;
          stopVideoPackageSweep();
          if (pkg.status === 'running') startVideoPackagePolling(pkg.id, workId);
          else if (pkg.status === 'ready') toast('托管发布包已生成', 'success');
          else if (pkg.status === 'failed') toast(pkg.error || '托管发布包生成失败', 'error');
          if (state.tab === 'video' && state.videoFocus && state.videoFocus.id === workId && state.videoStep === 4) renderVideo();
          return;
        }
        if (state.tab === 'video' && state.videoFocus && state.videoFocus.id === workId && state.videoStep === 4) renderVideo();
      } catch (e) { /* 下一轮继续 */ }
    }, 2000);
  }
  function startVideoPackagePolling(packageId, workId) {
    stopVideoPackagePolling();
    var tries = 0;
    state.videoPackageTimer = setInterval(async function () {
      tries += 1;
      if (tries > 120) { stopVideoPackagePolling(); return; }
      try {
        var data = await call('/video/packages/' + encodeURIComponent(packageId));
        var pkg = data.package;
        if (!pkg) return;
        state.videoPackages[workId] = pkg;
        if (pkg.status !== 'running') {
          stopVideoPackagePolling();
          if (state.tab === 'video' && state.videoFocus && state.videoFocus.id === workId && state.videoStep === 4) renderVideo();
          if (pkg.status === 'ready') toast('发布包已生成', 'success');
          else if (pkg.status === 'failed') toast(pkg.error || '发布包生成失败', 'error');
          return;
        }
        if (state.tab === 'video' && state.videoFocus && state.videoFocus.id === workId && state.videoStep === 4) renderVideo();
      } catch (e) { /* 轮询失败继续等下一次 */ }
    }, 2000);
  }
  function readPackageForm() {
    function field(name) {
      var node = $('[data-pkg-field="' + name + '"]');
      return node ? node.value : '';
    }
    return {
      subtitleStyle: field('subtitleStyle') || 'white',
      bgmAssetId: field('bgmAssetId') || '',
      title: field('title') || '',
      coverSubtitle: field('coverSubtitle') || '',
      description: field('description') || '',
      tags: field('tags') || '',
    };
  }
  function packageCopyText(pkg, work) {
    var tags = (pkg.tags || []).map(function (tag) { return '#' + tag; }).join(' ');
    return [pkg.title || videoWorkTitle(work), '', pkg.description || '', '', tags].join('\n').trim();
  }
  async function copyText(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(value);
    var area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  function renderVideoFocusStepOutput(item, isDraft, work) {
    if (isDraft) return renderVideoDraftCard(item, { focus: true });
    var renders = state.workRenders[work.id] || [];
    var output = work.status === 'succeeded' && work.outputAssetId
      ? '<div class="wb-step-card"><div class="wb-card-head"><div><h3>成片</h3><p>成片已经保存到素材库，预览后可下载；下面再补字幕、封面和发布包。</p></div></div>' +
        '<video class="wb-render-video" controls preload="metadata" data-work-video="' + esc(work.outputAssetId) + '"></video>' +
        '<div class="wb-actions" style="margin-top:8px"><button class="btn" type="button" data-wb-v-download="' + esc(work.id) + '">' + ic('download', 12) + '下载原片</button></div></div>'
      : '';
    var progress = work.status === 'rendering'
      ? '<div class="wb-step-card"><p class="wb-note">' + ic('loader', 12) + ' 正在渲染整片，通常几分钟；可离开这一页，回来后仍会继续显示进度。</p></div>'
      : work.status === 'failed'
        ? '<div class="wb-step-card"><p class="wb-v-error">' + esc(work.error || '渲染失败') + '</p></div>'
        : work.status === 'draft' || work.status === 'planning'
          ? '<div class="wb-step-card"><p class="wb-muted">还没有提交渲染。回到上一步核对参数后确认。</p></div>' : '';
    var renderList = renders.length ? '<div class="wb-step-card"><div class="wb-card-head"><div><h3>渲染记录</h3><p>整片和单镜的提交记录；失败的可直接重试。</p></div></div>' +
      renders.map(wbRenderRow).join('') + '</div>' : '';
    var packageSection = '';
    if (work.status === 'succeeded' && work.outputAssetId) {
      if (state.videoPackages[work.id] === undefined && state.videoPackageLoading !== work.id) void ensureVideoPackage(work.id);
      packageSection = renderPackageSection(work);
    }
    return hostedBannerHtml(work) + packageSection + output + progress + renderList;
  }
  function renderVideoFocusFooter(item, isDraft) {
    var work = isDraft ? null : item;
    var step = state.videoStep;
    var talking = !isDraft && item.productionMode === 'talking_head';
    var hosted = Boolean(work && work.autoHost && work.autoHost.enabled);
    var hostedReady = Boolean(hosted && work.autoHost.stage === 'awaiting_confirmation');
    var hostedDraft = Boolean(isDraft && item.autoHost);
    var prev = '<button class="btn" type="button" id="wb-video-prev"' + (step <= 1 ? ' disabled' : '') + '>上一步</button>';
    var status = isDraft ? (talking ? '配置好后生成口播稿' : '配置好后生成编导稿') : wbWorkStatusText(work.status);
    var hint = hostedDraft
      ? '只写主题，托管自动写稿；确认前不扣费'
      : isDraft
        ? (talking ? '写清口播文案，选音色和形象照' : '先写清目标和参考')
        : talking
          ? (step === 2 ? (hosted ? '托管会自动写稿并跳到确认页；这一步不扣费' : '检查分段和时长；保存后进入确认合成')
            : step === 3 ? (hostedReady ? '托管只在这里停一次；确认后才提交合成并计费' : '确认后才会提交数字人合成并计费')
              : step === 4 ? (hosted ? '成片完成后托管会自动生成字幕/封面/发布包' : '字幕/封面/发布包生成完就能直接发布')
                : '口播稿在第 2 步可以修改')
          : step === 2 ? (hosted ? '托管会自动写编导稿并跳到确认页；这一步不扣费' : '检查分镜，确认后进入渲染确认')
            : step === 3 ? (hostedReady ? '托管只在这里停一次；确认后才提交渲染并计费' : '确认后才会提交渲染并计费')
              : step === 4 ? (hosted ? '成片完成后托管会自动生成字幕/封面/发布包' : '字幕/封面/发布包生成完就能直接发布')
                : '任务创建后不能直接改目标和参考';
    var primary = '';
    if (isDraft) {
      primary = '<button class="btn primary" type="button" data-wb-v-action="start" data-id="' + esc(item.id) + '">' + (hostedDraft ? '开始托管 →' : (talking ? '生成口播稿 →' : '生成编导稿 →')) + '</button>';
    } else if (step === 1) {
      primary = '<button class="btn primary" type="button" data-wb-v-goto="2">' + (talking ? '下一步：检查口播稿 →' : '下一步：看编导稿 →') + '</button>';
    } else if (step === 2) {
      if (talking) {
        var hasSpeech = Boolean((work.talkingHead || {}).text);
        primary = work.status === 'rendering'
          ? '<button class="btn primary" type="button" data-wb-v-goto="3">查看合成进度 →</button>'
          : '<button class="btn primary" type="button" data-wb-v-work="save-talking-head-next" data-id="' + esc(work.id) + '"' + (hasSpeech ? '' : ' disabled') + '>下一步：确认合成 →</button>';
      } else if (work.status === 'planning') primary = '<button class="btn primary" type="button" disabled>' + ic('loader', 12) + ' 编导稿生成中…</button>';
      else if (work.status === 'failed' && !(work.directorScript && (work.directorScript.shots || []).length)) {
        primary = '<button class="btn primary" type="button" data-wb-v-work="regenerate" data-id="' + esc(work.id) + '">重新生成编导稿</button>';
      } else primary = '<button class="btn primary" type="button" data-wb-v-goto="3">下一步：确认渲染 →</button>';
    } else if (step === 3) {
      if (talking) {
        if (work.status === 'rendering') primary = '<button class="btn primary" type="button" data-wb-v-refresh="' + esc(work.id) + '">' + ic('refresh', 12) + '刷新进度</button>';
        else if (work.status === 'succeeded') primary = '<button class="btn primary" type="button" data-wb-v-goto="4">去包装发布 →</button>';
        else if (work.status === 'failed') primary = '<button class="btn primary" type="button" data-wb-v-work="confirm" data-id="' + esc(work.id) + '">重新合成 →</button>';
        else primary = '<button class="btn primary" type="button" data-wb-v-work="confirm" data-id="' + esc(work.id) + '">' + (hostedReady ? '确认托管并合成 →' : '确认并合成 →') + '</button>';
      } else if (work.status === 'planning') primary = '<button class="btn primary" type="button" disabled>等待编导稿…</button>';
      else if (work.status === 'rendering') primary = '<button class="btn primary" type="button" data-wb-v-goto="4">查看渲染进度 →</button>';
      else if (work.status === 'succeeded') primary = '<button class="btn primary" type="button" data-wb-v-goto="4">查看成片 →</button>';
      else primary = '<button class="btn primary" type="button" data-wb-v-work="confirm" data-id="' + esc(work.id) + '">' + (hostedReady ? '确认托管并渲染 →' : '确认并渲染 →') + '</button>';
    } else {
      var main = (state.workRenders[work.id] || []).filter(function (row) { return row.kind === 'main'; })[0] || null;
      var pkg = state.videoPackages[work.id];
      if (work.status === 'succeeded') {
        if (pkg && pkg.status === 'ready') primary = '<button class="btn primary" type="button" data-wb-v-pkg="download" data-id="' + esc(work.id) + '">' + ic('download', 12) + '下载发布包</button>';
        else if (pkg && pkg.status === 'running' || state.videoPackageLoading === work.id) primary = '<button class="btn primary" type="button" disabled>' + ic('loader', 12) + ' 发布包生成中…</button>';
        else if (pkg && pkg.status === 'failed') primary = '<button class="btn primary" type="button" data-wb-v-pkg="create" data-id="' + esc(work.id) + '">重新生成发布包</button>';
        else if (hosted && work.autoHost.stage !== 'failed') primary = '<button class="btn primary" type="button" disabled>' + ic('loader', 12) + ' 托管自动打包中…</button>';
        else primary = '<button class="btn primary" type="button" data-wb-v-pkg="create" data-id="' + esc(work.id) + '">生成发布包 →</button>';
      } else if (work.status === 'rendering') primary = '<button class="btn primary" type="button" data-wb-v-refresh="' + esc(work.id) + '">' + ic('refresh', 12) + '刷新进度</button>';
      else if (work.status === 'failed' && hosted) primary = '<button class="btn primary" type="button" data-wb-v-goto="3">回到托管确认页</button>';
      else if (work.status === 'failed' && main) primary = '<button class="btn primary" type="button" data-wb-v-retry="' + esc(main.id) + '">重试渲染</button>';
      else if (work.status === 'failed') primary = '<button class="btn primary" type="button" data-wb-v-goto="3">回到确认页</button>';
      else primary = '<button class="btn primary" type="button" data-wb-v-goto="3">去确认渲染 →</button>';
    }
    return '<div class="wb-focus-foot">' + prev +
      '<div class="wb-focus-status"><b>第 ' + step + ' / 4 步 · ' + esc(status) + '</b><br>' + esc(hint) + '</div>' +
      primary + '</div>';
  }
  function renderVideoFocus() {
    var item = videoFocusItem();
    if (!item) {
      state.videoFocus = null;
      state.videoStep = 1;
      return false;
    }
    var isDraft = state.videoFocus.kind === 'draft';
    var work = isDraft ? null : item;
    var maxStep = isDraft ? 1 : 4;
    state.videoStep = Math.max(1, Math.min(maxStep, Number(state.videoStep) || 1));
    if (!videoStepAvailable(item, state.videoStep)) state.videoStep = isDraft ? 1 : videoStepForWork(work);
    var body = state.videoStep === 1 ? renderVideoFocusStepBrief(item, isDraft, work)
      : state.videoStep === 2 ? renderVideoFocusStepScript(item, isDraft, work)
        : state.videoStep === 3 ? renderVideoFocusStepRender(item, isDraft, work)
          : renderVideoFocusStepOutput(item, isDraft, work);
    $('#wb-view').innerHTML = '<div class="wb-focus">' +
      '<div class="wb-focus-scroll">' + renderVideoFocusHead(item, isDraft, work) +
      '<div class="wb-focus-body">' + body + '</div></div>' +
      renderVideoFocusFooter(item, isDraft) + '</div>';
    syncVideoChrome();
    hydrateWorkVideos();
    hydratePackageMedia();
    void hydrateShotFrames();
    void refreshVideoEstimates();
    void refreshWorkEstimates();
    refreshTalkingHeadWorkEstimates();
    refreshTalkingHeadDraftEstimates();
    return true;
  }
  function renderVideoList() {
    loadVideoDrafts();
    var draftCards = state.videoDrafts.map(function (draft) {
      if (draft.autoHost) return renderHostedDraftCard(draft);
      return draft.productionMode === 'talking_head' ? renderTalkingHeadDraftCard(draft) : renderVideoDraftCard(draft);
    }).join('');
    var activeWorks = state.videoWorks.filter(function (work) { return work.status !== 'succeeded'; });
    var doneWorks = state.videoWorks.filter(function (work) { return work.status === 'succeeded'; });
    var launcher = '<div class="wb-card"><div class="wb-v-list-head"><div><h2>视频创作</h2><p>一键托管只写主题：自动写稿、选音色/形象照、算分段和费用，停在确认页；确认后才计费，成功后自动生成发布包。想自己逐步改稿也可以选口播成片或分镜模式。</p></div>' +
      '<div class="wb-actions">' +
      '<button class="btn primary" type="button" data-wb-v-launch="hosted">' + ic('sparkle', 13) + '一键托管</button>' +
      '<button class="btn" type="button" data-wb-v-launch="talking_head">' + ic('video', 13) + '口播成片</button>' +
      '<button class="btn" type="button" data-wb-v-launch="generate">' + ic('sparkle', 13) + '生成模式</button>' +
      '<button class="btn" type="button" data-wb-v-launch="replicate">' + ic('copy', 13) + '复刻模式</button>' +
      '<button class="btn" type="button" data-wb-v-action="open-voices" data-id="">' + ic('music', 13) + '音色库</button>' +
      '</div></div></div>';
    var drafts = state.videoDrafts.length
      ? '<div class="wb-v-section"><div class="wb-v-section-head"><b>待配置草稿</b><span>' + state.videoDrafts.length + ' 条 · 提交前不会扣费</span></div>' + draftCards + '</div>'
      : '';
    var active = activeWorks.length
      ? '<div class="wb-v-section"><div class="wb-v-section-head"><b>进行中的任务</b><span>' + activeWorks.length + ' 条</span></div><div class="wb-v-task-grid">' + activeWorks.map(renderVideoTaskRow).join('') + '</div></div>'
      : '';
    var done = doneWorks.length
      ? '<div class="wb-v-section"><div class="wb-v-section-head"><b>已完成</b><span>' + doneWorks.length + ' 条</span></div><div class="wb-v-task-grid">' + doneWorks.map(renderVideoTaskRow).join('') + '</div></div>'
      : '';
    var empty = !state.videoWorks.length && !state.videoDrafts.length
      ? '<div class="wb-v-empty">还没有视频任务。想省步骤就选「一键托管」；想自己写稿选「口播成片」；需要画面分镜选「生成模式」或「复刻模式」。</div>' : '';
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' + launcher + drafts + active + done + empty +
      '<details class="wb-v-tools" id="wb-avatar-tools"><summary>数字人口播（独立工具）</summary>' +
      '<div class="wb-card" style="margin-top:6px"><div id="wb-avatar-panel"></div></div></details>' +
      renderLegacyVideoProjects() + '</div></div>';
    renderAvatarPanel();
    refreshAvatarRuns(true);
    bindLegacyVideoHandlers();
    hydrateWorkVideos();
    void hydrateShotFrames();
    void refreshVideoEstimates();
    void refreshWorkEstimates();
    refreshTalkingHeadDraftEstimates();
    syncVideoChrome();
  }
  /* ── 页面组装 ── */
  function renderVideo() {
    loadVideoDrafts();
    if (state.videoFocus) {
      if (!renderVideoFocus()) renderVideoList();
    } else {
      renderVideoList();
    }
    $$('.wb-v-advanced').forEach(function (node) {
      node.addEventListener('toggle', function () { state.videoAdvancedOpen = node.open; });
    });

    $$('[data-wb-v-launch]').forEach(function (button) {
      button.onclick = function () {
        var value = button.dataset.wbVLaunch;
        var draft = value === 'hosted'
          ? newVideoDraft('generate', 'talking_head', { autoHost: true })
          : value === 'talking_head' ? newVideoDraft('generate', 'talking_head') : newVideoDraft(value, 'storyboard');
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
        if (field === 'durationSeconds' || field === 'resolution') scheduleVideoEstimates();
        if (draft.productionMode === 'talking_head' && (field === 'speech' || field === 'speed')) scheduleTalkingHeadDraftEstimate(draft.id);
      };
      if (control.tagName === 'TEXTAREA' || control.tagName === 'INPUT') control.addEventListener('input', handler);
      else control.addEventListener('change', handler);
    });
    $$('[data-th-speech]').forEach(function (control) {
      control.addEventListener('input', function () {
        var work = state.videoWorks.filter(function (item) { return item.id === control.dataset.thSpeech; })[0];
        var th = (work && work.talkingHead) || {};
        scheduleTalkingHeadWorkEstimate(control.dataset.thSpeech, control.value, th.speed);
      });
    });
    $$('[data-th-clone-voice]').forEach(function (button) {
      button.onclick = function () { openCloneVoiceDialog(); };
    });
    $$('[data-th-refresh-voices]').forEach(function (button) {
      button.onclick = async function () {
        button.disabled = true;
        await refreshAvatarRuns(true);
        renderVideo();
        toast('音色列表已刷新', 'success');
      };
    });
    $$('[data-th-goto-assets]').forEach(function (button) {
      button.onclick = function () { setTab('assets'); };
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
        button.disabled = true; button.innerHTML = ic('loader', 12) + '托管准备中…';
        try {
          if (draft.autoHost) {
            var hostedTopic = String(draft.topic || '').trim();
            if (!hostedTopic) throw new Error('先写一个主题，托管才能写稿');
            var hostedBody;
            if (draft.productionMode === 'talking_head') {
              if (!draft.voiceId) throw new Error('先选一个音色；没有的话点「克隆新音色」');
              if (!draft.imageAssetId) throw new Error('先选一张形象照；素材库没有图片时先上传');
              hostedBody = {
                productionMode: 'talking_head', autoHost: true, topic: hostedTopic,
                voiceId: draft.voiceId, imageAssetId: draft.imageAssetId, speed: draft.speed,
                type: draft.type, subtype: draft.subtype, accountId: state.accountId,
              };
            } else {
              hostedBody = {
                mode: 'generate', autoHost: true, brief: hostedTopic,
                type: draft.type, subtype: draft.subtype, hookStrategy: 'auto',
                durationSeconds: draft.durationSeconds, resolution: draft.resolution, ratio: draft.ratio,
                accountId: state.accountId,
              };
            }
            var hostedResult = await call('/video/works', { method: 'POST', body: hostedBody });
            state.videoWorks.unshift(hostedResult.work);
            removeVideoDraft(draft.id);
            var hostedStep = hostedResult.work && hostedResult.work.status === 'draft' ? 3 : 2;
            openVideoFocus('work', hostedResult.work.id, hostedStep);
            startVideoWorkPolling();
            toast(hostedResult.work.productionMode === 'talking_head'
              ? '托管正在写口播稿，完成后自动停在确认页'
              : '托管正在写编导稿，完成后自动停在确认页', 'success');
            return;
          }
          if (draft.productionMode === 'talking_head') {
            var speech = String(draft.speech || '').trim();
            if (!speech) {
              toast('先把口播文案粘进来', 'error'); button.disabled = false; button.innerHTML = original; return;
            }
            if (!draft.voiceId) {
              toast('先选一个音色；没有的话点「克隆新音色」', 'error'); button.disabled = false; button.innerHTML = original; return;
            }
            if (!draft.imageAssetId) {
              toast('先选一张形象照；素材库没有图片时先上传', 'error'); button.disabled = false; button.innerHTML = original; return;
            }
            var thResult = await call('/video/works', {
              method: 'POST',
              body: {
                productionMode: 'talking_head', speech: speech, voiceId: draft.voiceId,
                imageAssetId: draft.imageAssetId, speed: draft.speed,
                type: draft.type, subtype: draft.subtype, accountId: state.accountId,
              },
            });
            state.videoWorks.unshift(thResult.work);
            removeVideoDraft(draft.id);
            openVideoFocus('work', thResult.work.id, 2);
            toast('口播稿已就绪，核对分段和费用后再开始合成', 'success');
            return;
          }
          if (draft.mode === 'replicate' && draft.sourceKind === 'transcript' && !draft.sourceId) {
            toast('先选一条转写档案作为参考', 'error'); button.disabled = false; button.innerHTML = original; return;
          }
          var transcript = draft.sourceKind === 'transcript'
            ? (state.transcripts.filter(function (item) { return item.id === draft.sourceId; })[0] || null)
            : null;
          var reference = transcript ? (transcript.text || '') : draft.reference;
          var assetRefs = (draft.assetRefs || []).slice();
          // 复刻模式：把转写档案对应的视频素材一起带上，后面才能按分镜抽原帧。
          if (draft.mode === 'replicate' && transcript && transcript.assetId
            && !assetRefs.some(function (ref) { return ref.assetId === transcript.assetId; })) {
            assetRefs.push({ assetId: transcript.assetId, role: '场景', label: transcript.title || '参考视频', notes: '复刻参考视频' });
          }
          var result = await call('/video/works', {
            method: 'POST',
            body: {
              mode: draft.mode, type: draft.type, subtype: draft.subtype, hookStrategy: draft.hookStrategy,
              durationSeconds: draft.durationSeconds, resolution: draft.resolution, ratio: draft.ratio,
              brief: draft.brief, reference: reference, assetRefs: assetRefs, accountId: state.accountId,
            },
          });
          state.videoWorks.unshift(result.work);
          removeVideoDraft(draft.id);
          // 配置完成就进入这条任务的第 2 步：用户不用再在长列表里找刚创建的任务。
          openVideoFocus('work', result.work.id, 2);
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
            var confirmed = await call('/video/works/' + encodeURIComponent(workId) + '/confirm', { method: 'POST', body: {} });
            var confirmedWork = confirmed.work || null;
            var talkingConfirm = confirmedWork && confirmedWork.productionMode === 'talking_head';
            if (confirmedWork) state.videoWorks = state.videoWorks.map(function (item) { return item.id === workId ? confirmedWork : item; });
            state.videoStep = talkingConfirm ? 3 : 4;
            toast(talkingConfirm ? '已提交口播合成，这一页会自动刷新进度' : '已提交视频渲染，第 4 步会自动刷新进度', 'success');
          } else if (action === 'save-talking-head' || action === 'save-talking-head-next') {
            var thWork = state.videoWorks.filter(function (item) { return item.id === workId; })[0];
            if (!thWork) throw new Error('任务不存在，请刷新后再试');
            var speechInput = $('#wb-th-speech');
            var newSpeech = speechInput ? String(speechInput.value || '').trim() : '';
            if (!newSpeech) throw new Error('口播稿不能为空');
            var thChanged = newSpeech !== String((thWork.talkingHead || {}).text || '');
            if (thChanged && thWork.status === 'succeeded' && !window.confirm('改稿会断开当前成片关联，旧成片仍保留在素材库；需要重新合成才会扣费。继续？')) {
              button.disabled = false; button.innerHTML = original; return;
            }
            if (thChanged) {
              var thSaved = await call('/video/works/' + encodeURIComponent(workId), { method: 'PUT', body: { talkingHead: { text: newSpeech } } });
              state.videoWorks = state.videoWorks.map(function (item) { return item.id === workId ? thSaved.work : item; });
              delete state.videoPackages[workId];
              toast('口播稿已保存；确认分段后可以合成', 'success');
            }
            state.videoStep = action === 'save-talking-head-next' ? 3 : 2;
          } else if (action === 'regenerate') {
            await call('/video/works/' + encodeURIComponent(workId) + '/regenerate', { method: 'POST', body: {} });
            state.videoStep = 2;
            toast('正在换一版编导稿…', 'success');
          } else if (action === 'extract-frames') {
            var extracted = await call('/video/works/' + encodeURIComponent(workId) + '/extract-frames', { method: 'POST', body: {} });
            state.videoWorks = state.videoWorks.map(function (item) { return item.id === workId ? extracted.work : item; });
            toast('已抽取 ' + ((extracted.frames || []).length) + ' 张参考原帧', 'success');
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
            if (state.videoFocus && state.videoFocus.id === workId) {
              button.disabled = false;
              closeVideoFocus();
              toast('任务已删除', 'success');
              return;
            }
          }
          if (['confirm', 'regenerate', 'save-script', 'save-talking-head', 'save-talking-head-next', 'delete'].indexOf(action) >= 0) delete state.videoPackages[workId];
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
              referenceFrameAssetId: shot.referenceFrameAssetId || '',
              referenceFrameTime: shot.referenceFrameTime == null ? null : shot.referenceFrameTime,
            };
          });
          state.videoShotEditing = null;
          delete state.videoShotEdits[key];
          renderVideo();
          try {
            var result = await call('/video/works/' + encodeURIComponent(workId), { method: 'PUT', body: { directorScript: work.directorScript, scriptEdited: true } });
            state.videoWorks = state.videoWorks.map(function (item) { return item.id === workId ? result.work : item; });
            delete state.videoPackages[workId];
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
          if (state.videoFocus) state.videoStep = 4;
          toast('已重新提交渲染', 'success');
          void loadVideoWorks();
        } catch (error) { toast(error.message, 'error'); button.disabled = false; button.innerHTML = '重试'; }
      };
    });

    $$('[data-wb-v-open]').forEach(function (node) {
      node.onclick = function (event) {
        event.preventDefault();
        event.stopPropagation();
        openVideoFocus('work', node.dataset.wbVOpen);
      };
      if (node.tagName === 'ARTICLE') {
        node.onkeydown = function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openVideoFocus('work', node.dataset.wbVOpen); }
        };
      }
    });
    $$('[data-wb-v-goto]').forEach(function (button) {
      button.onclick = function () {
        state.videoStep = Number(button.dataset.wbVGoto);
        renderVideo();
        syncVideoChrome();
        renderTopbar();
      };
    });
    var prev = $('#wb-video-prev');
    if (prev) {
      prev.onclick = function () {
        if (state.videoStep <= 1) return;
        state.videoStep -= 1;
        renderVideo();
        syncVideoChrome();
        renderTopbar();
      };
    }
    $$('[data-wb-v-refresh]').forEach(function (button) {
      button.onclick = async function () {
        button.disabled = true; button.innerHTML = ic('loader', 12) + '刷新中…';
        await loadVideoWorks();
        toast('已刷新渲染进度', 'success');
      };
    });
    $$('[data-wb-v-download]').forEach(function (button) {
      button.onclick = async function () {
        var work = state.videoWorks.filter(function (item) { return item.id === button.dataset.wbVDownload; })[0];
        if (!work || !work.outputAssetId) return;
        button.disabled = true; var original = button.innerHTML; button.innerHTML = ic('loader', 12) + '准备下载…';
        try {
          var blob = await fetchBlob(API + '/assets/' + encodeURIComponent(work.outputAssetId) + '/file');
          var url = URL.createObjectURL(blob);
          var link = document.createElement('a');
          link.href = url;
          link.download = String(videoWorkTitle(work) || '视频成片').replace(/[\\/:*?"<>|]/g, '_') + '.mp4';
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        } catch (error) { toast(error.message, 'error'); }
        button.disabled = false; button.innerHTML = original;
      };
    });
    $$('[data-wb-v-pkg]').forEach(function (button) {
      button.onclick = async function () {
        var action = button.dataset.wbVPkg;
        var workId = button.dataset.id;
        var work = state.videoWorks.filter(function (item) { return item.id === workId; })[0];
        if (!work) return;
        if (action === 'download') {
          var pkg = state.videoPackages[workId];
          if (!pkg || !pkg.zipAssetId) return;
          button.disabled = true; var original = button.innerHTML; button.innerHTML = ic('loader', 12) + '准备下载…';
          try {
            var blob = await fetchBlob(API + '/assets/' + encodeURIComponent(pkg.zipAssetId) + '/file');
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = String(pkg.title || videoWorkTitle(work) || '视频发布包').replace(/[\\/:*?"<>|]/g, '_') + '-发布包.zip';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
          } catch (error) { toast(error.message, 'error'); }
          button.disabled = false; button.innerHTML = original;
          return;
        }
        if (action === 'copy') {
          var copyPkg = state.videoPackages[workId];
          if (!copyPkg) return;
          try {
            await copyText(packageCopyText(copyPkg, work));
            toast('发布文案已复制', 'success');
          } catch (error) { toast('复制失败，请手动选择文案', 'error'); }
          return;
        }
        if (action === 'create') {
          var payload = readPackageForm();
          button.disabled = true; var label = button.innerHTML; button.innerHTML = ic('loader', 12) + '提交中…';
          try {
            var data = await call('/video/works/' + encodeURIComponent(workId) + '/package', { method: 'POST', body: payload });
            if (data.package) {
              state.videoPackages[workId] = data.package;
              state.videoPackageLoading = '';
              renderVideo();
              if (data.package.status === 'running') {
                startVideoPackagePolling(data.package.id, workId);
                toast('发布包生成中，通常几十秒', 'success');
              } else if (data.package.status === 'ready') {
                toast('发布包已生成', 'success');
              }
            }
          } catch (error) {
            toast(error.message, 'error');
            button.disabled = false; button.innerHTML = label;
          }
          return;
        }
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
      '<div class="wb-card"><div class="wb-card-head"><div><h3>素材库</h3><p>树形文件夹整理素材；图片可进分析队列（画面描述/标签/可复用判定，关页继续跑）；AI 生成的成片自动进「成片」文件夹和画廊。</p></div></div>' +
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
  async function loadReports(force) {
    if (state.reportsLoading) return;
    if (!force && state.reports) return;
    state.reportsLoading = true;
    try {
      state.reports = await call('/reports?accountId=' + encodeURIComponent(state.accountId));
    } catch (error) {
      if (!state.reports) {
        state.reports = {
          items: [],
          totals: {},
          counts: { pending: state.copy.filter(function (item) { return !(item.stats && (item.stats.backfilledAt || item.stats.plays != null)); }).length },
        };
      }
    }
    state.reportsLoading = false;
    if (state.tab === 'reports') renderReports();
  }

  function openSelfCollectHelp() {
    showDialog('采集我的作品', '<p class="wb-note">不用逐条截图：在自己的抖音主页点一下采集助手，播放/赞评数据会直接进复盘。</p>' +
      '<ol class="wb-assistant-steps">' +
      '<li>打开抖音网页版，点右下角「我」进入自己的主页，往下滚动加载作品。</li>' +
      '<li>点浏览器工具栏的采集助手图标 → 「采集我的作品」。</li>' +
      '<li>回到这里点「刷新」，新作品会按发布时间排列；同一作品重复采集只更新数字。</li>' +
      '</ol>' +
      '<p class="wb-note">还没装采集助手？先下载 zip，解压后在 <code>edge://extensions</code> / <code>chrome://extensions</code> 开发者模式加载；配对入口在「同行观察 → 连接采集助手」。</p>' +
      '<p><a class="btn" href="/assets/junshi/douyin-assistant.zip?v=20261025-2" download>下载采集助手（zip）</a></p>');
  }

  function renderReports() {
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll" id="wb-report-subview"></div></div>';
    renderReportsData();
  }
  function renderReportsData() {
    // 十四期 · 数据复盘：自己作品（采集助手）+ 截图回填，统一由 /reports 返回。
    var report = state.reports;
    if (!report) {
      $('#wb-report-subview').innerHTML = '<div class="wb-card"><p class="wb-muted">' + ic('loader', 14) + ' 正在读取复盘数据…</p></div>';
      return;
    }
    var published = report.items || [];
    var totals = report.totals || {};
    var counts = report.counts || {};
    var ownCount = Number(counts.own || 0);
    var screenshotCount = Number(counts.screenshot || 0);
    var reviewCards = [['已复盘', published.length, '条'], ['总播放', totals.plays || 0, ''], ['总点赞', totals.likes || 0, ''], ['总评论', totals.comments || 0, ''], ['总分享', totals.shares || 0, ''], ['总收藏', totals.saves || 0, '']];
    var insight = state.reviewInsight;
    var head = '<div class="wb-card"><div class="wb-card-head"><div><h3>发布数据复盘</h3><p>用采集助手同步自己的主页作品；没有接采集助手的历史作品，可以直接上传作者端数据截图回填。</p></div></div>' +
      '<div class="wb-stats">' + reviewCards.map(function (item) { return '<div class="wb-stat"><span>' + item[0] + '</span><b>' + item[1] + '<small style="font-size:11px;color:var(--text-3);font-weight:400"> ' + item[2] + '</small></b></div>'; }).join('') + '</div>' +
      '<p class="wb-muted">采集助手 ' + ownCount + ' 条' + (screenshotCount ? ' · 截图回填 ' + screenshotCount + ' 条' : '') + '</p>' +
      '<div class="wb-field full wb-actions">' +
      '<button class="btn primary" type="button" data-review-action="insight"' + (published.length ? '' : ' disabled') + '>' + ic('bulb', 13) + '生成复盘洞察</button>' +
      '<button class="btn" type="button" data-review-action="backfill">' + ic('image', 13) + '截图回填</button>' +
      '<button class="btn" type="button" data-review-action="self-help">' + ic('refresh', 13) + '采集我的作品</button>' +
      '<button class="btn" type="button" data-review-action="refresh-reports">刷新</button>' +
      '</div>' +
      (insight ? '<div class="wb-copy-body wb-review-insight">' + md(insight) + '</div>' +
        '<div class="wb-actions"><button class="btn primary" type="button" data-review-action="next-cycle">' + ic('sparkle', 13) + '用这份复盘生成下个周期计划</button></div>' : '') +
      '</div>';
    var listHtml;
    if (published.length) {
      listHtml = '<div class="wb-card"><div class="wb-card-head"><div><h3>已发布内容数据</h3><p>按同步时间倒序；采集助手同步的作品会持续更新。</p></div></div>' +
        '<table class="wb-table"><thead><tr><th>主题</th><th>来源</th><th>发布</th><th>播放</th><th>赞</th><th>评</th><th>转</th><th>藏</th><th>同步</th><th></th></tr></thead><tbody>' +
        published.map(function (item) {
          var s = item.stats || {};
          var isOwn = item.origin === 'douyin_assistant';
          var publishedText = isOwn ? String(s.publishedAt || '').slice(0, 10) : (s.publishedAt || '');
          var action = isOwn
            ? (item.shareUrl ? '<a class="btn" href="' + esc(item.shareUrl) + '" target="_blank" rel="noopener noreferrer">打开作品</a>' : '<span class="wb-muted">已同步</span>')
            : (item.canUpdate
              ? '<button class="btn" type="button" data-review-update="' + esc(item.sourceId || '') + '" data-review-source="' + esc(item.sourceTable || 'snapshot') + '">更新数据</button>'
              : '<span class="wb-muted">历史数据</span>');
          return '<tr><td title="' + esc(item.topic) + '">' + esc(String(item.topic || '').slice(0, 26)) + '</td>' +
            '<td>' + (isOwn ? '采集助手' : '截图回填') + '</td>' +
            '<td>' + esc(publishedText || '—') + '</td>' +
            [s.plays, s.likes, s.comments, s.shares, s.saves].map(function (value) { return '<td>' + (Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—') + '</td>'; }).join('') +
            '<td>' + fmtDate(s.backfilledAt) + '</td>' +
            '<td>' + action + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      listHtml = '<div class="wb-card"><p class="wb-muted">还没有复盘数据。用采集助手同步自己的主页，或点上面「截图回填」上传作者端数据截图。</p></div>';
    }
    var stats = (state.summary && state.summary.stats) || {};
    var cards = [['对话消息', stats.messages || 0, '条'], ['视频项目', stats.videos || 0, '个'], ['素材', stats.assets || 0, '份'], ['同行观察', stats.references || 0, '条'], ['生成任务', stats.jobs || 0, '次']];
    var jobs = (state.summary && state.summary.jobs) || state.jobs.slice(0, 8);
    $('#wb-report-subview').innerHTML = head + listHtml +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>账号资产概览</h3><p>当前机构的内容资产与最近任务。</p></div></div>' +
      '<div class="wb-stats">' + cards.map(function (item) { return '<div class="wb-stat"><span>' + item[0] + '</span><b>' + item[1] + '<small style="font-size:11px;color:var(--text-3);font-weight:400"> ' + item[2] + '</small></b></div>'; }).join('') + '</div></div>' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>最近任务</h3><p>生成成功或失败都会记录。</p></div><button class="btn" type="button" data-wb-go="jobs">查看全部</button></div>' +
      (jobs.length ? '<table class="wb-table"><thead><tr><th>类型</th><th>状态</th><th>说明</th><th>时间</th></tr></thead><tbody>' +
        jobs.map(function (job) { return '<tr><td>' + esc(job.kind) + '</td><td>' + esc(jobStatusText(job.status)) + '</td><td>' + esc(job.detail) + '</td><td>' + fmtDate(job.createdAt) + '</td></tr>'; }).join('') + '</tbody></table>' : '<p class="wb-muted">还没有任务。</p>') +
      '</div>';
    $$('[data-wb-go]').forEach(function (button) { button.onclick = function () { setTab(button.dataset.wbGo); }; });
    $$('[data-review-action]').forEach(function (button) {
      button.onclick = async function () {
        var action = button.dataset.reviewAction;
        if (action === 'self-help') { openSelfCollectHelp(); return; }
        if (action === 'backfill') { openStatsBackfill(); return; }
        if (action === 'refresh-reports') {
          button.disabled = true; button.innerHTML = ic('loader', 12) + '刷新中…';
          await loadReports(true);
          return;
        }
        if (action === 'next-cycle') {
          var originalNext = button.innerHTML;
          button.disabled = true; button.innerHTML = ic('loader', 12) + '生成中…';
          var brief = ('基于最近一次数据复盘（' + published.length + ' 条已发布数据，总播放 ' + (totals.plays || 0) + '）生成下个周期计划。' + String(insight || ''))
            .replace(/[#*`>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 450);
          try {
            await call('/cycles', { method: 'POST', body: { count: 7, brief, accountId: state.accountId } });
            state.cycleForm = { count: 7, brief: '' };
            state.cycles = [];
            state.planView = 'cycles';
            setTab('plan');
            toast('已开始生成下个周期计划，通常十几秒到一分钟', 'success');
          } catch (error) {
            toast(error.message, 'error');
            button.disabled = false;
            button.innerHTML = originalNext;
          }
          return;
        }
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
    $$('[data-review-update]').forEach(function (button) {
      button.onclick = function () {
        openStatsBackfill(button.dataset.reviewSource || 'snapshot', button.dataset.reviewUpdate || '');
      };
    });
  }
  /* 历史任务：独立一级目的地（按用户口径保留），不再塞进数据复盘子页签。 */
  /* 历史任务：独立一级目的地（按用户口径保留）；类型筛选 + 失败原因 + 单任务重试。 */
  function stopJobsPolling() {
    if (state.jobsTimer) { clearInterval(state.jobsTimer); state.jobsTimer = null; }
  }
  function startJobsPolling() {
    var running = (state.jobStatusFacets || []).some(function (item) { return item.status === 'running' && Number(item.count) > 0; });
    if (!running) { stopJobsPolling(); return; }
    if (state.jobsTimer) return;
    state.jobsTimer = setInterval(function () {
      if (state.tab !== 'jobs') { stopJobsPolling(); return; }
      void loadJobs(true);
    }, 4000);
  }
  async function loadJobs(silent) {
    var params = ['limit=100'];
    if (state.jobKind) params.push('kind=' + encodeURIComponent(state.jobKind));
    if (state.jobStatus) params.push('status=' + encodeURIComponent(state.jobStatus));
    try {
      var data = await call('/jobs?' + params.join('&'));
      state.jobs = data.items || [];
      state.jobFacets = data.kinds || [];
      state.jobStatusFacets = data.statuses || [];
      state.jobTotal = Number(data.total || 0);
    } catch (error) {
      if (!silent) toast(error.message, 'error');
      return;
    }
    if (state.tab === 'jobs') renderJobs();
    startJobsPolling();
  }
  function jobStatusChip(status) {
    var cls = status === 'succeeded' ? 'ok' : status === 'failed' ? 'bad' : '';
    return '<span class="wb-tag ' + cls + '">' + esc(jobStatusText(status)) + '</span>';
  }
  function renderJobs() {
    var jobs = state.jobs || [];
    var totalAll = (state.jobFacets || []).reduce(function (sum, item) { return sum + Number(item.count || 0); }, 0);
    var filters = '<div class="wb-chips" style="margin-bottom:10px">' +
      '<button class="chip' + (state.jobKind ? '' : ' on') + '" type="button" data-job-kind="">全部 ' + totalAll + '</button>' +
      (state.jobFacets || []).map(function (item) {
        return '<button class="chip' + (state.jobKind === item.kind ? ' on' : '') + '" type="button" data-job-kind="' + esc(item.kind) + '">' + esc(item.kind) + ' ' + item.count + '</button>';
      }).join('') + '</div>';
    var statusSelect = '<label class="wb-inline"><span>状态</span><select id="wb-job-status">' +
      [['', '全部'], ['running', '进行中'], ['succeeded', '完成'], ['failed', '失败']].map(function (row) {
        return '<option value="' + row[0] + '"' + (state.jobStatus === row[0] ? ' selected' : '') + '>' + row[1] + '</option>';
      }).join('') + '</select></label>';
    var rows = jobs.map(function (job) {
      var reason = job.status === 'failed' ? (job.error || job.detail || '') : '';
      return '<tr data-job-row="' + esc(job.id) + '">' +
        '<td><b>' + esc(job.kind) + '</b>' + (Number(job.attempts) > 0 ? '<div class="wb-meta">第 ' + (Number(job.attempts) + 1) + ' 次尝试</div>' : '') + '</td>' +
        '<td>' + jobStatusChip(job.status) + '</td>' +
        '<td title="' + esc(job.detail) + '">' + esc(String(job.detail || '').slice(0, 60)) + '</td>' +
        '<td class="wb-job-error" title="' + esc(reason) + '">' + (reason ? esc(String(reason).slice(0, 80)) : '—') + '</td>' +
        '<td>' + fmtDate(job.createdAt) + '</td>' +
        '<td><div class="wb-actions"><button class="btn" type="button" data-job-detail="' + esc(job.id) + '">详情</button>' +
        (job.retryable ? '<button class="btn primary" type="button" data-job-retry="' + esc(job.id) + '">重试</button>' : '') + '</div></td></tr>';
    }).join('');
    var head = '<div class="wb-card"><div class="wb-card-head"><div><h3>历史任务</h3><p>文案、视频、转写、数字人和方案的每次生成状态；失败原因单独保留，能重跑的会给出「重试」。</p></div>' +
      '<div class="wb-actions">' + statusSelect + '<button class="btn" type="button" id="wb-job-refresh">' + ic('refresh', 12) + '刷新</button></div></div>' + filters +
      (jobs.length
        ? '<table class="wb-table"><thead><tr><th>类型</th><th>状态</th><th>说明</th><th>失败原因</th><th>创建</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<p class="wb-muted">' + (state.jobKind || state.jobStatus ? '当前筛选没有任务。' : '还没有历史任务。') + '</p>') +
      '<p class="wb-muted" style="margin-top:8px">共 ' + state.jobTotal + ' 条' + (state.jobTotal > jobs.length ? '，当前显示最近 ' + jobs.length + ' 条' : '') + '。</p></div>';
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' + head + '</div></div>';
    $$('[data-job-kind]').forEach(function (button) {
      button.onclick = function () { state.jobKind = button.dataset.jobKind; void loadJobs(); };
    });
    var status = $('#wb-job-status');
    if (status) status.onchange = function () { state.jobStatus = status.value; void loadJobs(); };
    var refresh = $('#wb-job-refresh');
    if (refresh) refresh.onclick = function () { void loadJobs(); };
    $$('[data-job-detail]').forEach(function (button) {
      button.onclick = function () { void openJobDetail(button.dataset.jobDetail); };
    });
    $$('[data-job-retry]').forEach(function (button) {
      button.onclick = function () { void retryJob(button.dataset.jobRetry, button); };
    });
    $$('[data-job-row]').forEach(function (row) {
      row.onclick = function (event) {
        if (event.target.closest('button')) return;
        void openJobDetail(row.dataset.jobRow);
      };
    });
  }
  async function retryJob(jobId, button) {
    var original = button ? button.innerHTML : '';
    if (button) { button.disabled = true; button.innerHTML = ic('loader', 11) + '重试中…'; }
    try {
      var result = await call('/jobs/' + encodeURIComponent(jobId) + '/retry', { method: 'POST', body: {} });
      toast('已重新提交，新任务已进入任务流水', 'success');
      closeDialog();
      await loadJobs(true);
      return result;
    } catch (error) {
      toast(error.message, 'error');
      if (button) { button.disabled = false; button.innerHTML = original; }
    }
  }
  function jobResourceHtml(resource) {
    if (!resource || !resource.item) return '<p class="wb-muted">这个任务没有可展示的关联资源。</p>';
    var item = resource.item;
    if (resource.type === 'avatar_run') {
      var failed = (item.segments || []).filter(function (segment) { return segment.status === 'failed'; });
      return '<div class="wb-job-resource"><p><b>数字人口播</b> · ' + esc(item.speedLabel || '') + ' · ' + item.segmentCount + ' 段 · ' + esc(jobStatusText(item.status)) + '</p>' +
        (item.error ? '<p class="err">' + esc(item.error) + '</p>' : '') +
        '<p class="wb-note">已完成 ' + item.doneSegments + ' 段' + (item.failedSegments ? ' · 失败 ' + item.failedSegments + ' 段' : '') + (item.durationSeconds ? ' · 成片 ' + item.durationSeconds + ' 秒' : '') + '</p>' +
        (failed.length ? '<div class="wb-job-segments">' + failed.map(function (segment) {
          return '<p><b>第 ' + segment.index + ' 段</b>：' + esc(segment.text) + '<br><span class="err">' + esc(segment.error || '失败') + '</span></p>';
        }).join('') + '</div>' : '') +
        (item.status === 'failed' && item.failedSegments ? '<button class="btn primary" type="button" data-job-avatar-retry="' + esc(item.id) + '">重试失败分段</button>' : '') +
        '</div>';
    }
    if (resource.type === 'render') {
      return '<div class="wb-job-resource"><p><b>视频渲染</b> · ' + esc(item.title || '') + ' · ' + esc(jobStatusText(item.status)) + '</p>' +
        (item.error ? '<p class="err">' + esc(item.error) + '</p>' : '') + '</div>';
    }
    if (resource.type === 'video_work') {
      return '<div class="wb-job-resource"><p><b>视频任务</b> · ' + esc(item.title || '未命名') + ' · ' + esc(item.status) + '</p>' +
        (item.error ? '<p class="err">' + esc(item.error) + '</p>' : '') + '</div>';
    }
    if (resource.type === 'transcript') {
      return '<div class="wb-job-resource"><p><b>转写档案</b> · ' + esc(item.title || '未命名') + ' · ' + esc(jobStatusText(item.status)) + '</p>' +
        (item.error ? '<p class="err">' + esc(item.error) + '</p>' : '') + '</div>';
    }
    if (resource.type === 'brain') {
      return '<div class="wb-job-resource"><p><b>写作大脑</b> · ' + esc(item.name || '未命名') + ' · ' + esc(jobStatusText(item.status)) + '</p>' +
        (item.error ? '<p class="err">' + esc(item.error) + '</p>' : '') + '</div>';
    }
    if (resource.type === 'copy' || resource.type === 'video_script') {
      var isCopy = resource.type === 'copy';
      return '<div class="wb-job-resource"><p><b>' + (isCopy ? '文案产出' : '分镜脚本') + '</b> · ' + esc(item.topic || item.title || '') + (item.style || item.mode ? ' · ' + esc(item.style || item.mode) : '') + '</p>' +
        '<pre class="wb-job-content">' + esc(item.content || item.script || '') + '</pre>' +
        '<button class="btn" type="button" data-job-copy="1">' + ic('copy', 11) + '复制内容</button></div>';
    }
    return '<p class="wb-muted">关联资源：' + esc(resource.type) + '</p>';
  }
  async function openJobDetail(jobId) {
    var info;
    try { info = await call('/jobs/' + encodeURIComponent(jobId)); }
    catch (error) { toast(error.message, 'error'); return; }
    var job = info.job;
    showDialog('任务详情', '<div class="wb-job-detail">' +
      '<p><b>' + esc(job.kind) + '</b> ' + jobStatusChip(job.status) + '</p>' +
      '<p class="wb-note">' + esc(job.detail) + '</p>' +
      (job.error ? '<div class="wb-job-errorbox"><b>失败原因</b><p>' + esc(job.error) + '</p></div>' : '') +
      '<p class="wb-meta">创建 ' + fmtDate(job.createdAt) + ' · 更新 ' + fmtDate(job.updatedAt) +
      (job.attempts ? ' · 第 ' + (job.attempts + 1) + ' 次尝试' : '') + (job.retryOf ? ' · 重试自 ' + esc(job.retryOf) : '') + '</p>' +
      (info.entityLabel ? '<p class="wb-meta">关联：' + esc(info.entityLabel) + (job.entityId ? ' · ' + esc(job.entityId) : '') + '</p>' : '') +
      jobResourceHtml(info.resource) +
      '<div class="wb-actions">' + (job.retryable ? '<button class="btn primary" type="button" id="wb-job-detail-retry">重试这个任务</button>' : '') +
      '<button class="btn" type="button" id="wb-job-detail-close">关闭</button></div></div>');
    $('#wb-job-detail-close').onclick = closeDialog;
    var retry = $('#wb-job-detail-retry');
    if (retry) retry.onclick = function () { void retryJob(job.id, retry); };
    var avatarRetry = $('[data-job-avatar-retry]');
    if (avatarRetry) {
      avatarRetry.onclick = async function () {
        avatarRetry.disabled = true; avatarRetry.innerHTML = ic('loader', 11) + '重试中…';
        try {
          await call('/avatar/runs/' + encodeURIComponent(avatarRetry.dataset.jobAvatarRetry) + '/retry', { method: 'POST', body: {} });
          toast('已重新提交失败分段', 'success');
          closeDialog();
          await loadJobs(true);
        } catch (error) {
          toast(error.message, 'error');
          avatarRetry.disabled = false; avatarRetry.innerHTML = '重试失败分段';
        }
      };
    }
    $$('[data-job-copy]').forEach(function (button) {
      button.onclick = async function () {
        var box = button.closest('.wb-job-resource');
        var pre = box ? box.querySelector('pre') : null;
        if (!pre) return;
        try {
          await navigator.clipboard.writeText(pre.textContent || '');
          toast('已复制到剪贴板', 'success');
        } catch {
          var range = document.createRange();
          range.selectNodeContents(pre);
          var selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          toast('已选中内容，按 Ctrl+C 复制');
        }
      };
    });
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
    } else if (wf.kind === 'hotspot' && wf.stage === 'angle') {
      var picked = wf.state.hotspot || {};
      body = '<p class="wb-note">热点：<b>' + esc(picked.title || '') + '</b></p>' +
        (picked.fact ? '<p>' + esc(picked.fact) + '</p>' : '') +
        '<h4>怎么把这个热点和你的账号结合？</h4><p class="wb-note">只借热点的注意力或事实关系，不编造新闻细节；下一步再选写作大脑。</p>' +
        '<div class="wb-choice-grid">' + (state.workflowMeta.angles || []).map(function (item) {
          var value = Array.isArray(item) ? item[0] : item;
          var desc = Array.isArray(item) ? item[1] : '';
          return '<button class="wb-choice" type="button" data-wf-angle="' + esc(value) + '"><b>' + esc(value) + '</b><small>' + esc(desc) + '</small></button>';
        }).join('') + '</div>';
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
        toast('已选定，文案已保存', 'success');
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
      showDialog('今天想从哪里开始？', '<p>可以先给一个大致方向，也可以让灵动Agent根据账号资料推荐三个选题。' +
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
    if (kind === 'hotspot') {
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
      var resetButton = function () { button.disabled = false; button.innerHTML = ic('sparkle', 12) + '开始'; };
      var input = {};
      var optimisticStage = 'searching';
      var optimisticState = { keyword: '', message: '正在联网搜索今天的热点…', copyOptions: [] };
      if (kind === 'today') input.goal = ($('#wb-flow-goal') || {}).value || '';
      if (kind === 'hotspot') {
        if (hotspotMode.mode === 'keyword') {
          input.mode = 'keyword';
          input.keyword = String(($('#wb-flow-keyword') || {}).value || '').trim();
          if (!input.keyword) { toast('先填一个搜索关键词，或改用手动填写热点', 'error'); resetButton(); return; }
          optimisticState = { keyword: input.keyword, message: '正在联网搜索今天的热点…', copyOptions: [] };
        } else {
          input.mode = 'manual';
          input.title = String(($('#wb-flow-title') || {}).value || '').trim();
          input.fact = String(($('#wb-flow-fact') || {}).value || '').trim();
          input.sourceUrl = String(($('#wb-flow-url') || {}).value || '').trim();
          if (!input.title || !input.fact) { toast('手动热点需要标题和事实描述', 'error'); resetButton(); return; }
          optimisticStage = 'angle';
          optimisticState = { hotspot: { title: input.title, fact: input.fact, sourceUrl: input.sourceUrl }, copyOptions: [] };
        }
      }
      button.disabled = true; button.innerHTML = ic('loader', 12) + '生成中…';
      closeDialog();
      launchWorkflow(kind, input, titles[kind], optimisticStage, optimisticState);
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
    showDialog('记忆与灵感', '<p class="wb-note">长期记忆会进入灵动Agent的每次回答；灵感是存下来的选题。</p>' +
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
    else if (state.tab === 'plan') renderPlan();
    else if (state.tab === 'video') renderVideo();
    else if (state.tab === 'assets') renderAssets();
    else if (state.tab === 'copybrains') renderBrains();
    else if (state.tab === 'reports') renderReports();
    else if (state.tab === 'jobs') renderJobs();
    else renderChat();
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    // 回到上次所在目的地；不从聊天页强制重置。
    try {
      var saved = localStorage.getItem('junshi.wb.tab');
      if (saved && TAB_META[saved]) state.tab = saved;
    } catch (e) { /* ignore */ }
    var toastEl = document.createElement('div');
    toastEl.id = 'wb-toast';
    toastEl.className = 'wb-toast';
    toastEl.hidden = true;
    $('#scr-workbench').appendChild(toastEl);
    $$('#wb-tabs [data-wb]').forEach(function (button) {
      button.addEventListener('click', function () {
        // 一级导航回到每个目的地的默认子视图；子页签自己的切换不受影响。
        if (button.dataset.wb === 'plan' && state.tab !== 'plan') state.planView = 'plans';
        setTab(button.dataset.wb);
      });
    });
    var backPlatform = $('#wb-back-platform');
    if (backPlatform) {
      backPlatform.onclick = function () {
        var nav = document.querySelector('.navitem[data-screen="chat"]');
        if (nav) nav.click();
      };
    }
    var close = $('#wb-dialog-close');
    if (close) close.onclick = closeDialog;
    var dialog = $('#wb-dialog');
    if (dialog) dialog.addEventListener('click', function (event) { if (event.target === dialog) closeDialog(); });
    loadAll();
  }

  window.JunshiWorkbench = { mount: mount };
})();
