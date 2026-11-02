/**
 * P201 「文生视频 / 全能参考（自动）」守卫（2026-11-02）。
 *
 * 用户口径：「我这里选的是学生自选，但是连线后，很明显生成的是首尾帧的模式，
 *   但是我们只需要文生视频或者就是全能参考。其他的模式都不需要」。
 *
 * 现场证据（生产库最近 6 条视频任务）：连了图的都有 `source_asset_url`（首帧），
 * 参考素材全空 —— 因为「学生自选」不锁任何方式，而画布的连线进的是首帧/尾帧槽。
 *
 * 这个新模式 = 课包层的**组合锁**：没连线→文生视频，连了东西→全能参考，
 * **首帧/尾帧完全不参与**。这条守卫钉住四件事：
 *   ① 常量与标签存在，且它**不在**模型的 INPUT_MODES 里（模型不该声明它）；
 *   ② 框体归一化：值能被保留下来（不因为"模型没声明"被静默清空），
 *      并且画布只暴露 文生/参考 两档、不再要求首帧；
 *   ③ 生成侧：按"有没有连接"翻译成 TEXT / OMNI_REFERENCE，forceOmni 跟着翻译结果走；
 *   ④ 后台下拉里有这个选项（只在模型同时支持文生与全能参考时出现）。
 *
 * 跑法：node scripts/p201-auto-text-omni.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (error) { failures += 1; console.error(`  ✗ ${label} —— ${error.message}`); }
};

const caps = read('apps/server/src/services/modelCapabilities.js');
const lib = read('apps/server/src/lib.js');
const gen = read('apps/server/src/routes/aiGeneration.js');
const admin = read('apps/admin/src/components/CourseManagement.jsx');

check('① 常量与标签齐备，且**不在**模型的 INPUT_MODES 里', () => {
  assert.match(caps, /export const AUTO_TEXT_OMNI_MODE = 'TEXT_OR_OMNI'/);
  assert.match(caps, /TEXT_OR_OMNI: '文生视频 \/ 全能参考（自动）'/);
  const list = caps.match(/export const INPUT_MODES = Object\.freeze\(\[[^\]]*\]\)/)?.[0] || '';
  assert.ok(!list.includes('TEXT_OR_OMNI'), 'INPUT_MODES 里不该有它（那是"模型能声明什么"）');
});

check('② 框体归一化：值不被静默清空，且画布只给文生/参考两档', () => {
  assert.match(lib, /const isAutoTextOmni = wantedMode === AUTO_TEXT_OMNI_MODE/);
  assert.match(lib, /isAutoTextOmni \|\|/, '没有放行这个组合锁（会被当成"挑不中"清空）');
  assert.match(lib, /box\.inputModes = box\.inputModes\.filter\(\(mode\) => mode === 'TEXT' \|\| mode === 'OMNI_REFERENCE'\)/,
    '画布没有收窄到 文生/参考（首帧槽还会出现）');
  assert.match(lib, /box\.requiresFirstFrame = false/, '没有取消"必须给首帧"');
});

check('③ 生成侧：按连接翻译成 TEXT / OMNI，帧模式不参与', () => {
  assert.match(gen, /const effectiveMode = rawLocked === AUTO_TEXT_OMNI_MODE/);
  assert.match(gen, /hasAnyInput \? 'OMNI_REFERENCE' : 'TEXT'/, '没有按"有没有连线"二选一');
  assert.match(gen, /const forceOmni = effectiveMode === 'OMNI_REFERENCE'/, 'forceOmni 没跟着翻译结果走');
  assert.ok(!/const forceOmni = String\(target\?\.inputMode/.test(gen), 'forceOmni 还是只看原始 inputMode');
});

check('④ 后台下拉里有这个选项，且只在模型支持文生+全能参考时出现', () => {
  assert.match(admin, /const AUTO_TEXT_OMNI_MODE = 'TEXT_OR_OMNI'/);
  assert.match(admin, /AUTO_TEXT_OMNI_LABEL/);
  assert.match(admin, /supported\.includes\('TEXT'\) && supported\.includes\('OMNI_REFERENCE'\)/);
  assert.match(admin, /list\.splice\(1, 0, \[AUTO_TEXT_OMNI_MODE/);
  // 音频那行也要在这个模式下显示（它能连音频当参考）
  assert.match(admin, /box\.inputMode === AUTO_TEXT_OMNI_MODE/);
});

assert.equal(failures, 0, `P201 有 ${failures} 条断言没过`);
console.log('PASS: 「文生视频 / 全能参考（自动）」—— 没连线走文生，连了只当参考，永不进首尾帧');
