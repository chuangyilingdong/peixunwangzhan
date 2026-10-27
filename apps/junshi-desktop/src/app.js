const app = window.junshiApp;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const PAGE_META = {
  home: { title: '首页', eyebrow: 'CONTENT STUDIO' },
  create: { title: '做内容', eyebrow: 'CREATE CONTENT' },
  peers: { title: '同行采集', eyebrow: 'PEER RESEARCH' },
  reports: { title: '我的数据', eyebrow: 'PERFORMANCE' },
  settings: { title: '设置', eyebrow: 'PREFERENCES' },
};

const state = {
  page: 'home',
  bootstrap: null,
  collector: null,
  remote: null,
  refs: [],
  reports: { items: [], ownCount: 0, pendingCount: 0 },
  jobs: [],
  jobKinds: [],
  jobStatuses: [],
  jobTotal: 0,
  plans: [],
  cycles: [],
  planDetail: null,
  cycleComposer: false,
  cycleBusy: false,
  cyclePollTimer: null,
  transcripts: [],
  createReference: null,
  createBusy: false,
  createAnswer: '',
  createStatus: '',
  createType: '口播稿',
  createGoal: '涨粉',
  createIdea: '',
  createTitleHint: '',
  createCopied: false,
  streamId: '',
  workflow: null,
  workflowMeta: { styles: [], angles: [], strengths: [], brains: [] },
  workflowBusy: false,
  workflowComposer: null,
  workflowPollTimer: null,
  brains: [],
  memories: [],
  assets: [],
  voices: [],
  voiceBusy: false,
  voicePollTimer: null,
  contextPanel: null,
  brainComposer: false,
  brainBusy: false,
  brainPollTimer: null,
  brainDetail: null,
  memoryBusy: false,
  production: {
    open: false,
    stage: 'draft',
    versions: [],
    draft: null,
    preflight: null,
    plan: null,
    work: null,
    renders: [],
    package: null,
    packageForm: null,
    busy: false,
    message: '',
    error: '',
    shotEdits: {},
    pollTimer: null,
    pollBusy: false,
  },
  insight: '',
  insightBusy: false,
  updateBusy: false,
  loaded: false,
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function fmtDate(value, withTime = false) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 16);
  return new Intl.DateTimeFormat('zh-CN', withTime ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { month: '2-digit', day: '2-digit' }).format(date);
}

function fmtBytes(value) {
  const number = Number(value) || 0;
  if (number >= 1024 * 1024 * 1024) return `${(number / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (number >= 1024 * 1024) return `${(number / 1024 / 1024).toFixed(1)} MB`;
  if (number >= 1024) return `${(number / 1024).toFixed(0)} KB`;
  return `${number} B`;
}

function fmtNumber(value) {
  const number = Number(value) || 0;
  if (number >= 100000000) return `${(number / 100000000).toFixed(1)}亿`;
  if (number >= 10000) return `${(number / 10000).toFixed(1)}万`;
  return number.toLocaleString('zh-CN');
}

function compactText(value, max = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function firstSentence(value, max = 48) {
  const text = String(value || '').replace(/^[#*\s]+/, '').replace(/\s+/g, ' ').trim();
  const sentence = text.split(/[。！？!?\n]/)[0].trim();
  return compactText(sentence || text, max);
}

function extractCreateVersions(value) {
  const raw = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];
  const pattern = /(?:^|\n)\s*(?:版本|方案)\s*([一二三123])(?:\s*[：:.\-、]?\s*)/g;
  const matches = [...raw.matchAll(pattern)];
  const labels = { '1': '一', '2': '二', '3': '三' };
  if (!matches.length) {
    const script = raw;
    return [{ label: '当前文案', title: firstSentence(script, 46) || '未命名内容', script, raw }];
  }
  return matches.map((match, index) => {
    const start = Number(match.index || 0) + match[0].length;
    const end = matches[index + 1] ? Number(matches[index + 1].index) : raw.length;
    const chunk = raw.slice(start, end).trim();
    const titleMatch = chunk.match(/(?:标题|选题)[：:]\s*([^\n]+)/);
    const bodyMatch = chunk.match(/(?:正文|口播|文案)[：:]\s*([\s\S]*)/);
    const script = String((bodyMatch && bodyMatch[1]) || chunk).trim();
    const firstLine = chunk.split('\n').map((line) => line.trim()).find((line) => line && !/^(正文|口播|文案)[：:]?$/.test(line)) || '';
    const cleanFirstLine = firstLine.replace(/^(标题|选题)[：:]\s*/, '').trim();
    const number = labels[match[1]] || match[1];
    return {
      label: `版本${number}`,
      title: compactText((titleMatch && titleMatch[1]) || (cleanFirstLine.length <= 60 ? cleanFirstLine : firstSentence(script, 46)) || '未命名内容', 60),
      script,
      raw: chunk,
    };
  }).filter((item) => item.script);
}

function productionGoalText(goal) {
  return {
    涨粉: '让更多本地家长认识并关注这个账号',
    咨询: '让有需求的家长主动私信或预约咨询',
    成交: '推动家长到店或报名体验',
    建立信任: '用真实场景消除家长对课程效果和价格的顾虑',
  }[goal] || goal || '建立信任并促成咨询';
}

function defaultVideoPrompt(script) {
  const excerpt = compactText(script, 220);
  return `根据以下口播制作一条短视频：${excerpt}\n画面要求：真实招生咨询与家庭教育场景，人物自然，镜头干净，字幕清晰；口播与画面对应；不使用虚假承诺、绝对化用语或未经授权的品牌元素。`;
}

function resetProduction() {
  if (state.production?.pollTimer) clearTimeout(state.production.pollTimer);
  state.production = {
    open: false,
    stage: 'draft',
    versions: [],
    draft: null,
    preflight: null,
    plan: null,
    work: null,
    renders: [],
    package: null,
    packageForm: null,
    busy: false,
    message: '',
    error: '',
    shotEdits: {},
    pollTimer: null,
    pollBusy: false,
  };
}

function startProductionFlow() {
  if (!state.createAnswer) return;
  const versions = extractCreateVersions(state.createAnswer);
  const selected = versions[0] || { title: firstSentence(state.createIdea, 46), script: state.createAnswer };
  resetProduction();
  state.production.open = true;
  state.production.stage = 'draft';
  state.production.versions = versions;
  state.production.draft = {
    title: state.createTitleHint || selected.title || firstSentence(state.createIdea, 46) || '未命名内容',
    objective: productionGoalText(state.createGoal),
    hook: firstSentence(selected.script, 52),
    script: selected.script,
    prompt: defaultVideoPrompt(selected.script),
    duration: 30,
    resolution: '768P',
    ratio: '9:16',
    generateAudio: true,
    productionMode: 'storyboard',
    imageAssetId: (state.assets || []).find((item) => item.kind === 'image')?.id || '',
    voiceId: (state.voices || []).find((item) => item.status === 'ready')?.id || '',
    speed: 'natural',
  };
  renderCreateOnly();
}

function pickProductionVersion(index) {
  const version = state.production.versions[Number(index)];
  if (!version || !state.production.draft) return;
  state.production.draft.title = version.title || state.production.draft.title;
  state.production.draft.hook = firstSentence(version.script, 52);
  state.production.draft.script = version.script;
  state.production.draft.prompt = defaultVideoPrompt(version.script);
  renderCreateOnly();
}

function toast(message, kind = '') {
  const node = $('#toast');
  node.textContent = message || '';
  node.className = `toast show ${kind}`.trim();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = 'toast'; }, 4200);
}

async function api(path, options = {}) {
  const result = await app.api(path, options);
  if (!result?.ok) throw new Error(result?.message || '请求失败');
  return result.data;
}

function navigate(page) {
  if (!PAGE_META[page]) return;
  state.page = page;
  render();
}

function statusBadge(status) {
  if (status === 'succeeded' || status === 'success') return '<span class="badge success">已完成</span>';
  if (status === 'failed') return '<span class="badge failed">失败</span>';
  if (status === 'running') return '<span class="badge running">进行中</span>';
  return `<span class="badge neutral">${escapeHtml(status || '待处理')}</span>`;
}

function jobRow(job) {
  const icon = job.kind?.includes('转写') ? '文' : job.kind?.includes('视频') ? '视' : '生';
  return `<div class="job-row">
    <span class="job-icon">${icon}</span>
    <div><b>${escapeHtml(job.detail || job.kind || '生成任务')}</b><small>${escapeHtml(job.kind || '')} · ${fmtDate(job.createdAt, true)}</small></div>
    ${statusBadge(job.status)}
  </div>`;
}

function updateShell() {
  const meta = PAGE_META[state.page];
  $('#page-title').textContent = meta.title;
  $('#page-eyebrow').textContent = meta.eyebrow;
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === state.page));
  const user = state.bootstrap?.user;
  const org = state.bootstrap?.organization;
  $('#user-name').textContent = user?.displayName || user?.login || '当前账号';
  $('#org-name').textContent = org?.name || user?.orgName || '';
  $('#user-avatar').textContent = (user?.displayName || user?.login || '军').slice(0, 1);
  const collector = state.collector || {};
  const sync = collector.sync || {};
  const dot = $('#collector-dot');
  dot.className = 'pulse-dot' + (sync.running ? ' running' : collector.pairing?.connected ? ' ready' : '');
  $('#collector-shortcut-text').textContent = sync.running ? `同步中 ${sync.done || 0}/${sync.total || 0}` : (collector.pairing?.connected ? '本地采集已连接' : '打开内置浏览器');
  const status = $('#global-status');
  status.className = 'status-chip' + (sync.running ? ' running' : collector.pairing?.connected ? '' : ' warn');
  status.querySelector('span').textContent = sync.running ? (sync.message || '正在同步') : collector.pairing?.connected ? '本地采集已连接' : '本地采集未连接';
}

async function loadAll({ silent = false, rerender = true } = {}) {
  if (!silent) {
    $('#view').innerHTML = '<div class="loading-block"><span class="spinner"></span><b>正在准备你的工作台…</b></div>';
  }
  try {
    const [bootstrap, collector, remote, refs, reports, jobs, transcripts, workflowData, brainsData, memoriesData, assetsData, voicesData, plansData, cyclesData] = await Promise.all([
      app.bootstrap(),
      app.getCollectorStatus().catch(() => null),
      api('/bootstrap'),
      api('/refs'),
      api('/reports?accountId=default'),
      api('/jobs?limit=100'),
      api('/transcripts'),
      api('/workflows?accountId=default'),
      api('/brains'),
      api('/memories?accountId=default'),
      api('/assets?accountId=default'),
      api('/voices'),
      api('/plans?accountId=default'),
      api('/cycles?accountId=default'),
    ]);
    state.bootstrap = bootstrap;
    state.collector = collector;
    state.remote = remote;
    state.refs = Array.isArray(refs?.items) ? refs.items : [];
    state.reports = reports || { items: [], ownCount: 0, pendingCount: 0 };
    state.jobs = Array.isArray(jobs?.items) ? jobs.items : [];
    state.jobKinds = Array.isArray(jobs?.kinds) ? jobs.kinds : [];
    state.jobStatuses = Array.isArray(jobs?.statuses) ? jobs.statuses : [];
    state.jobTotal = Number(jobs?.total || state.jobs.length || 0);
    state.loaded = true;
    state.transcripts = Array.isArray(transcripts?.items) ? transcripts.items : [];
    state.brains = Array.isArray(brainsData?.items) ? brainsData.items : [];
    state.memories = Array.isArray(memoriesData?.items) ? memoriesData.items : [];
    state.assets = Array.isArray(assetsData?.items) ? assetsData.items : [];
    state.voices = Array.isArray(voicesData?.items) ? voicesData.items : [];
    state.plans = Array.isArray(plansData?.items) ? plansData.items : [];
    state.cycles = Array.isArray(cyclesData?.items) ? cyclesData.items : [];
    state.workflowMeta = {
      styles: Array.isArray(workflowData?.styles) ? workflowData.styles : [],
      angles: Array.isArray(workflowData?.angles) ? workflowData.angles : [],
      strengths: Array.isArray(workflowData?.strengths) ? workflowData.strengths : [],
      brains: Array.isArray(workflowData?.brains) ? workflowData.brains : [],
    };
    if (!state.workflow) state.workflow = (workflowData?.items || []).find((item) => item.status === 'active') || null;
    updateShell();
    if (rerender) render();
    if (state.workflow?.status === 'active') startWorkflowPolling();
  } catch (error) {
    if (!silent) {
      $('#view').innerHTML = `<div class="empty-state"><span class="big-icon">!</span><b>工作台加载失败</b><p>${escapeHtml(error?.message || error)}</p><button class="btn primary" data-action="reload">重新加载</button></div>`;
    }
  }
}

function renderHome() {
  const refs = state.refs.length;
  const works = state.reports?.items?.length || 0;
  const jobs = Number(state.remote?.stats?.jobs || state.jobs.length || 0);
  const sync = state.collector?.sync || {};
  const recent = state.jobs.slice(0, 5);
  const lastSyncAt = state.collector?.lastSync?.at || state.refs.map((ref) => ref.lastSyncAt).filter(Boolean).sort().at(-1) || "";
  return `<div class="page">
    <section class="hero">
      <div class="hero-copy">
        <h2>今天想做什么？<br>点一下就开始。</h2>
        <p>不用记功能放在哪。做内容、看同行、同步自己的作品，都从下面三个大按钮开始。</p>
        <div class="hero-actions">
          <button class="btn primary" data-action="go-create">做一条内容</button>
          <button class="btn secondary" data-action="open-collector">打开本地采集</button>
        </div>
      </div>
      <div class="hero-side">
        <div class="hero-mini"><span class="hero-mini-icon">文</span><div><b>${refs} 个同行在观察</b><small>${sync.running ? (sync.message || '正在同步') : '随时可以采集最新作品'}</small></div></div>
        <div class="hero-mini"><span class="hero-mini-icon">数</span><div><b>${works} 条作品已复盘</b><small>播放 ${fmtNumber((state.reports?.items || []).reduce((sum, item) => sum + Number(item.stats?.plays || 0), 0))}</small></div></div>
      </div>
    </section>

    <div class="section-title"><h3>快捷操作</h3><span>一次只做一件事</span></div>
    <div class="quick-grid">
      <button class="action-card primary" data-action="go-create"><span class="icon">✦</span><span><b>做内容</b><p>告诉我主题，生成 3 个能直接发的版本</p></span></button>
      <button class="action-card green" data-action="open-collector"><span class="icon">⌁</span><span><b>采集同行</b><p>在内置浏览器里打开主页，点一下采集</p></span></button>
      <button class="action-card amber" data-action="open-self"><span class="icon">◎</span><span><b>同步我的作品</b><p>把自己的播放、点赞、收藏同步到复盘</p></span></button>
      <button class="action-card violet" data-action="go-reports"><span class="icon">▥</span><span><b>看数据建议</b><p>用已同步作品生成下一周期建议</p></span></button>
    </div>

    <div class="section-title"><h3>今天的进度</h3><span>${sync.running ? '后台任务进行中' : '一切正常'}</span></div>
    <div class="stats-grid">
      <div class="stat-card"><span>同行</span><b>${refs}</b><small>已保存的主页</small></div>
      <div class="stat-card"><span>我的作品</span><b>${works}</b><small>已进入数据复盘</small></div>
      <div class="stat-card"><span>历史任务</span><b>${jobs}</b><small>生成与转写</small></div>
      <div class="stat-card"><span>最近同步</span><b>${lastSyncAt ? fmtDate(lastSyncAt, true) : '—'}</b><small>${state.collector?.lastSync?.ok === false ? '上次失败' : '本机执行'}</small></div>
    </div>

    <div class="section-title"><h3>最近任务</h3><span>${recent.length ? '最新 ' + recent.length + ' 条' : ''}</span></div>
    <div class="panel"><div class="panel-body">${recent.length ? `<div class="job-list">${recent.map(jobRow).join('')}</div>` : '<div class="empty-state" style="min-height:160px"><span class="big-icon">✓</span><b>还没有任务</b><p>从“做一条内容”开始，结果会出现在这里。</p></div>'}</div></div>
  </div>`;
}

const WORKFLOW_CARDS = [
  ['today', '今', '今日选题', '从账号档案和当前目标里，给出 3 个今天值得拍的方向。'],
  ['viral', '仿', '爆款复刻', '从现有文案、同行转写或抖音链接提取结构，再换成自己的表达。'],
  ['hotspot', '热', '热点结合', '联网找近 3 天热点，或手填一条新闻，再找到与账号的结合角度。'],
];

function workflowStageSteps(kind, stage) {
  const steps = kind === 'today'
    ? [['idea', '选选题'], ['brain', '选写法'], ['rewriting', '写文案'], ['done', '完成']]
    : kind === 'viral'
      ? [['transcript', '确认原文'], ['rewriting', '改写文案'], ['done', '完成']]
      : [['searching', '找热点'], ['angle', '选角度'], ['brain', '选写法'], ['done', '完成']];
  const aliases = kind === 'viral'
    ? { extracting: 'transcript', extract_failed: 'transcript', copy: 'rewriting', ready: 'rewriting', failed: 'rewriting' }
    : kind === 'hotspot'
      ? { search_failed: 'searching', hotspots_ready: 'searching', rewriting: 'brain', copy: 'brain', ready: 'brain', failed: 'brain' }
      : { copy: 'rewriting', ready: 'rewriting', failed: 'rewriting' };
  const normalized = aliases[stage] || stage;
  const active = Math.max(0, steps.findIndex(([key]) => key === normalized));
  return `<div class="workflow-steps">${steps.map(([key, label], index) => `<div class="workflow-step${key === normalized ? ' active' : ''}${index < active ? ' done' : ''}"><span>${index < active ? '✓' : index + 1}</span><b>${label}</b></div>`).join('')}</div>`;
}

function renderWorkflowHub() {
  return `<section class="workflow-hub">
    <div class="workflow-hub-head"><div><span class="production-kicker">灵感工作流</span><h3>不知道写什么，从这三条开始</h3><p>不是另一套工具，选完方向后会直接回到“做内容”的定稿和制作流程。</p></div><div class="workflow-context-actions"><button type="button" data-action="context-open" data-context="brains">文案大脑 · ${state.brains.filter((item) => item.status === 'ready').length}</button><button type="button" data-action="context-open" data-context="memories">长期记忆 · ${state.memories.length}</button><button type="button" data-action="context-open" data-context="assets">素材 · ${state.assets.length}</button><button type="button" data-action="context-open" data-context="plans">方案 · ${state.plans.length}</button><button type="button" data-action="context-open" data-context="cycles">周期 · ${state.cycles.length}</button><button type="button" data-action="context-open" data-context="jobs">任务 · ${state.jobTotal}</button></div></div>
    <div class="workflow-card-grid">${WORKFLOW_CARDS.map(([kind, icon, title, desc]) => `<button type="button" class="workflow-launch-card ${kind}" data-action="workflow-open" data-kind="${kind}"><span class="workflow-launch-icon">${icon}</span><span><b>${title}</b><small>${desc}</small></span><em>开始 →</em></button>`).join('')}</div>
  </section>`;
}

function renderWorkflowComposer() {
  const composer = state.workflowComposer || {};
  const kind = composer.kind || 'today';
  const title = { today: '今日选题', viral: '爆款复刻', hotspot: '热点结合' }[kind] || '灵感工作流';
  let form = '';
  if (kind === 'today') {
    form = `<label class="production-field full"><span>今天大概想讲什么（可不填）</span><input id="workflow-goal" maxlength="200" placeholder="例如：家长总觉得课程贵，想讲清价值"></label><div class="workflow-composer-tip">会结合账号档案、机构资料和近期内容，给出 3 个不同方向。</div>`;
  } else if (kind === 'viral') {
    const source = composer.sourceType || 'text';
    const readyTranscripts = (state.transcripts || []).filter((item) => item.status === 'succeeded' && item.text);
    const sourceTabs = `<div class="chip-group workflow-source-tabs">${[['text', '现有文案'], ['transcript', `转写档案${readyTranscripts.length ? ` ${readyTranscripts.length}` : ''}`], ['link', '抖音作品链接'], ['upload', '上传视频']].map(([value, label]) => `<button type="button" class="choice-chip${source === value ? ' active' : ''}" data-action="workflow-viral-source" data-source="${value}">${label}</button>`).join('')}</div>`;
    const sourceInput = source === 'text'
      ? `<label class="production-field full"><span>爆款原文</span><textarea id="workflow-viral-text" rows="8" maxlength="4000" placeholder="把同行的口播或文案粘进来"></textarea></label>`
      : source === 'link'
        ? `<label class="production-field full"><span>抖音分享内容 / 单条作品链接</span><textarea id="workflow-viral-link" rows="4" maxlength="2000" placeholder="复制抖音分享口令，或粘贴单条作品链接"></textarea></label>`
        : source === 'upload'
          ? `<div class="workflow-composer-tip">点击“开始”后会打开系统文件选择器。视频只用于提取口播参考，不作为发布素材。</div>`
        : readyTranscripts.length
          ? `<label class="production-field full"><span>选择一条已转写作品</span><select id="workflow-viral-transcript">${readyTranscripts.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title || item.nickname || '未命名作品')}</option>`).join('')}</select></label>`
          : `<div class="workflow-warning">还没有可用的转写档案。先去「同行采集」或「我的数据」采集一条作品。</div>`;
    form = `${sourceTabs}${sourceInput}<div class="workflow-composer-tip">只学习结构、节奏和表达方法；不会照抄原文，也不会冒充原作者。</div>`;
  } else {
    const mode = composer.mode || 'keyword';
    form = `<div class="workflow-mode-switch"><button type="button" class="choice-chip${mode === 'keyword' ? ' active' : ''}" data-action="workflow-hotspot-mode" data-mode="keyword">关键词联网搜索</button><button type="button" class="choice-chip${mode === 'manual' ? ' active' : ''}" data-action="workflow-hotspot-mode" data-mode="manual">手动填写热点</button></div>${mode === 'keyword' ? `<label class="production-field full"><span>搜索关键词</span><input id="workflow-hotspot-keyword" maxlength="120" placeholder="例如：寒假托管 / 素质教育新政 / 校外培训监管"></label>` : `<label class="production-field full"><span>热点标题</span><input id="workflow-hotspot-title" maxlength="200" placeholder="例如：多地推行寒假托管"></label><label class="production-field full"><span>事实描述</span><textarea id="workflow-hotspot-fact" rows="4" maxlength="2000" placeholder="只写你已核对的事实，1–3 句即可"></textarea></label><label class="production-field full"><span>来源链接（可空）</span><input id="workflow-hotspot-url" maxlength="500" placeholder="https://…"></label>`}<div class="workflow-composer-tip">关键词模式会调用 DeepSeek 搜索；手动模式只引用你填写的事实，不编造新闻细节。</div>`;
  }
  return `<div class="workflow-shell"><div class="workflow-shell-head"><div><span class="production-kicker">新建工作流</span><h3>${title}</h3><p>先完成这一小步，接下来会回到现有内容定稿与制作。</p></div><button type="button" class="btn ghost small" data-action="workflow-composer-cancel">返回</button></div><div class="workflow-composer-form">${form}</div><div class="workflow-shell-foot"><small>工作流会把候选和过程存在平台，不会自动发布。</small><button type="button" class="btn primary" data-action="workflow-launch" data-kind="${kind}" ${state.workflowBusy ? 'disabled' : ''}>${state.workflowBusy ? '<span class="spinner"></span> 正在准备…' : '开始 →'}</button></div></div>`;
}

