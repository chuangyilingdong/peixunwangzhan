/**
 * P133 课时素材的**默认值**（用户 2026-09-23 口径）。
 *
 * 用户原话（建课时要手填太多）：
 *   ① 选「提示词」        → 素材标题默认 `提示词（1）`
 *   ② 生成框体 - AI 生图  → 标题 `图片框体`、模型 zhenzhen-image-g-v2.5-lowprice、清晰度 1k
 *   ③ 生成框体 - AI 生视频 → 标题 `视频框体`、模型 MiniMax-H3、清晰度 480P、时长 5、生成音频 带音频、
 *                          音频怎么用 声音参考（只借音色）
 *
 * 三条容易做漏/做错的，逐条钉住：
 *   ① 这几个值**必须落在渠道配置里那个模型真实的能力清单上**（生产上 2.5 低价版 = 1k/2k/4k、
 *      MiniMax-H3 = 480P/768P、5/10/15 秒、audio:true）。写渠道里没有的档位，下拉框显示成空值，
 *      而且换模型时会被 changeBoxModel 的「新模型不支持就退回学生自选」清掉。
 *   ② **老师改过名字的素材不能被默认值覆盖**（titleOrNext 只认"没改过的默认值"）。
 *   ③ 走「生成什么」那条路时也要给默认值（不只是切类型那条路）—— 用户就是这么用的。
 *
 * ⚠️ 真观感由 `.tmp/then-box-defaults.mjs` 在真浏览器里核（真打开课时抽屉、真新增素材、真改值），
 *    见第二十八轮交接 §六；那条路上有三个坑（标签页 / 抽屉分步 / ＋素材 按钮 0×0），注释里都写了。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const count = (haystack, needle) => haystack.split(needle).length - 1;

const admin = read('apps/admin/src/components/CourseManagement.jsx');
// 去掉注释再判（注释里会原样引用这些标识符/值，直接 includes 会假绿）
const code = admin.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── ① 默认值表 ─────────────────────────────────────────────────────── */
check('① 生图默认：标题「图片框体」+ 模型 zhenzhen-image-g-v2.5-lowprice + 清晰度 1k',
  code.includes("IMAGE: { title: '图片框体', model: 'zhenzhen-image-g-v2.5-lowprice', resolution: '1k' }"));
check('① 生视频默认：标题「视频框体」+ MiniMax-H3 + 480P + 5 秒 + 带音频 + 声音参考',
  code.includes("VIDEO: { title: '视频框体', model: 'MiniMax-H3', resolution: '480P', durationSeconds: 5, audio: true, audioRole: 'VOICE_REFERENCE' }"));
check('① 提示词默认标题是「提示词（N）」（N 按这一组里已有的提示词数往下排）',
  /function nextPromptTitle\(groupIndex\)/.test(code) && code.includes('return `提示词（${used + 1}）`;'));
check('① 比例**不设默认**（留给学生在课堂上挑）',
  /function boxDefaultsFor\(modality\)[\s\S]{0,400}aspectRatio: ''/.test(code));

/* ── ② 别覆盖老师改过的名字 ─────────────────────────────────────────── */
check('② 只有标题还是"没改过"的才换（空 / 素材N / 提示词（N）/ 四个框体名）',
  /function titleOrNext\(groupIndex, materialIndex, next\)/.test(code)
  && /DEFAULT_TITLE_RE/.test(code) && code.includes('图片框体|视频框体|文字框体|音乐框体'));

/* ── ③ 两条路都要给默认值（切类型 + 换「生成什么」）────────────────── */
check('③ 切素材类型时给默认值（提示词给标题、框体给标题 + 参数）',
  /function changeMaterialType\(groupIndex, materialIndex, uid, materialType\)/.test(code)
  && code.includes('box: box || boxDefaultsFor(modality)'));
check('③ 换「生成什么」时也给默认值（用户就是这么用的）',
  /function changeBoxModality\(groupIndex, materialIndex, uid, modality\)/.test(code)
  && /changeBoxModality[\s\S]{0,600}boxDefaultsFor\(modality\)/.test(code));
check('③ 新增素材的默认类型还是提示词，标题就是「提示词（N）」（不再是「素材N」）',
  code.includes('title: nextPromptTitle(groupIndex)') && !code.includes('title: `素材${materials.length + 1}`'));

/* ── ④ 默认值必须与渠道能力清单同源（换了模型/档位要一起改）────────── */
const caps = read('apps/server/src/services/modelCapabilities.js');
check('④ 1k 与 480P/5 在模态默认能力清单里（渠道没单独配时也兜得住）',
  /IMAGE: Object\.freeze\(\{[^}]*resolutions: \['1k'/.test(caps)
  && /VIDEO: Object\.freeze\(\{[^}]*durations: \[5, 10\]/.test(caps));
check('④ 代码里写了"这几个值必须落在渠道真实能力清单上"这条约束（换档位时看得到）',
  admin.includes('必须落在渠道配置里那个模型真实的能力清单上'));

console.log('');
if (failures) { console.log(`✗ p133 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p133 课时素材默认值：全部通过');
