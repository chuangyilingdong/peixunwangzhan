/**
 * 招生军师 · 抖音采集与转写服务（2026-10-24 四期）。
 *
 * 采集链路复刻原版 XiaoLingDang（作者本人授权移植）：
 *   · 公开数据走 F2 开源库（隔离 Python 进程，stdin/stdout 通信，cookie 不落日志——worker
 *     脚本 apps/server/src/douyin/douyin_worker.py 即原版同款）；
 *   · 分享短链解析在 Node 侧跟 302 完成，不进 worker；
 *   · 下载的视频存进工作台素材库（文件夹「抖音采集」）。
 * 转写走平台现有 seedance.nz 聚合渠道的 whisper-1（POST /v1/audio/transcriptions，
 * 同步 multipart，verbose_json 返回带时间码的分段），同一把渠道 Key，不新增凭据。
 *
 * 边界（与原版一致）：只读公开主页/作品/视频详情 + 单次少量下载；不做批量骚扰、不绕验证。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getProviderApiKey } from './providerSecret.js';
import { AI_PROVIDER_API_KEY } from '../config.js';

const DOUYIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../douyin');
const WORKER = path.join(DOUYIN_DIR, 'douyin_worker.py');
/** 原版自带的隔离运行时（装好了 f2/httpx）；优先环境变量，其次探测它，最后退回 PATH 里的 python。 */
const EMBEDDED_RUNTIME = 'E:/XiaoLingDang/_internal/.douyin-runtime/python.exe';
export function douyinPython() {
  const fromEnv = String(process.env.JUNSHI_DOUYIN_PYTHON || '').trim();
  if (fromEnv) return fromEnv;
  try { if (fs.existsSync(EMBEDDED_RUNTIME)) return EMBEDDED_RUNTIME; } catch { /* ignore */ }
  return 'python';
}

/* ── 限流：采集是易滥用的动作，单独预算 ── */
const DOUYIN_WINDOW_MS = 60 * 60 * 1000;
const DOUYIN_HOUR_LIMIT = 40;
const douyinHits = new Map();
export function douyinRateLimit(ownerKey) {
  const now = Date.now();
  const recent = (douyinHits.get(ownerKey) || []).filter((at) => now - at < DOUYIN_WINDOW_MS);
  if (recent.length >= DOUYIN_HOUR_LIMIT) {
    const error = new Error('这个机构本小时的抖音采集次数已达上限（40 次），请稍后再试。');
    error.status = 429;
    throw error;
  }
  recent.push(now);
  douyinHits.set(ownerKey, recent);
  if (douyinHits.size > 2000) {
    for (const [key, values] of douyinHits) if (!values.some((at) => now - at < DOUYIN_WINDOW_MS)) douyinHits.delete(key);
  }
}

/** 跑一次隔离 worker：stdin 传 JSON，stdout 找 DYRESULT: 行。凭据永远不进命令行参数。 */
export function runDouyinWorker(payload, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(douyinPython(), [WORKER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(Object.assign(new Error('抖音采集超时，请稍后重试'), { status: 504 })); }
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf-8'); });
    child.on('error', (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(Object.assign(new Error(`抖音采集环境不可用（${error.message}）；请确认服务器已安装 f2`), { status: 503 }));
    });
    child.on('close', () => {
      if (settled) return; settled = true; clearTimeout(timer);
      const marker = out.lastIndexOf('DYRESULT:');
      if (marker >= 0) {
        const line = out.slice(marker + 'DYRESULT:'.length).split(/\r?\n/, 1)[0];
        try { resolve(JSON.parse(line)); return; } catch { /* 落到 reject */ }
      }
      reject(Object.assign(new Error(`抖音采集失败${err ? `：${err.split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 160)}` : ''}`), { status: 502 }));
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/* ── 分享文本 / 链接解析（纯 Node：跟 302，不进 worker） ── */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/** 单条抖音视频上限：默认 200MB，与生产上传上限一致；可用 JUNSHI_DOUYIN_MAX_BYTES 调整。 */
const MAX_DOUYIN_VIDEO_BYTES = Math.max(120 * 1024 * 1024, Math.min(200 * 1024 * 1024, Number(process.env.JUNSHI_DOUYIN_MAX_BYTES) || 200 * 1024 * 1024));

/** 从一段分享文本里取出目标：短链 v.douyin.com/xxx、/video/{19位id}、/user/{sec_uid}。 */
export async function resolveDouyinTarget(raw) {
  const text = String(raw || '').trim();
  if (!text) throw Object.assign(new Error('请粘贴抖音分享内容或链接'), { status: 400 });
  const shortMatch = text.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9]+/);
  const videoMatch = text.match(/https?:\/\/(?:www\.)?douyin\.com\/video\/(\d{6,25})/);
  const iesMatch = text.match(/https?:\/\/www\.iesdouyin\.com\/share\/video\/(\d{6,25})/);
  const userMatch = text.match(/https?:\/\/(?:www\.)?douyin\.com\/user\/([A-Za-z0-9_-]{20,120})/);
  if (videoMatch) return { kind: 'video', id: videoMatch[1] };
  if (iesMatch) return { kind: 'video', id: iesMatch[1] };
  if (userMatch) return { kind: 'user', id: userMatch[1] };
  if (shortMatch) {
    let url = shortMatch[0];
    for (let hop = 0; hop < 5; hop += 1) {
      const response = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': UA, range: 'bytes=0-0' }, signal: AbortSignal.timeout(12000) }).catch(() => null);
      const location = response?.headers?.get('location');
      if (response && response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url).toString();
        const v = url.match(/\/video\/(\d{6,25})/);
        if (v) return { kind: 'video', id: v[1] };
        const u = url.match(/\/user\/([A-Za-z0-9_-]{20,120})/);
        if (u) return { kind: 'user', id: u[1] };
        continue;
      }
      const final = response?.url || url;
      const v = final.match(/\/video\/(\d{6,25})/);
      if (v) return { kind: 'video', id: v[1] };
      const u = final.match(/\/user\/([A-Za-z0-9_-]{20,120})/);
      if (u) return { kind: 'user', id: u[1] };
      break;
    }
    throw Object.assign(new Error('这条分享链接没有解析出作品或主页，请直接粘贴作品/主页完整链接'), { status: 400 });
  }
  throw Object.assign(new Error('没有识别到抖音链接；请粘贴「分享→复制链接」的完整内容'), { status: 400 });
}

