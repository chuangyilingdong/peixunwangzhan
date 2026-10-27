import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const executablePath = require('electron');
const appPath = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'junshi-app-ux-'));

const paragraphs = Array.from({ length: 42 }, (_, index) => `这是第 ${index + 1} 段用于检查长文案区域的示例内容。家长真正关心的不是课程名字，而是孩子能不能在一次次练习里看到变化。`);
const longAnswer = `版本一：先别急着报班\n\n${paragraphs.join('\n\n')}\n\n版本二：孩子不是不努力\n\n${paragraphs.join('\n\n')}`;
const insight = `你的作品里，讲真实家长犹豫的内容更容易获得收藏。下一条建议围绕“先别急着报班”展开，用具体对话做开场。\n\n${paragraphs.slice(0, 10).join('\n\n')}`;

let workflowRow = null;
let mockJobs = [{ id: 'job-1', kind: '视频渲染', detail: '家长沟通测试视频', status: 'failed', error: '上游超时，请重试', attempts: 0, createdAt: new Date().toISOString() }];
let mockCycles = [{ id: 'cycle-1', accountId: 'default', period: '本周内容计划', status: 'proposed', version: 1, contentCount: 1, brief: '重点建立家长信任', notice: '', error: '', slots: [{ id: 'slot-1', day: '第 1 天', contentType: '案例', topic: '家长为什么先问价格', purpose: '建立信任', recommendationReason: '回应高频顾虑', status: 'planned' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
let assets = [{ id: 'asset-image-1', kind: 'image', fileName: '形象照.jpg', file_name: '形象照.jpg', mimeType: 'image/jpeg', createdAt: new Date().toISOString() }];
let voices = [{ id: 'voice-1', name: '我的口播音色', status: 'ready', speakerId: 'reference', mode: 'reference', accountId: 'default', createdAt: new Date().toISOString() }];
let talkingWork = null;
let hostedWork = null;
let brains = [{ id: 'brain-1', kind: 'peer_report', name: '同行研究简报', status: 'ready', error: '', sourceNote: '3 条口播档案', profile: { positioning: '面向家长的教育口播号', cadence: '每周 3 条', tone: '短句、具体' }, sections: [{ title: '内容结构', content: '开场抛问题，中段给案例，结尾给动作。' }], accountId: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
let memories = [];
const workflowMeta = {

  styles: ['口语化', '专业解释', '故事感'],
  angles: [['痛点切入', '从家长最担心的问题切入'], ['政策解读', '解释新规对家长的实际影响'], ['案例反差', '用真实案例形成反差']],
  strengths: ['轻改造', '中改造', '重改造'],
  brains: [{ id: 'brain-1', name: '同行研究简报', kind: 'peer_report' }],
};
function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}
let plan = {
  id: 'pl-1', accountId: 'default', title: '家长问得最多的不是价格', objective: '让有顾虑的家长主动咨询',
  hook: '家长来问课，第一句往往不是多少钱。', script: '家长来问课，第一句往往不是多少钱，而是孩子到底能不能跟上。',
  prompt: '真实招生咨询场景，人物自然，镜头干净。', model: '', duration: 30, resolution: '768P', ratio: '9:16',
  generateAudio: true, assetIds: [], missing: [], rationale: '', publishDate: '', version: 1, status: 'draft',
  source: 'manual', chatMessageId: '', videoWorkId: '', renderId: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  materialRecommendations: [], repeatRisks: [],
};
let work = null;
let packageRow = null;
let workPollCount = 0;
const directorScript = {
  title: '家长问得最多的不是价格',
  strategy: '用真实咨询对话开场，先接住顾虑，再给出可验证的试听路径。',
  notes: '发布前核对价格与承诺。',
  shots: [
    { index: 1, seconds: 5, role: 'hook', scene: '家长在咨询桌前坐下', voiceover: '家长来问课，第一句往往不是多少钱。', overlay: '先别急着问价格', renderPrompt: '真实教育机构咨询场景，中景，自然光' },
    { index: 2, seconds: 8, role: 'pain', scene: '老师递上孩子测评记录', voiceover: '她真正担心的是孩子跟不上，钱花了却没有变化。', overlay: '怕的不是花钱，是没变化', renderPrompt: '老师和家长看测评表，手部特写' },
    { index: 3, seconds: 7, role: 'cta', scene: '家长点头并预约试听', voiceover: '先带孩子做一次试听，再决定要不要报名。', overlay: '先试听，再决定', renderPrompt: '咨询台前自然交流，温暖收尾' },
  ],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const send = (payload, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };
  if (url.pathname.endsWith('/plans') && req.method === 'GET') {
    return send({ data: { items: [plan] } });
  }
  if (url.pathname.endsWith('/cycles') && req.method === 'GET') {
    return send({ data: { items: mockCycles, current: mockCycles[0] || null } });
  }
  if (url.pathname.endsWith('/cycles') && req.method === 'POST') {
    const body = await readJson(req);
    const cycle = { id: 'cycle-2', accountId: 'default', period: '下个周期', status: 'proposed', version: 1, contentCount: 1, brief: body.brief || '', notice: '', error: '', slots: [{ id: 'slot-2', day: '第 1 天', contentType: '答疑', topic: '试听坐不住怎么办', purpose: '建立信任', recommendationReason: '常见问题', status: 'planned' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    mockCycles.unshift(cycle);
    return send({ data: { cycle } });
  }
  if (/\/cycles\/[^/]+\/confirm$/.test(url.pathname) && req.method === 'POST') {
    const id = decodeURIComponent(url.pathname.split('/').at(-2));
    mockCycles = mockCycles.map((item) => item.id === id ? { ...item, status: 'confirmed', version: Number(item.version || 1) + 1 } : item);
    return send({ data: { cycle: mockCycles.find((item) => item.id === id) } });
  }
  if (url.pathname.endsWith('/assets') && req.method === 'GET') {
    return send({ data: { items: assets, folders: [] } });
  }
  if (url.pathname.endsWith('/voices') && req.method === 'GET') {
    return send({ data: { items: voices } });
  }
  if (url.pathname.endsWith('/video/works') && req.method === 'POST') {
    const body = await readJson(req);
    const base = { accountId: 'default', productionMode: 'talking_head', title: body.title || body.topic || '数字人口播', status: 'draft', message: body.autoHost ? '托管正在写口播稿…' : '口播稿已就绪', durationSeconds: 12, resolution: body.resolution || '480P', ratio: '9:16', outputAssetId: null, error: '', autoHost: body.autoHost ? { enabled: true, stage: 'awaiting_confirmation' } : { enabled: false }, talkingHead: { text: body.speech || '', voiceId: body.voiceId || '', imageAssetId: body.imageAssetId || '', speed: body.speed || 'natural', voiceName: '我的口播音色', imageFileName: '形象照.jpg', plan: { batchCount: 4, segments: ['一', '二', '三', '四'], targetDuration: 12 } } };
    if (body.autoHost) {
      hostedWork = { ...base, id: 'work-hosted-1', status: 'planning', talkingHead: { ...base.talkingHead, text: '' } };
      return send({ data: { work: hostedWork } });
    }
    talkingWork = { ...base, id: 'work-talking-1' };
    return send({ data: { work: talkingWork } });
  }
  if (url.pathname.endsWith('/video/works/work-talking-1') && req.method === 'PUT') {
    const body = await readJson(req);
    talkingWork = { ...talkingWork, talkingHead: { ...talkingWork.talkingHead, text: body?.talkingHead?.text || talkingWork.talkingHead.text } };
    return send({ data: { work: talkingWork } });
  }
  if (url.pathname.endsWith('/video/works/work-talking-1') && req.method === 'GET') {
    return send({ data: { work: talkingWork, renders: [], package: null } });
  }
  if (url.pathname.endsWith('/video/works/work-hosted-1') && req.method === 'GET') {
    hostedWork = { ...hostedWork, status: 'draft', message: '托管已写好口播稿和分段，核对后确认合成。', talkingHead: { ...hostedWork.talkingHead, text: '这是托管自动写好的口播稿。' } };
    return send({ data: { work: hostedWork, renders: [], package: null } });
  }
  if (url.pathname.endsWith('/brains') && req.method === 'GET') {
    return send({ data: { items: brains } });
  }
  if (url.pathname.endsWith('/brains') && req.method === 'POST') {
    const body = await readJson(req);
    const brain = { id: `brain-${brains.length + 1}`, kind: body.kind || 'copy_brain', name: body.name || '写作大脑', status: 'running', error: '', sourceNote: `${(body.transcriptIds || []).length} 条口播档案`, profile: {}, sections: [], accountId: 'default', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    brains.unshift(brain);
    return send({ data: { brain } });
  }
  if (/\/brains\/[^/]+$/.test(url.pathname) && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    brains = brains.filter((item) => item.id !== id);
    return send({ data: { ok: true } });
  }
  if (url.pathname.endsWith('/memories') && req.method === 'GET') {
    return send({ data: { items: memories } });
  }
  if (url.pathname.endsWith('/memories') && req.method === 'POST') {
    const body = await readJson(req);
    const memory = { id: `memory-${memories.length + 1}`, kind: body.kind || 'memory', content: body.content || '', source: body.source || '', accountId: 'default', createdAt: new Date().toISOString() };
    memories.unshift(memory);
    return send({ data: { memory } });
  }
  if (/\/memories\/[^/]+$/.test(url.pathname) && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    memories = memories.filter((item) => item.id !== id);
    return send({ data: { ok: true } });
  }
  if (url.pathname.endsWith('/workflows') && req.method === 'GET') {
    return send({ data: { items: workflowRow ? [workflowRow] : [], ...workflowMeta } });
  }
  if (url.pathname.endsWith('/workflows') && req.method === 'POST') {
    const body = await readJson(req);
    if (body.kind === 'today') {
      workflowRow = {
        id: 'wf-1', kind: 'today', kindLabel: '今日选题', accountId: 'default', stage: 'idea', stageLabel: '选选题', status: 'active', error: '', input: body.input || {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        state: { goal: body.input?.goal || '', ideaOptions: [
          { id: 'idea-1', title: '家长问价格前，先讲清这三件事', hook: '家长第一句问多少钱，不代表只关心价格。', why: '直接回应近期咨询中的高频顾虑。' },
          { id: 'idea-2', title: '孩子试听坐不住，不等于不适合', hook: '一次试听坐不住，可能是环境陌生。', why: '适合建立信任。' },
          { id: 'idea-3', title: '报班前先看孩子卡在哪一步', hook: '先判断卡点，再决定要不要报班。', why: '有明确行动建议。' },
        ] },
      };
    } else if (body.kind === 'viral') {
      workflowRow = { id: 'wf-viral', kind: 'viral', kindLabel: '爆款复刻', accountId: 'default', stage: 'transcript', stageLabel: '确认原文', status: 'active', error: '', input: body.input || {}, state: { transcript: body.input?.sourceText || '参考同行结构生成的原文。' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    } else {
      workflowRow = { id: 'wf-hotspot', kind: 'hotspot', kindLabel: '热点结合', accountId: 'default', stage: 'hotspots_ready', stageLabel: '选热点', status: 'active', error: '', input: body.input || {}, state: { hotspots: [{ id: 'h-1', title: '寒假托管服务指引发布', fact: '多地发布寒假托管服务安排。', sourceName: '示例教育报', date: '2026-10-26' }] }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    }
    return send({ data: { workflow: workflowRow } });
  }
  if (/\/workflows\/[^/]+\/action$/.test(url.pathname) && req.method === 'POST') {
    const body = await readJson(req);
    if (!workflowRow) return send({ error: { message: 'workflow missing' } }, 404);
    if (body.action === 'cancel') {
      workflowRow = { ...workflowRow, status: 'cancelled' };
      return send({ data: { workflow: workflowRow } });
    }
    if (body.action === 'select_idea') {
      const idea = (workflowRow.state.ideaOptions || []).find((item) => item.id === body.optionId);
      workflowRow = { ...workflowRow, stage: 'brain', state: { ...workflowRow.state, selectedIdea: idea } };
      return send({ data: { workflow: workflowRow } });
    }
    if (body.action === 'select_brain') {
      const copyOptions = [
        { id: 'copy-1', title: '先别急着报班', content: '家长来问价格前，先看看孩子现在卡在哪一步。' },
        { id: 'copy-2', title: '孩子不是不努力', content: '一次试听坐不住，不代表不适合。' },
        { id: 'copy-3', title: '先试听再决定', content: '把判断交给真实课堂。' },
      ];
      workflowRow = {
        ...workflowRow, stage: 'rewriting', stageLabel: '写文案', status: 'active', state: {
          ...workflowRow.state,
          brainName: body.brainId ? '同行研究简报' : (body.style || '口语化'),
          copyOptions: copyOptions.slice(0, 1),
          message: '正在生成其余版本…',
        },
      };
      const streamingRow = workflowRow;
      setTimeout(() => {
        if (workflowRow === streamingRow && workflowRow.stage === 'rewriting') {
          workflowRow = { ...workflowRow, stage: 'ready', stageLabel: '选版本', state: { ...workflowRow.state, copyOptions, message: '' } };
        }
      }, 1800);
      return send({ data: { workflow: workflowRow } });
    }
    if (body.action === 'select_copy') {
      const option = (workflowRow.state.copyOptions || []).find((item) => item.id === body.optionId);
      workflowRow = { ...workflowRow, stage: 'done', status: 'done', state: { ...workflowRow.state, selectedCopy: option } };
      return send({ data: { workflow: workflowRow, draft: { id: 'draft-1', topic: option?.title || '工作流文案', style: '口语化', content: option?.content || '', accountId: 'default', createdAt: new Date().toISOString() } } });
    }
    if (body.action === 'regenerate') return send({ data: { workflow: workflowRow } });
    return send({ error: { message: `unsupported workflow action: ${body.action}` } }, 400);
  }
  if (url.pathname.endsWith('/plans/pl-1/preflight') && req.method === 'GET') {
    return send({ data: { plan, prompt: plan.prompt, outputSeconds: plan.duration, inputSeconds: 0, billingSeconds: plan.duration, missing: [], repeatRisks: [], videoReady: true, provider: 'mock-video', model: 'mock', estimate: { minFen: 75, maxFen: 75, totalFen: 75, note: '按 30 秒估算' }, pricingNote: 'mock', notice: '确认后会创建视频任务并生成编导稿；成片渲染还会再确认一次。' } });
  }
  if (url.pathname.endsWith('/plans/pl-1/submit') && req.method === 'POST') {
    plan = { ...plan, status: 'submitted', videoWorkId: 'w-1', version: 2 };
    work = { id: 'w-1', planId: 'pl-1', accountId: 'default', title: '家长问得最多的不是价格', status: 'planning', message: '正在写编导稿…', directorScript: null, scriptEdited: false, durationSeconds: 30, resolution: '768P', ratio: '9:16', outputAssetId: null, error: '' };
    return send({ data: { plan, work } });
  }
  if (url.pathname.endsWith('/plans/pl-1') && req.method === 'PUT') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      plan = { ...plan, ...parsed, version: Number(plan.version || 1) + 1, updatedAt: new Date().toISOString() };
      send({ data: { plan } });
    });
    return;
  }
  if (url.pathname.endsWith('/plans') && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      plan = { ...plan, ...parsed, status: 'draft', version: 1 };
      send({ data: { plan } });
    });
    return;
  }
  if (url.pathname.endsWith('/video/works/w-1/confirm') && req.method === 'POST') {
    work = { ...work, status: 'rendering', message: '正在生成视频…' };
    workPollCount = 0;
    return send({ data: { work, renderId: 'render-1' } });
  }
  if (url.pathname.endsWith('/video/works/w-1/package') && req.method === 'POST') {
    packageRow = { id: 'pkg-1', workId: 'w-1', renderId: 'render-1', status: 'running', title: plan.title, description: '真实家长咨询场景，先试听再决定。', tags: ['教育', '招生', '家长必看'], options: {}, videoAssetId: 'asset-video', coverAssetId: 'asset-cover', srtAssetId: 'asset-srt', zipAssetId: 'asset-zip', error: '' };
    return send({ data: { package: packageRow } });
  }
  if (url.pathname.endsWith('/video/works/w-1') && req.method === 'PUT') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      work = { ...work, directorScript: parsed.directorScript || work.directorScript, scriptEdited: true };
      send({ data: { work } });
    });
    return;
  }
  if (url.pathname.endsWith('/video/works/w-1') && req.method === 'GET') {
    workPollCount += 1;
    if (work?.status === 'planning' && workPollCount >= 1) {
      work = { ...work, status: 'draft', message: '编导稿已生成，检查后确认渲染。', directorScript };
    } else if (work?.status === 'rendering' && workPollCount >= 1) {
      work = { ...work, status: 'succeeded', message: '成片已生成', outputAssetId: 'asset-video' };
    }
    if (packageRow?.status === 'running' && workPollCount >= 2) {
      packageRow = { ...packageRow, status: 'ready' };
    }
    return send({ data: { work, renders: work?.status === 'succeeded' ? [{ id: 'render-1', status: 'succeeded', assetId: 'asset-video', kind: 'main' }] : [], package: packageRow } });
  }
  if (url.pathname.endsWith('/chat/stream')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    setTimeout(() => {
      res.write(`event: status\ndata: ${JSON.stringify({ text: '正在写 3 个版本…' })}\n\n`);
      res.write(`event: delta\ndata: ${JSON.stringify({ text: longAnswer })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ message: { content: longAnswer } })}\n\n`);
      res.end();
    }, 250);
    return;
  }
  if (url.pathname.endsWith('/reviews/insights')) return send({ data: { insight, sampleCount: 1 } });
  if (url.pathname.endsWith('/bootstrap')) return send({ data: { stats: { jobs: 1 } } });
  if (url.pathname.endsWith('/refs')) return send({ data: { items: [] } });
  if (url.pathname.endsWith('/reports')) return send({ data: { items: [{ id: 'work-1', topic: '家长先别急着报班', stats: { plays: 3200, likes: 61, saves: 18, publishedAt: '2026-10-20' } }], ownCount: 1, pendingCount: 0 } });
  if (url.pathname.endsWith('/jobs') && req.method === 'GET') return send({ data: { items: mockJobs, total: mockJobs.length, kinds: [{ kind: '视频渲染', count: 1 }], statuses: [{ status: 'failed', count: mockJobs.filter((item) => item.status === 'failed').length }] } });
  if (/\/jobs\/[^/]+\/retry$/.test(url.pathname) && req.method === 'POST') { mockJobs = mockJobs.map((item) => ({ ...item, status: 'succeeded', error: '' })); return send({ data: { ok: true, message: '已重新提交任务' } }); }
  if (url.pathname.endsWith('/transcripts')) return send({ data: { items: [{ id: 'transcript-1', source: 'douyin', status: 'succeeded', title: '同行参考作品一', nickname: '橘子老师', text: '先问孩子卡在哪，再谈课程。', segmentCount: 2 }] } });
  if (url.pathname.endsWith('/douyin/assistant/pairing')) return send({ data: { code: 'test-pair-code' } });
  if (url.pathname.endsWith('/douyin/assistant/pair')) return send({ data: { token: 'assistant-test-token' } });
  return send({ error: { message: `unexpected route: ${url.pathname}` } }, 404);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const app = await electron.launch({
  executablePath,
  args: [appPath, `--user-data-dir=${profile}`],
  cwd: appPath,
  env: {
    ...process.env,
    JUNSHI_SITE_URL: `http://127.0.0.1:${port}`,
    JUNSHI_TEST_SESSION_JSON: JSON.stringify({
      token: 'smoke-session-token',
      expiresAt: '2099-12-31T00:00:00.000Z',
      user: { login: 'smoke', displayName: '冒烟测试' },
      organization: { name: '冒烟机构' },
    }),
  },
});

try {
  const page = await app.firstWindow({ timeout: 30000 });
  await page.waitForSelector('.app-shell', { timeout: 20000 });
  await page.locator('[data-page="create"]').click();
  await page.waitForSelector('#create-idea', { timeout: 10000 });
  await page.fill('#create-idea', '家长觉得 AI 课太贵，帮我写一条讲清价值的短视频口播');
  await page.locator('[data-action="generate"]').click();
  await page.waitForSelector('.stream-status', { timeout: 5000 });
  await page.waitForSelector('.output-next', { timeout: 10000 });

  const layout = await page.evaluate(() => {
    const card = document.querySelector('.output-card');
    const output = document.querySelector('.output-text');
    const view = document.querySelector('.view');
    const next = document.querySelector('.output-next');
    return {
      cardHeight: card?.getBoundingClientRect().height || 0,
      viewportHeight: window.innerHeight,
      viewScrollTop: view?.scrollTop || 0,
      outputClientHeight: output?.clientHeight || 0,
      outputScrollHeight: output?.scrollHeight || 0,
      outputOverflowY: output ? getComputedStyle(output).overflowY : '',
      nextText: next?.textContent || '',
      actions: Array.from(document.querySelectorAll('.output-next [data-action]')).map((node) => node.dataset.action),
    };
  });
  if (!layout.nextText.includes('下一步') || !layout.nextText.includes('编导稿') || !layout.actions.includes('production-start') || !layout.actions.includes('copy-output')) {
    throw new Error(`missing production entry actions: ${JSON.stringify(layout)}`);
  }
  if (layout.cardHeight > layout.viewportHeight || layout.outputOverflowY !== 'auto' || layout.outputScrollHeight <= layout.outputClientHeight) {
    throw new Error(`output is not bounded/scrollable: ${JSON.stringify(layout)}`);
  }

  if (process.env.JUNSHI_UX_SCREENSHOT) await page.screenshot({ path: process.env.JUNSHI_UX_SCREENSHOT, fullPage: false });

  await page.locator('[data-action="context-open"][data-context="brains"]').click();
  await page.waitForSelector('.brain-card', { timeout: 5000 });
  await page.locator('[data-action="brain-detail"]').first().click();
  const brainPanel = await page.evaluate(() => ({ cards: document.querySelectorAll('.brain-card').length, detail: document.querySelector('.brain-detail')?.innerText || '' }));
  if (brainPanel.cards < 1 || !brainPanel.detail.includes('内容结构')) throw new Error(`brain panel incomplete: ${JSON.stringify(brainPanel)}`);
  if (process.env.JUNSHI_CONTEXT_SCREENSHOT) await page.screenshot({ path: process.env.JUNSHI_CONTEXT_SCREENSHOT, fullPage: false });
  await page.locator('[data-action="brain-composer-toggle"]').click();
  await page.waitForSelector('#brain-name', { timeout: 5000 });
  await page.fill('#brain-name', '家长沟通写法');
  await page.locator('input[name="brainTranscript"]').first().check();
  await page.locator('[data-action="brain-create"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.brain-card').length >= 2, null, { timeout: 5000 });
  const brainCardsAfterCreate = await page.locator('.brain-card').count();
  await page.locator('[data-action="context-back"]').click();

  await page.locator('[data-action="context-open"][data-context="memories"]').click();
  await page.waitForSelector('#memory-content', { timeout: 5000 });
  await page.fill('#memory-content', '家长最担心孩子坐不住，表达时先接住这个顾虑。');
  await page.locator('[data-action="memory-create"]').click();
  await page.waitForSelector('.memory-card', { timeout: 5000 });
  const memoryCount = await page.locator('.memory-card').count();
  if (memoryCount !== 1) throw new Error(`memory was not saved: ${memoryCount}`);
  await page.locator('[data-action="context-back"]').click();

  await page.locator('[data-action="workflow-open"][data-kind="today"]').click();
  await page.waitForSelector('#workflow-goal', { timeout: 5000 });
  await page.fill('#workflow-goal', '家长总觉得课程贵，想讲清价值');
  await page.locator('[data-action="workflow-launch"]').click();
  await page.waitForSelector('[data-action="workflow-select-idea"]', { timeout: 10000 });
  if (process.env.JUNSHI_WORKFLOW_SCREENSHOT) await page.screenshot({ path: process.env.JUNSHI_WORKFLOW_SCREENSHOT, fullPage: false });
  const workflowIdeaCount = await page.locator('[data-action="workflow-select-idea"]').count();
  await page.locator('[data-action="workflow-select-idea"]').first().click();
  await page.waitForSelector('[data-action="workflow-select-brain"]', { timeout: 10000 });
  await page.locator('[data-action="workflow-select-brain"]').first().click();
  await page.waitForSelector('[data-action="workflow-select-copy"]', { timeout: 10000 });
  const streamingCopy = await page.locator('[data-action="workflow-select-copy"]').first();
  const streamingCopyDisabled = await streamingCopy.isDisabled();
  const streamingCopyText = (await streamingCopy.innerText()).trim();
  if (!streamingCopyDisabled || streamingCopyText !== '生成中…') {
    throw new Error(`streaming copy must be disabled: ${JSON.stringify({ streamingCopyDisabled, streamingCopyText })}`);
  }
  await page.waitForFunction(() => {
    const buttons = document.querySelectorAll('[data-action="workflow-select-copy"]');
    return buttons.length === 3 && !buttons[0].disabled;
  }, null, { timeout: 10000 });
  const workflowCopyCount = await page.locator('[data-action="workflow-select-copy"]').count();
  await page.locator('[data-action="workflow-select-copy"]').first().click();
  await page.waitForSelector('.output-next', { timeout: 10000 });
  const workflowAdopted = await page.evaluate(() => ({
    text: document.querySelector('#output-text')?.textContent || '',
    next: document.querySelector('.output-next')?.textContent || '',
  }));
  if (workflowIdeaCount !== 3 || workflowCopyCount !== 3 || !workflowAdopted.text.includes('家长来问价格前') || !workflowAdopted.next.includes('完整制作流程')) {
    throw new Error(`workflow did not feed create: ${JSON.stringify({ workflowIdeaCount, workflowCopyCount, workflowAdopted })}`);
  }

  page.on('dialog', (dialog) => dialog.accept());
  await page.locator('[data-action="production-start"]').click();
  await page.waitForSelector('[data-action="production-save-plan"]', { timeout: 5000 });
  const productionTitle = await page.locator('[data-production-field="title"]').inputValue();
  if (!productionTitle.includes('先别急着报班')) throw new Error(`workflow title was not carried into production: ${productionTitle}`);

  await page.locator('[data-action="production-mode"][data-mode="talking_head"]').click();
  await page.waitForSelector('#production-voice', { timeout: 5000 });
  await page.selectOption('#production-image-asset', '');
  await page.selectOption('#production-voice', '');
  const avatarClearedDisabled = await page.locator('[data-action="production-create-talking"]').isDisabled();
  if (!avatarClearedDisabled) throw new Error('talking head create action must be disabled after clearing avatar fields');
  await page.selectOption('#production-image-asset', { index: 1 });
  await page.selectOption('#production-voice', { index: 1 });
  await page.waitForFunction(() => !document.querySelector('[data-action="production-create-talking"]')?.disabled, null, { timeout: 5000 });
  const avatarOptions = await page.evaluate(() => ({ images: document.querySelectorAll('#production-image-asset option').length, voices: document.querySelectorAll('#production-voice option').length, enabled: !document.querySelector('[data-action="production-create-talking"]')?.disabled }));
  avatarOptions.clearedDisabled = avatarClearedDisabled;
  if (avatarOptions.images < 2 || avatarOptions.voices < 2 || !avatarOptions.enabled) throw new Error(`talking head form incomplete: ${JSON.stringify(avatarOptions)}`);
  if (process.env.JUNSHI_VIDEO_MODES_SCREENSHOT) await page.screenshot({ path: process.env.JUNSHI_VIDEO_MODES_SCREENSHOT, fullPage: false });
  await page.locator('[data-action="production-create-talking"]').click();
  await page.waitForSelector('#production-talking-text', { timeout: 5000 });
  await page.locator('[data-action="production-edit-plan"]').click();

  await page.locator('[data-action="production-mode"][data-mode="hosted"]').click();
  await page.waitForSelector('[data-action="production-create-hosted"]', { timeout: 5000 });
  await page.locator('[data-action="production-create-hosted"]').click();
  await page.waitForFunction(() => document.querySelector('#production-talking-text')?.value?.includes('托管自动写好'), null, { timeout: 10000 });
  await page.locator('[data-action="production-edit-plan"]').click();
  await page.locator('[data-action="production-mode"][data-mode="storyboard"]').click();

  const draftState = await page.evaluate(() => ({
    steps: Array.from(document.querySelectorAll('.production-step')).map((node) => node.textContent.trim()),
    versionCount: document.querySelectorAll('.production-version').length,
    body: document.querySelector('.production-page')?.innerText || '',
  }));
  if (!draftState.body.includes('编导稿') || !draftState.body.includes('发布包')) {
    throw new Error(`production draft is incomplete: ${JSON.stringify(draftState)}`);
  }
  if (process.env.JUNSHI_PRODUCTION_SCREENSHOT) await page.screenshot({ path: process.env.JUNSHI_PRODUCTION_SCREENSHOT, fullPage: false });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 720));
  await page.waitForTimeout(200);
  const responsive = await page.evaluate(() => {
    const view = document.querySelector('.view');
    return { viewClientWidth: view?.clientWidth || 0, viewScrollWidth: view?.scrollWidth || 0, width: window.innerWidth, height: window.innerHeight };
  });
  if (responsive.viewScrollWidth > responsive.viewClientWidth + 1) throw new Error(`production page overflows horizontally: ${JSON.stringify(responsive)}`);

  await page.locator('[data-action="production-save-plan"]').click();
  await page.waitForSelector('#production-plan-confirm', { timeout: 10000 });
  await page.locator('#production-plan-confirm').check();
  await page.locator('[data-action="production-submit-plan"]').click();
  await page.waitForSelector('[data-shot-field="voiceover"]', { timeout: 10000 });
  const shotCount = await page.locator('.production-shot').count();
  if (shotCount < 2) throw new Error(`expected storyboard shots, got ${shotCount}`);
  await page.locator('[data-shot-field="voiceover"]').first().fill('这是人工修改后的开场口播。');
  await page.locator('[data-action="production-save-script"]').click();
  await page.waitForSelector('[data-action="production-save-script"]:not([disabled])', { timeout: 5000 });
  const editedVoiceover = await page.locator('[data-shot-field="voiceover"]').first().inputValue();
  if (!editedVoiceover.includes('人工修改')) throw new Error(`storyboard edit was not saved: ${editedVoiceover}`);

  await page.locator('#production-render-confirm').check();
  await page.locator('[data-action="production-confirm-render"]').click();
  await page.waitForSelector('[data-action="production-open-package"]', { timeout: 12000 });
  await page.locator('[data-action="production-open-package"]').click();
  await page.waitForSelector('[data-action="production-create-package"]', { timeout: 5000 });
  await page.locator('[data-action="production-create-package"]').click();
  await page.waitForSelector('[data-action="production-open-publish"]', { timeout: 12000 });
  await page.locator('[data-action="production-open-publish"]').click();
  await page.waitForSelector('[data-action="production-sync-after-publish"]', { timeout: 5000 });
  const publishState = await page.evaluate(() => ({
    text: document.querySelector('.production-page')?.innerText || '',
    currentStep: Array.from(document.querySelectorAll('.production-step')).findIndex((node) => node.classList.contains('active')),
  }));
  if (!publishState.text.includes('下载并检查发布包') || !publishState.text.includes('发布后') || publishState.currentStep !== 5) {
    throw new Error(`publish workflow is incomplete: ${JSON.stringify(publishState)}`);
  }

  if (process.env.JUNSHI_PUBLISH_SCREENSHOT) await page.screenshot({ path: process.env.JUNSHI_PUBLISH_SCREENSHOT, fullPage: false });

  await page.locator('[data-page="reports"]').click();
  await page.waitForSelector('[data-action="generate-insight"]:not([disabled])', { timeout: 5000 });
  await page.locator('[data-action="generate-insight"]').first().click();
  await page.waitForSelector('[data-action="insight-to-create"]', { timeout: 10000 });
  await page.locator('[data-action="insight-to-create"]').click();
  await page.waitForSelector('#create-idea', { timeout: 5000 });
  const idea = await page.locator('#create-idea').inputValue();
  if (!idea.includes('数据建议')) throw new Error(`insight was not carried into create: ${idea.slice(0, 80)}`);

  await page.locator('[data-action="context-open"][data-context="assets"]').click();
  await page.waitForSelector('.asset-card', { timeout: 5000 });
  const assetCount = await page.locator('.asset-card').count();
  await page.locator('[data-action="context-back"]').click();

  await page.locator('[data-action="context-open"][data-context="jobs"]').click();
  await page.waitForSelector('.job-center-card', { timeout: 5000 });
  const jobCount = await page.locator('.job-center-card').count();
  await page.locator('[data-action="job-retry"]').first().click();
  await page.waitForFunction(() => !document.querySelector('[data-action="job-retry"]'), null, { timeout: 5000 });
  await page.locator('[data-action="context-back"]').click();

  await page.locator('[data-action="context-open"][data-context="plans"]').click();
  await page.waitForSelector('.plan-library-card', { timeout: 5000 });
  await page.locator('[data-action="plan-library-detail"]').first().click();
  const planDetail = await page.locator('.plan-library-detail').innerText();
  if (!planDetail.includes('家长') && !planDetail.includes('口播')) throw new Error(`plan detail incomplete: ${planDetail.slice(0, 100)}`);
  await page.locator('[data-action="context-back"]').click();

  await page.locator('[data-action="context-open"][data-context="cycles"]').click();
  await page.waitForSelector('.cycle-card', { timeout: 5000 });
  await page.locator('[data-action="cycle-confirm"]').first().click();
  await page.waitForFunction(() => document.querySelector('.cycle-status')?.textContent?.includes('已确认'), null, { timeout: 5000 });
  await page.locator('[data-action="cycle-slot-use"]').first().click();
  await page.waitForSelector('#create-idea', { timeout: 5000 });
  const cycleIdea = await page.locator('#create-idea').inputValue();
  if (!cycleIdea.includes('家长为什么先问价格')) throw new Error(`cycle idea was not carried into create: ${cycleIdea}`);

  console.log(JSON.stringify({ name: 'junshi-desktop-app-ux-smoke', pass: true, layout, productionDraft: draftState, shotCount, storyboardEdited: true, publishStep: publishState.currentStep, responsive, workflow: { ideaCount: workflowIdeaCount, copyCount: workflowCopyCount, streamingCopyDisabled, productionTitle }, videoModes: { avatarOptions, hostedDraft: true }, context: { brainCards: brainPanel.cards, brainCardsAfterCreate, memoryCount, assetCount, jobCount, cycleConfirm: true }, insightFlow: true }));
} finally {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}
