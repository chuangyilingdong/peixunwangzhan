/**
 * 构建期：给第三方插件打的**兼容性小补丁**（不是品牌，品牌在 rebrand.mjs）。
 *
 * 每一条都必须写清「为什么」与「什么时候能删」——它们改的是别人的代码，
 * dsh 或插件升级后要重新评估，绝不能默默留着。
 *
 * 用法：node plugin-shims.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const PROFILE_MODULES = `${process.env.DSH_HOME || '/home/student/.dsh'}/profiles/web/node_modules`;

const SHIMS = [
  {
    // dsh-ppt-composer 的「标准输入区 PPT 选板」在 conversation.composer.dock 插槽里直接读
    // props.session.blank，而这个插槽的宿主并不保证传 session → 实测抛
    // 「Cannot read properties of undefined (reading 'blank')」，React 把这个插槽条目整个判失败，
    // 学生一贴附件就报错（界面能继续用，但那个选板没了）。
    // 加个可选链：没有 session 时按「非空白会话」处理（渲染空），至少不再抛错。
    // 什么时候能删：dsh 或 dsh-ppt-composer 升级后，先用浏览器贴一次附件确认不再报错。
    file: path.join(PROFILE_MODULES, 'dsh-ppt-composer/lib/client.js'),
    from: 'props.session.blank',
    to: 'props.session?.blank',
    why: 'conversation.composer.dock 插槽不传 session，PPT 选板直接读 .blank 会抛错',
  },
];

let touched = 0;
for (const shim of SHIMS) {
  if (!fs.existsSync(shim.file)) {
    console.log(`[shim] 跳过（文件不在）：${shim.file}`);
    continue;
  }
  const source = fs.readFileSync(shim.file, 'utf8');
  if (source.includes(shim.to) && !source.includes(shim.from)) {
    console.log(`[shim] 已经打过：${path.basename(path.dirname(path.dirname(shim.file)))}`);
    continue;
  }
  const count = source.split(shim.from).length - 1;
  if (count === 0) {
    console.log(`[shim] 没找到要打的模式（插件可能已修）：${shim.from}`);
    continue;
  }
  fs.writeFileSync(shim.file, source.split(shim.from).join(shim.to));
  touched += count;
  console.log(`[shim] ${shim.from} → ${shim.to}（${count} 处）：${shim.why}`);
}
console.log(`[shim] 共打 ${touched} 处`);