function workflowOptionCards(wf, options, idea = false) {
  if (!options.length) return '<div class="workflow-loading"><span class="spinner"></span><b>正在生成候选…</b><p>完成后会自动显示，不用留在这个页面。</p></div>';
  const copySelectable = ['copy', 'ready'].includes(wf.stage);
  return `<div class="workflow-option-list">${options.map((option, index) => idea
    ? `<article class="workflow-option"><span class="workflow-option-index">0${index + 1}</span><div><b>${escapeHtml(option.title || '未命名选题')}</b><p>${escapeHtml(option.hook || '')}</p><small>${escapeHtml(option.why || '')}</small></div><button type="button" class="btn primary small" data-action="workflow-select-idea" data-option-id="${escapeHtml(option.id)}">用这个选题</button></article>`
    : `<article class="workflow-option copy"><div class="workflow-copy-title"><b>${escapeHtml(option.title || `版本 ${index + 1}`)}</b>${option.hook ? `<small>${escapeHtml(option.hook)}</small>` : ''}</div><div class="workflow-copy-content">${escapeHtml(option.content || '')}</div><button type="button" class="btn primary small" data-action="workflow-select-copy" data-option-id="${escapeHtml(option.id)}"${copySelectable ? '' : ' disabled'}>${copySelectable ? '用这个版本' : '生成中…'}</button></article>`).join('')}</div>`;
}

function renderWorkflowCard() {
  const wf = state.workflow;
  if (!wf) return '';
  const stateData = wf.state || {};
  let body = '';
  if (['extracting', 'searching'].includes(wf.stage)) {
    body = `<div class="workflow-loading"><span class="spinner"></span><b>${escapeHtml(stateData.message || (wf.stage === 'searching' ? '正在联网搜索近期热点…' : '正在提取参考原文…'))}</b><p>这一步可能需要几十秒，完成后会自动出现下一步。</p></div>`;
  } else if (wf.stage === 'extract_failed' || wf.stage === 'search_failed') {
    body = `<div class="workflow-error"><b>${wf.stage === 'search_failed' ? '热点搜索没有完成' : '参考原文提取失败'}</b><p>${escapeHtml(stateData.extractError || wf.error || '可以重试，或换一种来源 / 手动填写。')}</p><div class="workflow-actions">${wf.stage === 'search_failed' ? '<button type="button" class="btn primary small" data-action="workflow-search-retry">重新搜索</button><button type="button" class="btn secondary small" data-action="workflow-search-manual">改用手动填写</button>' : '<button type="button" class="btn secondary small" data-action="workflow-cancel">放弃并换来源</button>'}</div></div>`;
  } else if (wf.stage === 'transcript') {
    body = `<label class="production-field full"><span>确认提取到的原文</span><textarea id="workflow-transcript" rows="10" maxlength="4000">${escapeHtml(stateData.transcript || '')}</textarea></label><div class="workflow-actions"><button type="button" class="btn secondary small" data-action="workflow-copy-transcript">复制原文</button><button type="button" class="btn primary small" data-action="workflow-confirm-transcript" ${state.workflowBusy ? 'disabled' : ''}>确认原文，开始改写 →</button></div>`;
  } else if (wf.stage === 'hotspots_ready') {
    body = `<p class="workflow-context">从近期搜索结果中挑出 ${(stateData.hotspots || []).length} 条可用热点。只引用事实，不要编造新闻细节。</p><div class="workflow-option-list">${(stateData.hotspots || []).map((item, index) => `<article class="workflow-option hotspot"><span class="workflow-option-index">0${index + 1}</span><div><b>${escapeHtml(item.title || '')}</b><p>${escapeHtml(item.fact || item.summary || '')}</p><small>${escapeHtml(item.sourceName || item.siteName || '')}${item.date ? ` · ${escapeHtml(String(item.date).slice(0, 10))}` : ''}</small></div><button type="button" class="btn primary small" data-action="workflow-select-hotspot" data-hotspot-id="${escapeHtml(item.id)}">选这个热点</button></article>`).join('')}</div>`;
  } else if (wf.stage === 'angle') {
    body = `<div class="workflow-context"><b>${escapeHtml((stateData.hotspot || {}).title || '已选热点')}</b><p>${escapeHtml((stateData.hotspot || {}).fact || '')}</p></div><h4>选择一个结合角度</h4><div class="workflow-choice-grid">${(state.workflowMeta?.angles || []).map((item) => { const [value, desc] = Array.isArray(item) ? item : [item, '']; return `<button type="button" class="workflow-choice" data-action="workflow-select-angle" data-angle="${escapeHtml(value)}"><b>${escapeHtml(value)}</b><small>${escapeHtml(desc)}</small></button>`; }).join('')}</div>`;
  } else if (wf.stage === 'brain') {
    const context = wf.kind === 'today' ? `选题：${(stateData.selectedIdea || {}).title || ''}` : wf.kind === 'hotspot' ? `热点：${(stateData.hotspot || {}).title || ''} · ${stateData.angle || ''}` : '原文已确认';
    const brains = state.workflowMeta?.brains || [];
    body = `<p class="workflow-context">${escapeHtml(context)}</p><h4>这次借谁的写法？</h4><div class="workflow-choice-grid"><button type="button" class="workflow-choice featured" data-action="workflow-select-brain" data-brain-id=""><b>系统基础表达</b><small>自然、清楚、有观点，不套用特定创作者的方法。</small></button>${brains.map((brain) => `<button type="button" class="workflow-choice" data-action="workflow-select-brain" data-brain-id="${escapeHtml(brain.id)}"><b>${escapeHtml(brain.name)}</b><small>借用结构、节奏和表达方法${brain.kind === 'peer_report' ? '（来自同行研究）' : ''}</small></button>`).join('')}</div><details class="workflow-style-details"><summary>不用写作大脑，改选表达风格</summary><div class="chip-group">${(state.workflowMeta?.styles || []).map((style) => `<button type="button" class="choice-chip" data-action="workflow-select-style" data-style="${escapeHtml(style)}">${escapeHtml(style)}</button>`).join('')}</div></details>`;
  } else if (wf.stage === 'idea') {
    body = `${workflowOptionCards(wf, stateData.ideaOptions || [], true)}<div class="workflow-actions"><button type="button" class="btn secondary small" data-action="workflow-regenerate">换一批选题</button></div>`;
  } else if (['rewriting', 'copy', 'ready'].includes(wf.stage)) {
    const options = stateData.copyOptions || [];
    body = `<h4>${wf.stage === 'ready' ? '3 个版本已完成，选一版进入定稿' : '正在写 3 个版本'}</h4>${stateData.message ? `<p class="workflow-context">${escapeHtml(stateData.message)}</p>` : ''}${workflowOptionCards(wf, options, false)}${wf.stage === 'ready' ? '<div class="workflow-actions"><button type="button" class="btn secondary small" data-action="workflow-regenerate">换一批</button></div>' : ''}`;
  } else if (wf.stage === 'failed') {
    body = `<div class="workflow-error"><b>这次没有完成</b><p>${escapeHtml(wf.error || '请重试')}</p><button type="button" class="btn primary small" data-action="workflow-regenerate">重新生成</button></div>`;
  } else {
    body = `<div class="workflow-loading"><span class="spinner"></span><b>${escapeHtml(wf.stageLabel || '处理中')}</b></div>`;
  }
  return `<div class="workflow-shell workflow-running"><div class="workflow-shell-head"><div><span class="production-kicker">${escapeHtml(wf.kindLabel || '创作工作流')}</span><h3>${escapeHtml(wf.kindLabel || '')}</h3><p>过程会自动刷新；完成后会回到“做内容”的定稿结果。</p></div><button type="button" class="btn ghost small" data-action="workflow-cancel">放弃当前流程</button></div>${workflowStageSteps(wf.kind, wf.stage)}<div class="workflow-card-body">${body}</div></div>`;
}

function renderWorkflowPage() {
  const composer = state.workflowComposer;
  return `<div class="page workflow-page"><div class="page-intro"><div><button type="button" class="production-back" data-action="${composer ? 'workflow-composer-cancel' : 'workflow-cancel'}">← ${composer ? '返回工作流' : '放弃当前流程'}</button><h2>${composer ? '新建灵感工作流' : '灵感工作流'}</h2><p>先选方向、参考或热点，再让系统生成候选；选定后会回到现有内容定稿与制作流程。</p></div></div>${composer ? renderWorkflowComposer() : renderWorkflowCard()}</div>`;
}

function brainStatusBadge(status) {
  if (status === 'ready') return '<span class="badge success">可用</span>';
  if (status === 'running') return '<span class="badge running">蒸馏中</span>';
  if (status === 'failed') return '<span class="badge failed">失败</span>';
  return `<span class="badge neutral">${escapeHtml(status || '待处理')}</span>`;
}

function renderBrainDetails(brain) {
  const profile = brain.profile && typeof brain.profile === 'object' ? brain.profile : {};
  const sections = Array.isArray(brain.sections) ? brain.sections : [];
  return `<div class="brain-detail"><div class="brain-detail-grid">${Object.entries(profile).map(([key, value]) => `<div><span>${escapeHtml(key)}</span><p>${escapeHtml(value)}</p></div>`).join('')}</div>${sections.length ? `<div class="brain-section-list">${sections.map((section) => `<article><b>${escapeHtml(section.title || '方法')}</b><p>${escapeHtml(section.content || '')}</p></article>`).join('')}</div>` : '<p class="section-note">这份档案暂时没有展开章节。</p>'}</div>`;
}

function renderBrainsPage() {
  const readyTranscripts = (state.transcripts || []).filter((item) => item.status === 'succeeded' && item.text);
  const composer = state.brainComposer ? `<div class="brain-composer"><div class="brain-composer-head"><div><span class="production-kicker">新建写作大脑</span><h3>从转写档案里提炼写法</h3><p>只学习方法、结构和表达方式，不模仿原作者身份，也不照抄内容。</p></div><button type="button" class="btn ghost small" data-action="brain-composer-toggle">取消</button></div><div class="production-form-grid"><label class="production-field"><span>类型</span><select id="brain-kind"><option value="copy_brain">写作大脑</option><option value="peer_report">同行研究简报</option></select></label><label class="production-field"><span>名称</span><input id="brain-name" maxlength="100" placeholder="例如：王老师口播方法"></label></div><div class="production-field full"><span>选择语料（至少 1 条，建议 2–5 条）</span>${readyTranscripts.length ? `<div class="brain-transcript-list">${readyTranscripts.slice(0, 20).map((item) => `<label><input type="checkbox" name="brainTranscript" value="${escapeHtml(item.id)}"><span><b>${escapeHtml(item.title || item.nickname || '未命名作品')}</b><small>${escapeHtml(item.nickname || '')}</small></span></label>`).join('')}</div>` : '<div class="workflow-warning">还没有已完成的转写档案，请先去「同行采集」采集作品并等待转写完成。</div>'}</div><div class="workflow-shell-foot"><small>蒸馏会生成思考框架、方法和带时间码的证据。</small><button type="button" class="btn primary" data-action="brain-create" ${state.brainBusy || !readyTranscripts.length ? 'disabled' : ''}>${state.brainBusy ? '<span class="spinner"></span> 创建中…' : '开始蒸馏 →'}</button></div></div>` : '';
  const list = state.brains.length ? `<div class="brain-card-list">${state.brains.map((brain) => `<article class="brain-card"><div class="brain-card-head"><div><span class="production-kicker">${brain.kind === 'peer_report' ? '同行研究简报' : '写作大脑'}</span><h3>${escapeHtml(brain.name)}</h3><p>${escapeHtml(brain.sourceNote || '')}</p></div>${brainStatusBadge(brain.status)}</div>${brain.status === 'running' ? '<div class="workflow-loading compact"><span class="spinner"></span><b>正在分析语料…</b><p>完成后会自动刷新。</p></div>' : brain.status === 'failed' ? `<div class="workflow-error"><b>蒸馏失败</b><p>${escapeHtml(brain.error || '请重新创建')}</p></div>` : `<div class="brain-card-actions"><button type="button" class="btn secondary small" data-action="brain-detail" data-brain-id="${escapeHtml(brain.id)}">${state.brainDetail === brain.id ? '收起详情' : '查看方法与证据'}</button><button type="button" class="btn ghost small" data-action="brain-delete" data-brain-id="${escapeHtml(brain.id)}">删除</button></div>${state.brainDetail === brain.id ? renderBrainDetails(brain) : ''}`}</article>`).join('')}</div>` : '<div class="workflow-empty"><b>还没有写作大脑</b><p>先从同行或自己的已转写作品里蒸馏一个，工作流的“选写法”阶段就会出现它。</p></div>';
  return `<div class="context-panel"><div class="context-panel-head"><div><button type="button" class="production-back" data-action="context-back">← 返回做内容</button><h2>文案大脑</h2><p>把已转写作品里的思考框架、写作方法和表达习惯沉淀成可复用的大脑。</p></div><button type="button" class="btn primary" data-action="brain-composer-toggle">${state.brainComposer ? '收起新建' : '新建写作大脑'}</button></div>${composer}<div class="section-title"><h3>已有档案</h3><span>${state.brains.length} 个</span></div>${list}</div>`;
}

