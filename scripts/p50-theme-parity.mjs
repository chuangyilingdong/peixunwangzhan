// 主题色板一致性守卫：服务端渲染 pptx 用的色板，必须和前端站内预览用的一模一样。
//
// 为什么单独立一条：PPT 的预览与文件是**两套实现**（一个在浏览器里画 HTML、一个生成 OOXML），
// 色板是唯一需要两边手工同步的东西 —— 一旦漂移，学生会看到「预览是蓝的、下载出来是橙的」，
// 而且**谁都不报错**。这里把两边拉平（包括色值、字段名、以及默认主题名）。
import { strict as assert } from 'node:assert';
import { THEMES as SERVER_THEMES, DEFAULT_THEME as SERVER_DEFAULT, themeOf as serverThemeOf } from '../apps/server/src/services/ooxml/pptx.js';
import { THEMES as CLIENT_THEMES, DEFAULT_THEME as CLIENT_DEFAULT, themeOf as clientThemeOf } from '../packages/shared/src/console/themes.js';

const serverNames = Object.keys(SERVER_THEMES).sort();
const clientNames = Object.keys(CLIENT_THEMES).sort();
assert.deepEqual(clientNames, serverNames, `两边的主题名不一致：\n  服务端 ${serverNames.join(',')}\n  前端   ${clientNames.join(',')}`);
assert.ok(serverNames.length >= 5, `主题太少了（${serverNames.length}）—— 至少要有几套可挑`);
assert.equal(CLIENT_DEFAULT, SERVER_DEFAULT, '两边默认主题不一致');

// label 是给人看的中文名，其余六个才是色值（都要 6 位十六进制、不带 #）
const COLOR_FIELDS = ['bg', 'ink', 'body', 'accent', 'soft', 'cover'];
const ALL_FIELDS = ['label', ...COLOR_FIELDS];
for (const name of serverNames) {
  assert.deepEqual(
    Object.keys(CLIENT_THEMES[name]).sort(), Object.keys(SERVER_THEMES[name]).sort(),
    `主题 ${name} 的字段集合两边不一致：前端 ${Object.keys(CLIENT_THEMES[name])} / 服务端 ${Object.keys(SERVER_THEMES[name])}`,
  );
  for (const field of ALL_FIELDS) {
    assert.equal(
      CLIENT_THEMES[name][field], SERVER_THEMES[name][field],
      `主题 ${name} 的 ${field} 两边不一致：前端 ${CLIENT_THEMES[name][field]} / 服务端 ${SERVER_THEMES[name][field]}`,
    );
  }
  for (const field of COLOR_FIELDS) {
    // 色值必须是 6 位十六进制（不带 #）：OOXML 用 srgbClr val，前端拼 # 前缀
    assert.match(SERVER_THEMES[name][field], /^[0-9A-F]{6}$/i, `主题 ${name} 的 ${field} 不是 6 位十六进制色值：${SERVER_THEMES[name][field]}`);
  }
}

// 不认识的主题名两边都要优雅回落到默认（模型可能写 "海洋蓝" 这种中文名）
for (const bogus of ['', '海洋蓝', 'OCEAN!', undefined, null]) {
  assert.equal(serverThemeOf(bogus).label, SERVER_THEMES[SERVER_DEFAULT].label, `服务端对 ${JSON.stringify(bogus)} 没有回落到默认主题`);
  assert.equal(clientThemeOf(bogus).label, CLIENT_THEMES[CLIENT_DEFAULT].label, `前端对 ${JSON.stringify(bogus)} 没有回落到默认主题`);
}
// 大小写不敏感
assert.equal(serverThemeOf('OCEAN').label, SERVER_THEMES.ocean.label, '主题名应当大小写不敏感');
assert.equal(clientThemeOf('Ocean').label, CLIENT_THEMES.ocean.label, '主题名应当大小写不敏感');

console.log(`P50 theme parity guard passed（${serverNames.length} 套主题、${ALL_FIELDS.length} 个字段逐一对齐：${serverNames.join(' / ')}）`);
