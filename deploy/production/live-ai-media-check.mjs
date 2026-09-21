#!/usr/bin/env node
/**
 * 真跑验收：素材到底有没有被上游拿到（**会花上游的钱，只手工跑**）。
 *
 * 为什么需要它：上游读不到我们域名上的素材时**不报错** —— 首帧/参考图被静默丢掉、
 * 任务照样 succeeded、结果却与输入毫无关系（2026-09-21 用户报「完全不一样的内容」）。
 * 光看任务状态和日志看不出任何异常，**只有把产物本身拿出来比**才知道输入有没有生效。
 * 判据：① 视频——结果视频的**第 0 帧**应该就是那张源图（把 URL 打出来，自己看/抽帧比）；
 *       ② 图片——产物应该是**基于那张源图**改出来的（构图一致）。
 *
 * 用法（在服务器上，release 目录里跑）：
 *   export PATH=/srv/ai-kids-platform/runtime/node/bin:$PATH
 *   cd /srv/ai-kids-platform/production/current
 *   node /path/to/live-ai-media-check.mjs                  # 用"最近一张老师上传的图片素材"当输入
 *   node /path/to/live-ai-media-check.mjs --asset=/api/student/file-assets/file_xxx/download
 *   node /path/to/live-ai-media-check.mjs --only=image     # 只跑图片那条（视频约 ¥0.75、图片约 ¥0.1–0.3）
 *   node /path/to/live-ai-media-check.mjs --dry            # **不花钱**：只把素材传到上游看能不能成
 *
 * 它做的事：读生产渠道配置与密钥（密钥只在内存里，不打印）→ 走**生产代码**（openAiCompatibleProvider）
 * → 首帧/参考图用**我们自己域名**上的地址 → 看产物。素材镜像那段逻辑（services/upstreamMediaMirror.js）
 * 会在发请求前把它换成上游自己的 URL —— 这个脚本验的就是"换了之后上游真的用了"。
 */
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createDecipheriv, createHash } from 'node:crypto';

const RELEASE = process.env.RELEASE_DIR || '/srv/ai-kids-platform/production/current';
const PROD_DATA = '/srv/ai-kids-platform/production/data';
const MODE = 'public';
const VERIFY_DIR = process.env.VERIFY_DIR || '/tmp/ai-media-check';
mkdirSync(VERIFY_DIR, { recursive: true });
// 脚本自己打开的库用**生产库副本**：镜像/解析那几段会按 file_assets 查表（少一张表就会走错路、
// 比如把"我们自己的文件"当成外部 URL 去 HTTP 取 → 私有素材 403）。副本 = 只读使用，不碰生产。
const COPY_DB = `${VERIFY_DIR}/platform.db`;
rmSync(COPY_DB, { force: true });   // 上一次跑留下的副本要先删，VACUUM INTO 不接受已存在的目标
try {
  const { DatabaseSync: DBSync } = await import('node:sqlite');
  const src = new DBSync('/srv/ai-kids-platform/production/data/platform.db', { readOnly: true });
  src.exec(`VACUUM INTO '${COPY_DB}'`);
  src.close();
} catch (error) {
  console.log('取生产库副本失败（脚本仍会跑，但读表那条路会不准）：', error?.message || error);
}

const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = String(item).replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const only = String(args.only || '').toLowerCase();

/* ── 生产配置：策略、密钥、AI_PROVIDER_*（脚本自己打开的库指到临时目录，别碰生产库）── */
process.env.PLATFORM_DATA_DIR = VERIFY_DIR;
process.env.PLATFORM_DB_PATH = COPY_DB;
process.env.DEPLOYMENT_MODE = MODE;

