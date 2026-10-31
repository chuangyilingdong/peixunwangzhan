# 修复 · 老师端教案 DOCX 预览报「文档解析失败」（2026-10-31）

## 现象

老师端从课程备课进入，PPT 可以正常打开预览；教案 DOCX 打开失败：

```text
文档解析失败：undefined is not a function (near '...(function () { })...')
```

## 根因

- PPT 走 `pptx-preview` **原生渲染**，不经过 pdf.js，所以正常；
- 教案 DOCX 走「服务端 LibreOffice 转 PDF → 浏览器 pdf.js 渲染」；
- `pdfjs-dist 6.3` 的 **legacy 构建仍然依赖 `Promise.withResolvers`**（ES2023 API，Safari 17.4 才有；
  legacy 里的 core-js 没补这一项）；
- 缺失时在 `new PDFDocumentLoadingTask()` / `getDocument()` 里直接抛 TypeError；
  Safari/JavaScriptCore 显示成 `undefined is not a function (near '...(function () { })...')`。

实测复现：Chromium 里删掉 `Promise.withResolvers`，`getDocument` 立即报
`TypeError: Promise.withResolvers is not a function`，调用栈在
`PDFDocumentLoadingTask` 构造 → `Module.getDocument`。

## 修复

在两处 pdf.js 动态 import 之前补一个最小 polyfill：

- `apps/org/src/components/TeachingAssetViewer.jsx`（老师端教学素材查看器）
- `packages/shared/src/console/PreviewFrame.jsx`（官网/机构端/平台端的文档预览共用）

```js
function ensurePromiseWithResolvers() {
  if (typeof Promise.withResolvers === 'function') return;
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}
```

必须在 `import('pdfjs-dist/legacy/build/pdf.mjs')` 之前执行。

## 发布与验证

- 提交：`29c1b825`
- release：`20261031T041031Z`，39/39 自检通过，health 200；
- 发布前确认没有 `QUEUED/RUNNING` 生成任务，未打断学生生成；
- org / admin / website 三个前端构建通过；
- 发布产物里 `withResolvers` 补丁已进入 org/admin/website 的 index/pdf chunk；
- 本地隔离验证：删掉 API 能复现，补 polyfill 后 `getDocument + render` 正常。

## 如果还报

先确认老师的浏览器/系统：

- Safari 需要 17.4+（iPadOS 17.4+）；
- 临时可用 Chrome / Edge 桌面版打开教案；
- 如果升级/换浏览器后仍报，下一步做**服务端 PDF 转页面图片**兜底（不依赖浏览器 pdf.js），
  需要 poppler/`pdftoppm` 或等价渲染器；届时按那套单独实施。

---

## 第二次修复（2026-10-31 晚）：主线程 polyfill 到不了 pdf.js worker

### 为什么第一次没修好

第一次只在**主线程**补了 `Promise.withResolvers`，并在 Chromium 里删掉主线程的这个 API 做验证 ——
但 Chromium 的 **worker 是独立作用域，仍然原生支持**，所以「补完能渲染」是假阳性。

真实情况：

- pdf.js 把解析放进 **Web Worker**，主线程的 polyfill 进不去 worker；
- worker 里的 `WorkerTask`、`MessageHandler.sendWithPromise`、`ChunkedStreamManager` 都会调
  `Promise.withResolvers`；预览地址是 HTTP URL 且常带 Range 请求，`ChunkedStreamManager`
  一定会被构造；
- 于是 worker 里抛 `TypeError`，经 MessageHandler 包成 `UnknownErrorException` 回到主线程；
  Safari/JavaScriptCore 的文案就是
  `undefined is not a function (near '...(function () { })...')`。

### 复现（可复跑）

`scripts/p177-pdfjs-worker-withresolvers.mjs`：

- 在 Chromium 页面里先 `delete Promise.withResolvers`，再补回主线程 polyfill；
- 反向对照：给 pdf.js 一个**真 worker**，在 worker 模块求值后删掉它的 `withResolvers`，
  用 `getDocument({ url, rangeChunkSize: 100 })` → 必报
  `UnknownErrorException: Promise.withResolvers is not a function`（复现老师现场）；
- 修复路径：把 worker 模块 `import` 到主线程，pdf.js 检测到 `globalThis.pdfjsWorker`
  后自动改用 **fake worker**（LoopbackPort，与主线程同一份 polyfill）→ 同一份 PDF 解析成功。

### 修复口径

两处 pdf.js 加载器（`apps/org/src/components/TeachingAssetViewer.jsx`、
`packages/shared/src/console/PreviewFrame.jsx`）改成：

1. 在补 polyfill **之前**判断浏览器是否**原生**支持 `Promise.withResolvers`；
2. 原生不支持时 `await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs')`，
   让 pdf.js 走 fake worker（主线程解析）；原生支持时仍用真 worker，性能不变；
3. polyfill 函数打 `__platformPreviewPolyfill` 标记，避免两个加载器互相把补丁误判成原生；
4. 预览失败时错误行追加浏览器版本（如 `（Safari 16.6）`），老师截图即可判断环境，
   控制台同时打印 UA / 是否原生支持。

> fake worker 会把 PDF 解析放在主线程：只对老浏览器生效，教案 DOCX 这类小文件足够；
> 若以后有老 Safari 打开超大 PDF 卡顿，再改为「自定义 worker entry 里注入 polyfill」以保留 worker。

### 发布

- 代码提交：`f77604f7`
- release：`20261031T042609Z`（从 `f77604f7` 构建），active / health 200 / 四端入口 200
- 回滚点：`20261031T041031Z`
- 发布前确认 MySQL `generation_jobs` 无 `QUEUED/RUNNING`（当时 FAILED 97 / SUCCEEDED 355）

### 如果这次还报

错误行现在会带浏览器版本。请老师截图；同时看是否满足：

- **Safari 17.3 及以下**：本次修复应生效。若仍报，检查页面是否真的加载了新包
  （`/org/` 的 index.html 是 `no-cache`，但仍需刷新一次），以及控制台
  `[教学素材] 文档解析失败` 里的 `nativeWithResolvers` 是否为 `false`。
- **Safari 17.4+**：说明不是 `Promise.withResolvers` 缺失，转做服务端 PDF→页面图片兜底
  （poppler/`pdftoppm` 或等价渲染器），不再依赖浏览器 pdf.js。
