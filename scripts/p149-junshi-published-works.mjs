/**
 * P149 招生军师十四期：采集助手同步「自己已发布作品」→ 数据复盘自动回填。
 *
 * 用户口径（2026-10-25）：
 *   ① 扩展在用户自己的抖音主页上读到作品列表，点「采集我的作品」上报；
 *   ② 播放/赞/评/转/藏直接进数据复盘，不再要求逐条截图；
 *   ③ 同一作品重复采集只更新数字，不新增重复行；
 *   ④ 复盘页同时保留原来的截图回填数据，两种来源合并统计；
 *   ⑤ 复盘洞察用合并后的数据（样本数 = 采集作品 + 截图回填）。
 *
 * ⚠️ 真起服务、真走 HTTP：schema 新表、配对账号绑定、免登录 ingest、/reports 聚合、
 *    洞察样本数 —— 只看源码或只调函数都验不出来。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p149-published-works-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DB_DRIVER: 'sqlite',
  AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const orgAdmin = await arow("SELECT id, org_id FROM users WHERE login='org-admin'");
assert.ok(orgAdmin, 'seed 里没有 org-admin');

const port = 19089;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null, code: payload?.error?.code || null };
}

const works = [
  {
    awemeId: '7450000000000000001',
    desc: '第一条：寒假班怎么选',
    playUrl: '',
    cover: 'https://example.test/cover1.jpg',
    shareUrl: 'https://www.douyin.com/video/7450000000000000001',
    createTime: 1760000000,
    durationMs: 18000,
    stats: { plays: 1200, digg: 130, comment: 12, share: 6, collect: 21 },
  },
  {
    awemeId: '7450000000000000002',
    desc: '第二条：体验课怎么开口',
    playUrl: 'https://example.test/play2.mp4',
    cover: 'https://example.test/cover2.jpg',
    shareUrl: 'https://www.douyin.com/video/7450000000000000002',
    createTime: 1760200000,
    durationMs: 22000,
    stats: { plays: 800, digg: 88, comment: 9, share: 4, collect: 15 },
  },
];

try {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch { /* 等服务起来 */ }
    await sleep(100);
  }

  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } });
  const token = login.data?.token;
  assert.ok(token, `登录失败：${JSON.stringify(login)}`);

  const pairing = await api('/api/junshi/workbench/douyin/assistant/pairing', { method: 'POST', token, body: { accountId: 'default' } });
  check('① 生成配对码绑定当前账号', pairing.status === 200 && /^[A-Z2-9]{6}$/.test(pairing.data?.code || ''), JSON.stringify(pairing));
  const pair = await api('/api/junshi/workbench/douyin/assistant/pair', { method: 'POST', body: { code: pairing.data.code, device: 'p149' } });
  const extToken = pair.data?.token;
  check('① 配对码换长期 token', pair.status === 200 && Boolean(extToken), JSON.stringify(pair));

  const first = await api('/api/junshi/workbench/douyin/assistant/ingest', {
    method: 'POST',
    token: extToken,
    body: { mode: 'self', secUserId: 'self-p149', nickname: '测试自己的号', works },
  });
  check('② 自己作品上报被接收（不走同行下载）', first.status === 200 && first.data?.accepted === 2 && first.data?.created === 2 && first.data?.updated === 0, JSON.stringify(first));

  let report = await api('/api/junshi/workbench/reports?accountId=default', { token });
  check('② 复盘列表直接出现 2 条采集作品', report.status === 200 && report.data?.items?.length === 2, JSON.stringify(report.data?.counts));
  check('② 来源标记为采集助手、数字/发布时间完整',
    report.data?.items?.[0]?.origin === 'douyin_assistant'
    && report.data.items[0].stats.plays === Number(works[1].stats.plays)
    && report.data.items[0].stats.publishedAt === '2025-10-11'
    && report.data.items[0].shareUrl === works[1].shareUrl,
    JSON.stringify(report.data?.items?.[0]));
  check('② 汇总卡把播放/赞评转藏都算进去',
    report.data?.totals?.plays === 2000 && report.data?.totals?.likes === 218
    && report.data?.counts?.own === 2 && report.data?.counts?.screenshot === 0,
    JSON.stringify({ totals: report.data?.totals, counts: report.data?.counts }));

  const updatedWorks = works.map((work) => ({ ...work, stats: { ...work.stats, plays: work.stats.plays + 100 } }));
  updatedWorks.push({
    awemeId: '7450000000000000003',
    desc: '第三条：新作品',
    cover: '',
    shareUrl: 'https://www.douyin.com/video/7450000000000000003',
    createTime: 1760400000,
    stats: { plays: 300, digg: 30, comment: 3, share: 1, collect: 5 },
  });
  const second = await api('/api/junshi/workbench/douyin/assistant/ingest', {
    method: 'POST',
    token: extToken,
    body: { mode: 'self', works: updatedWorks },
  });
  check('③ 重复采集只更新、不新增重复作品', second.status === 200 && second.data?.created === 1 && second.data?.updated === 2, JSON.stringify(second.data));

  report = await api('/api/junshi/workbench/reports?accountId=default', { token });
  check('③ 复盘列表变成 3 条（没有重复行）', report.data?.items?.length === 3 && report.data?.counts?.own === 3, JSON.stringify(report.data?.counts));
  check('③ 旧作品数字被新一次采集覆盖', report.data?.totals?.plays === 2500, JSON.stringify(report.data?.totals));

  const ownerKey = `org:${orgAdmin.org_id}`;
  await aq(
    'INSERT INTO junshi_workbench_copy_drafts (id,owner_key,org_id,account_id,topic,style,content,stats,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ['jwc_p149_screenshot', ownerKey, orgAdmin.org_id, 'default', '截图回填样例', '口语化', '测试内容', JSON.stringify({ plays: 500, likes: 50, comments: 5, shares: 2, saves: 10, publishedAt: '10月20日', backfilledAt: new Date().toISOString() }), new Date().toISOString()],
  );
  report = await api('/api/junshi/workbench/reports?accountId=default', { token });
  check('④ 截图回填与采集作品在复盘页合并', report.data?.items?.length === 4 && report.data?.counts?.own === 3 && report.data?.counts?.screenshot === 1, JSON.stringify(report.data?.counts));
  check('④ 合并后的汇总数字正确', report.data?.totals?.plays === 3000 && report.data?.totals?.likes === 298, JSON.stringify(report.data?.totals));

  const insight = await api('/api/junshi/workbench/reviews/insights', { method: 'POST', token, body: { accountId: 'default' } });
  check('⑤ 复盘洞察用合并后的 4 条样本', insight.status === 200 && insight.data?.sampleCount === 4 && /演示/.test(insight.data?.insight || ''), JSON.stringify({ status: insight.status, sampleCount: insight.data?.sampleCount }));

  const account = await api('/api/junshi/workbench/accounts', { method: 'POST', token, body: { name: '测试副号' } });
  const accountId = account.data?.account?.id;
  check('⑥ 可以建第二个创作账号', account.status === 200 && Boolean(accountId), JSON.stringify(account));
  const pairing2 = await api('/api/junshi/workbench/douyin/assistant/pairing', { method: 'POST', token, body: { accountId } });
  const pair2 = await api('/api/junshi/workbench/douyin/assistant/pair', { method: 'POST', body: { code: pairing2.data.code, device: 'p149-account-2' } });
  const secondIngest = await api('/api/junshi/workbench/douyin/assistant/ingest', {
    method: 'POST',
    token: pair2.data.token,
    body: {
      mode: 'self',
      works: [{
        awemeId: '7450000000000000004',
        desc: '副号作品：只属于副号',
        shareUrl: 'https://www.douyin.com/video/7450000000000000004',
        createTime: 1760600000,
        stats: { plays: 100, digg: 10, comment: 1, share: 0, collect: 2 },
      }],
    },
  });
  check('⑥ 配对码绑定的账号收到自己作品', secondIngest.status === 200 && secondIngest.data?.accountId === accountId && secondIngest.data?.created === 1, JSON.stringify(secondIngest.data));
  const defaultAfter = await api('/api/junshi/workbench/reports?accountId=default', { token });
  const secondReport = await api('/api/junshi/workbench/reports?accountId=' + encodeURIComponent(accountId), { token });
  check('⑥ 复盘按账号隔离，不串数据', defaultAfter.data?.counts?.own === 3 && secondReport.data?.counts?.own === 1 && secondReport.data?.items?.[0]?.topic === '副号作品：只属于副号', JSON.stringify({ defaultOwn: defaultAfter.data?.counts?.own, secondOwn: secondReport.data?.counts?.own }));
} finally {
  server.kill();
  await sleep(800);
  // Windows 上服务进程刚退出时临时库句柄可能还没释放；清理失败不该把测试判红。
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 交给系统临时目录清理 */ }
}

console.log(`\n结论：${failures ? `${failures} 项失败` : '全部通过'}`);
if (failures) {
  console.log(serverLog.slice(-4000));
  process.exit(1);
}
