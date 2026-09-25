/**
 * 客户端安装包上传（2026-09-25，用户口径「图6后台这里要支持我们自己上传更新，上传完成后要能触发更新」）。
 *
 * ── 为什么这条路由**不走**通用的上传管线 ─────────────────────────────────────
 * 通用管线（`index.js` 的 `readBodyBuffer` + `parseMultipartFormData`）是**把整份请求体读进内存**
 * 再解析的，而它的单文件硬顶是 200MB —— 见 fileUploadSecurity.js 里那段"内存闸"的说明：
 * 这台机（7.5G，历史上 1.6G 时被一次大上传打穿过）经不起几百 MB 的 Buffer。而客户端安装包是
 * **377MB**。所以这里在"读 body"之前就分流，用 **流式**：`req` → 临时文件，**边写边算 sha256**，
 * 全程只留 64KB 级的分片，写完 rename 成正式文件（同目录 rename 是原子的，客户端永远看不到半份包）。
 *
 * ── 请求形状（刻意不用 multipart）──────────────────────────────────────────
 *   POST /api/admin/client-update/upload?name=lingdong-client-<版本>-win-x64.exe
 *   Content-Type: application/octet-stream
 *   <body = 安装包原始字节>
 * 元数据只在查询串里（文件名），不解析 multipart —— 少一层解析就少一处能把 377MB 读进内存的地方。
 *
 * ── 落点与「触发更新」──────────────────────────────────────────────────────
 *   · 安装包写到 `manifest.json` 的**同目录**（生产是 /srv/ai-kids-platform/downloads/，nginx 的
 *     `/downloads/` 就是它）；manifest 的路径由 CLIENT_UPDATE_MANIFEST 决定，不另配一个目录。
 *   · 写完清单就是**触发**：客户端启动时读 `/downloads/manifest.json?t=…`（no-store），
 *     看到新版本 + sha256 + 字节数就会走它自己的更新流程。所以"上传完成即触发"不需要额外动作，
 *     唯一要小心的是清单必须**原子写**（见 clientUpdateManifest.writeAtomic）。
 *   · 顺手把包推到 OSS（流式，见 putObjectFromFile）：`/downloads/<名字>` 在 OSS 上有就会 302，
 *     客户端从 OSS 下载（这台机的公网出口只有 5 Mbps，377MB 从这儿发要 10 分钟）。
 *     ⚠️ 推 OSS **失败不算失败**：本地那份照样能下（X-Accel），响应里用 `ossSynced` 说明情况。
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { audit, envelope, errors, requirePlatformPermission, sendJson } from '../../lib.js';
import { parseClientInstallerName, publishClientInstaller, clientUpdateDir } from '../../services/clientUpdateManifest.js';
import { ossConfigured, putObjectFromFile } from '../../services/objectStorage.js';
import { forgetProbe } from '../publicAssets.js';

export const CLIENT_INSTALLER_UPLOAD_PATH = '/api/admin/client-update/upload';

/**
 * 安装包上限：默认 600MB（现网包 377MB）。env 可调（下限 1MB —— 调小了会在上传时明确报
 * 「安装包不能超过 N MB」，不会静默截断；守卫就是靠这个下限把超限分支跑到）。
 */
function maxInstallerBytes() {
  const configured = Number(process.env.CLIENT_INSTALLER_MAX_BYTES || 0);
  return Number.isFinite(configured) && configured >= 1024 * 1024 ? configured : 600 * 1024 * 1024;
}

/**
 * 把请求体流式落到 destPath，同时算 sha256。
 * 返回 `{ bytes, sha256 }`；中途超限/断流会抛错，并把临时文件删掉。
 */
