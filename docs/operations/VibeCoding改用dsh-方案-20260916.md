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

## 九、阶段 0 实测（容器里真装真跑，2026-09-16）

镜像：`debian:bookworm-slim`（本机已有；**Docker Hub 在这台机器上不可达**，所以用官方 Node 二进制装进去）
+ `npm i -g @deepseek-ai/dsh@0.1.5-rc.1`（固定版本，不用 latest）。Dockerfile 在 `.tmp/dsh-spike/`（未纳入仓库）。

实测结论（都是真跑出来的）：

```text
dsh --version                 → 0.1.5-rc.1
dsh --help                    → 子命令只有 web / plugin；有 --profile / --patch / --dump-config
                                示例里已经给出 headless（跑一次任务打印结果就退出）与 sdk 两个 profile
dsh web --help                → --host / --port / --no-open / --trusted-host <authority...>
                                注意 --trusted-host：这是给「被反代到别人域名」留的正规口子
dsh --profile web --dump-default-config  → 539 行组合树，关键几条：
                                 · sandbox-policy: mode = DSH_PERMISSION_MODE ?? 'workspace-write'，
                                   workspaceRoot = process.cwd()          ← 一容器一工作区
                                 · bash-sandbox: timeoutMs 60000
                                 · approval: policy = full-access ? 'never' : **'ask'**
                                 · llm-pi-ai 已在组合里（不配 providers 就没有可用路由）
                                 · session-persistence-jsonl: root = $DSH_HOME/sessions   ← 一容器一 DSH_HOME
                                 · **dsh-cordis-host-runner / dsh-cordis-client-runner 默认就在组合里**
                                 · host-plugin-inventory、host-directory-picker-auto、host-open-in-app 也在
```

这几条直接决定了我们的容器怎么配：

1. **一个学生一节课 = 一个容器 + 一个 `DSH_HOME`**（会话日志天然隔离在容器里，`workspaceRoot` 指到一次性工作区）。
2. **必须关掉 `dsh-cordis-host-runner` / `dsh-cordis-client-runner`**：它们让模型能自己写插件挂进宿主，
   官方注释明说在 Web 面上沙箱与审批这两道**都会被绕过**。给学生的运行时里不能有这条路径。
3. **审批策略要显式定**：默认 `ask` 是给「有真人坐旁边点同意」的场景准备的，我们这里没有真人可点。
   要么改成拒绝、要么只允许 `workspace-write` 且不提供升级通道 —— 这条得你拍板（见第十节）。
4. **模型路由只认我们自己的网关**：在 `llm-pi-ai.providers` 里声明 `api: openai-completions` + `baseURL` + `apiKeyEnv`，
   指向我们的网关；这样 token 用量与成本记账仍走我们自己那一套（`llm-deepseek` 会额外发 DSH 专有字段，不用它）。
5. **PPT/文档产物由我们自己提供工具**（dsh 没有），我们已有的 `deckSpec` + OOXML 生成正好包一个 `defineTool` 进去；
   产物清单用 `present` 工具 + `deliverables/presented` 事件，提交仍走我们现有 `/submit` 那套规则。
6. 学生界面里要**关掉** `host-plugin-inventory`（插件管理）、目录选择、以及终端/文件系统相关入口；
   `--trusted-host` 用我们自己的域名，配合我们的反代与 HTTPS 终止（dsh 自己没有 TLS）。

### 9.1 入口与闸门（2026-09-16 实测补齐）

容器内 nginx 这一层是必须的，而且踩到四个坑，都已修好并复测：

1. **dsh 只绑回环**：`--host 0.0.0.0` 被官方故意拒绝；只绑 127.0.0.1 时 Docker 端口发布从宿主
   根本连不上（HTTP 000）。→ 反代必须放在**容器内**（`deploy/dsh-student/proxy/`）。
2. **`absolute_redirect` 默认开着**：`return 302 /?token=…` 会被 nginx 写成
   `http://host:内部端口/…`，浏览器直接跳出入口（实测跑到了本机另一个 8080 服务上，
   差点把别人的界面当成 dsh）。→ 必须 `absolute_redirect off`。
3. **dsh 的鉴权协议**：`GET /` 无 cookie → **401**；`GET /?token=<TOKEN>` → **303** 到 `/` 并下发
   `Set-Cookie: dsh-auth-<随机后缀>=…`。cookie 名带随机后缀，没法按名字匹配，所以用我们自己的
   `dsh_edge` 当「已经补过 token」的标记，而且**标记值必须是本容器的票据**（用固定的 `1` 会让
   浏览器里别的容器留下的 cookie 误导这一台，直接打到 401 页）。
4. **host 侧与 client 侧的 cordis 必须一起关**：只关 `cordis-host-runner` 时，客户端面板
   `ui-cordis` 一直等 `dynamicCordisRunner`，整页变成「Failed to load plugins」（实测）。
   两边一起关之后界面正常起来。
