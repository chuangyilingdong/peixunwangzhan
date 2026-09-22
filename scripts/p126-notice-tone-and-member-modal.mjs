/**
 * P126 提示语的**语气**（红/绿）+ 机构端「创建账号」改按钮弹窗（2026-09-21 用户报的两条）。
 *
 * 用户原话：
 *   ①「创建账号应该是个按钮，然后弹窗出来创建，登录名应该和初始密码挨着，姓名放在上面。
 *      如果选择学生文案应该叫：学生姓名。如果选择老师，文案叫：老师姓名。登录名文案叫：登录账号，
 *      初始密码文案叫：登录密码。」
 *   ②「图2现在通过或者报错都是绿色框体，检查下有没有类似的情况。应该有所区分，红色/绿色。」
 *
 * ②的根因（**全站通病**）：「这条提示是成功还是失败」原来靠**猜消息里的字** ——
 *   `tone={message.includes('失败') || message.includes('错误') ? 'danger' : 'success'}`。
 *   只要错误文案里没有那两个词（「登录名已被占用」「姓名在这一批里重名」），就渲染成**绿色**。
 *   改法：错误消息统一由 `errorText()` 打一个前缀标记，`Notice` / 画布 toast 见到标记就按危险色渲染；
 *   各页面的 tone 不再猜（非错误的确认消息一律 success）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

/* ── ②-a 三个纯函数（真跑，不是读源码）────────────────────────────────────── */
const { errorText, isErrorText, stripNoticeMark, NOTICE_ERROR_MARK } = await import('../packages/shared/src/notice.js');
check('错误消息带标记：errorText 给任何 Error / 字符串都加上前缀（空消息兜底「操作失败」）',
  errorText(new Error('登录名已被占用')) === `${NOTICE_ERROR_MARK}登录名已被占用`
  && errorText('姓名在这一批里重名') === `${NOTICE_ERROR_MARK}姓名在这一批里重名`
  && errorText(null) === `${NOTICE_ERROR_MARK}操作失败`);
check('辨认与还原：isErrorText / stripNoticeMark 成对（成功消息原样返回）',
  isErrorText(errorText(new Error('x'))) && !isErrorText('账号已创建')
  && stripNoticeMark(errorText(new Error('x'))) === 'x' && stripNoticeMark('账号已创建') === '账号已创建');

/* ── ②-b 组件与全站不再"猜"语气 ─────────────────────────────────────────── */
const ui = read('packages/shared/src/ui.jsx');
check('Notice：带标记的消息**一律危险色**（压过调用方给的 tone），渲染时把标记去掉',
  /if \(typeof children === 'string' && isErrorText\(children\)\) return <div className="notice danger">\{stripNoticeMark\(children\)\}<\/div>/.test(ui));
const canvas = read('packages/shared/src/canvasWorkspace.jsx');
check('画布 toast 也按标记判（错误红 + 留着不自动消失；其余 5 秒走）',
  /isErrorText\(message\) \? 'is-error' : ''/.test(canvas) && /stripNoticeMark\(message\)/.test(canvas)
  && /if \(isErrorText\(message\)\) return undefined;/.test(canvas));