const env = {};
for (const line of readFileSync('/etc/ai-kids-platform/production.env', 'utf8').split('\n')) {
  const matched = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (matched) env[matched[1]] = matched[2].replace(/^["']|["']$/g, '');
}
// ⚠️ 必须真装进 process.env：视频的轮询上限跟着 AI_PROVIDER_TIMEOUT_MS（生产 300000、默认 120000），
//    不装就会把一条 130 秒的正常视频报成"AI 服务响应超时"（2026-09-21 踩过）。
for (const [name, value] of Object.entries(env)) {
  if (/^AI_PROVIDER_/.test(name) || /^FILE_UPLOAD_/.test(name) || name === 'PUBLIC_SITE_URL') process.env[name] = value;
}
const SELF = String(env.PUBLIC_SITE_URL || 'https://iicili.cyou').replace(/\/+$/, '');

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(`${PROD_DATA}/platform.db`, { readOnly: true });
const policy = JSON.parse(db.prepare('SELECT ai_provider_policy FROM platform_settings WHERE id=1').get().ai_provider_policy || '{}');
// 输入素材：优先用参数给的，否则拿**一张公开可见的素材**（口径与 publicFileAssetUrl 一致：
// 只有 PUBLIC_PLATFORM / PUBLIC_RELEASE 且不是教学素材的，才允许发给上游）。
// ⚠️ 别直接拿 course_lesson_materials.asset_url —— 那多半是 `/api/student/...`（要登录），
//    生成链路从不发它；拿它去跑只会撞 401，白折腾。
const fileRow = args.asset
  ? null
  : db.prepare("SELECT id FROM file_assets WHERE status='ACTIVE' AND visibility IN ('PUBLIC_PLATFORM','PUBLIC_RELEASE') AND category<>'TEACHING_ASSET' ORDER BY created_at DESC LIMIT 1").get();
db.close();
const assetArg = String(args.asset || '').trim();
const assetPath = assetArg || (fileRow ? `/api/public/file-assets/${fileRow.id}/download` : '');
if (!assetPath) { console.log('没找到可用的输入素材，请用 --asset=<公开的 /api/public/file-assets/... 地址> 指定'); process.exit(1); }
// 给了 student 作用域的地址也自动折成公开路由（和生成链路的口径一致）
const normalizedPath = assetPath.replace(/^\/api\/(?:student|admin|org)\/file-assets\//, '/api/public/file-assets/');
const ASSET = /^https?:\/\//i.test(normalizedPath) ? normalizedPath : `${SELF}${normalizedPath}`;
if (!ASSET.startsWith(SELF)) { console.log(`⚠️ 给的素材不在我们自己域名下（${ASSET}）—— 这个脚本验的就是自站素材的镜像，换一个。`); process.exit(1); }

const pepper = createHash('sha256').update(String(env.AUTH_PEPPER || 'p0-local-pepper')).digest();
const store = JSON.parse(readFileSync(`${PROD_DATA}/provider-secrets/provider-secrets.json`, 'utf8'));
function apiKeyFor(channelId) {
  const item = store.secrets?.[channelId];
  if (!item) return '';
  const decipher = createDecipheriv('aes-256-gcm', pepper, Buffer.from(item.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(item.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(item.data, 'base64')), decipher.final()]).toString('utf8');
}

const { openAiCompatibleProvider } = await import(`${RELEASE}/apps/server/src/services/openaiCompatibleProvider.js`);
const channelFor = (modality) => (policy.channels || []).find((item) => item.id === policy.modalityChannels?.[modality]) || null;
const providerFor = (modality, model = '') => {
  const channel = channelFor(modality);
  return openAiCompatibleProvider({
    name: channel.provider, model: model || channel.model, endpoint: channel.endpoint,
    apiKey: apiKeyFor(channel.id), requestTemplates: channel.requestTemplates || {},
    modelRequestTemplates: channel.modelRequestTemplates || {}, requestPaths: channel.requestPaths || {},
    pollPaths: channel.pollPaths || {}, selfOrigins: [SELF], pollIntervalMs: 8000,
  });
};

console.log(`输入素材（我们自己域名）：${ASSET}\n`);

// --dry：只验"素材能不能被上游拿到"（上传免费，**不生成、不花钱**）。
// 这一步过不了就别往下花钱了 —— 这正是 2026-09-21 那次故障的位置。
if ('dry' in args) {
  const { mirrorSelfHostedMedia } = await import(`${RELEASE}/apps/server/src/services/upstreamMediaMirror.js`);
  const { defaultMediaUploadPath } = await import(`${RELEASE}/apps/server/src/services/openaiCompatibleProvider.js`);
  const channel = channelFor('VIDEO') || channelFor('IMAGE');
  const uploadPath = defaultMediaUploadPath(channel.endpoint);
  const uploadUrl = uploadPath ? `${new URL(channel.endpoint).origin}${uploadPath}` : '';
  console.log(`dry：上传地址 ${uploadUrl || '(这家上游没配素材暂存，镜像不会启动)'}`);
  const mirrored = await mirrorSelfHostedMedia({ firstFrameUrl: ASSET }, {
    selfOrigins: [SELF], uploadUrl, apiKey: apiKeyFor(channel.id),
  });
  console.log(mirrored.firstFrameUrl === ASSET
    ? '   ❌ 没有被镜像（还是我们自己的地址）—— 上游大概率读不到它'
    : `   ✅ 已换成上游自己的地址：${mirrored.firstFrameUrl}`);
  process.exit(0);
}

const asReference = 'as-reference' in args;   // 视频那条：把素材当**参考**发（不是首帧）

if (only !== 'image') {
  const channel = channelFor('VIDEO');
  console.log(`① 视频模型 ${channel.model}：把这张图当**${asReference ? '参考（启发素材，模型会重画）' : '首帧（关键帧，模型会从这一帧开始）'}**（约 ¥0.75）`);
  try {
    const out = await providerFor('VIDEO').generate({
      modality: 'VIDEO', prompt: '让图片动起来', title: '验收',
      options: asReference
      ? { aspectRatio: '16:9', resolution: '480P', durationSeconds: 5, audio: false, referenceAssets: [{ type: 'IMAGE', url: ASSET }] }
      : { aspectRatio: '16:9', resolution: '480P', durationSeconds: 5, audio: false, firstFrameUrl: ASSET },
    });
    const url = out?.assets?.[0]?.assetUrl || '';
    console.log('   ✅ 已生成：', url);
    console.log('   ⚠️ 判据：把结果视频第 0 帧抽出来，**应该就是那张源图**：');
    console.log(`      curl -s -o /tmp/check.mp4 "<URL>" && ffmpeg -y -i /tmp/check.mp4 -vf "select=eq(n\\,0)" -vframes 1 /tmp/check-f0.png`);
    if (url) writeFileSync(`${VERIFY_DIR}/video-url.txt`, url);
  } catch (error) {
    console.log('   ❌ 失败：', error?.message || error);
  }
}

if (only !== 'video') {
  const channel = channelFor('IMAGE');
  const model = (channel.models || []).find((item) => /2\.5/.test(item)) || channel.model;
  console.log(`\n② 图片模型 ${model}：把这张图当**参考**（约 ¥0.1–0.3）`);
  try {
    const out = await providerFor('IMAGE', model).generate({
      modality: 'IMAGE', prompt: '把这张图改成夜景灯光效果，保持构图', title: '验收',
      options: { aspectRatio: '16:9', resolution: '1k', referenceAssets: [{ type: 'IMAGE', url: ASSET }] },
    });
    const url = out?.assets?.[0]?.assetUrl || '';
    console.log('   ✅ 已生成：', url);
    console.log('   ⚠️ 判据：产物应该是**基于那张源图**改出来的（构图一致），不是一张无关的新图。');
    if (url) writeFileSync(`${VERIFY_DIR}/image-url.txt`, url);
  } catch (error) {
    console.log('   ❌ 失败：', error?.message || error);
  }
}
