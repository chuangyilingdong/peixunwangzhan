/**
 * 课时编排里「某个模型的有效能力」—— 把**任意形状**的配置归一成固定的四件套。
 *
 * 为什么单独一个文件（而不是留在 CourseManagement.jsx 里）：
 *   它是 2026-09-28 那次**后台整页白屏**的根因所在，必须能被守卫直接 import 起来测
 *   （组件文件里有 JSX，node 侧 import 不了）。见 `scripts/p163-admin-capability-shape.mjs`。
 *
 * 事故经过（运营原话：「音乐渠道增加了 1 个 bgm，课时编排这里我选择 bgm 的模型，结果白屏」）：
 *   · 运营往音乐渠道里新加了一个模型 `mureka-v9-bgm`，它**还没有任何能力配置**；
 *   · 原来的写法是"整对象兜底"：`channel.modelCapabilities?.[model] || 模态默认 || 四件套` ——
 *     可 `undefined` 才走兜底，而**模态默认**（服务端 `MODALITY_CAPABILITY_DEFAULTS.MUSIC`
 *     = `{ modes: [...] }`）和"刚加进来还没配"的 `{}` **都是真值** → 兜底链不生效；
 *   · 于是 `caps.aspectRatios` 是 `undefined`，界面上一句 `!caps.aspectRatios.length`
 *     当场抛 `Cannot read properties of undefined (reading 'length')` → React 渲染期报错 → **整页白屏**。
 *
 * 所以这里**逐项兜底**，拿到什么都补齐：三个列表一定是数组、audio 一定是布尔。
 * ⚠️ 顺带一条语义：音乐/文本模型**本来就没有比例/清晰度/时长**（服务端的模态默认里也没有这三项），
 *    归一化之后它们是 `[]` —— 界面据此**不要**再显示"该模型还没有配置可用比例"那种话术
 *    （那是给图片/视频模型看的，音乐上显示会让人以为要去补比例）。
 */

/** 取一个列表字段：配置里的优先（必须是数组），否则用模态默认（也必须是数组），再否则空数组。 */
function pickList(configured, fallback, key) {
  const value = configured?.[key] ?? fallback?.[key];
  return Array.isArray(value) ? value : [];
}

/**
 * @param {{ configured?: any, fallback?: any }} args
 *   configured —— 渠道里这个模型自己的能力配置（可能是 `{}`、`undefined` 或半份配置）
 *   fallback   —— 该模态的默认能力（服务端下发的 `capabilityDefaults[modality]`）
 * @returns {{ aspectRatios: string[], resolutions: string[], durations: number[], audio: boolean }}
 */
export function resolveCapabilities({ configured = null, fallback = null } = {}) {
  return {
    aspectRatios: pickList(configured, fallback, 'aspectRatios'),
    resolutions: pickList(configured, fallback, 'resolutions'),
    durations: pickList(configured, fallback, 'durations'),
    audio: configured?.audio === true || fallback?.audio === true,
  };
}