function normalizeStat(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 单条视频详情（F2）。 */
export async function fetchDouyinVideo(awemeId) {
  const raw = await runDouyinWorker({ target: { kind: 'video', id: String(awemeId) } });
  if (!raw || raw.error) {
    const message = { access_denied: '抖音拒绝了这个请求（内容可能已删除或仅可见）', rate_limited: '抖音限流了，请稍后再试', unavailable: '暂时取不到这条内容，请稍后再试' }[raw?.error] || '取不到这条内容';
    throw Object.assign(new Error(message), { status: 502 });
  }
  const item = raw.aweme_detail || raw;
  const play = item?.video?.play_addr?.url_list?.[0] || item?.video?.play_addr?.uri || '';
  return {
    awemeId: String(item.aweme_id || awemeId),
    desc: String(item.desc || '').slice(0, 500),
    nickname: String(item.author?.nickname || item.author?.unique_id || ''),
    durationMs: normalizeStat(item?.video?.duration) || normalizeStat(item?.duration) * 1000,
    createTime: Number(item.create_time) || null,
    stats: {
      digg: normalizeStat(item.statistics?.digg_count),
      comment: normalizeStat(item.statistics?.comment_count),
      share: normalizeStat(item.statistics?.share_count),
      collect: normalizeStat(item.statistics?.collect_count),
    },
    cover: item?.video?.cover?.url_list?.[0] || item?.video?.origin_cover?.url_list?.[0] || '',
    playUrl: play ? (String(play).startsWith('http') ? play : `https://www.douyin.com/aweme/v1/play/?video_id=${play}&ratio=1080p&line=0`) : '',
  };
}

/** 同行主页 + 最近作品一页（F2）。 */
export async function fetchDouyinProfile(secUserId, cursor = 0) {
  // ⚠️ 坑：worker 见到 target 里带 cursor 就只拉作品列表、跳过主页信息请求。
  // 首屏（cursor=0）必须不带 cursor，才能同时拿到昵称/粉丝 + 第一批作品；
  // 否则作品接口被抖音拒时连主页信息都没有，会误报「取不到这个主页」（2026-10-25 真实踩到）。
  const target = { kind: 'user', id: String(secUserId) };
  if (Number(cursor) > 0) target.cursor = Number(cursor);
  const raw = await runDouyinWorker({ target });
  if (!raw || raw.error) {
    const message = { access_denied: '抖音拒绝了这个请求（主页可能已设私）', rate_limited: '抖音限流了，请稍后再试', unavailable: '暂时取不到这个主页，请稍后再试' }[raw?.error] || '取不到这个主页';
    throw Object.assign(new Error(message), { status: 502 });
  }
  const user = raw.user || {};
  if (!user.nickname && !Array.isArray(raw.aweme_list)) {
    throw Object.assign(new Error('取不到这个主页（可能不存在、已设私或抖音暂时拒绝），稍后再试'), { code: 'DOUYIN_EMPTY_PROFILE' });
  }
  /** 主页读到了但作品列表被抖音拒：把原因单独带出来，别让上层误判成「主页不存在」。 */
  const worksError = raw.works_status === 'unavailable' ? String(raw.works_error || 'APIResponseError').slice(0, 80) : '';
  const works = (Array.isArray(raw.aweme_list) ? raw.aweme_list : []).filter((item) => item && item.aweme_id).map((item) => ({
    awemeId: String(item.aweme_id),
    desc: String(item.desc || '').slice(0, 300),
    durationMs: normalizeStat(item?.video?.duration) || normalizeStat(item?.duration) * 1000,
    createTime: Number(item.create_time) || null,
    stats: {
      digg: normalizeStat(item.statistics?.digg_count),
      comment: normalizeStat(item.statistics?.comment_count),
      share: normalizeStat(item.statistics?.share_count),
      // 十一期：同行同步的「最低收藏数」筛选要用到。
      collect: normalizeStat(item.statistics?.collect_count),
    },
    cover: item?.video?.cover?.url_list?.[0] || '',
  }));
  return {
    secUserId: String(user.sec_uid || secUserId),
    nickname: String(user.nickname || user.unique_id || ''),
    signature: String(user.signature || '').slice(0, 500),
    followerCount: normalizeStat(user.follower_count),
    totalFavorited: normalizeStat(user.total_favorited),
    worksStatus: raw.works_status || 'read',
    worksError,
    nextCursor: raw.next_cursor != null ? Number(raw.next_cursor) : null,
    hasMore: raw.has_more === true,
    works,
  };
}

/** 下载视频字节（带 UA；上限 120MB）。 */
export async function downloadDouyinVideo(url) {
  const response = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.douyin.com/' }, signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw Object.assign(new Error(`视频下载失败（HTTP ${response.status}）`), { status: 502 });
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_DOUYIN_VIDEO_BYTES) throw Object.assign(new Error(`这条视频超过 ${Math.floor(MAX_DOUYIN_VIDEO_BYTES / 1024 / 1024)}MB，超出平台单素材上限`), { status: 413 });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw Object.assign(new Error('视频下载为空'), { status: 502 });
  if (buffer.length > MAX_DOUYIN_VIDEO_BYTES) throw Object.assign(new Error(`这条视频超过 ${Math.floor(MAX_DOUYIN_VIDEO_BYTES / 1024 / 1024)}MB，超出平台单素材上限`), { status: 413 });
  return buffer;
}

