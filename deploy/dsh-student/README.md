# 学生运行时容器（dsh = DeepSeek Harness）

一个学生一节课 = 一个这个容器的实例。容器没了，会话日志、工作区、票据一起没。

配套方案与全部踩坑记录：`docs/operations/VibeCoding改用dsh-方案-20260916.md`。

> **学生看到的品牌是「灵动ai」**（2026-09-16 起）：界面标题、侧边栏、欢迎页、favicon 全是我们的；
> 容器里看不到 dsh/DeepSeek 的标识。做法见下面「品牌（灵动ai）」一节。

## 里面有什么

- **dsh** `@deepseek-ai/dsh@0.1.5-rc.1`（**固定版本**：官方自称会有破坏性变更，不要用 latest）
- **我们的补丁层** `student-runtime.cordis.yml`：
  - 模型路由只用**我们自己的网关**（`llm-pi-ai` 的 hand-declared gateway，凭据走 `apiKeyEnv`，密钥不进配置文件），
    并且把**默认模型**指到我们网关的槽位、关掉 dsh 自带的 `deepseek-official` 路由
    （不这么做，学生一发消息就是 `MISSING_CREDENTIAL`，实测）
  - 模型声明带 `input: [text, image]`：dsh 对**手写声明的模型**默认只认文本，不声明的话学生贴的图进不了请求体
  - `maxRequestImageBytes: 8388608`（8MiB）：**每次请求的图片总量预算**。dsh 每轮重发全量历史、
    历史里的图会被重新编码进每一次请求体，不设上限的话请求体会随会话无限增长。
    超预算时 dsh 把**最老的**图从这一次请求里省略（历史不动，最新的一定看得见），
    换成一行 `[image omitted to fit request image limits; …]`。取值必须明显大于一轮工作集
    （一轮「看自己的产物」通常读 4-12 张，8MiB ≈ 30 张）—— 设小了 agent 会反复重读被省略的图。
    详见 `docs/operations/新对话交接-网页搜索与秒进-20260917.md` 第四节。
  - 课程技能目录（`skills/`，一个课程一个 `SKILL.md`）
  - 沙箱 `workspace-write` + 审批 `never`（**语义是「直接拒绝」**，不是自动放行），并把 `defaultPreset` 显式指到同名预设

> ⚠️ **这个补丁层是宿主文件、不在 release 产物里**：装机时它被放到
> `/opt/dsh-runtime/etc/dsh/student-runtime.cordis.yml`（`provision-user-runtime.sh` 只校验它在不在，
> **不负责安装**），而 dsh **只在启动时读一次** —— 改完必须**重启学生环境**才生效。
  - 关掉给学生的成人入口：`cordis-host-runner` / `cordis-client-runner` / `ui-cordis`
    （模型能自造插件挂进宿主，官方注释说在 Web 面上沙箱与审批都会被绕过）、`plugin-inventory`（插件管理）、
    `directory-picker`、`open-in-app`
- **容器内 nginx**：dsh 只绑 `127.0.0.1` 且**拒绝** `--host 0.0.0.0`（官方理由：会把 RCE 暴露到网络），
  所以对外入口必须由容器内的这层 nginx 提供 —— 它校验我们平台的短时票据，再把请求转给 `127.0.0.1:3080`。
- **读图跟着模型走，不需要额外的插件**：学生贴进来的图当**内容块**走同一条 TEXT 渠道、同一个模型 ——
  我们的渠道模型本来就能看图（平台老 VibeCoding 的聊天一直这么发，实测能读出图里的颜色）。
  浏览器里实测过：贴一张图发出去，落在我们账本里的那一通 `withImages=true`。
  入口脚本把 `@liustack/modlens` 的凭据也钉到我们的网关上（**它的位置与定位见下面「modlens 是什么」**）。

### modlens 是什么（2026-09-16 用户口径）

**modlens 补的是 dsh 自身缺的那块能力**（dsh 开源项目里没有「读图」这个能力，要靠插件给它装上），
**和「我们的模型能不能看图」是两件事** —— 别把这两句混起来说（我前面写错过一次，已改）。
所以它照装照挂；入口脚本给它写的凭据指向我们的网关，是保证**它真去读图时花的钱也进我们的账**。

## 品牌（灵动ai）

学生端**只应该看到灵动ai**。做法分两半：

