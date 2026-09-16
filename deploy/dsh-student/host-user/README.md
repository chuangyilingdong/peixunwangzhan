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

# 收（课堂结束 / 移出名单 / 兜底）
bash stop-student-user.sh --session <课堂id> --student <学生id>
```

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

学生浏览器要连 `https://域名:18201/`，**这个端口得在阿里云安全组里放行**
（现在只开了 22/80/443，实测 18201 从公网不通）。
建议只放行 `18201-18220`（20 个并发），来源 `0.0.0.0/0` —— 每个端口后面都有票据闸门，
且 dsh 自己还有一层会话票据。不放行的话，学生在自己机器的浏览器里打不开这个地址。