/* ── whisper-1 转写（seedance.nz，同一把渠道 Key） ── */
export async function seedanceAsrConfig(policyChannels) {
  const fromEnv = { endpoint: String(process.env.JUNSHI_ASR_ENDPOINT || '').trim(), apiKey: String(process.env.JUNSHI_ASR_KEY || '').trim() };
  if (fromEnv.endpoint && fromEnv.apiKey) return fromEnv;
  const channels = Array.isArray(policyChannels) ? policyChannels : [];
  for (const channel of channels) {
    const endpoint = String(channel.endpoint || '').trim();
    if (/seedance\.nz/i.test(endpoint) || /api\.seedance/i.test(endpoint)) {
      const apiKey = getProviderApiKey(channel.id) || getProviderApiKey() || AI_PROVIDER_API_KEY;
      if (apiKey) return { endpoint: endpoint.replace(/\/v1\/?$/i, ''), apiKey };
    }
  }
  return null;
}

function readableAsrError(text) {
  const cleaned = String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 180) || '上游没有返回可读错误';
}

function runMediaCommand(command, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(Object.assign(new Error(`${command} 处理超时`), { status: 504 }));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-6000); });
    child.on('error', (error) => finish(Object.assign(new Error(`${command} 启动失败：${error.message}`), { status: 503 })));
    child.on('close', (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(Object.assign(new Error(`${command} 处理失败${stderr ? `：${stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 260)}` : `（退出码 ${code}）`}`), { status: 502 }));
    });
  });
}

async function probeMediaDuration(file) {
  const { stdout } = await runMediaCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], 30000);
  return Math.max(0, Number(String(stdout).trim()) || 0);
}

/**
 * 先把视频抽成 16k 单声道低码率音频，再按 5 分钟切片。
 * Whisper 对整段大视频经常 fetch failed / timeout / 524；音频分片能显著降低单次上传和处理时间。
 */