1. **插槽**（`brand-plugin/`）：dsh 的侧边栏与欢迎页品牌位是官方留出来的扩展点
   （`sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark`），官方包
   `@deepseek-ai/dsh-client-ui-brand-official`（鲸鱼标 + 字标）只是它的占用者。
   我们在补丁层关掉官方那一行，换上自己的 `@lingdong/dsh-brand`：品牌图内联进客户端 bundle，
   侧边栏给方标+字标、欢迎页给横标。
2. **替换**（`rebrand.mjs`，构建期）：做不了插槽的地方只能改字符串 ——
   页面标题（`dsh-client-ui-layout` 里写死的 `productTitle`）、关于面板/内测公告文案、
   前端 `index.html` 的 `<title>`、`manifest.webmanifest` 的名字、`favicon.svg`，
   以及**发给模型的运行环境说明**里的 `DSH` 字样（模型偶尔会复述给学生看）。
   只替换**品牌串与散文短语**（`DSH home` / `DSH file policy` …），不碰 `DSH_HOME` 这类标识符与路径。

品牌图：`assets/lingdong-ai-logo.png` 是原图，`assets/lingdong-ai-logo-480.png` 是裁掉透明留白后
480 宽的版本（构建里用后者）。

**欢迎页文案**（2026-09-16 用户定稿）：原来那两句官方文案（标语「探索未至之境」+「预览版」角标）
并成一句 —— **「小灵ai陪你VibeCoding」**，角标直接藏掉。做法在 `rebrand.mjs` 里按**键名**替换
（`hero.headline` / `hero.preview`）+ 给角标那条 CSS 规则加 `display:none`，dsh 升级改文案也不会漏改。

**学生界面的取舍**（2026-09-16 用户定）：**保留「设置」入口**，不隐藏（里面有模型选择等）。

## 机器（容器宿主）

这台生产机跑不了容器，所以学生容器放在**另一台机器**上：装机、拉起、回收、自检的脚本都在
[`host/`](host/README.md)，平台与宿主之间只有「一个脚本 + 几个参数」这一层接口。

## 构建与运行

```bash
docker build -t dsh-student:local deploy/dsh-student

docker run --rm -p 18080:8080 \
  -e EDGE_TICKET=<平台签发的短时票据> \
  -e GATEWAY_BASE_URL=http://<我们网关>/api/gateway/v1 \
  -e PLATFORM_GATEWAY_KEY=<网关凭据> \
  -e DEEPSEEK_SEARCH_BASE_URL=http://<我们网关>/api/gateway/v1/search \
  -e DEEPSEEK_API_KEY=<网关凭据同上> \
  dsh-student:local
# 学生从 http://<入口>/?t=<票据> 进入
```

### 为什么有两个 `DEEPSEEK_*` 变量

dsh 的**网页搜索**插件（`@deepseek-ai/dsh-web-search-deepseek`）不读 `GATEWAY_BASE_URL`：

- 它调的**不是搜索接口**，而是 **Anthropic 协议的 `/messages`**（搜索是模型一跳里的服务端
  工具 `web_search_20250305`）；端点来自 `DEEPSEEK_SEARCH_BASE_URL`，它自己拼 `/messages`。
- 它认的密钥变量名是 `DEEPSEEK_API_KEY`（源码写死），与聊天那条路**不复用** base、只复用 key。

⚠️ 这两个变量给的都必须是**平台的网关地址 + 运行时密钥**（`PLATFORM_GATEWAY_KEY` 那把，
短时、绑课堂），**不是**渠道真密钥 —— 学生读得到自己的进程环境，真密钥导出即等于泄漏 + 绕过账本。
网关那一跳会把它换成真密钥（见 `apps/server/src/routes/runtimeSearchGateway.js`）。

## 入口闸门（已实测）

| 场景 | 结果 |
|---|---|
| 全新浏览器 + 票据 `?t=<票据>` | 200，真 dsh 界面（`<title>DeepSeek Harness</title>`） |
| 带着别的容器留下的旧 cookie + 票据 | 200（第一次命中就把 cookie 换成本容器的） |
| 只有旧 cookie、没有票据 | 403 |
| 既没票据也没 cookie | 403 |

## 已知待改进

