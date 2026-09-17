/**
 * 画幅档位的小示意图尺寸（2026-09-17 用户口径）。
 *
 * 光看「9:16 / 16:9 / 1:1」这几个字，学生不容易想象出画面是什么形状；像对照平台那样
 * 在文字上面画一个同比例的小方框就好认了。
 *
 * 单独一个模块（而不是塞在 index.jsx 里）是为了**能被守卫真跑**：
 * `.jsx` 在 node 里导不进来，纯函数放在这里才测得到。
 */

/**
 * @param value - 档位文字（例如 '16:9'、'21:9'）。
 * @returns {{width: number, height: number}|null} 像素尺寸；不是比例（如「自动」）时返回 null。
 */
export function ratioThumbSize(value) {
  const match = /^(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)$/.exec(String(value || '').trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return null;
  // 最长边固定 18px，短边按比例算；下限 7px —— 21:9 那种长条不然会缩成一条线，看不出形状。
  const scale = 18 / Math.max(width, height);
  return { width: Math.max(7, Math.round(width * scale)), height: Math.max(7, Math.round(height * scale)) };
}
