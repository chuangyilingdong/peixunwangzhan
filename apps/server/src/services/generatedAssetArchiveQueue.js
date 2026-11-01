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
 */
import { aq, arow, arows, json, parseJson } from '../lib.js';
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
const TICK_MS = positiveInt(process.env.AI_ARCHIVE_TICK_MS, 10000, 60000);
/** 单次取多少条来挑（按 priority/最老排序在这一批里做，不依赖 JSON 的 SQL 排序）。 */
const BATCH = 40;

const state = { active: 0, started: false, done: 0, failed: 0, lastError: '' };

export function archiveQueueState() {
  return { ...state, concurrency: ARCHIVE_CONCURRENCY, deadlineMs: DEADLINE_MS };
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
  const priority = await arows(
    "SELECT id, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND (storage_key IS NULL OR storage_key='') AND status='ACTIVE' AND metadata LIKE '%\"priority\":true%' AND metadata LIKE '%\"state\":\"PENDING\"%' ORDER BY created_at ASC LIMIT ?",
    [limit],
  ).catch(() => []);
  const rest = await arows(
    "SELECT id, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND (storage_key IS NULL OR storage_key='') AND status='ACTIVE' AND metadata LIKE '%\"state\":\"PENDING\"%' ORDER BY created_at ASC LIMIT ?",
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
    "UPDATE file_assets SET metadata=?, updated_at=? WHERE id=? AND (storage_key IS NULL OR storage_key='') AND metadata LIKE '%\"state\":\"PENDING\"%'",
    [next, now, fileId],
  );
  return Number(claimed?.changes || 0) > 0 ? { ...meta, archive } : null;
}

/** 把一条放回队列（失败重试）或标记 FAILED（超过重试上限）。 */
async function releaseOrFail(fileId, meta, reason) {
  const archive = meta.archive || {};
  const attempts = Number(archive.attempts || 0);
  const exhausted = attempts >= MAX_ATTEMPTS;
  const next = json({ ...meta, archive: { ...archive, state: exhausted ? 'FAILED' : 'PENDING', lastError: String(reason || '').slice(0, 200), lastAttemptAt: new Date().toISOString() } });
  await aq('UPDATE file_assets SET metadata=?, updated_at=? WHERE id=?', [next, new Date().toISOString(), fileId]).catch(() => {});
  if (exhausted) state.failed += 1;
  console.warn(`[归档] ${exhausted ? '放弃' : '稍后重试'} file=${fileId}（第 ${attempts} 次）：${String(reason || '').slice(0, 160)}`);
}

/** 归档一条（已认领后调用）。 */
async function archiveOne(fileId, meta) {
  const archive = meta.archive || {};
  const result = await archiveIntoExistingAsset({ fileId, assetUrl: archive.sourceUrl, modality: archive.modality, jobId: archive.jobId });
  if (result.ok) { state.done += 1; return; }
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
    if (meta.archive?.state !== 'PENDING') continue;
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

/**
 * 启动后台归档循环。**幂等**：重复调用只会有一个定时器。
 * ⚠️ 失败不致命：整轮抛错只记 lastError，下一轮继续 —— 归档是尽力而为的事。
 */
export function startGeneratedAssetArchiveWorker() {
  if (state.started) return archiveQueueState();
  state.started = true;
  console.log(`[归档] 后台归档队列启动：并发 ${ARCHIVE_CONCURRENCY} 路，截止 ${Math.round(DEADLINE_MS / 3600000)} 小时`);
  const tick = () => {
    drainArchiveQueue().catch((error) => {
      state.lastError = String(error?.message || error).slice(0, 200);
      console.warn('[归档] 本轮出错：', state.lastError);
    });
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
  const rows = await arows(
    "SELECT id, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND (storage_key IS NULL OR storage_key='') AND status='ACTIVE' AND metadata LIKE '%\"state\":\"ARCHIVING\"%' LIMIT 200",
  ).catch(() => []);
  let recovered = 0;
  for (const row of rows) {
    const meta = parseJson(row.metadata, {}) || {};
    if (meta.archive?.state !== 'ARCHIVING') continue;
    await aq('UPDATE file_assets SET metadata=?, updated_at=? WHERE id=?', [
      json({ ...meta, archive: { ...meta.archive, state: 'PENDING' } }), new Date().toISOString(), row.id,
    ]).catch(() => {});
    recovered += 1;
  }
  if (recovered) console.warn(`[归档] 收回了 ${recovered} 条上次被中断的归档任务`);
  return recovered;
}

/** 诊断用：还有多少条没归档。 */
export async function pendingArchiveCount() {
  const row = await arow(
    "SELECT COUNT(*) AS n FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND (storage_key IS NULL OR storage_key='') AND status='ACTIVE' AND metadata LIKE '%\"state\":\"PENDING\"%'",
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
