/**
 * 招生军师 · 数字人口播服务（2026-10-24 五期）。
 *
 * 全部走 seedance.nz 聚合渠道（与图片/视频/转写同一把 Key）：
 *   音色克隆  POST /v1/audio/generations  model=doubao-voice-clone（样本≤10MB 直链 + 试听文本）
 *   语音合成  POST /v1/audio/generations  model=doubao-seed-icl-2.0（用克隆出的 speaker）
 *   人脸分析  POST /v1/video/generations  model=kling-lip-sync-identify-face（形象照直链）
 *   对口型    POST /v1/video/generations  model=kling-lip-sync-video（sessionId/faceId + audio_url）
 *   素材直链  POST /v1/files/upload（24h）
 * 音频任务轮询 GET /v1/audio/generations/{id}，视频任务轮询 GET /v1/videos/{id}。
 */
import { getProviderApiKey } from './providerSecret.js';
import { AI_PROVIDER_API_KEY } from '../config.js';

export async function seedanceChannelConfig(policyChannels) {
  const channels = Array.isArray(policyChannels) ? policyChannels : [];
  for (const channel of channels) {
    const endpoint = String(channel.endpoint || '').trim();
    if (/seedance\.nz/i.test(endpoint)) {
      const apiKey = getProviderApiKey(channel.id) || getProviderApiKey() || AI_PROVIDER_API_KEY;
      if (apiKey) return { endpoint: endpoint.replace(/\/v1\/?$/i, ''), apiKey };
    }
  }
  return null;
}

