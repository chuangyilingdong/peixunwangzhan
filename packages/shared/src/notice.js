// 提示语的「语气」标记：**别靠猜消息里的字**（用户 2026-09-21 报：机构端图2 里"通过/报错"都是绿框）。
//
// 由来：很多页面原来用 `tone={message.includes('失败') || message.includes('错误') ? 'danger' : 'success'}`
// 这种判据决定红绿 —— 只要错误文案里没有那两个词（例如「登录名已被占用」「姓名在这一批里重名」），
// 就会渲染成**绿色**，看着像成功了。所以改成：**错误消息由 `errorText()` 统一加一个前缀标记**，
// `Notice` / 画布 toast 见到标记就按危险色渲染（并把标记去掉）。
// 放到单独的 .js 里（不是 .jsx）是为了让守卫能**真跑这三个纯函数**。
export const NOTICE_ERROR_MARK = '⚠ ';

export function errorText(error) {
  const message = String(error?.message || error || '').trim() || '操作失败';
  return NOTICE_ERROR_MARK + message;
}

export function isErrorText(value) {
  return String(value ?? '').startsWith(NOTICE_ERROR_MARK);
}

export function stripNoticeMark(value) {
  const text = String(value ?? '');
  return isErrorText(text) ? text.slice(NOTICE_ERROR_MARK.length) : text;
}
