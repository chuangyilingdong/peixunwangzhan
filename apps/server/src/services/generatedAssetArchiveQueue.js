/**
 * 生成产物的**归档队列**（2026-11-01，B2 解耦）。
 *
 * 解决的是什么：原来"任务完成"的条件里包含"20MB 已经存进 OSS"。
 *   1000 路并行时，这 20GB 全部挤在"任务还没完成"这个状态里，而入口只有 10Mbps ——
 *   于是每一条 H3 的完成时间都被带宽拖住，课堂等不起。
 *
 * 现在分两段：
 *   ① 上游出片 → 立刻建一条**占位行**（`file_assets`，storage_key 为空，
 *      `metadata.archive.state='PENDING'`）并结算任务。对外地址这一刻就固定了。
 *   ② 本队列在后台按并发上限把字节搬进那**同一行**，填上 storage_key。
 *
 * 三条设计约束：
 *   · **并发必须限住**：这里限的是"同时下载几份"，不是"同时生成几条"。
 *     生成侧是纯 I/O 等待（可以开很大），归档侧受入口带宽约束（只能开很小）。
 *   · **学生要看就先给他看**：下载路由发现 PENDING 会把该行 `archive.priority` 置 true 并
 *     直接 302 到上游；本队列优先处理 priority 的、再按最老的先来。
 *   · **上游地址会过期**（实测 ≥81 小时，见 docs/operations/方案-并发问题再评估-20261101.md），
 *     所以有 `archive_deadline`：超过 `AI_ARCHIVE_DEADLINE_MS`（默认 24 小时）未归档的，
 *     即使没人点也提到队首 —— 24 小时对 81 小时的下界留了 3 倍余量。
 *
 * ⚠️ 认领是**数据库条件更新**（PENDING → ARCHIVING），不是内存标记：
 *    多进程/重启后都不会两个 worker 抢同一条。
 * ⚠️ 失败重试有上限（默认 3 次），超过后 state=FAILED —— 读面仍然会 302 到上游（尽力而为），
 *    但不再占队列。运营在日志里能按 `[归档]` 前缀看到全过程。
 *
 * 2026-11-11：取件从 `metadata LIKE '%"state":"PENDING"%'` 改成 **archive_state 列 + 索引**
 * （`(archive_state, archive_priority, created_at)`）。metadata.archive 仍是读面/排障的真相，
 * 列只是索引副本；迁移 55（MySQL）/ schema.js 的 ALTER（SQLite）负责建列，启动时
 * `ensureArchiveColumns()` 把老数据回填一次。列不存在时自动退回旧的 metadata 扫描。
 */
import { aq, arow, arows, json, parseJson, nowIso } from '../lib.js';
import { archiveIntoExistingAsset, archiveOneGeneratedAsset } from './generatedAssetArchive.js';
import { createPendingGeneratedAsset } from '../routes/fileAssets.js';

function positiveInt(raw, fallback, max) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}

