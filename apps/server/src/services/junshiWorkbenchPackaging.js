/**
 * 内容工作台 · 视频包装（字幕 / BGM / 封面 / 发布包）。
 *
 * 纯媒体处理，不碰数据库：路由层负责素材读写与归属校验。
 * 依赖本机 ffmpeg/ffprobe；中文字体优先用仓库内置的 Noto Sans SC，
 * 生产缺字体时可通过 JUNSHI_COVER_FONT 指定 TTF/TTC。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const BUNDLED_FONT = path.join(ROOT, 'apps/server/assets/fonts/NotoSansSC-VF.ttf');
const FONT_NAME = 'Noto Sans SC';
export const PACKAGE_SUBTITLE_STYLES = Object.freeze(['none', 'white', 'yellow', 'bold']);
const SUBTITLE_MAX_CHARS = 18;
const SUBTITLE_MAX_LINES = 2;

let cachedFont = '';

function runProcess(command, args, { timeoutMs = 180000, cwd = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} 超时`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} 退出码 ${code}：${stderr.slice(-500)}`));
    });
  });
}

export async function probeMedia(file) {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file,
  ], { timeoutMs: 30000 });
  let data = {};
  try { data = JSON.parse(stdout || '{}'); } catch { /* ignore */ }
  return {
    duration: Math.max(0, Number(data?.format?.duration) || 0),
    hasAudio: (data?.streams || []).some((stream) => stream.codec_type === 'audio'),
    hasVideo: (data?.streams || []).some((stream) => stream.codec_type === 'video'),
  };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** 中文按字数换行；最后一行超长时截断加省略号，避免封面/字幕溢出。 */
