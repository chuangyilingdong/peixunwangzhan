/**
 * 框体节点「能不能删」的**唯一判定**（2026-09-19 用户口径「优化微调一下」）。
 *
 * 用户原话：「画布里学生点击了框体，如果在还没有生成的时候可以删除，然后又可以点击显示出来。
 * 但是一旦生成了，这个框体就无法删除了。等于这个框体次数已经使用了。」
 *
 * 规则：
 *   · **不是框体**（普通素材 / 角色 / 场景节点）→ 照常可删；
 *   · 框体**没生成过** → **可删**。删掉之后素材面板那条会回到「未生成」，再点一下就又回来了，
 *     课时配额一点没动（原来一律禁止删除，于是学生误加的、还空着的框体白占画布）；
 *   · 框体**正在生成 / 已生成** → **不给删**。那一次配额已经用掉了，留着才对得上；
 *     删了就会出现「素材面板显示已生成、画布上却没有」这种对不上的状态。
 *
 * ⚠️ 判据与画布节点状态那套必须保持一致（见 `index.jsx` 里 ImageNode 的 state 推导：
 *    `generationStatus === 'PENDING'` → 生成中；`assetUrl || generatedText` → 已生成；
 *    `uploaded` → 素材）。两边不一致就会出现「面板说未生成、却删不掉」这类对不上的情况。
 *
 * ⚠️ 为什么单独放一个 `.js`（而不是写在 `index.jsx` 里）：**守卫才跑得到它** ——
 *    `.jsx` 在 node 里导不进来（同 `ratioThumb.js` 那条约定）。
 *    守卫 `scripts/p122-canvas-box-rules.mjs` 直接拿状态矩阵跑这个函数。
 *
 * @param {{data?: object}} node React Flow 节点
 * @returns {boolean} true = 受保护、删不掉
 */
export function isProtectedBoxNode(node) {
  const data = node && typeof node === 'object' ? (node.data || {}) : {};
  if (!data.slotType) return false;
  if (data.generationStatus === 'PENDING') return true;
  return Boolean(data.assetUrl || data.generatedText || data.uploaded);
}

/**
 * 框体「还没生成」时占位区里那张引导插画（2026-09-19 用户口径：原来是一枚 🌈 emoji +
 * 一行小字，换成这张「小灵陪你一起创作」的引导插画）。
 *
 * ⚠️ 2026-09-22 用户报「图1现在图像框体有了预览图像…但是其他框体都没有（比如视频框体还是原始图）」——
 *    当时只有图片框体用上了它，视频/动画/音乐/文字还留着 `▶ / ✧ / ♫ / ✎` 那套老占位。
 *    **四类框体要一致**：改了这张图或这段读面，四个 Node 一起改（VideoNode / AnimationNode /
 *    AudioNode / 文字框体都在 `index.jsx`，搜 `learning-node__art--illustration` 就到）。
 *
 * ⚠️ 用**绝对路径**：画布同时跑在官网（学生的 `/learn/canvas`）与机构端（`/org/` 的课堂页），
 *    而 nginx 的 `/assets/` 落在**官网那份 dist** 上 —— 两边用同一个绝对地址都取得到。
 *    文件：`apps/website/public/assets/learning/box-empty-art.webp`。插图自带点阵底，
 *    正好接上占位区原本的点阵背景。
 */
export const BOX_EMPTY_ART = '/assets/learning/box-empty-art.webp';