function renderMemoryPage() {
  const list = state.memories.length ? `<div class="memory-list">${state.memories.map((memory) => `<article class="memory-card"><div><span>${memory.kind === 'inspiration' ? '灵感' : '长期记忆'}</span><b>${escapeHtml(memory.source || '手动记录')}</b><p>${escapeHtml(memory.content)}</p><small>${fmtDate(memory.createdAt, true)}</small></div><button type="button" class="btn ghost small" data-action="memory-delete" data-memory-id="${escapeHtml(memory.id)}">删除</button></article>`).join('')}</div>` : '<div class="workflow-empty"><b>还没有长期记忆</b><p>记录产品事实、家长高频问题、表达偏好和禁区，后续创作会持续参考。</p></div>';
  return `<div class="context-panel"><div class="context-panel-head"><div><button type="button" class="production-back" data-action="context-back">← 返回做内容</button><h2>长期记忆</h2><p>这里存的是机构长期有效的信息，不是一次性提示词。聊天与创作会自动参考最近记忆。</p></div></div><div class="memory-composer"><label class="production-field full"><span>新增长期记忆</span><textarea id="memory-content" rows="4" maxlength="2000" placeholder="例如：家长最常担心孩子坐不住；价格表达不要说“最便宜”；品牌名统一写“创易灵动”。"></textarea></label><div class="workflow-shell-foot"><label class="production-field"><span>类型</span><select id="memory-kind"><option value="memory">长期记忆</option><option value="inspiration">灵感</option></select></label><button type="button" class="btn primary" data-action="memory-create" ${state.memoryBusy ? 'disabled' : ''}>${state.memoryBusy ? '<span class="spinner"></span> 保存中…' : '保存记忆 →'}</button></div></div><div class="section-title"><h3>已保存</h3><span>${state.memories.length} 条</span></div>${list}</div>`;
}

function renderAssetsPage() {
  const items = state.assets || [];
  return `<div class="context-panel"><div class="context-panel-head"><div><button type="button" class="production-back" data-action="context-back">← 返回做内容</button><h2>素材库</h2><p>形象照、音色参考、复刻参考和成片都在这里。当前先提供上传、查看与下载，树形文件夹和 AI 分析在后续批次。</p></div><div class="context-head-actions"><button type="button" class="btn secondary small" data-action="asset-upload" data-kind="image">上传图片</button><button type="button" class="btn secondary small" data-action="asset-upload" data-kind="audio">上传音频</button><button type="button" class="btn secondary small" data-action="asset-upload" data-kind="video">上传视频</button></div></div><div class="asset-summary"><span>${items.length} 个素材</span><span>${items.filter((item) => item.kind === 'image').length} 图</span><span>${items.filter((item) => item.kind === 'audio').length} 音频</span><span>${items.filter((item) => item.kind === 'video').length} 视频</span></div>${items.length ? `<div class="asset-grid">${items.map((item) => `<article class="asset-card"><div class="asset-kind">${item.kind === 'image' ? '图' : item.kind === 'audio' ? '音' : item.kind === 'video' ? '视' : '文'}</div><div class="asset-main"><b>${escapeHtml(item.fileName || item.file_name || '未命名素材')}</b><small>${escapeHtml(item.folder || '未分类')} · ${fmtBytes(item.fileSize || item.file_size)} · ${fmtDate(item.createdAt, true)}</small></div><button type="button" class="btn ghost small" data-action="asset-download" data-asset-id="${escapeHtml(item.id)}" data-asset-name="${escapeHtml(item.fileName || item.file_name || '素材')}">下载</button></article>`).join('')}</div>` : '<div class="workflow-empty"><b>素材库还是空的</b><p>上传形象照、音色参考或复刻视频后，会出现在这里，也能在制作方式里直接选择。</p></div>'}</div>`;
}

function renderJobsPage() {
  const jobs = state.jobs || [];
  return `<div class="context-panel"><div class="context-panel-head"><div><button type="button" class="production-back" data-action="context-back">← 返回做内容</button><h2>任务中心</h2><p>文案、转写、编导稿、渲染、数字人和发布包任务都在这里。失败任务可直接重试。</p></div><button type="button" class="btn secondary small" data-action="jobs-refresh">刷新</button></div><div class="job-summary"><span>${state.jobTotal} 个任务</span>${(state.jobStatuses || []).map((item) => `<span>${escapeHtml(item.status)} ${item.count}</span>`).join('')}</div>${jobs.length ? `<div class="job-center-list">${jobs.map((job) => `<article class="job-center-card"><div class="job-center-head"><div><span>${escapeHtml(job.kind || '任务')}</span><b>${escapeHtml(job.detail || '未命名任务')}</b></div>${statusBadge(job.status)}</div><p>${escapeHtml(job.error || (job.status === 'running' ? '任务进行中…' : '任务已结束'))}</p><div class="job-center-foot"><small>${fmtDate(job.createdAt, true)}${Number(job.attempts) ? ` · 第 ${Number(job.attempts) + 1} 次` : ''}</small>${job.status === 'failed' ? `<button type="button" class="btn secondary small" data-action="job-retry" data-job-id="${escapeHtml(job.id)}">重试</button>` : ''}</div></article>`).join('')}</div>` : '<div class="workflow-empty"><b>还没有任务</b><p>生成、转写、渲染和发布包任务会在这里留下记录。</p></div>'}</div>`;
}

function renderPlansPage() {
  const plans = state.plans || [];
  return `<div class="context-panel"><div class="context-panel-head"><div><button type="button" class="production-back" data-action="context-back">← 返回做内容</button><h2>内容方案库</h2><p>这里保存从“做内容”进入制作后形成的方案。可以检查、继续制作或回到方案确认。</p></div><button type="button" class="btn secondary small" data-action="plans-refresh">刷新</button></div>${plans.length ? `<div class="plan-library-list">${plans.map((plan) => `<article class="plan-library-card"><div class="plan-library-head"><div><span>${plan.status === 'submitted' ? '已提交制作' : '待确认'}</span><h3>${escapeHtml(plan.title || '未命名方案')}</h3><p>${escapeHtml(plan.objective || '')}</p></div>${statusBadge(plan.status === 'submitted' ? 'succeeded' : 'draft')}</div><div class="plan-library-meta"><span>${Number(plan.duration || 0)} 秒</span><span>${escapeHtml(plan.resolution || '')}</span><span>${escapeHtml(plan.ratio || '')}</span><span>${fmtDate(plan.createdAt, true)}</span></div><div class="plan-library-actions"><button type="button" class="btn ghost small" data-action="plan-library-detail" data-plan-id="${escapeHtml(plan.id)}">${state.planDetail === plan.id ? '收起方案' : '查看方案'}</button>${plan.status !== 'submitted' ? `<button type="button" class="btn primary small" data-action="plan-library-open" data-plan-id="${escapeHtml(plan.id)}">继续制作</button>` : ''}</div>${state.planDetail === plan.id ? `<div class="plan-library-detail"><div class="production-copy-block"><b>完整口播</b><p>${escapeHtml(plan.script || '')}</p></div><div class="production-copy-block"><b>画面提示词</b><p>${escapeHtml(plan.prompt || '')}</p></div></div>` : ''}</article>`).join('')}</div>` : '<div class="workflow-empty"><b>还没有内容方案</b><p>从做内容的定稿进入制作后，会先形成一份内容方案。</p></div>'}</div>`;
}

function cycleStatusLabel(status) {
  return { generating: '生成中', proposed: '待确认', confirmed: '已确认', failed: '失败' }[status] || status || '待处理';
}

function renderCyclesPage() {
  const cycles = state.cycles || [];
  const composer = state.cycleComposer ? `<div class="cycle-composer"><div class="brain-composer-head"><div><span class="production-kicker">生成周期计划</span><h3>按账号定位排下个周期</h3><p>系统会结合账号档案、已发布内容和已有计划去重。</p></div><button type="button" class="btn ghost small" data-action="cycle-composer-toggle">取消</button></div><label class="production-field full"><span>这周期想达成什么（可空）</span><textarea id="cycle-brief" rows="4" maxlength="1000" placeholder="例如：下周重点做家长信任，安排 3 条案例、2 条答疑"></textarea></label><div class="workflow-shell-foot"><small>生成周期计划不会创建视频任务，也不会扣渲染费。</small><button type="button" class="btn primary" data-action="cycle-create" ${state.cycleBusy ? 'disabled' : ''}>${state.cycleBusy ? '<span class="spinner"></span> 生成中…' : '生成 7 天计划 →'}</button></div></div>` : '';
  return `<div class="context-panel"><div class="context-panel-head"><div><button type="button" class="production-back" data-action="context-back">← 返回做内容</button><h2>周期计划</h2><p>先排这一周期做什么，再逐条进入创作。计划确认前不会创建或渲染视频任务。</p></div><button type="button" class="btn primary small" data-action="cycle-composer-toggle">${state.cycleComposer ? '收起生成' : '生成周期计划'}</button></div>${composer}${cycles.length ? `<div class="cycle-list">${cycles.map((cycle) => `<article class="cycle-card"><div class="cycle-head"><div><span>${escapeHtml(cycle.period || '未命名周期')}</span><h3>${Number(cycle.contentCount || cycle.slots?.length || 0)} 条内容</h3><p>${escapeHtml(cycle.brief || cycle.notice || '')}</p></div><span class="cycle-status ${escapeHtml(cycle.status || '')}">${cycleStatusLabel(cycle.status)}</span></div>${cycle.status === 'generating' ? '<div class="workflow-loading compact"><span class="spinner"></span><b>正在安排选题…</b><p>通常十几秒到一分钟。</p></div>' : `<div class="cycle-slot-list">${(cycle.slots || []).map((slot) => `<div class="cycle-slot"><div><b>${escapeHtml(slot.day || '')}</b><span>${escapeHtml(slot.contentType || '')}</span><p>${escapeHtml(slot.topic || '')}</p><small>${escapeHtml(slot.recommendationReason || slot.purpose || '')}</small></div><button type="button" class="btn secondary small" data-action="cycle-slot-use" data-cycle-id="${escapeHtml(cycle.id)}" data-slot-id="${escapeHtml(slot.id)}">用这个选题做内容</button></div>`).join('')}</div>${cycle.status === 'proposed' ? `<div class="cycle-actions"><small>确认后计划进入执行状态，但仍不会自动创建视频任务。</small><button type="button" class="btn primary small" data-action="cycle-confirm" data-cycle-id="${escapeHtml(cycle.id)}" data-version="${Number(cycle.version || 1)}">确认这份计划</button></div>` : ''}`}</article>`).join('')}</div>` : '<div class="workflow-empty"><b>还没有周期计划</b><p>先生成一份 7 天计划，再把推荐选题一条条带回做内容。</p></div>'}</div>`;
}

function renderContextPage() {
  const panel = state.contextPanel;
  const body = panel === 'memories' ? renderMemoryPage() : panel === 'assets' ? renderAssetsPage() : panel === 'jobs' ? renderJobsPage() : panel === 'plans' ? renderPlansPage() : panel === 'cycles' ? renderCyclesPage() : renderBrainsPage();
  return `<div class="page workflow-page">${body}</div>`;
}

function renderCreate() {
  if (state.production?.open) return renderProduction();
  if (state.contextPanel) return renderContextPage();
  if (state.workflow?.status === 'active' || state.workflowComposer) return renderWorkflowPage();
  const types = ['口播稿', '朋友圈文案', '短视频脚本', '选题清单'];
  const goals = ['涨粉', '咨询', '成交', '建立信任'];
  const hasOutput = Boolean(state.createAnswer || state.createBusy);
  const isComplete = Boolean(state.createAnswer) && !state.createBusy;
  const copyLabel = state.createCopied
    ? '再次复制'
    : state.createType === '选题清单'
      ? '复制清单'
      : state.createType === '短视频脚本'
        ? '复制脚本'
        : '复制文案';
  const nextTitle = '先定稿，再进入完整制作流程';
  const nextDetail = '定稿 → 内容方案 → 编导稿与分镜 → 渲染成片 → 发布包 → 发布 → 数据复盘';
  const canResumeProduction = Boolean(state.production?.plan || state.production?.work);

  const referenceHtml = state.createReference ? `<div class="reference-banner"><div><span>已参考同行</span><b>${escapeHtml(state.createReference.title || '同行口播')}</b><small>只学习结构和表达方式，不照抄原文</small></div><button type="button" class="btn ghost small" data-action="clear-reference">移除</button></div>` : '';
  const nextStepHtml = isComplete ? `<div class="next-step-panel output-next">
    <div class="next-step-copy"><span>下一步</span><b>${nextTitle}</b><small>${nextDetail}</small></div>
    <div class="next-step-actions"><button type="button" class="btn primary small" data-action="${canResumeProduction ? 'production-resume' : 'production-start'}">${canResumeProduction ? '继续上次制作' : '进入制作'}</button><button type="button" class="btn secondary small" data-action="copy-output">${copyLabel}</button><button type="button" class="btn ghost small" data-action="regenerate-output">换一批</button></div>
  </div>` : '';
  return `<div class="page">
    <div class="page-intro"><div><h2>做一条内容</h2><p>先让 AI 写出可用文案，再按真实制作流程定稿、生成编导稿和分镜、渲染成片、生成发布包。</p></div></div>
    ${renderWorkflowHub()}
    <div class="split create-split">
      <section class="form-card">
        <h3>先告诉我这次想做什么</h3>
        <p>一句话就够，越具体越好。</p>
        <label class="field"><span>主题 / 素材</span><textarea id="create-idea" placeholder="例如：家长总觉得 AI 课太贵，帮我写一条讲清价值的短视频口播">${escapeHtml(state.createIdea)}</textarea></label>
        ${referenceHtml}
        <div class="field"><span>你想要什么</span><div class="chip-group">${types.map((type) => `<button type="button" class="choice-chip${state.createType === type ? ' active' : ''}" data-choice="type" data-value="${type}">${type}</button>`).join('')}</div></div>
        <div class="field"><span>这次最想达成</span><div class="chip-group">${goals.map((goal) => `<button type="button" class="choice-chip${state.createGoal === goal ? ' active' : ''}" data-choice="goal" data-value="${goal}">${goal}</button>`).join('')}</div></div>
        <div class="form-foot"><small>生成后先定稿，再进入制作</small><button class="btn primary" data-action="generate" ${state.createBusy ? 'disabled' : ''}>${state.createBusy ? '<span class="spinner"></span> 正在生成' : '生成 3 个版本'}</button></div>
      </section>
      <section class="output-card${isComplete ? ' complete' : ''}">
        ${hasOutput ? `<div class="output-head"><div><b>生成结果</b>${state.createBusy ? `<div class="stream-status"><span class="spinner"></span><span id="stream-status">${escapeHtml(state.createStatus || '正在思考…')}</span></div>` : ''}</div><div>${state.createBusy ? '<button class="btn ghost small" data-action="cancel-create">停止</button>' : '<span class="output-done">✓ 已完成</span>'}</div></div>${state.createBusy ? '<div class="progress"><i></i></div>' : ''}<div class="output-text" id="output-text">${escapeHtml(state.createAnswer)}</div>${nextStepHtml}` : `<div class="output-empty"><span class="big-icon">✦</span><b>结果会显示在这里</b><p>你不需要懂提示词，也不用调整一堆设置。写一句需求，剩下的交给 AI。</p></div>`}
      </section>
    </div>
  </div>`;
}

const PRODUCTION_STEPS = [
  ['draft', '定稿'],
  ['plan', '内容方案'],
  ['script', '编导稿'],
  ['render', '成片'],
  ['package', '发布包'],
  ['publish', '发布复盘'],
];

function productionStepIndex(stage) {
  const index = PRODUCTION_STEPS.findIndex(([key]) => key === stage);
  return index < 0 ? 0 : index;
}

function renderProductionSteps() {
  const active = productionStepIndex(state.production.stage);
  return `<div class="production-steps">${PRODUCTION_STEPS.map(([key, label], index) => `<div class="production-step${index === active ? ' active' : ''}${index < active ? ' done' : ''}"><span>${index < active ? '✓' : index + 1}</span><b>${label}</b></div>`).join('')}</div>`;
}

function productionEstimateText(preflight) {
  const estimate = preflight?.estimate;
  if (!estimate) return '';
  const min = Number(estimate.minFen || 0) / 100;
  const max = Number(estimate.maxFen || 0) / 100;
  const value = min === max ? `¥${min.toFixed(2)}` : `¥${min.toFixed(2)}–${max.toFixed(2)}`;
  return `${value}${estimate.note ? ` · ${estimate.note}` : ''}`;
}

function productionShotRoleLabel(role) {
  return { hook: '开场钩子', pain: '痛点', proof: '证明', turn: '转折', cta: '行动引导' }[role] || role || '镜头';
}

