// pdf.js 的 worker 入口（2026-10-31）。
//
// 为什么需要自定义 worker entry：Safari 17.4 以下没有 Promise.withResolvers，
// 而 pdf.worker 的 WorkerTask / ChunkedStreamManager 都会用它。主线程补 polyfill 进不到
// worker 作用域；把 worker 模块 import 到主线程（fake worker）又会在 Safari 17.0 上白屏。
// 所以在真 worker 里、在 pdf.worker 求值之前补一份 —— 两个 import 的先后就是求值顺序，
// 不要调换。
import './pdfWorkerPromiseWithResolvers.js';
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
