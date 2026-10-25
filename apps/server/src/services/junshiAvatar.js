/**
 * 招生军师 · 数字人口播服务（2026-10-24 五期）。
 *
 * 全部走 seedance.nz 聚合渠道（与图片/视频/转写同一把 Key）：
 *   音色克隆  POST /v1/audio/generations  model=doubao-voice-clone 或 minimax-voice-clone
 *   语音合成  POST /v1/audio/generations  model=doubao-seed-icl-2.0（克隆 speaker）或 doubao-seed-audio-1.0（预置音色）
 *   底片生成  POST /v1/videos             model=seedance-2.0-standard-i2v（形象照 → 5 秒人物正面出镜视频）
 *   人脸分析  POST /v1/video/generations  model=kling-lip-sync-identify-face（签名直链视频）
 *   对口型    POST /v1/video/generations  model=kling-lip-sync-video（sessionId/faceId + audio_url）
 *   素材直链  POST /v1/files/upload（24h；identify-face 必须用完整签名 URL，裸 URL 会报「文件处理失败」；
 *                                  且视频要 ffmpeg baseline/faststart 标准化，上游不接受 profile 过高的 mp4）
 * 音频任务轮询 GET /v1/audio/generations/{id}，视频任务轮询 GET /v1/videos/{id}。
 *
 * ⚠️ i2v 参考图必须在顶层 images（不是 metadata.images）；放错会 400
 *    「image-to-video requires at least one input image」。2026-10-25 复测确认。
 *
 * ⚠️ 2026-10-24/25 生产实测：
 *    1. identify-face 返回的是 results 数组：session_id / face_id / end_time 分在
 *       outputType=text 的子 JSON 里；parseFaceSession 已递归兼容，并返回 endTime。
 *    2. kling-lip-sync-video 的「session_id has expired」是误导性报错。同一份新会话：
 *       4700ms 底片 + soundEndTime 5000/4700/4600 全部失败，4000 成功；
 *       5300ms 底片 + 4700 成功。真正约束是 soundEndTime 要比 end_time 早约 700ms。
 *       用 safeLipSyncEndTime(endTime) 计算，不要再写死 5000。
 *    3. 音色克隆仍被上游阻：doubao-voice-clone 503「No available channel」，
 *       minimax-voice-clone「模型响应异常」。但 doubao-seed-audio-1.0 的参考音频直出可用
 *       （audio_url），因此克隆失败时降级为「参考音频直出」（音色相近，非训练克隆）。
 *    4. 底片 i2v 传 seconds:'6'，给 5 秒口播留出 700ms 安全余量；仍保留「底片+配音」
 *       降级，仅在真正失败时触发。
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
export async function submitVideoTask({ endpoint, apiKey, model, metadata, promptOverride, images = null, extra = null }) {
  const body = { model, metadata: metadata || {} };
  if (promptOverride) body.prompt = promptOverride;
  // Seedance 2.0 i2v 要顶层 images；放进 metadata 会被上游判成「没有输入图」。
  if (Array.isArray(images) && images.length) body.images = images;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(body, extra);
  const json = await apiFetch({ endpoint, apiKey, path: '/v1/video/generations', method: 'POST', body });
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

/**
 * 从 identify-face 的 result_text 里抠出 sessionId/faceId/endTime。
 * 2026-10-25 实测上游返回的是 results 数组，session_id 和 face_id 分别放在
 * 两条 outputType=text 的子 JSON 里，不再是单个对象；end_time 与 face_id 在同一条。
 * endTime 是底片可对口型的截止毫秒数，lip-sync 的 soundEndTime 必须留出余量。
 */
export function parseFaceSession(resultText) {
  const raw = String(resultText || '').trim();
  const found = { sessionId: '', faceId: '', endTime: 0 };
  const takeText = (value) => {
    const textValue = String(value || '');
    const start = textValue.indexOf('{');
    const end = textValue.lastIndexOf('}');
    if (start < 0 || end <= start) return;
    try { takeObject(JSON.parse(textValue.slice(start, end + 1))); } catch { /* ignore */ }
  };
  const takeObject = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) takeObject(item); return; }
    const sessionId = value.sessionId ?? value.session_id ?? value.data?.sessionId ?? value.data?.session_id;
    if (sessionId !== undefined && sessionId !== null && String(sessionId) !== '') found.sessionId = String(sessionId);
    const faceId = value.faceId ?? value.face_id ?? value.data?.faceId ?? value.data?.face_id;
    if (faceId !== undefined && faceId !== null && String(faceId) !== '') found.faceId = String(faceId);
    const endTime = value.endTime ?? value.end_time ?? value.data?.endTime ?? value.data?.end_time;
    if (endTime !== undefined && endTime !== null && Number(endTime) > 0) found.endTime = Number(endTime);
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') takeObject(child);
      else if (typeof child === 'string' && child.includes('{')) takeText(child);
    }
  };
  takeText(raw);
  if (found.sessionId && found.faceId !== '') return { sessionId: found.sessionId, faceId: found.faceId, endTime: found.endTime };
  throw Object.assign(new Error('人脸分析结果里没有 sessionId/faceId'), { status: 502 });
}

/**
 * 计算 lip-sync 的安全结束时间。
 *
 * 2026-10-25 复测结论：`session_id has expired` 是上游的误导性报错。同一份
 * identify-face 会话，在 4700ms 底片上提交 soundEndTime=5000/4700/4600 全部报
 * 「过期」，而 4000 成功；在 5300ms 底片上 4700 成功。真正约束是
 * `soundEndTime` 必须比底片 end_time 早约 700ms。这里统一留 700ms 余量并按
 * 100ms 向下取整，避免最后一帧/音频尾部触发参数校验。
 */
export function safeLipSyncEndTime(endTime, maxMs = 5000) {
  const end = Number(endTime) || 0;
  if (!(end > 0)) return 4000;
  return Math.max(1000, Math.min(maxMs, Math.floor((end - 700) / 100) * 100));
}
