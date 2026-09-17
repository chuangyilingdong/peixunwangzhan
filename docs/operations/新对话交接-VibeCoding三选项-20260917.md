# 新对话交接 · VibeCoding 拆成三个选项（对话 / 写代码 / 做网页），沙箱改为按需（2026-09-17）

> 时点交接，不是口径源。领域口径以 `docs/README.md` 为准。
> 上一份：`docs/operations/新对话交接-网页搜索与秒进-20260917.md`
> （搜索透传、请求体 2MB 的墙、历史「不用攒」、以及「秒进」卡在内存的实测账）。

## 一、口径变更（**这条改的是学生看得见的行为，先看它**）

```text
旧：VibeCoding 的入口绑在创作环境（dsh 沙箱）上 —— 沙箱不可用时，卡片里只剩一个「点不动的按钮」。
新：进去**默认走平台自己的链路**（没有沙箱）→ 秒进、几乎零服务器内存、不占端口；
    学生在里面选 **对话 / 写代码 / 做网页**；想要「AI 真的把代码跑起来、自己看效果再改」
    时才点「**让 AI 真的做出来**」把沙箱（447MB）开起来。
```

**为什么值得改**（接上一份交接的实测）：一台 1.6GB 的机器**只装得下 1-2 个**沙箱环境。
把入口绑在沙箱上，等于「一节课几十人」从门口就卡住；而「对话 / 写代码 / 做网页」这三件事
本来就不需要沙箱。**447MB 只为真正要 AI 动手的人付。**

三条对齐（避免与既有口径打架）：
- **与「入口按课时已发布类型放行」不冲突**：老师侧仍是 画布 / VibeCoding 两个类型（p104 口径不动），
  三个选项是 VibeCoding **内部**的学生选择。
- **与「不替 dsh 决定用什么能力」一致**：选项只决定「要不要动手（开不开沙箱）」，
  开了之后工具选择仍归 dsh。
- **与「入口不该变成点不动的按钮」一致**：这正是 `runtimeWorkspace.jsx` 文件头里写的原意，
  这轮把它落实（并且是用户点的这个方向）。

## 二、为什么这轮不用新写运行时（探索结论）

平台自己那条链路**本来就是完整的**，只是从主入口被摘掉了：

| 环节 | 现成实现 |
|---|---|
| 对话（流式） | `POST /api/student/vibecoding/conversations/:id/messages` → `streamAssistantReply`（SSE），历史 20 条多轮 |
| 课程口径 | `lessonSystemMessage`（课时标题 / 简介 / 正文） |
| 产物 | 围栏代码块在流式期间就落库（`vibecoding_artifacts`）+ SSE `artifact` 事件 |
| 提交 | `vibecoding_submissions`（按产物唯一） |
| **预览** | `buildPreviewDocument` 拼成自包含文档 → `PreviewFrame`（`sandbox="allow-scripts"`，经 `/vibe-preview.html` 那个 nginx 单独放宽 CSP 的外壳投递） |
| 门禁与账本 | `assertChatPreflight`（课堂 / 能力 / 次数 / 预算）+ `applyGatewayRoute` + `recordAiUsage`，与沙箱那条**共用** |

**所以「做网页」连预览都不用开沙箱**：学生的代码一直在浏览器里跑（作品广场也是这么渲染的）。
这轮是「接回去 + 分档 + 加升级点」，一行新运行时都没写。

## 三、改了什么

1. **数据**：`vibecoding_conversations.mode`（新库建表带、老库走 ALTER）。
   ⚠️ **留空 = 迁移前的老行为**（既能出网页也能出文档）→ 老会话零回归。取值在代码里规范化，不加 CHECK。
2. **服务端**（`apps/server/src/routes/vibecoding.js`）：
   - `VIBE_MODES = ['CHAT','CODE','WEB']` + `normalizeVibeMode`；
   - `lessonSystemMessage` 分档：选了选项就在最前面加那一档的角色说明；
     **两种格式说明（网页 / 文档）永远都给** —— 选项只改默认行为，**不改能力边界**；
   - `PUT /conversations/:id` 接受 `mode`：非法值 `INVALID_VIBE_MODE`，
     **聊过就锁**（`VIBECODING_MODE_LOCKED`，按消息数判）。
3. **入口**（`packages/shared/src/classroom.jsx`）：
   - VibeCoding 入口**不再依赖 `runtime.ready`** → 走平台链路；
   - 删掉那个「点不动的兜底按钮」；
   - 顺带修掉一个**既存缺陷**：`enter()` 原来按课时单值（`modeOf`）推分支，
     两种都开的课时**点 VibeCoding 会进画布**；现在由按钮显式传目标（`enter(lesson, 'VIBECODING')`）。
