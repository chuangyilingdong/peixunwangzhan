# 学生运行时容器（dsh = DeepSeek Harness）

一个学生一节课 = 一个这个容器的实例。容器没了，会话日志、工作区、票据一起没。

配套方案与全部踩坑记录：`docs/operations/VibeCoding改用dsh-方案-20260916.md`。

## 里面有什么

- **dsh** `@deepseek-ai/dsh@0.1.5-rc.1`（**固定版本**：官方自称会有破坏性变更，不要用 latest）
- **我们的补丁层** `student-runtime.cordis.yml`：
  - 模型路由只用**我们自己的网关**（`llm-pi-ai` 的 hand-declared gateway，凭据走 `apiKeyEnv`，密钥不进配置文件）
  - 课程技能目录（`skills/`，一个课程一个 `SKILL.md`）
  - 沙箱 `workspace-write` + 审批 `never`（**语义是「直接拒绝」**，不是自动放行），并把 `defaultPreset` 显式指到同名预设
  - 关掉给学生的成人入口：`cordis-host-runner` / `cordis-client-runner` / `ui-cordis`
    （模型能自造插件挂进宿主，官方注释说在 Web 面上沙箱与审批都会被绕过）、`plugin-inventory`（插件管理）、
    `directory-picker`、`open-in-app`
- **容器内 nginx**：dsh 只绑 `127.0.0.1` 且**拒绝** `--host 0.0.0.0`（官方理由：会把 RCE 暴露到网络），
  所以对外入口必须由容器内的这层 nginx 提供 —— 它校验我们平台的短时票据，再把请求转给 `127.0.0.1:3080`。
- **读图（modlens）也走我们的网关**：入口脚本按本次容器注入的运行时密钥写 `~/.modlens/config.json`，
  把它的 openai 路由指向 `GATEWAY_BASE_URL` + `PLATFORM_GATEWAY_KEY`（`provider: openai`、`reuse` 全 false）。
  它自带 OpenAI / Gemini / Antigravity CLI 等渠道，容器里既没有那些凭据、花了钱也不进我们的账，
  所以这一步是**必须**的，不是可选优化。模型名由 `PLATFORM_VISION_MODEL` 给（默认 `platform-vision`），
  平台在**读图渠道的模型清单**里解析它（见下「模型名只当意向」）。

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
  dsh-student:local
# 学生从 http://<入口>/?t=<票据> 进入
```

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
3. 还没接：我们自己的 PPT/文档产物工具（dsh 没有这类工具）、以及把 `deliverables/presented`
   事件接回我们的作品提交接口。
4. 工作区要学生手动选一次（dsh 的界面在选好工作区前不让发消息）；平台建会话时应预选 `/home/student/workspace`。

## 模型名只当「意向」、读图单独一条渠道（2026-09-16）

容器补丁层里那两行 `deepseek-flash` / `deepseek-pro` **只是给学生看的槽位名**，不是上游的真名。
网关（`apps/server/src/routes/runtimeGateway.js` 的 `resolveRuntimeSelection`）这样解析：

| 容器报的 | 落点 |
|---|---|
| 带图的请求（modlens 读图） | 政策里的 **`visionChannelId`（读图渠道）**，并在它的模型清单里解析名字 |
| 名字**在**默认 TEXT 渠道的模型清单里 | 就用这个名字（渠道支持多模型时有用） |
| 名字**不在**（含 `provider/model` 前缀的写法） | 用这条渠道**自己的 model**，绝不把容器报的字符串原样发上游 |
| 管理员配了 `modelRoutes`（名字 → 哪条渠道） | 按路由走（既有语义不变） |

没配读图渠道时，带图的调用**直接 409**（`RUNTIME_VISION_UNCONFIGURED`）而不是退回纯文本渠道 ——
后者会让学生拿到一段编出来的「图里有什么」，钱照花、结论是假的。

守卫：`node scripts/p97-runtime-gateway.mjs`（网关这一侧的规矩）、
`node scripts/p98-runtime-container-e2e.mjs`（**真容器**：容器里读图 → 我们的网关 → 落进 usage_records；
本机没有 docker 或没有镜像时**明确跳过**，不装作通过）。

## 已装的社区插件与 PPT 预设（2026-09-16）

用户指定要装这 8 个仓库；核实后按**可安装形态**分成三类（全部固定版本，见 Dockerfile 里的 ARG）：

| 仓库 | 实际包 | 版本 | 结果 |
|---|---|---|---|
| omdsh-dev/DSH-better-sidebar | `dsh-better-sidebar` | 0.19.1 | 已装并挂载（侧边栏底座） |
| bowenliang123/dsh-context | `dsh-context` | 0.52.2 | 已装并挂载（它自己声明兼容 dsh 0.1.5-rc.1） |
| awesome-dsh-plugin/dsh-find-plugin | `dsh-find-plugin` | 0.3.7 | 已装并挂载 |
| liustack/modlens | `@liustack/modlens` | 3.26.1 | 已装并挂载（视觉桥；**凭据由入口脚本指向我们的网关**，见上「读图」） |
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