function renderProductionDraft() {
  const p = state.production;
  const d = p.draft || {};
  const mode = d.productionMode || 'storyboard';
  const selectedIndex = p.versions.findIndex((item) => item.script === d.script);
  const versions = mode === 'storyboard' && p.versions.length > 1 ? `<div class="production-version-grid">${p.versions.map((item, index) => `<button type="button" class="production-version${index === selectedIndex ? ' active' : ''}" data-action="production-pick-version" data-index="${index}"><span>${escapeHtml(item.label)}</span><b>${escapeHtml(item.title)}</b></button>`).join('')}</div>` : '';
  const images = (state.assets || []).filter((item) => item.kind === 'image');
  const readyVoices = (state.voices || []).filter((item) => item.status === 'ready');
  const imageOptions = `<option value="">请选择形象照</option>${images.map((item) => `<option value="${escapeHtml(item.id)}"${d.imageAssetId === item.id ? ' selected' : ''}>${escapeHtml(item.fileName || item.file_name || '图片素材')}</option>`).join('')}`;
  const voiceOptions = `<option value="">请选择已就绪音色</option>${readyVoices.map((item) => `<option value="${escapeHtml(item.id)}"${d.voiceId === item.id ? ' selected' : ''}>${escapeHtml(item.name || '未命名音色')}</option>`).join('')}`;
  const avatarFields = `<div class="production-avatar-fields">
    <div class="production-field"><span>形象照</span><div class="production-inline-control"><select data-production-field="imageAssetId" id="production-image-asset">${imageOptions}</select><button type="button" class="btn ghost small" data-action="production-upload-image">上传</button></div><small>正面、人脸清晰；用于数字人底片。</small></div>
    <div class="production-field"><span>音色</span><div class="production-inline-control"><select data-production-field="voiceId" id="production-voice">${voiceOptions}</select><button type="button" class="btn ghost small" data-action="production-upload-voice" ${state.voiceBusy ? 'disabled' : ''}>${state.voiceBusy ? '处理中…' : '上传音频'}</button></div><small>参考音频建议 2–15 秒；上游克隆不稳定时会用参考音频直出。</small></div>
    <label class="production-field"><span>语速</span><select data-production-field="speed">${[['natural', '自然'], ['slightly_fast', '稍快'], ['fast', '较快'], ['extreme', '极快']].map(([value, label]) => `<option value="${value}"${(d.speed || 'natural') === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    <label class="production-field"><span>清晰度</span><select data-production-field="resolution">${['480P', '768P'].map((value) => `<option value="${value}"${(d.resolution || '480P') === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label>
  </div>`;
  let modeFields = '';
  if (mode === 'storyboard') {
    modeFields = `<div class="production-form-grid">
      <label class="production-field full"><span>标题</span><input data-production-field="title" maxlength="200" value="${escapeHtml(d.title || '')}" placeholder="这条内容对外展示的标题"></label>
      <label class="production-field full"><span>这条内容要达成什么</span><input data-production-field="objective" maxlength="500" value="${escapeHtml(d.objective || '')}" placeholder="例如：让有顾虑的家长主动咨询"></label>
      <label class="production-field full"><span>完整口播 / 文案</span><textarea data-production-field="script" rows="12" maxlength="8000">${escapeHtml(d.script || '')}</textarea></label>
      <label class="production-field full"><span>前三秒 / 开场</span><textarea data-production-field="hook" rows="3" maxlength="1000">${escapeHtml(d.hook || '')}</textarea></label>
      <label class="production-field full"><span>视频画面提示词</span><textarea data-production-field="prompt" rows="5" maxlength="3000">${escapeHtml(d.prompt || '')}</textarea><small>后续编导会用这段描述拆分镜头。可以写人物、场景、动作和画面风格。</small></label>
      <label class="production-field"><span>时长</span><select data-production-field="duration">${[15, 20, 25, 30].map((value) => `<option value="${value}"${Number(d.duration) === value ? ' selected' : ''}>${value} 秒</option>`).join('')}</select></label>
      <label class="production-field"><span>清晰度</span><select data-production-field="resolution">${['768P', '480P'].map((value) => `<option value="${value}"${d.resolution === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label>
      <label class="production-field"><span>画幅</span><select data-production-field="ratio">${['9:16', '16:9', '1:1'].map((value) => `<option value="${value}"${d.ratio === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label>
    </div>`;
  } else if (mode === 'talking_head') {
    modeFields = `<div class="production-form-grid">
      <label class="production-field full"><span>标题</span><input data-production-field="title" maxlength="200" value="${escapeHtml(d.title || '')}"></label>
      <label class="production-field full"><span>口播稿</span><textarea data-production-field="script" rows="10" maxlength="3000">${escapeHtml(d.script || '')}</textarea><small>按当前语速分段，单次最多 30 段；合成前还会再确认一次费用。</small></label>
    </div>${avatarFields}`;
  } else {
    modeFields = `<div class="production-form-grid">
      <label class="production-field full"><span>这条视频讲什么</span><textarea data-production-field="title" data-hosted-topic="1" rows="4" maxlength="500">${escapeHtml(d.title || '')}</textarea><small>一键托管会自己写口播稿、分段和算费用，停在确认页，不会直接扣费。</small></label>
    </div>${avatarFields}`;
  }
  const avatarReady = Boolean(d.imageAssetId && readyVoices.some((item) => item.id === d.voiceId));
  const primaryAction = mode === 'storyboard' ? 'production-save-plan' : mode === 'talking_head' ? 'production-create-talking' : 'production-create-hosted';
  const primaryLabel = mode === 'storyboard' ? '保存内容方案 →' : mode === 'talking_head' ? '创建口播任务 →' : '开始一键托管 →';
  const note = mode === 'storyboard'
    ? '下一步只生成方案与编导稿，不会立即渲染。'
    : mode === 'talking_head'
      ? '先用已选音色和形象照创建口播任务，核对分段后再确认合成。'
      : '先免费写稿和分段，核对费用后再确认合成。';
  return `<div class="production-panel">
    <div class="production-panel-head"><div><span class="production-kicker">第 1 步 · 定稿与制作方式</span><h3>先选一版，再决定怎么成片</h3><p>分镜成片、数字人口播和一站式托管共用同一份内容定稿，但后续步骤不同。</p></div><span class="production-note">不会直接发布</span></div>
    <div class="production-mode-grid">${[['storyboard', '分镜成片', '编导稿 → 逐镜检查 → 视频渲染'], ['talking_head', '口播成片', '形象照 + 音色 → 分段对口型'], ['hosted', '一键托管', '只写主题 → 自动写稿 → 确认合成']].map(([value, label, desc]) => `<button type="button" class="production-mode-card${mode === value ? ' active' : ''}" data-action="production-mode" data-mode="${value}"><b>${label}</b><small>${desc}</small></button>`).join('')}</div>
    ${versions}
    ${modeFields}
    <div class="production-footer"><button type="button" class="btn ghost" data-action="production-exit">返回生成结果</button><div><small>${note}</small><button type="button" class="btn primary" data-action="${primaryAction}" ${p.busy || (mode !== 'storyboard' && !avatarReady) ? 'disabled' : ''}>${p.busy ? '<span class="spinner"></span> 提交中…' : primaryLabel}</button></div></div>
  </div>`;
}

function renderProductionPlan() {
  const p = state.production;
  const plan = p.plan || {};
  const info = p.preflight || {};
  const estimate = productionEstimateText(info);
  const missing = plan.missing || [];
  const canSubmit = Boolean(p.preflight) && !missing.length && !p.busy;
  return `<div class="production-panel">
    <div class="production-panel-head"><div><span class="production-kicker">第 2 步 · 内容方案</span><h3>${escapeHtml(plan.title || '方案已保存')}</h3><p>${escapeHtml(plan.objective || '')}</p></div><span class="production-note">${plan.status === 'submitted' ? '已提交制作' : '待确认制作'}</span></div>
    <div class="production-summary-grid"><div><span>时长</span><b>${Number(plan.duration || 0)} 秒</b></div><div><span>清晰度</span><b>${escapeHtml(plan.resolution || '')}</b></div><div><span>画幅</span><b>${escapeHtml(plan.ratio || '')}</b></div><div><span>配音</span><b>${plan.generateAudio ? '生成' : '不生成'}</b></div></div>
    <div class="production-copy-block"><b>完整口播</b><p>${escapeHtml(plan.script || '')}</p></div>
    <div class="production-copy-block"><b>画面提示词</b><p>${escapeHtml(plan.prompt || '')}</p></div>
    ${estimate ? `<div class="production-estimate"><b>后续渲染预估</b><span>${escapeHtml(estimate)}</span></div>` : '<div class="production-estimate warn"><b>尚未拿到渲染估价</b><span>请重新检查方案后再提交。</span></div>'}
    ${info.videoReady === false ? '<div class="production-warning">当前视频渠道未配置。可以先生成编导稿，但渲染前需要管理员配置视频渠道。</div>' : ''}
    ${missing.length ? `<div class="production-warning">方案还缺：${escapeHtml(missing.join('、'))}</div>` : ''}
    <label class="production-check"><input type="checkbox" id="production-plan-confirm"><span>我已核对文案、目标、时长和画面描述，确认创建视频任务并生成编导稿。此步骤不会直接渲染，也不会产生渲染费用。</span></label>
    <div class="production-footer"><button type="button" class="btn ghost" data-action="production-edit-plan">返回修改方案</button><div><small>编导稿生成完成后，还要再检查分镜并单独确认渲染。</small><button type="button" class="btn primary" data-action="production-submit-plan" ${canSubmit ? '' : 'disabled'}>${p.busy ? '<span class="spinner"></span> 创建中…' : '确认方案并生成编导稿 →'}</button></div></div>
  </div>`;
}

function renderProductionScript() {
  const p = state.production;
  const work = p.work;
  if (!work) return '<div class="production-panel"><div class="production-loading"><span class="spinner"></span><b>正在创建视频任务…</b><p>稍等片刻。</p></div></div>';
  if (work.productionMode === 'talking_head') {
    const th = work.talkingHead || {};
    if (work.status === 'planning') {
      return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 3 步 · 口播准备</span><h3>${escapeHtml(work.title || '正在准备口播稿')}</h3><p>系统正在写口播稿并按语速分段。确认前不会创建数字人合成任务，也不会扣费。</p></div><span class="production-note">准备中</span></div><div class="production-loading"><span class="spinner"></span><b>${escapeHtml(work.message || '正在准备口播稿与分段…')}</b><p>完成后会自动停在这里等你确认。</p></div><div class="production-footer"><button type="button" class="btn ghost" data-action="production-exit">返回生成结果</button><button type="button" class="btn secondary" data-action="production-refresh-work">刷新进度</button></div></div>`;
    }
    if (work.status === 'failed' && !th.text) {
      return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 3 步 · 口播准备</span><h3>口播任务没有准备好</h3><p>${escapeHtml(work.error || work.message || '请重试')}</p></div><span class="production-note">失败</span></div><div class="production-footer"><button type="button" class="btn ghost" data-action="production-edit-plan">返回重选</button></div></div>`;
    }
    const plan = th.plan || {};
    return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 3 步 · 确认口播与分段</span><h3>${escapeHtml(work.title || '数字人口播')}</h3><p>${escapeHtml(work.message || '核对口播稿、音色、形象照和分段后再确认合成。')}</p></div><span class="production-note">${work.autoHost?.enabled ? '托管待确认' : '待确认'}</span></div>
      <div class="production-summary-grid"><div><span>音色</span><b>${escapeHtml(th.voiceName || '已选择')}</b></div><div><span>形象照</span><b>${escapeHtml(th.imageFileName || '已选择')}</b></div><div><span>语速</span><b>${escapeHtml(th.speed || 'natural')}</b></div><div><span>预计分段</span><b>${Number(plan.batchCount || (plan.segments || []).length || 0)} 段</b></div></div>
      <label class="production-field full" style="margin-top:14px"><span>口播稿</span><textarea id="production-talking-text" rows="10" maxlength="3000">${escapeHtml(th.text || state.production?.draft?.script || '')}</textarea></label>
      <div class="production-warning">确认后会创建数字人底片、TTS、人脸分析和逐段对口型任务，可能产生视频生成费用。成片完成后仍会先进入发布包，不会自动发布。</div>
      <label class="production-check"><input type="checkbox" id="production-render-confirm"><span>我已核对口播稿、音色、形象照和语速，同意提交数字人合成。</span></label>
      <div class="production-footer"><div class="production-footer-left"><button type="button" class="btn ghost" data-action="production-edit-plan">返回重选</button><button type="button" class="btn secondary" data-action="production-save-talking" ${p.busy ? 'disabled' : ''}>保存口播稿</button></div><div><small>确认后才进入第 4 步数字人合成。</small><button type="button" class="btn primary" data-action="production-confirm-render" ${p.busy ? 'disabled' : ''}>${p.busy ? '<span class="spinner"></span> 提交中…' : '确认口播，开始合成 →'}</button></div></div>
    </div>`;
  }
  const script = work.directorScript;
  const busy = work.status === 'planning';
  if (busy) {
    return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 3 步 · 编导稿</span><h3>${escapeHtml(work.title || '正在生成编导稿')}</h3><p>系统正在把内容方案拆成镜头、口播和画面提示词。通常十几秒到一分钟。</p></div><span class="production-note">生成中</span></div><div class="production-loading"><span class="spinner"></span><b>${escapeHtml(work.message || '正在写编导稿…')}</b><p>可以先去处理别的事情，任务会保留。</p></div><div class="production-footer"><button type="button" class="btn ghost" data-action="production-exit">返回生成结果</button><button type="button" class="btn secondary" data-action="production-refresh-work">刷新进度</button></div></div>`;
  }
  if (work.status === 'failed' && !(script && Array.isArray(script.shots) && script.shots.length)) {
    return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 3 步 · 编导稿</span><h3>编导稿生成失败</h3><p>${escapeHtml(work.error || work.message || '请重试')}</p></div><span class="production-note">失败</span></div><div class="production-footer"><button type="button" class="btn ghost" data-action="production-edit-plan">返回方案</button><button type="button" class="btn primary" data-action="production-regenerate-script">重新生成编导稿</button></div></div>`;
  }
  const shots = (script && Array.isArray(script.shots)) ? script.shots : [];
  const shotHtml = shots.length ? shots.map((shot) => {
    const edits = p.shotEdits[String(shot.index)] || {};
    const field = (key) => edits[key] !== undefined ? edits[key] : (shot[key] || '');
    return `<article class="production-shot"><div class="production-shot-head"><b>镜 ${escapeHtml(shot.index)} · ${escapeHtml(productionShotRoleLabel(shot.role))}</b><span>${Number(shot.seconds || 0)} 秒</span></div><label class="production-field"><span>画面</span><textarea data-shot-field="scene" data-shot-index="${escapeHtml(shot.index)}" rows="3">${escapeHtml(field('scene'))}</textarea></label><label class="production-field"><span>口播</span><textarea data-shot-field="voiceover" data-shot-index="${escapeHtml(shot.index)}" rows="3">${escapeHtml(field('voiceover'))}</textarea></label><label class="production-field"><span>给视频模型的画面提示词</span><textarea data-shot-field="renderPrompt" data-shot-index="${escapeHtml(shot.index)}" rows="3">${escapeHtml(field('renderPrompt'))}</textarea></label><label class="production-field"><span>花字 / 字幕（可空）</span><input data-shot-field="overlay" data-shot-index="${escapeHtml(shot.index)}" value="${escapeHtml(field('overlay'))}"></label></article>`;
  }).join('') : '<div class="production-warning">这一版没有可用分镜，请重新生成编导稿。</div>';
  return `<div class="production-panel">
    <div class="production-panel-head"><div><span class="production-kicker">第 3 步 · 编导稿与分镜</span><h3>${escapeHtml(work.title || '视频编导稿')}</h3><p>${escapeHtml(script?.strategy || work.message || '逐镜检查画面、口播和字幕，确认后再提交渲染。')}</p></div><span class="production-note">${work.scriptEdited ? '已人工修改' : '待确认'}</span></div>
    <div class="production-shot-list">${shotHtml}</div>
    ${script?.notes ? `<p class="section-note">${escapeHtml(script.notes)}</p>` : ''}
    ${productionEstimateText(p.preflight) ? `<div class="production-estimate"><b>渲染预估</b><span>${escapeHtml(productionEstimateText(p.preflight))}</span></div>` : ''}
    <div class="production-warning">确认渲染后会产生视频生成费用，并提交到平台视频渠道。请先逐镜核对，确认无误再继续。</div>
    <label class="production-check"><input type="checkbox" id="production-render-confirm"><span>我已检查编导稿和分镜，同意提交视频渲染。渲染完成后仍会先生成发布包，不会自动发布。</span></label>
    <div class="production-footer"><div class="production-footer-left"><button type="button" class="btn ghost" data-action="production-edit-plan">返回方案</button><button type="button" class="btn secondary" data-action="production-regenerate-script" ${p.busy ? 'disabled' : ''}>换一版编导稿</button><button type="button" class="btn secondary" data-action="production-save-script" ${p.busy ? 'disabled' : ''}>保存本版修改</button></div><div><small>确认后才进入第 4 步渲染。</small><button type="button" class="btn primary" data-action="production-confirm-render" ${p.busy ? 'disabled' : ''}>${p.busy ? '<span class="spinner"></span> 提交中…' : '确认分镜，提交渲染 →'}</button></div></div>
  </div>`;
}

function renderProductionRender() {
  const p = state.production;
  const work = p.work || {};
  if (work.status === 'rendering' || work.status === 'queued') {
    return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 4 步 · 成片渲染</span><h3>${escapeHtml(work.title || '正在生成视频')}</h3><p>${escapeHtml(work.message || '正在提交视频渠道并生成成片…')}</p></div><span class="production-note">渲染中</span></div><div class="production-loading"><span class="spinner"></span><b>视频生成通常需要几分钟</b><p>可以离开这个页面，任务会继续；回来后会显示最新进度。</p></div><div class="production-footer"><button type="button" class="btn ghost" data-action="production-exit">返回生成结果</button><button type="button" class="btn secondary" data-action="production-refresh-work">刷新进度</button></div></div>`;
  }
  if (work.status === 'failed') {
    return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 4 步 · 成片渲染</span><h3>这次渲染没有完成</h3><p>${escapeHtml(work.error || work.message || '请重试')}</p></div><span class="production-note">失败</span></div><div class="production-footer"><button type="button" class="btn ghost" data-action="production-back-script">返回分镜</button><button type="button" class="btn primary" data-action="production-retry-render">重新提交渲染</button></div></div>`;
  }
  if (work.status === 'succeeded' && work.outputAssetId) {
    return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 4 步 · 成片已生成</span><h3>${escapeHtml(work.title || '成片已生成')}</h3><p>成片已经保存到素材库。下一步是生成发布包，仍然不会自动发布。</p></div><span class="production-note success">已完成</span></div><div class="production-success-box"><span class="big-icon">✓</span><div><b>视频已经渲染完成</b><p>可以下载原片检查，也可以直接继续生成字幕、封面和发布文案。</p></div></div><div class="production-footer"><button type="button" class="btn secondary" data-action="production-download-video">下载原片</button><div><small>发布包会生成封面、字幕、标题、描述和 ZIP。</small><button type="button" class="btn primary" data-action="production-open-package">下一步：生成发布包 →</button></div></div></div>`;
  }
  return `<div class="production-panel"><div class="production-loading"><span class="spinner"></span><b>正在同步成片状态…</b><p>请稍后刷新。</p></div></div>`;
}

function renderProductionPackage() {
  const p = state.production;
  const pkg = p.package;
  if (pkg && pkg.status === 'ready') {
    return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 5 步 · 发布包</span><h3>${escapeHtml(pkg.title || '发布包已生成')}</h3><p>字幕、封面、标题和发布说明已经打包。下载检查后，再进入发布。</p></div><span class="production-note success">已生成</span></div><div class="production-package-summary"><div><span>标题</span><b>${escapeHtml(pkg.title || '')}</b></div><div><span>发布描述</span><p>${escapeHtml(pkg.description || '')}</p></div><div><span>话题标签</span><p>${(pkg.tags || []).map((tag) => `#${escapeHtml(tag)}`).join(' ')}</p></div></div><div class="production-footer"><button type="button" class="btn secondary" data-action="production-download-package">下载发布包</button><div><small>下载后请人工检查封面、字幕和口播。</small><button type="button" class="btn primary" data-action="production-open-publish">下一步：发布与复盘 →</button></div></div></div>`;
  }
  if (pkg && pkg.status === 'running') {
    return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 5 步 · 发布包</span><h3>正在生成发布包</h3><p>系统正在烧字幕、制作封面、整理标题和发布文案。</p></div><span class="production-note">生成中</span></div><div class="production-loading"><span class="spinner"></span><b>通常几十秒</b><p>完成后会显示下载发布包按钮。</p></div><div class="production-footer"><button type="button" class="btn ghost" data-action="production-exit">返回生成结果</button><button type="button" class="btn secondary" data-action="production-refresh-work">刷新进度</button></div></div>`;
  }
  const form = p.packageForm || {};
  return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 5 步 · 发布包</span><h3>生成字幕、封面和发布文案</h3><p>这一步会生成包装后的 mp4、封面、字幕、发布说明和 ZIP。不会替你发布。</p></div><span class="production-note">待生成</span></div><div class="production-form-grid"><label class="production-field full"><span>发布标题（封面和发布共用）</span><input data-package-field="title" maxlength="120" value="${escapeHtml(form.title || '')}"></label><label class="production-field"><span>字幕样式</span><select data-package-field="subtitleStyle">${[['white', '白字黑边'], ['yellow', '黄字黑边'], ['bold', '大字报'], ['none', '不烧字幕']].map(([value, label]) => `<option value="${value}"${form.subtitleStyle === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label class="production-field"><span>封面副标题</span><input data-package-field="coverSubtitle" maxlength="60" value="${escapeHtml(form.coverSubtitle || '')}" placeholder="例如：3–8 岁家长必看"></label><label class="production-field full"><span>发布描述</span><textarea data-package-field="description" rows="4" maxlength="1000">${escapeHtml(form.description || '')}</textarea></label><label class="production-field full"><span>话题标签（空格或逗号分隔）</span><input data-package-field="tags" value="${escapeHtml(form.tags || '')}" placeholder="教育 招生 家长必看"></label></div>${pkg?.status === 'failed' ? `<div class="production-warning">上次打包失败：${escapeHtml(pkg.error || '请重试')}</div>` : ''}<div class="production-footer"><button type="button" class="btn ghost" data-action="production-back-render">返回成片</button><div><small>生成发布包不会自动发布。</small><button type="button" class="btn primary" data-action="production-create-package" ${p.busy ? 'disabled' : ''}>${p.busy ? '<span class="spinner"></span> 提交中…' : '生成发布包 →'}</button></div></div></div>`;
}

function renderProductionPublish() {
  const p = state.production;
  const pkg = p.package || {};
  return `<div class="production-panel"><div class="production-panel-head"><div><span class="production-kicker">第 6 步 · 发布与复盘</span><h3>发布包已准备好，最后再人工发布</h3><p>客户端不会自动发布。请人工检查并上传到抖音 / 视频号，发布后回来同步作品数据。</p></div><span class="production-note">最后一公里</span></div><div class="production-publish-steps"><div><span>1</span><b>下载并检查发布包</b><p>核对成片、封面、字幕、标题和描述。</p></div><div><span>2</span><b>去平台发布</b><p>使用你自己的抖音 / 视频号账号完成发布。</p></div><div><span>3</span><b>回客户端同步作品</b><p>进入“我的数据”同步作品，再看这条内容的效果。</p></div></div><div class="production-copy-block"><b>发布文案</b><p>${escapeHtml(pkg.title || '')}</p><p>${escapeHtml(pkg.description || '')}</p><p>${(pkg.tags || []).map((tag) => `#${escapeHtml(tag)}`).join(' ')}</p></div><div class="production-footer"><div class="production-footer-left"><button type="button" class="btn secondary" data-action="production-download-package">下载发布包</button><button type="button" class="btn secondary" data-action="production-copy-package">复制发布文案</button></div><div><small>发布后再同步，才能拿到真实数据。</small><button type="button" class="btn primary" data-action="production-sync-after-publish">去同步作品数据 →</button></div></div></div>`;
}

function renderProduction() {
  const p = state.production;
  const stage = p.stage;
  const body = stage === 'plan'
    ? renderProductionPlan()
    : stage === 'script'
      ? renderProductionScript()
      : stage === 'render'
        ? renderProductionRender()
        : stage === 'package'
          ? renderProductionPackage()
          : stage === 'publish'
            ? renderProductionPublish()
            : renderProductionDraft();
  return `<div class="page production-page">
    <div class="page-intro production-intro"><div><button type="button" class="production-back" data-action="production-exit">← 返回生成结果</button><h2>制作这条内容</h2><p>文案只是第 1 步。按顺序完成方案、编导稿、分镜、渲染和发布包，最后才进入人工发布与数据复盘。</p></div><span class="production-flow-label">完整制作流程</span></div>
    ${renderProductionSteps()}
    ${body}
  </div>`;
}

async function startCreate(options = {}) {
  if (state.createBusy) return;
  const idea = $('#create-idea')?.value?.trim() || state.createIdea;
  if (!idea) { toast('先写一句你想做什么', 'error'); $('#create-idea')?.focus(); return; }
  const previousAnswer = options.variation ? String(state.createAnswer || '').slice(0, 4000) : '';
  state.createIdea = idea;
  state.createTitleHint = '';
  state.createAnswer = '';
  state.createCopied = false;
  resetProduction();
  state.createStatus = '正在连接生成服务…';
  state.createBusy = true;
  state.streamId = crypto.randomUUID();
  const typeInstruction = state.createType === '选题清单'
    ? '请给出 3 个可以直接开拍的选题方向，每个方向说明拍什么、为什么值得拍。'
    : `请直接写 3 个可以继续进入视频制作的${state.createType}版本，每个版本控制在 45–75 秒口播长度。每个版本先写“版本一/二/三”，再写标题和正文。只输出这三个版本，不要写前言、分析、编辑说明或总结；信息不足时用自然通用表述，不要保留【机构名】这类方括号占位符。`;
  const reference = state.createReference?.text ? `\n参考同行口播（只学习结构、节奏和表达方法，不要照抄）：\n${String(state.createReference.text).slice(0, 3500)}` : '';
  const variation = previousAnswer
    ? `\n上一版是：\n${previousAnswer}\n请换一个开场、结构和案例，避免与上一版重复。`
    : '';
  const message = `${typeInstruction}目标：${state.createGoal}。主题或素材：${idea}${reference}${variation}。不要解释你的思考过程，不要使用 Markdown 表格。`;
  renderCreateOnly();
  try {
    const result = await app.chat({ requestId: state.streamId, message, accountId: 'default', tier: 'standard' });
    if (!result?.ok) throw new Error(result?.message || '生成失败');
  } catch (error) {
    state.createBusy = false;
    state.createStatus = '';
    state.streamId = '';
    toast(String(error?.message || error), 'error');
    renderCreateOnly();
  }
}

function renderCreateOnly() {
  if (state.page === 'create') {
    $('#view').innerHTML = renderCreate();
  }
}

function regenerateOutput() {
  if (!state.createAnswer || state.createBusy) return;
  void startCreate({ variation: true });
}

async function copyOutput() {
  if (!state.createAnswer) return;
  try {
    await navigator.clipboard.writeText(state.createAnswer);
    state.createCopied = true;
    $$('[data-action="copy-output"]').forEach((button) => { button.textContent = '已复制'; });
    toast('已复制当前文本。正式流程请继续定稿并进入制作。', 'success');
  } catch {
    toast('复制失败，请手动选择文字', 'error');
  }
}

function stopWorkflowPolling() {
  if (state.workflowPollTimer) {
    clearTimeout(state.workflowPollTimer);
    state.workflowPollTimer = null;
  }
}

function startWorkflowPolling(delay = 1200) {
  stopWorkflowPolling();
  if (!state.workflow?.id || state.workflow.status !== 'active') return;
  state.workflowPollTimer = setTimeout(() => {
    state.workflowPollTimer = null;
    void pollWorkflow();
  }, delay);
}

async function pollWorkflow() {
  const current = state.workflow;
  if (!current?.id || current.status !== 'active') { stopWorkflowPolling(); return; }
  try {
    const data = await api('/workflows?accountId=default');
    state.workflowMeta = {
      styles: Array.isArray(data?.styles) ? data.styles : state.workflowMeta.styles,
      angles: Array.isArray(data?.angles) ? data.angles : state.workflowMeta.angles,
      strengths: Array.isArray(data?.strengths) ? data.strengths : state.workflowMeta.strengths,
      brains: Array.isArray(data?.brains) ? data.brains : state.workflowMeta.brains,
    };
    const latest = (data?.items || []).find((item) => item.id === current.id);
    if (latest) state.workflow = latest;
    if (state.page === 'create') renderCreateOnly();
    if (state.workflow?.status === 'active') state.workflowPollTimer = setTimeout(() => { state.workflowPollTimer = null; void pollWorkflow(); }, 1400);
  } catch {
    state.workflowPollTimer = setTimeout(() => { state.workflowPollTimer = null; void pollWorkflow(); }, 3000);
  }
}

function openWorkflowComposer(kind) {
  if (state.workflow?.status === 'active') { toast('先完成或放弃当前工作流', 'error'); return; }
  state.workflowComposer = { kind, sourceType: 'text', mode: 'keyword' };
  state.workflowBusy = false;
  renderCreateOnly();
}

function setWorkflowComposer(patch) {
  state.workflowComposer = { ...(state.workflowComposer || {}), ...patch };
  renderCreateOnly();
}

function workflowLaunchInput(kind, composer) {
  if (kind === 'today') return { goal: String(document.querySelector('#workflow-goal')?.value || '').trim() };
  if (kind === 'viral') {
    if (composer.sourceType === 'text') {
      const sourceText = String(document.querySelector('#workflow-viral-text')?.value || '').trim();
      if (!sourceText) throw new Error('请先粘贴爆款原文');
      return { sourceType: 'text', sourceText };
    }
    if (composer.sourceType === 'link') {
      const shareText = String(document.querySelector('#workflow-viral-link')?.value || '').trim();
      if (!shareText) throw new Error('请先粘贴抖音分享内容或作品链接');
      return { sourceType: 'link', shareText };
    }
    if (composer.sourceType === 'upload') return { sourceType: 'upload' };
    const transcriptId = String(document.querySelector('#workflow-viral-transcript')?.value || '').trim();
    if (!transcriptId) throw new Error('请选择一条已转写作品');
    return { sourceType: 'transcript', transcriptId };
  }
  if (composer.mode === 'keyword') {
    const keyword = String(document.querySelector('#workflow-hotspot-keyword')?.value || '').trim();
    if (!keyword) throw new Error('请先填写搜索关键词');
    return { mode: 'keyword', keyword };
  }
  const title = String(document.querySelector('#workflow-hotspot-title')?.value || '').trim();
  const fact = String(document.querySelector('#workflow-hotspot-fact')?.value || '').trim();
  const sourceUrl = String(document.querySelector('#workflow-hotspot-url')?.value || '').trim();
  if (!title || !fact) throw new Error('请填写热点标题和已核对的事实');
  return { mode: 'manual', title, fact, sourceUrl };
}

async function launchWorkflow(kind) {
  if (state.workflowBusy) return;
  let input;
  try {
    input = workflowLaunchInput(kind, state.workflowComposer || {});
  } catch (error) {
    toast(String(error?.message || error), 'error');
    return;
  }
  state.workflowBusy = true;
  renderCreateOnly();
  try {
    if (kind === 'viral' && input.sourceType === 'upload') {
      const uploaded = await app.uploadAsset({ kind: 'video', folder: '复刻参考' });
      if (uploaded?.ok === false) throw new Error(uploaded.message || '上传视频失败');
      if (uploaded?.canceled) { state.workflowBusy = false; renderCreateOnly(); return; }
      if (!uploaded?.asset?.id) throw new Error('上传后没有拿到视频素材');
      input = { sourceType: 'upload', assetId: uploaded.asset.id };
    }
    const data = await api('/workflows', { method: 'POST', body: { kind, accountId: 'default', input }, timeout: 120000 });
    state.workflow = data.workflow;
    state.workflowComposer = null;
    state.workflowBusy = false;
    renderCreateOnly();
    toast(`已开始${state.workflow?.kindLabel || '创作'}工作流`, 'success');
    startWorkflowPolling(800);
  } catch (error) {
    state.workflowBusy = false;
    toast(String(error?.message || error), 'error');
    renderCreateOnly();
  }
}

function adoptWorkflowDraft(draft) {
  if (!draft?.content) return;
  state.createIdea = draft.topic || state.createIdea || '工作流生成内容';
  state.createTitleHint = draft.topic || '';
  state.createAnswer = String(draft.content || '');
  state.createCopied = false;
  state.createType = '口播稿';
  resetProduction();
  stopWorkflowPolling();
  state.workflowComposer = null;
  renderCreateOnly();
  toast('已采用这一版。下一步：定稿并进入完整制作流程。', 'success');
}

async function runWorkflowAction(payload) {
  const wf = state.workflow;
  if (!wf?.id || state.workflowBusy) return;
  stopWorkflowPolling();
  state.workflowBusy = true;
  renderCreateOnly();
  try {
    const data = await api(`/workflows/${encodeURIComponent(wf.id)}/action`, { method: 'POST', body: payload, timeout: 120000 });
    if (data?.workflow) state.workflow = data.workflow;
    state.workflowBusy = false;
    if (data?.switchToManual) {
      state.workflow = null;
      state.workflowComposer = { kind: 'hotspot', mode: 'manual', sourceType: 'text' };
      stopWorkflowPolling();
      renderCreateOnly();
      return;
    }
    if (data?.draft) {
      adoptWorkflowDraft(data.draft);
      return;
    }
    renderCreateOnly();
    if (state.workflow?.status === 'active') startWorkflowPolling(900);
  } catch (error) {
    state.workflowBusy = false;
    toast(String(error?.message || error), 'error');
    renderCreateOnly();
    if (state.workflow?.status === 'active') startWorkflowPolling(2000);
  }
}

async function cancelWorkflow() {
  if (!state.workflow?.id) { state.workflow = null; state.workflowComposer = null; renderCreateOnly(); return; }
  if (!confirm('确定放弃当前工作流？已生成的候选会保留在平台任务里，但不会继续推进。')) return;
  try {
    const data = await api(`/workflows/${encodeURIComponent(state.workflow.id)}/action`, { method: 'POST', body: { action: 'cancel' } });
    if (data?.workflow) state.workflow = data.workflow;
  } catch (error) {
    toast(String(error?.message || error), 'error');
    return;
  }
  stopWorkflowPolling();
  state.workflow = null;
  state.workflowComposer = null;
  renderCreateOnly();
}

function copyWorkflowTranscript() {
  const text = String(state.workflow?.state?.transcript || '');
  if (!text) return;
  void navigator.clipboard.writeText(text).then(() => toast('原文已复制', 'success')).catch(() => toast('复制失败', 'error'));
}

function openContextPanel(panel) {
  state.contextPanel = ['memories', 'assets', 'jobs', 'plans', 'cycles'].includes(panel) ? panel : 'brains';
  state.brainComposer = false;
  state.brainDetail = null;
  state.planDetail = null;
  state.cycleComposer = false;
  renderCreateOnly();
  if (state.contextPanel === 'jobs') void refreshJobs();
  if (state.contextPanel === 'plans') void refreshPlans();
  if (state.contextPanel === 'cycles') void refreshCycles();
}

async function uploadLibraryAsset(kind) {
  try {
    const result = await app.uploadAsset({ kind, folder: kind === 'image' ? '素材库图片' : kind === 'audio' ? '素材库音频' : '素材库视频' });
    if (result?.ok === false) throw new Error(result.message || '上传失败');
    if (result?.canceled) return;
    if (result?.asset) state.assets.unshift(result.asset);
    renderCreateOnly();
    toast('素材已上传', 'success');
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

async function refreshJobs() {
  try {
    const data = await api('/jobs?limit=100');
    state.jobs = Array.isArray(data?.items) ? data.items : [];
    state.jobKinds = Array.isArray(data?.kinds) ? data.kinds : [];
    state.jobStatuses = Array.isArray(data?.statuses) ? data.statuses : [];
    state.jobTotal = Number(data?.total || state.jobs.length || 0);
    if (state.contextPanel === 'jobs') renderCreateOnly();
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

async function retryJob(id) {
  if (!id) return;
  try {
    const result = await api(`/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {}, timeout: 120000 });
    toast(result?.message || '已重新提交任务', 'success');
    await refreshJobs();
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

async function refreshPlans() {
  try {
    const data = await api('/plans?accountId=default');
    state.plans = Array.isArray(data?.items) ? data.items : [];
    if (state.contextPanel === 'plans') renderCreateOnly();
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

function openPlanForProduction(plan) {
  if (!plan) return;
  resetProduction();
  state.production.open = true;
  state.production.stage = 'plan';
  state.production.plan = plan;
  state.production.draft = {
    title: plan.title || '', objective: plan.objective || '', hook: plan.hook || '', script: plan.script || '', prompt: plan.prompt || '',
    duration: Number(plan.duration || 30), resolution: plan.resolution || '768P', ratio: plan.ratio || '9:16', generateAudio: plan.generateAudio !== false,
    productionMode: 'storyboard', imageAssetId: '', voiceId: '', speed: 'natural',
  };
  state.contextPanel = null;
  renderCreateOnly();
  void refreshProductionPreflight();
}

function stopCyclePolling() {
  if (state.cyclePollTimer) {
    clearTimeout(state.cyclePollTimer);
    state.cyclePollTimer = null;
  }
}

async function refreshCycles({ silent = false } = {}) {
  try {
    const data = await api('/cycles?accountId=default');
    state.cycles = Array.isArray(data?.items) ? data.items : [];
    if (state.contextPanel === 'cycles') renderCreateOnly();
    if (state.cycles.some((item) => item.status === 'generating')) {
      stopCyclePolling();
      state.cyclePollTimer = setTimeout(() => { state.cyclePollTimer = null; void refreshCycles({ silent: true }); }, 2500);
    }
  } catch (error) {
    if (!silent) toast(String(error?.message || error), 'error');
  }
}

async function createCycle() {
  if (state.cycleBusy) return;
  const brief = String(document.querySelector('#cycle-brief')?.value || '').trim();
  state.cycleBusy = true;
  renderCreateOnly();
  try {
    const data = await api('/cycles', { method: 'POST', body: { count: 7, brief, accountId: 'default' }, timeout: 120000 });
    if (data?.cycle) state.cycles.unshift(data.cycle);
    state.cycleBusy = false;
    state.cycleComposer = false;
    renderCreateOnly();
    toast('周期计划开始生成，通常十几秒到一分钟', 'success');
    stopCyclePolling();
    state.cyclePollTimer = setTimeout(() => { state.cyclePollTimer = null; void refreshCycles({ silent: true }); }, 1800);
  } catch (error) {
    state.cycleBusy = false;
    renderCreateOnly();
    toast(String(error?.message || error), 'error');
  }
}

async function confirmCycle(id, version) {
  try {
    const data = await api(`/cycles/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: { version: Number(version) } });
    if (data?.cycle) state.cycles = state.cycles.map((item) => item.id === id ? data.cycle : item);
    renderCreateOnly();
    toast('周期计划已确认', 'success');
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

function useCycleSlot(cycleId, slotId) {
  const cycle = (state.cycles || []).find((item) => item.id === cycleId);
  const slot = (cycle?.slots || []).find((item) => item.id === slotId);
  if (!slot) return;
  state.createIdea = [slot.topic, slot.purpose ? `目标：${slot.purpose}` : '', slot.recommendationReason ? `推荐理由：${slot.recommendationReason}` : ''].filter(Boolean).join('\n');
  state.createTitleHint = slot.topic || '';
  state.createType = '口播稿';
  state.createGoal = '建立信任';
  state.createAnswer = '';
  state.createCopied = false;
  resetProduction();
  state.contextPanel = null;
  renderCreateOnly();
  toast('选题已带回“做内容”，点“生成 3 个版本”继续。', 'success');
}


function stopBrainPolling() {
  if (state.brainPollTimer) {
    clearTimeout(state.brainPollTimer);
    state.brainPollTimer = null;
  }
}

async function refreshBrains({ silent = false } = {}) {
  try {
    const data = await api('/brains');
    state.brains = Array.isArray(data?.items) ? data.items : [];
    state.workflowMeta.brains = state.brains.filter((item) => item.status === 'ready').map((item) => ({ id: item.id, name: item.name, kind: item.kind }));
    if (state.page === 'create') renderCreateOnly();
    if (state.brains.some((item) => item.status === 'running')) {
      stopBrainPolling();
      state.brainPollTimer = setTimeout(() => { state.brainPollTimer = null; void refreshBrains({ silent: true }); }, 2500);
    }
  } catch (error) {
    if (!silent) toast(String(error?.message || error), 'error');
  }
}

async function createBrain() {
  if (state.brainBusy) return;
  const name = String(document.querySelector('#brain-name')?.value || '').trim();
  const kind = String(document.querySelector('#brain-kind')?.value || 'copy_brain');
  const transcriptIds = $$('input[name="brainTranscript"]:checked').map((node) => node.value);
  if (!name) { toast('请先给这份档案起个名字', 'error'); return; }
  if (!transcriptIds.length) { toast('请至少选择一条已转写作品', 'error'); return; }
  state.brainBusy = true;
  renderCreateOnly();
  try {
    const data = await api('/brains', { method: 'POST', body: { kind, name, transcriptIds, accountId: 'default' }, timeout: 120000 });
    if (data?.brain) state.brains.unshift({ ...data.brain, profile: {}, sections: [], sourceNote: `${transcriptIds.length} 条口播档案` });
    state.brainBusy = false;
    state.brainComposer = false;
    renderCreateOnly();
    toast('已开始蒸馏，完成后会自动出现在“选写法”里。', 'success');
    stopBrainPolling();
    state.brainPollTimer = setTimeout(() => { state.brainPollTimer = null; void refreshBrains({ silent: true }); }, 1800);
  } catch (error) {
    state.brainBusy = false;
    renderCreateOnly();
    toast(String(error?.message || error), 'error');
  }
}

async function deleteBrain(id) {
  if (!id || !confirm('删除这份写作大脑？已经生成的内容不受影响。')) return;
  try {
    await api(`/brains/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.brains = state.brains.filter((item) => item.id !== id);
    state.workflowMeta.brains = state.workflowMeta.brains.filter((item) => item.id !== id);
    if (state.brainDetail === id) state.brainDetail = null;
    renderCreateOnly();
    toast('已删除', 'success');
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

async function createMemory() {
  if (state.memoryBusy) return;
  const content = String(document.querySelector('#memory-content')?.value || '').trim();
  const kind = String(document.querySelector('#memory-kind')?.value || 'memory');
  if (!content) { toast('先写一条要长期记住的信息', 'error'); return; }
  state.memoryBusy = true;
  renderCreateOnly();
  try {
    const data = await api('/memories', { method: 'POST', body: { content, kind, source: '客户端手动记录', accountId: 'default' } });
    if (data?.memory) state.memories.unshift(data.memory);
    state.memoryBusy = false;
    renderCreateOnly();
    toast('已保存为长期记忆', 'success');
  } catch (error) {
    state.memoryBusy = false;
    renderCreateOnly();
    toast(String(error?.message || error), 'error');
  }
}

async function deleteMemory(id) {
  if (!id || !confirm('删除这条长期记忆？')) return;
  try {
    await api(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.memories = state.memories.filter((item) => item.id !== id);
    renderCreateOnly();
    toast('已删除', 'success');
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

function setProductionMode(mode) {
  if (!state.production?.draft) return;
  state.production.draft.productionMode = ['storyboard', 'talking_head', 'hosted'].includes(mode) ? mode : 'storyboard';
  if (state.production.draft.productionMode === 'hosted') state.production.draft.resolution = '480P';
  renderCreateOnly();
}

async function uploadProductionImage() {
  try {
    const result = await app.uploadAsset({ kind: 'image', folder: '形象照' });
    if (result?.ok === false) throw new Error(result.message || '上传失败');
    if (result?.canceled) return;
    if (result?.asset) {
      state.assets.unshift(result.asset);
      state.production.draft.imageAssetId = result.asset.id;
      renderCreateOnly();
      toast('形象照已上传并选中', 'success');
    }
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

function stopVoicePolling() {
  if (state.voicePollTimer) {
    clearTimeout(state.voicePollTimer);
    state.voicePollTimer = null;
  }
}

async function refreshVoices({ silent = false } = {}) {
  try {
    const data = await api('/voices');
    state.voices = Array.isArray(data?.items) ? data.items : [];
    const stillTraining = state.voices.some((item) => ['training', 'running'].includes(item.status));
    state.voiceBusy = stillTraining;
    if (state.page === 'create' && state.production?.open) renderCreateOnly();
    if (stillTraining) {
      stopVoicePolling();
      state.voicePollTimer = setTimeout(() => { state.voicePollTimer = null; void refreshVoices({ silent: true }); }, 2500);
    }
  } catch (error) {
    if (!silent) toast(String(error?.message || error), 'error');
  }
}

async function uploadProductionVoice() {
  if (state.voiceBusy) return;
  try {
    const result = await app.uploadAsset({ kind: 'audio', folder: '音色参考' });
    if (result?.ok === false) throw new Error(result.message || '上传失败');
    if (result?.canceled) return;
    if (!result?.asset) return;
    state.assets.unshift(result.asset);
    state.voiceBusy = true;
    renderCreateOnly();
    const name = String(result.asset.fileName || result.asset.file_name || '我的音色').replace(/\.[^.]+$/, '').slice(0, 60);
    const data = await api('/voices', { method: 'POST', body: { assetId: result.asset.id, name, accountId: 'default' }, timeout: 120000 });
    if (data?.voice) {
      state.voices.unshift(data.voice);
      state.production.draft.voiceId = data.voice.id;
    }
    toast('音色样本已上传，正在准备。完成前请先不要开始合成。', 'success');
    renderCreateOnly();
    stopVoicePolling();
    state.voicePollTimer = setTimeout(() => { state.voicePollTimer = null; void refreshVoices({ silent: true }); }, 1800);
  } catch (error) {
    state.voiceBusy = false;
    renderCreateOnly();
    toast(String(error?.message || error), 'error');
  }
}

function talkingWorkPayload() {
  const d = state.production?.draft || {};
  if (!d.imageAssetId) throw new Error('请先选择或上传形象照');
  if (!d.voiceId) throw new Error('请先选择或上传音色');
  return {
    accountId: 'default', productionMode: 'talking_head', type: 'ecommerce', subtype: '口播带货',
    title: d.title || '数字人口播', imageAssetId: d.imageAssetId, voiceId: d.voiceId,
    speed: d.speed || 'natural', resolution: d.resolution || '480P',
  };
}

async function createProductionTalking() {
  const p = state.production;
  if (!p || p.busy) return;
  syncProductionDraftFromDom();
  if (!String(p.draft?.script || '').trim()) { toast('请先填写口播稿', 'error'); return; }
  let body;
  try { body = { ...talkingWorkPayload(), speech: p.draft.script }; }
  catch (error) { toast(String(error?.message || error), 'error'); return; }
  p.busy = true;
  renderCreateOnly();
  try {
    const data = await api('/video/works', { method: 'POST', body, timeout: 120000 });
    p.work = data.work;
    p.stage = 'script';
    p.busy = false;
    renderCreateOnly();
    toast('口播任务已创建。核对分段后确认合成。', 'success');
  } catch (error) {
    p.busy = false;
    renderCreateOnly();
    toast(String(error?.message || error), 'error');
  }
}

async function createProductionHosted() {
  const p = state.production;
  if (!p || p.busy) return;
  syncProductionDraftFromDom();
  const topic = String(p.draft?.title || '').trim();
  if (!topic) { toast('请先写一个视频主题', 'error'); return; }
  let body;
  try { body = { ...talkingWorkPayload(), autoHost: true, topic }; }
  catch (error) { toast(String(error?.message || error), 'error'); return; }
  p.busy = true;
  p.stage = 'script';
  renderCreateOnly();
  try {
    const data = await api('/video/works', { method: 'POST', body, timeout: 120000 });
    p.work = data.work;
    p.busy = false;
    renderCreateOnly();
    toast('一键托管已开始写稿和分段，完成后停在确认页。', 'success');
    startProductionPoll(1000);
  } catch (error) {
    p.busy = false;
    p.stage = 'draft';
    renderCreateOnly();
    toast(String(error?.message || error), 'error');
  }
}

async function saveProductionTalking({ silent = false } = {}) {
  const p = state.production;
  if (p?.work?.productionMode !== 'talking_head' || !p.work.id) return false;
  const speech = String(document.querySelector('#production-talking-text')?.value || p.work.talkingHead?.text || '').trim();
  if (!speech) { toast('口播稿不能为空', 'error'); return false; }
  if (!silent) { p.busy = true; renderCreateOnly(); }
  try {
    const data = await api(`/video/works/${encodeURIComponent(p.work.id)}`, { method: 'PUT', body: { talkingHead: { text: speech } } });
    p.work = data.work || p.work;
    if (!silent) { p.busy = false; renderCreateOnly(); }
    toast('口播稿已保存，确认后重新合成', 'success');
    return true;
  } catch (error) {
    if (!silent) { p.busy = false; renderCreateOnly(); }
    toast(String(error?.message || error), 'error');
    return false;
  }
}

function syncProductionDraftFromDom() {
  if (!state.production?.draft) return;
  $$('[data-production-field]').forEach((node) => {
    const key = node.dataset.productionField;
    state.production.draft[key] = ['duration'].includes(key) ? Number(node.value) : node.value;
  });
}

function syncProductionPackageFromDom() {
  if (!state.production?.packageForm) return;
  $$('[data-package-field]').forEach((node) => {
    state.production.packageForm[node.dataset.packageField] = node.value;
  });
}

function syncProductionShotsFromDom() {
  $$('[data-shot-field]').forEach((node) => {
    const index = String(node.dataset.shotIndex || '');
    if (!index) return;
    state.production.shotEdits[index] = state.production.shotEdits[index] || {};
    state.production.shotEdits[index][node.dataset.shotField] = node.value;
  });
}

function stopProductionPoll() {
  if (state.production?.pollTimer) {
    clearTimeout(state.production.pollTimer);
    state.production.pollTimer = null;
  }
}

function applyProductionWork(data, { rerender = true } = {}) {
  const p = state.production;
  if (!p || !data?.work) return;
  p.work = data.work;
  p.renders = Array.isArray(data.renders) ? data.renders : [];
  p.package = data.package || p.package || null;
  if (p.stage === 'script' && ['rendering', 'succeeded'].includes(p.work.status)) p.stage = 'render';
  if (p.stage === 'render' && p.work.status === 'draft' && p.work.directorScript) p.stage = 'script';
  if (rerender) renderCreateOnly();
}

async function pollProductionWork() {
  const p = state.production;
  if (!p?.work?.id || p.pollBusy) return;
  if (!p.open) return;
  p.pollBusy = true;
  try {
    const data = await api(`/video/works/${encodeURIComponent(p.work.id)}`);
    applyProductionWork(data, { rerender: true });
    const status = p.work?.status || '';
    const packageStatus = p.package?.status || '';
    const shouldPoll = (p.stage === 'script' && status === 'planning')
      || (p.stage === 'render' && ['queued', 'rendering'].includes(status))
      || (p.stage === 'package' && packageStatus === 'running');
    if (shouldPoll) {
      p.pollTimer = setTimeout(() => { p.pollTimer = null; void pollProductionWork(); }, 2500);
    } else {
      p.pollTimer = null;
    }
  } catch (error) {
    p.message = String(error?.message || error).slice(0, 300);
    if (p.stage === 'render' || p.stage === 'script') renderCreateOnly();
    p.pollTimer = setTimeout(() => { p.pollTimer = null; void pollProductionWork(); }, 5000);
  } finally {
    p.pollBusy = false;
  }
}

function startProductionPoll(delay = 1200) {
  stopProductionPoll();
  if (!state.production?.open) return;
  state.production.pollTimer = setTimeout(() => {
    state.production.pollTimer = null;
    void pollProductionWork();
  }, delay);
}

async function refreshProductionPreflight() {
  const p = state.production;
  if (!p?.plan?.id) return;
  p.busy = true;
  p.error = '';
  renderCreateOnly();
  try {
    const info = await api(`/plans/${encodeURIComponent(p.plan.id)}/preflight`);
    p.preflight = info;
    if (info?.plan) p.plan = info.plan;
  } catch (error) {
    p.preflight = null;
    p.error = String(error?.message || error);
    toast(`无法获取制作检查结果：${p.error}`, 'error');
  } finally {
    p.busy = false;
    renderCreateOnly();
  }
}

async function saveProductionPlan() {
  const p = state.production;
  if (!p || p.busy) return;
  syncProductionDraftFromDom();
  const d = p.draft || {};
  if (!d.title || !d.script || !d.prompt) { toast('请先补全标题、完整口播和画面提示词', 'error'); return; }
  p.busy = true;
  p.error = '';
  renderCreateOnly();
  try {
    const body = {
      accountId: 'default', title: d.title, objective: d.objective, hook: d.hook, script: d.script, prompt: d.prompt,
      duration: Number(d.duration || 30), resolution: d.resolution || '768P', ratio: d.ratio || '9:16',
      generateAudio: true, assetIds: [], missing: [], rationale: '由“做内容”生成文案后进入制作流程；发布前需人工核对事实、价格和合规边界。',
    };
    const data = p.plan?.id && p.plan.status !== 'submitted'
      ? await api(`/plans/${encodeURIComponent(p.plan.id)}`, { method: 'PUT', body: { ...body, version: p.plan.version } })
      : await api('/plans', { method: 'POST', body });
    p.plan = data.plan;
    p.stage = 'plan';
    p.preflight = null;
    p.busy = false;
    renderCreateOnly();
    await refreshProductionPreflight();
    toast('内容方案已保存。下一步：检查方案并生成编导稿。', 'success');
  } catch (error) {
    p.busy = false;
    p.error = String(error?.message || error);
    toast(p.error, 'error');
    renderCreateOnly();
  }
}

function editProductionPlan() {
  const p = state.production;
  if (!p?.draft) return;
  p.stage = 'draft';
  p.error = '';
  renderCreateOnly();
}

async function submitProductionPlan() {
  const p = state.production;
  if (!p?.plan?.id || p.busy) return;
  if (!document.querySelector('#production-plan-confirm')?.checked) { toast('请先勾选确认已核对方案', 'error'); return; }
  p.busy = true;
  p.error = '';
  renderCreateOnly();
  try {
    const data = await api(`/plans/${encodeURIComponent(p.plan.id)}/submit`, { method: 'POST', body: { version: p.plan.version, confirm: true } });
    p.plan = data.plan || p.plan;
    p.work = data.work || null;
    p.stage = 'script';
    p.busy = false;
    renderCreateOnly();
    toast('方案已确认，正在生成编导稿。', 'success');
    startProductionPoll(900);
  } catch (error) {
    p.busy = false;
    p.error = String(error?.message || error);
    toast(p.error, 'error');
    renderCreateOnly();
  }
}

async function refreshProductionWork() {
  const p = state.production;
  if (!p?.work?.id) return;
  try {
    const data = await api(`/video/works/${encodeURIComponent(p.work.id)}`);
    applyProductionWork(data, { rerender: true });
    toast('已刷新制作进度', 'success');
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

async function saveProductionScript({ silent = false } = {}) {
  const p = state.production;
  const work = p?.work;
  if (!work?.id || !work.directorScript) return false;
  syncProductionShotsFromDom();
  const next = JSON.parse(JSON.stringify(work.directorScript));
  next.shots = (Array.isArray(next.shots) ? next.shots : []).map((shot) => {
    const edits = p.shotEdits[String(shot.index)] || {};
    return {
      ...shot,
      scene: edits.scene !== undefined ? edits.scene : shot.scene,
      voiceover: edits.voiceover !== undefined ? edits.voiceover : shot.voiceover,
      renderPrompt: edits.renderPrompt !== undefined ? edits.renderPrompt : shot.renderPrompt,
      overlay: edits.overlay !== undefined ? edits.overlay : shot.overlay,
    };
  });
  if (!silent) {
    p.busy = true;
    renderCreateOnly();
  }
  try {
    const data = await api(`/video/works/${encodeURIComponent(work.id)}`, { method: 'PUT', body: { directorScript: next, scriptEdited: true } });
    p.work = data.work;
    p.shotEdits = {};
    if (!silent) {
      p.busy = false;
      renderCreateOnly();
      toast('编导稿和分镜已保存', 'success');
    }
    return true;
  } catch (error) {
    if (!silent) {
      p.busy = false;
      renderCreateOnly();
    }
    toast(String(error?.message || error), 'error');
    return false;
  }
}

async function regenerateProductionScript() {
  const p = state.production;
  if (!p?.work?.id || p.busy) return;
  p.busy = true;
  p.error = '';
  renderCreateOnly();
  try {
    const data = await api(`/video/works/${encodeURIComponent(p.work.id)}/regenerate`, { method: 'POST', body: {} });
    p.work = data.work || p.work;
    p.stage = 'script';
    p.shotEdits = {};
    p.busy = false;
    renderCreateOnly();
    toast('正在换一版编导稿…', 'success');
    startProductionPoll(1200);
  } catch (error) {
    p.busy = false;
    p.error = String(error?.message || error);
    toast(p.error, 'error');
    renderCreateOnly();
  }
}

async function confirmProductionRender({ retry = false } = {}) {
  const p = state.production;
  if (!p?.work?.id || p.busy) return;
  if (!retry && !document.querySelector('#production-render-confirm')?.checked) { toast('请先勾选确认已检查分镜', 'error'); return; }
  if (!confirm('确认提交视频渲染？这一步可能产生视频生成费用，渲染完成后仍不会自动发布。')) return;
  if (p.work.productionMode === 'talking_head') {
    const nextSpeech = String(document.querySelector('#production-talking-text')?.value || p.work.talkingHead?.text || '').trim();
    if (nextSpeech !== String(p.work.talkingHead?.text || '').trim()) {
      const saved = await saveProductionTalking({ silent: true });
      if (!saved) return;
    }
  } else if (Object.keys(p.shotEdits || {}).length) {
    const saved = await saveProductionScript({ silent: true });
    if (!saved) return;
  }
  p.busy = true;
  p.stage = 'render';
  p.error = '';
  renderCreateOnly();
  try {
    const data = await api(`/video/works/${encodeURIComponent(p.work.id)}/confirm`, { method: 'POST', body: {} });
    p.work = data.work || p.work;
    p.busy = false;
    renderCreateOnly();
    toast('已提交视频渲染，任务会继续在后台生成。', 'success');
    startProductionPoll(1500);
  } catch (error) {
    p.busy = false;
    p.error = String(error?.message || error);
    toast(p.error, 'error');
    renderCreateOnly();
  }
}

function openProductionPackage() {
  const p = state.production;
  if (!p?.work?.outputAssetId) { toast('成片还没有生成完成', 'error'); return; }
  const script = p.work.directorScript || {};
  const voice = (script.shots || []).map((shot) => shot.voiceover || '').filter(Boolean).slice(0, 2).join(' ');
  p.stage = 'package';
  p.packageForm = p.packageForm || {
    title: p.package?.title || script.title || p.work.title || p.draft?.title || '未命名视频',
    subtitleStyle: 'white',
    coverSubtitle: '',
    description: p.package?.description || [script.strategy, voice].filter(Boolean).join('\n').slice(0, 300),
    tags: (p.package?.tags || ['教育', '招生', '家长必看']).join(' '),
  };
  renderCreateOnly();
  if (p.package?.status === 'running') startProductionPoll(1500);
}

async function createProductionPackage() {
  const p = state.production;
  if (!p?.work?.id || p.busy) return;
  syncProductionPackageFromDom();
  const form = p.packageForm || {};
  if (!String(form.title || '').trim()) { toast('请先填写发布标题', 'error'); return; }
  p.busy = true;
  p.error = '';
  renderCreateOnly();
  try {
    const data = await api(`/video/works/${encodeURIComponent(p.work.id)}/package`, { method: 'POST', body: {
      title: form.title, subtitleStyle: form.subtitleStyle || 'white', coverSubtitle: form.coverSubtitle || '',
      description: form.description || '', tags: form.tags || '',
    } });
    p.package = data.package || null;
    p.busy = false;
    renderCreateOnly();
    toast('正在生成字幕、封面和发布包…', 'success');
    startProductionPoll(1500);
  } catch (error) {
    p.busy = false;
    p.error = String(error?.message || error);
    toast(p.error, 'error');
    renderCreateOnly();
  }
}

async function downloadProductionAsset(assetId, filename) {
  if (!assetId) return;
  try {
    const result = await app.downloadAsset({ assetId, filename });
    if (result?.ok === false) throw new Error(result.message || '下载失败');
    if (!result?.canceled) toast(`已保存到 ${result.path}`, 'success');
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

function packageCopyText(pkg) {
  return [pkg?.title, pkg?.description, (pkg?.tags || []).map((tag) => `#${tag}`).join(' ')].filter(Boolean).join('\n\n');
}

async function copyProductionPackage() {
  const p = state.production;
  const pkg = p?.package;
  if (!pkg) return;
  try {
    await navigator.clipboard.writeText(packageCopyText(pkg));
    toast('发布标题、描述和标签已复制', 'success');
  } catch {
    toast('复制失败，请手动选择发布文案', 'error');
  }
}

function openProductionPublish() {
  if (state.production?.package?.status !== 'ready') { toast('先生成发布包', 'error'); return; }
  state.production.stage = 'publish';
  renderCreateOnly();
}

async function syncAfterPublish() {
  const result = await app.openCollectorSelf();
  openCollectorResult(result);
  if (result?.ok !== false) toast('已打开我的主页。下一步：点“采集我的作品”，发布数据会同步到「我的数据」。', 'success');
}

function renderPeers() {
  const refs = state.refs;
  const sync = state.collector?.sync || {};
  return `<div class="page">
    <div class="page-intro"><div><h2>同行采集</h2><p>三步就能采集：添加主页 → 去采集 → 点“采集当前主页”。不需要懂技术，也不需要安装浏览器扩展。</p></div><div><button class="btn secondary" data-action="collector-help">查看完整步骤</button> <button class="btn primary" data-action="sync-all" ${sync.running || !refs.length ? 'disabled' : ''}>${sync.running ? `同步中 ${sync.done || 0}/${sync.total || 0}` : '更新全部同行'}</button></div></div>
    <section class="guide-card">
      <div class="guide-step"><span>1</span><div><b>粘贴主页</b><p>把同行抖音主页链接填到下面，点“添加同行”。</p></div></div>
      <div class="guide-step"><span>2</span><div><b>点“去采集”</b><p>客户端会打开这个同行的主页，登录或验证码由你手动完成。</p></div></div>
      <div class="guide-step"><span>3</span><div><b>点“采集当前主页”</b><p>在右侧采集窗口点按钮，作品会自动下载和转写。</p></div></div>
      <button class="btn secondary" data-action="collector-help">不会操作？点这里</button>
    </section>
    <section class="panel"><div class="panel-head"><div><h3>添加一个同行</h3><p>只需要粘贴一次，以后从列表里直接采集。</p></div></div><div class="panel-body"><div class="field" style="margin-top:0"><span>备注名（可不填）</span><input id="peer-name" placeholder="例如：王老师教育号"></div><div class="field"><span>主页链接 / 分享口令</span><input id="peer-url" placeholder="https://www.douyin.com/user/..."></div><div class="form-foot"><small>添加后点下方“去采集”</small><button class="btn primary" data-action="add-peer">添加同行</button></div></div></section>
    <div class="section-title"><h3>已观察的同行</h3><span>${refs.length} 个</span></div>
    ${refs.length ? `<div class="list">${refs.map((ref, index) => `<article class="peer-card"><div class="peer-main"><div class="peer-title-row"><b>${escapeHtml(ref.name || '未命名同行')}</b>${ref.lastSyncStatus ? statusBadge(ref.lastSyncStatus) : '<span class="badge neutral">还没同步</span>'}</div><span class="peer-url">${escapeHtml(ref.url || ref.secUserId || '')}</span><div class="peer-meta">${ref.lastSyncAt ? `上次同步 ${fmtDate(ref.lastSyncAt, true)}` : '还没有采集记录'}${ref.lastSyncMessage ? ` · ${escapeHtml(ref.lastSyncMessage)}` : ''}</div></div><div class="peer-actions"><button class="btn primary small" data-action="open-peer" data-index="${index}">去采集</button><button class="btn ghost small" data-action="collector-help">教程</button></div></article>`).join('')}</div>` : `<div class="panel"><div class="empty-state"><span class="big-icon">⌁</span><b>还没有同行</b><p>先在上面的输入框粘贴一个同行主页链接，点“添加同行”。</p></div></div>`}
    ${renderTranscriptCards()}
  </div>`;
}

function renderTranscriptCards() {
  const items = (state.transcripts || []).filter((item) => item.source === 'douyin').slice(0, 8);
  const sync = state.collector?.sync || {};
  const lastSync = state.collector?.lastSync || {};
  const hasRunning = Boolean(sync.running || items.some((item) => item.status === 'running'));
  if (!items.length && !sync.running && !lastSync.at) return '';
  const content = items.length
    ? `<div class="list">${items.map((item, index) => `<article class="peer-card"><div class="peer-main"><div class="peer-title-row"><b>${escapeHtml(item.title || '同行作品')}</b>${statusBadge(item.status)}</div><span class="peer-url">${escapeHtml(item.nickname || '同行采集')}</span><div class="peer-meta">${item.status === 'succeeded' ? `转写完成 · ${item.segmentCount || 0} 段 · 可参考仿写` : item.status === 'running' ? '正在转写，完成后可参考仿写' : '转写失败，可重新采集'}${item.text ? ` · ${escapeHtml(item.text.slice(0, 60))}…` : ''}</div></div><div class="peer-actions">${item.status === 'succeeded' ? `<button class="btn primary small" data-action="use-transcript" data-index="${index}">参考这条写一条</button>` : `<button class="btn ghost small" disabled>${item.status === 'running' ? '转写中' : '暂不可用'}</button>`}</div></article>`).join('')}</div>${hasRunning ? '<p class="section-note transcript-wait">正在转写的作品完成后会自动出现“参考这条写一条”，不用留在这个页面等。</p>' : ''}`
    : `<div class="panel"><div class="empty-state transcript-empty"><span class="big-icon">文</span><b>${hasRunning ? '作品已上报，正在下载和转写' : '还没有可参考的同行口播'}</b><p>${hasRunning ? '转写需要几分钟。完成后这里会出现“参考这条写一条”，可以先去处理别的事情。' : '采集同行主页后，服务器会自动下载作品并转写口播；成功的作品会出现在这里。'}</p>${hasRunning ? '<div class="progress transcript-progress"><i></i></div>' : '<button class="btn secondary" data-action="sync-all">重新更新同行</button>'}</div></div>`;
  return `<div class="section-title"><h3>采集后能做什么</h3><span>参考同行口播，写自己的内容</span></div>
    <p class="section-note">这些是已经转写好的同行口播。点“参考这条写一条”，只学习结构和表达方式，不会照抄原文。</p>
    ${content}`;
}

async function addPeer() {
  const nameInput = $('#peer-name');
  const urlInput = $('#peer-url');
  const url = urlInput?.value?.trim() || '';
  if (!url) { toast('先粘贴同行主页链接', 'error'); urlInput?.focus(); return; }
  const name = nameInput?.value?.trim() || `同行 ${state.refs.length + 1}`;
  try {
    await api('/refs', { method: 'POST', body: { name, url, notes: '客户端添加' } });
    toast('已添加同行。下一步：在下方卡片点“去采集”。', 'success');
    await loadAll({ silent: true, rerender: false });
    render();
  } catch (error) {
    toast(String(error?.message || error), 'error');
  }
}

async function syncAllPeers() {
  const result = await app.syncAll();
  if (result?.ok === false) toast(result.message || '同步失败', 'error');
  else toast('已开始更新同行。采集和转写完成后，下方会出现可参考的口播。', 'success');
  await loadAll({ silent: true, rerender: false });
  render();
}

function renderReports() {
  const items = state.reports?.items || [];
  const totals = items.reduce((sum, item) => {
    const stats = item.stats || {};
    sum.plays += Number(stats.plays || 0);
    sum.likes += Number(stats.likes || 0);
    sum.saves += Number(stats.saves || 0);
    return sum;
  }, { plays: 0, likes: 0, saves: 0 });
  return `<div class="page">
    <div class="page-intro"><div><h2>我的数据</h2><p>先同步自己的作品，再看哪类内容真的有效。这里只展示结果，不让你做复杂配置。</p></div><div><button class="btn secondary" data-action="open-self">同步我的作品</button> <button class="btn primary" data-action="generate-insight" ${state.insightBusy || !items.length ? 'disabled' : ''}>${state.insightBusy ? '<span class="spinner"></span> 分析中' : '生成数据建议'}</button></div></div>
    <div class="stats-grid"><div class="stat-card"><span>已复盘</span><b>${items.length}</b><small>条作品</small></div><div class="stat-card"><span>总播放</span><b>${fmtNumber(totals.plays)}</b><small>全部作品</small></div><div class="stat-card"><span>总点赞</span><b>${fmtNumber(totals.likes)}</b><small>全部作品</small></div><div class="stat-card"><span>总收藏</span><b>${fmtNumber(totals.saves)}</b><small>全部作品</small></div></div>
    ${items.length && !state.insight && !state.insightBusy ? `<div class="next-step-panel report-next"><div class="next-step-copy"><span>下一步</span><b>作品已同步，生成一份数据建议</b><small>看看哪类内容有效，再把建议直接变成下一条内容。</small></div><button class="btn primary small" data-action="generate-insight">生成数据建议</button></div>` : ''}
    ${state.insight ? `<div class="section-title"><h3>给你的建议</h3><span>基于最近 ${items.length} 条作品</span></div><section class="panel insight-panel"><div class="panel-body"><div class="output-text insight-output">${escapeHtml(state.insight)}</div><div class="next-step-panel"><div class="next-step-copy"><span>下一步</span><b>把建议变成一条内容</b><small>把这份判断带进“做内容”，生成可以继续进入完整制作流程的口播稿。</small></div><button class="btn primary small" data-action="insight-to-create">按建议写一条</button></div></div></section>` : ''}
    <div class="section-title"><h3>已同步作品</h3><span>${items.length} 条</span></div>
    ${items.length ? `<div class="list">${items.slice(0, 12).map((item) => { const stats = item.stats || {}; return `<div class="work-row"><b>${escapeHtml(item.topic || '未命名作品')}</b><span>播放 ${fmtNumber(stats.plays)}</span><span>赞 ${fmtNumber(stats.likes)}</span><strong>藏 ${fmtNumber(stats.saves)}</strong><span>${escapeHtml(stats.publishedAt || '')}</span></div>`; }).join('')}</div>` : `<div class="panel"><div class="empty-state"><span class="big-icon">▥</span><b>还没有作品数据</b><p>点“同步我的作品”，在内置浏览器里采集一次自己的主页。</p><button class="btn primary" data-action="open-self">同步我的作品</button></div></div>`}
  </div>`;
}

function useInsightForCreate() {
  const insight = String(state.insight || '').trim();
  if (!insight) { toast('先生成数据建议', 'error'); return; }
  state.createIdea = `根据下面的数据建议，帮我写一条能解决当前问题的口播稿：\n${insight.slice(0, 1600)}`;
  state.createType = '口播稿';
  state.createGoal = '咨询';
  state.createReference = null;
  state.createAnswer = '';
  state.createTitleHint = '';
  state.createCopied = false;
  resetProduction();
  state.page = 'create';
  render();
  toast('建议已带入“做内容”。下一步：点“生成 3 个版本”。', 'success');
}

async function generateInsight() {
  if (!state.reports?.items?.length) { toast('先同步自己的作品', 'error'); return; }
  state.insightBusy = true;
  render();
  try {
    const data = await api('/reviews/insights', { method: 'POST', body: { accountId: 'default' }, timeout: 120000 });
    state.insight = String(data?.insight || '').trim() || '这次没有生成有效建议，请稍后重试。';
    toast('数据建议已生成', 'success');
  } catch (error) {
    toast(String(error?.message || error), 'error');
  } finally {
    state.insightBusy = false;
    render();
  }
}

function renderSettings() {
  const settings = state.collector?.settings || {};
  const update = state.collector?.update || {};
  const user = state.bootstrap?.user || {};
  const org = state.bootstrap?.organization || {};
  return `<div class="page">
    <div class="page-intro"><div><h2>设置</h2><p>只需要设置一次。默认选项已经适合大多数用户。</p></div></div>
    <div class="section-title"><h3>账号</h3><span>平台统一账号</span></div>
    <section class="panel"><div class="panel-body account-box"><div><span class="avatar">${escapeHtml((user.displayName || user.login || '军').slice(0, 1))}</span><div><b>${escapeHtml(user.displayName || user.login || '当前账号')}</b><small>${escapeHtml(org.name || user.orgName || '')}</small></div></div><button class="btn danger" data-action="logout">退出登录</button></div></section>
    <div class="section-title"><h3>自动同步</h3><span>让客户端在后台帮你更新</span></div>
    <div class="settings-list">
      <div class="settings-row"><div><b>定时同步同行</b><small>按设定周期自动采集，不需要你每次手动点</small></div><label class="switch"><input type="checkbox" data-setting="autoSyncEnabled" ${settings.autoSyncEnabled ? 'checked' : ''}><i></i></label></div>
      <div class="settings-row"><div><b>同步间隔</b><small>自动同步的频率</small></div><select data-setting="intervalHours"><option value="6" ${Number(settings.intervalHours) === 6 ? 'selected' : ''}>每 6 小时</option><option value="12" ${Number(settings.intervalHours) === 12 ? 'selected' : ''}>每 12 小时</option><option value="24" ${Number(settings.intervalHours) === 24 ? 'selected' : ''}>每天</option><option value="48" ${Number(settings.intervalHours) === 48 ? 'selected' : ''}>每 2 天</option><option value="168" ${Number(settings.intervalHours) === 168 ? 'selected' : ''}>每周</option></select></div>
      <div class="settings-row"><div><b>开机自动启动</b><small>登录 Windows 后在托盘里待命</small></div><label class="switch"><input type="checkbox" data-setting="launchAtLogin" ${settings.launchAtLogin ? 'checked' : ''}><i></i></label></div>
      <div class="settings-row"><div><b>完成时通知我</b><small>同步或生成结束后弹系统通知</small></div><label class="switch"><input type="checkbox" data-setting="notificationsEnabled" ${settings.notificationsEnabled !== false ? 'checked' : ''}><i></i></label></div>
      <div class="settings-row"><div><b>关闭窗口后继续运行</b><small>关闭后留在托盘，后台任务不会停</small></div><label class="switch"><input type="checkbox" data-setting="closeToTray" ${settings.closeToTray !== false ? 'checked' : ''}><i></i></label></div>
    </div>
    <div class="section-title"><h3>客户端</h3><span>v${escapeHtml(state.bootstrap?.version || '')}</span></div>
    <section class="panel"><div class="panel-body"><div class="account-box"><div><div><b>软件更新</b><small>${escapeHtml(update.message || '自动检查已开启')}</small></div></div><button class="btn secondary" data-action="check-update" ${state.updateBusy ? 'disabled' : ''}>${state.updateBusy ? '检查中…' : '检查更新'}</button></div></div></section>
  </div>`;
}

function render() {
  updateShell();
  if (!state.loaded) return;
  if (state.page === 'home') $('#view').innerHTML = renderHome();
  else if (state.page === 'create') $('#view').innerHTML = renderCreate();
  else if (state.page === 'peers') $('#view').innerHTML = renderPeers();
  else if (state.page === 'reports') $('#view').innerHTML = renderReports();
  else $('#view').innerHTML = renderSettings();
}

function useTranscript(index) {
  const item = (state.transcripts || []).filter((entry) => entry.source === 'douyin')[Number(index)];
  if (!item?.text) { toast('这条口播还没有转写完成', 'error'); return; }
  state.createReference = { title: item.title || '同行口播', text: item.text };
  state.createIdea = '参考这条同行口播的结构和节奏，帮我写一条适合我机构的内容';
  state.createAnswer = '';
  state.createTitleHint = '';
  state.createCopied = false;
  resetProduction();
  state.page = 'create';
  render();
}

function openCollectorGuide() {
  const modal = document.querySelector('#guide-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeCollectorGuide() {
  const modal = document.querySelector('#guide-modal');
  if (modal) modal.classList.add('hidden');
}

function openCollectorResult(result) {
  if (result?.ok === false) toast(result.message || '无法打开采集窗口', 'error');
}

async function handleAction(action, target) {
  if (action === 'reload') { await loadAll(); return; }
  if (action === 'go-create') { navigate('create'); return; }
  if (action === 'go-reports') { navigate('reports'); return; }
  if (action === 'open-collector') { openCollectorResult(await app.openCollector()); return; }
  if (action === 'open-self') { const result = await app.openCollectorSelf(); openCollectorResult(result); if (result?.ok !== false) toast('已打开我的主页。下一步：在采集窗口点“采集我的作品”。', 'success'); return; }
  if (action === 'collector-help') { openCollectorGuide(); return; }
  if (action === 'open-peer') { const ref = state.refs[Number(target?.dataset?.index || 0)]; if (!ref) return; const result = await app.openCollectorUrl(ref.url || ref.secUserId); openCollectorResult(result); if (result?.ok !== false) toast('已打开同行主页，请在采集窗口点“采集当前主页（同行）”', 'success'); return; }
  if (action === 'add-peer') { await addPeer(); return; }
  if (action === 'sync-all') { await syncAllPeers(); return; }
  if (action === 'context-open') { openContextPanel(target?.dataset?.context); return; }
  if (action === 'context-back') { state.contextPanel = null; state.brainComposer = false; state.brainDetail = null; state.planDetail = null; state.cycleComposer = false; renderCreateOnly(); return; }
  if (action === 'asset-upload') { await uploadLibraryAsset(target?.dataset?.kind || 'image'); return; }
  if (action === 'asset-download') { await downloadProductionAsset(target?.dataset?.assetId, target?.dataset?.assetName || '素材'); return; }
  if (action === 'jobs-refresh') { await refreshJobs(); return; }
  if (action === 'job-retry') { await retryJob(target?.dataset?.jobId); return; }
  if (action === 'plans-refresh') { await refreshPlans(); return; }
  if (action === 'plan-library-detail') { state.planDetail = state.planDetail === target?.dataset?.planId ? null : (target?.dataset?.planId || null); renderCreateOnly(); return; }
  if (action === 'plan-library-open') { openPlanForProduction((state.plans || []).find((item) => item.id === target?.dataset?.planId)); return; }
  if (action === 'cycle-composer-toggle') { state.cycleComposer = !state.cycleComposer; renderCreateOnly(); return; }
  if (action === 'cycle-create') { await createCycle(); return; }
  if (action === 'cycle-confirm') { await confirmCycle(target?.dataset?.cycleId, target?.dataset?.version); return; }
  if (action === 'cycle-slot-use') { useCycleSlot(target?.dataset?.cycleId, target?.dataset?.slotId); return; }
  if (action === 'brain-composer-toggle') { state.brainComposer = !state.brainComposer; renderCreateOnly(); return; }
  if (action === 'brain-create') { await createBrain(); return; }
  if (action === 'brain-detail') { state.brainDetail = state.brainDetail === target?.dataset?.brainId ? null : (target?.dataset?.brainId || null); renderCreateOnly(); return; }
  if (action === 'brain-delete') { await deleteBrain(target?.dataset?.brainId); return; }
  if (action === 'memory-create') { await createMemory(); return; }
  if (action === 'memory-delete') { await deleteMemory(target?.dataset?.memoryId); return; }
  if (action === 'workflow-open') { openWorkflowComposer(target?.dataset?.kind || 'today'); return; }
  if (action === 'workflow-composer-cancel') { state.workflowComposer = null; state.workflowBusy = false; renderCreateOnly(); return; }
  if (action === 'workflow-viral-source') { setWorkflowComposer({ sourceType: target?.dataset?.source || 'text' }); return; }
  if (action === 'workflow-hotspot-mode') { setWorkflowComposer({ mode: target?.dataset?.mode || 'keyword' }); return; }
  if (action === 'workflow-launch') { await launchWorkflow(target?.dataset?.kind || state.workflowComposer?.kind || 'today'); return; }
  if (action === 'workflow-cancel') { await cancelWorkflow(); return; }
  if (action === 'workflow-regenerate') { await runWorkflowAction({ action: 'regenerate' }); return; }
  if (action === 'workflow-select-idea') { await runWorkflowAction({ action: 'select_idea', optionId: target?.dataset?.optionId || '' }); return; }
  if (action === 'workflow-confirm-transcript') { await runWorkflowAction({ action: 'confirm_transcript', text: String(document.querySelector('#workflow-transcript')?.value || '') }); return; }
  if (action === 'workflow-copy-transcript') { copyWorkflowTranscript(); return; }
  if (action === 'workflow-select-hotspot') { await runWorkflowAction({ action: 'select_hotspot', hotspotId: target?.dataset?.hotspotId || '' }); return; }
  if (action === 'workflow-select-angle') { await runWorkflowAction({ action: 'select_angle', angle: target?.dataset?.angle || '' }); return; }
  if (action === 'workflow-select-brain') { await runWorkflowAction({ action: 'select_brain', brainId: target?.dataset?.brainId || '', style: '口语化' }); return; }
  if (action === 'workflow-select-style') { await runWorkflowAction({ action: 'select_brain', brainId: '', style: target?.dataset?.style || '口语化' }); return; }
  if (action === 'workflow-select-copy') { await runWorkflowAction({ action: 'select_copy', optionId: target?.dataset?.optionId || '' }); return; }
  if (action === 'workflow-search-retry') { await runWorkflowAction({ action: 'search_retry' }); return; }
  if (action === 'workflow-search-manual') { await runWorkflowAction({ action: 'search_switch_manual' }); return; }
  if (action === 'generate') { await startCreate(); return; }
  if (action === 'use-transcript') { useTranscript(target?.dataset?.index); return; }
  if (action === 'clear-reference') { state.createReference = null; renderCreateOnly(); return; }
  if (action === 'cancel-create') { await app.cancelChat(state.streamId); return; }
  if (action === 'copy-output') { await copyOutput(); return; }
  if (action === 'regenerate-output') { regenerateOutput(); return; }
  if (action === 'production-start') { startProductionFlow(); return; }
  if (action === 'production-resume') { state.production.open = true; if (state.production.work && state.production.stage === 'script' && state.production.work.status === 'planning') startProductionPoll(300); if (state.production.stage === 'render' && ['queued', 'rendering'].includes(state.production.work?.status)) startProductionPoll(300); if (state.production.stage === 'package' && state.production.package?.status === 'running') startProductionPoll(300); renderCreateOnly(); return; }
  if (action === 'production-exit') { state.production.open = false; stopProductionPoll(); renderCreateOnly(); return; }
  if (action === 'production-mode') { setProductionMode(target?.dataset?.mode); return; }
  if (action === 'production-pick-version') { pickProductionVersion(target?.dataset?.index); return; }
  if (action === 'production-upload-image') { await uploadProductionImage(); return; }
  if (action === 'production-upload-voice') { await uploadProductionVoice(); return; }
  if (action === 'production-create-talking') { await createProductionTalking(); return; }
  if (action === 'production-create-hosted') { await createProductionHosted(); return; }
  if (action === 'production-save-talking') { await saveProductionTalking(); return; }
  if (action === 'production-save-plan') { await saveProductionPlan(); return; }
  if (action === 'production-edit-plan') { editProductionPlan(); return; }
  if (action === 'production-submit-plan') { await submitProductionPlan(); return; }
  if (action === 'production-refresh-work') { await refreshProductionWork(); return; }
  if (action === 'production-save-script') { await saveProductionScript(); return; }
  if (action === 'production-regenerate-script') { await regenerateProductionScript(); return; }
  if (action === 'production-confirm-render') { await confirmProductionRender(); return; }
  if (action === 'production-retry-render') { await confirmProductionRender({ retry: true }); return; }
  if (action === 'production-back-script') { state.production.stage = 'script'; renderCreateOnly(); return; }
  if (action === 'production-open-package') { openProductionPackage(); return; }
  if (action === 'production-back-render') { state.production.stage = 'render'; renderCreateOnly(); return; }
  if (action === 'production-create-package') { await createProductionPackage(); return; }
  if (action === 'production-download-video') { await downloadProductionAsset(state.production.work?.outputAssetId, `${state.production.work?.title || '视频成片'}.mp4`); return; }
  if (action === 'production-download-package') { await downloadProductionAsset(state.production.package?.zipAssetId, `${state.production.package?.title || '视频发布包'}-发布包.zip`); return; }
  if (action === 'production-copy-package') { await copyProductionPackage(); return; }
  if (action === 'production-open-publish') { openProductionPublish(); return; }
  if (action === 'production-sync-after-publish') { await syncAfterPublish(); return; }
  if (action === 'generate-insight') { await generateInsight(); return; }
  if (action === 'insight-to-create') { useInsightForCreate(); return; }
  if (action === 'check-update') {
    state.updateBusy = true; render();
    const result = await app.checkUpdates();
    toast(result?.message || (result?.ok ? '正在检查更新' : '检查更新失败'), result?.ok ? 'success' : 'error');
    state.updateBusy = false;
    state.collector = await app.getCollectorStatus().catch(() => state.collector);
    render();
    return;
  }
  if (action === 'logout') {
    if (!confirm('确定退出当前机构账号吗？')) return;
    await app.logout();
  }
}

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
  $('#sidebar-collector').addEventListener('click', () => void app.openCollector());
  $('#refresh-page').addEventListener('click', async () => { await loadAll({ silent: false }); toast('已刷新', 'success'); });
  $('#guide-close')?.addEventListener('click', closeCollectorGuide);
  $('#guide-modal')?.addEventListener('click', (event) => { if (event.target === document.querySelector('#guide-modal')) closeCollectorGuide(); });

  $('#view').addEventListener('click', (event) => {
    const choice = event.target.closest('[data-choice]');
    if (choice) {
      if (choice.dataset.choice === 'type') state.createType = choice.dataset.value;
      if (choice.dataset.choice === 'goal') state.createGoal = choice.dataset.value;
      renderCreateOnly();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (action) void handleAction(action.dataset.action, action);
  });

  $('#view').addEventListener('input', (event) => {
    if (event.target.id === 'create-idea') state.createIdea = event.target.value;
    if (event.target.dataset.productionField && state.production?.draft) {
      const key = event.target.dataset.productionField;
      state.production.draft[key] = key === 'duration' ? Number(event.target.value) : event.target.value;
    }
    if (event.target.dataset.packageField && state.production?.packageForm) {
      state.production.packageForm[event.target.dataset.packageField] = event.target.value;
    }
    if (event.target.dataset.shotField && state.production) {
      const index = String(event.target.dataset.shotIndex || '');
      state.production.shotEdits[index] = state.production.shotEdits[index] || {};
      state.production.shotEdits[index][event.target.dataset.shotField] = event.target.value;
    }
  });

  $('#view').addEventListener('change', async (event) => {
    if (event.target.dataset.productionField && state.production?.draft) {
      const productionKey = event.target.dataset.productionField;
      state.production.draft[productionKey] = productionKey === 'duration' ? Number(event.target.value) : event.target.value;
      if (['imageAssetId', 'voiceId'].includes(productionKey)) renderCreateOnly();
      return;
    }
    if (event.target.dataset.packageField && state.production?.packageForm) {
      state.production.packageForm[event.target.dataset.packageField] = event.target.value;
      return;
    }
    const key = event.target.dataset.setting;
    if (!key) return;
    const value = event.target.type === 'checkbox' ? event.target.checked : Number(event.target.value);
    try {
      const result = await app.updateSettings({ [key]: value });
      if (result?.ok) {
        state.collector = { ...(state.collector || {}), settings: result.settings };
        toast('设置已保存', 'success');
      }
    } catch (error) {
      toast(String(error?.message || error), 'error');
    }
  });

  app.onChatEvent(({ requestId, type, data }) => {
    if (requestId !== state.streamId) return;
    if (type === 'status') {
      state.createStatus = data?.text || '正在生成…';
      const node = $('#stream-status');
      if (node) node.textContent = state.createStatus;
      return;
    }
    if (type === 'delta') {
      state.createAnswer += String(data?.text || '');
      const output = $('#output-text');
      if (output) {
        const followOutput = output.scrollHeight - output.scrollTop - output.clientHeight < 56;
        output.textContent = state.createAnswer;
        if (followOutput) output.scrollTop = output.scrollHeight;
      }
      return;
    }
    if (type === 'reset') {
      state.createAnswer = '';
      const output = $('#output-text');
      if (output) output.textContent = '';
      return;
    }
    if (type === 'done') {
      const finalText = String(data?.message?.content || state.createAnswer || '').trim();
      state.createAnswer = finalText;
      state.createBusy = false;
      state.createStatus = '';
      state.createCopied = false;
      state.streamId = '';
      renderCreateOnly();
      if (finalText) toast('文案已生成。下一步：定稿并进入制作流程。', 'success');
      else toast('生成结束，但没有返回内容，请重试。', 'error');
      void loadAll({ silent: true, rerender: false });
      return;
    }
    if (type === 'error') {
      state.createBusy = false;
      state.createStatus = '';
      state.streamId = '';
      toast(data?.message || '生成失败，请重试', 'error');
      renderCreateOnly();
      return;
    }
    if (type === 'stopped') {
      state.createBusy = false;
      state.createStatus = '';
      state.streamId = '';
      toast('已停止生成，可以继续修改主题后重试');
      renderCreateOnly();
      return;
    }
    if (type === 'closed' && state.createBusy) {
      state.createBusy = false;
      state.createStatus = '';
      state.streamId = '';
      toast('生成连接意外结束，请检查结果或重试', 'error');
      renderCreateOnly();
    }
  });

  app.onCollectorStatus((status) => {
    const wasRunning = Boolean(state.collector?.sync?.running);
    state.collector = status;
    updateShell();
    const isRunning = Boolean(status?.sync?.running);
    if (state.page !== 'create' && (wasRunning !== isRunning || state.page === 'peers' || state.page === 'settings')) {
      render();
    }
    if (wasRunning && !isRunning) {
      void loadAll({ silent: true, rerender: false }).then(() => toast('同步已完成，转写结果已更新。', 'success'));
    }
  });
}

async function boot() {
  if (!app) {
    $('#view').innerHTML = '<div class="empty-state"><b>客户端桥接未加载</b><p>请重新安装招生军师。</p></div>';
    return;
  }
  bindEvents();
  await loadAll();
  if (!state.bootstrap?.signedIn) {
    $('#view').innerHTML = '<div class="empty-state"><b>登录已过期</b><p>请重新登录后再打开工作台。</p></div>';
  }
}

boot();