async function apiFetch({ endpoint, apiKey, path, method = 'GET', body = null, form = null, timeoutMs = 120000 }) {
  const headers = { authorization: `Bearer ${apiKey}` };
  let payload = null;
  if (form) payload = form;
  else if (body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const response = await fetch(`${endpoint}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保持 null */ }
  if (!response.ok) {
    const detail = json?.error?.message || json?.message || text.slice(0, 160);
    throw Object.assign(new Error(`seedance ${path} HTTP ${response.status}：${detail}`), { status: 502 });
  }
  return json;
}

/* ── 24h 直链上传（≤50MB；30 次/分钟） ── */
export async function uploadToSeedance({ endpoint, apiKey, buffer, fileName, mimeType }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), fileName);
  const json = await apiFetch({ endpoint, apiKey, path: '/v1/files/upload', method: 'POST', form });
  const url = json?.url || json?.data?.url || '';
  if (!url) throw Object.assign(new Error('上传成功但没有返回直链'), { status: 502 });
  return url;
}

/* ── 音频任务：提交与轮询 ── */
export async function submitAudioTask({ endpoint, apiKey, model, prompt, metadata }) {
  const json = await apiFetch({ endpoint, apiKey, path: '/v1/audio/generations', method: 'POST', body: { model, prompt, metadata: metadata || {} } });
  const taskId = json?.task_id || json?.id || json?.data?.task_id || '';
  if (!taskId) throw Object.assign(new Error(`提交 ${model} 没有返回任务号`), { status: 502 });
  return String(taskId);
}

function searchValues(value, predicate, found = []) {
  if (found.length > 4) return found;
  if (predicate(value)) { found.push(value); return found; }
  if (Array.isArray(value)) { for (const item of value) searchValues(item, predicate, found); }
  else if (value && typeof value === 'object') { for (const item of Object.values(value)) searchValues(item, predicate, found); }
  return found;
}

const HTTP_URL = /^https?:\/\/\S+$/;

/** 轮询音频任务：SUCCESS → {url, resultText}；FAILURE → 抛错；未完成 → {status}。 */
export async function pollAudioTask({ endpoint, apiKey, taskId, timeoutMs = 600000, intervalMs = 5000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const json = await apiFetch({ endpoint, apiKey, path: `/v1/audio/generations/${taskId}` });
    const status = String(json?.status || json?.data?.status || json?.data?.data?.status || '').toUpperCase();
    if (status === 'SUCCESS' || status === 'COMPLETED' || status === 'SUCCEEDED') {
      const urls = searchValues(json, (v) => typeof v === 'string' && HTTP_URL.test(v) && /\.(mp3|wav|ogg|m4a|aac)(\?|$)/i.test(v));
      const anyUrl = urls[0] || searchValues(json, (v) => typeof v === 'string' && HTTP_URL.test(v) && /audio/i.test(v))[0] || '';
      const resultText = String(json?.result_text || json?.data?.result_text || searchValues(json, (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{6,120}$/.test(v))[0] || '');
      if (!anyUrl && !resultText) throw Object.assign(new Error('音频任务成功但没解析出结果'), { status: 502 });
      return { done: true, url: anyUrl, resultText };
    }
    if (status === 'FAILURE' || status === 'FAILED') {
      const reason = String(json?.fail_reason || json?.data?.fail_reason || '').slice(0, 200);
      throw Object.assign(new Error(`音频任务失败${reason ? `：${reason}` : ''}`), { status: 502 });
    }
    if (Date.now() > deadline) throw Object.assign(new Error('音频任务超时'), { status: 504 });
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/* ── 视频任务：提交与轮询（/v1/videos 家族） ── */
export async function submitVideoTask({ endpoint, apiKey, model, metadata }) {
  const json = await apiFetch({ endpoint, apiKey, path: '/v1/video/generations', method: 'POST', body: { model, metadata: metadata || {} } });
  const taskId = json?.task_id || json?.id || json?.data?.task_id || '';
  if (!taskId) throw Object.assign(new Error(`提交 ${model} 没有返回任务号`), { status: 502 });
  return String(taskId);
}

/** 轮询视频任务：完成 → {url, resultText}；失败 → 抛错。 */
export async function pollVideoTask({ endpoint, apiKey, taskId, timeoutMs = 900000, intervalMs = 6000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const json = await apiFetch({ endpoint, apiKey, path: `/v1/videos/${taskId}` });
    const status = String(json?.status || json?.data?.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const urls = searchValues(json, (v) => typeof v === 'string' && HTTP_URL.test(v) && /\.(mp4|mov|webm)(\?|$)/i.test(v));
      const anyUrl = urls[0] || searchValues(json, (v) => typeof v === 'string' && HTTP_URL.test(v))[0] || '';
      const resultText = String(json?.result_text || json?.data?.result_text || json?.metadata?.result_text || '');
      if (!anyUrl && !resultText) throw Object.assign(new Error('视频任务成功但没解析出地址'), { status: 502 });
      return { done: true, url: anyUrl, resultText };
    }
    if (status === 'failed' || status === 'failure') {
      const reason = String(json?.fail_reason || json?.error?.message || '').slice(0, 200);
      throw Object.assign(new Error(`视频任务失败${reason ? `：${reason}` : ''}`), { status: 502 });
    }
    if (Date.now() > deadline) throw Object.assign(new Error('视频任务超时'), { status: 504 });
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** 从 identify-face 的 result_text 里抠出 sessionId/faceId（结构未知，宽容解析）。 */
export function parseFaceSession(resultText) {
  const raw = String(resultText || '').trim();
  try {
    const parsed = JSON.parse(raw);
    const sessionId = parsed.sessionId || parsed.session_id || parsed.data?.sessionId || parsed.data?.session_id || '';
    const faceId = parsed.faceId || parsed.face_id || parsed.data?.faceId || parsed.data?.face_id || '';
    if (sessionId && faceId) return { sessionId, faceId };
  } catch { /* 不是纯 JSON */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      const sessionId = parsed.sessionId || parsed.session_id || '';
      const faceId = parsed.faceId || parsed.face_id || '';
      if (sessionId && faceId) return { sessionId, faceId };
    } catch { /* ignore */ }
  }
  throw Object.assign(new Error('人脸分析结果里没有 sessionId/faceId'), { status: 502 });
}
