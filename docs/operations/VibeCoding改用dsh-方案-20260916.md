# VibeCoding 改用 DeepSeek Harness（dsh）方案（2026-09-16）

> 状态：**方案与前置条件，尚未开始替换**。本文只回答「要用 dsh 的 Web UI 当学生端 VibeCoding 界面，
> 同时保留我们的多租户、课堂门禁、产物提交，该怎么做、缺什么」。
> 领域口径仍以 `docs/README.md` 为准；本文不改任何口径。

## 一、用户定的方向

1. 学生端的 VibeCoding **界面换成 dsh 自带 Web UI**（`npx @deepseek-ai/dsh web`）。
2. 我们已有的**多租户、课堂门禁、产物提交**要保留并做进去。
3. 要装的能力（插件）：**浏览器预览与交互**、**文件与命令沙箱执行**、**PPT/文档产物**。
4. 环境：**独立容器或独立机器隔离**（dsh 会执行模型生成的代码与命令）。

## 二、现状：现在这套 VibeCoding 是什么规模

```text
apps/server/src/routes/vibecoding.js     1196 行   对话 / 消息 SSE / 产物 / 提交 的接口面
packages/shared/src/vibecodingWorkspace.jsx 963 行  学生工作台（含手机模拟器、控制台、附件、预览、提交）
packages/shared/src/console/*                       工作台组件族（按 OpenSquilla 控制台重建）
```

对话生成这条链路今天长这样（**这是要被 dsh 替掉的部分**）：

```text
POST /api/student/vibecoding/conversations/:id/messages
  → ownConversation + assertConversationEditable          （归属校验）
  → vibeCodingContext(student, lessonId, sessionId)        （课堂门禁：许可 + 名单 + 课堂进行中 + 入口类型）
  → assertChatPreflight + assertComputePoolBudget          （策略与算力池预算）
  → applyGatewayRoute / generationProvider                 （模型渠道路由）
  → recordAiUsage（creditUsage / compute_attempts）        （逐笔算力记账，平台成本账）
  → 助手回复里的文件落成 vibecoding_artifacts
```

## 三、必须保住的契约（换引擎也不能动）

| # | 契约 | 落点 | 回归守卫 |
|---|---|---|---|
| 1 | 进课三层门禁（许可 → 课堂名单 → 课堂进行中 → 入口类型） | `services/studentContext.js` `resolveStudentLessonContext`，VibeCoding 侧 `vibeCodingContext` | `p66`、`p78`、`p6` |
| 2 | 一个学生全局最多一个未终态课堂；课堂入口类型决定能不能走 VibeCoding | 同上 | `p66`、`p78` |
| 3 | 每次模型调用按机构/学生/课时/课堂记账；算力池预算与售价口径 | `services/creditUsage.js`、`computePool.js`、`computeGateway.js` | `p59`、`p62`、`p92` |
| 4 | **按产物提交**：`(conversation_id, entry_file)` 唯一，重复提交是覆盖（round+1）；提交要版权确认；只允许网页/PPT/Word/Excel | `routes/vibecoding.js` 的 `/submit`、`vibecoding_submissions` | `p94`、`p18`、`p41` |
| 5 | 私有产物与素材的可见性：学生在沙箱里预览、机构可只读预览、公开只在平台发布后 | `/vibe-preview.html` 外壳 + `data:` 地址（见 README §三 14） | `p95`、`p51` |
| 6 | 聊天侧能力：附件白名单与上限、SSE 流、重新生成/编辑/删除、清空对话、置顶 | `routes/vibecoding.js`、`console/attachments.js` | `p26`、`p16`、`p42` |
| 7 | 平台侧：审核、发布到作品广场、下架原因学生可见 | `admin/works.js`、`vibecoding_submissions` | `p25`、`p64`、`p80` |

> 一句话：**dsh 只能替掉第 19~20 行的「模型调用 + agent 循环 + 产物生成」**，上面 7 条都在它外面，
> 任何一条丢了都是产品事故（学生进不去课、账记不上、作品提交不了）。

## 四、环境与隔离：现在的结论（已实测）

```text
生产服务器 39.106.183.200：2 vCPU / 1.6GB 内存（可用约 1.3GB）/ 40GB 盘（余 24GB）
                            **没有 docker，也没有 podman**
本机开发机：Docker 29.4.3 已装（本次已启动，16 vCPU / 16GB 分配给容器 VM）
```

结论：**现在这台生产机上跑不了 dsh 的隔离方案**。
- 没有容器运行时，而用户要的是「独立容器或独立机器」隔离；
- 2 vCPU / 1.6GB 连一个带浏览器的 agent 会话都紧张（browser-use 需要 Chromium，单个实例就是几百 MB 起），
  再乘「同时上课的学生数」直接爆；
