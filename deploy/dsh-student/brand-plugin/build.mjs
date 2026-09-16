/**
 * 构建期：把品牌图的 data URL 注入 lib/client.js（替换 __LINGDONG_LOGO_DATA_URL__）。
 *
 * 为什么内联而不是放静态文件：dsh 的 web 前端由它自己发，容器里另放一个 png
 * 就要额外接一条静态路由；内联进客户端 bundle 是最不容易出错的做法。
 *
 * 用法：node build.mjs <品牌图.png>   （默认取 /opt/brand-plugin/logo.png）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const logoPath = process.argv[2] || path.join(here, 'logo.png');
const clientPath = path.join(here, 'lib', 'client.js');

if (!fs.existsSync(logoPath)) {
  console.error(`[brand] 找不到品牌图：${logoPath}`);
  process.exit(1);
}
const bytes = fs.readFileSync(logoPath);
if (!/^\x89PNG/.test(bytes.subarray(0, 4).toString('latin1'))) {
  console.error(`[brand] 品牌图必须是 PNG：${logoPath}`);
  process.exit(1);
}
const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
const source = fs.readFileSync(clientPath, 'utf8');
if (!source.includes('__LINGDONG_LOGO_DATA_URL__')) {
  // 已经注入过（重复构建）就不动，避免把上一版的 data URL 又嵌一层
  console.log('[brand] 已经注入过品牌图，跳过');
} else {
  fs.writeFileSync(clientPath, source.replace('__LINGDONG_LOGO_DATA_URL__', dataUrl));
  console.log(`[brand] 品牌图已内联（${Math.round(bytes.length / 1024)} KB → ${Math.round(dataUrl.length / 1024)} KB base64）`);
}
