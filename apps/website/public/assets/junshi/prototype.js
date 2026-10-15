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
  /** 内联 sprite 图标。尺寸走 width/height 属性。 */
  function ic(name, size) {
    var px = size || 14;
    return '<svg class="ic" width="' + px + '" height="' + px + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }
  function call(path, options) {
    var opt = options || {};
    return fetch(API + path, {
      method: opt.method || 'GET',
      headers: opt.body ? { 'content-type': 'application/json' } : undefined,
      body: opt.body ? JSON.stringify(opt.body) : undefined,
      credentials: 'same-origin',
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
    pfGroup: 'org', pfDraft: {}, profile: null, completion: null, guest: true,
  };

  /* ───────────── 主题 ───────────── */
  function applyThemeIcon() {
    var mode = document.documentElement.style.colorScheme
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    $('#js-theme').innerHTML = ic(mode === 'dark' ? 'sun' : 'moon', 16);
  }
  $('#js-theme').addEventListener('click', function () {
    var cur = document.documentElement.style.colorScheme
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.style.colorScheme = cur === 'dark' ? 'light' : 'dark';
    applyThemeIcon();
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
  function renderExperts() {
    var box = $('#js-experts');
    $('#ex-count').textContent = state.experts.length + ' 位';
    box.innerHTML = '';
    state.experts.forEach(function (e) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'expert';
      b.setAttribute('aria-pressed', String(state.expert && state.expert.id === e.id));
      b.innerHTML = '<span class="eavatar">' + esc(e.avatar) + '</span>' +
        '<span style="min-width:0"><span class="ename">' + esc(e.name) + '</span><span class="etag">' + esc(e.tag) + '</span></span>';
      b.addEventListener('click', function () { switchExpert(e); });
      box.appendChild(b);
    });
  }

  function renderConversations() {
    var box = $('#js-convs');
    if (!box) return;
    $('#conv-count').textContent = state.conversations.length ? state.conversations.length + ' 个' : '';
    if (!state.conversations.length) {
      show(box, '<p class="empty" style="padding:2px 10px">还没有会话，点上面「新对话」或直接提问。</p>');
      return;
    }
    box.innerHTML = '';
    state.conversations.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'convrow';
      row.setAttribute('aria-current', String(c.id === state.conversationId));
      row.innerHTML = '<button class="convopen" type="button"><span class="convtitle">' + esc(c.title || '（未命名）') + '</span>' +
        '<span class="convmeta">' + esc(fmtTime(c.updatedAt)) + ' · ' + c.messageCount + ' 条</span></button>' +
        '<button class="convdel" type="button" aria-label="删除这个会话">' + ic('x', 13) + '</button>';
      row.querySelector('.convopen').addEventListener('click', function () { openConversation(c.id); });
      row.querySelector('.convdel').addEventListener('click', function () { deleteConversation(c.id); });
      box.appendChild(row);
    });
  }

  async function loadConversations() {
    if (!state.expert) return;
    try {
      var d = await call('/conversations?expertId=' + encodeURIComponent(state.expert.id));
      state.conversations = d.conversations || [];
    } catch (e) { state.conversations = []; }
    renderConversations();
  }

  function switchExpert(e) {
    if (state.streaming) return;
    var same = state.expert && state.expert.id === e.id;
    state.expert = e;
    state.conversationId = null;
    state.messages = [];
    renderExperts();
    $('#conv-avatar').textContent = e.avatar;
    $('#conv-name').textContent = e.name;
    $('#conv-tag').textContent = e.tag;
    var conv = $('.conv');
    if (!same && conv) {
      conv.style.animation = 'none';
      void conv.offsetHeight;
      conv.style.animation = 'bubble-in var(--t-enter) var(--ease-out) both';
    }
    renderHello();
    loadConversations();
  }

  function newConversation() {
    if (state.streaming) return;
    state.conversationId = null;
    state.messages = [];
    renderHello();
    renderConversations();
  }

  async function openConversation(id) {
    if (state.streaming || id === state.conversationId) return;
    loading($('#js-msgs'));
    try {
      var d = await call('/conversations/' + encodeURIComponent(id));
      state.conversationId = d.conversation.id;
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
  function appendMsg(role, content, opts) {
    var o = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'msg' + (role === 'user' ? ' me' : '');
    var who = role === 'user' ? '我' : (state.expert ? state.expert.avatar : '军师');
    wrap.innerHTML = '<span class="mavatar">' + esc(who) + '</span>' +
      '<div class="bubblewrap"><div class="bubble"></div>' +
      (role === 'assistant' && !o.plain ? '<div class="msgactions"></div>' : '') + '</div>';
    wrap.querySelector('.bubble').textContent = content;
    if (role === 'assistant' && !o.plain) attachActions(wrap, o);
    $('#js-msgs').appendChild(wrap);
    scrollBottom();
    return wrap.querySelector('.bubble');
  }

  /** 助手消息下面的操作条：复制恒有；最后一条额外给「重新生成」。 */
  function attachActions(wrap, o) {
    var bar = wrap.querySelector('.msgactions');
    if (!bar) return;
    bar.innerHTML = '<button class="msgact" type="button" data-act="copy">' + ic('check', 12) + '复制</button>' +
      (o.last ? '<button class="msgact" type="button" data-act="regen">' + ic('refresh', 12) + '重新生成</button>' : '');
    bar.querySelector('[data-act="copy"]').addEventListener('click', function () {
      var text = wrap.querySelector('.bubble').textContent;
      var done = function () { bar.querySelector('[data-act="copy"]').innerHTML = ic('check', 12) + '已复制'; setTimeout(function () {
        var b = bar.querySelector('[data-act="copy"]'); if (b) b.innerHTML = ic('check', 12) + '复制'; }, 1600); };
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

  function renderMessages() {
    var box = $('#js-msgs');
    box.innerHTML = '';
    var lastAi = -1;
    state.messages.forEach(function (m, i) { if (m.role === 'assistant' && (m.content || '').trim()) lastAi = i; });
    state.messages.forEach(function (m, i) {
      if (m.role !== 'user' && !(m.content || '').trim()) return;    // 空助手＝被打断的占位
      appendMsg(m.role, m.content, { last: i === lastAi });
    });
    var last = state.messages[state.messages.length - 1];
    if (last && last.role === 'user') {
      var note = document.createElement('div');
      note.className = 'status';
      note.innerHTML = ic('alert', 13) + '<span>上一条没答完（可能刷新或关过页面），可以点「重新生成」或再问一次</span>';
      box.appendChild(note);
    }
    scrollBottom();
  }

  function renderHello() {
    var e = state.expert;
    var s = (e.starters || []).map(function (q, i) {
      return '<button class="starter" type="button" data-starter="' + i + '">' + ic('sparkle', 13) + '<span>' + esc(q) + '</span></button>';
    }).join('');
    $('#js-msgs').innerHTML =
      '<div class="hello"><div class="msg"><span class="mavatar">' + esc(e.avatar) + '</span>' +
      '<div class="bubble">' + esc(e.greeting) + '</div></div>' +
      (s ? '<div class="starters">' + s + '</div>' : '') + '</div>';
    $('#js-refs').innerHTML = '<p class="empty">发出问题后，这里会显示这次回答参考了你资料库里的哪几份文件。</p>';
    $('#ref-count').textContent = '';
    root.querySelectorAll('[data-starter]').forEach(function (b) {
      b.addEventListener('click', function () {
        $('#js-input').value = state.expert.starters[Number(b.dataset.starter)];
        send({});
      });
    });
  }

  function scrollBottom() {
    var box = $('#js-msgs');
    box.scrollTop = box.scrollHeight;
  }

  /* ───────────── 对话（SSE）──────────── */
  function setComposerBusy(busy) {
    state.streaming = busy;
    var send = $('#js-send');
    send.innerHTML = busy ? ic('x', 14) + '停止' : ic('send', 14) + '发送';
    send.classList.toggle('primary', !busy);
    send.classList.toggle('stop', busy);
    $('#js-input').disabled = busy;
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
      var res = await fetch(API + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
        signal: state.abort.signal,
      });
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
            if (data.conversationId) state.conversationId = data.conversationId;
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
        renderMessages();
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
        bubble.textContent = partial + (partial ? '\n\n（已停止）' : '（已停止生成）');
        if (partial.trim()) {
          state.messages.push({ role: 'assistant', content: partial });
          // ⚠️ 只有「已经生成了一部分」才重排：renderMessages 是按 state.messages 重建 DOM 的，
          //    而一个字都没生成时 state 里只有用户那条 —— 重排会把刚写上去的「（已停止生成）」
          //    提示一起冲掉，用户看到的就是「问了一句，然后什么都没有」（2026-10-15 线上实测到）。
          renderMessages();
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
      root.scrollTop = 0;
      var main = $('.main'); if (main) main.scrollTop = 0;
      scrollBottom();
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
      renderMessages();
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

  /* ───────────── 合规体检 ───────────── */
  function runCompliance() {
    var content = $('#cs-text').value.trim();
    var out = $('#cs-out');
    if (!content) { show(out, '<p class="empty">先贴一段文案。</p>'); return; }
    loading(out);
    call('/compliance', { method: 'POST', body: { content: content } }).then(function (d) {
      var head = d.pass
        ? '<p class="lead" style="color:var(--green);font-weight:600">没发现问题，可以发。</p>'
        : '<p class="lead" style="color:var(--red);font-weight:600">命中 ' + d.total + ' 处，涉及 ' + d.hits.length + ' 个词，建议改完再发。</p>';
      var hits = d.hits.map(function (h) {
        return '<div class="bench"><span>' + esc(h.word) +
          ' <em style="font-style:normal;font-size:11px;color:var(--red)">' + esc(h.level) + ' × ' + h.hits + '</em><br>' +
          '<em style="font-style:normal;font-size:11px;color:var(--text-3)">' + esc(h.advice) + '</em></span></div>';
      }).join('');
      var risky = d.risky.length
        ? '<p class="err" style="margin-top:12px;background:var(--warm-soft);color:var(--warm)">' + ic('alert', 14) +
          '<span>还需人工确认：<br>' + d.risky.map(esc).join('<br>') + '</span></p>' : '';
      show(out, head + hits + risky);
    }).catch(function (e) { errorBox(out, e); });
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
        (state.guest ? ' disabled' : '') + '></div>';
    }).join('');
    $('#pf-msg').textContent = state.guest ? '未登录：可以看，改不了。用机构账号登录后就能保存，专家也会用上。' : '';
  }
  function renderProfile() {
    var pct = state.completion ? state.completion.percent : 0;
    $('#pf-percent').textContent = '完成度 ' + pct + '%';
    $('#pf-bar').style.width = pct + '%';
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
    if (state.guest) { $('#pf-msg').textContent = '未登录，保存不了。用机构账号登录后再试。'; return; }
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
  $('#js-q').addEventListener('input', debounce(function (e) { state.lib.q = e.target.value.trim(); renderLib(); }, 300));
  $('#cs-run').addEventListener('click', runCompliance);
  $('#cs-demo').addEventListener('click', function () {
    $('#cs-text').value = '我们是烟台最大的美术教育机构，老师都是最好的，全网最低价，保证孩子第一节课就爱上画画。活动原价199元现价0元，还抽红包墙大奖。';
    runCompliance();
  });
  $('#pf-save').addEventListener('click', saveProfile);

  /* ───────────── 启动 ───────────── */
  applyThemeIcon();
  Promise.all([
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
      state.guest = !(ov.profile && ov.profile.org && ov.profile.org.name);
      $('#js-today').textContent = ov.today;
      $('#js-sidenote').innerHTML = '专家回答会先检索你自己的资料库，再结合机构画像。<br>' +
        '本月主线：' + esc((ov.calendar[String(ov.month)] || {}).launch || '');
    }
    if (state.expert) switchExpert(state.expert);
    else renderExperts();
    showScreen(state.screen);
  });
})();
