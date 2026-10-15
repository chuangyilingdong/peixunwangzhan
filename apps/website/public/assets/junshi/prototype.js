/* 招生军师 —— 前端逻辑（见 ../../junshi/index.html 顶部注释：脚本必须外链，CSP 是 script-src 'self'）*/
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
          var err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        return payload && payload.data !== undefined ? payload.data : payload;
      });
    });
  }

  function show(target, html) { if (target) target.innerHTML = html; }
  function loading(target) { show(target, '<p class="js-loading">加载中…</p>'); }
  function errorBox(target, err) {
    show(target, '<p class="js-err">' + esc(err && err.message ? err.message : '加载失败') + '</p>');
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 250);
    };
  }

  /* ───────────── 全局状态 ───────────── */
  var state = {
    screen: 'war',
    month: null,
    overview: null,
    profile: null,
    completion: null,
    guest: true,
    pfGroup: 'org',
    pfDraft: {},
    lib: { scene: '', q: '', open: {} },
    ob: { cat: '', tag: '', q: '' },
    cp: { kind: '', q: '' },
    co: { steps: [], done: [] },
    pl: { node: '', kind: '' },
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
  $$('.js-navitem').forEach(function (b) {
    b.addEventListener('click', function () { showScreen(b.dataset.screen); });
  });

  /* ───────────── 作战台 ───────────── */
  var MSHORT = ['寒假班', '开学季', '转介绍', '地推', '母亲节', '暑招', '暑期课消', '秋招储备', '开学季', '10月', '双11', '双12'];
  var LINES = [['launch', '拉新'], ['consume', '课消'], ['renew', '续费'], ['referral', '转介绍']];

  function renderMonths() {
    var box = $('#js-months'); if (!box || !state.overview) return;
    var cal = state.overview.calendar;
    box.innerHTML = '';
    for (var m = 1; m <= 12; m++) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'js-month';
      b.setAttribute('aria-pressed', String(state.month === m));
      b.innerHTML = '<b>' + m + '月</b><u>' + (m === state.overview.month ? '本月' : esc(MSHORT[m - 1])) + '</u>';
      b.addEventListener('click', (function (mm) {
        return function () { state.month = mm; renderMonths(); };
      })(m));
      box.appendChild(b);
    }
    var c = cal[String(state.month)];
    if (!c) { $('#js-mdetail').innerHTML = ''; return; }
    var rows = LINES.map(function (l) {
      return '<div class="js-mline"><b>' + l[1] + '</b><span>' + esc(c[l[0]] || '—') + '</span></div>';
    }).join('');
    $('#js-mdetail').innerHTML = rows + '<div class="js-mnote">军师提醒：' + esc(c.note) + '</div>';
  }

  function renderWar() {
    var o = state.overview; if (!o) return;
    var m = state.month || o.month;
    var c = o.calendar[String(m)];
    $('#js-today').textContent = o.today;
    $('#war-month').textContent = m + ' 月';

    var left = 100 - o.completion.percent;
    $('#war-cast').innerHTML = '<b>军师播报 · ' + esc(o.today) + '</b><br>' +
      esc(m) + ' 月的主线是「' + esc(c.launch) + '」。' +
      (left > 0
        ? '机构画像还差 <b>' + left + '%</b> 没填（缺：' + esc(o.completion.missing.map(function (k) { return GROUP_LABEL[k] || k; }).join(' / ')) + '）——补完，下面的玩法匹配和文案替换会更准。'
        : '机构画像已填齐，下面的玩法匹配和文案替换都是按你的机构信息出的。');

    show($('#war-lines'), LINES.map(function (l) {
      return '<div class="js-mline"><b>' + l[1] + '</b><span>' + esc(c[l[0]] || '—') + '</span></div>';
    }).join('') + '<div class="js-mnote">军师提醒：' + esc(c.note) + '</div>');

    $('#war-stats').innerHTML = [
      ['素材索引', o.stats.library, ' 条'],
      ['异议库', o.stats.objections, ' 条'],
      ['钩子玩法', o.stats.hooks, ' 个'],
      ['合规词', o.stats.complianceWords, ' 个'],
    ].map(function (x) {
      return '<div>' + x[0] + '<strong>' + x[1] + '<span>' + x[2] + '</span></strong></div>';
    }).join('') + '<p class="js-lead" style="flex-basis:100%;margin-top:8px">合规词表数字来自全库 ' +
      o.stats.scannedDocs + ' 份文档 / ' + Math.round(o.stats.scannedChars / 10000) + ' 万字的真实统计。</p>';

    $('#war-profile').innerHTML =
      '<div class="js-bar"><i style="width:' + o.completion.percent + '%"></i></div>' +
      '<p class="js-lead" style="margin-top:7px">已完成 ' + o.completion.percent + '%（' + o.completion.filled + '/' + o.completion.total + ' 项）' +
      (state.guest ? ' · <b style="font-weight:500">未登录，只能看不能存</b>' : '') + '</p>' +
      (o.completion.missing.length
        ? '<p class="js-lead" style="margin-top:4px">待补充：' + esc(o.completion.missing.map(function (k) { return GROUP_LABEL[k] || k; }).join('、')) + '</p>'
        : '');

    renderMonths();
  }

  /* ───────────── 素材库 ───────────── */
  function renderLib() {
    var box = $('#js-lib'); if (!box) return;
    loading(box);
    var qs = ['limit=30'];
    if (state.lib.q) qs.push('q=' + encodeURIComponent(state.lib.q));
    if (state.lib.scene) qs.push('scene=' + encodeURIComponent(state.lib.scene));
    call('/library?' + qs.join('&')).then(function (d) {
      $('#js-count').textContent = d.total + ' 条（全库 ' + (state.overview ? state.overview.stats.library : '') + ' 条索引）';
      if (!d.items.length) { show(box, '<p class="js-empty">没有匹配。试试更短的关键词，或换个场景筛选。</p>'); return; }
      box.innerHTML = d.items.map(function (it, i) {
        var key = it.t + '#' + i;
        var open = state.lib.open[key];
        return '<button class="js-doc" type="button" data-lib="' + i + '" style="' + (open ? 'border-color:var(--p-brand)' : '') + '">' +
          '<span class="js-tag">' + esc(it.kind) + '</span>' +
          '<b>' + esc(it.t) + '</b>' +
          '<em>' + esc(it.cat) + ((it.nodes && it.nodes.length) ? ' · ' + esc(it.nodes.join('/')) : '') + '</em></button>' +
          (open ? '<div style="border:1px solid var(--p-line);border-top:0;border-radius:0 0 9px 9px;padding:10px 12px;margin-top:-7px;background:var(--p-surface2)">' +
            '<p class="js-lead"><b style="font-weight:500;color:var(--p-text)">路径</b>：' + esc(it.path) + '</p>' +
            '<p class="js-lead" style="margin-top:6px"><b style="font-weight:500;color:var(--p-text)">场景</b>：' + esc((it.scenes || []).join('、') || '—') + '</p>' +
            '<p class="js-lead" style="margin-top:6px"><b style="font-weight:500;color:var(--p-text)">原文摘要</b>：' + esc(it.digest) + '</p></div>'
            : '');
      }).join('');
      box.querySelectorAll('[data-lib]').forEach(function (b) {
        b.addEventListener('click', function () {
          var it = d.items[Number(b.dataset.lib)];
          var key = it.t + '#' + Number(b.dataset.lib);
          state.lib.open[key] = !state.lib.open[key];
          renderLib();
        });
      });
    }).catch(function (e) { errorBox(box, e); });
  }

  /* ───────────── 话术工坊（异议库）───────────── */
  function renderObjections() {
    var box = $('#ob-list'); if (!box) return;
    loading(box);
    var qs = ['limit=20'];
    if (state.ob.cat) qs.push('cat=' + encodeURIComponent(state.ob.cat));
    if (state.ob.tag) qs.push('tag=' + encodeURIComponent(state.ob.tag));
    if (state.ob.q) qs.push('q=' + encodeURIComponent(state.ob.q));
    call('/objections?' + qs.join('&')).then(function (d) {
      $('#ob-count').textContent = d.total + ' 条';
      if (!d.items.length) { show(box, '<p class="js-empty">没找到。换个说法试试，比如「贵」「时间」「商量」。</p>'); return; }
      box.innerHTML = d.items.map(function (o, i) {
        var chain = o.chain ? '<div class="js-steps" style="margin-top:8px">' + o.chain.map(function (s, k) {
          var parts = s.split('：');
          return '<div class="js-step"><span class="js-stepno">' + (k + 1) + '</span><div><b>' + esc(parts[0]) + '</b><p>' + esc(parts.slice(1).join('：')) + '</p></div></div>';
        }).join('') + '<p class="js-lead" style="margin-top:6px;color:var(--p-text3)">↑ 这是军师给的应答骨架，不是你这份资料里的原话。</p></div>' : '';
        return '<div class="js-sample">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:5px">' +
          '<span class="js-tag b">' + esc(o.cat) + '</span>' +
          (o.tags || []).slice(0, 4).map(function (t) { return '<span class="js-tag">' + esc(t) + '</span>'; }).join('') +
          '<em style="margin-left:auto;font-style:normal;font-size:11px;color:var(--p-text3)">' + esc((o.src || '').slice(0, 26)) + '</em></div>' +
          '<b style="font-weight:500;color:var(--p-text);font-size:12.5px">' + esc(o.q) + '</b>' +
          '<p style="margin-top:6px">' + esc(o.a.length > 260 ? o.a.slice(0, 260) + '…' : o.a) + '</p>' +
          (o.a.length > 260 ? '<button class="js-btn" type="button" data-obj="' + i + '" style="margin-top:8px">展开全文</button>' : '') +
          chain + '</div>';
      }).join('');
      box.querySelectorAll('[data-obj]').forEach(function (b) {
        b.addEventListener('click', function () {
          var o = d.items[Number(b.dataset.obj)];
          b.previousElementSibling.textContent = o.a;
          b.remove();
        });
      });
    }).catch(function (e) { errorBox(box, e); });
  }

  function renderObFilters() {
    call('/objections?limit=1').then(function (d) {
      var catBox = $('#ob-cats');
      catBox.innerHTML = '';
      [''].concat(d.cats).forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'js-scene';
        b.setAttribute('aria-pressed', String(state.ob.cat === c));
        b.innerHTML = (c || '全部品类') + '<span>' + (c ? '' : d.total) + '</span>';
        b.addEventListener('click', function () { state.ob.cat = c; renderObFilters(); renderObjections(); });
        catBox.appendChild(b);
      });
      var tagBox = $('#ob-tags');
      tagBox.innerHTML = '';
      [''].concat(d.tags).forEach(function (t) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'js-chip';
        b.setAttribute('aria-pressed', String(state.ob.tag === t));
        b.textContent = t || '全部标签';
        b.addEventListener('click', function () { state.ob.tag = t; renderObFilters(); renderObjections(); });
        tagBox.appendChild(b);
      });
    }).catch(function () {});
  }

  /* ───────────── 内容工厂 ───────────── */
  function renderCopies() {
    var box = $('#cp-list'); if (!box) return;
    loading(box);
    var qs = ['limit=10'];
    if (state.cp.kind) qs.push('kind=' + encodeURIComponent(state.cp.kind));
    if (state.cp.q) qs.push('q=' + encodeURIComponent(state.cp.q));
    call('/copies?' + qs.join('&')).then(function (d) {
      $('#cp-count').textContent = '共 ' + d.total + ' 条';
      if (!d.items.length) { show(box, '<p class="js-empty">没找到，换个关键词。</p>'); return; }
      var prof = state.profile || {};
      var orgName = (prof.org && prof.org.name) || '';
      box.innerHTML = d.items.map(function (c) {
        var text = c.c;
        var replaced = false;
        if (orgName) { text = text.replace(/XX教育|XX机构|XX|xxx/gi, orgName); replaced = true; }
        return '<div class="js-sample">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">' +
          '<span class="js-tag w">' + esc(c.kind) + '</span>' +
          (c.placeholder ? '<span class="js-tag">原含占位符' + (orgName ? '·已替换' : '') + '</span>' : '') +
          '<em style="margin-left:auto;font-style:normal;font-size:11px;color:var(--p-text3)">' + esc((c.src || '').slice(0, 24)) + '</em></div>' +
          '<div style="white-space:pre-line;color:var(--p-text)">' + esc(text) + '</div>' +
          '</div>';
      }).join('') +
      (state.guest ? '<p class="js-lead" style="margin-top:8px">登录并填好机构画像后，文案里的 XX 会自动换成你的机构名。</p>'
        : replacedHint());
    }).catch(function (e) { errorBox(box, e); });
    function replacedHint() { return ''; }
  }

  function renderCopyKinds() {
    call('/copies?limit=1').then(function (d) {
      var box = $('#cp-kinds');
      box.innerHTML = '';
      [''].concat(d.kinds).forEach(function (k) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'js-chip';
        b.setAttribute('aria-pressed', String(state.cp.kind === k));
        b.textContent = k || '全部';
        b.addEventListener('click', function () { state.cp.kind = k; renderCopyKinds(); renderCopies(); });
        box.appendChild(b);
      });
    }).catch(function () {});
  }

  /* ───────────── 转化教练 ───────────── */
  function renderCoach() {
    var box = $('#co-checks');
    call('/playbook').then(function (d) {
      state.co.steps = d.sops.trial10;
      box.innerHTML = d.sops.trial10.map(function (s, i) {
        return '<button class="js-check" type="button" data-step="' + i + '">' +
          '<span class="js-box"><i data-lucide="check" aria-hidden="true"></i></span>' +
          '<span><b>' + esc(s.name) + '</b><p>' + esc(s.detail) + '</p></span>' +
          '<span class="js-min">' + esc(s.min) + '</span></button>';
      }).join('');
      box.querySelectorAll('[data-step]').forEach(function (el) {
        el.addEventListener('click', function () {
          var i = Number(el.dataset.step);
          var k = state.co.done.indexOf(i);
          if (k >= 0) state.co.done.splice(k, 1); else state.co.done.push(i);
          renderCoachScore();
        });
      });
      $('#co-abcd').innerHTML = d.sops.abcd.map(function (a) {
        return '<div class="js-abox"><b>' + esc(a.k) + '</b><span>' + esc(a.name) + '</span><p>' + esc(a.rule) + '</p></div>';
      }).join('');
      if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      renderCoachScore();
    }).catch(function (e) { errorBox(box, e); });
  }
  function renderCoachScore() {
    var n = state.co.done.length, total = state.co.steps.length || 10;
    $$('[data-step]').forEach(function (el) {
      var i = Number(el.dataset.step), on = state.co.done.indexOf(i) >= 0;
      el.querySelector('.js-box').classList.toggle('on', on);
      var mid = el.children[1];
      if (mid) mid.className = on ? 'done' : '';
    });
    $('#co-bar').style.width = Math.round(n / total * 100) + '%';
    $('#co-score').textContent = '已完成 ' + n + ' / ' + total + ' 步 · 得分 ' + (n * 10) + ' 分' +
      (n >= 9 ? '（A 类，可以进入逼单）' : n >= 7 ? '（B 类，注意补漏）' : '');
  }

  /* ───────────── 团队作战 ───────────── */
  function renderTeam() {
    call('/playbook').then(function (d) {
      var pool = d.incentives.pool;
      $('#tm-thlabel').textContent = '并入奖金池（超过 ' + pool.threshold + ' 万后，超出部分的 ' + Math.round(pool.rate * 100) + '%）';
      var range = $('#tm-range');
      function calc() {
        var v = Number(range.value);
        var p = Math.max(0, v - pool.threshold) * pool.rate;
        $('#tm-perf').textContent = v;
        $('#tm-pool').textContent = p.toFixed(1) + ' 万';
        $('#tm-p1').textContent = (p * pool.champion).toFixed(2) + ' 万（' + Math.round(pool.champion * 100) + '%）';
        $('#tm-p2').textContent = (p * pool.team).toFixed(2) + ' 万（' + Math.round(pool.team * 100) + '%）';
        $('#tm-p3').textContent = (p * (1 - pool.champion - pool.team)).toFixed(2) + ' 万';
      }
      range.addEventListener('input', calc);
      calc();

      var inc = d.incentives;
      function rows(list, keyA, keyB) {
        return list.map(function (x) {
          return '<div class="js-bench"><span>' + esc(x[keyA]) + '</span><b>' + esc(x[keyB]) + '</b></div>';
        }).join('');
      }
      $('#tm-inc').innerHTML =
        '<p class="js-lead"><b style="font-weight:500;color:var(--p-text)">提成阶梯</b></p>' + rows(inc.commission, 'range', 'amount') +
        '<p class="js-lead" style="margin-top:10px"><b style="font-weight:500;color:var(--p-text)">续班奖罚（按续班率）</b></p>' + rows(inc.renew, 'range', 'amount') +
        '<p class="js-lead" style="margin-top:10px"><b style="font-weight:500;color:var(--p-text)">转介绍阶梯</b></p>' + rows(inc.referral, 'range', 'amount') +
        '<div class="js-oath" style="margin-top:12px">“' + esc(inc.oath) + '”<br><span style="color:var(--p-text3);font-size:11px">— 资料库里的目标书誓词原文</span></div>' +
        '<p class="js-lead" style="margin-top:10px">' + esc(pool.note) + '</p>';
    }).catch(function (e) { errorBox($('#tm-inc'), e); });
  }

  /* ───────────── 复盘报告（真算）───────────── */
  function readReview() {
    function n(id) { var v = $(id).value; return v === '' ? null : Number(v); }
    return { lead: n('#rv-lead'), visit: n('#rv-visit'), trial: n('#rv-trial'), deal: n('#rv-deal'), cost: n('#rv-cost'), revenue: n('#rv-revenue') };
  }
  function renderReview() {
    var d = readReview();
    if (d.lead === null || d.visit === null || d.deal === null || d.lead <= 0) {
      $('#rv-msg').textContent = '至少填「线索数、到访数、成交数」，线索要大于 0。';
      $('#rv-out').innerHTML = '<p class="js-empty">数据不够，算不出来。</p>';
      return null;
    }
    function rate(a, b) { return (b && b > 0) ? a / b : null; }
    function pct(x) { return x === null ? '—' : (x * 100).toFixed(1) + '%'; }

    var bars = [['线索 ' + d.lead, 1, '—'],
                ['到访 ' + d.visit, rate(d.visit, d.lead) || 0, pct(rate(d.visit, d.lead)) + '（线索→到访）']];
    if (d.trial !== null) bars.push(['试听 ' + d.trial, rate(d.trial, d.lead) || 0, pct(rate(d.trial, d.visit)) + '（到访→试听）']);
    bars.push(['成交 ' + d.deal, rate(d.deal, d.lead) || 0, pct(rate(d.deal, d.trial !== null ? d.trial : d.visit)) + '（' + (d.trial !== null ? '试听→成交' : '到访→成交') + '）']);

    var out = ['<div class="js-funnel">' + bars.map(function (b) {
      return '<div class="js-frow"><b>' + esc(b[0]) + '</b><div class="js-fbar"><i style="width:' + Math.max(3, Math.round(b[1] * 100)) + '%"></i></div><em>' + esc(b[2]) + '</em></div>';
    }).join('') + '</div>'];

    if (d.cost !== null) {
      out.push('<div class="js-bench" style="margin-top:12px"><span>线索成本</span><b>¥ ' + (d.cost / d.lead).toFixed(1) + ' / 条</b></div>');
      if (d.deal > 0) out.push('<div class="js-bench"><span>单客获取成本</span><b>¥ ' + Math.round(d.cost / d.deal) + '</b></div>');
    }
    if (d.cost !== null && d.revenue !== null && d.cost > 0) {
      out.push('<div class="js-bench"><span>投入产出比</span><b>' + (d.revenue / d.cost).toFixed(2) + ' : 1</b></div>');
      out.push('<div class="js-bench"><span>毛利（未扣人力）</span><b>¥ ' + (d.revenue - d.cost).toLocaleString() + '</b></div>');
    }

    var pairs = [[rate(d.visit, d.lead), '线索→到访'],
                 [d.trial !== null ? rate(d.trial, d.visit) : null, '到访→试听'],
                 [rate(d.deal, d.trial !== null ? d.trial : d.visit), d.trial !== null ? '试听→成交' : '到访→成交']];
    var worst = null;
    pairs.forEach(function (p) { if (p[0] !== null && (worst === null || p[0] < worst[0])) worst = p; });
    if (worst) {
      var advice = worst[1] === '线索→到访'
        ? '地推/社群把「到店礼」前置，现场就把时间约死。'
        : worst[1] === '到访→试听'
          ? '《体验课地推活动话术》的「2 条短信 + 1 个电话」：短信当天发、D+3 补一条，电话在试听前一天确认到场。'
          : '《试听课标准流程》里的一对一咨询（30 分钟起）和课程反馈（20 分钟）这两步别省。';
      out.push('<div class="js-mnote" style="margin-top:12px">最弱的一环是「' + esc(worst[1]) + '」，只有 ' + pct(worst[0]) + '。资料库里对应的打法：' + advice + '</div>');
    }
    show($('#rv-out'), out.join(''));
    return { d: d, rates: { visit: rate(d.visit, d.lead), deal: rate(d.deal, d.trial !== null ? d.trial : d.visit) } };
  }

  /* ───────────── 合规哨兵 ───────────── */
  function renderComplianceWords() {
    call('/compliance/words').then(function (d) {
      $('#cs-stats').textContent = '全库 ' + d.scanned + ' 份 / ' + Math.round(d.chars / 10000) + ' 万字';
      $('#cs-words').innerHTML = d.words.map(function (w) {
        return '<div class="js-bench"><span>' + esc(w.word) + ' <em style="font-style:normal;color:var(--p-text3);font-size:11px">' + esc(w.level) + '</em><br>' +
          '<em style="font-style:normal;color:var(--p-text3);font-size:11px">' + esc(w.advice) + '</em></span><b style="color:var(--p-red)">' + w.count + ' 次</b></div>';
      }).join('');
    }).catch(function (e) { errorBox($('#cs-words'), e); });
  }
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
        return '<div class="js-bench"><span>' + esc(h.word) + ' <em style="font-style:normal;font-size:11px;color:var(--p-red)">' + esc(h.level) + ' × ' + h.hits + '</em><br>' +
          '<em style="font-style:normal;font-size:11px;color:var(--p-text3)">' + esc(h.advice) + '</em></span></div>';
      }).join('');
      var risky = d.risky.length ? '<div class="js-mnote" style="margin-top:10px">还需人工确认：<br>' + d.risky.map(esc).join('<br>') + '</div>' : '';
      show(out, head + hits + risky);
    }).catch(function (e) { errorBox(out, e); });
  }

  /* ───────────── 机构画像 ───────────── */
  var GROUPS = [
    ['org', '基本信息', ['name', 'shortName', 'foundedYear', 'city', 'campuses']],
    ['product', '产品体系', ['categories', 'classTypes', 'unitPrice', 'mainPackage', 'discountFloor']],
    ['teacher', '师资信息', ['headcount', 'education', 'seniority', 'star']],
    ['biz', '经营数据', ['students', 'perCampus', 'fullRate', 'renewRate', 'leadCost', 'visitRate', 'dealRate']],
    ['reach', '触达方式', ['wecomQr', 'officialAccount', 'douyin', 'phone', 'addressScript']],
    ['cases', '案例素材', ['caseStudy', 'praise', 'achievements']],
    ['risk', '合规红线', ['forbiddenWords', 'noPromise', 'prepayRule']],
  ];
  var FIELD_LABEL = {
    name: '机构名称', shortName: '简称', foundedYear: '成立年份', city: '城市', campuses: '校区分布',
    categories: '课程品类', classTypes: '班型', unitPrice: '课时单价', mainPackage: '主力课包', discountFloor: '优惠底线',
    headcount: '教师人数', education: '学历构成', seniority: '教龄构成', star: '明星教师',
    students: '在读学员', perCampus: '分校区人数', fullRate: '满班率', renewRate: '历史续班率',
    leadCost: '线索成本（自动）', visitRate: '到访率（自动）', dealRate: '成交率（自动）',
    wecomQr: '企业微信活码', officialAccount: '公众号', douyin: '抖音号', phone: '联系电话', addressScript: '地址话术',
    caseStudy: '学员案例', praise: '家长好评', achievements: '成果数据',
    forbiddenWords: '不能说的词', noPromise: '不能承诺的事', prepayRule: '预收费规则',
  };
  var GROUP_LABEL = {};
  GROUPS.forEach(function (g) { GROUP_LABEL[g[0]] = g[1]; });

  function renderProfileGroups() {
    var box = $('#pf-groups');
    if (!box) return;
    box.innerHTML = '';
    var missing = (state.completion && state.completion.missing) || [];
    GROUPS.forEach(function (g) {
      var miss = missing.indexOf(g[0]) >= 0;
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'js-scene';
      b.setAttribute('aria-pressed', String(state.pfGroup === g[0]));
      b.innerHTML = g[1] + '<span style="' + (miss ? '' : 'color:var(--p-green)') + '">' + (miss ? '待补充' : '已完成') + '</span>';
      b.addEventListener('click', function () { state.pfGroup = g[0]; renderProfileGroups(); renderProfileFields(); });
      box.appendChild(b);
    });
  }
  function renderProfileFields() {
    var g = GROUPS.filter(function (x) { return x[0] === state.pfGroup; })[0];
    if (!g) return;
    $('#pf-title').textContent = g[1];
    var bag = (state.pfDraft[g[0]] || {});
    $('#pf-fields').innerHTML = g[2].map(function (f) {
      return '<div class="js-field"><label for="pf_' + f + '">' + esc(FIELD_LABEL[f] || f) + '</label>' +
        '<input id="pf_' + f + '" data-pf="' + f + '" type="text" value="' + esc(bag[f] || '') + '" placeholder="待补充"' +
        (state.guest ? ' disabled' : '') + '></div>';
    }).join('');
    $('#pf-msg').textContent = state.guest ? '未登录：可以看，改不了。用机构账号登录后就能保存。' : '';
  }
  function renderProfile() {
    $('#pf-percent').textContent = '完成度 ' + (state.completion ? state.completion.percent : 0) + '%';
    $('#pf-bar').style.width = (state.completion ? state.completion.percent : 0) + '%';
    $('#nav-pf').textContent = (state.completion ? state.completion.percent : 0) + '%';
    state.pfDraft = {};
    GROUPS.forEach(function (g) { state.pfDraft[g[0]] = Object.assign({}, (state.profile && state.profile[g[0]]) || {}); });
    renderProfileGroups();
    renderProfileFields();
  }

  /* ───────────── 策划室 ───────────── */
  function renderPlanner() {
    call('/playbook').then(function (pb) {
      var nodeBox = $('#pl-nodes');
      var nodes = ['', '开学季', '双十一', '国庆', '暑假', '寒假', '母亲节', '儿童节', '端午', '中秋'];
      nodeBox.innerHTML = '';
      nodes.forEach(function (n) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'js-chip';
        b.setAttribute('aria-pressed', String(state.pl.node === n));
        b.textContent = n || '不限节点';
        b.addEventListener('click', function () { state.pl.node = n; renderPlanner(); });
        nodeBox.appendChild(b);
      });
      var kinds = [''];
      pb.hooks.forEach(function (h) { if (kinds.indexOf(h.kind) < 0) kinds.push(h.kind); });
      var kindBox = $('#pl-kinds');
      kindBox.innerHTML = '';
      kinds.forEach(function (k) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'js-chip';
        b.setAttribute('aria-pressed', String(state.pl.kind === k));
        b.textContent = k || '不限玩法类型';
        b.addEventListener('click', function () { state.pl.kind = k; renderPlanner(); });
        kindBox.appendChild(b);
      });

      var hooks = pb.hooks.filter(function (h) {
        if (state.pl.kind && h.kind !== state.pl.kind) return false;
        if (state.pl.node && (h.name + h.rule + h.note).indexOf(state.pl.node) < 0) return false;
        return true;
      });
      $('#pl-count').textContent = '库里 ' + pb.hooks.length + ' 个玩法，筛出 ' + hooks.length + ' 个';
      show($('#pl-hooks'), hooks.length ? hooks.map(function (h) {
        return '<div class="js-hook"><b>' + esc(h.name) + ' <span class="js-tag w">' + esc(h.kind) + '</span></b><dl>' +
          '<dt>价格 </dt><dd>' + esc(h.price) + '</dd><br>' +
          '<dt>规则 </dt><dd>' + esc(h.rule) + '</dd><br>' +
          '<dt>注意 </dt><dd>' + esc(h.note) + '</dd><br>' +
          '<dt>出处 </dt><dd>' + esc(h.src) + '</dd></dl></div>';
      }).join('') : '<p class="js-empty">这个组合下库里没有现成玩法，换个类型看看。</p>');

      var keyword = state.pl.node || (state.overview ? String(state.overview.month) + '月' : '');
      var box = $('#pl-mats');
      loading(box);
      call('/library?limit=8' + (keyword ? '&q=' + encodeURIComponent(keyword) : '')).then(function (d) {
        show(box, d.total
          ? d.items.map(function (it) {
            return '<div class="js-doc" style="cursor:default"><span class="js-tag">' + esc(it.kind) + '</span><b>' + esc(it.t) + '</b><em>' + esc(it.cat) + '</em></div>';
          }).join('') + '<p class="js-lead" style="margin-top:6px">共 ' + d.total + ' 条，去「素材库」可以看全文摘要。</p>'
          : '<p class="js-empty">这个关键词下没有素材。</p>');
      }).catch(function (e) { errorBox(box, e); });
    }).catch(function (e) { errorBox($('#pl-hooks'), e); });
  }

  /* ───────────── 各屏首次进入 ───────────── */
  var INIT = {
    war: renderWar,
    planner: renderPlanner,
    script: function () { renderObFilters(); renderObjections(); },
    content: function () {
      renderCopyKinds(); renderCopies();
      call('/playbook').then(function (d) {
        show($('#cf-schedule'), d.sops.daily.map(function (s) {
          return '<div class="js-slot"><b>' + esc(s.slot) + '</b><span>' + esc(s.detail) + '</span></div>';
        }).join(''));
        show($('#cf-week'), d.sops.week.map(function (w) {
          return '<div class="js-slot"><b>' + esc(w.day) + '</b><span>' + esc(w.detail) + '</span></div>';
        }).join(''));
        show($('#cf-flash'), d.sops.flash7.map(function (f) {
          return '<div class="js-slot"><b>' + esc(f.name) + '</b><span>' + esc(f.detail) + '</span></div>';
        }).join(''));
        $('#cf-accept').innerHTML = '验收标准（资料库原文）：' + d.sops.acceptance.map(function (a) {
          return '<b style="font-weight:500">' + esc(a.metric) + ' ' + esc(a.target) + '</b>';
        }).join(' · ');
      }).catch(function (e) { errorBox($('#cf-schedule'), e); });
    },
    coach: renderCoach,
    team: renderTeam,
    review: function () { $('#rv-out').innerHTML = '<p class="js-empty">左边填数，点「算转化漏斗」。</p>'; },
    library: function () {
      renderLib();
      call('/library/facets').then(function (f) {
        var box = $('#lib-scenes');
        box.innerHTML = '';
        var list = [''].concat(f.scene.slice(0, 12).map(function (x) { return x.k; }));
        list.forEach(function (s) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'js-chip';
          b.setAttribute('aria-pressed', String(state.lib.scene === s));
          var found = f.scene.filter(function (x) { return x.k === s; })[0];
          b.textContent = (s || '全部场景') + (found ? '（' + found.n + '）' : '');
          b.addEventListener('click', function () { state.lib.scene = s; renderLib(); INIT.library(); });
          box.appendChild(b);
        });
      }).catch(function () {});
    },
    compliance: renderComplianceWords,
    profile: renderProfile,
  };

  /* ───────────── 事件绑定 ───────────── */
  $('#js-q').addEventListener('input', debounce(function (e) { state.lib.q = e.target.value.trim(); renderLib(); }, 300));
  $('#ob-q').addEventListener('input', debounce(function (e) { state.ob.q = e.target.value.trim(); renderObjections(); }, 300));
  $('#cp-q').addEventListener('input', debounce(function (e) { state.cp.q = e.target.value.trim(); renderCopies(); }, 300));
  $('#cs-run').addEventListener('click', runCompliance);
  $('#cs-demo').addEventListener('click', function () {
    $('#cs-text').value = '我们是烟台最大的美术教育机构，老师都是最好的，全网最低价，保证孩子第一节课就爱上画画。活动原价199元现价0元，还抽红包墙大奖。';
    runCompliance();
  });
  $('#rv-calc').addEventListener('click', function () { renderReview(); });
  $('#rv-save').addEventListener('click', function () {
    var r = renderReview();
    if (!r) return;
    if (state.guest) { $('#rv-msg').textContent = '未登录，存不了基准值。用机构账号登录后再点。'; return; }
    state.pfDraft.biz = Object.assign({}, state.pfDraft.biz, {
      leadCost: '¥' + (r.d.cost !== null ? (r.d.cost / r.d.lead).toFixed(1) : '—') + '/条',
      visitRate: r.rates.visit !== null ? (r.rates.visit * 100).toFixed(1) + '%' : '',
      dealRate: r.rates.deal !== null ? (r.rates.deal * 100).toFixed(1) + '%' : '',
    });
    saveProfile('已把这场的基准值并入「经营数据」并保存。');
  });
  $('#pf-save').addEventListener('click', function () { saveProfile('已保存。'); });

  function collectProfile() {
    var draft = JSON.parse(JSON.stringify(state.pfDraft));
    $$('[data-pf]').forEach(function (inp) {
      var bag = draft[state.pfGroup] || (draft[state.pfGroup] = {});
      if (inp.value.trim()) bag[inp.dataset.pf] = inp.value.trim();
      else delete bag[inp.dataset.pf];
    });
    return draft;
  }
  function saveProfile(okMsg) {
    if (state.guest) { $('#pf-msg').textContent = '未登录，保存不了。用机构账号登录后再试。'; return; }
    var draft = collectProfile();
    state.pfDraft = draft;
    $('#pf-msg').textContent = '保存中…';
    call('/profile', { method: 'PUT', body: { profile: draft } }).then(function (d) {
      state.profile = d.profile;
      state.completion = d.completion;
      $('#pf-msg').textContent = okMsg || '已保存。';
      renderProfile();
      if (state.overview) { state.overview.completion = d.completion; state.overview.profile = d.profile; renderWar(); }
    }).catch(function (e) { $('#pf-msg').textContent = '保存失败：' + e.message; });
  }

  /* ───────────── 启动 ───────────── */
  call('/overview').then(function (o) {
    state.overview = o;
    state.month = o.month;
    state.profile = o.profile;
    state.completion = o.completion;
    state.guest = !(o.profile && o.profile.org && o.profile.org.name);
    $('#nav-lib').textContent = o.stats.library;
    $('#js-orgchip').textContent = (o.profile && o.profile.org && o.profile.org.name)
      ? o.profile.org.name
      : '未填机构画像 · 参考数据可直接看';
    $('#js-sidenote').innerHTML = '军师的产出都走两遍：<br>一遍过机构画像，<br>一遍过合规哨兵。';
    renderWar();
  }).catch(function (e) {
    $('#war-cast').innerHTML = '<b>数据没加载出来</b><br>' + esc(e.message);
  });

  showScreen(state.screen);
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
})();