const appFiles = [
  ...fs.readdirSync(path.join(root, 'apps/admin/src/pages')).filter((f) => f.endsWith('.jsx')).map((f) => `apps/admin/src/pages/${f}`),
  ...fs.readdirSync(path.join(root, 'apps/admin/src/components')).filter((f) => f.endsWith('.jsx')).map((f) => `apps/admin/src/components/${f}`),
  'apps/admin/src/App.jsx',
  'apps/org/src/main.jsx',
  'apps/org/src/pages/StudentGrants.jsx',
].filter((f) => fs.existsSync(path.join(root, f)));
const guessing = appFiles.filter((file) => /tone=\{[^}]*\.includes\(/.test(read(file)));
check('【反向自检】没有页面再按"消息里有没有某个词"决定红绿（这一条以前到处都是）',
  guessing.length === 0, guessing.join('、'));

// 全仓不再有「把 error.message 塞进提示、而那条提示会渲染成绿色」的地方。
// 两种正确写法都放行：① 走 errorText（带标记 → Notice 自己红）；② 接收变量在渲染时就是
// <Notice tone="danger">（例如 Security.jsx 的 error / passwordMessage）。
const allAppFiles = [
  ...appFiles,
  ...fs.readdirSync(path.join(root, 'apps/org/src/pages')).filter((f) => f.endsWith('.jsx')).map((f) => `apps/org/src/pages/${f}`),
  'packages/shared/src/canvasWorkspace.jsx', 'packages/shared/src/classroom.jsx',
].filter((f) => fs.existsSync(path.join(root, f)));
const offenders = [];
for (const file of allAppFiles) {
  const text = read(file);
  for (const match of text.matchAll(/set([A-Za-z]+)\((?:error|err)\.message[^)]*\)/g)) {
    const variable = match[1];
    const lowered = variable.charAt(0).toLowerCase() + variable.slice(1);
    // 放行三种"渲染处明确就是危险色"的写法：① 变量就地渲染 danger；② 变量挂在 tone= 上；
    // ③ 作为 `error={变量}` 传给子组件，而子组件里 `<Notice tone="danger">{error}`（两个弹窗都是这样）。
    const renderedDanger = text.includes(`<Notice tone="danger">{${lowered}}`)
      || text.includes(`error={${lowered}}`) && text.includes('<Notice tone="danger">{error}')
      || new RegExp(`tone=\{${variable}`).test(text);
    if (!renderedDanger) offenders.push(`${file} → ${variable}`);
  }
}
check('【反向自检】错误消息要么走 errorText、要么渲染处明确 danger（两样都没有的会显示成绿色）',
  offenders.length === 0, offenders.join('、'));

/* ── ① 机构端「创建账号」：按钮 + 弹窗 + 字段顺序与文案 ──────────────────── */
const org = read('apps/org/src/main.jsx');
check('① 创建账号是个**按钮**、点开弹窗（表单不再常驻占半屏）',
  /<button className="primary-button" onClick=\{\(\) => \{ setMessage\(''\); setCreateOpen\(true\); \}\}>创建账号<\/button>/.test(org)
  && /isAdmin && createOpen \? <Modal/.test(org)
  && /<Modal\s*\n\s*title="创建账号"/.test(org)
  && !/Panel title="新建账号"/.test(org));
check('① 字段顺序：角色 → 姓名 → 登录账号 → 登录密码 → 手机号（登录名与初始密码挨着，姓名在其前）',
  (() => {
    const order = ['>角色<select', "form.role === 'TEACHER' ? '老师姓名' : '学生姓名'", '>登录账号<input', '>登录密码<input', '>手机号（可选）<input'];
    const at = order.map((needle) => org.indexOf(needle));
    return at.every((index) => index > 0) && at.every((index, i) => i === 0 || index > at[i - 1]);
  })());
check('① 文案按角色变：选学生叫「学生姓名」、选老师叫「老师姓名」；登录名/初始密码改叫「登录账号 / 登录密码」',
  /form\.role === 'TEACHER' \? '老师姓名' : '学生姓名'/.test(org)
  && org.includes('>登录账号<input') && org.includes('>登录密码<input')
  && !/>登录名<input/.test(org) && !/>初始密码<input/.test(org)
  && org.includes('<option value="TEACHER">老师</option>'));
check('① 创建成功 → 关弹窗 + 带上"登录账号"的绿色确认（失败留在弹窗里看红字）',
  /setCreateOpen\(false\);\s*\n\s*setMessage\(`账号已创建：\$\{form\.displayName\}（登录账号 \$\{form\.login\}）`\)/.test(org)
  && /catch \(error\) \{ setMessage\(errorText\(error\)\); \} finally \{ setBusy\(false\); \}/.test(org));

assert.ok(true);
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
