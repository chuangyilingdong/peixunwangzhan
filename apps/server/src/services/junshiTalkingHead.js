/**
 * 内容工作台 · 口播成片简易模式（2026-10-26 二十期）。
 *
 * 视频任务有两种制作方式：
 *   - storyboard：编导稿 + 分镜 + 整片渲染（七/十五期）；
 *   - talking_head：口播稿 + 音色 + 形象照，直接复用数字人分段对口型链路（五/十七期）。
 *
 * 这里只放纯数据转换和“合成结果回写视频任务”，不碰上游渠道：
 * 口播配置快照存 talking_head，真实合成仍由 junshiWorkbench 的 runTalkingHead 执行。
 * 合成成功时把 avatar_run 的分段时长转成一份只读编导稿，让第 4 步包装/字幕继续复用原链路。
 */
import { aq, arow, nowIso } from '../lib.js';

const SPEEDS = new Set(['natural', 'slightly_fast', 'fast', 'extreme']);

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function parseTalkingHeadConfig(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw || '{}'); } catch { data = {}; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  return {
    text: String(data.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 3000),
    voiceId: clean(data.voiceId, 64),
    imageAssetId: clean(data.imageAssetId, 64),
    speed: SPEEDS.has(String(data.speed || '')) ? String(data.speed) : 'natural',
    voiceName: clean(data.voiceName, 60),
    imageFileName: clean(data.imageFileName, 120),
  };
}

function segmentSeconds(segment) {
  const audio = Number(segment?.audioSeconds || 0);
  const video = Number(segment?.durationSeconds || 0);
  const value = audio > 0 ? audio : video;
  return Math.max(0.5, Math.round((value + 0.12) * 1000) / 1000);
}

/**
 * 把数字人分段转成包装链路能读的“编导稿”：
 * 第 4 步的 SRT 生成按 shots[].seconds/voiceover 走，这里用真实音频时长，
 * 比按字数估算更接近成片。UI 在 talking_head 模式下不展示这份分镜。
 */
export function buildTalkingHeadDirectorScript({ title = '', text = '', segments = [], durationSeconds = 0 } = {}) {
  const done = (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment && (segment.status === 'done' || segment.text))
    .map((segment, index) => ({
      index: index + 1,
      seconds: segmentSeconds(segment),
      role: index === 0 ? 'hook' : 'proof',
      scene: '数字人口播',
      voiceover: clean(segment.text, 500),
      overlay: '',
      renderPrompt: '数字人口播（逐段对口型）',
      referenceFrameAssetId: '',
      referenceFrameTime: null,
    }))
    .filter((shot) => shot.voiceover);
  const fallback = clean(text, 500);
  const shots = done.length ? done : (fallback ? [{
    index: 1,
    seconds: Math.max(1, Number(durationSeconds) || 3),
    role: 'hook',
    scene: '数字人口播',
    voiceover: fallback,
    overlay: '',
    renderPrompt: '数字人口播（逐段对口型）',
    referenceFrameAssetId: '',
    referenceFrameTime: null,
  }] : []);
  return {
    title: clean(title, 120) || fallback.slice(0, 40) || '口播成片',
    strategy: '数字人口播 · 逐段对口型',
    notes: '',
    shots,
  };
}

/**
 * 合成结束后回写视频任务。
 * 只有 work.avatar_run_id 仍指向本次 run 时才更新，避免旧任务晚到覆盖新一轮合成。
 */
export async function syncTalkingHeadWork(owner, runId, {
  status,
  assetId = '',
  durationSeconds = 0,
  segments = [],
  text = '',
  error = '',
} = {}) {
  if (!owner?.key || !runId) return null;
  const work = await arow(
    "SELECT * FROM junshi_workbench_video_works WHERE owner_key=? AND avatar_run_id=? AND production_mode='talking_head' ORDER BY created_at DESC LIMIT 1",
    [owner.key, runId],
  ).catch(() => null);
  if (!work) return null;
  const at = nowIso();
  if (status === 'succeeded') {
    if (!assetId) return null;
    const script = buildTalkingHeadDirectorScript({
      title: work.title || '',
      text: text || '',
      segments,
      durationSeconds,
    });
    await aq(
      "UPDATE junshi_workbench_video_works SET status='succeeded', output_asset_id=?, duration_seconds=?, director_script=?, message=?, error='', updated_at=? WHERE id=? AND owner_key=? AND avatar_run_id=? AND production_mode='talking_head'",
      [assetId, Math.max(0, Number(durationSeconds) || 0), JSON.stringify(script), '口播成片已完成，可以包装发布了。', at, work.id, owner.key, runId],
    );
    return { workId: work.id, status: 'succeeded' };
  }
  if (status === 'failed') {
    const cleanError = clean(error, 1000) || '口播合成失败';
    await aq(
      "UPDATE junshi_workbench_video_works SET status='failed', output_asset_id=NULL, error=?, message=?, updated_at=? WHERE id=? AND owner_key=? AND avatar_run_id=? AND production_mode='talking_head'",
      [cleanError, `口播合成失败：${cleanError.slice(0, 160)}`, at, work.id, owner.key, runId],
    );
    return { workId: work.id, status: 'failed' };
  }
  return null;
}
