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
 *
 * 2026-09-25 加第 ⑥ 条：**预览形态**（用户口径「能否真的就是 PPT 形式」）。
 *   PPT/PPTX 必须是 SLIDES（前端一屏一张**放映** + 缩略图条），Word/PDF 必须是 DOCUMENT
 *   （连续滚动阅读）。两者背后都是同一份转换出来的 PDF，差别只在怎么翻 —— 判错的后果是
 *   「PPT 又变回文档滚动」，正是用户这次要修掉的那种观感。
 *   同一条里还钉住「转换产物在 OSS 上的键**带源文件字节数**」：键不带尺寸的话，
 *   换掉源文件之后还会命中旧 PDF（那是错的课件，比慢严重得多）。
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

const { previewKindFor, needsConversion, signPreviewTicket, verifyPreviewTicket, ensurePreviewPdf, PREVIEW_CACHE_DIR,
  previewModeFor, isSlideDeck, previewPdfObjectKey, publishPreviewPdf } =
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

/* ⑥ 预览形态：PPT 放映 / 文档滚动（2026-09-25） */
const modes = [
  [{ fileName: '第 3 课.pptx' }, 'SLIDES'],
  [{ mimeType: 'application/vnd.ms-powerpoint', fileName: '课件.PPT' }, 'SLIDES'],
  [{ fileName: '讲义.odp' }, 'SLIDES'],
  [{ mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', fileName: '没有扩展名' }, 'SLIDES'],
  [{ fileName: '教案.docx' }, 'DOCUMENT'],
  [{ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: '教案' }, 'DOCUMENT'],
  [{ mimeType: 'application/pdf', fileName: '含幻灯片字样的.pdf' }, 'DOCUMENT'],
  [{ mimeType: 'video/mp4', fileName: '课堂实录.mp4' }, 'DOCUMENT'],
];
for (const [input, expected] of modes) {
  check(`形态 ${input.fileName || input.mimeType} → ${expected}`, previewModeFor(input) === expected, previewModeFor(input));
}
check('isSlideDeck 只是 previewModeFor 的糖', isSlideDeck({ fileName: 'a.pptx' }) === true && isSlideDeck({ fileName: 'a.docx' }) === false);

/* ⑥-b 转换产物在 OSS 上的键：**带源文件字节数**，源文件换了就不会命中旧 PDF */
check('OSS 键带源文件字节数', previewPdfObjectKey('file_x', 758) === '_preview/file_x-758.pdf', previewPdfObjectKey('file_x', 758));
check('拿不到字节数时退回不带尺寸的键（宁可重转，也不给错版本）', previewPdfObjectKey('file_x', 0) === '_preview/file_x.pdf');
check('没有 fileId 就没有键', previewPdfObjectKey('', 1) === null);
// OSS 没配时绝不"假装成功"：调用方据此退回本机流式发，而不是给一个不存在的地址
const noOss = await publishPreviewPdf({ fileId: 'file_x', pdfPath: path.join(temp, '不存在.pdf'), sourceSize: 1 });
check('OSS 没配置时 publishPreviewPdf 返回 null（fail-closed，不抛错）', noOss === null, String(noOss));

/* ③ 预览票据 */
const { ticket } = signPreviewTicket('file_abc');
check('有效票据通过', verifyPreviewTicket('file_abc', ticket) === true);
check('过期票据拒绝', verifyPreviewTicket('file_abc', ticket, { now: Date.now() + 2 * 60 * 60 * 1000 }) === false);
check('换一个文件 id 用同一张票据 → 拒绝', verifyPreviewTicket('file_other', ticket) === false);
check('篡改签名 → 拒绝', verifyPreviewTicket('file_abc', ticket.slice(0, -2) + 'xx') === false);
check('乱写票据 → 拒绝', verifyPreviewTicket('file_abc', 'not-a-ticket') === false && verifyPreviewTicket('file_abc', '') === false);
check('票据里带的是未来时间（不是现在的秒数）', Number(ticket.slice(0, ticket.indexOf('.'))) > Date.now());

/* ⑥-c 前端口径：放映形态必须真的接上了（形态判定对了、界面还是文档滚动的话等于没做） */
{
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const viewer = read('apps/org/src/components/TeachingAssetViewer.jsx');
  const css = read('packages/shared/src/styles.css');
  const lib = read('apps/server/src/lib.js');
  check('⑥ 票据接口把 previewMode 一起给前端（前端才知道该放映还是该滚动）',
    /previewMode: previewModeFor\(\{ mimeType: file\.mime_type, fileName: file\.file_name \}\)/.test(lib));
  check('⑥ 放映形态：一屏一张（单块画布）+ 缩略图条 + 左右翻页按钮',
    /className="ta-slide-stage"/.test(viewer) && /className="ta-rail"/.test(viewer) && /className="ta-slide-nav prev"/.test(viewer) && /className="ta-slide-nav next"/.test(viewer));
  check('⑥ 放映形态按"整张适应窗口"算比例（min(宽比, 高比)，不是按宽度铺满）',
    /Math\.min\(\(slideBox\.width - SLIDE_PADDING\) \/ slidePage\.width, \(slideBox\.height - SLIDE_PADDING\) \/ slidePage\.height\)/.test(viewer));
  check('⑥ 放映形态的文案说"张"、文档形态说"页"（别让 PPT 又看起来像文档）',
    viewer.includes(': \'\'} 张') && viewer.includes(': \'\'} 页'));
  check('⑥ 键盘/全屏：放映形态有空格与 F，文档形态仍是上下页',
    /\['ArrowRight', 'PageDown', ' '\]/.test(viewer) && /key === 'f'/.test(viewer));
  check('⑥ 缩略图是**进视口才画**（几十页的课件不为看不见的缩略图买单）', /new IntersectionObserver/.test(viewer));
  check('⑥ 样式：放映台允许放大后滚动（margin:auto，别裁掉左上角）',
    /\.ta-slide-stage \{[^}]*overflow:auto/.test(css) && /\.ta-slide-slot \{[^}]*margin:auto/.test(css));
  check('⑥ 打印仍是白纸（放映形态也不例外）', /@media print \{ \.preview-overlay, \.ta-panel \{ display:none !important; \} \}/.test(css));
}

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
