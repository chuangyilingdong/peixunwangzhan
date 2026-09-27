#!/usr/bin/env node
/**
 * 21 · 给首页「视频展示」的视频**补封面图**（写进 CMS 的 posterUrl）。
 *
 * 为什么要它（2026-09-28 用户报「图4手机网页打开官网，这2个视频默认是黑色的封面」）：
 *   卡片上的 `<video>` 用 `poster` 显示封面；生产上那两个视频的 `posterUrl` 都是**空串**，
 *   于是卡片退化成 `.hp-vid-frame{background:#000}` 那块黑。
 *   代码里原本有个"没配封面就用 `#t=0.5` 取首帧"的技巧 —— **在 iOS 上不生效**：
 *   iOS Safari 出于省流量**不会预加载视频数据**，没 poster 就什么都不画。
 *   所以唯一的修法是给它一张**真封面图**（这条路后台本来就有：首页 → 视频展示 → 「上传封面」）。
 *
 * 这个脚本走的就是后台那条路（**不直写内容表**），所以版本历史、审计、公开端全都一致：
 *   ① 用一个**临时会话**（root 超管，会话记录跑完就删）调 `POST /api/admin/file-assets/upload`
 *      → 与后台「上传封面」同一个入口、同一套校验/扫描/OSS 落盘；
 *   ② `PUT /api/admin/website-content/HOME` 写草稿（**只改 videos.items[*].posterUrl**，
 *      其它字段原样保留）；
 *   ③ `POST …/publish` 发布（与后台点「发布」等价：写 revision + published_content）。
 *
 * ⚠️ 会话怎么来的：`sessions` 里 `token_hash = sha256(token)`，而签发/校验都是应用自己的
 *    `tokenHash()`（这里直接 import 它，不复制一份哈希实现 —— 复制就会哪天静默失效）。
 *    这个脚本会往 sessions 插一行、退出时删掉；TTL 给 1 小时，即使脚本被杀也不会留长期后门。
 *
 * 用法（服务器上；先 `export $(grep -E '^(FILE_STORAGE|OSS_|RDS_|DB_)' /etc/ai-kids-platform/production.env | xargs)`）：
 *   node deploy/production/migrate/21-home-video-covers.mjs --poster-dir=/tmp/covers        # 试运行（只读）
 *   node deploy/production/migrate/21-home-video-covers.mjs --poster-dir=/tmp/covers --apply
 * 本机对着一个本地跑着的服务 + 同一个库试（会走 sqlite，因为 store 认 DB_DRIVER）：
 *   PLATFORM_DATA_DIR=.tmp/x PLATFORM_DB_PATH=.tmp/x/platform.db node … --base=http://127.0.0.1:19157 …
 *
 * 约定：`--poster-dir` 下放 `home-video-1-cover.jpg` / `home-video-2-cover.jpg`
 * （按 items 的**顺序**对应第 1、2 个视频；要换图就换文件、别改脚本）。
 * 生成这两张图的命令（本机 ffmpeg，从视频第 1 秒抽帧、缩到 1280 宽）：
 *   ffmpeg -ss 1 -i <视频> -frames:v 1 -vf scale=1280:-2 -q:v 3 -y home-video-1-cover.jpg
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = process.cwd();
/** ⚠️ 两种写法都认：`--name value` 与 `--name=value`（20 号脚本踩过这个坑）。 */
const arg = (name, fallback = '') => {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || fallback;
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
};
const apply = process.argv.includes('--apply');
const base = arg('--base', process.env.COVER_BASE || 'http://127.0.0.1:8789').replace(/\/+$/, '');
const posterDir = arg('--poster-dir', '');
const key = arg('--key', 'HOME');
const force = process.argv.includes('--force');
const reason = arg('--reason', '首页视频展示补封面（走后台同一条上传路）');

if (!posterDir) { console.error('必须给 --poster-dir=<放着 home-video-N-cover.jpg 的目录>'); process.exit(2); }

const app = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib.js')).href);
const { aq, arow, arows, id, tokenHash } = app;

console.log(`目标：${base} · 内容区块 ${key} · 封面目录 ${posterDir}${apply ? '' : ' · **试运行**（加 --apply 才真写）'}`);

// ── 1. 找一个能用的超管（后台那套权限里，上传口要求 SUPER_ADMIN；root 超管还额外拿通配权限）──
const admins = await arows("SELECT id,login,role,org_id,permissions FROM users WHERE role='SUPER_ADMIN' AND deleted_at IS NULL ORDER BY CASE WHEN login='root' THEN 0 ELSE 1 END");
if (!admins.length) { console.error('✗ 库里没有可用的 SUPER_ADMIN，无法走后台接口'); process.exit(1); }
const admin = admins[0];
const permissions = (() => { try { return JSON.parse(admin.permissions || '[]'); } catch { return []; } })();
const isRoot = admin.login === 'root' || permissions.includes('*');
console.log(`· 用超管 ${admin.login}（${admin.id}）${isRoot ? '· 通配权限' : `· 权限 ${permissions.slice(0, 5).join(',') || '（空）'}`}`);
if (!isRoot) console.log('  ⚠️ 不是 root 通配超管：上传口可能因为业务域权限不足而 403（那就换 --base 指到一个 root 超管的实例）');

// ── 2. 当前内容：试运行直接读库（**不建会话、不写任何东西**）；真跑读接口（顺带验一次鉴权）──
const row = await arow('SELECT * FROM website_contents WHERE content_key=?', [key]);
if (!row) { console.error(`✗ 没有 ${key} 这一块内容`); process.exit(1); }
const draft = JSON.parse(row.draft_content || '{}');

