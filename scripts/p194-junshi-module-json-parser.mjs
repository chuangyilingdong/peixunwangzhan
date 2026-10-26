/**
 * P194 招生军师：模块级 JSON 解析作用域守卫（2026-10-26）
 *
 * 生产实测「文案大脑 → 添加大脑 → 蒸馏」失败，错误是
 * `parseLooseJsonObject is not defined`：runBrainDistill 在巨型 handler 外，
 * 但调用了只存在于 handler 内的解析函数。这里钉住模块级蒸馏必须用
 * 模块级 firstJsonObject，避免同类作用域错误再次上线。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'apps/server/src/routes/junshiWorkbench.js'), 'utf8');
const distillStart = source.indexOf('async function runBrainDistill');
const distillEnd = source.indexOf('/* ───────────── SSE', distillStart);
assert.ok(distillStart >= 0 && distillEnd > distillStart, '没找到 runBrainDistill');
const distill = source.slice(distillStart, distillEnd);
assert.match(distill, /firstJsonObject\(result\.text\)/, '蒸馏真实渠道必须用模块级 firstJsonObject');
assert.doesNotMatch(distill, /parseLooseJsonObject/, 'runBrainDistill 不能引用 handler 内的 parseLooseJsonObject');
const firstJsonAt = source.indexOf('function firstJsonObject');
const handlerAt = source.indexOf('export async function handleJunshiWorkbench');
assert.ok(firstJsonAt >= 0 && handlerAt > firstJsonAt, 'firstJsonObject 必须是 handler 外的模块级函数');

console.log(JSON.stringify({ name: 'p194-junshi-module-json-parser', pass: true, checks: 3 }));
