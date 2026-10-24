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
    refs: [],
    jobs: [],
    summary: null,
    busy: false,
    abort: null,
    selectedVideo: null,
    videoForm: null,
    copyForm: null,
  };

  function setTab(tab) {
    state.tab = tab;
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

  async function loadAll() {
    var view = $('#wb-view');
    if (view) view.innerHTML = '<div class="loading">' + ic('loader', 14) + '正在读取工作台…</div>';
    try {
      var boot = await call('/bootstrap');
      state.profile = boot.profile || null;
      state.summary = boot;
      var results = await Promise.all([
        call('/chat').catch(function () { return { messages: [] }; }),
        call('/copy').catch(function () { return { items: [] }; }),
        call('/videos').catch(function () { return { items: [] }; }),
        call('/assets').catch(function () { return { items: [] }; }),
        call('/refs').catch(function () { return { items: [] }; }),
        call('/jobs').catch(function () { return { items: [] }; }),
      ]);
      state.messages = results[0].messages || [];
      state.copy = results[1].items || [];
      state.videos = results[2].items || [];
      state.assets = results[3].items || [];
      state.refs = results[4].items || [];
      state.jobs = results[5].items || [];
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
  function messageHtml(message) {
    var me = message.role === 'user';
    var content = message.content || '';
    var body = me ? esc(content).replace(/\n/g, '<br>') : (content ? md(content) : '<span class="loading">正在写…</span>');
    var sources = '';
    var chunks = message.citations && message.citations.chunks;
    if (!me && chunks && chunks.length) {
      sources = '<details class="wb-src"><summary>引用了你的资料（' + chunks.length + '）</summary>' +
        chunks.map(function (chunk) { return '<p>' + esc(chunk.title) + (chunk.domain && chunk.domain.length ? ' · ' + esc(chunk.domain.join(' / ')) : '') + '</p>'; }).join('') +
        '</details>';
    }
    return '<div class="wb-msg' + (me ? ' me' : '') + '"><div class="wb-msg-meta">' + (me ? '你' : '小铃铛') + (message.pending ? ' · 正在写' : '') + '</div>' +
      '<div class="wb-bubble">' + body + '</div>' + sources + '</div>';
  }
  function renderMessages(forceBottom) {
    var box = $('#wb-msgs');
    if (!box) return;
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    box.innerHTML = state.messages.length ? state.messages.map(messageHtml).join('') : chatEmpty();
    if (forceBottom || near) box.scrollTop = box.scrollHeight;
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
      '<button class="btn" type="button" id="wb-clear-chat">清空对话</button></div>' +
      '<div class="wb-msgs" id="wb-msgs"></div>' +
      '<div><div class="wb-quick">' +
      '<button class="chip" type="button" data-wb-prompt="给我 3 个今天能拍的选题">今日选题</button>' +
      '<button class="chip" type="button" data-wb-prompt="写 5 条 30 秒口播文案">写口播</button>' +
      '<button class="chip" type="button" data-wb-prompt="帮我按钩子、痛点、证明、转折、行动拆解这个同行内容">拆同行</button>' +
      '<button class="chip" type="button" data-wb-prompt="把今天的热点和我的课程结合起来，给我 3 个选题">热点结合</button>' +
      '</div><div class="wb-composer"><textarea id="wb-input" placeholder="说说你今天想做什么，或贴一段同行口播…"></textarea>' +
      '<button class="btn primary" type="button" id="wb-send">' + (state.busy ? ic('stop', 14) + '停止' : ic('arrow-up', 15) + '发送') + '</button></div></div></div></div>';
    renderMessages(true);
    bindPromptButtons();
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
  async function sendChat(raw) {
    var text = String(raw || '').trim();
    if (!text || state.busy) return;
    var input = $('#wb-input');
    if (input) input.value = '';
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
        body: JSON.stringify({ message: text }), signal: state.abort.signal,
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

  /* ───────────── 账号档案 ───────────── */
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
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll"><div class="wb-card">' +
      '<div class="wb-card-head"><div><h3>账号档案</h3><p>这些信息会进入每次对话、文案和分镜的上下文。</p></div></div>' +
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
    $('#wb-account-form').onsubmit = async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        var data = Object.fromEntries(new FormData(form).entries());
        var saved = await call('/profile', { method: 'PUT', body: { profile: data } });
        state.profile = saved.profile;
        toast('账号档案已保存', 'success');
      } catch (error) { toast(error.message, 'error'); }
      finally { button.disabled = false; }
    };
  }

  /* ───────────── 同行观察 ───────────── */
  function renderReferences() {
    var items = state.refs;
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>记录同行</h3><p>拆结构，不抄内容。自动采集在二期接入。</p></div></div>' +
      '<form id="wb-ref-form" class="wb-form">' +
      '<label class="wb-field"><span>名称</span><input name="name" required placeholder="例如：某某教育号"></label>' +
      '<label class="wb-field"><span>链接</span><input name="url" type="url" placeholder="https://..."></label>' +
      '<label class="wb-field full"><span>观察笔记</span><textarea name="notes" placeholder="钩子、结构、证据、转化方式…"></textarea></label>' +
      '<div class="wb-field full wb-actions"><button class="btn primary" type="submit">加入观察</button></div></form></div>' +
      (items.length ? '<div class="wb-cards">' + items.map(function (item) {
        return '<article class="wb-item"><div class="wb-card-head"><h4>' + esc(item.name) + '</h4><button class="btn" type="button" data-ref-del="' + esc(item.id) + '">' + ic('trash', 12) + '</button></div>' +
          (item.url ? '<p><a href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">' + esc(item.url) + '</a></p>' : '') +
          '<p class="wb-preview" style="-webkit-line-clamp:6">' + esc(item.notes || '还没有观察笔记。') + '</p>' +
          '<div class="wb-meta">' + fmtDate(item.createdAt) + '</div></article>';
      }).join('') + '</div>' : '<div class="wb-card"><p class="wb-muted">还没有同行记录。先加入 3-5 个值得研究的账号。</p></div>') +
      '</div></div>';
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
      '<div class="wb-card"><div class="wb-card-head"><div><h3>生成新文案</h3><p>围绕一个主题，一次给你多条不同角度的口播。</p></div></div>' +
      '<form id="wb-copy-form" class="wb-form">' +
      '<label class="wb-field full"><span>主题</span><input name="topic" required placeholder="例如：寒假班怎么选、体验课怎么开口" value="' + esc(formState.topic || '') + '"></label>' +
      '<label class="wb-field"><span>条数</span><select name="count">' + [3, 5, 7, 10].map(function (n) { return '<option' + (Number(formState.count || 5) === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<label class="wb-field"><span>风格</span><select name="style">' + ['口语化', '专业理性', '故事感', '犀利反常识'].map(function (s) { return '<option' + (formState.style === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></label>' +
      '<div class="wb-field full wb-actions"><button class="btn primary" type="submit">生成文案</button><span class="wb-note">使用平台模型渠道；模型返回空时会给出演示样本。</span></div></form></div>' +
      (state.copy.length ? '<div class="wb-cards wb-copy-grid">' + state.copy.map(function (item) {
        return '<article class="wb-item"><div class="wb-card-head"><div><h4>' + esc(item.topic) + '</h4><div class="wb-meta">' + esc(item.style) + ' · ' + fmtDate(item.createdAt) + '</div></div></div>' +
          '<div class="wb-copy-body">' + md(item.content) + '</div>' +
          '<div class="wb-actions"><button class="btn" type="button" data-copy-content="' + esc(item.id) + '">' + ic('copy', 12) + '复制</button>' +
          '<button class="btn" type="button" data-copy-check="' + esc(item.id) + '">' + ic('shield', 12) + '合规体检</button>' +
          '<button class="btn" type="button" data-copy-del="' + esc(item.id) + '">' + ic('trash', 12) + '</button></div></article>';
      }).join('') + '</div>' : '<div class="wb-card"><p class="wb-muted">还没有文案。输入一个主题，先生成 5 条。</p></div>') +
      '</div></div>';
    $('#wb-copy-form').onsubmit = async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var button = form.querySelector('[type="submit"]');
      var original = button.innerHTML;
      button.disabled = true; button.innerHTML = ic('loader', 13) + '生成中…';
      try {
        var data = Object.fromEntries(new FormData(form).entries());
        data.count = Number(data.count || 5);
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

  /* ───────────── 视频创作 ───────────── */
  function focusDetail() {
    requestAnimationFrame(function () {
      var detail = $('.wb-detail');
      if (detail) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  function renderVideo() {
    var formState = state.videoForm || {};
    var selected = state.selectedVideo;
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>新建视频项目</h3><p>从需求到分镜、口播和 SRT；复刻模式先拆参考结构，再给替换点。</p></div></div>' +
      '<form id="wb-video-form" class="wb-form">' +
      '<label class="wb-field full"><span>视频主题</span><input name="title" required placeholder="例如：为什么体验课要这样上" value="' + esc(formState.title || '') + '"></label>' +
      '<label class="wb-field"><span>模式</span><select name="mode">' + ['原创', '复刻'].map(function (m) { return '<option' + (formState.mode === m ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></label>' +
      '<label class="wb-field"><span>目标时长</span><input value="30-60 秒" disabled></label>' +
      '<label class="wb-field full"><span>需求说明</span><textarea name="brief" placeholder="课程、人群、想引导的动作，或想保留/替换的部分">' + esc(formState.brief || '') + '</textarea></label>' +
      '<label class="wb-field full"><span>参考内容（复刻模式）</span><textarea name="referenceText" placeholder="粘贴参考视频的口播文字、结构说明或链接">' + esc(formState.referenceText || '') + '</textarea></label>' +
      '<div class="wb-field full wb-actions"><button class="btn primary" type="submit">生成分镜脚本</button><span class="wb-note">真实视频生成/数字人需要外部服务；一期先产出可拍脚本和 SRT。</span></div></form></div>' +
      (state.videos.length ? '<div class="wb-cards">' + state.videos.map(function (item) {
        return '<article class="wb-item click' + (selected && selected.id === item.id ? ' current' : '') + '" data-video-open="' + esc(item.id) + '">' +
          '<div class="wb-card-head"><h4>' + esc(item.title) + '</h4><span class="wb-tag">' + esc(item.mode) + '</span></div>' +
          '<div class="wb-meta">' + fmtDate(item.createdAt) + ' · ' + esc(videoStatusText(item.status)) + '</div>' +
          '<p class="wb-preview">' + esc(String(item.script || '').replace(/[#*|>`-]/g, ' ').replace(/\s+/g, ' ').slice(0, 150)) + '</p></article>';
      }).join('') + '</div>' : '<div class="wb-card"><p class="wb-muted">还没有视频项目。写一个主题和需求，先生成一版分镜。</p></div>') +
      (selected ? '<div class="wb-card wb-detail"><div class="wb-card-head"><div><h3>' + esc(selected.title) + '</h3><p>' + esc(selected.mode) + ' · 创建于 ' + fmtDate(selected.createdAt) + '</p></div>' +
        '<div class="wb-actions"><button class="btn primary" type="button" id="wb-save-video-top">保存修改</button><button class="btn" type="button" id="wb-close-video">收起</button></div></div>' +
        '<label class="wb-field"><span>口播/分镜脚本</span><textarea class="wb-script" id="wb-script-editor">' + esc(selected.script) + '</textarea></label>' +
        '<div class="wb-export"><button class="btn" type="button" data-export="md">导出 Markdown</button>' +
        '<button class="btn" type="button" data-export="srt">导出 SRT</button>' +
        '<button class="btn" type="button" data-export="json">导出 JSON</button>' +
        '<button class="btn primary" type="button" id="wb-save-video">保存修改</button>' +
        '<button class="btn" type="button" id="wb-video-check">' + ic('shield', 12) + '合规体检</button></div>' +
        '<p class="wb-note" style="margin-top:9px">状态：' + esc(videoStatusText(selected.status)) + ' · 保存后再导出，导出的是最新脚本。</p></div>' : '') +
      '</div></div>';
    $('#wb-video-form').onsubmit = async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var button = form.querySelector('[type="submit"]');
      var original = button.innerHTML;
      button.disabled = true; button.innerHTML = ic('loader', 13) + '生成中…';
      try {
        var data = Object.fromEntries(new FormData(form).entries());
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
    if (close) close.onclick = function () { state.selectedVideo = null; renderVideo(); };
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
  }

  /* ───────────── 素材库 ───────────── */
  function renderAssets() {
    var items = state.assets;
    $('#wb-view').innerHTML = '<div class="wb-page"><div class="wb-scroll">' +
      '<div class="wb-card"><div class="wb-card-head"><div><h3>素材库</h3><p>图片、视频、音频和文本保存在本机/机构文件存储；不会上传到第三方。</p></div>' +
      '<label class="btn primary" for="wb-asset-input">' + ic('upload', 13) + '上传素材</label>' +
      '<input id="wb-asset-input" type="file" multiple hidden accept=".jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.webm,.m4v,.mp3,.m4a,.wav,.aac,.txt,.md"></div>' +
      (items.length ? '<div class="wb-asset-grid">' + items.map(function (item) {
        var thumb = item.kind === 'image'
          ? '<img data-asset-img="' + esc(item.id) + '" alt="' + esc(item.fileName) + '" loading="lazy">'
          : ic(item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'music' : 'folder', 28);
        return '<article class="wb-asset"><div class="wb-thumb">' + thumb + '</div><div class="wb-asset-info"><b title="' + esc(item.fileName) + '">' + esc(item.fileName) + '</b>' +
          '<small>' + esc(item.kind) + ' · ' + fmtSize(item.size) + ' · ' + fmtDate(item.createdAt) + '</small>' +
          '<div class="wb-actions"><button class="btn" type="button" data-asset-open="' + esc(item.id) + '">打开</button>' +
          '<button class="btn" type="button" data-asset-del="' + esc(item.id) + '">' + ic('trash', 12) + '</button></div></div></article>';
      }).join('') + '</div>' : '<p class="wb-muted">素材库是空的。上传课程图、课堂视频、参考音频或口播文本。</p>') +
      '</div></div></div>';
    var input = $('#wb-asset-input');
    input.onchange = async function () {
      var files = Array.prototype.slice.call(input.files || []);
      if (!files.length) return;
      for (var i = 0; i < files.length; i++) {
        var form = new FormData();
        form.append('file', files[i]);
        try {
          var result = await call('/assets', { method: 'POST', body: form });
          state.assets.unshift(result.asset);
          renderAssets();
          toast(files[i].name + ' 已上传', 'success');
        } catch (error) { toast(files[i].name + '：' + error.message, 'error'); }
      }
    };
    $$('[data-asset-open]').forEach(function (button) {
      button.onclick = function () { openAsset(button.dataset.assetOpen); };
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

  /* ───────────── 合规体检（复用 junshi 的规则引擎） ───────────── */
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
    else if (state.tab === 'reports') renderReports();
    else if (state.tab === 'jobs') renderJobs();
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