1. dsh 的会话票据（`?token=`）目前是**内部 302** 补上的，浏览器地址栏会闪现一次；
   生产做法应由平台后端完成这一次交换，再把 cookie 交给浏览器（容器内 nginx 不再需要这段逻辑）。
2. `dsh_edge` cookie 的值就是平台票据；生产应换成平台签发的**按会话**cookie（并在会话结束时失效）。
3. **产物回传：后端已做，前端还没接**（2026-09-16 第三轮）。学生工作区里的作品现在能**列出来、
   取回来、按现有作品链路落库**（网页作品端到端跑通，含作品里的本地图片；收环境前会先留存一份）。
   差的：① 学生页面上的按钮（`/api/student/runtime/*` 目前没有前端在调）；
   ② **二进制产物（PPT/Word/Excel 原文件）的收纳与广场展示 —— 要先定口径**
   （现有链路把 `files` 当文本规格存、下载时现场渲染，装不下真 `.pptx`；
   而 dsh 的 PPT 插件产出的就是真二进制）。详见
   `docs/operations/新对话交接-dsh迁移-20260916-第三轮.md`。
   注：产物清单**不以** `deliverables/presented` 事件为准（它只记路径、还依赖模型记得调 `present`），
   **以工作区为准** —— dsh 的 PPT 成品也会发布到工作区里（实测代码路径）。
4. 工作区要学生手动选一次（dsh 的界面在选好工作区前不让发消息）；平台建会话时应预选 `/home/student/workspace`。

## 模型名只当「意向」、带图的请求默认跟着模型走（2026-09-16）

容器补丁层里那两行 `deepseek-flash` / `deepseek-pro` **只是给学生看的槽位名**，不是上游的真名。
网关（`apps/server/src/routes/runtimeGateway.js` 的 `resolveRuntimeSelection`）这样解析：

| 容器报的 | 落点 |
|---|---|
| 带图的请求（学生贴图） | **同一条 TEXT 渠道、同一个模型**（默认；我们的模型能看图） |
| 带图的请求 + 后台配了「读图渠道」 | 改走那条渠道（可选覆盖，留给「想把图单独送去另一条渠道」的场景） |
| 名字**在**默认 TEXT 渠道的模型清单里 | 就用这个名字（渠道支持多模型时有用） |
| 名字**不在**（含 `provider/model` 前缀的写法） | 用这条渠道**自己的 model**，绝不把容器报的字符串原样发上游 |
| 管理员配了 `modelRoutes`（名字 → 哪条渠道） | 按路由走（既有语义不变） |

网关同时负责**别把图弄丢**：多模态 content 数组以前被压成 `"[object Object]"`（学生的图在网关这一跳就没了），
现在只放行文字与 `http(s)`/`data:image`，其余（含容器内的 `file://` 路径）丢掉。

守卫：`node scripts/p97-runtime-gateway.mjs`（网关这一侧的规矩，20 项）、
`node scripts/p98-runtime-container-e2e.mjs`（**真容器**：容器里带图的调用打到我们的网关、
跟着模型落在 TEXT 渠道（或配了读图渠道时落在它上面）、进 `usage_records`；
本机没有 docker 或没有镜像时**明确跳过**，不装作通过）。

## 已装的社区插件与 PPT 预设（2026-09-16）

用户指定要装这 8 个仓库；核实后按**可安装形态**分成三类（全部固定版本，见 Dockerfile 里的 ARG）：

| 仓库 | 实际包 | 版本 | 结果 |
|---|---|---|---|
| omdsh-dev/DSH-better-sidebar | `dsh-better-sidebar` | 0.19.1 | 已装并挂载（侧边栏底座） |
| bowenliang123/dsh-context | `dsh-context` | 0.52.2 | 已装并挂载（它自己声明兼容 dsh 0.1.5-rc.1） |
| awesome-dsh-plugin/dsh-find-plugin | `dsh-find-plugin` | 0.3.7 | 已装并挂载 |
| liustack/modlens | `@liustack/modlens` | 3.26.1 | 已装并挂载（**dsh 侧的读图能力**，补的是 dsh 自身缺的那块；凭据由入口脚本钉到我们的网关，读图花的钱也进我们的账） |
| zhu1090093659/dsh-web | `@linxin666/dsh-web-all` | 0.3.23 | 已装并挂载（聚合仓；`dsh-web` 本身是 20 多个子包的 monorepo，装的是它的全家桶聚合包） |
| FSMargoo/dsh-at-file | `dsh-at-file` | 0.6.3 | **已装但禁用**：它 import 的 `settingsNamespace` 在我们钉的 dsh 0.1.5-rc.1 里不存在，挂上就整棵树加载失败、界面起不来（npm 上它只有这一个版本，没有可回退的旧版） |
| dataelement/dsh-desktop | `dsh-ppt` + `dsh-ppt-composer` | 0.1.1-rc.2 | 已装；**PPT 预设**（可编辑 PPTD + 本地生成 PPTX，16 套模板 / 134 布局） |
| Lum1104/dsh-browser | `@yuxianglin/dsh-bridge-browser` | 0.0.5 | **未装**：它是「dsh 侧一个桥 + 每个学生自己浏览器里一个 Chrome 扩展」，扩展没法装进容器，桥也没发布到 npm；给学生的容器里装它没有意义 |

