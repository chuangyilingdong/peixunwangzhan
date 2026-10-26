/**
 * P194 招生军师：模块级 JSON 解析作用域守卫（2026-10-26）
 *
 * 生产实测「文案大脑 → 添加大脑 → 蒸馏」与「数据复盘 → 截图回填」都失败：
 * 两个模块级函数引用了只存在于巨型 handler 内的 parseLooseJsonObject。
 * 这里钉住它们必须使用模块级 firstJsonObject，防止同类作用域错误再次上线。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'apps/server/src/routes/junshiWorkbench.js'), 'utf8');
const handlerAt = source.indexOf('export async function handleJunshiWorkbench');
const firstJsonAt = source.indexOf('function firstJsonObject');
assert.ok(handlerAt > 0, '没找到 handleJunshiWorkbench');
assert.ok(firstJsonAt >= 0 && handlerAt > firstJsonAt, 'firstJsonObject 必须是 handler 外的模块级函数');

const distillStart = source.indexOf('async function runBrainDistill');
const distillEnd = source.indexOf('/* ───────────── SSE', distillStart);
assert.ok(distillStart >= 0 && distillEnd > distillStart, '没找到 runBrainDistill');
const distill = source.slice(distillStart, distillEnd);
assert.match(distill, /firstJsonObject\(result\.text\)/, '蒸馏真实渠道必须用模块级 firstJsonObject');
assert.doesNotMatch(distill, /parseLooseJsonObject/, 'runBrainDistill 不能引用 handler 内的 parseLooseJsonObject');

const statsStart = source.indexOf('async function extractStatsFromScreenshot');
const statsEnd = source.indexOf('/**', statsStart + 10);
assert.ok(statsStart >= 0 && statsEnd > statsStart && statsStart < handlerAt, '截图回填必须是 handler 外的模块级函数');
const stats = source.slice(statsStart, statsEnd);
assert.match(stats, /firstJsonObject\(result\.text\)/, '截图回填真实渠道必须用模块级 firstJsonObject');
assert.doesNotMatch(stats, /parseLooseJsonObject/, 'extractStatsFromScreenshot 不能引用 handler 内的 parseLooseJsonObject');

console.log(JSON.stringify({ name: 'p194-junshi-module-json-parser', pass: true, checks: 5 }));
