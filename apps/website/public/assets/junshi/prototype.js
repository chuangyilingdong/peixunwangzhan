/* 招生军师 · 专家团 —— 前端逻辑
 * 见 ../../junshi/index.html 顶部注释：脚本必须外链（CSP script-src 'self'），且要打 ?v= 内容哈希。
 *
 * 对话走 POST + fetch 流式读（不用 EventSource —— 它只支持 GET，塞不下 messages 数组），
 * 自己解析 SSE 的 `event:` / `data:` 两行格式。
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
  function loading(t) { show(t, '<p class="js-loading">加载中…</p>'); }
  function errorBox(t, e) { show(t, '<p class="js-err">' + esc(e && e.message ? e.message : '加载失败') + '</p>'); }
  function debounce(fn, ms) {
    var t = null;
    return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms || 260); };
  }

  var state = {
    screen: 'chat',
    experts: [],
    expert: null,
    messages: [],        // {role, content}（发给服务端的历史）
    streaming: false,
    lib: { scene: '', q: '' },
    pfGroup: 'org', pfDraft: {}, profile: null, completion: null, guest: true,
  };

  /* ───────────── 导航 ───────────── */
  var inited = {};
  function showScreen(name) {
    $$('.js-screen').forEach(function (s) { s.hidden = (s.id !== 'scr-' + name); });
    $$('.js-navitem').forEach(function (b) {
      if (b.dataset.screen === name) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    state.screen = name;
    if (!inited[name]) { inited[name] = true; (INIT[name] || function () {})(); }
  }
  $$('.js-navitem').forEach(function (b) { b.addEventListener('click', function () { showScreen(b.dataset.screen); }); });

  /* ───────────── 专家列表 ───────────── */
  function renderExperts() {
    var box = $('#js-experts');
    $('#ex-count').textContent = state.experts.length + ' 位';
    box.innerHTML = '';
    state.experts.forEach(function (e) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'js-expert';
      b.setAttribute('aria-pressed', String(state.expert && state.expert.id === e.id));
      b.innerHTML = '<span class="js-eavatar">' + esc(e.avatar) + '</span>' +
        '<span style="min-width:0"><span class="js-ename">' + esc(e.name) + '</span><span class="js-etag">' + esc(e.tag) + '</span></span>';
      b.addEventListener('click', function () { switchExpert(e); });
      box.appendChild(b);
    });
  }
  function switchExpert(e) {
    if (state.streaming) return;              // 正在生成时不许切，否则流会写到别的专家的对话里
    state.expert = e;
    state.messages = [];
    renderExperts();
    $('#conv-avatar').textContent = e.avatar;
    $('#conv-name').textContent = e.name;
    $('#conv-tag').textContent = e.tag;
    $('#js-refs').innerHTML = '<p class="js-empty">发出问题后，这里会显示这次回答参考了你资料库里的哪几份文件。</p>';
    $('#ref-count').textContent = '';
    renderHello();
  }
  function renderHello() {
    var e = state.expert;
    var s = (e.starters || []).map(function (q, i) {
      return '<button class="js-starter" type="button" data-starter="' + i + '">' + esc(q) + '</button>';
    }).join('');
    $('#js-msgs').innerHTML =
      '<div class="js-hello"><div class="js-msg"><span class="js-mavatar">' + esc(e.avatar) + '</span>' +
      '<div class="js-bubble">' + esc(e.greeting) + '</div></div>' +
      (s ? '<div class="js-starters" style="margin-left:35px">' + s + '</div>' : '') + '</div>';
    root.querySelectorAll('[data-starter]').forEach(function (b) {
      b.addEventListener('click', function () {
        var q = state.expert.starters[Number(b.dataset.starter)];
        $('#js-input').value = q;
        send();
      });
    });
  }

  /* ───────────── 消息渲染 ───────────── */
  function appendMsg(role, content, opts) {
    var o = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'js-msg' + (role === 'user' ? ' me' : '');
    var who = role === 'user' ? '我' : (state.expert ? state.expert.avatar : '军师');
    wrap.innerHTML = '<span class="js-mavatar">' + esc(who) + '</span><div class="js-bubble"></div>';
    wrap.querySelector('.js-bubble').textContent = content;
    $('#js-msgs').appendChild(wrap);
    scrollBottom();
    return wrap.querySelector('.js-bubble');
  }
  function scrollBottom() {
    var box = $('#js-msgs');
    box.scrollTop = box.scrollHeight;
  }

  /* ───────────── 对话（SSE）──────────── */
  async function send() {
    if (state.streaming) return;
    var input = $('#js-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    $('#js-hint').textContent = '';

    // 第一次发言时把开场白清掉（保留历史气泡更自然）
    var hello = $('#js-msgs').querySelector('.js-hello');
    if (hello) hello.remove();

    appendMsg('user', text);
    state.messages.push({ role: 'user', content: text });
    state.streaming = true;
    $('#js-send').disabled = true;
    input.disabled = true;

    var bubbleWrap = appendMsg('assistant', '');
    var bubble = bubbleWrap;
    var statusEl = document.createElement('div');
    statusEl.className = 'js-status js-dots';
    statusEl.textContent = '正在连接…';
    bubbleWrap.parentNode.parentNode.insertBefore(statusEl, bubbleWrap.parentNode.nextSibling);
    var answer = '';

    function setStatus(t, dots) {
      statusEl.textContent = t;
      statusEl.className = 'js-status' + (dots ? ' js-dots' : '');
    }

    try {
      var res = await fetch(API + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expertId: state.expert.id, messages: state.messages }),
        credentials: 'same-origin',
      });
      if (!res.ok || !res.body) {
        var payload = null;
        try { payload = await res.json(); } catch (e) { /* 忽略非 JSON */ }
        throw new Error((payload && (payload.message || (payload.error && payload.error.message))) || ('服务返回 HTTP ' + res.status));
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
        buffer = lines.pop();                      // 最后一行可能是不完整的，留到下一轮
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('event: ') === 0) { event = line.slice(7).trim(); continue; }
          if (line.indexOf('data: ') !== 0) continue;   // `: ping` 心跳等注释行直接忽略
          var data;
          try { data = JSON.parse(line.slice(6)); } catch (e) { continue; }
          if (event === 'status') setStatus(data.text, true);
          else if (event === 'citations') renderRefs(data);
          else if (event === 'thinking') setStatus('正在思考…', true);
          else if (event === 'delta') {
            if (!answer) setStatus('', false);
            answer += data.text || '';
            bubble.textContent = answer;
            scrollBottom();
          } else if (event === 'error') {
            throw new Error(data.message || '生成失败');
          } else if (event === 'done') {
            if (data.citations) renderRefs(data.citations);
          }
        }
      }
      if (!answer.trim()) {
        bubble.textContent = '（这次没有生成内容，可以再试一次）';
      } else {
        state.messages.push({ role: 'assistant', content: answer });
      }
    } catch (e) {
      bubble.textContent = '';
      statusEl.className = 'js-status';
      statusEl.innerHTML = '<span style="color:var(--p-red)">' + esc(e.message || '出错了') + '</span>';
      statusEl = null;
    } finally {
      if (statusEl && statusEl.parentNode) statusEl.remove();
      state.streaming = false;
      $('#js-send').disabled = false;
      input.disabled = false;
      input.focus();
      scrollBottom();
    }
  }

  function renderRefs(c) {
    var items = [];
    (c.chunks || []).forEach(function (x) {
      items.push('<div class="js-ref"><b>' + esc(x.title) + '</b><span>' + esc((x.domain || []).join(' / ')) + '</span>' +
        (x.excerpt ? '<p>' + esc(x.excerpt) + '…</p>' : '') + '</div>');
    });
    (c.hooks || []).forEach(function (n) {
      items.push('<div class="js-ref"><b>玩法：' + esc(n) + '</b><span>资料库 · 玩法库</span></div>');
    });
    (c.objections || []).forEach(function (q) {
      items.push('<div class="js-ref"><b>' + esc(q) + '</b><span>资料库 · 异议库</span></div>');
    });
    if (c.copies) items.push('<div class="js-ref"><b>同类文案 ' + c.copies + ' 条</b><span>资料库 · 文案库</span></div>');
    if (c.hasProfile) items.push('<div class="js-ref"><b>你的机构画像</b><span>回答已结合你的品类与价格</span></div>');
    $('#ref-count').textContent = items.length ? items.length + ' 项' : '';
    show($('#js-refs'), items.length ? items.join('') :
      '<p class="js-empty">这次没有检索到直接相关的资料，回答基于行业常识。可以先在「机构画像」里补全信息，命中率会更高。</p>');
  }

  /* ───────────── 知识库 ───────────── */
  function renderLib() {
    var box = $('#js-lib'); if (!box) return;
    loading(box);
    var qs = ['limit=30'];
    if (state.lib.q) qs.push('q=' + encodeURIComponent(state.lib.q));
    if (state.lib.scene) qs.push('scene=' + encodeURIComponent(state.lib.scene));
    call('/library?' + qs.join('&')).then(function (d) {
      $('#js-count').textContent = d.total + ' 条';
      if (!d.items.length) { show(box, '<p class="js-empty">没有匹配。试试更短的关键词，或换个场景。</p>'); return; }
      box.innerHTML = d.items.map(function (it) {
        return '<div class="js-doc" style="cursor:default"><span class="js-tag">' + esc(it.kind) + '</span>' +
          '<b style="font-weight:400">' + esc(it.t) + '</b><em>' + esc(it.cat) + '</em></div>';
      }).join('');
    }).catch(function (e) { errorBox(box, e); });
  }

  /* ───────────── 合规体检 ───────────── */
  function runCompliance() {
    var content = $('#cs-text').value.trim();
    var out = $('#cs-out');
    if (!content) { show(out, '<p class="js-empty">先贴一段文案。</p>'); return; }
    loading(out);
    call('/compliance', { method: 'POST', body: { content: content } }).then(function (d) {
      var head = d.pass
        ? '<p class="js-lead" style="color:var(--p-green);font-weight:500">没发现问题，可以发。</p>'
        : '<p class="js-lead" style="color:var(--p-red);font-weight:500">命中 ' + d.total + ' 处，涉及 ' + d.hits.length + ' 个词，建议改完再发。</p>';
      var hits = d.hits.map(function (h) {
        return '<div class="js-bench"><span>' + esc(h.word) +
          ' <em style="font-style:normal;font-size:11px;color:var(--p-red)">' + esc(h.level) + ' × ' + h.hits + '</em><br>' +
          '<em style="font-style:normal;font-size:11px;color:var(--p-text3)">' + esc(h.advice) + '</em></span></div>';
      }).join('');
      var risky = d.risky.length ? '<div class="js-err" style="margin-top:10px;background:var(--p-warm-soft);color:var(--p-warm)">还需人工确认：<br>' + d.risky.map(esc).join('<br>') + '</div>' : '';
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
  var GROUP_LABEL = {};
  GROUPS.forEach(function (g) { GROUP_LABEL[g[0]] = g[1]; });

  function renderPfGroups() {
    var box = $('#pf-groups'); if (!box) return;
    box.innerHTML = '';
    var missing = (state.completion && state.completion.missing) || [];
    GROUPS.forEach(function (g) {
      var miss = missing.indexOf(g[0]) >= 0;
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'js-scene';
      b.setAttribute('aria-pressed', String(state.pfGroup === g[0]));
      b.innerHTML = g[1] + '<span style="' + (miss ? '' : 'color:var(--p-green)') + '">' + (miss ? '待补充' : '已完成') + '</span>';
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
      return '<div class="js-field"><label for="pf_' + f + '">' + esc(FIELD_LABEL[f] || f) + '</label>' +
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
    chat: function () { renderExperts(); if (state.expert) renderHello(); },
    library: function () {
      renderLib();
      call('/library/facets').then(function (f) {
        var box = $('#lib-scenes'); box.innerHTML = '';
        [''].concat(f.scene.slice(0, 12).map(function (x) { return x.k; })).forEach(function (s) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'js-chip';
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

  /* ───────────── 事件绑定 ───────────── */
  $('#js-send').addEventListener('click', send);
  $('#js-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#conv-reset').addEventListener('click', function () {
    if (state.streaming || !state.expert) return;
    state.messages = [];
    $('#js-refs').innerHTML = '<p class="js-empty">发出问题后，这里会显示这次回答参考了你资料库里的哪几份文件。</p>';
    $('#ref-count').textContent = '';
    renderHello();
  });
  $('#js-q').addEventListener('input', debounce(function (e) { state.lib.q = e.target.value.trim(); renderLib(); }, 300));
  $('#cs-run').addEventListener('click', runCompliance);
  $('#cs-demo').addEventListener('click', function () {
    $('#cs-text').value = '我们是烟台最大的美术教育机构，老师都是最好的，全网最低价，保证孩子第一节课就爱上画画。活动原价199元现价0元，还抽红包墙大奖。';
    runCompliance();
  });
  $('#pf-save').addEventListener('click', saveProfile);

  /* ───────────── 启动 ───────────── */
  Promise.all([
    call('/experts').catch(function () { return { experts: [] }; }),
    call('/overview').catch(function () { return null; }),
  ]).then(function (out) {
    var ex = out[0], ov = out[1];
    state.experts = ex.experts || [];
    if (!state.experts.length) {
      $('#js-msgs').innerHTML = '<p class="js-err">专家列表没加载出来，刷新一下试试。</p>';
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
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  });
})();