### 装 PPT 预设踩到的两个坑（都已固化进 Dockerfile）

1. **`dsh-ppt-composer` 把 `dsh-ppt@0.1.1-rc.2` 声明成 registry 依赖**，而那个版本并没有发布到 npm ——
   npm 上的 `dsh-ppt@0.4.2` 是**别人的另一个项目**（`STARDUSTLC666/dsh-ppt`）。
   不写 override 的后果不只是装不上，而是可能把同名第三方包当依赖拉进来，所以这里显式
   `pnpm.overrides` 把 `dsh-ppt` 指到本地 tarball。
2. **`dsh-ppt` 只能当依赖、不能同时当 bundle**：它和 `dsh-ppt-composer` 都会注册名为
   `dsh-ppt-bundled` 的 skill provider，两个都挂载就报「already registered」，整棵树起不来。
   构建里在装完 composer **之后**再从 `dsh.profile.bundles` 里摘掉 `dsh-ppt`（依赖保留），并断言这一点。

### 还没做的裁剪（截图实测出来的清单）

装完插件后学生界面多出了这些**不该给孩子看/用**的东西，需要按图索骥地关掉：

- **DSH 自己的「内测声明」弹窗**（面向 Harness 开发者的公告，还会挡住界面）；
- 侧边栏的 **任务看板 / 远程访问 / 检查更新 / 设置**；
- **选择工作区**（我们的场景是「一学生一容器一 workspace」，应当固定住、不让选）；
- 右下角的**宠物/皮肤**一类装饰入口。

这些大多来自 `@linxin666/dsh-web-all` 与 `dsh-better-sidebar`，做法是在我们的补丁层里把对应行
`disabled: true`（或在插件自己的配置里关掉）；每加一条都要重新构建 + 启动验证，所以下一轮集中处理。

### 裁剪与预置（2026-09-16，均已实测）

装完插件后学生界面多出来的成人入口，做法是在补丁层里把**行**关掉（包留着）：

- 关掉：插件管理 / 市场 / 社区插件 / 远程访问 / 诊断 / 任务看板 / Git 图 / 宠物 / 皮肤中心 /
  会话归档 / 用量 / 模型能力 / 描述图片（都来自 `@linxin666/dsh-web-all`），以及设置里的插件清单页。
- **保留目录选择器**：dsh 的界面在「选好工作区」之前不允许发消息，把它关掉会让输入框一直是灰的（实测踩到）。
- **预置「开发者内测声明已读」**：那是 DSH 面向 Harness 开发者的公告，会挡住界面（不点「继续」就用不了）。
  客户端读 `ui-onboarding.welcomeNoticeVersion` 与自己的常量 `"2026-08-13.1"` 比较，所以镜像里直接写好
  `$DSH_HOME/settings.yaml`。

### 入口标记按容器唯一（修一个真实 401）

`dsh_edge` 这个「已经补过 token」的标记，最初用固定值、后来用平台票据值，都踩到同一个坑：
浏览器里留着**别的容器**或**同一个学生用同一张票据重开容器**时的旧 cookie，会让这台容器误判
「token 已补过」→ 直接打到 dsh 的 401 页（实测出现过）。
现在标记值 = **本次启动 dsh token 的 sha256 前 16 位**，由 entrypoint 渲染，容器一次一换；
`?t=` 票据仍按平台签发的那张校验。复测：带旧同值 cookie 的 jar 访问 → 200 并换成本容器标记。
