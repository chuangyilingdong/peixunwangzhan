# 新对话交接 · 三个功能做成 dsh 输入框那一排按钮（2026-09-17 第十一轮）

> 时点交接，不是口径源。领域口径以 `docs/README.md` 为准。
> 上一份：`docs/operations/新对话交接-VibeCoding三选项-20260917.md`
> ⚠️ **上一份里「三个功能用 dsh 原生 preset 承载」这条已经被本轮取代**，原因见第一节。

## 一、⚠️ 上一轮那个结论是错的：宿主插件**能**挂上

上一轮的交接里写着：

> 「实测这个部署里 `link:` 进 profile 的包**只有客户端半边会下发，宿主半边不被加载** ——
> 连品牌包的宿主 `apply` 也从未被调用过。三条接法都试过，症状都是『模块压根不被 import』。
> 所以『宿主插件改 agent 行为』这条路暂时走不通。」

**这个结论是错的**，而且它错得很贵 —— 整个方向（改用 preset）都是建在它上面的。真实情况是：

| 当时观察到的 | 当时下的判断 | 实际原因 |
|---|---|---|
| `/tmp/lingdong-brand.diag` 从未生成 | 宿主 `apply` 没被调用 | 那份**带诊断代码**的品牌包是 13:34 传上去的，而两个学生环境是 12:07 / 12:29 起的 —— **从来没重启过**。dsh 只在启动时加载插件。 |
| 新包 `@lingdong/dsh-feature` 不被 import | 新包挂不上 | 那个学生的 `node_modules/@lingdong/` 里**没有这个软链**（模板有了、他的家目录没有），而 `package.json` 已经被硬链接更新成「要它」→ 解析失败。 |

怎么查实的（这套方法直接可复用）：拿一个**探针用户**（`dshprobe2`）+ 一份**隔离的插件副本**，
在宿主插件模块末尾加一行「被 import 时就写一个文件」，然后**用那个用户冷启动一个探针实例**：

```
# 探针实例（学生用例、不进生产入口）
runuser -u dshprobe2 -- env DSH_HOME=/home/dshprobe2/.dsh DSH_WORKSPACE=… \
  /opt/dsh-runtime/opt/node/bin/node …/@deepseek-ai/dsh/lib/bin.js \
  --profile web --patch /opt/dsh-runtime/etc/dsh/student-runtime.cordis.yml \
  --trusted-host 127.0.0.1 --no-open --host 127.0.0.1 --port 19301
```

结果：品牌包与功能包的模块**都被 import 了**，`apply` 也被调用了，而且三个服务
（`sessionProjections` / `systemPrompt` / `commands`）**都在**。

### 顺手查出来的一个真 bug（比错误结论更要紧）

那个「探测一下服务在不在」的诊断版把 `inject` 清空了，而 `apply` 里照读 `ctx.sessionProjections`：

```
failed to apply loader entry lingdong-feature: cannot get property "sessionProjections" without inject
```

**cordis 的规矩**：`inject` 里没声明的服务，读它就抛。而 **dsh 的加载器遇到插件 `apply` 抛错，
会让整个 profile 起不来**（实测：学生打开创作环境直接白屏、端口都不监听）。

所以这个部署里那条 `README` 里写过的老话要再强调一次：**插件里的 `apply` 必须自己兜异常**。
功能包现在包了一层 `try/catch`：最坏情况是「功能开关不生效」，绝不能是「学生进不去创作环境」。

## 二、口径（学生看到什么）

学生干活的地方就是**创作环境（dsh）那一个页面**，输入框那一排有三个按钮：

```text
[对话] [写代码] [做网页]        ← 点了就切，随时可切（不是只有新会话能选）
```

- 三个功能的差别**只在于 AI 的角色与默认产出**（进系统提示词），**能力边界一分不减**
  （同一个 agent、同一套工具与技能；三档都还能写网页、做文档）。
- 切换是**按会话**记的（钉在会话日志里），刷新、恢复会话都还在。
- 用户原话：「一个页面，然后分成不同的功能，例如像豆包这种」「我需要的是 dsh 那个页面来完成这些工作」。

## 三、改了什么

### 1. 三个功能做成 dsh 插件（`deploy/dsh-student/feature-plugin/`，自成一个包）

三件事全部用 dsh 现成机制，写法**照抄官方 `dsh-plan-mode`**（它做的就是同一件事：「客户端一个开关 → 宿主状态变」）：

| 要做什么 | 用什么 |
|---|---|
| 按会话记住选了哪个功能 | `sessionProjections.register` + `agent.session.append('studentFeature/mode', {feature})` |
| 让功能影响模型 | `systemPrompt.section({order:100, text: (ctx) => …})` —— `text` 是函数，按会话逐轮重算 |
| 客户端怎么切 | 宿主注册 `/feature <id>` 命令；浏览器 `ctx.remote.commands.execute(sessionId, '/feature web', [])` |

**不要**用 `agent/request` 改消息（官方写死了它不能改消息）；**不要**自建 RPC 命名空间。

