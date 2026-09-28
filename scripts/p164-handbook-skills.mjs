/**
 * P164 机构手册「跨学科知识融合，综合能力培养」一栏 —— 用户 2026-09-28 口径。
 *
 * 原话：「机构手册这个图1页面的上方增加一个板块"跨学科知识融，综合能力培养"，内容参考图2和图3」
 *   · 图1 = **海报**那段（「为什么现在就是开 AI 课的好时机？」）→ 所以这一栏要在它**上方**；
 *   · 图2 = 学科领域 / 具体知识点那张表（语文 / 美术 / 信息技术 / 逻辑与数学 / 音乐·节奏）；
 *   · 图3 = 综合能力实践培养那四条（主动创造 / 分解任务 / 与 AI 协作 / 成长型思维）。
 * ⚠️ 用户标题写的是「知识融」，图2 上写的是「知识**融合**」—— 按图上那份取。
 *
 * 这一栏与政策那栏同一条做法，也有三份必须对齐的东西（漂了都以"看着像没事"的方式坏掉）：
 *   ① 官网组件要真的渲染（`hb-skills`，位置在 policy 之后、**poster 之前**）；
 *   ② 共享默认值（`packages/shared/src/siteDefaults.js` 的 `HANDBOOK_SKILLS_DEFAULT`）——
 *      官网接口不通时渲染它、**后台表单也用它预填**；
 *   ③ 数据库种子那份（零依赖手抄）—— 新库初始化用它；②③ 不一致 = 新库与老库显示两套内容。
 * 另外这一栏的内容是**排出来的文字**（学科表 + 能力清单），不是截图 —— 所以它既不该有图片字段，
 * 也不该退化成"放一张图"。窄屏折成一列这条也一并钉住。
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

/* ── ① 官网渲染 + 位置（在海报上方）───────────────────────────────────── */
const site = stripComments(read('apps/website/src/main.jsx'));
const css = read('apps/website/src/styles.css');
check('① 官网渲染这一栏（hb-skills + 学科表 hb-skills__row + 能力清单 hb-skills__list）',
  site.includes('className="hb-skills hb-reveal"') && site.includes('hb-skills__row') && site.includes('hb-skills__list'));
const skillsAt = site.indexOf('className="hb-skills hb-reveal"');
check('① 位置在**海报上方**（用户口径：图1 那个页面的上方）',
  skillsAt > 0 && skillsAt < site.indexOf('className="hb-poster hb-reveal"'),
  `skills@${skillsAt} poster@${site.indexOf('className="hb-poster hb-reveal"')}`);
check('① 官网兜底引用共享那一份（不抄第二份）',
  site.includes('"skills":HANDBOOK_SKILLS_DEFAULT') && site.includes('HANDBOOK_SKILLS_DEFAULT'));
check('① 内容用**真正的表格与清单**排（不是放一张图），并且有面板小标题（第二行描边）',
  site.includes('className="hb-skills__table"') && site.includes('className="hb-skills__label"')
  && !/hb-skills[\s\S]{0,400}?<img/.test(site));
check('① 样式：纸色底 + 两列；窄屏折成一列',
  /\.hb-skills\{[^}]*background:var\(--hb-paper\)/.test(css)
  && /\.hb-skills__cols\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/.test(css)
  && /@media\(max-width:901px\)\{\.hb-skills__cols\{grid-template-columns:minmax\(0,1fr\)\}/.test(css));

/* ── ② 共享默认值：内容与用户给的图对得上 ────────────────────────────── */
const { HANDBOOK_SKILLS_DEFAULT } = await import('../packages/shared/src/siteDefaults.js');
const subjects = Array.isArray(HANDBOOK_SKILLS_DEFAULT?.subjects) ? HANDBOOK_SKILLS_DEFAULT.subjects : [];
const abilities = Array.isArray(HANDBOOK_SKILLS_DEFAULT?.abilities) ? HANDBOOK_SKILLS_DEFAULT.abilities : [];
check('② 学科表 = 图2 那五行（语文 / 美术 / 信息技术 / 逻辑与数学 / 音乐·节奏）',
  subjects.map((row) => row.subject).join(',') === '语文,美术,信息技术,逻辑与数学,音乐 / 节奏',
  subjects.map((row) => row.subject).join(','));
check('② 每条学科都有具体知识点，且与图2 对得上（抽查两条）',
  subjects.every((row) => row.points)
  && (subjects[0]?.points || '').includes('起承转合')
  && (subjects[2]?.points || '').includes('训练数据'));
check('② 能力清单 = 图3 那四条',
  abilities.length === 4
  && abilities[0]?.title?.includes('主动创造')
  && abilities[1]?.title?.includes('分解')
  && abilities[2]?.title?.includes('与 AI 协作')
  && abilities[3]?.title?.includes('成长型思维'),
  abilities.map((item) => item.title).join(' / '));
check('② 每条能力都有说明，且抽查两条与图3 一致（"我指挥 AI" / "失败是迭代的一部分"）',
  abilities.every((item) => item.desc)
  && (abilities[2]?.desc || '').includes('我指挥 AI')
  && (abilities[3]?.desc || '').includes('失败是迭代的一部分'));
check('② 区块本身有眉题 + 两行标题（用户给的标题就是这两行）',
  Boolean(HANDBOOK_SKILLS_DEFAULT.eyebrow)
  && (HANDBOOK_SKILLS_DEFAULT.headingLines || []).join('') === '跨学科知识融合，综合能力培养',
  (HANDBOOK_SKILLS_DEFAULT.headingLines || []).join(''));

/* ── ③ 数据库种子那份逐字段一致 ─────────────────────────────────────── */
const seed = await import('../packages/database/src/websiteContentDefaults.js');
const seedSkills = seed.WEBSITE_CONTENT_DEFAULTS?.HANDBOOK?.skills;
check('③ 数据库种子里有这一块，且与共享那份**逐字段一致**',
  JSON.stringify(seedSkills) === JSON.stringify(HANDBOOK_SKILLS_DEFAULT),
  seedSkills ? '两份内容不同（改一边忘另一边 = 新库与老库显示两套内容）' : '数据库种子里没有 skills');

/* ── ④ 后台能配：默认值预填 + 增删排序 ──────────────────────────────── */
const admin = stripComments(read('apps/admin/src/pages/WebsiteContent.jsx'));
check('④ 后台表单有这一块，且用共享默认值**预填**（否则运营一改就把内置内容冲掉）',
  admin.includes('HANDBOOK_SKILLS_DEFAULT') && /const skillsBlock = structured\?\.skills[\s\S]{0,120}HANDBOOK_SKILLS_DEFAULT/.test(admin)
  && /function updateSkills\(patch\)/.test(admin));
check('④ 后台能增删与排序学科、也能增删与排序能力',
  admin.includes('新增学科') && admin.includes('新增能力')
  && /function addSkillSubject\(\)/.test(admin) && /function moveSkillSubject\(/.test(admin) && /function removeSkillSubject\(/.test(admin)
  && /function addSkillAbility\(\)/.test(admin) && /function moveSkillAbility\(/.test(admin) && /function removeSkillAbility\(/.test(admin));
check('④ 草稿预览里也认这一块（否则"后台预览"与官网不一致）',
  /跨学科与综合能力：\{subjects\.length\} 个学科/.test(admin));

console.log('');
if (failures) { console.log(`✗ p164 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p164 机构手册「跨学科知识融合，综合能力培养」：全部通过');
