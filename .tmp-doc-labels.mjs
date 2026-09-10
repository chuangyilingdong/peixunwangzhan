/** 一次性脚本：把第二节的历史发布列表标签理顺（每次发布都会挤动一次）。 */
import fs from 'node:fs';

const file = 'docs/operations/交接说明.md';
let source = fs.readFileSync(file, 'utf8');
const rep = (from, to) => {
  if (!source.includes(from)) {
    console.error('未匹配：', from.slice(0, 60));
    process.exit(1);
  }
  source = source.replace(from, to);
};

// 第十轮那条被当成「本次发布」的续行缩进了，这里拉出来当成独立条目
rep(
  '          上一次发布（9d26a43 / release 20260910T160417Z）：画布第十轮——按用户两条反馈改，',
  '上一次发布（9d26a43 / release 20260910T160417Z）：画布第十轮——按用户两条反馈改，',
);
rep('          上一次发布（31dc538 / release 20260910T144631Z）：画布第九轮', '上上次发布（31dc538 / release 20260910T144631Z）：画布第九轮');
rep('上上次发布（5efc604 / release 20260910T142409Z）：画布第八轮', '再上一次发布（5efc604 / release 20260910T142409Z）：画布第八轮');
rep('再上一次发布（49d75ec / release 20260910T134928Z）：画布第七轮', '更早——画布第七轮（49d75ec / release 20260910T134928Z）');

fs.writeFileSync(file, source);
console.log('历史标签已理顺');