/** 同时下载几份。⚠️ 按入口带宽定，不要按 CPU 定：4 份 × 20MB 在 10Mbps 下也要约 64 秒。 */
export const ARCHIVE_CONCURRENCY = positiveInt(process.env.AI_ARCHIVE_CONCURRENCY, 3, 16);
const MAX_ATTEMPTS = positiveInt(process.env.AI_ARCHIVE_MAX_ATTEMPTS, 3, 10);
const DEADLINE_MS = positiveInt(process.env.AI_ARCHIVE_DEADLINE_MS, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
// ⚠️ 2026-11-02：默认从 10 秒缩到 2 秒。学生点开产物的那一刻会**等我们归档完**再发
// （见 routes/fileAssets.js 的 ARCHIVE_WAIT_MS），10 秒的空转窗口会让"刚生成完的图"
// 多等一整个 tick。2 秒一轮是一次索引查询，代价可以忽略。
const TICK_MS = positiveInt(process.env.AI_ARCHIVE_TICK_MS, 2000, 60000);
/** 失败多久之后放回队列重试；以及最多重试多少轮（每轮 3 次）。 */
const RETRY_AFTER_MS = positiveInt(process.env.AI_ARCHIVE_RETRY_AFTER_MS, 60 * 60 * 1000, 24 * 60 * 60 * 1000);
const MAX_RETRY_ROUNDS = positiveInt(process.env.AI_ARCHIVE_MAX_RETRY_ROUNDS, 24, 200);
/** 单次取多少条来挑（按 priority/最老排序在这一批里做，不依赖 JSON 的 SQL 排序）。 */
const BATCH = 40;

const state = { active: 0, started: false, done: 0, failed: 0, lastError: '' };
// 索引列是否可用（迁移 55 / schema.js 的 ALTER 是否已经跑过）。
// false 时退回旧的 metadata LIKE 扫描 —— 迁移没跑也不会让归档停摆。
let archiveColumnsReady = false;

/**
 * 老数据回填：把 file_assets.metadata.archive 里的 state/priority/attempts 写进索引列。
 * 幂等，只处理还没写过索引列的未归档行；迁移 55 在 MySQL 侧做同一件事，这里是 SQLite /
 * 迁移漏跑 / 回滚后的兜底。
 */
export async function ensureArchiveColumns() {
  if (archiveColumnsReady) return true;
  try {
    const rows = await arows(
      "SELECT id, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND storage_key IS NULL AND status='ACTIVE' AND archive_state IS NULL LIMIT 5000",
    );
    for (const row of rows) {
      const archive = parseJson(row.metadata, {})?.archive || {};
      const stateName = String(archive.state || '').toUpperCase();
      if (!['PENDING', 'ARCHIVING', 'FAILED'].includes(stateName)) continue;
      await aq(
        'UPDATE file_assets SET archive_state=?, archive_priority=?, archive_attempts=?, archive_next_attempt_at=NULL, updated_at=? WHERE id=?',
        [stateName, archive.priority === true ? 1 : 0, Number(archive.attempts || 0), nowIso(), row.id],
      ).catch(() => {});
    }
    archiveColumnsReady = true;
  } catch {
    // 列不存在（迁移 55 没跑）→ 继续用 metadata 扫描。
    archiveColumnsReady = false;
  }
  return archiveColumnsReady;
}

export function archiveQueueState() {
  return { ...state, concurrency: ARCHIVE_CONCURRENCY, deadlineMs: DEADLINE_MS, indexed: archiveColumnsReady };
}

/**
 * 结算时用：把这批产物换成**占位行**，立刻返回可以落库的载荷。
 *
 * 只处理 http(s) 地址（`data:` / `mock:` 之类本来就在我们库里，原样返回）。
 * 任何一条建行失败都**不抛**：退回原来的阻塞归档 —— 生意不能因为占位行挂掉就整条失败。
 */
export async function stageGeneratedAssets(assetPayloads, { modality, jobId, ownerUserId, ownerOrgId } = {}) {
  const list = Array.isArray(assetPayloads) ? assetPayloads : [];
  if (!list.length) return list;
  return Promise.all(list.map(async (asset) => {
    const payload = asset && typeof asset === 'object' ? asset : {};
    const source = String(payload.assetUrl || payload.previewUrl || '').trim();
    if (!/^https?:\/\//i.test(source)) return payload;
    try {
      const declaredMime = String(payload.mimeType || '').toLowerCase().split(';', 1)[0].trim();
      const extension = declaredMime === 'video/mp4' ? '.mp4'
        : declaredMime === 'video/webm' ? '.webm'
          : declaredMime === 'image/png' ? '.png'
            : declaredMime === 'image/jpeg' ? '.jpg'
              : declaredMime === 'image/webp' ? '.webp'
                : declaredMime === 'image/gif' ? '.gif'
                  : declaredMime === 'audio/mpeg' ? '.mp3'
                    : declaredMime === 'audio/wav' || declaredMime === 'audio/x-wav' ? '.wav'
                      : declaredMime === 'audio/ogg' ? '.ogg' : '.bin';
      const created = await createPendingGeneratedAsset({
        sourceUrl: source,
        modality,
        jobId,
        ownerUserId,
        ownerOrgId,
        fileName: `${String(modality || 'asset').toLowerCase()}-${jobId || 'job'}${extension}`,
        declaredMime,
        metadata: { source: 'generated-asset-pending', modality: String(modality || '').toUpperCase(), jobId: jobId || null, upstreamUrl: source },
      });
      const next = { ...payload, assetUrl: created.url, metadata: { ...(payload.metadata || {}), archive: { state: 'PENDING', sourceUrl: source, fileId: created.id } } };
      // previewUrl 与 assetUrl 是同一个上游地址时才一起改写（同 archiveGeneratedAssets 的口径）
      if (String(payload.previewUrl || '').trim() === source) next.previewUrl = created.url;
      return next;
    } catch (error) {
      // 建行都失败（库挂了/约束问题）→ 这一条退回**同步归档**：宁可让这一次任务慢一点，
      // 也不要留下一个永远没人处理的裸上游地址。
      console.warn(`[归档] 建占位行失败，这一条退回同步归档：${String(error?.message || error).slice(0, 120)}`);
      const fallback = await archiveOneGeneratedAsset({ assetUrl: source, modality, jobId, ownerUserId, ownerOrgId });
      if (!fallback.ok) return payload;
      const next = { ...payload, assetUrl: fallback.url, mimeType: fallback.mimeType || payload.mimeType,
        metadata: { ...(payload.metadata || {}), archive: { mirrored: true, sourceUrl: source, mimeType: fallback.mimeType, bytes: fallback.bytes } } };
      if (String(payload.previewUrl || '').trim() === source) next.previewUrl = fallback.url;
      return next;
    }
  }));
}

/** 取一批候选：优先"学生已经要看"的，其次最老的（= 最早到期的）。 */
async function pickCandidates(limit) {
  if (await ensureArchiveColumns()) {
    // 迁移 55 的索引列：只扫“未归档”的几行，按 priority 再按先来后到。
    return await arows(
      "SELECT id, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND archive_state='PENDING' AND status='ACTIVE' AND storage_key IS NULL AND (archive_next_attempt_at IS NULL OR archive_next_attempt_at<=?) ORDER BY archive_priority DESC, created_at ASC LIMIT ?",
      [nowIso(), limit],
    ).catch(() => []);
  }
  // 兜底（迁移 55 没跑）：保留原来的 metadata 扫描。注意只查 storage_key IS NULL，
  // 历史空串由迁移 54 归一化；这个分支只在列不存在时才会走到。
  const priority = await arows(
    "SELECT id, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND storage_key IS NULL AND status='ACTIVE' AND metadata LIKE '%\"priority\":true%' AND metadata LIKE '%\"state\":\"PENDING\"%' ORDER BY created_at ASC LIMIT ?",
    [limit],
  ).catch(() => []);
  const rest = await arows(
    "SELECT id, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND storage_key IS NULL AND status='ACTIVE' AND metadata LIKE '%\"state\":\"PENDING\"%' ORDER BY created_at ASC LIMIT ?",
    [limit],
  ).catch(() => []);
  const seen = new Set();
  const merged = [];
  for (const row of [...priority, ...rest]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged.slice(0, limit);
}

/**
 * 认领一条：PENDING → ARCHIVING（条件更新，改到行数为准）。
 * 返回认领后的 metadata；没抢到返回 null。
 */
async function claim(fileId, meta) {
  const now = new Date().toISOString();
  const archive = { ...(meta.archive || {}), state: 'ARCHIVING', startedAt: now, attempts: Number(meta.archive?.attempts || 0) + 1 };
  const next = json({ ...meta, archive });
  const claimed = await aq(
    "UPDATE file_assets SET metadata=?, updated_at=? WHERE id=? AND storage_key IS NULL AND metadata LIKE '%\"state\":\"PENDING\"%'",
    [next, now, fileId],
  );
  if (!Number(claimed?.changes || 0)) return null;
  // 索引列同步（列不存在时由 catch 兜住；metadata 仍是真相）。
  await aq(
    "UPDATE file_assets SET archive_state='ARCHIVING', archive_attempts=archive_attempts+1, archive_next_attempt_at=NULL WHERE id=? AND (archive_state='PENDING' OR archive_state IS NULL)",
    [fileId],
  ).catch(() => {});
  return { ...meta, archive };
}

/** 把一条放回队列（失败重试）或标记 FAILED（超过重试上限）。 */
async function releaseOrFail(fileId, meta, reason) {
  const archive = meta.archive || {};
  const attempts = Number(archive.attempts || 0);
  const exhausted = attempts >= MAX_ATTEMPTS;
  const next = json({ ...meta, archive: { ...archive, state: exhausted ? 'FAILED' : 'PENDING', lastError: String(reason || '').slice(0, 200), lastAttemptAt: new Date().toISOString() } });
  const now = new Date().toISOString();
  await aq('UPDATE file_assets SET metadata=?, updated_at=? WHERE id=?', [next, now, fileId]).catch(() => {});
  await aq(
    'UPDATE file_assets SET archive_state=?, archive_attempts=?, archive_next_attempt_at=NULL, updated_at=? WHERE id=?',
    [exhausted ? 'FAILED' : 'PENDING', attempts, now, fileId],
  ).catch(() => {});
  if (exhausted) state.failed += 1;
  console.warn(`[归档] ${exhausted ? '放弃' : '稍后重试'} file=${fileId}（第 ${attempts} 次）：${String(reason || '').slice(0, 160)}`);
}

/** 归档一条（已认领后调用）。 */
async function archiveOne(fileId, meta) {
  const archive = meta.archive || {};
  const result = await archiveIntoExistingAsset({ fileId, assetUrl: archive.sourceUrl, modality: archive.modality, jobId: archive.jobId });
  if (result.ok) {
    state.done += 1;
    // replaceGeneratedAssetFromFile 会把 metadata.archive.state 改成 ARCHIVED；这里同步索引列，
    // 让队列下一次查询立刻不再看到它（列不存在时忽略）。
    await aq("UPDATE file_assets SET archive_state='ARCHIVED', archive_next_attempt_at=NULL WHERE id=?", [fileId]).catch(() => {});
    return;
  }
  await releaseOrFail(fileId, meta, result.reason);
}

/** 跑一轮：补满并发。返回这一轮启动了几条。 */
export async function drainArchiveQueue() {
  const free = ARCHIVE_CONCURRENCY - state.active;
  if (free <= 0) return 0;
  const candidates = await pickCandidates(Math.min(BATCH, free * 4));
  let started = 0;
  for (const row of candidates) {
    if (state.active >= ARCHIVE_CONCURRENCY) break;
    const meta = parseJson(row.metadata, {}) || {};
    if (meta.archive?.state !== 'PENDING') {
      // 索引列与 metadata 漂移（手工改库/旧代码写入）：把列同步成 metadata 的真实状态，
      // 否则这一行会每 2 秒被捞出来、又每 2 秒被跳过，永远占着扫描窗口。
      const actual = String(meta.archive?.state || '').toUpperCase();
      if (['ARCHIVING', 'FAILED', 'ARCHIVED'].includes(actual)) {
        await aq('UPDATE file_assets SET archive_state=? WHERE id=?', [actual, row.id]).catch(() => {});
      }
      continue;
    }
    // 到期提升：超过 deadline 还没归档的，日志里点名（排序已在 pickCandidates 按 created_at 兜住）
    const queuedAt = Date.parse(meta.archive?.queuedAt || '') || 0;
    if (queuedAt && Date.now() - queuedAt > DEADLINE_MS) {
      console.warn(`[归档] 已超过 ${Math.round(DEADLINE_MS / 3600000)} 小时仍未归档：file=${row.id}`);
    }
    const claimedMeta = await claim(row.id, meta);
    if (!claimedMeta) continue;
    state.active += 1;
    started += 1;
    archiveOne(row.id, claimedMeta)
      .catch((error) => { state.lastError = String(error?.message || error).slice(0, 200); })
      .finally(() => { state.active -= 1; });
  }
  return started;
}

let timer = null;
let lastSweepAt = 0;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

/**
 * 启动后台归档循环。**幂等**：重复调用只会有一个定时器。
 * ⚠️ 失败不致命：整轮抛错只记 lastError，下一轮继续 —— 归档是尽力而为的事。
 */
export function startGeneratedAssetArchiveWorker() {
  if (state.started) return archiveQueueState();
  state.started = true;
  // 索引列/老数据回填是异步的；pickCandidates 自己也会 await ensureArchiveColumns()。
  ensureArchiveColumns()
    .then((ok) => console.log(`[归档] 取件索引列${ok ? '已就绪' : '不可用（迁移 55 没跑？）→ 退回 metadata 扫描'}`))
    .catch(() => {});
  console.log(`[归档] 后台归档队列启动：并发 ${ARCHIVE_CONCURRENCY} 路，截止 ${Math.round(DEADLINE_MS / 3600000)} 小时`);
  const tick = () => {
    drainArchiveQueue().catch((error) => {
      state.lastError = String(error?.message || error).slice(0, 200);
      console.warn('[归档] 本轮出错：', state.lastError);
    });
    // 每 10 分钟扫一次"失败过一小时"的行，放回队列（不阻塞收件）
    if (Date.now() - lastSweepAt > SWEEP_EVERY_MS) {
      lastSweepAt = Date.now();
      requeueStaleFailures().catch(() => {});
    }
  };
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  return archiveQueueState();
}

/** 关服时清定时器（在飞的下载由进程退出自然结束，行会停在 ARCHIVING —— 启动时由 recoverStaleClaims 收回）。 */
export function stopGeneratedAssetArchiveWorker() {
  if (timer) { clearInterval(timer); timer = null; }
  state.started = false;
}

/**
 * 启动时把**卡在 ARCHIVING** 的行放回 PENDING。
 *
 * 为什么需要：进程被杀（发布重启 / OOM）时，正在下载的那几条会永远停在 ARCHIVING，
 * 而认领条件只认 PENDING —— 不收回的话它们就再也没人处理，学生一直拿上游地址。
 */
export async function recoverStaleClaims() {
  await ensureArchiveColumns();
  const rows = archiveColumnsReady
    ? await arows(
      "SELECT id, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND storage_key IS NULL AND status='ACTIVE' AND (archive_state='ARCHIVING' OR metadata LIKE '%\"state\":\"ARCHIVING\"%') LIMIT 200",
    ).catch(() => [])
    : await arows(
      "SELECT id, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND storage_key IS NULL AND status='ACTIVE' AND metadata LIKE '%\"state\":\"ARCHIVING\"%' LIMIT 200",
    ).catch(() => []);
  let recovered = 0;
  for (const row of rows) {
    const meta = parseJson(row.metadata, {}) || {};
    if (meta.archive?.state !== 'ARCHIVING') continue;
    const now = new Date().toISOString();
    await aq('UPDATE file_assets SET metadata=?, updated_at=? WHERE id=?', [
      json({ ...meta, archive: { ...meta.archive, state: 'PENDING' } }), now, row.id,
    ]).catch(() => {});
    await aq("UPDATE file_assets SET archive_state='PENDING', archive_next_attempt_at=NULL, updated_at=? WHERE id=?", [now, row.id]).catch(() => {});
    recovered += 1;
  }
  if (recovered) console.warn(`[归档] 收回了 ${recovered} 条上次被中断的归档任务`);
  return recovered;
}

/**
 * 把**失败过一段时间**的行放回队列重试（2026-11-02）。
 *
 * 为什么需要：`releaseOrFail` 在 3 次失败后标 FAILED 就不再碰它 —— 一条上游抖一下，
 * 这条产物就永远停在上游地址上（而那个地址活不过 81 小时）。这里每小时扫一次，
 * 把 FAILED 且 `updated_at` 超过 `AI_ARCHIVE_RETRY_AFTER_MS`（默认 1 小时）的重新排队，
 * 并把 `attempts` 归零（给新的 3 次机会），用 `retryRounds` 记住总轮数封顶，避免无限折腾。
 */
export async function requeueStaleFailures() {
  await ensureArchiveColumns();
  const cutoff = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
  const rows = archiveColumnsReady
    ? await arows(
      "SELECT id, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND storage_key IS NULL AND status='ACTIVE' AND (archive_state='FAILED' OR metadata LIKE '%\"state\":\"FAILED\"%') AND updated_at < ? LIMIT 50",
      [cutoff],
    ).catch(() => [])
    : await arows(
      "SELECT id, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND storage_key IS NULL AND status='ACTIVE' AND metadata LIKE '%\"state\":\"FAILED\"%' AND updated_at < ? LIMIT 50",
      [cutoff],
    ).catch(() => []);
  let requeued = 0;
  for (const row of rows) {
    const meta = parseJson(row.metadata, {}) || {};
    const archive = meta.archive || {};
    if (archive.state !== 'FAILED') continue;
    const rounds = Number(archive.retryRounds || 0);
    if (rounds >= MAX_RETRY_ROUNDS) continue;
    const now = new Date().toISOString();
    await aq('UPDATE file_assets SET metadata=?, updated_at=? WHERE id=?', [
      json({ ...meta, archive: { ...archive, state: 'PENDING', attempts: 0, retryRounds: rounds + 1, priority: false, requeuedAt: now } }),
      now, row.id,
    ]).catch(() => {});
    await aq(
      "UPDATE file_assets SET archive_state='PENDING', archive_priority=0, archive_attempts=0, archive_next_attempt_at=NULL, updated_at=? WHERE id=?",
      [now, row.id],
    ).catch(() => {});
    requeued += 1;
  }
  if (requeued) console.warn(`[归档] 把 ${requeued} 条之前失败的重新排队（第 N 轮，最多 ${MAX_RETRY_ROUNDS} 轮）`);
  return requeued;
}

/** 诊断用：还有多少条没归档。 */
export async function pendingArchiveCount() {
  await ensureArchiveColumns();
  const row = archiveColumnsReady
    ? await arow(
      "SELECT COUNT(*) AS n FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND archive_state IN ('PENDING','ARCHIVING') AND storage_key IS NULL AND status='ACTIVE'",
    ).catch(() => null)
    : await arow(
      "SELECT COUNT(*) AS n FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND storage_key IS NULL AND status='ACTIVE' AND metadata LIKE '%\"state\":\"PENDING\"%'",
    ).catch(() => null);
  return Number(row?.n || 0);
}

/** 等到"当前没有在飞的归档"。守卫与运维脚本用（生产不用轮询它，循环自己跑）。 */
export async function awaitArchiveIdle({ timeoutMs = 30000 } = {}) {
  const startedAt = Date.now();
  while (state.active > 0) {
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}
