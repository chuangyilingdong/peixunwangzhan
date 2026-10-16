/* 招生军师 · 专家团 —— 前端逻辑
 * 见 ../../junshi/index.html 顶部注释：脚本必须外链（CSP script-src 'self'），且要打 ?v= 内容哈希。
 *
 * 对话走 POST + fetch 流式读（不用 EventSource —— 它只支持 GET，塞不下请求体），
 * 自己解析 SSE 的 `event:` / `data:` 两行格式。
 *
 * ⚠️ 2026-10-15 改为**服务端存会话**（机构级）：历史的事实来源是 junshi_conversations /
 *    junshi_messages 两张表，前端不再把整个 messages 数组发上去，只发「这一句 + conversationId」。
 *    好处：同机构同事能接上下文、换设备看得到、以后才有用量统计。
 */
(function () {
  var root = document.getElementById('js-app');
  if (!root) return;
  var $ = function (s) { return root.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(root.querySelectorAll(s)); };
  var API = '/api/junshi';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /** 轻量 Markdown → HTML：先整体转义，再只认「模型真的会写」的几种结构。
   *  支持 **加粗**、「整行只有加粗」当小标题、1. 2. 有序列表、- · 无序列表、# 标题、空行分段。
   *  实测真实回答里就是这几种（7 行加粗 + 6 行列点），多余的花样不认、原始 HTML 永远不放行。 */
  function mdHtml(src) {
    var out = [];
    var list = null;
    var closeList = function () { if (list) { out.push('</' + list + '>'); list = null; } };
    var inline = function (s) { return s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>'); };
    String(src == null ? '' : src).split('\n').forEach(function (line) {
      var t = esc(line).trim();
      if (!t) { closeList(); return; }
      var h = t.match(/^#{1,4}\s*(\S.*)$/);
      if (h) { closeList(); out.push('<p class="md-h">' + inline(h[1]) + '</p>'); return; }
      var only = t.match(/^\*\*([^*]+)\*\*[：:]?$/);
      if (only) { closeList(); out.push('<p class="md-h">' + only[1] + '</p>'); return; }
      var ol = t.match(/^(\d{1,2})[.、)]\s+(\S.*)$/);
      if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(ol[2]) + '</li>'); return; }
      var ul = t.match(/^[-—•·]\s+(\S.*)$/);
      if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(ul[1]) + '</li>'); return; }
      closeList();
      out.push('<p>' + inline(t) + '</p>');
    });
    closeList();
    return out.join('');
  }
  /** 内联 sprite 图标。尺寸走 width/height 属性。 */
  function ic(name, size) {
    var px = size || 14;
    return '<svg class="ic" width="' + px + '" height="' + px + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }
  /* 平台登录态：三个端共用同一个 localStorage 前缀（见 packages/shared/src/auth.js），
     同源页面互相能读到。军师靠它把会话与画像挂到机构名下。
     ⚠️ 为什么不靠 cookie：机构端 cookie 的 Path 是 `/api/org`，浏览器**根本不会**把它发给
     `/api/junshi/*`（服务端 readToken 虽然兼容跨端，但请求里压根没这个 cookie）。
     服务端接受 `Authorization: Bearer`，这条通道与路径无关、最稳。 */
  var AUTH_KEYS = ['ai-kids-platform.session.v1.org', 'ai-kids-platform.session.v1.student', 'ai-kids-platform.session.v1.admin'];
  function authSession() {
    for (var i = 0; i < AUTH_KEYS.length; i++) {
      try {
        var s = JSON.parse(localStorage.getItem(AUTH_KEYS[i]) || 'null');
        if (s && s.token && (!s.expiresAt || new Date(s.expiresAt).getTime() > Date.now() + 60000)) return s;
      } catch (e) { /* 隐私模式：静默跳过 */ }
    }
    return null;
  }
  function authToken() { var s = authSession(); return s ? s.token : null; }
  function saveSession(s) {
    // 与机构端同一个 key（clientType=org）：在军师登录 = 在机构端也登录，一套账号一处生效。
    try { localStorage.setItem(AUTH_KEYS[0], JSON.stringify({ token: s.token, expiresAt: s.expiresAt, user: s.user, organization: s.organization || null })); } catch (e) {}
  }
  function clearSession() {
    for (var i = 0; i < AUTH_KEYS.length; i++) { try { localStorage.removeItem(AUTH_KEYS[i]); } catch (e) {} }
  }
  /* ── 登录门 ──
     口径（2026-10-16 用户）：先登录才能进入，而不是进去之后再补登录。所以没会话时
     停在门口、一个业务接口都不请求；会话在途中失效（过期/停用/别处登出）也一样回门口，
     不悄悄降级成匿名 —— 那样门槛等于没有。 */
  function showGate(message) {
    var gate = $('#js-gate');
    if (!gate) return;
    root.classList.add('gated');
    gate.hidden = false;
    $('#js-gate-err').textContent = message || '';
    var li = $('#js-gate-login');
    if (li && !li.value) { try { li.focus({ preventScroll: true }); } catch (e) { li.focus(); } }
  }
  function sessionLost() {
    clearSession();
    showGate('登录状态已过期，请重新登录。');
    throw new Error('登录状态已过期，请重新登录。');
  }
  (function bindGate() {
    var form = $('#js-gate-form');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('#js-gate-go');
      var login = $('#js-gate-login').value.trim();
      var password = $('#js-gate-pass').value;
      var code = $('#js-gate-code').value.trim();
      if (!login || !password) { $('#js-gate-err').textContent = '请填写账号和密码。'; return; }
      btn.disabled = true; btn.textContent = '登录中…';
      $('#js-gate-err').textContent = '';
      fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(code ? { login: login, password: password, clientType: 'org', mfaCode: code } : { login: login, password: password, clientType: 'org' }),
        credentials: 'same-origin',
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (p) { return { res: res, p: p }; });
      }).then(function (out) {
        var payload = out.p && out.p.data !== undefined ? out.p.data : out.p;
        if (!out.res.ok || !payload || !payload.token) {
          var code2 = (out.p && ((out.p.error && out.p.error.code) || out.p.code)) || '';
          if (code2 === 'MFA_REQUIRED') {
            $('#js-gate-mfa').hidden = false;
            throw new Error('该账号开了二次验证，请填写动态验证码或恢复码。');
          }
          throw new Error((out.p && ((out.p.error && out.p.error.message) || out.p.message)) || ('登录失败（HTTP ' + out.res.status + '）'));
        }
        saveSession(payload);
        location.reload();          // 会话已落地：重进就是登录态，数据全按机构取
      }).catch(function (err) {
        $('#js-gate-err').textContent = err.message || '登录失败，请重试。';
        btn.disabled = false; btn.textContent = '进入专家团';
      });
    });
  })();
  function call(path, options) {
    var opt = options || {};
    var token = authToken();
    function request(withToken) {
      var headers = {};
      if (opt.body) headers['content-type'] = 'application/json';
      if (withToken && token) headers.authorization = 'Bearer ' + token;
      return fetch(API + path, {
        method: opt.method || 'GET',
        headers: Object.keys(headers).length ? headers : undefined,
        body: opt.body ? JSON.stringify(opt.body) : undefined,
        credentials: 'same-origin',
      });
    }
    return request(true).then(function (res) {
      // 带了 token 却被拒（过期 / 被停用 / 已在别处登录）：本地会话作废、回登录门。
      // 这个页面的口径是「先登录才能进」—— 悄悄降级成匿名会让门槛形同虚设。
      if (res.status === 401 && token) return sessionLost();
      return res;
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (payload) {
        if (!res.ok) {
          var msg = (payload && (payload.message || (payload.error && payload.error.message))) || ('请求失败（HTTP ' + res.status + '）');
          var err = new Error(msg); err.status = res.status; throw err;
        }
        return payload && payload.data !== undefined ? payload.data : payload;
      });
    });
  }
  function show(t, html) { if (t) t.innerHTML = html; }
  function loading(t) { show(t, '<p class="loading">' + ic('loader', 14) + '加载中…</p>'); }
  function errorBox(t, e) {
    show(t, '<p class="err">' + ic('alert', 14) + '<span>' + esc(e && e.message ? e.message : '加载失败') + '</span></p>');
  }
  function debounce(fn, ms) {
    var t = null;
    return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms || 260); };
  }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return sameDay ? (p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()))
      : (p(d.getMonth() + 1) + '-' + p(d.getDate()));
  }

  var state = {
    screen: 'chat',
    experts: [],
    expert: null,
    conversations: [],
    conversationId: null,
    messages: [],              // [{role, content, citations}]
    streaming: false,
    abort: null,
    lastQuestion: '',
    lib: { scene: '', q: '' },
    pfGroup: 'org', pfDraft: {}, profile: null, completion: null, signedIn: false, orgLabel: '',
  };

  /* ───────────── 主题 ───────────── */
  var THEME_KEY = 'junshi.theme.v1';
  function savedMode() {
    try { var v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : null; } catch (e) { return null; }
  }
  function currentMode() {
    return document.documentElement.style.colorScheme
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function applyThemeIcon(animate) {
    var btn = $('#js-theme');
    btn.innerHTML = ic(currentMode() === 'dark' ? 'sun' : 'moon', 16);
    if (!animate) return;
    btn.classList.remove('swapping');
    void btn.offsetWidth;
    btn.classList.add('swapping');
  }
  var themeTimer = null;
  $('#js-theme').addEventListener('click', function () {
    var rootEl = document.documentElement;
    rootEl.classList.add('theming');                    // 只在这个窗口里让颜色参与过渡（见 index.html 里的说明）
    var next = currentMode() === 'dark' ? 'light' : 'dark';
    rootEl.style.colorScheme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式：静默降级 */ }
    applyThemeIcon(true);
    clearTimeout(themeTimer);
    themeTimer = setTimeout(function () { rootEl.classList.remove('theming'); }, 320);
  });

  /* ───────────── 导航 ───────────── */
  var inited = {};
  function showScreen(name) {
    $$('.screen').forEach(function (s) { s.hidden = (s.id !== 'scr-' + name); });
    $$('.navitem').forEach(function (b) {
      if (b.dataset.screen === name) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    state.screen = name;
    if (!inited[name]) { inited[name] = true; (INIT[name] || function () {})(); }
  }
  $$('.navitem').forEach(function (b) { b.addEventListener('click', function () { showScreen(b.dataset.screen); }); });

  /* ───────────── 专家 + 会话列表 ───────────── */
  /** 专家列表只建一次 DOM，切换时只改 aria-pressed —— 节点不重建，选中底色才能平滑过渡
      （之前每次切换整表重建，高亮是硬跳的）。 */
  function renderExperts() {
    var box = $('#js-experts');
    $('#ex-count').textContent = state.experts.length + ' 位';
    if (box.childElementCount !== state.experts.length) {
      box.innerHTML = '';
      state.experts.forEach(function (e) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'expert';
        b.dataset.id = e.id;
        b.innerHTML = '<span style="min-width:0"><span class="ename">' + esc(e.name) + '</span><span class="etag" title="' + esc(e.tag) + '">' + esc(e.tag) + '</span></span>';
        b.addEventListener('click', function () { switchExpert(e); });
        box.appendChild(b);
      });
    }
    updateExpertSelection();
  }
  function updateExpertSelection() {
    $$('.expert').forEach(function (b) {
      b.setAttribute('aria-pressed', String(Boolean(state.expert) && b.dataset.id === state.expert.id));
    });
  }

  function fillConvRow(row, c) {
    row.querySelector('.convtitle').textContent = c.title || '（未命名）';
    row.querySelector('.convmeta').textContent = fmtTime(c.updatedAt) + (c.messageCount ? ' · ' + c.messageCount + ' 条' : '');
    row.setAttribute('aria-current', String(c.id === state.conversationId));
  }
  function buildConvRow(c) {
    var row = document.createElement('div');
    row.className = 'convrow';
    row.dataset.id = c.id;
    row.innerHTML = '<button class="convopen" type="button"><span class="convtitle"></span><span class="convmeta"></span></button>' +
      '<button class="convdel" type="button" aria-label="删除这个会话">' + ic('x', 13) + '</button>';
    row.querySelector('.convopen').addEventListener('click', function () { openConversation(c.id); });
    row.querySelector('.convdel').addEventListener('click', function () { deleteConversation(c.id); });
    fillConvRow(row, c);
    return row;
  }
  /** 退场：先量高度再收到 0，淡出的同时把位置让出来（Emil：透明度要和高度一起走） */
  function leaveConvRow(row) {
    if (row.dataset.leaving) return;
    row.dataset.leaving = '1';
    row.style.maxHeight = row.offsetHeight + 'px';
    row.style.overflow = 'hidden';
    row.classList.add('leaving');
    requestAnimationFrame(function () {
      row.style.maxHeight = '0px';
      row.style.opacity = '0';
    });
    setTimeout(function () { if (row.parentNode) row.parentNode.removeChild(row); }, 220);
  }
  /** 会话列表：按 id 就地增删改，不整表重建 —— 高亮能过渡、新会话是滑进来的、删除是收走的。
      之前的整表重建还会把 hover 状态和滚动位置一起清掉。 */
  function renderConversations() {
    var box = $('#js-convs');
    if (!box) return;
    $('#conv-count').textContent = state.conversations.length ? state.conversations.length + ' 个' : '';
    if (!state.conversations.length) {
      if (!box.querySelector('.empty')) show(box, '<p class="empty" style="padding:2px 10px">还没有会话，点上面「新对话」或直接提问。</p>');
      return;
    }
    var empty = box.querySelector('.empty');
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);

    var wanted = {};
    state.conversations.forEach(function (c) { wanted[c.id] = true; });

    var rows = {};
    var hadRows = false;
    Array.prototype.slice.call(box.querySelectorAll('.convrow')).forEach(function (row) {
      hadRows = true;
      if (row.dataset.leaving) return;
      if (wanted[row.dataset.id]) rows[row.dataset.id] = row;
      else leaveConvRow(row);
    });
    // 整批换掉（切专家）：不留旧行慢慢收，直接清掉 —— 两批一起动会互相挤位置，反而乱
    if (hadRows && !Object.keys(rows).length) box.innerHTML = '';

    var cursor = box.firstChild;
    state.conversations.forEach(function (c, i) {
      var row = rows[c.id];
      if (row) fillConvRow(row, c);
      else {
        row = buildConvRow(c);
        row.classList.add('enter');
        if (!hadRows) row.style.animationDelay = Math.min(i * 36, 180) + 'ms';   // 首次铺开才错峰（Emil：组入场 30–80ms）
      }
      while (cursor && (cursor.nodeType !== 1 || cursor.classList.contains('leaving'))) cursor = cursor.nextSibling;
      if (row === cursor) cursor = cursor.nextSibling;
      else box.insertBefore(row, cursor);
    });
  }

  // 记住「上次在哪个会话」：刷新/重开页面回到原来那段对话，而不是停在开场白。
  var LASTCONV_KEY = 'junshi.lastconv.v1';
  function rememberConversation(expertId, conversationId) {
    try {
      var all = JSON.parse(localStorage.getItem(LASTCONV_KEY) || '{}');
      if (!all || typeof all !== 'object') all = {};
      if (conversationId) all[expertId] = conversationId; else delete all[expertId];
      localStorage.setItem(LASTCONV_KEY, JSON.stringify(all));
    } catch (e) { /* 隐私模式：静默降级成不记 */ }
  }
  function lastConversationOf(expertId) {
    try { return (JSON.parse(localStorage.getItem(LASTCONV_KEY) || '{}') || {})[expertId] || null; } catch (e) { return null; }
  }

  async function loadConversations() {
    if (!state.expert) return;
    try {
      var d = await call('/conversations?expertId=' + encodeURIComponent(state.expert.id));
      state.conversations = d.conversations || [];
    } catch (e) { state.conversations = []; }
    renderConversations();
  }

  /** 进入某位专家时：优先回到上次那个会话（且它还在列表里），否则显示开场白。 */
  async function resumeOrGreet() {
    await loadConversations();
    var lastId = lastConversationOf(state.expert.id);
    if (lastId && state.conversations.some(function (c) { return c.id === lastId; })) {
      await openConversation(lastId);
    } else {
      renderHello();
    }
    animatePanelSwap();       // 等内容就位再换气，不在旧内容上先淡一次
  }

  /** 面板整块换内容时的一次轻换气（见 index.html 里 .conv.swap 的说明） */
  function animatePanelSwap() {
    var conv = $('.conv');
    if (!conv) return;
    conv.classList.remove('swap');
    void conv.offsetWidth;
    conv.classList.add('swap');
  }

  function switchExpert(e) {
    if (state.streaming) return;
    state.expert = e;
    state.conversationId = null;
    state.messages = [];
    renderExperts();
    $('#conv-name').textContent = e.name;
    $('#conv-tag').textContent = e.tag;
    resumeOrGreet();
  }

  function newConversation() {
    if (state.streaming) return;
    state.conversationId = null;
    state.messages = [];
    rememberConversation(state.expert.id, null);
    renderHello();
    renderConversations();
  }

  async function openConversation(id) {
    if (state.streaming || id === state.conversationId) return;
    loading($('#js-msgs'));
    try {
      var d = await call('/conversations/' + encodeURIComponent(id));
      state.conversationId = d.conversation.id;
      rememberConversation(state.expert.id, d.conversation.id);
      state.messages = d.messages || [];
      renderMessages();
      renderConversations();
      var last = d.messages[d.messages.length - 1];
      if (last && last.citations) renderRefs(last.citations);
      else $('#js-refs').innerHTML = '<p class="empty">这一轮没有引用记录。</p>';
    } catch (e) { errorBox($('#js-msgs'), e); }
  }

  async function deleteConversation(id) {
    if (state.streaming) return;
    try {
      await call('/conversations/' + encodeURIComponent(id), { method: 'DELETE' });
      if (id === state.conversationId) { state.conversationId = null; state.messages = []; renderHello(); }
      await loadConversations();
    } catch (e) { $('#js-hint').textContent = '删除失败：' + e.message; }
  }

  /* ───────────── 消息渲染 ───────────── */
  /** appendMsg 的开关：enter=false 不放进场动画（整表重排时用），scroll=false 不跟随滚动。 */
  function appendMsg(role, content, opts) {
    var o = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'msg' + (role === 'user' ? ' me' : '') + (o.enter === false ? '' : ' enter');
    wrap.innerHTML = '<div class="bubblewrap"><div class="bubble"></div>' +
      (role === 'assistant' && !o.plain ? '<div class="msgactions"></div>' : '') + '</div>';
    var bubbleEl = wrap.querySelector('.bubble');
    // 助手的回答按轻量 Markdown 渲染（模型写的是 Markdown，之前原样输出＝满屏裸露的 ** 星号）；
    // 流式中的占位（plain）与用户消息保持纯文本。
    if (role === 'assistant' && !o.plain) bubbleEl.innerHTML = mdHtml(content);
    else bubbleEl.textContent = content;
    if (o.stopped) bubbleEl.insertAdjacentHTML('beforeend', '<span class="stopped">（已停止）</span>');
    if (role === 'assistant' && !o.plain) attachActions(wrap, o);
    $('#js-msgs').appendChild(wrap);
    if (o.scroll !== false) scrollBottom(true);
    return bubbleEl;
  }

  /** 按钮文案切换：内容立刻换（不延迟响应），只让新文案从模糊里淡进来。 */
  function setLabel(btn, html) {
    btn.innerHTML = '<span class="btnlabel swap">' + html + '</span>';
  }

  /** 助手消息下面的操作条：复制恒有；最后一条额外给「重新生成」。 */
  function attachActions(wrap, o) {
    var bar = wrap.querySelector('.msgactions');
    if (!bar) return;
    bar.innerHTML = '<button class="msgact" type="button" data-act="copy">' + ic('copy', 12) + '复制</button>' +
      (o.last ? '<button class="msgact" type="button" data-act="regen">' + ic('refresh', 12) + '重新生成</button>' : '');
    bar.querySelector('[data-act="copy"]').addEventListener('click', function () {
      var text = wrap.querySelector('.bubble').textContent;
      var done = function () {
        var btn = bar.querySelector('[data-act="copy"]');
        if (!btn) return;
        setLabel(btn, ic('check', 12) + '已复制');
        setTimeout(function () { var b = bar.querySelector('[data-act="copy"]'); if (b) setLabel(b, ic('copy', 12) + '复制'); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
        document.body.removeChild(ta); done();
      }
    });
    var regen = bar.querySelector('[data-act="regen"]');
    if (regen) regen.addEventListener('click', function () { regenerate(); });
  }

  /** keepPos：流式收尾时的重排要留在原位（用户可能正在往上读），别把人拽到底。
   *  重排也**不给每条消息放进场动画** —— 是同一批内容，重放动画＝刚读完的一屏无端抖一下。 */
  function renderMessages(keepPos) {
    var box = $('#js-msgs');
    var prevTop = box.scrollTop;
    box.innerHTML = '';
    var lastAi = -1;
    state.messages.forEach(function (m, i) { if (m.role === 'assistant' && (m.content || '').trim()) lastAi = i; });
    state.messages.forEach(function (m, i) {
      if (m.role !== 'user' && !(m.content || '').trim()) return;    // 空助手＝被打断的占位
      appendMsg(m.role, m.content, { last: i === lastAi, enter: false, scroll: false, stopped: m.stopped });
    });
    var last = state.messages[state.messages.length - 1];
    if (last && last.role === 'user') {
      var note = document.createElement('div');
      note.className = 'status';
      note.innerHTML = ic('alert', 13) + '<span>上一条没答完（可能刷新或关过页面），可以点「重新生成」或再问一次</span>';
      box.appendChild(note);
    }
    if (keepPos && !stick) box.scrollTop = prevTop;
    else scrollBottom(true);
  }

  function renderHello() {
    var e = state.expert;
    var s = (e.starters || []).map(function (q, i) {
      return '<button class="starter" type="button" data-starter="' + i + '">' + ic('sparkle', 13) + '<span>' + esc(q) + '</span></button>';
    }).join('');
    $('#js-msgs').innerHTML =
      '<div class="hello"><div class="msg"><div class="bubble">' + esc(e.greeting) + '</div></div>' +
      (s ? '<div class="starters">' + s + '</div>' : '') + '</div>';
    $('#js-refs').innerHTML = '<p class="empty">发出问题后，这里会显示这次回答参考了你资料库里的哪几份文件。</p>';
    $('#ref-count').textContent = '';
    stick = true; setJumpVisible(false);          // 新开场＝新上下文，跟随状态归位
    root.querySelectorAll('[data-starter]').forEach(function (b) {
      b.addEventListener('click', function () {
        $('#js-input').value = state.expert.starters[Number(b.dataset.starter)];
        send({});
      });
    });
  }

  /*  ── 跟随滚动（Apple：别抢用户的位置）──
   * 贴着底部时才自动跟；离底超过 28px 视为「在读旧内容」，此时流式输出不再拉回，
   * 改浮一个「回到最新」。之前是每个 delta 无条件 scrollBottom()，实测用户上翻后被按着头拽回底部。 */
  var stick = true;
  function nearBottom() {
    var box = $('#js-msgs');
    return box.scrollHeight - box.scrollTop - box.clientHeight <= 28;
  }
  function scrollBottom(force) {
    if (!force && !stick) return;
    var box = $('#js-msgs');
    box.scrollTop = box.scrollHeight;
    stick = true;
  }
  function setJumpVisible(on) {
    var j = $('#js-jump');
    if (!j) return;
    j.classList.toggle('show', on);
    j.tabIndex = on ? 0 : -1;
    j.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
  $('#js-msgs').addEventListener('scroll', function () {
    stick = nearBottom();
    setJumpVisible(!stick);
    // 输入条上沿的发丝线：只有内容真的滚到它下面才出现（规范里的「滚动边缘」，不是一道常驻横线）
    var c = $('.composer');
    if (c) c.classList.toggle('scrolled', $('#js-msgs').scrollTop > 8);
  }, { passive: true });
  $('#js-jump').addEventListener('click', function () { scrollBottom(true); });

  /* ───────────── 对话（SSE）──────────── */
  function setComposerBusy(busy) {
    state.streaming = busy;
    var send = $('#js-send');
    setLabel(send, busy ? ic('x', 14) + '停止' : ic('arrow-up', 15) + '发送');   // 上箭头＝iOS 消息的发法
    send.classList.toggle('primary', !busy);
    send.classList.toggle('stop', busy);
    $('#js-input').disabled = busy;
    // 流式期间消息区在不停变字，先让读屏器别逐字播报，收尾那次重排再一次性念（aria-busy 的用法）
    $('#js-msgs').setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  async function streamChat(payload, bubble) {
    state.abort = new AbortController();
    var statusEl = document.createElement('div');
    statusEl.className = 'status';
    statusEl.innerHTML = ic('loader', 13) + '<span>正在连接…</span>';
    bubble.parentNode.parentNode.appendChild(statusEl);
    var answer = '';
    var lastStatus = 'init';
    function setStatus(text, spin) {
      var key = (spin ? '1' : '0') + '|' + text;
      if (key === lastStatus) return;      // 推理模型会推几百个 thinking，状态没变就别重写 DOM
      lastStatus = key;
      statusEl.innerHTML = (spin ? ic('loader', 13) : '') + (text ? '<span>' + esc(text) + '</span>' : '');
      statusEl.className = 'status' + (spin && !text ? ' dots' : '');
    }

    try {
      var token = authToken();
      var chatFetch = function (withToken) {
        var headers = { 'content-type': 'application/json' };
        if (withToken && token) headers.authorization = 'Bearer ' + token;
        return fetch(API + '/chat', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload),
          credentials: 'same-origin',
          signal: state.abort.signal,
        });
      };
      var res = await chatFetch(Boolean(token));
      if (res.status === 401 && token) sessionLost();   // 会话失效：回登录门（不再悄悄降级匿名）
      if (!res.ok || !res.body) {
        var p = null;
        try { p = await res.json(); } catch (e) { /* 非 JSON */ }
        throw new Error((p && (p.message || (p.error && p.error.message))) || ('服务返回 HTTP ' + res.status));
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buffer = '';
      var event = '';
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
          var data;
          try { data = JSON.parse(line.slice(6)); } catch (e) { continue; }
          if (event === 'start') {
            if (data.conversationId) { state.conversationId = data.conversationId; rememberConversation(state.expert.id, data.conversationId); }
            if (data.title) state.conversations = [{ id: data.conversationId, expertId: state.expert.id, title: data.title, messageCount: 1, updatedAt: new Date().toISOString() }]
              .concat(state.conversations.filter(function (c) { return c.id !== data.conversationId; }));
            renderConversations();
          } else if (event === 'status') setStatus(data.text, true);
          else if (event === 'citations') renderRefs(data);
          else if (event === 'thinking') setStatus('正在思考', true);
          else if (event === 'delta') {
            answer += data.text || '';
            bubble.textContent = answer;         // 直接换文本，不逐字做动效 —— 那会干扰阅读
            if (answer) setStatus('', false);
            scrollBottom();
          } else if (event === 'error') throw new Error(data.message || '生成失败');
          else if (event === 'reset') { answer = ''; bubble.textContent = ''; }   // 服务端重试：清空气泡
          else if (event === 'stopped') { /* 已把部分内容留在 answer 里 */ }
        }
      }
      if (!answer.trim()) bubble.textContent = '（这次没有生成内容，可以再试一次）';
      return answer;
    } finally {
      if (statusEl.parentNode) statusEl.remove();
      state.abort = null;
    }
  }

  async function send(opts) {
    var o = opts || {};
    if (state.streaming || !state.expert) return;
    var input = $('#js-input');
    var text = o.content !== undefined ? o.content : input.value.trim();
    if (!text) return;
    if (o.content === undefined) { input.value = ''; input.style.height = ''; }
    $('#js-hint').textContent = '';
    state.lastQuestion = text;

    var hello = $('#js-msgs').querySelector('.hello');
    if (hello) hello.remove();
    if (!o.regenerate) {
      appendMsg('user', text, { plain: true });
      state.messages.push({ role: 'user', content: text });
    }
    var bubble = appendMsg('assistant', '', { plain: true });
    setComposerBusy(true);

    try {
      var answer = await streamChat({
        conversationId: state.conversationId,
        expertId: state.expert.id,
        content: text,
        regenerate: Boolean(o.regenerate),
      }, bubble);
      if (answer.trim()) {
        state.messages.push({ role: 'assistant', content: answer });
        renderMessages(true);          // 收尾重排留在原位：用户上翻读旧内容时不被拽回底部
      } else {
        // ⚠️ 空回答时**不要**走 renderMessages：它按 state.messages 重建 DOM，此时里面只有用户那条，
        //    会把刚写上去的「这次没有生成内容」提示一起冲掉（与上面 stopped 分支同一个坑）。
        bubble.textContent = '（这次没有生成内容，可以再试一次）';
      }
      loadConversations();
    } catch (e) {
      var stopped = e && (e.name === 'AbortError' || String(e.message).indexOf('abort') >= 0);
      if (stopped) {
        var partial = bubble.textContent || '';
        if (partial.trim()) {
          // 「已停止」的标记跟着内容一起进 state —— 之前是先把标记写进 DOM 再重排，
          // 重排按 state 重建，那句标记会被冲掉（用户看到一段没有交代的截断）。
          state.messages.push({ role: 'assistant', content: partial, stopped: true });
          renderMessages(true);
        } else {
          // 一个字都没生成：**不要**重排（重排会把刚写上去的提示一起冲掉，线上实测到过）
          bubble.textContent = '（已停止生成）';
        }
        loadConversations();
      } else {
        bubble.textContent = '';
        bubble.parentNode.innerHTML = '<div class="err">' + ic('alert', 14) + '<span>' + esc(e.message || '出错了') + '</span></div>';
        state.messages.pop();     // 把刚 push 的用户消息撤回去，避免界面上留下一条没答的
      }
    } finally {
      setComposerBusy(false);
      try { input.focus({ preventScroll: true }); } catch (err) { input.focus(); }
      scrollBottom();      // 贴着底才跟；用户上翻过就留在原地（原来那两行清 scrollTop 是老布局的残留，已删）
    }
  }

  function regenerate() {
    if (state.streaming) return;
    var q = '';
    for (var i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') { q = state.messages[i].content; break; }
    }
    if (!q) { $('#js-hint').textContent = '没找到可重答的问题。'; return; }
    var last = state.messages[state.messages.length - 1];
    if (last && last.role === 'assistant') {
      state.messages.pop();                       // 界面上先移除旧回答，服务端也会删掉那条
      renderMessages(true);
    }
    send({ content: q, regenerate: true });
  }

  function renderRefs(c) {
    var items = [];
    // ⚠️ 必须编号，且编号要和回答里说的「资料N」对得上：模型的 资料N = 第 N 段检索原文。
    (c.chunks || []).forEach(function (x, i) {
      items.push('<div class="ref"><b>资料' + (i + 1) + '：' + esc(x.title) + '</b><span>' + esc((x.domain || []).join(' / ')) + '</span>' +
        (x.excerpt ? '<p>' + esc(x.excerpt) + '…</p>' : '') + '</div>');
    });
    (c.hooks || []).forEach(function (n) {
      items.push('<div class="ref"><b>玩法：' + esc(n) + '</b><span>资料库 · 玩法库</span></div>');
    });
    (c.objections || []).forEach(function (q) {
      items.push('<div class="ref"><b>' + esc(q) + '</b><span>资料库 · 异议库</span></div>');
    });
    if (c.copies) items.push('<div class="ref"><b>同类文案 ' + c.copies + ' 条</b><span>资料库 · 文案库</span></div>');
    if (c.hasProfile) items.push('<div class="ref"><b>你的机构画像</b><span>回答已结合你的品类与价格</span></div>');
    $('#ref-count').textContent = items.length ? items.length + ' 项' : '';
    show($('#js-refs'), items.length ? items.join('') :
      '<p class="empty">这次没有检索到直接相关的资料，回答基于行业常识。可以先在「机构画像」里补全信息，命中率会更高。</p>');
    var body = $('#js-refs');
    if (body) body.scrollTop = 0;
  }

  /* ───────────── 知识库 ───────────── */
  function renderLib() {
    var box = $('#js-lib'); if (!box) return;
    loading(box);
    var qs = ['limit=40'];
    if (state.lib.q) qs.push('q=' + encodeURIComponent(state.lib.q));
    if (state.lib.scene) qs.push('scene=' + encodeURIComponent(state.lib.scene));
    call('/library?' + qs.join('&')).then(function (d) {
      $('#js-count').textContent = d.total + ' 条';
      if (!d.items.length) { show(box, '<p class="empty">没有匹配。试试更短的关键词，或换个场景。</p>'); return; }
      box.innerHTML = d.items.map(function (it) {
        return '<div class="doc" style="cursor:default"><span class="tag">' + esc(it.kind) + '</span>' +
          '<b style="font-weight:400">' + esc(it.t) + '</b><em>' + esc(it.cat) + '</em></div>';
      }).join('');
    }).catch(function (e) { errorBox(box, e); });
  }

  /* ───────────── 合规体检 ─────────────
     两层：① 词表快检（确定性规则引擎，移植自开源项目 traffic-compass 的 engine.py：
     L2 词库 + 白名单防误杀 + 语境窗口 + 资质红线）② AI 深度审读（读语境 + 最小改动建议）。 */
  var SEV = { high: { icon: '🔴', color: 'var(--red)' }, mid: { icon: '🟠', color: 'var(--heat)' }, low: { icon: '🟡', color: 'var(--text-3)' } };
  function runCompliance() {
    var content = $('#cs-text').value.trim();
    var out = $('#cs-out');
    if (!content) { show(out, '<p class="empty">先贴一段文案。</p>'); return; }
    loading(out);
    show($('#cs-ai-out'), '');
    call('/compliance', { method: 'POST', body: { content: content } }).then(function (d) {
      var color = d.verdict.level === 'block' ? 'var(--red)' : d.verdict.level === 'fix' ? 'var(--heat)' : 'var(--green)';
      var head = '<p class="lead" style="color:' + color + ';font-weight:600">' + esc(d.verdict.text) +
        '<em style="font-style:normal;font-weight:400;color:var(--text-3)">（词表命中 ' + d.total + ' 处）</em></p>';
      var redlines = (d.redlines || []).map(function (r) {
        return '<div class="bench"><span>⛔ <b style="font-weight:600">' + esc(r.field) + '红线</b>：命中「' + esc(r.trigger) + '」<br>' +
          '<em style="font-style:normal;font-size:12px;color:var(--text-3)">' + esc(r.note) + '</em></span></div>';
      }).join('');
      var hits = (d.hits || []).map(function (h) {
        var s = SEV[h.severity] || SEV.mid;
        return '<div class="bench"><span>' + s.icon + ' <b style="font-weight:600;color:' + s.color + '">' + esc(h.word) + '</b>' +
          (h.count > 1 ? '<em style="font-style:normal;font-size:12px;color:var(--text-3)">×' + h.count + '</em>' : '') +
          ' <em style="font-style:normal;font-size:12px;color:var(--text-3)">' + esc(h.category) + '</em><br>' +
          '<em style="font-style:normal;font-size:12px;color:var(--text-3)">改成：' + esc(h.replace) + (h.note ? '｜' + esc(h.note) : '') + '</em></span></div>';
      }).join('');
      var wl = (d.whitelist || []).length
        ? '<p class="lead" style="margin-top:10px;color:var(--text-3)">已放行（防误杀）：' + d.whitelist.map(esc).join('；') + '</p>' : '';
      var risky = (d.risky || []).length
        ? '<p class="err" style="margin-top:12px;background:var(--heat-bg);color:var(--heat)">' + ic('alert', 14) +
          '<span>还需人工确认：<br>' + d.risky.map(esc).join('<br>') + '</span></p>' : '';
      show(out, head + redlines + hits + wl + risky);
      if ($('#cs-rules') && d.rules) {
        $('#cs-rules').textContent = '规则：' + d.rules.name + ' · 移植自开源项目 traffic-compass（MIT），' + d.rules.updated + ' 更新';
      }
      runAiReview(content);        // 词表跑完自动接 AI 深度审读
    }).catch(function (e) { errorBox(out, e); });
  }

  /** AI 深度审读：SSE 流式收 JSON，收完解析成结构化结果（解析失败就按 Markdown 渲染原文） */
  function runAiReview(content) {
    var box = $('#cs-ai-out');
    if (!box) return;
    var answer = '';
    var statusText = 'AI 正在读语境…';
    function paint() {
      var html = '<div class="ptitle" style="padding:0 0 6px;border:0">AI 深度审读<small>' + esc(statusText || (answer ? '已收到 ' + answer.length + ' 字' : '')) + '</small></div>';
      if (answer) html += '<div class="bubble" style="max-width:100%;background:var(--fill-2)" data-ai-raw></div>';
      box.innerHTML = html;
      if (answer) box.querySelector('[data-ai-raw]').textContent = answer;
    }
    paint();
    var headers = { 'content-type': 'application/json' };
    var token = authToken();
    if (token) headers.authorization = 'Bearer ' + token;
    fetch(API + '/compliance/review', { method: 'POST', headers: headers, body: JSON.stringify({ content: content }), credentials: 'same-origin' })
      .then(function (res) {
        if (res.status === 401 && token) sessionLost();
        if (!res.ok || !res.body) throw new Error('审读失败（HTTP ' + res.status + '）');
        var reader = res.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = ''; var event = '';
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) return;
            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach(function (line) {
              if (line.indexOf('event: ') === 0) { event = line.slice(7).trim(); return; }
              if (line.indexOf('data: ') !== 0) return;
              var data; try { data = JSON.parse(line.slice(6)); } catch (e) { return; }
              if (event === 'status') { statusText = data.text || ''; paint(); }
              else if (event === 'delta') { answer += data.text || ''; statusText = ''; paint(); }
              else if (event === 'error') throw new Error(data.message || '审读失败');
            });
            return pump();
          });
        }
        return pump();
      })
      .then(function () { renderAiReport(box, answer); })
      .catch(function (e) {
        box.innerHTML = '<div class="ptitle" style="padding:0 0 6px;border:0">AI 深度审读</div>' +
          '<div class="err">' + ic('alert', 14) + '<span>' + esc(e.message || 'AI 审读失败，可以再点一次「开始检查」') + '</span></div>';
      });
  }

  /** 把 AI 的 JSON 报告渲染成结构化结果；不是 JSON 就按 Markdown 原文渲染 */
  function renderAiReport(box, raw) {
    var text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    var report = null;
    try { report = JSON.parse(text); } catch (e) { /* 降级 */ }
    var head = '<div class="ptitle" style="padding:0 0 8px;border:0">AI 深度审读<small>读语境 · 最小改动建议</small></div>';
    if (!report || typeof report !== 'object') {
      box.innerHTML = head + '<div class="bubble" style="max-width:100%;background:var(--fill-2)">' + mdHtml(text || '（没有拿到审读结果）') + '</div>';
      return;
    }
    var parts = [head];
    var vs = report.violations || [];
    if (vs.length) {
      parts.push(vs.map(function (v) {
        var s = SEV[v.severity] || SEV.mid;
        return '<div class="bench"><span>' + s.icon + ' <b style="font-weight:600;color:' + s.color + '">' + esc(v.text || '') + '</b>' +
          '<em style="font-style:normal;font-size:12px;color:var(--text-3)"> ' + esc(v.category || '') + '</em><br>' +
          '<em style="font-style:normal;font-size:12px;color:var(--text-3)">为什么：' + esc(v.reason || '') + '</em><br>' +
          '<em style="font-style:normal;font-size:12px;color:var(--text-2)">改成：' + esc(v.suggest || '') + '</em></span></div>';
      }).join(''));
    } else {
      parts.push('<p class="lead" style="color:var(--green);font-weight:600">AI 读完语境没找到违规点。</p>');
    }
    if ((report.whitelist_notes || []).length) parts.push('<p class="lead" style="margin-top:10px;color:var(--text-3)">已放行：' + report.whitelist_notes.map(esc).join('；') + '</p>');
    if ((report.highlights || []).length) parts.push('<p class="lead" style="margin-top:8px;color:var(--text-2)">写得好的地方：' + report.highlights.map(esc).join('；') + '</p>');
    if ((report.improvements || []).length) {
      parts.push('<div class="ptitle" style="padding:12px 0 6px;border:0">建议（保留你的口语腔）</div>' +
        report.improvements.map(function (t) { return '<p class="lead" style="margin-bottom:6px">· ' + esc(t) + '</p>'; }).join(''));
    }
    if (report.summary) parts.push('<p class="lead" style="margin-top:10px;color:var(--text-3)">' + esc(report.summary) + '</p>');
    box.innerHTML = parts.join('');
  }

  /* ───────────── 机构画像 ───────────── */
  var GROUPS = [
    ['org', '基本信息', ['name', 'shortName', 'foundedYear', 'city', 'campuses']],
    ['product', '产品体系', ['categories', 'classTypes', 'unitPrice', 'mainPackage', 'discountFloor']],
    ['teacher', '师资信息', ['headcount', 'education', 'seniority', 'star']],
    ['biz', '经营数据', ['students', 'perCampus', 'fullRate', 'renewRate']],
    ['reach', '触达方式', ['wecomQr', 'officialAccount', 'douyin', 'phone', 'addressScript']],
    ['cases', '案例素材', ['caseStudy', 'praise', 'achievements']],
    ['risk', '合规红线', ['forbiddenWords', 'noPromise', 'prepayRule']],
  ];
  var FIELD_LABEL = {
    name: '机构名称', shortName: '简称', foundedYear: '成立年份', city: '城市', campuses: '校区分布',
    categories: '课程品类', classTypes: '班型', unitPrice: '课时单价', mainPackage: '主力课包', discountFloor: '优惠底线',
    headcount: '教师人数', education: '学历构成', seniority: '教龄构成', star: '明星教师',
    students: '在读学员', perCampus: '分校区人数', fullRate: '满班率', renewRate: '历史续班率',
    wecomQr: '企业微信活码', officialAccount: '公众号', douyin: '抖音号', phone: '联系电话', addressScript: '地址话术',
    caseStudy: '学员案例', praise: '家长好评', achievements: '成果数据',
    forbiddenWords: '不能说的词', noPromise: '不能承诺的事', prepayRule: '预收费规则',
  };
  function renderPfGroups() {
    var box = $('#pf-groups'); if (!box) return;
    box.innerHTML = '';
    var missing = (state.completion && state.completion.missing) || [];
    GROUPS.forEach(function (g) {
      var miss = missing.indexOf(g[0]) >= 0;
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'scene';
      b.setAttribute('aria-pressed', String(state.pfGroup === g[0]));
      b.innerHTML = g[1] + '<span style="' + (miss ? '' : 'color:var(--green)') + '">' + (miss ? '待补充' : '已完成') + '</span>';
      b.addEventListener('click', function () { state.pfGroup = g[0]; renderPfGroups(); renderPfFields(); });
      box.appendChild(b);
    });
  }
  function renderPfFields() {
    var g = GROUPS.filter(function (x) { return x[0] === state.pfGroup; })[0];
    if (!g) return;
    $('#pf-title').textContent = g[1];
    var bag = (state.pfDraft[g[0]] || {});
    $('#pf-fields').innerHTML = g[2].map(function (f) {
      return '<div class="field"><label for="pf_' + f + '">' + esc(FIELD_LABEL[f] || f) + '</label>' +
        '<input id="pf_' + f + '" data-pf="' + f + '" type="text" value="' + esc(bag[f] || '') + '" placeholder="待补充"' +
        (state.signedIn ? '' : ' disabled') + '></div>';
    }).join('');
    $('#pf-msg').textContent = state.signedIn ? ('已登录' + (state.orgLabel ? '：' + state.orgLabel : '') + '，改完点「保存」。') : '';
  }
  function renderProfile() {
    var pct = state.completion ? state.completion.percent : 0;
    $('#pf-percent').textContent = '完成度 ' + pct + '%';
    $('#pf-bar').style.width = pct + '%';
    var loginBox = $('#pf-login');
    if (loginBox) loginBox.hidden = state.signedIn;      // 未登录才显示「登录机构账号」入口
    var saveBtn = $('#pf-save');
    if (saveBtn) saveBtn.disabled = !state.signedIn;     // 未登录时「保存」就是禁用态，别让人白点
    state.pfDraft = {};
    GROUPS.forEach(function (g) { state.pfDraft[g[0]] = Object.assign({}, (state.profile && state.profile[g[0]]) || {}); });
    renderPfGroups();
    renderPfFields();
  }
  function collectProfile() {
    var draft = JSON.parse(JSON.stringify(state.pfDraft));
    $$('[data-pf]').forEach(function (inp) {
      var bag = draft[state.pfGroup] || (draft[state.pfGroup] = {});
      if (inp.value.trim()) bag[inp.dataset.pf] = inp.value.trim();
      else delete bag[inp.dataset.pf];
    });
    return draft;
  }
  function saveProfile() {
    if (!state.signedIn) { $('#pf-msg').textContent = '还没登录：先点上面的「登录机构账号」，登录后回到本页即可保存。'; return; }
    var draft = collectProfile();
    state.pfDraft = draft;
    $('#pf-msg').textContent = '保存中…';
    call('/profile', { method: 'PUT', body: { profile: draft } }).then(function (d) {
      state.profile = d.profile; state.completion = d.completion;
      $('#pf-msg').textContent = '已保存。专家现在会按这些信息回答。';
      renderProfile();
    }).catch(function (e) { $('#pf-msg').textContent = '保存失败：' + e.message; });
  }

  /* ───────────── 各屏首次进入 ───────────── */
  var INIT = {
    chat: function () { renderExperts(); renderConversations(); },
    library: function () {
      renderLib();
      call('/library/facets').then(function (f) {
        var box = $('#lib-scenes'); box.innerHTML = '';
        [''].concat(f.scene.slice(0, 14).map(function (x) { return x.k; })).forEach(function (s) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'chip';
          b.setAttribute('aria-pressed', String(state.lib.scene === s));
          var found = f.scene.filter(function (x) { return x.k === s; })[0];
          b.textContent = (s || '全部场景') + (found ? '（' + found.n + '）' : '');
          b.addEventListener('click', function () { state.lib.scene = s; INIT.library(); });
          box.appendChild(b);
        });
      }).catch(function () {});
    },
    compliance: function () {},
    profile: renderProfile,
  };

  /* ───────────── 事件 ───────────── */
  $('#js-send').addEventListener('click', function () {
    if (state.streaming) {                    // 忙时这个按钮是「停止」
      if (state.abort) state.abort.abort();
      return;
    }
    send({});
  });
  $('#js-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send({}); }
  });
  $('#js-input').addEventListener('input', function (e) {
    e.target.style.height = '';
    e.target.style.height = Math.min(e.target.scrollHeight, 168) + 'px';
  });
  $('#conv-reset').addEventListener('click', newConversation);
  $('#js-logout').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    var token = authToken();
    // 服务端登出（作废这个会话）→ 本地清会话 → 回登录门；服务端失败也要能本地退出
    fetch('/api/auth/logout', { method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : undefined, credentials: 'same-origin' })
      .catch(function () { })
      .then(function () { clearSession(); location.reload(); });
  });
  $('#js-q').addEventListener('input', debounce(function (e) { state.lib.q = e.target.value.trim(); renderLib(); }, 300));
  $('#cs-run').addEventListener('click', runCompliance);
  $('#cs-demo').addEventListener('click', function () {
    $('#cs-text').value = '我们是烟台最大的美术教育机构，老师都是最好的，全网最低价，保证孩子第一节课就爱上画画。活动原价199元现价0元，还抽红包墙大奖。';
    runCompliance();
  });
  $('#pf-save').addEventListener('click', saveProfile);

  /* ───────────── 启动 ───────────── */
  // 默认给浅色：这套苹果体系（浅灰白底 + 白面板）的主场是浅色；用户切过深色就记住他的选择。
  var bootMode = savedMode() || 'light';
  document.documentElement.style.colorScheme = bootMode;
  applyThemeIcon();

  // 先登录才能进入（2026-10-16 用户口径）：没有会话就停在登录门，**业务接口一个都不请求**。
  if (!authSession()) showGate('');
  else Promise.all([
    call('/experts').catch(function () { return { experts: [] }; }),
    call('/overview').catch(function () { return null; }),
  ]).then(function (out) {
    var ex = out[0], ov = out[1];
    state.experts = ex.experts || [];
    if (!state.experts.length) {
      $('#js-msgs').innerHTML = '<p class="err">' + ic('alert', 14) + '<span>专家列表没加载出来，刷新一下试试。</span></p>';
    } else {
      state.expert = state.experts[0];
    }
    if (ov) {
      state.profile = ov.profile;
      state.completion = ov.completion;
      // 登录态以服务端为准（signedIn）：原来拿「画像里有没有机构名」猜，会把「刚登录、
      // 画像还空着」的用户判成未登录、输入框全部禁用 —— 那是条死路（2026-10-16 修）。
      state.signedIn = Boolean(ov.signedIn);
      state.orgLabel = ov.orgName || ov.userName || '';
      // 顶栏把登录身份亮出来（登录态可见，才能分清「已登录」和「没提示登录」）
      $('#js-who').textContent = state.orgLabel;
      $('#js-who').hidden = !state.signedIn;
      $('#js-logout').hidden = !state.signedIn;
      $('#js-today').textContent = ov.today;
      $('#js-sidenote').innerHTML = '专家回答会先检索你自己的资料库，再结合机构画像。<br>' +
        '本月主线：' + esc((ov.calendar[String(ov.month)] || {}).launch || '');
    }
    if (state.expert) switchExpert(state.expert);
    else renderExperts();
    showScreen(state.screen);
  });
})();
