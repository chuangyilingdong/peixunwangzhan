/**
 * 内容工作台 · 视频一键托管（2026-10-26 二十一期）。
 *
 * 托管只做三件事：
 *   1. 免费准备：写口播稿/编导稿、校验音色形象、算分段和费用；
 *   2. 停在确认页：不创建渲染行、不创建数字人任务、不扣费；
 *   3. 确认成功后才提交付费步骤，成片完成后自动生成默认发布包。
 *
 * 状态存 video_works.auto_host（JSON 文本），不新增任务表：
 * AUTO_HOST_STAGE 的 preparing/awaiting_confirmation 由免费步骤维护，
 * submitted 由 confirm 维护，packaging/ready/failed 由发布包维护。
 */
import { aq, arow, nowIso } from '../lib.js';

const STAGES = new Set(['idle', 'preparing', 'awaiting_confirmation', 'submitted', 'packaging', 'ready', 'failed']);

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function parseAutoHost(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw || '{}'); } catch { data = {}; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  const enabled = data.enabled === true;
  const stage = STAGES.has(String(data.stage || '')) ? String(data.stage) : (enabled ? 'preparing' : 'idle');
  return {
    enabled,
    autoPackage: data.autoPackage !== false,
    stage,
    topic: clean(data.topic, 500),
    startedAt: clean(data.startedAt, 64),
    confirmedAt: clean(data.confirmedAt, 64),
    packagedAt: clean(data.packagedAt, 64),
    error: clean(data.error, 1000),
    updatedAt: clean(data.updatedAt, 64),
  };
}

export function newAutoHost({ topic = '', autoPackage = true } = {}) {
  const at = nowIso();
  return {
    enabled: true,
    autoPackage,
    stage: 'preparing',
    topic: clean(topic, 500),
    startedAt: at,
    confirmedAt: '',
    packagedAt: '',
    error: '',
    updatedAt: at,
  };
}

/**
 * 只更新已经托管的视频任务。手动任务不会因为异步回调被意外变成托管。
 * 读-合并-写在同一 owner 范围内完成；托管状态只影响 UI 和自动打包，不参与计费。
 */
export async function patchAutoHost(ownerKey, workId, patch = {}) {
  if (!ownerKey || !workId) return null;
  const row = await arow('SELECT auto_host FROM junshi_workbench_video_works WHERE id=? AND owner_key=?', [workId, ownerKey]).catch(() => null);
  if (!row) return null;
  const current = parseAutoHost(row.auto_host);
  if (!current.enabled && patch.enabled !== true) return current;
  const merged = parseAutoHost(JSON.stringify({
    ...current,
    ...patch,
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
    updatedAt: nowIso(),
  }));
  await aq('UPDATE junshi_workbench_video_works SET auto_host=?, updated_at=? WHERE id=? AND owner_key=?',
    [JSON.stringify(merged), nowIso(), workId, ownerKey]);
  return merged;
}
