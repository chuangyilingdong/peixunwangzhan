/**
 * 灵动ai 学生端品牌 —— 宿主侧。
 *
 * 这个包只贡献**浏览器里的呈现**（品牌插槽的占用者），宿主侧没有任何行为，
 * 留一个空的 apply 是为了让加载器有这一行、从而把 client 半边挂上去。
 * 官方同款包（@deepseek-ai/dsh-client-ui-brand-official）也是这么写的。
 */

/** 宿主插件体：空的。 */
export function apply() {}
