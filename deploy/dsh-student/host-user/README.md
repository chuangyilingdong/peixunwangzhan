# 学生创作环境 · 同机独立用户版（不用容器）

> 2026-09-16 起，生产上学生环境走这条路（用户口径：**成本要紧**）。
> 容器版仍在 `../host/`，两种形态输出同一套 `KEY=VALUE`，平台侧只看 `DSH_RUNTIME_MODE` 一个开关。

## 为什么不用容器

容器与独立用户**每个学生的内存开销实测相近**（都约 470–500MB —— 大头是 dsh 进程本身，不是隔离方式），
所以省的不是"每个学生的内存"，而是：**不用再买一台机器**、不用 docker 守护进程与镜像分发、
公共运行时只存一份（硬链接共享，磁盘不翻倍）。隔离性上容器更强（见下「边界在哪」）。

## 隔离靠三样，缺一不可

| | 管什么 | 怎么实现 |
|---|---|---|
| ① 独立 Linux 用户 | **同学之间互不可见** | 一个学生一个用户，家目录 `0700`；靠操作系统权限，不靠"我们记得每次都配对" |
| ② dsh 自带的沙箱 | 工作区外的**写**被内核拒 | Landlock（`landlock-run`），实测写 `/etc` 被拒 |
| ③ systemd 资源限额 | 一个人跑飞不拖垮全班 | `MemoryMax=768M` / `CPUQuota=150%` / `TasksMax=256` |

**边界在哪（要说清）**：dsh 的沙箱**只锁写、不锁读**（它交给 Landlock 的是 `readOnly: ["/"]`）。
所以"读不到同学的东西"完全靠 ① 的文件权限 —— 这也是为什么每个学生必须是独立用户、
家目录必须 `0700`。这正是它比容器弱的那一档：容器是"对方的文件系统压根没挂进来"，
这里是"操作系统权限挡住"；**一处漏配就是一次泄漏**，所以下面「装配期必须核实的四条」不能省。

## 布局（与容器里同一套绝对路径，少一处不一致就少一个坑）

```
/opt/dsh-runtime/opt/node            运行时（node + dsh 全局包）
/opt/dsh-runtime/opt/brand-plugin    品牌包（profile 里有指向它的绝对符号链接）
/opt/dsh-runtime/home/student/.dsh   烤好的 profile（含全部插件）—— 共享只读模板
/opt/dsh-runtime/etc/dsh             补丁层与课程技能
/opt/brand-plugin -> /opt/dsh-runtime/opt/brand-plugin   （补上镜像里的绝对路径）
/etc/nginx/dsh-students/<名>.conf    每个学生一条 server 块（开课时生成、停课时删）
/etc/nginx/dsh-proxy-headers.conf    WebSocket 升级 + SSE 不缓冲 + 长超时
/srv/dsh-runtime/logs/<名>.log       每个学生的启动日志（dsh 的会话票据从这里取）
```

每个学生的家目录里只有他自己的东西：`workspace/`（工作区）、`.dsh/`（设置 + 会话）、
`.modlens/config.json`（读图凭据，指向我们的网关）、`.credentials.yaml`（dsh 的凭据，运行时生成）。

## 用

```bash
# 装配（root，一次；幂等）
bash provision-user-runtime.sh                # 默认从 dsh-student:local 提取运行时
bash provision-user-runtime.sh /root/dsh-student.tar   # 或从镜像包

# 开一个学生的环境（平台调这个；root 或经窄 sudoers）
bash run-student-user.sh --session <课堂id> --student <学生id> \
  --key <平台签发的运行时密钥> --gateway https://iicili.cyou/api/gateway/v1 \
  --ticket <平台签发的短时票据>
# 输出：RUNTIME_NAME= / HOST_PORT= / EDGE_URL=https://<域名>:<端口>/?t=<票据>

# 收（课堂结束 / 移出名单 / 兜底）—— 收之前会**先留住产物**，见下面「取回产物」
bash stop-student-user.sh --session <课堂id> --student <学生id>

# 取回产物：列清单 / 取一份 / 留存（平台调这个；root 或经窄 sudoers）
bash collect-student-user.sh --session <课堂id> --student <学生id> --list
bash collect-student-user.sh --session <课堂id> --student <学生id> --export mygame/index.html
bash collect-student-user.sh --session <课堂id> --student <学生id> --preserve
```

