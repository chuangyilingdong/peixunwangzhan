/**
 * P162 机构手册「政策」一栏（地区卡，按地区排）—— 用户 2026-09-28 口径。
 *
 * 原话：「图4图5是机构手册页面的内容需要调整改造下」+ 给了一批各地「推进中小学人工智能教育」的
 * 公告截图（北上广深浙率先 + 全国各地区跟进），形状定成 **地区卡（按地区排）**。
 *
 * 这一栏**不是纯文案**，它有三份必须互相对齐的东西，任何一份漂了都会以"看着像没事"的方式坏掉：
 *   ① **官网组件**要真的渲染这一段（`hb-policy`，位置在「关于」之后）；
 *   ② **共享默认值**（`packages/shared/src/siteDefaults.js` 的 `HANDBOOK_POLICY_DEFAULT`）
 *      —— 官网接口不通时渲染它、**后台表单也用它预填**；
 *   ③ **数据库种子那份**（`packages/database/src/websiteContentDefaults.js`，零依赖**手抄**）
 *      —— 新库初始化用的就是它。②③ 不一致 = 同一个页面**新库与老库显示两套内容**。
 * 另外卡片图是**自托管**的（站点 CSP 是 `default-src 'self'`，外链会被挡成空白），
 * 而且必须是**真 webp、1200×676** —— 路径写对、文件是占位图/别的尺寸，看着也不报错。
 *
 * ⚠️ 真观感（网格排布、卡片图取景）由真浏览器核：/handbook 是公开页，直接打开截图即可。
 * ⚠️ 判"某段代码在不在"之前先剥注释（这个仓库的守卫踩过好几次：注释里常原样引用被删的代码）。
 */
import fs from 'node:fs';
import { stripComments } from './lib/sourceText.mjs';

const root = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ── ① 官网组件：这一段真的在、而且在「关于」之后 ───────────────────────── */
const site = stripComments(read('apps/website/src/main.jsx'));
const css = read('apps/website/src/styles.css');
check('① 官网渲染「政策」区块（hb-policy）与地区卡（hb-policy__card / hb-policy__region）',
  site.includes('className="hb-policy hb-reveal"') && site.includes('hb-policy__card') && site.includes('hb-policy__region'));
check('① 位置在「关于」之后（用户口径的顺序：主视觉 → 关于 → **政策** → 海报 → …）',
  site.indexOf('className="hb-policy hb-reveal"') > site.indexOf('className="hb-about"')
  && site.indexOf('className="hb-policy hb-reveal"') < site.indexOf('className="hb-poster'));
check('① 官网兜底**引用共享那一份**，不再抄第三份（"policy":HANDBOOK_POLICY_DEFAULT）',
  site.includes('"policy":HANDBOOK_POLICY_DEFAULT') && site.includes('HANDBOOK_POLICY_DEFAULT'));
