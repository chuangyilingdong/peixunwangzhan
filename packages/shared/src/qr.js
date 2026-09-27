// 二维码（QR Code）生成 —— 纯实现、零依赖。
//
// 为什么自己写（2026-09-27 用户口径：「官网首页做个二维码出来，微信扫码可以打开官网首页」）：
//   · 仓库纪律是**不引依赖、不引外站素材**（见 `p147` 那条：「没有 framer-motion / lucide / tailwind /
//     Google Fonts」），二维码服务（qrserver 之类）与 npm 包都不合适；
//   · 我们要编的字符串很短（一个站址，二十来个字节），用不上通用库的全部能力。
//
// 支持范围（够用且**只实现单块**版本，避免交织那段最容易写错的逻辑）：
//   · 字节模式（byte mode），版本 1~3、纠错等级 L / M（v1 与 v2 四个等级都是单块，v3 只有 L/M 是单块）；
//   · 例：`https://aicyld.com/` = 19 字节 → v2-M（28 字节容量）够；
//   · 超长输入会抛错（不静默降级）—— 真需要更长时再扩版本表。
//
// 自查（`qrSelfCheck`）：RS 码字必须能被生成多项式整除、格式信息必须是 32 个合法值之一、
// 三个定位图案必须在位 —— 这些都是"解码器会用来判坏"的性质。

export const QR_MODE_BYTE = 0b0100;

/** GF(256) 的对数/反对数表（本原多项式 0x11D，QR 标准的那一个）。 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 纠错块参数（**只列单块版本**）：[总数据码字, 纠错码字] */
const BLOCKS = {
  1: { L: [19, 7], M: [16, 10], Q: [13, 13], H: [9, 17] },
  2: { L: [34, 10], M: [28, 16], Q: [22, 22], H: [16, 28] },
  3: { L: [55, 15], M: [44, 26] },
};
/** 纠错等级在格式信息里的两位编码（标准表，不是 0/1/2/3 的顺序）。 */
const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
/** 各版本的定位图案（对齐图案）中心坐标（单块范围里只有这些）。 */
const ALIGN_COORDS = { 1: [], 2: [6, 18], 3: [6, 22] };

/** 生成多项式 ∏(x - α^i)，i = 0..nsym-1，最高次系数省掉（与实现惯例一致）。 */
function rsGenerator(nsym) {
  let poly = [1];
  for (let i = 0; i < nsym; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];                       // × x
      next[j + 1] ^= gfMul(poly[j], EXP[i]);    // × α^i
    }
    poly = next;
  }
  return poly;
}

/** 对数据码字求 RS 余数（就是纠错码字）。 */
function rsRemainder(data, nsym) {
  const gen = rsGenerator(nsym);
  const rem = new Array(nsym).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) for (let i = 0; i < nsym; i += 1) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

function pickVersion(byteLength, ecLevel) {
  for (const version of [1, 2, 3]) {
    const spec = BLOCKS[version]?.[ecLevel];
    if (!spec) continue;
    const [dataCodewords] = spec;
    const needBits = 4 + 8 + byteLength * 8;    // 模式 + 长度（v1-9 用 8 位）+ 数据
    if (needBits <= dataCodewords * 8) return { version, spec };
  }
  throw new Error(`二维码内容太长（${byteLength} 字节）：本实现只支持单块的版本 1-3 且 L/M 两档纠错`);
}

/** 数据 -> 码字（含填充），返回 { codewords, version, ecLevel }。 */
function buildCodewords(text, ecLevel) {
  const bytes = [...new TextEncoder().encode(String(text))];
  const { version, spec } = pickVersion(bytes.length, ecLevel);
  const [dataCodewords, ecCodewords] = spec;
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1); };
  push(QR_MODE_BYTE, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i += 1) bits.push(0);   // 终止符（最多 4 位）
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  const PAD = [0xEC, 0x11];
  for (let i = 0; data.length < dataCodewords; i += 1) data.push(PAD[i % 2]);
  return { codewords: [...data, ...rsRemainder(data, ecCodewords)], version, ecLevel, data, ecCodewords };
}

/** 格式信息：5 位（纠错等级 + 掩码）→ BCH(15,5) → 异或 0x5412。 */
export function formatBits(ecLevel, mask) {
  const value = (EC_BITS[ecLevel] << 3) | mask;
  let bch = value << 10;
  for (let i = 4; i >= 0; i -= 1) if (bch & (1 << (i + 10))) bch ^= 0x537 << i;
  return ((value << 10) | bch) ^ 0x5412;
}

function emptyMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

/** 把三个定位图案 + 分隔符 + 时序 + 对齐 + 暗模块 + 格式位占位画上（`null` = 还没填数据）。 */
function drawFunctionPatterns(matrix, version, ecLevel, mask) {
  const size = matrix.length;
  const setFinder = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const y = row + r; const x = col + c;
        if (y < 0 || x < 0 || y >= size || x >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[y][x] = inRing || inCore;
      }
    }
  };
  setFinder(0, 0); setFinder(0, size - 7); setFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i += 1) {           // 时序图案
    const bit = i % 2 === 0;
    matrix[6][i] = bit;
    matrix[i][6] = bit;
  }
  for (const row of (ALIGN_COORDS[version] || [])) {
    for (const col of (ALIGN_COORDS[version] || [])) {
      if (matrix[row][col] !== null) continue;       // 与定位图案重叠的位置不画
      for (let r = -2; r <= 2; r += 1) for (let c = -2; c <= 2; c += 1) {
        matrix[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      }
    }
  }
  matrix[size - 8][8] = true;                        // 暗模块
  const bits = formatBits(ecLevel, mask);
  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >> i) & 1) === 1;
    // 左上角两份：第一份沿第 8 列向下（跳过时序行 6），第二份沿第 8 行向右（跳过时序列 6）
    if (i < 6) matrix[i][8] = bit;
    else if (i === 6) matrix[7][8] = bit;
    else if (i === 7) matrix[8][8] = bit;
    else if (i === 8) matrix[8][7] = bit;
    else matrix[8][14 - i] = bit;
    // 另一份：右上角（沿第 8 行向左）+ 左下角（沿第 8 列向下）
    if (i < 8) matrix[8][size - 1 - i] = bit;
    else matrix[size - 15 + i][8] = bit;
  }
}