5. **脚本必须是 LF**：CRLF 会让容器 `exec format error`；另外别忘了 shebang（都踩过）。
   仓库里用 `.gitattributes` 保住 LF，Dockerfile 里再兜一次 `sed -i 's/$//'`。

四场景复测结果（`curl`，含 cookie jar）：

| 场景 | 结果 |
|---|---|
| 全新浏览器 + 票据 | 200，真 dsh 界面（`<title>DeepSeek Harness</title>`，26131 字节） |
| 带别的容器的旧 cookie + 票据 | 200（第一次命中就换成本容器 cookie） |
| 只有旧 cookie、无票据 | 403 |
| 无票据无 cookie | 403 |

产物：`deploy/dsh-student/`（Dockerfile、补丁层、课程技能、容器内反代、入口脚本、README）。

## 十、要你拍板的两件事（其余我按上面的默认走）

1. **审批策略**：学生跑到需要「升级权限」的命令时，dsh 默认会弹审批等人点。
   我们这边没人点，所以建议「**直接拒绝 + 只在一次性工作区内可写**」（安全、但模型遇到受限命令会失败并换做法）；
   另一种是给 `danger-full-access`（能力最大、但容器里就能随意读写）。前者我建议。
2. **一个学生一个容器，还是同一个容器多会话**：隔离性 vs 成本。
   一容器多会话省资源，但 dsh 的「一个 cookie = 全部会话权限」意味着同容器内的学生会互相看得见 —— **不建议**。
   我按「一容器一会话」设计，资源估算见第十一节。

## 十一、要你给的资源（阻塞项，第一条最要紧）

1. **一台能跑容器的机器**：现在这台生产机（2 vCPU / 1.6GB，**没有 docker/podman**）跑不动。
   按「一学生一容器」估：每个容器里跑 Node 运行时 + 一个 Chromium（browser-use 走 Playwright MCP），
   单容器建议 1–2 vCPU / 1.5–2GB。**10 个学生同时上课 ≈ 10–20 vCPU / 15–20GB**，另需镜像与工作区磁盘。
2. **模型渠道**：确认 dsh 走我们的网关（保住记账），并给出这个用途可用的 key/额度。
3. **并发量级**：峰值同时创作的学生数，决定机器规格与是否需要预热池。
4. **学生界面边界清单**：哪些入口给学生看（我先把终端、插件管理、目录选择、文件系统隐藏，其余你确认）。


> 调研对象：GitHub `deepseek-ai/deepseek-harness` master 快照（版本号 `0.1.6-alpha.1`；npm 上最新是 `0.1.5-rc.1`）。

### 8.1 它的 Web UI 不是「可以挂到别人站点上」的东西 —— 这决定了整个方案

- `dsh web` = `--profile web` 的别名，默认只监听 `http://127.0.0.1:3080`；
  **故意不支持 `--host 0.0.0.0`**，启动就报错退出，理由原文是「会把这台机器上的远程代码执行暴露到网络上」。
- 它**没有用户体系**：唯一身份是一个进程级浏览器 cookie。原文（`.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md:13,31`）：
  「Every API Proxy method, Remote unary call, ... requires **the same browser session**」「**One application credential is the enforceable identity used for every operation.**
  Cookie 是 `HttpOnly` + `SameSite=Strict` + host-only，且**没有 logout**；
  `packages/identity` 里只有一个匿名安装 UUID，官方原文注明「Do not use it to identify a user」。
- 它**拒绝跨站承载**：`packages/client/connection/src/api-request-trust.ts` 里 `sec-fetch-site === 'cross-site'` 直接返回 false，
  `sandboxed iframe`（opaque origin）也拒绝。→ **把 dsh Web UI 用 iframe 嵌进我们官网是行不通的**（跨源）。
- 它还**没有 TLS**：`packages/host/webserver/README.md:39` 原文「carries no TLS, authentication, or origin policy of its own」。
- 官方对「多租户」的措辞是未来时：`a future multi-principal Host must revisit ...`；
  `packages/ptc-runtime` 里写「A container-class backend would provide a hard multi-tenant boundary ... **nothing is decided beyond the well-known `isolation` value**」。

**所以「用 dsh Web UI 当学生界面 + 保留多租户」现实上只有一个做法**：
**一个学生一节课 = 一个隔离容器里的一个 dsh 运行时**，我们的站点**不嵌 iframe**，而是
「门禁通过 → 我们发短时票据 → 反代到这个容器（同源路径，cookie 由我们的反代持有/透传）」，
或者更干净：**学生界面由我们自己的前端实现，通过 dsh 的 SDK 驱动容器里的运行时**（下面 8.4 说明为什么这条更稳）。

### 8.2 三个能力的官方现成件——和我们想的不一样

