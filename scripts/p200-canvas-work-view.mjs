/**
 * P200 画布作品的「作品内容 / 创作画布」两个视图（2026-11-02）。
 *
 * 钉的是这条用户口径（2026-09-21 原话）：
 *   「作品发布后，网站显示的是画布内容，**应该显示的是图片/视频/音频等等，而不是画布**」。
 *
 * 当时改了两个地方：广场的作品详情页（`pages/WorkDetail.jsx`）与老师端
 * （`apps/org/.../ClassroomWork.jsx`）。**学生主页的弹窗漏了** —— 点开只剩画布，
 * 看起来像还在编辑。这条守卫把三处**放在一起**钉，防止哪天又只改一半。
 *
 * 跑法：node scripts/p200-canvas-work-view.mjs
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

const modal = read('apps/website/src/components/WorkPreviewModal.jsx');
const detail = read('apps/website/src/pages/WorkDetail.jsx');
const classroom = read('apps/org/src/pages/classroom/ClassroomWork.jsx');

/** 这一处是不是"默认看作品内容 + 画布作为第二个标签页"。 */
function assertTwoViews(source, label) {
  assert.ok(/WorkMediaGallery/.test(source), `${label}：没有用 WorkMediaGallery（看不到图/视频/音频）`);
  assert.ok(/作品内容/.test(source), `${label}：缺「作品内容」标签`);
  assert.ok(/创作画布/.test(source), `${label}：缺「创作画布」标签`);
}

check('① 学生主页弹窗：默认「作品内容」，画布是第二个标签（2026-11-02 补的）', () => {
  assertTwoViews(modal, '学生主页弹窗');
  assert.ok(/useState\('media'\)/.test(modal), '默认视图不是作品内容');
  assert.ok(/view === 'canvas'\s*\?\s*<div className="canvas-work__canvas/.test(modal), '画布分支没有挂在标签页上');
  // 不能再把画布直接当唯一内容渲染
  assert.ok(!/detail \? \(isVibe[\s\S]{0,400}<CanvasEditor/.test(modal), '画布仍然是无条件的默认视图');
});

check('② 广场作品详情页：同一套两个视图', () => {
  assertTwoViews(detail, '作品详情页');
  assert.ok(/view === 'canvas'/.test(detail), '详情页没有视图切换');
});

check('③ 老师端课堂作品：同一套两个视图', () => {
  assertTwoViews(classroom, '老师端');
  assert.ok(/workView === 'canvas'/.test(classroom), '老师端没有视图切换');
});

check('④ 三处用的是同一个标签文案（别再各写各的）', () => {
  for (const [label, source] of [['弹窗', modal], ['详情页', detail], ['老师端', classroom]]) {
    assert.ok(source.includes('作品内容') && source.includes('创作画布'), `${label} 的标签文案不一致`);
  }
});

check('⑤ 分享面板的选项标签是**短的**（长 caption 会把下拉框撑成一条横幅）', () => {
  const share = read('packages/shared/src/workShare.jsx');
  // 不能再把 caption 直接当 label —— 画布的 caption 是生成提示词，几百字
  assert.ok(!/label: item\.caption \|\|/.test(share), '又直接用 caption 当标签了');
  assert.ok(/caption\.length <= 12/.test(share), '没有按长度判断"短名字"');
  assert.ok(/`\$\{kind\} \$\{ordinal\}`/.test(share), '没有「图片 N」这种短标签兜底');
  // 网页作品那支用文件名，也压一下长度
  assert.ok(/String\(item\.name \|\| '这一件'\)\.slice\(0, \d+\)/.test(share), '文件名没有截断');
});

assert.equal(failures, 0, `P200 有 ${failures} 条断言没过`);
console.log('PASS: 画布作品三处都默认看「作品内容」，画布作为第二个标签页');
