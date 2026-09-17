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

> ⚠️ **补丁层的源头是镜像，不是宿主上的那个文件**（2026-09-17 订正，原来这里写反了）：
> 装机时 `provision-user-runtime.sh` 从镜像里 `tar` 出 `etc/dsh` 与 `home/student/.dsh`
> **覆盖**到 `/opt/dsh-runtime/` 下 —— 所以**直接改宿主上的
> `/opt/dsh-runtime/etc/dsh/student-runtime.cordis.yml`，下一次 provision 就没了**。
> 要改就得改 `Dockerfile` 里 `COPY` 的那份（本目录的 `student-runtime.cordis.yml`）并重建镜像。
> 另外 dsh **只在启动时读一次**补丁层 —— 改完必须**重启学生环境**才生效。
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

## 学生端的三个功能：对话 / 写代码 / 做网页（`feature-plugin/`）

用户口径（2026-09-17）：「一个页面，然后分成不同的功能，例如像豆包这种」—— 做在 **dsh 自己的输入框那一排**，
点了就切，**随时可切**（不是只有新会话能选）。切了 AI 的角色与默认产出跟着变，**能力边界不变**
（同一个 agent、同一套工具与技能；三档都还能写网页、做文档）。

做法（三件事都用 dsh 现成的机制，写法照抄官方 `dsh-plan-mode` —— 它做的就是同一件事）：

| 要做什么 | 用什么 | 注意 |
|---|---|---|
| 按会话记住选了哪个功能 | `sessionProjections.register` + `agent.session.append('studentFeature/mode', …)` | 状态钉在**会话日志**上，不在进程内存里；恢复/分叉会话能重建 |
| 让功能影响模型 | `systemPrompt.section`，`text` 是**函数** | ⚠️ **不要**用 `agent/request` 改消息：官方写死了它不能改消息 |
| 浏览器怎么切 | 宿主注册 `/feature <id>` 命令，客户端 `ctx.remote.commands.execute` | 不自建 RPC 命名空间 |

浏览器那半边挂在 **`conversation.input.left`**（官方留白、没有占用者的 list 插槽）。三条硬约束：
- 插件里**只能 require react / react/jsx-runtime**（别的包不在磁盘上，被打进 shell 了）；
- 样式一律**内联**（没有给我们注入样式表的通道）；
- 插槽给的标准 props 是 **`sessionId` / `useSession` / `useProjection`** 三个，当前功能用
  `useProjection('studentFeature')` 读 —— 与官方「计划模式」读 `useProjection('plan')` 同款。
- 插槽是 `scope: session` 的：**新会话首页不渲染**，所以这一排按钮在「已经有会话」之后才出现。

> ⚠️ **最容易踩、也最贵的两个坑**（都实测踩过，守卫 p108 已钉住）：
> 1. **宿主插件里读服务必须先 `inject`**。少写一个，cordis 抛「cannot get property … without inject」，
>    而加载器遇到插件 `apply` 抛错会让**整个 profile 起不来** —— 学生打开创作环境直接白屏。
>    所以包里的 `apply` 自己兜了异常：最坏是「功能开关不生效」，不能是「学生进不去」。
> 2. **诊断代码（`appendFileSync` / 调试 `console.log`）不许留在包里**。上一轮靠「写文件看有没有出现」
>    判断插件加载，而那次判断建立在一份**没有重启过的部署**上，于是得出「宿主插件挂不上」的**错误结论**，
>    整个方向都跟着错了一轮。判插件有没有加载，请直接读启动日志。

## 办公文件预览：Univer 插件（2026-09-17 起装）

学生用 dsh 做出了 `.pptx`，但 dsh 自己没有 office 渲染器 —— 界面只给一句「此文件类型不支持预览」，
于是「生成了个 PPT，打不开也看不到」。装 `dsh-univer-office`（0.3.2）补上这一块：
**浏览器内预览与编辑** xlsx / docx / pptx（导入 `.xlsx/.csv/.tsv/.docx/.pptx`）。
它声明支持 `^0.1.5-rc.1`，与我们钉的 dsh 版本对得上。

三条**实测**出来的事（写在这里免得下一轮再踩）：

| 事项 | 实测 |
|---|---|
| `dsh plugin add` 会重算 bundles | 它把 `dsh-ppt` **又加回了 bundles** —— 必须再摘一次（否则与 composer 抢注册 `dsh-ppt-bundled`，整棵插件树起不来）。所以这一步必须排在「PPT 那一步之后」 |
| Chromium | 「PDF 打印 / 截图 / 幻灯片校验 / SVG 文字测量」**需要本机有 Chromium**。镜像里没有（`/usr/bin/chromium-browser` 只是 snap 桩，`/snap/bin/chromium` 不存在）→ 这几项不可用；**预览与编辑本身是浏览器内渲染，不受影响** |
| 内存 | 一个学生环境 RSS 从 **~258MB → ~550MB（+~290MB）**。这台 1.6GB 的机器本来就只塞得下 1-2 个环境，装完余量更紧 —— 要开更多学生得先加内存 |

顺带（同一轮）：宿主上的 `/opt/ppt-bundles` **原本是缺的**，而 profile 的 pnpm override 指着它
（`file:/opt/ppt-bundles/dsh-ppt.tgz`）—— 于是**任何 pnpm 操作都会失败**（`dsh plugin add` 也跑不了）。
镜像里有这份、`provision` 不抽它，所以宿主上要单独补：见下面「PPT 预设」一节的做法。

**部署**：包放在 `/opt/feature-plugin`，profile 的 `node_modules/@lingdong/dsh-feature` 软链指向它，
`package.json` 的 `dsh.profile.bundles` 里也要有 `@lingdong/dsh-feature`（**两个都要**：
bundles 决定加载器有这一行，node_modules 决定这行解析得到；缺前者不会加载，缺后者整个环境起不来）。

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