浏览器那半边挂在 **`conversation.input.left`**（官方留白、无占用者的 list 插槽）。实测确认的三条硬约束：
- 只能 `require('react')` / `require('react/jsx-runtime')`，别的包不在磁盘上（被打进 shell 了）；
- 样式必须**内联**（没有注入样式表的通道）；
- 插槽给的标准 props 是 **`sessionId` / `useSession` / `useProjection`**，当前功能用
  `useProjection('studentFeature', …)` 读 —— 与官方计划模式读 `useProjection('plan')` 同款；
- 插槽是 `scope: session`：**新会话首页不渲染**，所以这一排按钮在「已经有会话」之后才出现。

### 2. 撤掉上一轮的三个 dsh 原生 preset

那是「宿主插件挂不上」这个**错误结论**下的替代方案。撤掉的理由：
① 与按钮是**两套并行的「本节做什么」**，学生会同时看到两个 switcher；
② preset 的规矩是**只有空会话能切**，与用户要的「随时可切」正相反。
已删：补丁层里的 `agent-presets` 段 + 宿主上的三个 preset 目录。

### 3. 品牌包拆回「只管品牌」

功能开关曾被并进品牌包（同样是因为那个错误结论）。现在品牌包只剩品牌 ——
它是**承重**的（它挂了整个外观都没了），不该跟着别人一起出事。

### 4. 平台侧：删老工作台 + 入口改回 dsh（`442f34d`），本轮**把它发了出去**

老工作台（约 960 行的控制台）、只被它用的 SSE 客户端、网站上 `/learn/vibecoding` 两条路由与页面组件
已删；入口恢复成「进入创作环境」+「提交作品」。上一轮只提交、没发布 —— 本轮发布并核验（见第五节第 1 条）。

### 5. 装机路径：功能包必须随镜像走（本段是最后补的，别删）

`provision-user-runtime.sh` 从镜像里 `tar` 出 `etc/dsh` 与 `home/student/.dsh` **覆盖**宿主 ——
**镜像才是补丁层与 profile 模板的源头**。本轮的按钮先是手工接在宿主上的，
所以 `Dockerfile`（`COPY feature-plugin/` + `dsh plugin add /opt/feature-plugin` + 两条断言）、
`provision`（抽取清单加 `opt/feature-plugin`、补根路径软链、收尾把两个自写插件的
「目录 / profile 软链 / package.json 引用 2 处」打出来）都补齐了，`p108` 钉住。

### 6. 顺带处理了一个并行提交

`5f30023`（另一个会话在 14:07 落的 `deploy/dsh-student/agent-presets/make-presets.mjs`）
已删除：它要生成的三个 preset 在 `67a104f` 撤掉了（理由见上面第 2 条），留着会误导下一个人。
它里头**唯一有价值的那条发现是真的**（「补丁层与 profile 的源头是镜像」），
已搬进部署 README 与 `provision` 的注释 —— 本轮的镜像缺口正是因为看到它才查出来的。
它另说的「补丁层里至今没有 agent-presets 这一段」与实测不符：那段一直在。

## 四、怎么验的（这次是真端到端）

1. **真浏览器 + 真 dsh**：探针实例里选中工作区建出会话后，输入框那一排出现
   `本节功能` 一组三个按钮，「对话」默认按下；点「做网页」后 **`aria-pressed` 转到「做网页」**。
2. **会话日志**（`session.v3.jsonl.zstd`，`zstdcat` 解开）里能看到完整三步：
   `command/run(name=feature)` → `studentFeature/mode` → `command/done(kind=success)`。
3. **模型真的按新角色回答**：切到「做网页」后问「你现在的本节功能是什么」，模型答 **「做网页」**
   —— 证明那段角色说明确实进了系统提示词（不是只有界面变了）。
4. **两台真学生环境重启后复验**：`systemctl` 单元 active、启动日志无报错、
   发给浏览器的客户端插件清单里出现 `@lingdong/dsh-feature/client.js`（之前只有品牌那条）。
5. **学生从平台进去那一段也验了**（发布之后，用生产测试账号 `student-1`，服务端侧走的）：
   `/api/student/runtime/status` 返回 `available: true`（学生看到的就是「进入创作环境」，
   不是「暂不可用」）；调「进入创作环境」那个按钮的后端 `/api/student/runtime/launch`，
   返回的入口是**当前**的（`18202` + 新票据 —— 每次点都由宿主脚本现取现给，不存在陈旧票据）；
   跟着它 302 到 dsh 页面 → **200，标题「灵动ai」，客户端插件清单里有
   `@lingdong/dsh-feature/client.js`**。⚠️ 这一段是**服务端侧**验的：本机出口封着 HTTPS，
   没能在浏览器里点这一遍（前几轮同样受这个限制）。
6. 全量守卫 **117/117**；`p108` 新增 22 条断言钉住这个插件与它的装机路径（inject 与服务一致、
   `apply` 兜异常、无诊断残留、品牌包不含功能代码、补丁层不再配 preset 等）。

## 五、风险与未做