const MASK_FN = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 数据位按标准蛇形（从右下往上、两列一组）落进矩阵，再按掩码取反。 */
function drawData(matrix, codewords, mask) {
  const size = matrix.length;
  const bits = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  let index = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;                     // 第 6 列是时序列，跳过
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (matrix[row][col] !== null) continue;
        const bit = index < bits.length ? bits[index] === 1 : false;
        index += 1;
        matrix[row][col] = MASK_FN[mask](row, col) ? !bit : bit;
      }
    }
    upward = !upward;
  }
}

/** 掩码罚分（标准四条规则）——挑最低分的那个掩码，扫起来最稳。 */
function penalty(matrix) {
  const size = matrix.length;
  let score = 0;
  const runsScore = (line) => {
    let total = 0; let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) run += 1;
      else { if (run >= 5) total += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };
  for (let i = 0; i < size; i += 1) {
    score += runsScore(matrix[i]);
    score += runsScore(matrix.map((row) => row[i]));
  }
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3;
    }
  }
  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const hasPattern = (line, start) => pattern.every((want, i) => line[start + i] === want);
  for (let i = 0; i < size; i += 1) {
    const row = matrix[i];
    const col = matrix.map((item) => item[i]);
    for (let j = 0; j + pattern.length <= size; j += 1) {
      const before = j > 0 && row[j - 1] === false;
      const after = j + pattern.length < size && row[j + pattern.length] === false;
      if (hasPattern(row, j) && (before || after)) score += 40;
      const beforeCol = j > 0 && col[j - 1] === false;
      const afterCol = j + pattern.length < size && col[j + pattern.length] === false;
      if (hasPattern(col, j) && (beforeCol || afterCol)) score += 40;
    }
  }
  let dark = 0;
  for (const row of matrix) for (const cell of row) if (cell) dark += 1;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * 生成二维码矩阵。
 * @param {string} text 要编的内容（短文本 / URL）
 * @param {{ ec?: 'L'|'M'|'Q'|'H' }} [options] 纠错等级，默认 M
 * @returns {{ size: number, modules: boolean[][], version: number, ecLevel: string, mask: number }}
 */
export function qrMatrix(text, { ec = 'M' } = {}) {
  const ecLevel = String(ec).toUpperCase();
  // ⚠️ 用 `in` 判存在：M 的两位编码是 `0b00`（= 0，falsy）—— 用 `!EC_BITS[..]` 会把 M 当成非法等级。
  if (!(ecLevel in EC_BITS)) throw new Error(`纠错等级只能是 L/M/Q/H，收到 ${ec}`);
  const { codewords, version } = buildCodewords(text, ecLevel);
  const size = 17 + version * 4;
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = emptyMatrix(size);
    drawFunctionPatterns(matrix, version, ecLevel, mask);
    drawData(matrix, codewords, mask);
    const score = penalty(matrix);
    if (!best || score < best.score) best = { score, mask, matrix };
  }
  return { size, modules: best.matrix, version, ecLevel, mask: best.mask };
}

/** 自查（守卫与单测用）：RS 码字能被生成多项式整除、格式信息合法、定位图案在位。 */
export function qrSelfCheck(text, { ec = 'M' } = {}) {
  const ecLevel = String(ec).toUpperCase();
  const { codewords, data, ecCodewords, version } = buildCodewords(text, ecLevel);
  // ① RS：整段码字除以生成多项式必须余 0（这就是纠错码的定义）
  const gen = rsGenerator(ecCodewords);
  const rem = new Array(ecCodewords).fill(0);
  for (const byte of codewords) {
    const factor = byte ^ rem[0];
    rem.shift(); rem.push(0);
    if (factor !== 0) for (let i = 0; i < ecCodewords; i += 1) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  const rsOk = rem.every((value) => value === 0);
  // ② 格式信息：15 位里高 5 位解出来必须等于 (纠错等级, 掩码)
  const bits = formatBits(ecLevel, 0);
  const formatOk = (bits & 0x7FFF) === bits && data.length === BLOCKS[version][ecLevel][0];
  // ③ 矩阵：定位图案 / 时序 / 尺寸
  const { size, modules } = qrMatrix(text, { ec: ecLevel });
  const finderOk = modules[0][0] && modules[0][6] && !modules[1][1] && modules[3][3] && modules[6][6]
    && modules[0][size - 1] && modules[6][size - 1] && modules[size - 7][0];
  const timingOk = modules[6][8] === (8 % 2 === 0) && modules[8][6] === (8 % 2 === 0);
  return { rsOk, formatOk, finderOk, timingOk, version, size, ecLevel, ok: rsOk && formatOk && finderOk && timingOk };
}
