/* 招生军师 · 专家团 —— 前端逻辑
 * 见 ../../junshi/index.html 顶部注释：脚本必须外链（CSP script-src 'self'），且要打 ?v= 内容哈希。
 *
 * 对话走 POST + fetch 流式读（不用 EventSource —— 它只支持 GET，塞不下 messages 数组），
 * 自己解析 SSE 的 `event:` / `data:` 两行格式。
 *
 * 图标：改用内联 SVG sprite（`<use href="#i-xxx">`），不再加载 600KB 的图标库 JS ——
 * 见 index.html 里的 sprite 定义与 gen_icon_sprite.py 的说明。
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
  /** 内联 sprite 图标。size 走 CSS 的 em，所以外面给 font-size 即可。 */
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

  var state = {
    screen: 'chat',
    experts: [],
    expert: null,
    messages: [],
    streaming: false,
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

  /* ───────────── 专家列表 ───────────── */
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
  function switchExpert(e) {
    if (state.streaming) return;
    var same = state.expert && state.expert.id === e.id;
    state.expert = e;
    state.messages = [];
    renderExperts();
    $('#conv-avatar').textContent = e.avatar;
    $('#conv-name').textContent = e.name;
    $('#conv-tag').textContent = e.tag;
    $('#js-refs').innerHTML = '<p class="empty">发出问题后，这里会显示这次回答参考了你资料库里的哪几份文件。</p>';
    $('#ref-count').textContent = '';
    // 切专家＝换了一整套上下文，属于「防止突兀跳变」：面板整体做一次短交叉淡入。
    // 只在真的换了人时播，重复点同一位不重放（避免高频点击下的闪动）。
    var conv = $('.conv');
    if (!same && conv) {
      conv.style.animation = 'none';
      void conv.offsetHeight;                                  // 强制回流，让动画能重新触发
      conv.style.animation = 'bubble-in var(--t-enter) var(--ease-out) both';
    }
    renderHello();
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
    root.querySelectorAll('[data-starter]').forEach(function (b) {
      b.addEventListener('click', function () {
        $('#js-input').value = state.expert.starters[Number(b.dataset.starter)];
        send();
      });
    });
  }

  /* ───────────── 消息 ───────────── */
  function appendMsg(role, content) {
    var wrap = document.createElement('div');
    wrap.className = 'msg' + (role === 'user' ? ' me' : '');
    var who = role === 'user' ? '我' : (state.expert ? state.expert.avatar : '军师');
    wrap.innerHTML = '<span class="mavatar">' + esc(who) + '</span><div class="bubble"></div>';
    wrap.querySelector('.bubble').textContent = content;
    $('#js-msgs').appendChild(wrap);
    scrollBottom();
    return wrap.querySelector('.bubble');
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
    input.style.height = '';
    $('#js-hint').textContent = '';

    var hello = $('#js-msgs').querySelector('.hello');
    if (hello) hello.remove();

    appendMsg('user', text);
    state.messages.push({ role: 'user', content: text });
    state.streaming = true;
    $('#js-send').disabled = true;
    input.disabled = true;

    var bubble = appendMsg('assistant', '');
    var statusEl = document.createElement('div');
    statusEl.className = 'status';
    statusEl.innerHTML = ic('loader', 13) + '<span>正在连接…</span>';
    bubble.parentNode.parentNode.appendChild(statusEl);
    var answer = '';

    function setStatus(text, spin) {
      statusEl.innerHTML = (spin ? ic('loader', 13) : '') + (text ? '<span>' + esc(text) + '</span>' : '');
      statusEl.className = 'status' + (spin && !text ? ' dots' : '');
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
        try { payload = await res.json(); } catch (e) { /* 非 JSON 就算了 */ }
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
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('event: ') === 0) { event = line.slice(7).trim(); continue; }
          if (line.indexOf('data: ') !== 0) continue;
          var data;
          try { data = JSON.parse(line.slice(6)); } catch (e) { continue; }
          if (event === 'status') setStatus(data.text, true);
          else if (event === 'citations') renderRefs(data);
          else if (event === 'thinking') setStatus('正在思考', true);
          else if (event === 'delta') {
            answer += data.text || '';
            bubble.textContent = answer;               // 直接换文本，不逐字做动效 —— 那会干扰阅读
            if (answer) setStatus('', false);
            scrollBottom();
          } else if (event === 'error') throw new Error(data.message || '生成失败');
          else if (event === 'done') { if (data.citations) renderRefs(data.citations); }
        }
      }
      if (!answer.trim()) bubble.textContent = '（这次没有生成内容，可以再试一次）';
      else state.messages.push({ role: 'assistant', content: answer });
      if (statusEl.parentNode) statusEl.remove();
    } catch (e) {
      bubble.textContent = '';
      statusEl.className = 'status';
      statusEl.innerHTML = '<span style="color:var(--red)">' + esc(e.message || '出错了') + '</span>';
      setTimeout(function () { if (statusEl.parentNode) statusEl.remove(); }, 8000);
    } finally {
      state.streaming = false;
      $('#js-send').disabled = false;
      input.disabled = false;
      // ⚠️ 必须 preventScroll：浏览器 focus 时会去「把元素滚进视口」，
      //    而 `overflow:hidden` 的容器**照样能被程序滚动** —— 结果整个三栏被顶上去了
      //    （2026-10-15 实测：右侧引用面板 top 跑到 -152px，看着像被裁掉了）。
      try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
      root.scrollTop = 0;
      var main = $('.main'); if (main) main.scrollTop = 0;
      scrollBottom();
    }
  }

  function renderRefs(c) {
    var items = [];
    (c.chunks || []).forEach(function (x) {
      items.push('<div class="ref"><b>' + esc(x.title) + '</b><span>' + esc((x.domain || []).join(' / ')) + '</span>' +
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
    // 每次重新渲染都回到顶部：列表一变长，浏览器的滚动锚定会把面板停在中间，
    // 表现为「第一条被顶出去了」（2026-10-15 实测）。
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
    chat: function () { renderExperts(); if (state.expert) renderHello(); },
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
  $('#js-send').addEventListener('click', send);
  $('#js-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  // 输入框随内容长高（最多到 CSS 的 max-height），不写死行数
  $('#js-input').addEventListener('input', function (e) {
    e.target.style.height = '';
    e.target.style.height = Math.min(e.target.scrollHeight, 168) + 'px';
  });
  $('#conv-reset').addEventListener('click', function () {
    if (state.streaming || !state.expert) return;
    state.messages = [];
    $('#js-refs').innerHTML = '<p class="empty">发出问题后，这里会显示这次回答参考了你资料库里的哪几份文件。</p>';
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