1. ✅ **平台侧已发布**：生产 `release 20260917T061044Z` / commit `92d9700`。
   回滚 = `current` 软链切回 `20260917T050652Z` 再重启（备份 `backups/20260917T061040Z`）。
   核验：BUILD-METADATA 的 commit 对得上、服务 active 且 `NRestarts=0`、`/health` 200、
   三端入口 200，并且**部署出去的产物里老工作台痕迹为 0**、新的「进入创作环境」在。

   ⚠️ **但镜像还没重建**（见下一条），也就是说：**现在别跑 `provision-user-runtime.sh`**。
2. **切换会在对话里留下一张卡片**。dsh 的规矩：命令的结果「renders as a persistent flow node」，
   没有「不显示」开关（官方 `/plan` 也一样）。所以文案改成了给学生看的一句「已切到「做网页」」，
   但卡片本身还在。真嫌吵的话得另找通道。
3. **原生 preset 那个「标准模式 ⌄」还在**（它是 dsh 官方组件，不是我们加的）。它和我们的三个按钮
   是**两个轴**（preset = 用哪套 agent 人设/工具；按钮 = 本节做什么），但学生可能觉得像两个模式开关。
   **本轮刻意没动**（不是我们引入的，动它要另做决定）。
4. **平台侧那套 `mode` 列 + 提示词分档现在没有界面在用它**（学生选功能是在 dsh 里）。
   保留是刻意的（删它要连提交/产物一起拆），等专门一轮再收。
5. 三个功能的角色文案**只在探针会话里真机跑过一轮**（模型答「做网页」）。三档合不合口味，
   要在真课上多跑几节才知道。
6. ⚠️ **镜像还没重建 —— 这是本轮最后发现、也最容易被忽略的一个缺口**。
   `provision-user-runtime.sh` 会从镜像里 `tar` 出 `etc/dsh` 与 `home/student/.dsh`
   **覆盖**到宿主上：也就是说**补丁层与 profile 模板的源头是镜像**，宿主上那两份只是它的副本。
   而这一排按钮是先在宿主上**手工接通**的（`/opt/feature-plugin` + profile 软链 + bundles 那条），
   镜像里当时没有它 —— 换台机器、或重跑一次 provision，**按钮就没了**
   （更坏的情况：profile 里留了 bundles 却缺软链 → 整个创作环境起不来）。
   已经做的：`Dockerfile` 补上 `COPY feature-plugin/ /opt/feature-plugin/` +
   照品牌包同款 `dsh plugin add`（并断言 bundles 与 dependencies 两条），
   `provision` 的抽取清单与根路径软链也补齐了，`p108` 钉住这一串。
   **没做的：真正重建一次镜像并重跑 provision 验证**（本机没有 docker，镜像历来在别处构建）。
   重建之前，宿主上那份是手工接的 —— 别去动它，也别跑 provision。
7. ⚠️ **宿主上发现一处属主不对（本轮已修一半，另一半是既存问题）**：
   `/opt/feature-plugin` 与 `/opt/dsh-runtime/opt/brand-plugin` 这两个**所有学生共读**的目录，
   属主一度是某个学生用户 —— 目录属主能**替换目录里的文件**，等于一个学生能改到别人加载的插件
   （`dsh` 的宿主插件是以该学生身份加载的）。已改回 `root:root` + `755`/`644`。
   **既存的那一半**：`/opt/dsh-runtime/opt/node`（共享 Node 运行时）的属主是探针账号 `dshprobe2`，
   本轮**没动**（chown 整个运行时风险大于收益，且实际入口被 dsh 沙箱挡着）。
   要收的话：`chown -R root:root /opt/dsh-runtime/opt/node`，并顺手把不再用的探针账号 `dshprobe2` 收掉。

## 六、这一轮的坑（都别再踩）

1. **「没重启」会让一切诊断失效** —— 见第一节。判插件有没有加载，读启动日志；
   文件诊断只有在**确认环境是重启过的**前提下才有效。
2. **Git Bash（MSYS）会改写参数里的反斜杠**：`node -e '…"\n"…'` 里的 `\n` 会被吃掉，
   生成出语法错误的 JS（这一轮踩了两次）。**要生成文件就写脚本文件再跑**，别用 `-e` 拼字符串。
3. **手工 `systemctl restart` 学生单元会让入口失效**：dsh 每次启动换一个新 token，
   而 nginx 入口 conf 里存的是启动那一刻的 token；重新跑 `run-student-user.sh` 走**复用**分支时，
   它从日志里取 token 用的是 `head -1` —— 日志是**追加**的，手工重启多留一行旧 token 就会被取错。
   正确做法：先把日志收敛成最后一行，再重跑 launch 脚本（它会重写入口并 reload nginx）。
4. **`pkill -f` 打不死探针**：它只打到了 `runuser` 外层包装，真正的 node 子进程还在。
   按 PID 收（`ps` 里认 `--port <端口>` 那一行）。
5. 学生环境**重启不会丢数据**（工作区、会话都在 `~/.dsh` 与 `~/workspace`）；
   但 `stop-student-user.sh` 会**删家目录** —— 调试用 `systemctl stop/restart`，别用 stop 脚本。