export function wrapLines(input, maxChars = SUBTITLE_MAX_CHARS, maxLines = SUBTITLE_MAX_LINES) {
  const text = normalizeText(input);
  if (!text) return [];
  const lines = [];
  let rest = text;
  while (rest && lines.length < maxLines) {
    if (lines.length === maxLines - 1) {
      lines.push(rest.length > maxChars ? `${rest.slice(0, Math.max(1, maxChars - 1))}…` : rest);
      break;
    }
    if (rest.length <= maxChars) { lines.push(rest); break; }
    let cut = -1;
    for (let index = maxChars; index >= Math.max(4, Math.floor(maxChars * 0.6)); index -= 1) {
      if (/[，,。.！!？?；;：:\s]/.test(rest[index - 1])) { cut = index; break; }
    }
    if (cut <= 0) cut = maxChars;
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return lines.filter(Boolean);
}

function srtTime(seconds) {
  const totalMs = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

function parseSrtTime(value) {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000;
}

/** 按编导稿的分镜时长与口播生成 SRT；视频比脚本短时按比例压缩时间轴。 */
export function buildDirectorSrt(script, duration = 0) {
  const shots = Array.isArray(script?.shots) ? script.shots : [];
  const cues = [];
  let cursor = 0;
  for (const shot of shots) {
    const seconds = Math.max(0.5, Number(shot.seconds) || 0);
    const text = normalizeText(shot.voiceover || shot.overlay || '');
    if (text) {
      const lines = wrapLines(text, SUBTITLE_MAX_CHARS, SUBTITLE_MAX_LINES);
      if (lines.length) cues.push({ start: cursor, end: cursor + seconds, text: lines.join('\n') });
    }
    cursor += seconds;
  }
  if (!cues.length) {
    const title = normalizeText(script?.title);
    if (title) cues.push({ start: 0, end: Math.max(2.5, Math.min(4, duration || 3)), text: title });
  }
  if (duration > 0 && cursor > duration + 0.2 && cursor > 0) {
    const scale = duration / cursor;
    for (const cue of cues) {
      cue.start = Math.min(duration, cue.start * scale);
      cue.end = Math.min(duration, Math.max(cue.start + 0.3, cue.end * scale));
    }
  }
  return cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join('\n');
}

function assTime(seconds) {
  const totalCs = Math.round(Math.max(0, Number(seconds) || 0) * 100);
  const hours = Math.floor(totalCs / 360_000);
  const minutes = Math.floor((totalCs % 360_000) / 6_000);
  const secs = Math.floor((totalCs % 6_000) / 100);
  const centis = totalCs % 100;
  const pad = (n) => String(n).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(centis)}`;
}

function subtitleDims(ratio) {
  if (String(ratio || '') === '16:9') return { width: 1920, height: 1080, font: 54, marginV: 80 };
  if (String(ratio || '') === '1:1') return { width: 1080, height: 1080, font: 54, marginV: 110 };
  return { width: 1080, height: 1920, font: 60, marginV: 150 };
}

export function srtToAss(srt, { ratio = '9:16', style = 'white' } = {}) {
  const dims = subtitleDims(ratio);
  const yellow = style === 'yellow';
  const bold = style === 'bold';
  const fontSize = dims.font + (bold ? 8 : 0);
  const outline = bold ? 6 : 4;
  const shadow = bold ? 2 : 1;
  const primary = yellow ? '&H0000FFFF' : '&H00FFFFFF';
  const events = [];
  const blocks = String(srt || '').replace(/\r/g, '').trim().split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex < 0) continue;
    const [from, to] = lines[timeIndex].split('-->').map((value) => value.trim());
    const text = lines.slice(timeIndex + 1).join('\n').trim();
    if (!text) continue;
    const safe = text.split('\n')
      .map((line) => line.replace(/[\\{}]/g, '').trim())
      .filter(Boolean)
      .join('\\N');
    if (!safe) continue;
    events.push(`Dialogue: 0,${assTime(parseSrtTime(from))},${assTime(parseSrtTime(to))},Default,,0,0,0,,${safe}`);
  }
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${dims.width}`,
    `PlayResY: ${dims.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${FONT_NAME},${fontSize},${primary},&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,70,70,${dims.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

export function resolveCoverFont() {
  if (cachedFont) return cachedFont;
  const candidates = [
    process.env.JUNSHI_COVER_FONT,
    BUNDLED_FONT,
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    'C:/Windows/Fonts/NotoSansSC-VF.ttf',
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/simhei.ttf',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    try {
      if (fs.statSync(absolute).isFile()) { cachedFont = absolute; return absolute; }
    } catch { /* 继续找下一个 */ }
  }
  throw new Error('服务器缺少中文字体：请安装 fonts-noto-cjk，或设置 JUNSHI_COVER_FONT 指向可用的中文 TTF/TTC。');
}

async function prepareFontDir(workDir) {
  const fontDir = path.join(workDir, 'fonts');
  await fsp.mkdir(fontDir, { recursive: true });
  const source = resolveCoverFont();
  const target = path.join(fontDir, 'NotoSansSC-VF.ttf');
  try {
    await fsp.link(source, target);
  } catch {
    await fsp.copyFile(source, target);
  }
  return { fontDir, fontPath: target };
}

function coverDims(ratio) {
  if (String(ratio || '') === '16:9') return { width: 1920, height: 1080, font: 96, subFont: 42, chars: 14, lines: 2, anchor: 0.56 };
  if (String(ratio || '') === '1:1') return { width: 1080, height: 1080, font: 78, subFont: 40, chars: 10, lines: 3, anchor: 0.56 };
  return { width: 1080, height: 1920, font: 86, subFont: 42, chars: 8, lines: 3, anchor: 0.58 };
}

function coverBaseFilters(dims) {
  return [
    `scale=${dims.width}:${dims.height}:force_original_aspect_ratio=increase`,
    `crop=${dims.width}:${dims.height}`,
    'drawbox=x=0:y=0:w=iw:h=ih:color=black@0.16:t=fill',
    'drawbox=x=0:y=ih*0.42:w=iw:h=ih*0.10:color=black@0.18:t=fill',
    'drawbox=x=0:y=ih*0.52:w=iw:h=ih*0.10:color=black@0.32:t=fill',
    'drawbox=x=0:y=ih*0.62:w=iw:h=ih*0.30:color=black@0.55:t=fill',
  ];
}

function coverTitleFilters(dims, lineCount) {
  const fontSize = lineCount >= 3 ? dims.font - 14 : dims.font;
  const lineGap = Math.round(fontSize * 0.22);
  const blockHeight = lineCount * fontSize + Math.max(0, lineCount - 1) * lineGap;
  const startY = Math.round(dims.height * dims.anchor - blockHeight / 2);
  const filters = [];
  for (let index = 0; index < lineCount; index += 1) {
    filters.push(`drawtext=fontfile=fonts/NotoSansSC-VF.ttf:textfile=cover-title-${index}.txt:fontcolor=white:fontsize=${fontSize}:borderw=5:bordercolor=black@0.9:x=(w-text_w)/2:y=${startY + index * (fontSize + lineGap)}`);
  }
  return filters;
}

/** 从成片抽一帧做 9:16 / 16:9 / 1:1 封面；标题逐行 drawtext，避免 textfile 换行被 ffmpeg 渲染成方框。 */
export async function renderCover({ videoPath, title, subtitle = '', ratio = '9:16', duration = 0, workDir, outputPath }) {
  const dims = coverDims(ratio);
  const lines = wrapLines(title, dims.chars, dims.lines);
  const titleLines = lines.length ? lines : ['精彩内容'];
  for (let index = 0; index < titleLines.length; index += 1) {
    await fsp.writeFile(path.join(workDir, `cover-title-${index}.txt`), titleLines[index], 'utf8');
  }
  await prepareFontDir(workDir);
  const base = coverBaseFilters(dims);
  const titleFilters = coverTitleFilters(dims, titleLines.length);
  const tail = [];
  if (normalizeText(subtitle)) {
    await fsp.writeFile(path.join(workDir, 'cover-sub.txt'), normalizeText(subtitle).slice(0, 30), 'utf8');
    tail.push('drawtext=fontfile=fonts/NotoSansSC-VF.ttf:textfile=cover-sub.txt:fontcolor=0xFFE45C:fontsize=' + dims.subFont + ':borderw=3:bordercolor=black@0.9:x=(w-text_w)/2:y=h*0.84');
  }
  tail.push('drawbox=x=0:y=h-12:w=iw:h=12:color=0x2563EB@0.95:t=fill');
  const frameTime = Math.max(0.1, Math.min(1, (Number(duration) || 0) / 5 || 0.5));
  try {
    await runProcess('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-ss', frameTime.toFixed(3), '-i', videoPath,
      '-frames:v', '1', '-vf', [...base, ...titleFilters, ...tail].join(','), '-q:v', '3', outputPath,
    ], { timeoutMs: 60000, cwd: workDir });
  } catch {
    // 极短视频/坏首帧兜底：用纯色底图生成封面，不阻断发布包。
    const fallback = [
      'drawbox=x=0:y=0:w=iw:h=ih:color=0x0f172a@1.0:t=fill',
      ...base.slice(2),
      ...titleFilters,
      ...tail,
    ];
    await runProcess('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `color=c=0x0f172a:s=${dims.width}x${dims.height}:d=1`,
      '-frames:v', '1', '-vf', fallback.join(','), '-q:v', '3', outputPath,
    ], { timeoutMs: 60000, cwd: workDir });
  }
  return outputPath;
}

/** 烧字幕 + 混 BGM，并统一转成 mp4 faststart。assPath 必须在 workDir 下。 */
export async function renderPackagedVideo({ videoPath, bgmPath = '', assPath = '', outputPath, bgmVolume = 0.18, hasAudio = true, duration = 0, workDir }) {
  if (assPath) await prepareFontDir(workDir);
  const volume = Math.max(0, Math.min(1, Number(bgmVolume) || 0.18));
  const filters = [];
  filters.push(assPath ? `[0:v]ass=${path.basename(assPath)}:fontsdir=fonts[v]` : '[0:v]null[v]');
  let withAudio = false;
  if (bgmPath) {
    filters.push(`[1:a]volume=${volume.toFixed(3)}[bgm]`);
    if (hasAudio) {
      filters.push('[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[a]');
    } else {
      filters.push('[bgm]anull[a]');
    }
    withAudio = true;
  } else if (hasAudio) {
    filters.push('[0:a]anull[a]');
    withAudio = true;
  }
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath,
    ...(bgmPath ? ['-stream_loop', '-1', '-i', bgmPath] : []),
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    ...(withAudio ? ['-map', '[a]'] : ['-an']),
    ...(duration > 0 ? ['-t', Number(duration).toFixed(3)] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    ...(withAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
    '-movflags', '+faststart', outputPath,
  ];
  await runProcess('ffmpeg', args, { timeoutMs: 300000, cwd: workDir });
  return outputPath;
}

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = ZIP_CRC_TABLE[(crc ^ buffer[index]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

/** 极简 ZIP（deflate/store，UTF-8 文件名）。发布包不需要额外依赖。 */
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name || 'file').replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8');
    const compress = entry.compress !== false;
    const method = compress ? 8 : 0;
    const body = compress ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    central.push({ name, method, crc, compressed: body.length, size: data.length, offset, time: stamp.time, date: stamp.date });
    offset += local.length + name.length + body.length;
  }
  const centralChunks = [];
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014B50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.offset, 42);
    centralChunks.push(header, entry.name);
  }
  const centralBuffer = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

/** 没有 LLM 时的发布文案兜底：标题/策略/前两句口播 + 账号品类标签。 */
export function buildPublishCopy({ work, script, profile } = {}) {
  const title = normalizeText(script?.title || work?.title || work?.brief || '未命名视频').slice(0, 60);
  const voiceovers = (Array.isArray(script?.shots) ? script.shots : [])
    .map((shot) => normalizeText(shot.voiceover))
    .filter(Boolean);
  const description = normalizeText([
    script?.strategy,
    voiceovers.slice(0, 2).join(' '),
  ].filter(Boolean).join('\n')).slice(0, 300);
  const rawTags = [
    work?.typeLabel,
    work?.subtype,
    profile?.product,
    '教育',
    '招生',
    '家长必看',
  ];
  const tags = [];
  for (const raw of rawTags) {
    const value = normalizeText(raw).replace(/^#/, '').slice(0, 16);
    if (value && !tags.includes(value)) tags.push(value);
    if (tags.length >= 6) break;
  }
  return { title, description, tags };
}

export function packageMarkdown({ work, title, description, tags, options, duration }) {
  const subtitleLabel = { none: '不烧字幕', white: '白字黑边', yellow: '黄字黑边', bold: '大字报' }[options?.subtitleStyle] || '白字黑边';
  return [
    `# ${title}`,
    '',
    '## 发布标题',
    title,
    '',
    '## 发布描述',
    description || '（未填写）',
    '',
    '## 话题标签',
    (tags || []).map((tag) => `#${tag}`).join(' ') || '（未填写）',
    '',
    '## 视频参数',
    `- 时长：${Math.round(Number(duration) || 0)} 秒`,
    `- 画幅：${work?.ratio || '9:16'}`,
    `- 清晰度：${work?.resolution || '默认'}`,
    `- 字幕：${subtitleLabel}`,
    `- BGM：${options?.bgmAssetId ? '已混入' : '无'}`,
    '',
    '## 发布前检查',
    '- [ ] 成片已完整预览',
    '- [ ] 封面标题无错别字，封面文字未被裁切',
    '- [ ] 描述和标签符合账号定位',
    '- [ ] 教育合规：不承诺保过/提分/名额，不使用“最”“第一”等绝对化用语',
    '- [ ] 发布账号和发布时间已确认',
    '',
  ].join('\n');
}