- 我们自己的生产服务（API + 三端静态资源 + 数据库）也跑在同一台机器上，不能和「执行模型生成代码」的进程混住。

→ 需要一台**新机器**（建议 4–8 vCPU / 8–16GB / 装 Docker），或者至少先把原型跑在本机 Docker 里。

## 五、分期计划（每期都可独立验收，不一次性推翻线上）

**阶段 0 — 隔离原型（本机 Docker，不碰生产库与生产密钥）**
- 容器里装 `@deepseek-ai/dsh`，用我们**自己的**模型渠道（走我们网关的 baseURL）起一个运行时，能开一个会话。
- 装三个能力插件：浏览器预览与交互、文件与命令沙箱、PPT/文档产物。
- 验收：给一句中文需求 → 容器里产出 HTML/PPT → 我们能在容器外预览到这份产物，并拿到**文件清单与用量事件**。

**阶段 1 — 接缝验证（我们后端 ↔ 单个 dsh 运行时）**
- 用 dsh 的 SDK（JSON-RPC over stdio）从我们的 Node 后端驱动一个会话：
  开会话 → 发一句 → 收事件流 → 取产物清单。
- 把 `vibeCodingContext`（课堂门禁）放在**开会话之前**：没开课的学生拿不到运行时。
- 把模型调用路由到我们网关，验证 `recordAiUsage` 仍能逐笔记账（这是阶段 1 的硬指标）。

**阶段 2 — 界面切换（dsh Web UI 当学生界面）**
- 每个学生一个容器（或一个运行时进程 + 独立 workspace），我们后端按门禁发短时票据后反代到该容器。
- dsh Web UI 里补我们的信息：当前课包/课时/课堂、剩余可创作时长、提交按钮（走我们的 `/submit`）。
- 学生看到的入口仍在官网「进入课堂」，URL 与登录态由我们控制。

**阶段 3 — 替换与回归**
- 学生端 VibeCoding 默认走 dsh；旧的 `vibecodingWorkspace` 保留一个开关可回退。
- 跑第三节那 7 条契约的全部守卫（p6/p16/p18/p25/p26/p41/p42/p51/p59/p62/p64/p66/p78/p80/p94/p95）后再切换。

## 六、风险（必须先说清，别等出事）

1. **它明确说自己是实验软件**：官方 SAFETY 原文——未做安全审计、**不得视为安全或生产可用**，
   会执行模型生成的代码与命令，沙箱**不保证隔离**。所以「隔离」这件事由我们负责（容器 + 限权限 + 限网络 + 一次性工作区）。
2. **给孩子的产品**：agent 会跑命令、连网络；学生输入不可控。必须有：容器级隔离、出网白名单、
   每节课重置工作区、产物只在我们的沙箱外壳里预览（沿用 `data:` 那条既定做法）。
3. **品牌与许可**：dsh 是 MIT，但仓库里有 `BRAND_GUIDELINES.md`；把它的 Web UI 放进我们产品对学生展示，
   署名/品牌口径要按它那份文件来（调研中，结论会补进来）。
4. **版本漂移**：当前 npm 上是 `0.1.5-rc.1`（RC），仓库自称会有破坏性变更 —— 要固定版本号，别用 `latest`。
5. **算力成本**：agent 循环比现在的单次问答调用多得多（多轮工具调用）。上线前必须先用真实预算测每节课成本。

## 七、要你给的东西（阻塞项）

1. **一台隔离机器或容器宿主**（生产侧）；本机 Docker 只能做原型。
2. **模型渠道**：dsh 走哪条？—— 用我们平台已有的渠道配置（这样成本进我们的账），还是它自己直连 DeepSeek 官方？
   这决定阶段 1 能不能保住记账。
3. **学生界面的边界**：dsh Web UI 里哪些功能要给学生看到/隐藏（它有终端、文件系统、插件管理这些入口，
   给学生用得关掉一部分）。你给一份「学生能看见什么」，我按这个裁剪。
4. **并发的量级**：预估同时在线创作的学生数，决定每容器几个人、机器规格。

## 八、待补（调研中）

- dsh Web UI 的启动参数、协议、能否被反代到子路径；
- 它自带的用户/凭据/工作区模型是否支持多租户，官方推荐的多用户做法；
- 三个能力插件的官方包名与配置项（浏览器 / 沙箱 / PPT·文档产物），以及产物清单与用量事件怎么拿；
- 自定义插件（我们要往它 UI 里加「提交作品」等入口）的开发方式。
