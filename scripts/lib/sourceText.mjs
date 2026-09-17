/**
 * 源码文本工具（守卫用）：把注释剥掉，好判「某段代码还在不在」。
 *
 * ⚠️ 为什么不是一个正则：**注释里会写注释符号**。
 * 踩过的坑：一行行注释里写了「受鉴权保护的素材（斜杠 api 斜杠 双星）」，
 * 其中的「斜杠 + 星号」被朴素的块注释正则当成块注释起点，一路吞到几百行之后
 * 真正的块注释结束符 —— 于是「剥完注释」的文本里少了 470 行代码，
 * 断言判「代码没了」其实是被自己的正则吃掉了（2026-09-17 真实踩到，p110 因此误报）。
 * （这段注释本身就差点再犯一次：写示例时把结束符也写进去了，注释提前结束、语法直接报错。）
 *
 * 所以这里逐字符走：字符串（含模板串）原样保留，双斜杠到行尾算行注释，
 * 「斜杠 + 星号」到「星号 + 斜杠」算块注释。
 * 注释**被替换成等量空白/换行**（保留换行，行号不会错位），返回的文本可以直接做正则断言。
 *
 * @param text - 源文件内容。
 * @returns {string} 去掉注释的文本（换行与原文本一一对应）。
 */
export function stripComments(text) {
  const source = String(text ?? '');
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    // 行注释：吃掉直到行尾（保留那个换行，行号不错位）
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    // 块注释：吃掉直到 */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    // 字符串/模板串：原样保留（里面的 // 与 /* 都不是注释）
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { out += source[i]; i += 1; }
        out += source[i] ?? '';
        i += 1;
      }
      out += source[i] ?? '';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