export async function prepareAudioChunks({ buffer, fileName = 'source.mp4', chunkSeconds = 300 }) {
  if (!buffer?.length) throw Object.assign(new Error('转写素材为空'), { status: 400 });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'junshi-asr-'));
  try {
    const rawExt = path.extname(String(fileName || '')).toLowerCase();
    const ext = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : '.mp4';
    const input = path.join(dir, `source${ext}`);
    await fsp.writeFile(input, buffer);
    const duration = await probeMediaDuration(input).catch(() => 0);
    const pattern = path.join(dir, 'chunk-%03d.mp3');
    try {
      await runMediaCommand('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', input,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-b:a', '24k',
        '-f', 'segment', '-segment_time', String(Math.max(30, Number(chunkSeconds) || 300)), '-reset_timestamps', '1',
        pattern,
      ], 180000);
    } catch (error) {
      if (/does not contain any stream|matches no streams|Stream map|Failed to configure output pad/i.test(String(error?.message || error))) {
        throw Object.assign(new Error('这条素材没有可用音轨，无法转写'), { status: 422 });
      }
      throw error;
    }
    const chunks = (await fsp.readdir(dir))
      .filter((name) => /^chunk-\d{3}\.mp3$/.test(name))
      .sort()
      .map((name) => path.join(dir, name));
    if (!chunks.length) throw Object.assign(new Error('这条素材没有可用音轨，无法转写'), { status: 422 });
    return { dir, chunks, duration };
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function asrErrorRetryable(error) {
  const message = String(error?.message || error);
  const status = Number(error?.status) || 0;
  return status === 429 || status >= 500 || /fetch failed|timed? ?out|aborted|ECONN|UND_ERR|socket|network|524/i.test(message);
}

/** 同步转写：multipart 上传音频/视频字节，verbose_json 拿时间码分段。 */
export async function transcribeMedia({ endpoint, apiKey, buffer, fileName, mimeType, timeoutMs = 300000 }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'video/mp4' }), fileName);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  const response = await fetch(`${endpoint}/v1/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`转写服务返回 HTTP ${response.status}：${readableAsrError(text)}`), { status: response.status === 429 ? 429 : 502 });
  }
  let payload;
  try { payload = JSON.parse(text); } catch {
    // 非 JSON（plain text 格式等）：整段当无时间码文本
    return { text: String(text).trim(), segments: [], duration: 0, language: '' };
  }
  const segments = (Array.isArray(payload.segments) ? payload.segments : []).map((segment) => ({
    start: Number(segment.start) || 0,
    end: Number(segment.end) || 0,
    text: String(segment.text || '').trim(),
  }));
  return {
    text: String(payload.text || segments.map((s) => s.text).join(' ') || '').trim(),
    segments,
    duration: Number(payload.duration) || (segments.length ? segments[segments.length - 1].end : 0),
    language: String(payload.language || ''),
  };
}

/** 视频 → 低码率音频分片 → 逐片转写并合并时间码；单片失败自动重试 3 次。 */
export async function transcribeMediaReliable({ endpoint, apiKey, buffer, fileName, mimeType, chunkSeconds = 300, attempts = 3, transcribeImpl = transcribeMedia }) {
  const prepared = await prepareAudioChunks({ buffer, fileName, chunkSeconds });
  try {
    const mergedSegments = [];
    const texts = [];
    let duration = 0;
    let language = '';
    for (let index = 0; index < prepared.chunks.length; index += 1) {
      const chunkPath = prepared.chunks[index];
      const chunkBuffer = await fsp.readFile(chunkPath);
      let result = null;
      let lastError = null;
      for (let attempt = 1; attempt <= Math.max(1, Number(attempts) || 1); attempt += 1) {
        try {
          result = await transcribeImpl({
            endpoint, apiKey, buffer: chunkBuffer,
            fileName: `chunk-${String(index + 1).padStart(3, '0')}.mp3`,
            mimeType: 'audio/mpeg', timeoutMs: 180000,
          });
          break;
        } catch (error) {
          lastError = error;
          if (!asrErrorRetryable(error) || attempt >= attempts) break;
          await new Promise((resolve) => setTimeout(resolve, 1200 * (2 ** (attempt - 1))));
        }
      }
      if (!result) {
        const detail = String(lastError?.message || lastError || '未知错误');
        throw Object.assign(new Error(`音频分片 ${index + 1}/${prepared.chunks.length} 转写失败：${detail}`), { status: lastError?.status || 502 });
      }
      const offset = index * Math.max(30, Number(chunkSeconds) || 300);
      for (const segment of result.segments || []) {
        mergedSegments.push({ start: offset + (Number(segment.start) || 0), end: offset + (Number(segment.end) || 0), text: segment.text });
      }
      if (result.text) texts.push(result.text.trim());
      duration = Math.max(duration, offset + (Number(result.duration) || 0));
      if (!language && result.language) language = result.language;
    }
    return {
      text: texts.filter(Boolean).join('\n').trim(),
      segments: mergedSegments,
      duration: duration || prepared.duration,
      language,
      chunkCount: prepared.chunks.length,
    };
  } finally {
    await fsp.rm(prepared.dir, { recursive: true, force: true }).catch(() => {});
  }
}
