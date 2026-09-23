/**
 * 公开内容的出站口：`/media/**`（广场媒体）与 `/downloads/**`（客户端安装包）。
 *
 * 为什么需要它：这两样是吃满这台机 5 Mbps 出口的大头（媒体 1.79G、安装包 392M）。
 * 搬到 OSS 之后，字节由 OSS 直接发，不再经过我们。
 *
 * **为什么不是"给 bucket 开公开读"**（试过，走不通，而且没必要）：
 *   这个 bucket 里同时放着**私有课件**（`lingdong/2026/09/*`），所以它是开着
 *   **「阻止公共访问」**的 —— 那是很负责任的默认设置，任何公开读策略都会被拒。
 *   于是改成：**bucket 全私有，由平台签发临时地址**。这样私有课件更安全，
 *   而且不需要动控制台。
 *
 * 三条路径：
 *   · OSS 有 → **302 到稳定签名地址**（同一对象在同一时间窗内地址恒定，浏览器能正常缓存）
 *   · OSS 没有 → **X-Accel-Redirect 交回 nginx 发本地文件**（Range/视频拖拽由 nginx 原生处理，
 *     也正好是"本地那份文件还在"的兜底）
 *   · 路径不合法 → 404（**不做任何目录拼接**，防 `..` 逃逸）
 *
 * ⚠️ 探测"OSS 有没有"会走一次 HEAD；这里加了 10 分钟的内存缓存，
 *    否则一个页面 20 张图就是 20 次 OSS 往返。
 */
import { headObject, stableSignedUrl, ossConfigured } from '../services/objectStorage.js';

const MEDIA_PREFIX = '/media/';
const DOWNLOADS_PREFIX = '/downloads/';

// 探测结果的内存缓存：key → { inOss, at }
const probeCache = new Map();
const PROBE_TTL_MS = 10 * 60 * 1000;
const PROBE_MAX = 5000;

async function objectInOss(key) {
  const hit = probeCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.inOss;
  let inOss = false;
  try {
    const head = await headObject(key);
    inOss = Boolean(head.exists);
  } catch {
    inOss = false; // 探测失败就当本地有，交给兜底路径 —— 不能让一次网络抖动变成 404
  }
  if (probeCache.size > PROBE_MAX) probeCache.clear();
  probeCache.set(key, { inOss, at: now });
  return inOss;
}

/** 从 URL 路径解出（OSS 键, 本地兜底前缀）；不合法返回 null */
function resolveTarget(pathname) {
  if (pathname.startsWith(MEDIA_PREFIX)) {
    const rest = pathname.slice(MEDIA_PREFIX.length);
    return { keyBase: 'public-media', rest, localPrefix: '/__local_media/' };
  }
  if (pathname.startsWith(DOWNLOADS_PREFIX)) {
    const rest = pathname.slice(DOWNLOADS_PREFIX.length);
    return { keyBase: 'downloads', rest, localPrefix: '/__local_downloads/' };
  }
  return null;
}

export async function handlePublicAssets(ctx) {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return null;
  const pathname = String(ctx.pathname || '');
  const target = resolveTarget(pathname);
  if (!target) return null;

  let decoded;
  try { decoded = decodeURIComponent(target.rest); } catch { return null; }
  // 只认"正常文件名 + 子目录"：拒绝 ..、绝对路径、空名 —— 不做任何越界拼接
  if (!decoded || decoded.includes('..') || decoded.startsWith('/') || /[\x00-\x1f]/.test(decoded)) return null;

  // 客户端更新清单必须**每次读最新的**（发布脚本刚写的新版本要立刻生效），所以它始终走本地。
  if (target.keyBase === 'downloads' && decoded === 'manifest.json') {
    return { __fileResponse: true, status: 200, accelRedirect: `${target.localPrefix}${encodeURI(decoded)}` };
  }

  // `media/web-works/*` 必须**留本地**：那些页面是在**不带 allow-same-origin 的沙箱 iframe**
  // 里跑的（文档 origin 是 opaque/null），里面 `import` 的 ES module 一律按 **CORS 模式**取 ——
  // 而 OSS 不会返回 Access-Control-Allow-Origin（除非给 bucket 配 CORS 规则）。
  // 这一小块只有 21M（10 个 js + 图 + html），留本地最省事，CORS 头本来就在 nginx 那条 location 上。
  // 其余的（ltai-works 的图/视频、安装包）都是 <img>/<video>/下载，**不需要 CORS** ✓
  if (target.keyBase === 'public-media' && decoded.startsWith('web-works/')) {
    return { __fileResponse: true, status: 200, accelRedirect: `${target.localPrefix}${encodeURI(decoded)}` };
  }

  const key = `${target.keyBase}/${decoded}`;

  if (ossConfigured() && await objectInOss(key)) {
    // 稳定签名：窗口内地址恒定 → 浏览器缓存得住；302 本身给 1 小时新鲜度，
    // 于是重复访问直接命中缓存、连这次跳转都不用再走。
    const redirectUrl = stableSignedUrl(key);
    return {
      __fileResponse: true,
      status: 302,
      headers: { 'cache-control': 'public, max-age=3600' },
      redirectUrl,
    };
  }

  // 兜底：本地那份文件还在，交回 nginx 发（Range 由 nginx 处理）
  return { __fileResponse: true, status: 200, accelRedirect: `${target.localPrefix}${encodeURI(decoded)}` };
}

/** 诊断用：探测缓存的样子（不打印内容） */
export function probeCacheStats() {
  return { size: probeCache.size, ttlMs: PROBE_TTL_MS };
}
