// 复制到剪贴板 + 拼绝对地址。2026-09-27 从 `pages/MyWorkDetail.jsx` 抽出来 ——
// 「我的主页」也要复制链接，再抄一份就是第三份了（全仓原本就手写了三处）。
//
// 返回 true = 复制成功；false = 没复制成（**调用方自己把地址显示出来**，别让人干瞪眼）。

/** 非安全上下文（http）里 `navigator.clipboard` 是 undefined，所以留一条 execCommand 的退路。 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    const done = document.execCommand('copy');
    document.body.removeChild(scratch);
    return done;
  } catch {
    return false;
  }
}

/** 把站内路径拼成能发出去的绝对地址（分享给别人才用得了）。 */
export function absoluteUrl(path) {
  return new URL(String(path || ''), window.location.origin).href;
}
