/**
 * P198 归档管线的**免费压力测试**（2026-11-01）。
 *
 * 为什么要有它：把 `AI_GENERATION_CONCURRENCY` 开到 100 之后，"归档会不会成为新瓶颈"
 * 只能靠压测回答。但真实压测要 100 次 H3（要花钱）。这个脚本用**本地假上游**跑同一套代码：
 *   · `stageGeneratedAssets` 建 100 条占位行（与生产同一个函数）；
 *   · `drainArchiveQueue` 按 `AI_ARCHIVE_CONCURRENCY` 并发把字节搬回来；
 *   · 断言全部被填上、临时文件不留、内存不随条数增长。
 *
 * 它**不验证**的：真实上游的 QPS/429/计费。那部分只能用真钱测，见文档。
 *
 * 跑法：node scripts/p198-archive-load.mjs [条数]
 * 成本：0（不访问任何外部地址）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const COUNT = Number(process.argv[2] || 100);
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p198-archive-load-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;
process.env.FILE_UPLOAD_ROOT = path.join(temp, 'uploads');
process.env.FILE_STORAGE = 'local';
process.env.DEPLOYMENT_MODE = 'local-mock';
process.env.AI_ARCHIVE_CONCURRENCY = '8';
process.env.AI_ARCHIVE_MAX_ATTEMPTS = '2';

const run = (args, label) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => (code ? reject(new Error(`${label} 失败：${err.slice(-500)}`)) : resolve()));
});

// 1MB 的"PNG"：前 8 字节是真的 PNG 头（sniffMime 认这个），后面填充到 1MB。
// 用 1MB 而不是真实的 20MB：这份压测要证明的是**管线与并发**，不是带宽（本地磁盘没有带宽问题）。
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BODY = Buffer.concat([PNG_HEADER, Buffer.alloc(1024 * 1024 - PNG_HEADER.length, 0x20)]);

let server;
let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (error) { failures += 1; console.error(`  ✗ ${label} —— ${error.message}`); }
};

try {
  await run(['packages/database/src/db.js', '--init'], 'db --init');
  await run(['packages/database/src/seed.js'], 'seed');

  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(BODY.length) });
    res.end(BODY);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const { arow } = await import('../packages/database/src/store.js');
  const { stageGeneratedAssets, drainArchiveQueue, awaitArchiveIdle, pendingArchiveCount, archiveQueueState } =
    await import('../apps/server/src/services/generatedAssetArchiveQueue.js');
  const { archiveTempUsage } = await import('../apps/server/src/services/generatedAssetArchive.js');

  const student = await arow("SELECT id, org_id FROM users WHERE login='student-1'");
  assert.ok(student, '种子库里没有 student-1');

  const rssBefore = process.memoryUsage().rss;
  const startedAt = Date.now();

  const payloads = Array.from({ length: COUNT }, (_, index) => ({ assetUrl: `${base}/f${index}.png`, mimeType: 'image/png' }));
  const staged = await stageGeneratedAssets(payloads, { modality: 'IMAGE', jobId: 'job_p198', ownerUserId: student.id, ownerOrgId: student.org_id });
  const stagedMs = Date.now() - startedAt;

  await check(`建 ${COUNT} 条占位行（全部拿到稳定地址）`, async () => {
    assert.equal(staged.length, COUNT);
    assert.ok(staged.every((item) => /^\/api\/student\/file-assets\/file_[\w-]+\/download$/.test(item.assetUrl)));
    assert.equal(await pendingArchiveCount(), COUNT);
  });

  await check('地址各不相同（没有复用同一行）', async () => {
    assert.equal(new Set(staged.map((item) => item.assetUrl)).size, COUNT);
  });

  await check(`后台队列按并发 ${archiveQueueState().concurrency} 把 ${COUNT} 条全部归档`, async () => {
    const deadline = Date.now() + 120000;
    for (;;) {
      await drainArchiveQueue();
      await awaitArchiveIdle({ timeoutMs: 60000 });
      if (await pendingArchiveCount() === 0) break;
      if (Date.now() > deadline) throw new Error(`超时：还剩 ${await pendingArchiveCount()} 条没归档`);
    }
    assert.equal(await pendingArchiveCount(), 0);
    assert.equal(archiveQueueState().failed, 0, `有 ${archiveQueueState().failed} 条最终失败`);
    assert.equal(archiveQueueState().done, COUNT, `只有 ${archiveQueueState().done} 条成功`);
  });

  const totalMs = Date.now() - startedAt;
  const rssAfter = process.memoryUsage().rss;
  const rssDeltaMb = Math.round((rssAfter - rssBefore) / 1024 / 1024);

  await check('临时文件没有残留', async () => {
    const usage = await archiveTempUsage();
    assert.equal(usage.files, 0, `留下 ${usage.files} 个临时文件（${usage.bytes} 字节）`);
  });

  await check('内存没有随条数线性增长（流式生效）', async () => {
    // 100 条 × 1MB = 100MB；如果是整段读进内存，增量至少 ≥100MB。
    // 流式后增量应当远小于这个数（8 路并发 × chunk）。给 80MB 的宽限（Node 自身波动）。
    const budgetMb = Math.max(80, COUNT * 0.8);
    assert.ok(rssDeltaMb < budgetMb, `RSS 增长 ${rssDeltaMb}MB，超过预算 ${Math.round(budgetMb)}MB`);
  });

  console.log('');
  console.log(`  建行 ${stagedMs}ms · 全流程 ${totalMs}ms · 平均 ${Math.round(totalMs / COUNT)}ms/条`);
  console.log(`  归档并发 ${archiveQueueState().concurrency} · RSS 增长 ${rssDeltaMb}MB（${COUNT} 条 × 1MB）`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
}

assert.equal(failures, 0, `P198 有 ${failures} 条断言没过`);
console.log(`PASS: 归档管线 ${COUNT} 条免费压测（占位行 → 后台队列 → 全部落地，无残留、内存不随条数增长）`);
