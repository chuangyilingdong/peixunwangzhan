/**
 * P163 课时编排的「模型能力」形状守卫 —— 2026-09-28 后台整页白屏的根因。
 *
 * 运营原话：「音乐渠道增加了 1 个 bgm，课时编排这里，我选择 bgm 的模型，结果出现图3的报错白屏。」
 * 控制台：`Uncaught TypeError: Cannot read properties of undefined (reading 'length')`
 * （在 `Array.map` 里），整页白。
 *
 * 根因（读代码就能看清，代码里也留了注释）：
 *   · 运营刚往音乐渠道加了一个模型 `mureka-v9-bgm`，**它还没有任何能力配置**；
 *   · 原来的 `capabilitiesFor()` 是**整对象兜底**：
 *     `channel.modelCapabilities?.[model] || capabilityDefaults[modality] || 四件套`；
 *   · 可是服务端的模态默认里，**音乐只有 `{ modes: [...] }`**（没有 aspectRatios/resolutions/durations），
 *     "刚加进来还没配"的模型又是 `{}` —— 两者都是**真值** ⇒ 兜底链不生效；
 *   · 于是 `caps.aspectRatios` 是 undefined，界面上 `!caps.aspectRatios.length` 当场抛错 ⇒ 白屏。
 *
 * 这条网盯四件事：
 *   ① `resolveCapabilities()` 是**逐项**兜底：拿到 `{}` / `{modes}` / 半份配置，三个列表都必须是数组；
 *   ② **拿服务端真实的模态默认值逐个跑一遍**（TEXT/IMAGE/VIDEO/MUSIC）—— 任何一个模态都不许产出 undefined；
 *   ③ 后台的 `capabilitiesFor()` 必须走这个归一化（不许退回"整对象兜底"）；
 *   ④ 那句「该模型还没有配置可用比例」只对**图片/视频**显示（音乐本来就没有比例这回事）。
 */
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const isShape = (value) => Boolean(value)
  && Array.isArray(value.aspectRatios) && Array.isArray(value.resolutions) && Array.isArray(value.durations)
  && typeof value.audio === 'boolean';
const show = (value) => JSON.stringify(value);

const { resolveCapabilities } = await import('../apps/admin/src/courseCapabilities.js');
const { MODALITY_CAPABILITY_DEFAULTS } = await import('../apps/server/src/services/modelCapabilities.js');

/* ── ① 逐项兜底：这几个形状都曾经/可能出现在线上 ───────────────────────── */
check('① 什么都没给 → 三个列表是空数组、audio 是 false', isShape(resolveCapabilities()), show(resolveCapabilities()));
check('① 模型表里是 `{}`（刚加进来还没配 = 这次事故的输入）→ 仍然是四件套', isShape(resolveCapabilities({ configured: {} })), show(resolveCapabilities({ configured: {} })));
check('① 模态默认是 `{ modes: [...] }`（音乐那份）→ 仍然是四件套', isShape(resolveCapabilities({ fallback: { modes: ['LYRICS', 'DESCRIPTION'] } })), show(resolveCapabilities({ fallback: { modes: ['LYRICS'] } })));
const partial = resolveCapabilities({ configured: { aspectRatios: ['16:9'] }, fallback: { aspectRatios: ['1:1'], resolutions: ['1k'], durations: [5] } });
check('① 半份配置：配置里的优先、缺的用模态默认补',
  partial.aspectRatios.join() === '16:9' && partial.resolutions.join() === '1k' && partial.durations.join() === '5', show(partial));
const junk = resolveCapabilities({ configured: { aspectRatios: 'oops', durations: [5] } });
check('① 非数组的值（有人手改过渠道配置）→ 当空数组，不抛错', junk.aspectRatios.length === 0 && junk.durations.join() === '5', show(junk));
check('① audio 只有显式 true 才算（配置或默认任一为真）',
  resolveCapabilities({ configured: { audio: true } }).audio === true
  && resolveCapabilities({ fallback: { audio: true } }).audio === true
  && resolveCapabilities({ configured: { audio: 'yes' } }).audio === false);

/* ── ② 拿服务端**真实的**模态默认逐个跑 —— 任何模态都不许产出 undefined ──── */
const modalities = Object.keys(MODALITY_CAPABILITY_DEFAULTS);
check('② 服务端的模态默认里，音乐确实没有 aspectRatios（这正是当年白屏的前提）',
  Array.isArray(MODALITY_CAPABILITY_DEFAULTS.MUSIC?.aspectRatios) === false && modalities.includes('MUSIC'), modalities.join());
const brokenModalities = modalities.filter((key) => !isShape(resolveCapabilities({ fallback: MODALITY_CAPABILITY_DEFAULTS[key] })));
check(`② 逐个模态跑一遍都得是四件套（${modalities.join(' / ')}）`, brokenModalities.length === 0, brokenModalities.join(' '));
const blankModalities = modalities.filter((key) => !isShape(resolveCapabilities({ configured: {}, fallback: MODALITY_CAPABILITY_DEFAULTS[key] })));
check('② "模型表里是空对象 + 模态默认" 的组合也全都要是四件套（这次事故的组合）', blankModalities.length === 0, blankModalities.join(' '));

/* ── ③ 后台必须走这个归一化 ─────────────────────────────────────────── */
const course = stripComments(read('apps/admin/src/components/CourseManagement.jsx'));
check('③ 后台的 capabilitiesFor() 走 resolveCapabilities（逐项归一化）',
  /function capabilitiesFor\([\s\S]{0,400}?resolveCapabilities\(\{/.test(course)
  && /import \{ resolveCapabilities \} from '\.\.\/courseCapabilities\.js'/.test(course));
check('③ 不许退回"整对象兜底"那种写法（`|| capabilityDefaults[modality] ||` 是当年白屏那一行）',
  !/\|\|\s*capabilityDefaults\[modality\]\s*\|\|/.test(course));

/* ── ④ 比例那句提示只对图片/视频显示 ───────────────────────────────── */
check('④ 「该模型还没有配置可用比例」只对 IMAGE / VIDEO 显示（音乐没有比例这回事，别误导运营）',
  /modality === 'IMAGE' \|\| modality === 'VIDEO' \? \(caps\.aspectRatios\.length \? null : <p className="muted">该模型还没有配置可用比例/.test(course));

console.log('');
if (failures) { console.log(`✗ p163 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p163 课时编排的模型能力形状：全部通过');