## 取回产物（2026-09-16 加，切学生入口前必需的那一段）

dsh 把作品落在**学生自己的工作区**里，平台库里一份都没有 —— 学生点「提交作品」时，
平台就是靠 `collect-student-user.sh` 把文件取回去的。脚本**只打印一行 JSON 到 stdout**
（告警与错误走 stderr，失败退出码非 0 且带 `COLLECT_*` 错误码），平台直接 `JSON.parse`。

三个子命令：

| 子命令 | 干什么 | 输出 |
|---|---|---|
| `--list` | 走查工作区，列出**可以当作品交**的文件（网页/PPT/Word/Excel） | `{deliverables:[{name,kind,bytes,mtime,recommended}], skipped, truncated}` |
| `--export <工作区相对路径>` | 取回一份：它自己 + 它引用的本地素材（递归） | `{name, origin, files:[{name,encoding,content,bytes,binary,sha256}], renamed, missing, warnings}` |
| `--preserve` | 把当前所有产物**原样留一份**到工作区之外 | `{directory, saved}` |

产物在哪、长什么样，是**实测**出来的（不是按文档推的）：

- 网页作品就是工作区里的 `index.html` 之类；
- **PPT 成品也在工作区里**：`dsh-ppt` 做完一份演示文稿走 `publishWorkspaceOutput()`，
  在工作区建一个以标题命名的目录（第 2 版起 `<标题>-r2`），里面既有 PPTD 工程文件，
  也有**成品 `.pptx`（真二进制）**；
- 会话日志里的 `deliverables/presented` 事件**只记路径、不复制内容**，而且依赖模型记得调
  `present` 工具 —— 所以**不拿它当唯一真相**（`present` 确实挂在默认的 `standard` preset 里，
  这一点核实过，但产物本身以工作区为准）。

三条硬约束（都在 `collect-student.mjs` 里，本机守卫 `scripts/p100` 有对抗性用例）：

1. **只收工作区内部的普通文件**：`realpath` 之后必须仍在工作区内（挡 `../../etc/shadow`）；
2. **拒收符号链接本身**（`lstat` 判定）—— 只看 `realpath` 会被链接指到工作区外面去；
3. **单文件 24MB / 一次导出 48MB 上限**，超了进 `skipped`（`TOO_LARGE`）**明确报出来**，
   不悄悄少给。

另外，`--export` 会做一次**拍平**：现有作品链路只认同层文件名（服务端的产物名校验、
公开下载口、前端预览三处都拒 `/`，2026-09-16 核实），所以 `mygame/index.html` +
`mygame/assets/hero.png` 会被拍平成 `index.html` + `hero.png`，**并把 HTML 里的引用一起改写**，
改名情况进 `renamed`/`warnings`。`--preserve` 不做拍平（留存件是底档，按原样留）。

### 收环境前先留存

`stop-student-user.sh` 现在第一步就是 `collect-student-user.sh --preserve`（留到
`/srv/dsh-runtime/deliverables/<时间戳>/`，含 `INDEX.json` 与每份的 `MANIFEST.json`）。
补这一步之前，「下课」等于**学生的作品直接消失** —— 没点过提交的那些就真没了。
留存失败**不拦**收环境（否则一个坏脚本会让课堂永远收不掉），但会在 stderr 上吵一句。

### 提权通道：特权代理（不是 sudoers）

平台账号要能调那三个脚本（建 Linux 用户、写 nginx 入口、起 systemd 单元、读学生工作区），
但这些都要 root。**不能用 sudo** —— 平台服务的单元里有 `NoNewPrivileges=true`，
那个标志会让 sudo 直接拒绝提权（2026-09-16 第一次真部署时实测：

```
sudo: The "no new privileges" flag is set, which prevents sudo from running as root.
```

所以最初写好的那条窄 sudoers 在生产上**根本走不通**，不管怎么写）。现在的做法是一个
**root 常驻的特权代理** `dsh-host-broker.mjs`：

