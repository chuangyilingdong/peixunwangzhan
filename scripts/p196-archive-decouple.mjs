/**
 * P196 生成产物的「占位行 + 后台归档」守卫（2026-11-01，B2 解耦）。
 *
 * 钉的是什么：原来"任务完成"的条件里包含"20MB 已经存进 OSS"。一条 H3 20-22MB，
 * 1000 路并行就是 20GB 全挤在"还没完成"这个状态里，而入口只有 10Mbps —— 课堂等不起。
 *
 * 现在拆成两段：上游出片 → 立刻建**占位行**（对外地址固定）→ 后台队列把字节搬进同一行。
 * 这条守卫钉住这七件事（任何一件破了，学生就会看到坏图/坏视频）：
 *   ① 结算时拿到的是**稳定的代理地址**（不是上游临时地址）；
 *   ② 占位行：storage_kind 仍是 INTERNAL_PROXY、storage_key 为空、archive.state=PENDING；
 *   ③ 归档没落地时，下载路由**302 到上游**，并把这行提到队首（priority=true）；
 *   ④ 后台队列真的把字节填进**同一行**（storage_key 有值、state=ARCHIVED、大小对）；
 *   ⑤ 归档完之后，同一个地址不再 302 到上游（改成走我们自己的存储）；
 *   ⑥ 卡在 ARCHIVING 的行能在启动时被收回（进程被杀留下的）；
 *   ⑦ 坏地址按次数重试，到上限标 FAILED（不会无限占队列）。
 *
 * 跑法：node scripts/p196-archive-decouple.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p196-archive-decouple-'));
const dbPath = path.join(temp, 'platform.db');
const uploadRoot = path.join(temp, 'uploads');
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;
process.env.FILE_UPLOAD_ROOT = uploadRoot;
process.env.FILE_STORAGE = 'local';
process.env.DEPLOYMENT_MODE = 'local-mock';
process.env.AI_ARCHIVE_CONCURRENCY = '3';
process.env.AI_ARCHIVE_MAX_ATTEMPTS = '3';
// 下载侧等待归档的上限：生产默认 30 秒，这里压到 8 秒让用例跑得快
process.env.ARCHIVE_DOWNLOAD_WAIT_MS = '8000';

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (error) { failures += 1; console.error(`  ✗ ${label} —— ${error.message}`); }
};

const run = (args, label) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => (code ? reject(new Error(`${label} 失败：\n${err || out}`)) : resolve(out)));
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let server;
try {
  await run(['packages/database/src/db.js', '--init'], 'db --init');
  await run(['packages/database/src/seed.js'], 'seed');

  // 本地假上游：一个能返回 PNG 的 HTTP 服务（归档要真的走 fetch）
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/ok.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      res.end(PNG);
      return;
    }
    // 慢一点的上游：用来把"归档正在搬（ARCHIVING）"这个窗口撑开，复现生产那 3 秒
    if (req.url.startsWith('/slow.png')) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
        res.end(PNG);
      }, 600);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${server.address().port}/ok.png`;
  const slowUpstream = `http://127.0.0.1:${server.address().port}/slow.png`;
  // 一个确定连不上的地址（本机一个没监听的端口）
  const deadUpstream = 'http://127.0.0.1:9/never.png';

  const { arow, aq } = await import('../packages/database/src/store.js');
  const { stageGeneratedAssets, drainArchiveQueue, awaitArchiveIdle, recoverStaleClaims } = await import('../apps/server/src/services/generatedAssetArchiveQueue.js');
  const { prepareFileDownload, prepareWorkImage, prepareFilePreview } = await import('../apps/server/src/routes/fileAssets.js');

  const student = await arow("SELECT id, org_id FROM users WHERE login='student-1'");
  assert.ok(student, '种子库里没有 student-1');

  const ctx = { req: { headers: {} }, auth: null };
  const rowOf = (id) => arow('SELECT * FROM file_assets WHERE id=?', [id]);
  const metaOf = async (id) => JSON.parse((await rowOf(id))?.metadata || '{}');
  const fileIdOf = (url) => String(url || '').match(/file-assets\/(file_[\w-]+)\/download/)?.[1] || '';

  let staged = null;
  let fileId = '';

  await check('① 结算拿到的是稳定代理地址（不是上游临时地址）', async () => {
    staged = await stageGeneratedAssets(
      [{ assetUrl: upstream, previewUrl: upstream, mimeType: 'image/png', label: '画面 1' }],
      { modality: 'IMAGE', jobId: 'job_p196', ownerUserId: student.id, ownerOrgId: student.org_id },
    );
    assert.match(staged[0].assetUrl, /^\/api\/student\/file-assets\/file_[\w-]+\/download$/, staged[0].assetUrl);
    // previewUrl 与 assetUrl 是同一个上游地址时一起改写（读面靠它出缩略图）
    assert.equal(staged[0].previewUrl, staged[0].assetUrl);
    fileId = fileIdOf(staged[0].assetUrl);
    assert.ok(fileId, '地址里没有 fileId');
  });

  await check('② 占位行：仍走 INTERNAL_PROXY、storage_key 为空、state=PENDING', async () => {
    const row = await rowOf(fileId);
    assert.equal(row.storage_kind, 'INTERNAL_PROXY');
    assert.equal(String(row.storage_key || ''), '');
    const meta = await metaOf(fileId);
    assert.equal(meta.archive?.state, 'PENDING');
    assert.equal(meta.archive?.sourceUrl, upstream);
  });

  await check('③ 归档没落地时，下载请求**等服务端搬完**再给（不把浏览器甩到上游 CDN）', async () => {
    // 2026-11-02 修正：第一版是"直接 302 到上游"，但上游 CDN 从国内网络时通时不通
    // （实测同一地址连打三次：超时 20s、超时 20s、1.5s 才成功），画布刚生成完的图就成了破图，
    // 刷新一下（这时已归档、走 OSS）才好。现在改成有界等待。
    const result = await prepareFileDownload(ctx, await rowOf(fileId));
    assert.notEqual(String(result.redirectUrl || ''), upstream, '还是 302 到上游了（破图的根源）');
    assert.ok(result.stream || result.redirectUrl, '既没有本地流也没有跳转地址');
    const meta = await metaOf(fileId);
    assert.equal(meta.archive?.state, 'ARCHIVED', '等待期间没有真的去归档');
    assert.equal(meta.archive?.priority, true, '没有把该行提到队首');
  });

  await check('③b 作品图与预览在待归档窗口也**不 404**（同一个窗口、同一套等待）', async () => {
    // 作品广场/学生主页的作品图走 prepareWorkImage、素材预览走 prepareFilePreview，
    // 两者原来在 storage_key 为空时直接 FILE_STORAGE_NOT_FOUND —— 学生生成完立刻发布就是一片坏图。
    const staged2 = await stageGeneratedAssets(
      [{ assetUrl: upstream, mimeType: 'image/png' }],
      { modality: 'IMAGE', jobId: 'job_p196_preview', ownerUserId: student.id, ownerOrgId: student.org_id },
    );
    const previewId = fileIdOf(staged2[0].assetUrl);
    assert.equal((await metaOf(previewId)).archive?.state, 'PENDING');
    const image = await prepareWorkImage(ctx, await rowOf(previewId));
    assert.ok(image && (image.stream || image.redirectUrl), '作品图没拿到字节');
    const preview = await prepareFilePreview(ctx, await rowOf(previewId));
    assert.ok(preview && (preview.stream || preview.redirectUrl), '预览没拿到字节');
    assert.equal((await metaOf(previewId)).archive?.state, 'ARCHIVED');
  });

  await check('③c ⭐ 归档**正在搬**（ARCHIVING）时也不 404 —— 生产就是死在这 3 秒里', async () => {
    // 2026-11-02 生产实证：产物建好 0.56 秒后队列就认领了（PENDING→ARCHIVING），
    // 3.7 秒后归档完成。学生点开正好落在 ARCHIVING 这个窗口 —— 而第一版的判断只认 PENDING，
    // 于是掉到本地分支报 FILE_STORAGE_NOT_FOUND（404），表现就是"刚生成完是破图、刷新才好"。
    const staged3 = await stageGeneratedAssets(
      [{ assetUrl: slowUpstream, mimeType: 'image/png' }],
      { modality: 'IMAGE', jobId: 'job_p196_archiving', ownerUserId: student.id, ownerOrgId: student.org_id },
    );
    const archivingId = fileIdOf(staged3[0].assetUrl);
    drainArchiveQueue();                       // 认领（不 await 它跑完）
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal((await metaOf(archivingId)).archive?.state, 'ARCHIVING', '没进入 ARCHIVING 窗口，这条用例失去意义');
    const result = await prepareFileDownload(ctx, await rowOf(archivingId));
    assert.notEqual(String(result.redirectUrl || ''), slowUpstream, '又退回上游了（ARCHIVING 没被当成待归档）');
    assert.ok(result.stream || result.redirectUrl, '既没有本地流也没有跳转地址');
    assert.equal((await metaOf(archivingId)).archive?.state, 'ARCHIVED');
  });

  await check('④ 后台队列把字节填进同一行（storage_key 有值、ARCHIVED、大小对）', async () => {
    await drainArchiveQueue();
    assert.ok(await awaitArchiveIdle({ timeoutMs: 20000 }), '归档一直没结束');
    const row = await rowOf(fileId);
    const meta = await metaOf(fileId);
    assert.ok(String(row.storage_key || '').length > 0, 'storage_key 还是空的');
    assert.equal(meta.archive?.state, 'ARCHIVED');
    assert.equal(Number(row.file_size), PNG.length);
    assert.equal(row.mime_type, 'image/png');
  });

  await check('⑤ 归档完之后，同一个地址不再 302 到上游', async () => {
    const result = await prepareFileDownload(ctx, await rowOf(fileId));
    // ⚠️ 不能用 `__fileResponse` 判：本地存储分支**也**返回 `__fileResponse: true`（带 stream、不带 redirectUrl）。
    //    判据是"跳没跳到上游"。
    assert.notEqual(String(result.redirectUrl || ''), upstream, '还在往上游跳（归档白做了）');
    assert.ok(result.stream || result.redirectUrl, '既没有本地流也没有跳转地址');
  });

  await check('⑥ 卡在 ARCHIVING 的行会在启动时被收回 PENDING', async () => {
    const meta = await metaOf(fileId);
    await aq('UPDATE file_assets SET storage_key=NULL, metadata=? WHERE id=?', [
      JSON.stringify({ ...meta, archive: { ...meta.archive, state: 'ARCHIVING' } }), fileId,
    ]);
    const recovered = await recoverStaleClaims();
    assert.ok(recovered >= 1, `一条都没收回（${recovered}）`);
    assert.equal((await metaOf(fileId)).archive?.state, 'PENDING');
  });

  await check('⑦ 坏地址按次数重试，到上限标 FAILED（不无限占队列）', async () => {
    const bad = await stageGeneratedAssets(
      [{ assetUrl: deadUpstream, mimeType: 'image/png' }],
      { modality: 'IMAGE', jobId: 'job_p196_bad', ownerUserId: student.id, ownerOrgId: student.org_id },
    );
    const badId = fileIdOf(bad[0].assetUrl);
    for (let round = 1; round <= 3; round += 1) {
      await drainArchiveQueue();
      await awaitArchiveIdle({ timeoutMs: 20000 });
      const meta = await metaOf(badId);
      const attempts = Number(meta.archive?.attempts || 0);
      assert.equal(attempts, round, `第 ${round} 轮后 attempts=${attempts}`);
      if (round < 3) assert.equal(meta.archive?.state, 'PENDING', `第 ${round} 轮不该放弃`);
      else assert.equal(meta.archive?.state, 'FAILED', '到上限了还停在 PENDING（会无限重试）');
    }
    // 最后的保底：连一次都搬不回来时，下载仍然给上游地址（总比 404 好），但这是**异常路径**
    const fallback = await prepareFileDownload(ctx, await rowOf(badId));
    assert.equal(fallback.status, 302, '归档彻底失败后连保底跳转都没了');
    assert.equal(fallback.redirectUrl, deadUpstream);
  });

  await check('⑧ 非 http(s) 产物原样返回（data:/mock: 本来就在我们库里）', async () => {
    const kept = await stageGeneratedAssets([{ assetUrl: 'mock://generation/x', mimeType: 'text/plain' }], { modality: 'TEXT', jobId: 'job_p196_text' });
    assert.equal(kept[0].assetUrl, 'mock://generation/x');
  });
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
}

assert.equal(failures, 0, `P196 有 ${failures} 条断言没过`);
console.log('PASS: 归档与任务完成解耦（占位行 + 后台队列 + 失败重试 + 中断收回）');