check('① 样式：纸色底 + 多列自适应网格（与 about / poster 同一块底色，不切断层）',
  /\.hb-policy\{[^}]*background:var\(--hb-paper\)/.test(css)
  && /\.hb-policy__grid\{[^}]*grid-template-columns:repeat\(auto-fill/.test(css));

/* ── ② 共享默认值：11 个地区、字段齐全、顺序固定 ───────────────────────── */
const { HANDBOOK_POLICY_DEFAULT } = await import('../packages/shared/src/siteDefaults.js');
const EXPECTED = ['北京', '上海', '广东', '深圳', '浙江', '天津', '重庆', '江苏', '福建', '山东', '西安'];
const cards = Array.isArray(HANDBOOK_POLICY_DEFAULT?.cards) ? HANDBOOK_POLICY_DEFAULT.cards : [];
check(`② 默认值里有 ${EXPECTED.length} 个地区，且顺序是「先北上广深浙、再其余按时间」`,
  cards.map((card) => card.region).join(',') === EXPECTED.join(','),
  `实际 ${cards.map((card) => card.region).join(',')}`);
check('② 每张卡字段齐全（地区 / 文件全名 / 一行注 / 卡片图 / 图说）',
  cards.every((card) => card.region && card.title && card.note && card.imageUrl && card.imageAlt));
check('② 区块本身也有眉题 + 两行标题 + 正文',
  Boolean(HANDBOOK_POLICY_DEFAULT.eyebrow) && (HANDBOOK_POLICY_DEFAULT.headingLines || []).length === 2 && Boolean(HANDBOOK_POLICY_DEFAULT.body));

/* ── ③ 数据库种子那份必须逐字段一致（手抄的那一份最容易漂）────────────── */
const seed = await import('../packages/database/src/websiteContentDefaults.js');
const seedPolicy = seed.WEBSITE_CONTENT_DEFAULTS?.HANDBOOK?.policy;
check('③ 数据库种子里有这一块，且与共享那份**逐字段一致**',
  JSON.stringify(seedPolicy) === JSON.stringify(HANDBOOK_POLICY_DEFAULT),
  seedPolicy ? '两份内容不同（改一边忘另一边 = 新库与老库显示两套内容）' : '数据库种子里没有 policy');

/* ── ④ 卡片图：自托管 + 真 webp + 1200×676 ─────────────────────────────
   CSP 是 `default-src 'self'`，外链图会被挡成空白；而"路径写对了、文件却是占位或别的尺寸"
   页面上不报错、只是难看 —— 所以这里既看地址，也**解开文件头量尺寸**。 */
const webpSize = (buf) => {
  if (buf.length < 30 || buf.slice(0, 4).toString() !== 'RIFF' || buf.slice(8, 12).toString() !== 'WEBP') return null;
  const kind = buf.slice(12, 16).toString();
  if (kind === 'VP8X') return { kind, w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (kind === 'VP8L') { const bits = buf.readUInt32LE(21); return { kind, w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) }; }
  if (kind === 'VP8 ') return { kind, w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  return null;
};

const badPath = cards.filter((card) => !/^\/assets\/handbook\/policy-[a-z0-9-]+\.webp$/.test(String(card.imageUrl || '')));
check('④ 每张卡图都是**本站** /assets/handbook/policy-*.webp（外链会被 CSP 挡成空白）', badPath.length === 0,
  badPath.map((card) => `${card.region}:${card.imageUrl}`).join(' '));
const missing = [];
const wrongSize = [];
const notWebp = [];
for (const card of cards) {
  const rel = String(card.imageUrl).replace(/^\//, 'apps/website/public/');
  let buf = null;
  try { buf = fs.readFileSync(new URL(rel, root)); } catch { missing.push(card.region); continue; }
  const size = webpSize(buf);
  if (!size) { notWebp.push(card.region); continue; }
  if (size.w !== 1200 || size.h !== 676) wrongSize.push(`${card.region}:${size.w}x${size.h}`);
}
check('④ 11 张卡图都在仓库里', missing.length === 0, missing.join(' '));
check('④ 都是**真 webp**（不是占位/HTML 兜底）', notWebp.length === 0, notWebp.join(' '));
check('④ 尺寸统一 1200×676（官网按这个比例铺满，尺寸不对会被裁得难看）', wrongSize.length === 0, wrongSize.join(' '));
const tooSmall = cards.filter((card) => {
  const rel = String(card.imageUrl).replace(/^\//, 'apps/website/public/');
  try { return fs.statSync(new URL(rel, root)).size < 8 * 1024; } catch { return false; }
}).map((card) => card.region);
check('④ 每张图都像真截图（> 8KB，挡"一张空白的极简 webp"）', tooSmall.length === 0, tooSmall.join(' '));

/* ── ⑤ 后台能配：默认值预填 + 增删 + 上传（不然运营一改就把内置 11 张冲掉）──── */
const admin = stripComments(read('apps/admin/src/pages/WebsiteContent.jsx'));
check('⑤ 后台表单有这一块，且用共享默认值**预填**（草稿里没有时不能让列表是空的）',
  admin.includes('HANDBOOK_POLICY_DEFAULT') && /const policyBlock = structured\?\.policy[\s\S]{0,120}HANDBOOK_POLICY_DEFAULT/.test(admin)
  && /function updatePolicy\(patch\)/.test(admin));
check('⑤ 后台能增删与排序地区、能传卡片图',
  admin.includes('新增地区') && /function addPolicyCard\(\)/.test(admin) && /function movePolicyCard\(/.test(admin) && /function removePolicyCard\(/.test(admin)
  && /hb-policy-\$\{index\}/.test(admin));
check('⑤ 草稿预览里也认这一块（否则"后台预览"与官网不一致）',
  /政策地区卡 \{policyCards\.length\} 张/.test(admin));

console.log('');
if (failures) { console.log(`✗ p162 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p162 机构手册「政策」地区卡：全部通过');