async function streamToFile(req, destPath, limitBytes) {
  const hash = createHash('sha256');
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw errors.badRequest(`安装包不能超过 ${Math.floor(limitBytes / 1024 / 1024)} MB`, 'INSTALLER_TOO_LARGE');
  }
  await mkdir(dirname(destPath), { recursive: true });
  const temp = `${destPath}.uploading-${process.pid}-${Date.now()}`;
  const out = createWriteStream(temp, { flags: 'wx' });
  let bytes = 0;
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      // ⚠️ 三条退出路径都要 reject：流错误、写错误、以及 req 被客户端掐断（aborted）。
      req.on('aborted', () => rejectPromise(errors.badRequest('上传被中断', 'UPLOAD_ABORTED')));
      req.on('error', rejectPromise);
      out.on('error', rejectPromise);
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > limitBytes) {
          rejectPromise(errors.badRequest(`安装包不能超过 ${Math.floor(limitBytes / 1024 / 1024)} MB`, 'INSTALLER_TOO_LARGE'));
          req.destroy();
          return;
        }
        hash.update(chunk);
        // 背压：写不动就先暂停读，别把内存撑起来（这正是这条路由存在的理由）
        if (!out.write(chunk)) req.pause();
      });
      out.on('drain', () => req.resume());
      req.on('end', () => out.end(() => resolvePromise()));
    });
  } catch (error) {
    out.destroy();
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  // 先 fsync 落盘再 rename：断电时宁可没有这个包，也不要一个"名字在、内容是半截"的安装包
  await new Promise((resolvePromise, rejectPromise) => out.close((error) => (error ? rejectPromise(error) : resolvePromise())));
  return { temp, bytes, sha256: hash.digest('hex') };
}

/**
 * 处理安装包上传。返回 true 表示这条请求已经被它接管（index.js 据此提前 return）。
 * ⚠️ 必须在**读 body 之前**调用。
 */
export async function handleClientInstallerUpload(ctx, req, res) {
  if (ctx.pathname !== CLIENT_INSTALLER_UPLOAD_PATH || ctx.method !== 'POST') return false;
  // 权限与「客户端更新」配置同一档（ADMIN_AUDIT）—— 能改更新策略的人才能发包
  requirePlatformPermission(ctx, 'ADMIN_AUDIT');

  const rawName = String(ctx.search.get('name') || '').trim();
  if (!rawName) throw errors.badRequest('缺少安装包文件名（?name=）', 'INSTALLER_NAME_REQUIRED');
  let parsed;
  try { parsed = parseClientInstallerName(rawName); } catch (error) { throw errors.badRequest(error.message, 'INVALID_INSTALLER_NAME'); }

  const dir = clientUpdateDir();
  const target = join(dir, rawName);
  // 兜一层目录逃逸（文件名已经被上面的正则钉死了，这里只是不给自己留后门）
  if (resolve(target) !== resolve(join(dir, rawName)) || rawName.includes('/') || rawName.includes('\\') || rawName.includes('..')) {
    throw errors.badRequest('安装包文件名不合法', 'INVALID_INSTALLER_NAME');
  }

  const limit = maxInstallerBytes();
  const { temp, bytes, sha256 } = await streamToFile(req, target, limit);
  if (bytes <= 0) {
    await rm(temp, { force: true }).catch(() => {});
    throw errors.badRequest('安装包是空的', 'INSTALLER_EMPTY');
  }
  // 覆盖同名旧包是**正常**操作（重发同一版本），rename 是原子的
  await rename(temp, target);

  // ⭐ 这一步就是"触发更新"：写清单。写坏了要能回滚到"文件在、清单没变"的状态。
  let manifest;
  try {
    manifest = publishClientInstaller({ fileName: rawName, size: bytes, sha256 });
  } catch (error) {
    await rm(target, { force: true }).catch(() => {});
    throw errors.badRequest(error.message, 'INSTALLER_PUBLISH_FAILED');
  }

  // 顺手推 OSS（流式）。失败不影响发布结果，只在响应里说明——本地那份照样能下。
  let ossSynced = false;
  let ossReason = '';
  if (ossConfigured()) {
    try {
      await putObjectFromFile(`downloads/${rawName}`, target, 'application/octet-stream', { cacheControl: 'public, max-age=86400', size: bytes });
      ossSynced = true;
      // 刚推上去的包，别让"OSS 上有没有"的 10 分钟探测缓存把下载打回本机出口
      forgetProbe(`downloads/${rawName}`);
    } catch (error) {
      ossReason = String(error?.message || error).slice(0, 200);
      console.error(`[客户端更新] 安装包已发布到本地，但推 OSS 失败：${ossReason}`);
    }
  } else {
    ossReason = 'OSS 未配置（安装包只在本机，下载会走本机出口）';
  }

  await audit(ctx, 'CLIENT_INSTALLER_PUBLISH', 'PLATFORM_SETTING', rawName, null, {
    version: parsed.version, platform: parsed.platform, bytes, sha256, ossSynced,
  });
  const info = await stat(target).catch(() => null);
  sendJson(res, 200, envelope({
    fileName: rawName,
    version: parsed.version,
    platform: parsed.platform,
    bytes,
    sha256,
    ossSynced,
    ossReason,
    manifest,
    fileOnDisk: Boolean(info?.isFile()),
  }), req);
  return true;
}