// ── 3. 逐条比对封面：要哪几张、跳过哪几张 ──
const items = Array.isArray(draft?.videos?.items) ? draft.videos.items : [];
if (!items.length) { console.error('✗ HOME.videos.items 是空的，没什么可补'); process.exit(1); }
const planned = [];
for (let index = 0; index < items.length; index += 1) {
  const current = String(items[index]?.posterUrl || '').trim();
  const file = path.join(posterDir, `home-video-${index + 1}-cover.jpg`);
  const title = String(items[index]?.title || `第 ${index + 1} 个视频`);
  if (current && !force) { console.log(`· 第 ${index + 1} 个（${title}）已有封面，跳过：${current}`); continue; }
  if (!fs.existsSync(file)) { console.log(`· 第 ${index + 1} 个（${title}）没有对应封面文件 ${path.basename(file)}，跳过`); continue; }
  planned.push({ index, title, file, bytes: fs.statSync(file).size, current });
}
if (!planned.length) { console.log('✓ 没有需要补的封面（本来就是好的）。'); process.exit(0); }
for (const item of planned) {
  console.log(`· 第 ${item.index + 1} 个（${item.title}）：${item.current ? '换封面' : '补封面'} ← ${path.basename(item.file)}（${item.bytes} 字节）`);
}
if (!apply) { console.log('\n（试运行结束，什么都没写。要真跑加 --apply）'); process.exit(0); }

// ── 4. 建一个**临时会话**（跑完就删；1 小时 TTL，脚本被杀也不会留长期后门）──
const token = randomBytes(32).toString('base64url');
const sessionId = id('session');
const now = new Date();
const expiresAt = new Date(now.getTime() + 3600_000).toISOString();
await aq(
  'INSERT INTO sessions(id,token_hash,user_id,role,org_id,client_type,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)',
  [sessionId, tokenHash(token), admin.id, admin.role, admin.org_id || null, 'admin', now.toISOString(), expiresAt],
);
console.log(`· 临时会话已建（${sessionId}，1 小时后自动过期）`);
const headers = { authorization: `Bearer ${token}` };
let exitCode = 0;
try {
  // ── 5. 上传封面（与后台「上传封面」同一个入口）──
  for (const item of planned) {
    const bytes = fs.readFileSync(item.file);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/jpeg' }), path.basename(item.file));
    form.append('category', 'PROMO_COVER');
    form.append('visibility', 'PUBLIC_PLATFORM');
    const response = await fetch(`${base}/api/admin/file-assets/upload`, { method: 'POST', headers, body: form });
    const payload = await response.json().catch(() => ({}));
    const assetId = payload?.data?.id;
    if (!response.ok || !assetId) throw new Error(`上传 ${path.basename(item.file)} 失败：HTTP ${response.status} ${JSON.stringify(payload).slice(0, 300)}`);
    // ⚠️ 写进 CMS 的是**公开下载口**（`/api/public/...`）—— 后台表单也是这么拼的（WebsiteContent.jsx 的 apply()）。
    //    `data.proxyRoute` 是 /api/admin/... 那条，放进去官网会 401/403。
    items[item.index] = { ...items[item.index], posterUrl: `/api/public/file-assets/${assetId}/download` };
    console.log(`· 上传完成：第 ${item.index + 1} 个 → ${assetId}`);
  }

  // ── 6. 写草稿 + 发布（PUT / publish，与后台两个按钮等价）──
  draft.videos = { ...(draft.videos || {}), items };
  const put = await fetch(`${base}/api/admin/website-content/${key}`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ content: draft }),
  });
  const putPayload = await put.json().catch(() => ({}));
  if (!put.ok) throw new Error(`写草稿失败：HTTP ${put.status} ${JSON.stringify(putPayload).slice(0, 300)}`);
  console.log(`· 草稿已写（v${putPayload?.data?.draftVersion ?? '?'}）`);
  const publish = await fetch(`${base}/api/admin/website-content/${key}/publish`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ reason }),
  });
  const publishPayload = await publish.json().catch(() => ({}));
  if (!publish.ok) throw new Error(`发布失败：HTTP ${publish.status} ${JSON.stringify(publishPayload).slice(0, 300)}`);
  console.log(`· 已发布（v${publishPayload?.data?.publishedVersion ?? '?'}）：${reason}`);

  // ── 7. 复核：公开端（不带任何凭据）必须能看到封面地址 ──
  const publicResponse = await fetch(`${base}/api/public/website-content/${key}`);
  const publicPayload = await publicResponse.json().catch(() => ({}));
  const content = publicPayload?.data?.content ?? publicPayload?.data ?? null;
  const published = Array.isArray(content?.videos?.items) ? content.videos.items : [];
  for (const item of planned) {
    const poster = String(published[item.index]?.posterUrl || '');
    if (!poster) throw new Error(`公开端第 ${item.index + 1} 个视频的 posterUrl 还是空 —— 发布没生效`);
    const head = await fetch(`${base}${poster}`, { method: 'GET', redirect: 'manual' });
    if (![200, 302].includes(head.status)) throw new Error(`封面地址取不到图：HTTP ${head.status} ${poster}`);
    console.log(`✓ 公开端第 ${item.index + 1} 个：${poster}（HTTP ${head.status}）`);
  }
} catch (error) {
  exitCode = 1;
  console.error(`✗ ${error.message}`);
} finally {
  await aq('DELETE FROM sessions WHERE id=?', [sessionId]).catch(() => {});
  console.log('· 临时会话已删除');
}
process.exit(exitCode);
