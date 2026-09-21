/**
 * 把画面裁成目标比例（"cover" 语义：居中裁剪，**不拉伸**）。
 *
 * 为什么需要它（2026-09-21 用户报「我让他生成 16:9，图2 明显是扁的」）：
 *   上游的关键帧模式会**执行**请求里指定的固定比例（其文档原话："本服务会执行关键帧请求指定的固定比例，
 *   而官方会忽略它并使用自适应，因此这部分行为有差异"）—— 给一张 1:1 的图 + 16:9，它就把图**硬拉**成 16:9。
 *   同一次对比里，生图（图1）看起来正常，是因为图片模型是**重画**一张 16:9，不是把输入拉扁。
 *   所以：**在把首帧交给上游之前先按目标比例裁好**，上游就没有可拉的东西了，出来的是正常的 16:9。
 *
 * 依赖 ffmpeg/ffprobe（生产机上本来就有，`/usr/bin/ffmpeg`）。**这一条失败不影响生成**：
 *   探测失败、裁剪失败、命令不存在 → 一律回退成"原图不动"（宁可保持现状，也不让学生卡住）。
 *   比例已经一致（误差 <1%）时不重编码，直接返回原样。
 */
import { spawn } from 'node:child_process';

const FFMPEG_TIMEOUT_MS = Math.max(5000, Number(process.env.MEDIA_FIT_TIMEOUT_MS || 25000));
// 命令可用性只在第一次探一次（生产机上有，本地/CI 上可能没有 —— 缺了就走回退）
let ffmpegReady = null;

/**
 * 把 bytes 喂给子进程的 stdin、收 stdout 的 bytes。
 * ⚠️ 不能用 `execFile(..., { input })`：异步版 execFile **没有 input 选项**（那是 execFileSync 的），
 *    传了会被忽略 → 子进程读空 stdin、直接失败（2026-09-21 实测 ffprobe 就是这么挂的）。
 */
function runWithInput(command, args, input, { timeoutMs = FFMPEG_TIMEOUT_MS, maxBuffer = 64 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    let size = 0;
    let aborted = false;
    const timer = setTimeout(() => { aborted = true; child.kill('SIGKILL'); }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBuffer) { aborted = true; child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (aborted) return reject(new Error(size > maxBuffer ? '输出过大' : '超时'));
      if (code !== 0) return reject(new Error(`exit ${code}：${stderr.trim().slice(0, 160)}`));
      resolve(Buffer.concat(chunks));
    });
    child.stdin.on('error', () => { /* EPIPE：真正的错误在 close 里给 */ });
    child.stdin.end(input);
  });
}

/** '16:9' → { w: 16, h: 9 }；不是比例就返回 null。 */
export function parseRatio(value) {
  const match = String(value || '').trim().match(/^(\d{1,4}):(\d{1,4})$/);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

async function toolAvailable() {
  if (ffmpegReady !== null) return ffmpegReady;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
    ffmpegReady = true;
  } catch { ffmpegReady = false; }
  return ffmpegReady;
}

async function probeSize(bytes) {
  const stdout = await runWithInput('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', 'pipe:0',
  ], bytes, { maxBuffer: 1 << 20 });
  const [width, height] = String(stdout).trim().split(',').map(Number);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * 裁剪入口：bytes 进来、bytes 出去（PNG）。
 * 返回 `{ bytes, contentType, changed }`；`changed:false` 表示"不用动，发原来的"。
 * 任何失败都返回 `{ changed: false }` —— 调用方照原样发。
 */
export async function fitMediaToRatio(bytes, ratioValue, { source = '' } = {}) {
  const target = parseRatio(ratioValue);
  if (!target || !bytes?.length) return { changed: false };
  if (!(await toolAvailable())) return { changed: false, reason: 'no-ffmpeg' };
  try {
    const size = await probeSize(bytes);
    if (!size) return { changed: false, reason: 'probe-failed' };
    const sourceRatio = size.width / size.height;
    const targetRatio = target.w / target.h;
    // 已经一致（误差 <1%）→ 不重编码
    if (Math.abs(sourceRatio - targetRatio) / targetRatio < 0.01) return { changed: false, reason: 'already-matches' };
    // crop 默认居中；宽高都写成 min(...)，两个方向都覆盖（比目标宽就裁两侧、比目标高就裁上下）。
    const filter = `crop='min(iw,ih*${target.w}/${target.h})':'min(ih,iw*${target.h}/${target.w})'`;
    const cropped = await runWithInput('ffmpeg', [
      '-v', 'error', '-i', 'pipe:0', '-vf', filter, '-frames:v', '1',
      '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ], Buffer.from(bytes));
    if (!cropped.length) return { changed: false, reason: 'empty-output' };
    return { bytes: cropped, contentType: 'image/png', changed: true, from: `${size.width}x${size.height}`, ratio: ratioValue };
  } catch (error) {
    return { changed: false, reason: String(error?.message || error).slice(0, 80), source };
  }
}
