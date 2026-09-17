// P107 客户端侧的请求体预算（dsh 每轮重发全量历史 → 必须有上限）
//
// 背景（2026-09-17 实测）：dsh **每一轮都把整段对话重新发一次**，而历史里的图片会被重新编码进
// 每一次请求体。于是对话越长请求体越大 —— 学生那次「做游戏、不停看自己截图」的会话，
// 8 张截图就把请求体顶到 2.19MB（实测：4 张 1.09MB → 8 张 2.19MB），再往后必然撞上请求体积上限。
//
// ⚠️ **压缩救不了它**（这是最容易想错的一步）：压缩的触发线按 token 算，而图片在 dsh 的计量里
// 只是一个**附件引用**（正文到发请求时才编码成 base64），所以「字节的墙」总是先到、压缩永远来不及。
// 正解是 pi-ai 那个**路由级图片预算** `maxRequestImageBytes`：超预算时它把**最老的**图从这一次
// 请求里省略掉，换成 `[image omitted to fit request image limits; …]`（函数名 replaceOldestImages
// —— 保留最新的，所以 agent 刚读过的图一定看得见），历史本身不动。
//
// 这个守卫是**接线守卫**（读源码/配置断言，不是跑行为）：它钉不住「压缩对不对」，但能钉住
// 「这行配置还在、取值与网关上限仍然自洽、压缩没被人关掉」。真跑行为的验证在真机
// （headless 档 + 记录请求体的代理：默认 2.19MB → 设 1MiB 后被钉在 0.95MB）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const bytes = (text) => {
  const m = String(text).match(/^(\d+)(b|kb|mb)$/i);
  if (!m) return NaN;
  return Number(m[1]) * ({ b: 1, kb: 1024, mb: 1048576 }[m[2].toLowerCase()]);
};

const patch = read('deploy/dsh-student/student-runtime.cordis.yml');
const gateway = read('apps/server/src/routes/runtimeGateway.js');
const indexjs = read('apps/server/src/index.js');

/* ① 补丁层里必须给这条路由配上图片预算 */
const declared = patch.match(/maxRequestImageBytes:\s*(\d+)/);
check('补丁层给 platform-gateway 配了 maxRequestImageBytes', Boolean(declared), patch.includes('platform-gateway') ? '有路由但没这个字段' : '连路由都没有');
const budget = declared ? Number(declared[1]) : NaN;
check('取值是个合理的正整数', Number.isFinite(budget) && budget >= 1048576 && budget <= 33554432, String(budget));

/* ② 与网关的请求体上限必须仍然自洽：图片预算 + 正文余量 < 网关上限 < nginx 的 30m */
const limitText = indexjs.match(/RUNTIME_GATEWAY_BODY_LIMIT\s*=\s*String\(process\.env\.RUNTIME_GATEWAY_BODY_LIMIT \|\| '(\d+mb)'\)/i);
check('网关的请求体上限是按路径分流的（jsonBodyLimitFor）', /jsonBodyLimitFor/.test(indexjs) && /startsWith\('\/api\/gateway\/'\)/.test(indexjs));
const limit = limitText ? bytes(limitText[1]) : NaN;
check('网关上限读得出来', Number.isFinite(limit), String(limitText?.[1]));
// 正文、系统提示词、工具 schema 还要占地方：给它们留 1MB，超了就说明图片预算离墙太近
check(`图片预算 + 1MB 正文余量 < 网关上限（${budget / 1048576}MiB + 1 < ${limit / 1048576}MB）`,
  budget + 1048576 < limit, `${budget} + 1048576 vs ${limit}`);
check('网关上限本身在 nginx 的 client_max_body_size（30m）之内', limit < 30 * 1048576, String(limit));

/* ③ 服务端那道兜底还在：即使客户端没配预算，网关也不会把超量图片转给上游 */
check('网关仍有图片字节预算（客户端之外的第二道）', /MAX_HISTORY_IMAGE_CHARS\s*=\s*\d+/.test(gateway));
check('省略的图是换成文字说明，不是静默丢掉', /已省略/.test(gateway) && /boundHistoryImages/.test(gateway));

/* ④ 别把 dsh 的自动压缩关掉：它是文字历史增长的唯一出口 */
check('补丁层没有把 compaction 关掉（auto: false）', !/compaction[^\n]*auto:\s*false/.test(patch) && !/auto:\s*false/.test(patch));

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
