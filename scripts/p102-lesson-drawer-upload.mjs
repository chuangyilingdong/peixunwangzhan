// P102 课时抽屉里的上传控件（2026-09-16）
//
// 背景：课时配置抽屉（LessonDrawer）里有一段内联 <style>，它曾经把
//   `.inline-file-upload input { display:block; max-width:100% }`
// 盖回去 —— 而全局样式（packages/shared/src/styles.css）本来是把这个
// **label 包住的隐藏文件域**藏起来的（点 label 就相当于点文件域）。
// 被盖回 display:block 之后，「上传图片」按钮旁边会多出一个原生的
// 「选择文件 / 未选择任何文件」，而且把 label 撑成几百像素宽，
// 顺着把「资源地址」输入框挤窄。生产上肉眼可见（2026-09-16 浏览器实测确认）。
//
// 这类问题**静态就能钉死**，不用起浏览器：
//   ① 全局样式确实藏着它（否则设计意图变了，这条守卫的意义也就变了）；
//   ② 抽屉的内联样式没有把它重新显示出来；
//   ③ 文件域一律包在 .inline-file-upload 的 label 里，不存在裸的文件域。
// ②③ 都带**反向自检**：拿篡改过的源码喂进同一个检测函数，必须报错 ——
// 免得哪天检测写法失效了还一路绿到底。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const squeeze = (text) => text.replace(/\s+/g, '');

const stylesCss = read('packages/shared/src/styles.css');
const adminSource = read('apps/admin/src/components/CourseManagement.jsx');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ---------------------------------------------------------------- 检测函数 */

/** 内联样式里有没有「把 label 里的文件域重新显示出来」这条规则。 */
const showsHiddenFileInput = (source) => {
  const compact = squeeze(source);
  return (
    compact.includes('inline-file-uploadinput{display:block') ||
    /\.inline-file-upload\s+input\s*\{[^}]*display\s*:\s*(block|inline|inline-block)/.test(source)
  );
};

/** 裸文件域：<input type="file" ...> 没有紧邻的 .inline-file-upload label 包着。 */
const bareFileInputs = (source) => {
  const parts = source.split('<input type="file"');
  const bare = [];
  for (let i = 1; i < parts.length; i += 1) {
    const before = parts[i - 1].slice(-400);
    if (!before.includes('inline-file-upload')) bare.push(i);
  }
  return bare;
};

/* ---------------------------------------------------------------- ① 全局样式 */

check(
  '全局样式把 .inline-file-upload 里的文件域藏起来（设计意图还在）',
  /\.inline-file-upload\s+input\s*\{\s*display\s*:\s*none/.test(stylesCss),
);

/* ---------------------------------------------------------------- ② 抽屉内联样式 */

check(
  '课时抽屉的内联样式没有把隐藏文件域重新显示出来',
  !showsHiddenFileInput(adminSource),
  '内联样式又写了 display:block —— 原生「选择文件」会重新冒出来',
);

// 反向自检：把当年那条错误声明塞回去，检测必须报警
check(
  '反向自检：塞回 display:block 时这条守卫会红',
  showsHiddenFileInput(
    adminSource.replace(
      '<style>{`',
      '<style>{`.lesson-editor-dialog .inline-file-upload input{display:block;max-width:100%}',
    ),
  ) === true,
);

/* ---------------------------------------------------------------- ③ 不许有裸文件域 */

const bare = bareFileInputs(adminSource);
check(
  '课包/课时组件里的文件域都包在 .inline-file-upload 的 label 里',
  bare.length === 0,
  `第 ${bare.join('、')} 个文件域没包 label`,
);

// 反向自检：摘掉一个 label 包装，检测必须报警
const unwrapped = adminSource.replace(
  '<label className="inline-file-upload">',
  '<span className="not-an-upload-label">',
);
check(
  '反向自检：摘掉 label 包装时这条守卫会红',
  bareFileInputs(unwrapped).length === bare.length + 1,
  '检测函数没识别出被摘掉包装的文件域',
);

/* ---------------------------------------------------------------- ④ 上传行仍是两件 */

// 素材编辑器的上传行＝「地址输入框 + 紧凑按钮」，按钮靠 label 自己的内边距成形。
const assetInputs = adminSource.match(/className="lesson-asset-input"/g) || [];
check('素材编辑器仍有上传行（守卫不是空转）', assetInputs.length >= 2, `找到 ${assetInputs.length} 处`);

assert.ok(stylesCss.length > 0 && adminSource.length > 0);

if (failures) { console.log(`\nP102 有 ${failures} 项未通过`); process.exitCode = 1; }
else console.log('P102 课时抽屉上传控件：隐藏文件域没被重新显示、文件域一律 label 包装（含反向自检）通过');
