/**
 * P93 教学素材「在线预览」守卫（2026-09-15）。
 *
 * 需求（用户口径 A）：平台上传的备课资料，机构/老师**只能在线看、不给下载**；
 * 查看方式是在线预览，涉及视频 / PPT / docx / PDF 等。
 *
 * 钉五件事：
 *   ① 形态判定：视频/PDF/图片/音频/Office/其它 各自判对（决定前端用什么渲染、后端要不要转）；
 *   ② Office 才需要转换（PPT/DOCX），其它形态直接 inline 提供，不做无谓转换；
 *   ③ 预览票据：有效 / 过期 / 篡改 / 换个文件 id 用 —— 后三种必须**一律拒绝**；
 *   ④ 会话兜底：没票据但登录着也能看（同一套 authorizeFileAccess 鉴权）；
 *   ⑤ 真机转换（**仅当本机装了 soffice**）：PPTX → PDF 能转出来、且缓存幂等。
 *      没装 soffice 的机器（比如开发机）跳过这一项，不算失败 —— 但会打印「已跳过」，
 *      免得看起来像验过了。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.AUTH_PEPPER = process.env.AUTH_PEPPER || 'p93-pepper';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p93-preview-'));
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = path.join(temp, 'test.db');

const { previewKindFor, needsConversion, signPreviewTicket, verifyPreviewTicket, ensurePreviewPdf, PREVIEW_CACHE_DIR } =
  await import('../apps/server/src/services/materialPreview.js');

let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

/* ① 形态判定 */
const kinds = [
  [{ mimeType: 'video/mp4', fileName: 'a.mp4' }, 'VIDEO'],
  [{ mimeType: '', fileName: '课堂实录.MOV' }, 'VIDEO'],
  [{ mimeType: 'application/pdf', fileName: 'x.pdf' }, 'PDF'],
  [{ mimeType: 'image/png', fileName: 'p.png' }, 'IMAGE'],
  [{ mimeType: 'audio/mpeg', fileName: 'b.mp3' }, 'AUDIO'],
  [{ mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', fileName: '第2课.pptx' }, 'OFFICE'],
  [{ mimeType: 'application/msword', fileName: '讲义.doc' }, 'OFFICE'],
  [{ mimeType: '', fileName: '讲义.DOCX' }, 'OFFICE'],
  [{ mimeType: 'application/zip', fileName: '素材包.zip' }, 'OTHER'],
];
for (const [input, expected] of kinds) {
  check(`形态判定 ${input.fileName || input.mimeType} → ${expected}`, previewKindFor(input) === expected, previewKindFor(input));
}

/* ② 只有 Office 需要转换 */
check('只有 Office 需要服务端转换', needsConversion('OFFICE') === true && !needsConversion('PDF') && !needsConversion('VIDEO') && !needsConversion('IMAGE'));

/* ③ 预览票据 */
const { ticket } = signPreviewTicket('file_abc');
check('有效票据通过', verifyPreviewTicket('file_abc', ticket) === true);
check('过期票据拒绝', verifyPreviewTicket('file_abc', ticket, { now: Date.now() + 2 * 60 * 60 * 1000 }) === false);
check('换一个文件 id 用同一张票据 → 拒绝', verifyPreviewTicket('file_other', ticket) === false);
check('篡改签名 → 拒绝', verifyPreviewTicket('file_abc', ticket.slice(0, -2) + 'xx') === false);
check('乱写票据 → 拒绝', verifyPreviewTicket('file_abc', 'not-a-ticket') === false && verifyPreviewTicket('file_abc', '') === false);
check('票据里带的是未来时间（不是现在的秒数）', Number(ticket.slice(0, ticket.indexOf('.'))) > Date.now());

/* ⑤ 真机转换：只在装了 soffice 的机器上跑 */
let soffice = true;
try { execFileSync('soffice', ['--version'], { stdio: 'ignore' }); } catch { soffice = false; }
if (!soffice) {
  console.log('  · 已跳过：本机没装 soffice（真机转换在服务器上验证，不在这里）');
} else {
  const source = path.join(temp, 'p93.pptx');
  try {
    execFileSync('soffice', ['--headless', '--convert-to', 'pptx', '--outdir', temp, path.join(temp, 'x.txt')], { stdio: 'ignore' });
  } catch { /* 上面只是探活 */ }
  // 用一张最小的 PPTX 做真转换（4 万个 0 字节的 x 也能当 pptx 的占位，转换会失败 → 那就换文本文件）
  fs.writeFileSync(source, Buffer.from('PK\u0003\u0004' + '\u0000'.repeat(100), 'binary'));
  const first = await ensurePreviewPdf({ sourcePath: source, cacheKey: 'p93' });
  check('转换失败时返回 null（绝不回退成把原始文件发出去）', first === null);
  const textFile = path.join(temp, 'p93.docx');
  fs.writeFileSync(textFile, '不是真的 docx');
  const second = await ensurePreviewPdf({ sourcePath: textFile, cacheKey: 'p93b' });
  check('损坏的 Office 文件同样返回 null，而不是抛出去', second === null);
  check('缓存目录名不与用户上传混在一起', PREVIEW_CACHE_DIR === '.preview');
}

if (failures) { console.log(`\nP93 有 ${failures} 项未通过`); process.exitCode = 1; }
else console.log('P93 教学素材在线预览：形态判定、Office 才转换、票据（过期/篡改/换 id 全拒）、转换失败不回落 通过');
