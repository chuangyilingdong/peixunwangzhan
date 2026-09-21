/**
 * multipart 请求体的**内存闸**（2026-09-21，跟着单文件上限提到 200MB 一起来的）。
 *
 * 为什么需要它：请求体是一次性读进内存的（`readBodyBuffer` 拿到整块 Buffer，multipart 解析用
 * `subarray` 做视图、不再复制，所以峰值就是这一块）；而紧随其后的病毒扫描更狠 —— 每次上传都
 * spawn 一个 `clamscan`，它要重新加载病毒库，**实测扫 150MB 文件峰值 RSS ≈990MB**。
 * 生产机 1.6GB：上限提到 200MB 之后，两份这样的大请求叠在一起就会 OOM ——
 * 而这台机器上被 OOM 挑走过学生的创作环境（见交接文档的事故复盘）。
 *
 * 所以：**在读 body 之前**先占一个名额（拿到的是整块 Buffer，所以名额要活到响应发完），
 * 超了当场给一句中文（429 `UPLOAD_BUSY`），**不走到分配内存那一步**。
 * 名额用完必须 release（调用方挂在 `res.on('finish'|'close')` 上，release 是幂等的）。
 *
 * ⚠️ 这是**平台级**的闸（不分用户/机构）：默认「同时 2 份 / 合计 256MB」——
 * 也就是说一份 200MB 的上传天然互斥，不会出现两份同时在扫。
 * 与 `uploadLimits.js` 那套（每用户/每机构的频率、并发、配额）是两回事，两道都要有。
 */
const DEFAULT_MAX_INFLIGHT = 2;
const DEFAULT_MAX_INFLIGHT_BYTES = 256 * 1024 * 1024;

function positiveInt(raw, fallback) {
  const value = Number(raw || fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function bodyGateLimits(env = process.env) {
  return {
    maxBodies: positiveInt(env.FILE_UPLOAD_MAX_INFLIGHT, DEFAULT_MAX_INFLIGHT),
    maxBytes: positiveInt(env.FILE_UPLOAD_MAX_INFLIGHT_BYTES, DEFAULT_MAX_INFLIGHT_BYTES),
  };
}

const state = { count: 0, bytes: 0, busy: 0 };

/** 当前在飞的名额（给守卫与诊断看）。 */
export function bodyGateState() {
  return { ...state };
}

/**
 * 占一个名额。返回 release（幂等）。
 * @param {number} declaredBytes - 来自 content-length；未知时按 0 计（只占份数）
 * @param {(message: string, code: string, details?: object) => Error} tooMany - 由调用方注入错误构造器
 */
export function acquireBodySlot(declaredBytes, { env = process.env, tooMany } = {}) {
  const { maxBodies, maxBytes } = bodyGateLimits(env);
  const size = Number.isFinite(declaredBytes) && declaredBytes > 0 ? Math.floor(declaredBytes) : 0;
  if (state.count + 1 > maxBodies || state.bytes + size > maxBytes) {
    state.busy += 1;
    throw tooMany('同时上传的文件太多，请稍后再试', 'UPLOAD_BUSY', { retryAfterSeconds: 10 });
  }
  state.count += 1;
  state.bytes += size;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.count -= 1;
    state.bytes -= size;
  };
}
