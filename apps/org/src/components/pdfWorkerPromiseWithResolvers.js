// pdf.js 的 worker 是**独立全局**：主线程补的 Promise.withResolvers 进不来。
// 这个模块在 pdf.worker 之前求值（见 worker entry 的 import 顺序），把缺的 API 补上。
// Safari 17.4 以下（含老师那台 17.0）没有 Promise.withResolvers；pdf.worker 里的
// WorkerTask / ChunkedStreamManager 都会用它，缺了会在 worker 里抛 TypeError。
if (typeof Promise.withResolvers !== 'function') {
  const withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  withResolvers.__platformPreviewPolyfill = true;
  Promise.withResolvers = withResolvers;
}