4. **工作台**（`packages/shared/src/vibecodingWorkspace.jsx`）：
   - 空态换成**三张选项卡片**（只在还没聊过时出现；选好给出该档的示例开头）；
   - 头部加「让 AI 真的做出来」（沙箱可用时才渲染）；
   - 「开环境」抽成 `useRuntimeLaunch`（`runtimeWorkspace.jsx`），**入口与工作台共用**
     —— 忙状态、超时、跨刷新防重复点只有一份实现，不会只在一处被修好。
5. **顺带修掉的失败体验**（`services/studentRuntime.js`）：宿主脚本失败原来一律
   **500「服务器内部错误」**，把「这台机器装不下新环境 / 端口池占满了」这类**学生看得懂**的
   原因全吞了。现在对外 503 + 脚本原话的尾巴，完整原文进服务器日志。

## 四、怎么验的

- 全量守卫 **117/117**（新增 `p108`：分档提示词含反向自检、白名单、聊过锁定、
  入口不卡沙箱、预览仍是沙箱 iframe、升级失败要说出来）。
- **真浏览器实检**（本地 + 种子数据，`student-1/study123`）：
  登录 → 课程中心 → 第 1 节（VibeCoding）→ 进入课堂 → **三张卡片** → 选「做网页」→
  **刷新后仍选中**（说明已落库）→ 发一条 → 出产物 `index.html` / `script.js` →
  右侧**预览 iframe 自动打开**（`sandbox="allow-scripts"`，`src=/vibe-preview.html`）。**全程零沙箱。**
- 沙箱「可用」时（`DSH_RUNTIME_TRANSPORT=script` + 一个假宿主脚本）：
  课程中心那一排变成「进入课堂 + 让 AI 真的做出来 + 提交作品」，工作台头部也出现升级按钮；
  确认弹窗、以及**失败提示**都点过。
- ⚠️ 实检当场抓到我自己的一个真缺陷：工作台里升级失败时 `launch.message` **根本没渲染** →
  「点了没反应」（这个项目最怕的那种）。已修（toast）+ p108 钉住。

## 五、风险与未做（别当成已完成）

1. **「对话」走平台链路后，AI 不能自己跑代码 / 看效果** —— 这是 dsh 的核心价值。
   所以升级点必须显眼（现在课程中心与工作台各一个）；否则学生会以为能力退化了。
2. **两条链路的课程口径还没对齐**：平台侧靠 `lessonSystemMessage`（课时标题/简介/正文），
   沙箱侧靠 `SKILL.md`（而且全平台只有一个 `gushi-animation`，**没有「课时 → 技能」映射**）。
   这轮只把平台侧分档做好，沙箱侧仍靠学生在升级时的「承接说明」。
3. **升级是交接不是接力**：沙箱里是**另一段对话、另一份工作区**。这轮只做了
   「把当前要求复制到剪贴板」；**没有**把已产出的产物写进沙箱工作区
   （那要给 broker-policy 加一个 `seed` op + 改宿主脚本，留下一轮）。
4. 老会话（无 `mode`）保持迁移前行为 → 零回归（p108 有反向自检钉住）。
5. 既存漂移，本轮**没动**但记着：`POST student/runtime/launch` 只校验「有进行中的课堂」、
   **不校验课时的 `deliveryModes`** —— 入口放行实际靠前端。
6. 本地 mock 验的是**链路与界面**；三种角色下真模型的表现（分档合不合口味）**要真机上课才知道**。

## 六、这一轮的坑

1. **本地起站点**：vite 只听 `::1`（`localhost` 通、`127.0.0.1` 不通），而 API 听 `0.0.0.0`
   —— 探针与代理目标都要用 `localhost`。
2. **浏览器工具的三个坑**：`tab.url` 是方法不是属性；输入框在无障碍树里是 `textbox "登录名"`
   （按 placeholder / `input[type=text]` 定位会超时）；课程中心那两个 `进入课堂` 在 a11y 树里
   落在 `link` 上，别死按 `role=button` 猜 —— 先读 `domSnapshot()` 再动手。
3. **`pkill -f` 又没杀掉服务**（端口 `EADDRINUSE`，我还对着旧进程的响应当成了新进程）
   → 用 `netstat -ano | grep 端口` 找 PID + `taskkill //PID`。
4. **hook 必须放在提前 return 之前**（本文件 `vibecodingWorkspace.jsx` 里 297 行附近有 return），
   否则「少一个 hook」直接崩 —— `classroom.jsx` 里早有同款注释。
