/**
 * 进程内 TTL 缓存（2026-11-12）。
 *
 * ⚠️ 只对**单进程**成立：生产是 systemd 起的一个 node 进程，重启即清空。
 *    改多实例 / PM2 cluster 之前，这里必须换成 Redis 或 DB 版本
 *    （和 upstreamSubmitGate.js 顶上那句提醒同源）。
 *
 * 语义：
 *   · 绝对 TTL —— 从 set 那一刻起算，get 不续命。轮询不会把过期时间无限推后。
 *   · 访问提权 —— 命中后 delete+set，满了淘汰最旧（照 fileUploadSecurity 的扫描缓存）。
 *   · ttlMs <= 0 直接禁用：get 恒 miss、set 空操作，作为线上紧急开关。
 */

export function createTtlCache({ name = 'cache', ttlMs = 0, max = 1000 } = {}) {
  const ttl = Number(ttlMs) || 0;
  const limit = Math.max(1, Math.floor(Number(max)) || 1);
  const store = new Map(); // key -> { value, at }

  return {
    name,
    get(key) {
      if (ttl <= 0) return undefined;
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at >= ttl) {
        store.delete(key);
        return undefined;
      }
      // 访问提权：Map 的插入顺序就是淘汰顺序
      store.delete(key);
      store.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      if (ttl <= 0) return;
      store.delete(key);
      store.set(key, { value, at: Date.now() });
      while (store.size > limit) store.delete(store.keys().next().value);
    },
    delete(key) { return store.delete(key); },
    deleteWhere(predicate) {
      let removed = 0;
      for (const key of [...store.keys()]) {
        if (!predicate(key)) continue;
        store.delete(key);
        removed += 1;
      }
      return removed;
    },
    clear() { store.clear(); },
    get size() { return store.size; },
    stats() { return { name, size: store.size, ttlMs: ttl, max: limit }; },
  };
}

/**
 * 同一个 key 的并发未命中只跑一次 loader。
 * 照 materialPreview.js 的 previewJobs 写法，结束后（含失败）删掉在途 Promise。
 */
export function singleFlight(inflight, key, factory) {
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = Promise.resolve().then(factory);
  inflight.set(key, job);
  return job.finally(() => {
    if (inflight.get(key) === job) inflight.delete(key);
  });
}
