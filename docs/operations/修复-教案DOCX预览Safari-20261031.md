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
>
> ⚠️ **2026-10-31 晚更新**：Safari 17.0 上 fake worker **白屏**，这一条已被推翻 ——
> 现已改为「自定义 worker entry + 真 worker」，见文末「第三次修正」。

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

---

## 第三次修正（2026-10-31 晚）：fake worker 在 Safari 17.0 白屏

### 现象

第二次发布后老师反馈：**不报错了，但教案整页白屏**（工具栏显示「第 3 / 共 11 页」、
「正在渲染第 5 页…」，画布纯白）。

### 排查

- 服务端转出来的 PDF **本身有内容**：11 页都有文字（pdf.js 在 Node 里提取正常），
  文件 338KB，不是空文档；
- 用 Chromium 的 fake worker 渲染真实 PDF 能画出像素（darkPixels≈69776），
  WebKit 26 也能画出（≈65250）—— 所以不是 fake worker 的通用 bug，而是
  **Safari 17.0 这一版的 fake worker 路径**（LoopbackPort / structuredClone 等）在真机上白屏；
- 不再赌 fake worker：回到 **真 worker**，只在 worker 里补 withResolvers。

### 修复

- 新增 worker entry（org 与 shared 各一份）：
  - `pdfWorkerPromiseWithResolvers.js`：worker 作用域内的最小 polyfill；
  - `pdfWorkerWithPolyfill.js`：先 import polyfill 模块、再 import
    `pdfjs-dist/legacy/build/pdf.worker.min.mjs`（两个 import 的先后就是求值顺序）。
- 两个加载器在**原生不支持** withResolvers 时：
  ```js
  lib.GlobalWorkerOptions.workerPort = new PdfWorkerWithPolyfill();
  ```
  不再把 worker 模块 import 到主线程；现代浏览器仍用 `?url` 的官方 worker。
- 主线程的 polyfill 保留（`PDFWorker` 构造里的 `Promise.withResolvers` 仍要用）。
- 守卫 `p177` 增加**像素断言**：用生产构建出的 worker（前置 `delete Promise.withResolvers`）
  解析真实 11 页教案，必须 `darkPixels > 100`；反向对照仍是「真 worker 缺 API 必失败」。

### 发布

- 代码提交：`8fce63e7`
- release：`20261031T044923Z`（从 `8fce63e7` 构建），active / health 200 / 四端入口 200
- 回滚点：`20261031T042609Z`（该版 fake worker 在 Safari 17.0 白屏，仅作技术回滚点）
- 发布前 MySQL `generation_jobs` 无 `QUEUED/RUNNING`（FAILED 98 / SUCCEEDED 355）

> 第二次修复（fake worker）的 release `20261031T042609Z` 已由本次取代；历史保留，
> 不要回退到它来解决老 Safari 的教案预览。

---

## 第四次修正（2026-10-31 晚）：Safari 17.0 还缺 `ArrayBuffer.transferToFixedLength`

### 现象

第三次发布（真 worker + withResolvers 补丁）后，老师**仍然白屏**，控制台出现：

```text
Warning: getOperatorList - ignoring errors during "GetOperatorList: page 0" task:
"TypeError: i.transferToFixedLength is not a function.
(In 'i.transferToFixedLength(c)', 'i.transferToFixedLength' is undefined)".
(pdfWorkerWithPolyfill-….js, line 3)
```

### 根因

- `pdf.worker` 的 `compileFontInfo` / `compileSystemFontInfo` 用
  `ArrayBuffer.prototype.transferToFixedLength(c)` 把字体字节截到实际长度；
- 该 API 是 ES2024，**Safari 17.0 没有**（17.4 才有）；
- pdf.js 在 `getOperatorList` 里把这类异常当 **warning 吞掉**，所以界面**不报错**，
  只是 operator list 为空 → 页面白屏；
- 第三次的 worker polyfill 只补了 `Promise.withResolvers`，漏了这个。

### 修复

`pdfWorkerPromiseWithResolvers.js`（org / shared 各一份）增加：

```js
if (typeof ArrayBuffer.prototype.transferToFixedLength !== 'function') {
  Object.defineProperty(ArrayBuffer.prototype, 'transferToFixedLength', {
    configurable: true, writable: true,
    value: function (newByteLength) {
      const length = newByteLength === undefined ? this.byteLength : Number(newByteLength);
      if (!Number.isInteger(length) || length < 0) throw new RangeError('Invalid ArrayBuffer length');
      const source = new Uint8Array(this);
      const target = new ArrayBuffer(length);
      new Uint8Array(target).set(source.subarray(0, Math.min(source.length, length)));
      return target;
    },
  });
}
```

> 原生实现会把原 buffer detach；pdf.js 拿到新 buffer 后不会再用旧的，所以这里只做
> 「截断/补零 + 复制」，不强制 detach（避免在 Safari 17.0 上再依赖 `structuredClone` 的 transfer）。

守卫 `p177` 增加：

- 补丁单测（删掉原生 API → import → 截断 `[1,2,3,4]→[1,2]`、补零 `[7,8]→[7,8,0,0]`）；
- worker 内确认日志 `transferToFixedLength=function`；
- 用生产构建出的 worker、前置 `delete Promise.withResolvers` + `delete transferToFixedLength`，
  解析**真实 11 页教案 PDF**，Chromium 与 WebKit 都必须有像素
  （实测 darkPixels 69776 / 65250）。

### 发布

- 代码提交：`58d01c72`
- release：`20261031T045806Z`（从 `58d01c72` 构建），active / health 200 / 四端入口 200
- 回滚点：`20261031T044923Z`
- 发布前 MySQL `generation_jobs` 无 `QUEUED/RUNNING`（FAILED 98 / SUCCEEDED 355）

> `20261031T044923Z` 的 worker 只补了 withResolvers，Safari 17.0 仍会因本节的 API
> 白屏；不要回退到它。当前正确版本是 `20261031T045806Z`。
