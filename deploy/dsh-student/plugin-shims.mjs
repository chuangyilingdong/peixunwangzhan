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
// dsh 自带包的位置（客户端半边在这些包里的 lib/client.js）
const DSH_MODULES = '/opt/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

const SHIMS = [
  {
    // 「内测声明」是 dsh 面向**它自己的开发者**的产品公告（"0.1 版本仍在测试…欢迎开发者加入插件生态"），
    // 给孩子用的学生端不该出现，而且它会**挡住界面**（不点「继续」用不了）。
    //
    // 原本靠预置 `DSH_HOME/settings.yaml` 里的 `ui-onboarding.welcomeNoticeVersion` 让它认为「已读」，
    // 但在**同机独立用户**这条路上实测：同样的文件、同样的内容、同样可写，客户端仍然判定未读
    // （原因未定位；容器模式同一份文件是有效的）。与其继续追设置链路，这里直接把判定钉成「已读」——
    // 学生端永远不显示这个公告。什么时候能删：等 dsh 把这个公告从客户端拆出去，或我们决定改用官方配置项时。
    file: path.join(DSH_MODULES, 'dsh-client-ui-settings-models/lib/client.js'),
    from: 'scope.value?.[WELCOME_NOTICE_ACK_FIELD] === WELCOME_NOTICE_VERSION',
    to: 'true',
    why: '学生端不显示 dsh 的开发内测公告（它还会挡住界面）',
  },
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
