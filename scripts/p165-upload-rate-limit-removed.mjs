/**
 * P165 上传**频率**限制已取消（用户 2026-09-28 口径）。
 *
 * 原话两句：「上传失败：个人上传频率达到上限。**这个限制取消。**」
 * 场景：运营在课时编排里给一节课连传十来个教学素材（PPT / 教案），撞上了
 * `FILE_UPLOAD_USER_PER_HOUR`（默认 20 次/小时）那道闸。
 *
 * 这条网盯三件事：
 *   ① **频率闸真的没了** —— 判据不是"默认值调大了"，而是**把 env 调成 1 次/小时再连传 25 次**：
 *      env 现在完全不起作用，25 次都得过（改回去的话第 2 次就抛 UPLOAD_USER_RATE_LIMIT）；
 *   ② **并发闸与容量配额还在** —— 这次只取消频次，另外两类不是频次闸、用户也没让取消
 *      （删多了会静静地把防滥用能力也删掉，所以这里反向钉住）；
 *   ③ 模块里不再有那两个错误码与窗口计数器的残留（否则"取消"只是嘴上说说）。
 *
 * ⚠️ 判静态部分之前**先剥注释** —— 这个模块的注释里**正原样写着**那两个 env 名（说明它们已失效），
 *    不剥的话第一条断言永远红。剥注释用共享工具 `scripts/lib/sourceText.mjs`（今天刚统一过去的：
 *    朴素正则会被字符串里的 `/*` 骗，见 p162 那次）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stripComments } from './lib/sourceText.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p165-upload-limits-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});

// ⚠️ 故意把两个频率 env 调到最小（1 次/小时）—— 它们现在应当**完全不起作用**。
process.env.FILE_UPLOAD_USER_PER_HOUR = '1';
process.env.FILE_UPLOAD_ORG_PER_HOUR = '1';

await run(['packages/database/src/db.js', '--init']);
const { reserveUpload, uploadLimitConfig } = await import('../apps/server/src/services/uploadLimits.js');

/* ── ① 频率闸没了：env 调成 1 次/小时，连传 25 次都要过 ─────────────────── */
console.log('① 频率闸已取消（env 调成 1 次/小时，连传 25 次）');
const attempts = 25;
let blocked = null;
for (let i = 0; i < attempts; i += 1) {
  try {
    const release = await reserveUpload({ userId: 'user_p165', orgId: 'org_p165', bytes: 1024 });
    release();
  } catch (error) { blocked = { at: i + 1, code: error?.code, message: error?.message }; break; }
}
check(`① 连传 ${attempts} 次全部通过（原来第 2 次就会拦 —— env 现在是摆设）`, !blocked,
  blocked ? `第 ${blocked.at} 次被拦：${blocked.code} ${blocked.message}` : '');
check('① 配置里不再有 userPerHour / orgPerHour 这一对', !('userPerHour' in uploadLimitConfig()) && !('orgPerHour' in uploadLimitConfig()),
  JSON.stringify(uploadLimitConfig()));

/* ── ② 并发与容量两道**仍然保留**（这次只取消频次，别删多）────────────── */
console.log('② 并发闸与容量配额仍然有效（只取消频率）');
const held = [];
for (let i = 0; i < 3; i += 1) held.push(await reserveUpload({ userId: 'user_p165b', orgId: 'org_p165b', bytes: 1024 }));
let concurrencyCode = null;
try { await reserveUpload({ userId: 'user_p165b', orgId: 'org_p165b', bytes: 1024 }); } catch (error) { concurrencyCode = error?.code; }
check('② 同时在传超过上限仍会被拦（UPLOAD_CONCURRENCY_LIMIT）', concurrencyCode === 'UPLOAD_CONCURRENCY_LIMIT', String(concurrencyCode));
for (const release of held) release();
let quotaCode = null;
try { await reserveUpload({ userId: 'user_p165c', orgId: 'org_p165c', bytes: 1024 * 1024 * 1024 }); } catch (error) { quotaCode = error?.code; }
check('② 超过容量配额仍会被拦（UPLOAD_USER_QUOTA_EXCEEDED）', quotaCode === 'UPLOAD_USER_QUOTA_EXCEEDED', String(quotaCode));

/* ── ③ 源码里不再有频率闸的残留 ─────────────────────────────────────── */
console.log('③ 源码里没有频率闸的残留');
const code = stripComments(fs.readFileSync(path.join(root, 'apps/server/src/services/uploadLimits.js'), 'utf8'));
check('③ 没有 UPLOAD_USER_RATE_LIMIT / UPLOAD_ORG_RATE_LIMIT 这两个错误码',
  !code.includes('UPLOAD_USER_RATE_LIMIT') && !code.includes('UPLOAD_ORG_RATE_LIMIT'));
check('③ 没有「个人/机构上传频率已达到上限」这两句话术',
  !code.includes('个人上传频率已达到上限') && !code.includes('机构上传频率已达到上限'));
check('③ 窗口计数器（windows / hit()）已清掉，不再读那两个 env',
  !/\bwindows\b/.test(code) && !/\bhit\(/.test(code)
  && !code.includes('FILE_UPLOAD_USER_PER_HOUR') && !code.includes('FILE_UPLOAD_ORG_PER_HOUR'));

console.log('');
if (failures) { console.log(`✗ p165 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p165 上传频率限制已取消（并发与容量配额仍在）：全部通过');