```bash
install -o root -g root -m 0644 dsh-host-broker.mjs /opt/dsh-host-user/dsh-host-broker.mjs
install -o root -g root -m 0644 dsh-host-broker.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now dsh-host-broker
systemctl status dsh-host-broker --no-pager
ls -la /run/dsh-host-user/broker.sock     # 期望 srw-rw---- root ai-kids-prod
```

- 协议：一行 JSON 请求 → 一行 JSON 应答；op 只有 `launch` / `stop` / `collect` 三种，
  **脚本路径写死在代理里**，不从请求来 —— 它不是一个「以 root 执行任意命令」的后门。
- socket 权限 `0660`、属组 `ai-kids-prod`：能连上它的只有平台那一个身份。
- 参数都过校验：未知 op、以 `-` 开头的值（会被脚本当成选项）、带 `..` 的产物名、超长值一律拒。
- 平台侧开关：`DSH_RUNTIME_TRANSPORT=broker`（用户版**默认**）或 `script`（容器版/本地守卫）。

**旧的 sudoers 规则（`/etc/sudoers.d/dsh-students`）已经撤掉** —— 代理取代了它，
少一处提权面。要回滚就把它改回来并把 `DSH_RUNTIME_TRANSPORT` 设成 `script`。

平台侧开关（`/etc/ai-kids-platform/production.env`）：

```
DSH_RUNTIME_MODE=user                     # user（默认）| container
DSH_RUNTIME_GATEWAY_URL=https://iicili.cyou/api/gateway/v1
# 可选：DSH_RUNTIME_LAUNCH_SCRIPT / DSH_RUNTIME_STOP_SCRIPT 覆盖脚本路径
```

## 权限：一条窄 sudoers（比把平台账号塞进 docker 组窄得多）

平台进程是普通账号 `ai-kids-prod`，而建 Linux 用户/写 nginx 入口/起 systemd 单元都要 root。
`/etc/sudoers.d/dsh-students`：

```
ai-kids-prod ALL=(root) NOPASSWD: /opt/dsh-host-user/run-student-user.sh, /opt/dsh-host-user/stop-student-user.sh
```

**前提**：这两个脚本必须 `root` 所有且平台账号**不可写**（已核实），否则就是提权后门。
装了以后平台账号只能跑这两个脚本，跑别的会被拒（已实测：`sudo -n /bin/ls /root` → denied）。

## 两个入口相关的硬约束（都实测过）

1. **dsh 硬注入 `<base href="/">`**（`dsh-host-frontend-static` 里 `renderIndex(...).replace(..., '<base href="/">')`），
   前端又按 `/plugins/...`、`/assets/...` **绝对路径**取资源 —— 所以它**必须挂在域名根路径**，
   **不能挂 `/dsh/<名>/` 子路径**。一个学生一个端口（`https://域名:18201/`）或一个子域。
2. nginx 必须 `absolute_redirect off`（否则 302 写成绝对地址把浏览器带出入口），
   并 `proxy_redirect` 改写 dsh 自己的 303（它带 `Location: /`）。两个都在生成的 server 块里。

## 装配期必须核实的四条（少一条就可能串号）

```bash
sudo -u ai-kids-prod test -r /etc/ai-kids-platform/production.env && echo '❌ 平台账号能读生产密钥' || echo '✓'
sudo -u ai-kids-prod test -r /srv/ai-kids-platform/production/data/platform.db && echo '❌ 能读生产库' || echo '✓'
sudo -u <学生用户> cat /home/<另一个学生>/workspace/index.html && echo '❌ 同学能读彼此作业' || echo '✓'
sudo -u <学生用户> test -w /opt/dsh-runtime/home/student/.dsh/profiles/web/package.json && echo '❌ 公共运行时可写' || echo '✓'
```

## 真机验证记录（2026-09-16，生产机自身）

- 开环境 → 无票据 **403**、带票据 **302 到相对地址**、跟完跳转出 **灵动ai 界面**、
  复用 cookie 正常、别人的旧 cookie **403**；