| 你要的能力 | 官方到底有什么 | 结论 |
|---|---|---|
| 浏览器预览与交互 | `dsh-browser-use` **本身零浏览器代码**，只注册一个 provider 名；真正的实现在三个**实验性** provider 里（Playwright MCP / Chrome DevTools MCP / Stagehand）。**Stagehand 强制要 OpenAI/Anthropic 之类的 key，且明确不支持 DeepSeek 端点与 baseURL 覆盖** | 只能走 **Playwright MCP** 路线（容器里装 Chromium），且它是「MCP 连接」不是现成工具 |
| 文件与命令沙箱 | `dsh-sandbox-local` + `dsh-bash-sandbox`：**同内核同文件系统的 argv 级文件策略**，三档 `read-only`（默认）/`workspace-write`/`danger-full-access`，**只管文件效果，网络与进程可见性不在承诺里**；原文「**use a container, microVM, or remote executor when the whole environment must be isolated**」。fail-closed：没有可用 runner 就 `SANDBOX_UNAVAILABLE`，绝不裸跑 | 与你的选择一致：**必须容器**；容器内再叠这层策略 |
| PPT/文档产物 | **没有**。全仓库没有任何 pptx/docx/xlsx 生成工具或技能，只有图标与「不可预览」判定 | 这块**必须我们自己写工具**（我们已有 `packages/shared/src/deckSpec.js` 与服务端 OOXML 生成，正好包装成一个 dsh 工具） |

另外两个必须知道的坑：
- `packages/extensions/tool-cordis` 允许模型**自己写 JavaScript 并以临时插件挂进宿主**，
  而它的注释明说在 Web 面上「**both the sandbox and the approval seam are bypassed rather than enforced**」。
  给学生用**必须把这个插件关掉**（或整包不装）。
- 产物登记有现成件：`present` 工具 + `deliverables/presented` 事件（`docs/persistence-catalog.md` 里是 log-only 事件），
  但它**只记路径、不校验内容**；内容校验要在我们提交环节自己做。

### 8.3 模型路由：可以指到我们自己的网关（记账能保住）

`llm-pi-ai` 支持 hand-declared gateway：
`providers.<route>` 里给 `api: openai-completions` + `baseURL` + `apiKeyEnv`（**凭据引用，不落明文**）+ `models` 列表即可，
原文「each key is the provider route name」「apiKeyEnv is a credential reference resolved per request ... so no secret enters the configuration file」。
`llm-deepseek` 的 route 名是 `deepseek-official`，也能 `baseURL` 覆盖，但它会额外发 `dsh_session_log`、`dsh_plugin_packages`
这类 DSH 专有 header/字段（`docs/deepseek-llm-api-wire-extensions.md`），**建议直接走 llm-pi-ai + 我们网关**，顺带把成本记在我们账上。

### 8.4 我们要的三件事，分别接在哪（这是可落地的地方）

1. **课堂门禁**：开会话之前必须过 `resolveStudentLessonContext`。dsh 侧没有用户概念，所以门禁**只能在我们这边**——
   我们是唯一发「容器 + 运行时」的人，没开课的学生根本拿不到实例。
2. **算力记账**：走 SDK 的 `session.event`。事件流里有 `assistant/message.usage`（token 计数）、`tool/call`、`tool/result`；
   原文「usage ... so the model output and its accounting travel together」。**注意 SDK 没有「本次 prompt 的结果」**——
   只能按 `turn/start`/`turn/end`/`step/*` 自己切区间，不能靠 `prompt()` 的返回值。
3. **按产物提交**：用 `deliverables/presented` 事件拿产物路径清单，再走我们现有的 `/submit`
   （`(conversation_id, entry_file)` 唯一、版权确认、只允许网页/PPT/Word/Excel 那套规则不变）。

### 8.5 品牌与许可

MIT；描述性文字可以说「built on DeepSeek Harness」；**项目名里不要直接用全称**（官方建议用 DSH 缩写）；
官方品牌本身是一个可替换插件（`ui-brand-official`），换成我们自己的品牌在机制上是被支持的。

### 8.6 调研里没能确认的（要实测才能定）

1. dsh 前端在**反代子路径**下能否工作：vite `base: './'` 是相对路径，但 `index.html` 里的
   `/manifest.webmanifest`、`/favicon.svg` 和代码里的 `/api`、`/api/remote.mux`、`/plugins` 都是绝对路径，仓库里找不到任何 base-path 配置项；
2. 同源反代 + 同源 iframe 承载是否真的可行（理论上能过信任围栏，但官方没有任何「与他人共用 origin」的先例或契约）；
3. 浏览器 provider 那几个实验性包在 npm 上是否真的已发布、版本号多少；
4. `tool-cordis` 关掉之后，还有没有别的「模型可自造插件」的路径。

