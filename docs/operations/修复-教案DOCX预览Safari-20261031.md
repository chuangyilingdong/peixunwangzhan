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
