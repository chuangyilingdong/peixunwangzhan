// pdf.js 的 worker 是**独立全局**：主线程补的 Promise.withResolvers 进不来。
// 这个模块在 pdf.worker 之前求值（见 worker entry 的 import 顺序），把缺的 API 补上。
// Safari 17.4 以下没有 Promise.withResolvers；pdf.worker 里的 WorkerTask / ChunkedStreamManager
// 都会用它，缺了会在 worker 里抛 TypeError。
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

// Safari 17.0 也没有 ArrayBuffer.prototype.transferToFixedLength（ES2024）。
// pdf.worker 的 compileFontInfo / compileSystemFontInfo 用它把字体字节截到实际长度；
// 缺了会抛 TypeError，而 pdf.js 在 getOperatorList 里把它当 warning 吞掉 —— 表现就是
// **不报错但整页白屏**（老师那台 17.0 的实际报错）。这里补一个语义足够的最小实现：
// 复制到新 buffer、按 newByteLength 截断/补零；pdf.js 调用后不会再用原 buffer，所以不强制 detach。
if (typeof ArrayBuffer.prototype.transferToFixedLength !== 'function') {
  Object.defineProperty(ArrayBuffer.prototype, 'transferToFixedLength', {
    configurable: true,
    writable: true,
    value: function transferToFixedLength(newByteLength) {
      const length = newByteLength === undefined ? this.byteLength : Number(newByteLength);
      if (!Number.isInteger(length) || length < 0) throw new RangeError('Invalid ArrayBuffer length');
      const source = new Uint8Array(this);
      const target = new ArrayBuffer(length);
      new Uint8Array(target).set(source.subarray(0, Math.min(source.length, length)));
      return target;
    },
  });
}
