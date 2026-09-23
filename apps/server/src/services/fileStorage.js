/**
 * 文件存储适配层：把「对象到底放在本地盘还是 OSS」这件事收在一处。
 *
 * 为什么要有这一层：`file_assets` 表里有 282 行上传（历史上）以及生成产物，
 * 它们**不会因为打开开关就搬家**。所以每一行都得能各自回答"我在哪儿"：
 *   · 判据放在 `metadata.storageBackend`（表里已有一个 metadata JSON 列，**不用改 schema**）
 *   · **缺省（老数据）一律当本地盘** —— 不迁移也能继续跑，回滚就是把标记删掉
 *
 * 开关是两段的，任何一段不满足都退回本地（`objectStorage.js` 里 fail-closed）：
 *   ① env 里有 FILE_STORAGE=oss
 *   ② OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / 端点 都齐
 */
import { parseJson } from '@platform/database';
import { ossConfigured, storageBackend, putObject, signedUrl, getObjectToFile, headObject, withPrefix, deleteObject, ossInfo } from './objectStorage.js';

/** 这一行的对象在哪个后端：'oss' 或 'local'（缺省即 local，老数据安全） */
export function rowStorageBackend(file) {
  if (!file) return 'local';
  const meta = parseJson(file.metadata, {}) || {};
  return meta.storageBackend === 'oss' ? 'oss' : 'local';
}

/** 新建的字节该写到哪儿（写与读两边的判据必须一致，所以都走这里） */
export function uploadBackend() {
  return storageBackend();
}

/**
 * 落一次上传的字节。本地走原来的 `wx` 独占写；OSS 走 putObject（失败直接抛，绝不留半份）。
 * 注意返回的 storageKey **在 OSS 模式下是带前缀的完整键**，回滚换 bucket/前缀时不会认错。
 */
export async function persistUploadBytes({ relativeKey, buffer, mimeType, writeLocal }) {
  if (uploadBackend() === 'oss') {
    const result = await putObject(relativeKey, buffer, mimeType);
    return { storageKey: result.key, storageBackend: 'oss', storagePath: null };
  }
  const storagePath = await writeLocal();
  return { storageKey: String(relativeKey).replaceAll('\\', '/'), storageBackend: 'local', storagePath };
}

/**
 * 给客户端一个"去哪儿取这个文件"的交代。
 *   · OSS 行 → 返回 `{ redirectUrl }`：**302 到带签名的临时地址**，字节不经过我们这台机
 *     （这台机的公网出口只有 5 Mbps，媒体全从它出去会拖慢所有人）
 *   · 本地行 → 返回 null，调用方继续走原来的流式下发
 */
export function ossRedirectUrl(file, { expires = 900, contentType, contentDisposition } = {}) {
  if (!file || rowStorageBackend(file) !== 'oss') return null;
  const key = String(file.storage_key || '').replaceAll('\\', '/');
  if (!key) return null;
  if (!ossConfigured()) return null; // 配置被人临时撤掉时退回本地路径，让它照旧报"文件不存在"而不是 500
  return signedUrl(key, { expires, contentType, contentDisposition });
}

/** OSS 上有没有这个对象（回填脚本与巡检用） */
export async function objectExists(file) {
  const key = String(file?.storage_key || '').replaceAll('\\', '/');
  if (!key || !ossConfigured()) return { exists: false, size: 0 };
  return headObject(key);
}

/**
 * 需要本地路径才能处理的场景（课件预览要交给 LibreOffice 转换，它只认本地文件）。
 * 把 OSS 对象取到 destPath；已有则跳过（免重复下载）。返回本地路径。
 */
export async function materializeObject(file, destPath) {
  const key = String(file?.storage_key || '').replaceAll('\\', '/');
  if (!key) throw new Error('这一行没有 storage_key');
  const probe = await headObject(key).catch(() => ({ exists: false }));
  if (!probe.exists) throw new Error(`OSS 上找不到对象：${key}`);
  await getObjectToFile(key, destPath);
  return destPath;
}

/** 删对象（删除文件资产时用；本地行由调用方自己 rm） */
export async function removeObject(file) {
  const key = String(file?.storage_key || '').replaceAll('\\', '/');
  if (!key || rowStorageBackend(file) !== 'oss') return { deleted: false, reason: 'not-oss' };
  await deleteObject(key);
  return { deleted: true };
}

/** 运维用：当前存储总览（**不打印 secret**） */
export function storageOverview() {
  return { ...ossInfo(), withPrefixSample: withPrefix('2026/09/example.png') };
}
