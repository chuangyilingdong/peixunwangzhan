#!/usr/bin/env node
/**
 * 09 · OSS 连通性验收（密钥放进 env 之后**第一件事**就做这个）
 *
 * 验的是真链路，不是配置读没读到：
 *   ① 配置齐不齐（只打印 bucket / 端点 / AK 末四位，**绝不打印 secret**）
 *   ② 服务器 → OSS **内网端点** 能写（putObject）
 *   ③ 服务器能探到（headObject，比字节数）
 *   ④ **给浏览器的签名 URL 能取到同一份字节**（走公网端点、带签名、带覆盖响应头）
 *      —— 这一步是整条链里最容易错的地方（签名拼法、子资源是否参与签名、路径编码）
 *   ⑤ 能删（删掉测试对象，不留垃圾）
 *
 * 跑法（在服务器上，root）：
 *   cd /srv/ai-kids-platform/source
 *   export $(grep -E '^(FILE_STORAGE|OSS_)' /etc/ai-kids-platform/production.env | xargs)
 *   /srv/ai-kids-platform/runtime/node/bin/node deploy/production/migrate/09-verify-oss.mjs
 *
 * ⚠️ 只 import objectStorage.js（**不碰 fileStorage.js**）：后者会经 @platform/database
 *    在 import 期就打开生产库，验收脚本不该有那个副作用。
 */
import { createHash } from 'node:crypto';
import { putObject, headObject, signedUrl, deleteObject, ossInfo, ossConfigured } from '../../../apps/server/src/services/objectStorage.js';

const KEY = `_selftest/verify-${Date.now()}.txt`;
const BODY = Buffer.from(`lingdong oss verify ${new Date().toISOString()}\n`, 'utf8');
const sha = (b) => createHash('sha256').update(b).digest('hex');

let failures = 0;
const step = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('OSS 连通性验收');
console.log('① 配置');
const info = ossInfo();
console.log(`  ${JSON.stringify(info)}`);
step('FILE_STORAGE=oss 且配置齐全', info.backend === 'oss', info.backend !== 'oss' ? '当前判定不是 oss —— 后面几步没意义，先看上面缺哪项' : '');
if (!ossConfigured()) { console.log('\n配置不齐，停止。'); process.exit(1); }

console.log('② 服务器写（内网端点）');
try {
  const put = await putObject(KEY, BODY, 'text/plain; charset=utf-8');
  step('putObject 成功', true, `etag=${put.etag} size=${put.size}`);
} catch (error) {
  step('putObject 成功', false, error.message);
  console.log('\n写不进去，后面的步骤没法验。常见原因：AK/SK 不对、bucket 名不对、端点不对、');
  console.log('或者 RAM 策略里 Resource 没写全（需要 bucket 与 bucket/* 两条）。');
  process.exit(1);
}

console.log('③ 服务器探（内网端点，比对字节数）');
try {
  const head = await headObject(KEY);
  step('headObject 看到对象且大小一致', head.exists && head.size === BODY.length, `exists=${head.exists} size=${head.size}/${BODY.length}`);
} catch (error) { step('headObject', false, error.message); }

console.log('④ 浏览器视角（公网端点 + 签名 + 覆盖响应头）—— 最容易错的一步');
try {
  const url = signedUrl(KEY, {
    expires: 300,
    contentType: 'text/plain; charset=utf-8',
    contentDisposition: 'inline; filename="verify.txt"',
  });
  const res = await fetch(url);
  const got = Buffer.from(await res.arrayBuffer());
  step('签名 URL 取回 200', res.ok, `HTTP ${res.status}`);
  step('取回的字节与写进去的一致', sha(got) === sha(BODY), `sha ${sha(got).slice(0, 12)} / ${sha(BODY).slice(0, 12)}`);
  step('覆盖的 content-type 生效', String(res.headers.get('content-type') || '').includes('text/plain'), res.headers.get('content-type') || '');
  step('覆盖的 content-disposition 生效', String(res.headers.get('content-disposition') || '').includes('inline'), res.headers.get('content-disposition') || '');
} catch (error) { step('签名 URL 取回', false, error.message); }

console.log('⑤ 清理（把测试对象删掉）');
try {
  await deleteObject(KEY);
  const after = await headObject(KEY);
  step('删除后探不到', !after.exists);
} catch (error) { step('删除', false, error.message); }

if (failures) { console.log(`\nOSS 验收失败：${failures} 项 —— 先别把 FILE_STORAGE 打开`); process.exit(1); }
console.log('\nOSS 验收全部通过 —— 现在可以放心地把 FILE_STORAGE 设成 oss 并跑回填');
