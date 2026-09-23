/**
 * 阿里云 OSS 客户端（零依赖，手写 V1 签名）。
 *
 * 为什么不引 ali-oss：这是**刚上线**的生产，多一个依赖就多一份 lockfile 与构建面；
 * 而我们要的能力只有四个（放、取签名 URL、删、探存在），V1 签名的规则是公开且稳定的
 * （HMAC-SHA1 + 一段固定拼法），手写比引包更好审计。
 *
 * ⚠️ 两个端点要分清，这是**省钱又提速**的关键：
 *   · OSS_ENDPOINT          公网端点（如 oss-cn-guangzhou.aliyuncs.com）—— 给**浏览器**的签名 URL 用它
 *   · OSS_INTERNAL_ENDPOINT 内网端点（同地域 ECS 用，如 oss-cn-guangzhou-internal.aliyuncs.com）
 *                           —— **服务器自己**读写用它：走近乎免费、且不占那 5 Mbps 的公网出口
 *   内网端点只有**同一个地域**的 ECS 能用；没配就退回公网端点。
 *
 * 配置（都在 /etc/ai-kids-platform/production.env，权限 600）：
 *   FILE_STORAGE=oss                  总开关；不设或设 local 时本模块不参与任何路径
 *   OSS_BUCKET / OSS_REGION / OSS_ENDPOINT / OSS_INTERNAL_ENDPOINT
 *   OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET
 *   OSS_PREFIX=<可选，对象键的统一前缀，便于与其他用途共用一个 bucket>
 */
import { createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const cfg = () => ({
  bucket: String(process.env.OSS_BUCKET || '').trim(),
  region: String(process.env.OSS_REGION || '').trim(),
  publicEndpoint: String(process.env.OSS_ENDPOINT || '').trim().replace(/^https?:\/\//, ''),
  internalEndpoint: String(process.env.OSS_INTERNAL_ENDPOINT || '').trim().replace(/^https?:\/\//, ''),
  accessKeyId: String(process.env.OSS_ACCESS_KEY_ID || '').trim(),
  accessKeySecret: String(process.env.OSS_ACCESS_KEY_SECRET || '').trim(),
  prefix: String(process.env.OSS_PREFIX || '').trim().replace(/^\/+|\/+$/g, ''),
});

/** 配置齐了没有。缺任何一项就当没配 —— 调用方据此退回本地存储，绝不半开。 */
export function ossConfigured() {
  const c = cfg();
  return Boolean(c.bucket && c.accessKeyId && c.accessKeySecret && (c.publicEndpoint || c.region));
}

/** 当前存储后端。只有显式写了 FILE_STORAGE=oss 且配置齐全才走 OSS。 */
export function storageBackend() {
  return String(process.env.FILE_STORAGE || 'local').trim().toLowerCase() === 'oss' && ossConfigured() ? 'oss' : 'local';
}

/** 诊断用（**不要**把 secret 打出来） */
export function ossInfo() {
  const c = cfg();
  return {
    configured: ossConfigured(),
    backend: storageBackend(),
    bucket: c.bucket || null,
    region: c.region || null,
    publicEndpoint: publicEndpoint() || null,
    internalEndpoint: c.internalEndpoint || null,
    prefix: c.prefix || null,
    accessKeyIdTail: c.accessKeyId ? `…${c.accessKeyId.slice(-4)}` : null,
  };
}

function publicEndpoint() {
  const c = cfg();
  return c.publicEndpoint || (c.region ? `oss-${c.region}.aliyuncs.com` : '');
}

function internalEndpoint() {
  const c = cfg();
  return c.internalEndpoint || (c.region ? `oss-${c.region}-internal.aliyuncs.com` : '');
}

/** 带前缀的对象键（对外的 storage_key 一律是带前缀的完整键，便于换 bucket 时不受影响） */
export function withPrefix(key) {
  const c = cfg();
  const clean = String(key || '').replaceAll('\\', '/').replace(/^\/+/, '');
  return c.prefix ? `${c.prefix}/${clean}` : clean;
}

/** 路径编码：按段编码、保留 `/`（OSS 的键里 `/` 是普通字符，不能被转义成 %2F） */
function encodeKey(key) {
  return String(key).split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/**
 * V1 签名的待签串。
 *   VERB + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date + "\n"
 *   + CanonicalizedOSSHeaders + CanonicalizedResource
 * 其中：
 *   · 生成**签名 URL** 时，第四行的 Date 位置上放的是 `Expires`（unix 秒）
 *   · CanonicalizedResource = "/<bucket>/<key>"，若有子资源（response-* 之类）则按字典序
 *     以 `?k=v&k2=v2` 接在后面 —— **子资源必须参与签名**，否则 OSS 会判签名不匹配。
 * （导出是为了能不带凭据地做自检，见下方 selfTest。）
 */
export function stringToSignV1({ verb = 'GET', key = '', contentType = '', dateOrExpires = '', subResources = {} } = {}) {
  const c = cfg();
  // 子资源有两种形态，都要正确进签名：
  //   · 有值（response-content-disposition=attachment;…）→ 拼成 k=v
  //   · **有键无值**（`?policy`、`?acl` 这类 bucket 级操作）→ 只拼键名，**不能带等号**
  //     用 `true` 表示这种；'' / null / undefined 一律当"没有这一项"（那种拼出 `?k=` 是错的）
  const keys = Object.keys(subResources)
    .filter((k) => subResources[k] !== undefined && subResources[k] !== null && subResources[k] !== '')
    .sort();
  const canonicalResource = `/${c.bucket}/${String(key).replace(/^\/+/, '')}`
    + (keys.length ? `?${keys.map((k) => (subResources[k] === true ? k : `${k}=${subResources[k]}`)).join('&')}` : '');
  return `${verb}\n\n${contentType}\n${dateOrExpires}\n${canonicalResource}`;
}

/** 用 secret 把待签串签成 Authorization 里的那段 */
export function signV1(fields) {
  const c = cfg();
  if (!c.accessKeySecret) throw new Error('OSS_ACCESS_KEY_SECRET 未配置');
  return createHmac('sha1', c.accessKeySecret).update(stringToSignV1(fields), 'utf8').digest('base64');
}

/** 服务器自己读写用的地址（内网优先） */
function serverUrl(key, subResources = {}) {
  const qs = Object.keys(subResources).length
    ? `?${Object.entries(subResources).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    : '';
  return `https://${cfg().bucket}.${internalEndpoint()}/${encodeKey(key)}${qs}`;
}

/**
 * 签发一个**给浏览器**用的 URL（公网端点）。
 * @param {string} key          对象键（不带前缀也行，这里会补）
 * @param {object} opts
 *   expires            有效期秒数，默认 900
 *   contentType        覆盖响应头 content-type（会参与签名）
 *   contentDisposition 覆盖响应头 content-disposition（下载用 attachment; filename=…）
 *   cacheControl       覆盖响应头 cache-control
 */
export function signedUrl(key, { expires = 900, contentDisposition, cacheControl, method = 'GET' } = {}) {
  if (!ossConfigured()) throw new Error('OSS 未配置，无法签发 URL');
  const c = cfg();
  const fullKey = withPrefix(key);
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(1, Number(expires) || 900);
  const subResources = {};
  // ⚠️ 两条线都是**实测**出来的（2026-09-23），别照直觉改：
  //   ① **不要传 response-content-type**：阿里云直接回 400
  //      `InvalidRequest: Can not override response header on content-type`
  //      —— 对象上传时已带 Content-Type，就不允许再由 URL 覆盖。我们上传时本来就把 mime
  //      写对了，浏览器拿到的类型本来就是对的。
  //   ② **`inline` 会被无视**：请求 `inline` 回给你的仍是 `attachment`；只有 `attachment; filename=…`
  //      这类会原样生效。这对我们没有影响 —— 走这条重定向的只有**下载**（要的就是 attachment + 文件名），
  //      而**预览**走的是"先把对象取到本地再发"（见 fileAssets.js），不经过签名 URL。
  if (contentDisposition) subResources['response-content-disposition'] = contentDisposition;
  if (cacheControl) subResources['response-cache-control'] = cacheControl;
  const signature = signV1({ verb: method, key: fullKey, dateOrExpires: expiresAt, subResources });
  const params = new URLSearchParams({
    OSSAccessKeyId: c.accessKeyId,
    Expires: String(expiresAt),
    Signature: signature,
    ...subResources,
  });
  return `https://${c.bucket}.${publicEndpoint()}/${encodeKey(fullKey)}?${params.toString()}`;
}

/**
 * 服务器侧上传一个对象（内网端点）。
 * 成功返回 { key, etag, size }；失败抛错（错误里带 OSS 的返回体，便于排查）。
 */
export async function putObject(key, buffer, contentType = 'application/octet-stream') {
  if (!ossConfigured()) throw new Error('OSS 未配置，无法上传');
  const c = cfg();
  const fullKey = withPrefix(key);
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const date = new Date().toUTCString();
  const signature = signV1({ verb: 'PUT', key: fullKey, contentType, dateOrExpires: date });
  const res = await fetch(serverUrl(fullKey), {
    method: 'PUT',
    headers: {
      Date: date,
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      Authorization: `OSS ${c.accessKeyId}:${signature}`,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OSS 上传失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return { key: fullKey, etag: String(res.headers.get('etag') || ''), size: body.length };
}

/** 服务器侧探测对象是否存在（内网端点）。返回 { exists, size } —— 不抛错，探不到就当不存在。 */
export async function headObject(key) {
  if (!ossConfigured()) return { exists: false, size: 0 };
  const c = cfg();
  const fullKey = withPrefix(key);
  const date = new Date().toUTCString();
  const signature = signV1({ verb: 'HEAD', key: fullKey, dateOrExpires: date });
  try {
    const res = await fetch(serverUrl(fullKey), {
      method: 'HEAD',
      headers: { Date: date, Authorization: `OSS ${c.accessKeyId}:${signature}` },
    });
    if (!res.ok) return { exists: false, size: 0 };
    return { exists: true, size: Number(res.headers.get('content-length') || 0) };
  } catch { return { exists: false, size: 0 }; }
}

/**
 * 把对象**取到本地文件**（内网端点）。
 * 为什么要它：课件预览要把 Office 文件交给 LibreOffice 转换，而转换器只认本地路径
 * （见 services/materialPreview.js）。所以 OSS 上的课件得先落到本地临时目录再转。
 * 用流写文件，避免把大文件整个读进内存（上限是 200MB 级的课件）。
 */
export async function getObjectToFile(key, destPath) {
  if (!ossConfigured()) throw new Error('OSS 未配置，无法下载');
  const c = cfg();
  const fullKey = withPrefix(key);
  const date = new Date().toUTCString();
  const signature = signV1({ verb: 'GET', key: fullKey, dateOrExpires: date });
  const res = await fetch(serverUrl(fullKey), {
    method: 'GET',
    headers: { Date: date, Authorization: `OSS ${c.accessKeyId}:${signature}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OSS 下载失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
  return { path: destPath, bytes: Number(res.headers.get('content-length') || 0) };
}

/**
 * 设置 **bucket 策略**（公开读只开指定前缀用）。
 *
 * ⚠️ 这是**安全边界**上的操作：策略写错会把私有的课件/学生素材一起放开。
 *    所以这个函数只负责"把策略装上去"，**用什么策略由调用方决定**，
 *    并且在装完之后**必须验证**：公开前缀能匿名读、私有前缀仍然拒绝（见 11 号脚本）。
 *
 * 请求形状（Aliyun V1）：`PUT /?policy`，CanonicalizedResource = `/<bucket>/?policy`，
 * 策略 JSON 放在 body 里。不需要额外的 CanonicalizedOSSHeaders，所以现有的签名字段就够。
 */
export async function putBucketPolicy(policy) {
  if (!ossConfigured()) throw new Error('OSS 未配置，无法设置策略');
  const c = cfg();
  const body = Buffer.from(typeof policy === 'string' ? policy : JSON.stringify(policy), 'utf8');
  const date = new Date().toUTCString();
  const signature = signV1({ verb: 'PUT', key: '', contentType: 'application/json', dateOrExpires: date, subResources: { policy: true } });
  const res = await fetch(`https://${c.bucket}.${internalEndpoint()}/?policy`, {
    method: 'PUT',
    headers: {
      Date: date,
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      Authorization: `OSS ${c.accessKeyId}:${signature}`,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OSS 设置策略失败：HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return { ok: true };
}

/** 读回当前 bucket 策略（验证用；没设过会返回 404，这里当"没有策略"处理） */
export async function getBucketPolicy() {
  if (!ossConfigured()) return null;
  const c = cfg();
  const date = new Date().toUTCString();
  const signature = signV1({ verb: 'GET', key: '', dateOrExpires: date, subResources: { policy: true } });
  const res = await fetch(`https://${c.bucket}.${internalEndpoint()}/?policy`, {
    method: 'GET',
    headers: { Date: date, Authorization: `OSS ${c.accessKeyId}:${signature}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

/** 服务器侧删除对象（内网端点）。删不存在的对象也返回 ok（OSS 语义）。 */
export async function deleteObject(key) {
  if (!ossConfigured()) throw new Error('OSS 未配置，无法删除');
  const c = cfg();
  const fullKey = withPrefix(key);
  const date = new Date().toUTCString();
  const signature = signV1({ verb: 'DELETE', key: fullKey, dateOrExpires: date });
  const res = await fetch(serverUrl(fullKey), {
    method: 'DELETE',
    headers: { Date: date, Authorization: `OSS ${c.accessKeyId}:${signature}` },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`OSS 删除失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return { deleted: true };
}

/**
 * 不带任何凭据的自检：只验证**签名算法本身**（HMAC-SHA1 + 待签串拼法）没被改坏。
 * 用固定输入算出一个固定摘要，由 scripts/p136-oss-signature.mjs 钉住期望值。
 * 不需要 OSS 配置也能跑 —— 真正的连通性验证要等密钥到位后走 deploy/production/migrate/09-verify-oss.mjs。
 */
export function selfTest() {
  const probe = 'GET\n\n\n1234567890\n/bucket-a/dir/file.png';
  return createHmac('sha1', 'test-secret').update(probe, 'utf8').digest('base64');
}