- 环境里的模型调用走我们网关 **200**，并落进生产账本（`usage_records` 有 `deepseek-flash SUCCESS`）；
- 隔离：两个学生互相读不到对方作业、列不出对方家目录；学生读不到生产库与生产密钥；公共运行时只读；
- 资源限额生效（`MemoryMax=768M` / `TasksMax=256`，`CPUQuota=150%`）；
- 平台账号走 **sudo** 能开、能收（收 = 停进程 + 撤入口 + 删用户与家目录）。
- **内存实测**：一个学生 RSS 约 470–520MB；这台机器（1.6GB）可用约 1.25GB →
  **同时约 2 个学生**，再多就靠 swap（内核会把闲置的学生换出去，比容器 OOM 杀进程温和）。

## 还差一步（要用户配合）

学生浏览器要连 `https://域名:18201/`，**这个端口要在两处都放行**：

| 哪一层 | 怎么放行 | 不放的表现 |
|---|---|---|
| 阿里云**安全组**（入方向） | 自定义 TCP、端口 `18201/18220`、来源 `0.0.0.0/0` | 连接超时（包在云网络里被丢） |
| 宿主**主机防火墙 ufw** | `ufw allow 18201:18220/tcp` | **也**是连接超时 —— 但抓包能看到 SYN 已经到主机了 |

⚠️ **第二层是最容易漏的**：2026-09-16 就在这儿卡了一轮 —— 安全组放行了、`ss -tln` 也显示在监听，
但从公网连不上。判别方法：在宿主上 `tcpdump -n -i any "tcp port 18201"`，
**如果 SYN 抓得到、客户端却一直超时**，那就是主机防火墙（ufw 默认 deny incoming），不是安全组。
生产机 ufw 现有的放行只有 22/80/443，学生端口段是后来补上的。

**三个地方必须一致**（否则学生会拿到一个从公网打不开的端口）：
① 阿里云安全组；② 宿主 ufw；③ `run-student-user.sh` 里的 `PORT_RANGE`（现在 20，即 18201-18220）。

建议只开 `18201-18220`（20 个并发）。每个端口后面都有票据闸门，dsh 自己还有一层会话票据；
而且**没人上课时这些端口没有监听**（server 块是开课时生成、下课时删掉的），暴露窗口只在课堂期间。


## 给学生端打补丁的正确姿势（2026-09-16 踩了很久）

dsh 的客户端代码有两处**同名拷贝**，而且 pnpm 用的是符号链接 —— 补丁打错地方就会
「明明写进去了、线上还是老代码」：

1. **打包器读的是真身**：`node_modules/@deepseek-ai/<包>` 往往只是指向 `.pnpm/<包>@版本/node_modules/<包>`
   的符号链接。用 `sed -i` 改这个路径会把**符号链接本身换成普通文件**，而打包器按真身路径读
   → 你的改动它永远看不见。**必须用 `fs.writeFileSync`（它会跟随符号链接改到真身）**，
   也就是走 `plugin-shims.mjs` 那套，而不是在真机上 `sed -i`。
2. **客户端 bundle 是服务端现场拼的**，拼的是上面那个真身；所以补丁要进**镜像**（构建期），
   在真机上临时改文件对已经在跑的容器/进程无效。
3. 验证方法：用浏览器抓 `/plugins/??…` 那个大响应体（十几 MB），直接在响应里 grep 你的补丁串
   —— 不要只看文件系统里有没有。

## 学生端的品牌补丁（都固化在镜像构建里）

| 补丁 | 在哪 | 为什么 |
|---|---|---|
| 侧边栏/欢迎页品牌插槽 | `brand-plugin/` | 换掉官方鲸鱼标与字标 |
| 页面标题、关于/公告文案、favicon、manifest、启动字标 | `rebrand.mjs` | 做不了插槽的地方只能改字符串 |
| **「内测声明」弹窗永不渲染** | `plugin-shims.mjs`（`WelcomeNotice`） | 它是给 dsh 开发者看的公告，会**挡住学生界面** |
| PPT 选板的空值崩溃 | `plugin-shims.mjs` | 见文件内注释 |
