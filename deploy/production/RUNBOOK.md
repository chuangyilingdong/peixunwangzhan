# 生产环境运行手册

> 本文件只放**运维用的命令与流程**。产品口径、设计约定、踩过的坑见 `docs/README.md`（最终文档）
> 与 `docs/operations/交接说明.md`。
> ⚠️ 「发布记录（2026-09-08）」往后的内容是**历史快照**，当时的入口/班级口径已不适用 ——
> 只当历史看。当前可执行的流程看本文的「发布流程（当前）」一节。

## 发布流程（当前，2026-09-13 起）

服务器上**必须先补 Node 到 PATH**，否则会报 `node: not found`（运行时 Node 在
`/srv/ai-kids-platform/runtime/node/bin`）。

> ⚠️ **2026-09-16 踩到的坑：服务器上 `remote.origin.fetch` 只配了 `main`** ——
> 于是在特性分支上 `git pull` 是**静默空转**（输出「Already up to date」，其实什么都没拉，
> 部署上去的还是老代码）。先就地补一次（幂等），并**核对 HEAD 与本地一致**再往下走：
> ```bash
> cd /srv/ai-kids-platform/internal-test/source
> git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
> git fetch origin
> git branch --set-upstream-to=origin/feature/vibecoding-ppt-quality-20260915
> git log --oneline -1        # ← 与本地 HEAD 不一致就别继续
> ```

```bash
ssh -i ~/.ssh/ai_kids_platform_ecs_temp_ed25519 root@39.106.183.200
cd /srv/ai-kids-platform/internal-test/source        # 目录名沿用，内测服务已删
export PATH=/srv/ai-kids-platform/runtime/node/bin:$PATH
git pull --ff-only                                   # 先确认本地已 push
cd deploy/production
bash backup-production.sh                            # 先备份（整库）
bash build-production.sh                             # 产出 releases/<stamp>
cd /srv/ai-kids-platform/production
ln -sfn /srv/ai-kids-platform/production/releases/<stamp> current
systemctl restart learning-platform-production
# 核验：BUILD-METADATA 的 commit / is-active / NRestarts=0 / health / 三端入口 200
```

回滚 = 把 `current` 软链切回上一版 release 目录再重启。
⚠️ **2026-09-20 起 release 目录只保留最新 10 份**（此前没有任何清理策略，攒到 364 份 / 3.3G）——
  所以「所有历史 release 都保留」这句**已不成立**：可回滚窗口是最近 10 次发布，再往前要回滚得拿
  git 里那个 commit 重新构建。清理是**手工**做的、没有定时任务；口径见
  `docs/operations/开新会话先读-现状对齐-20260919.md` §三「2026-09-20 运维实查」，
  删除前的 release→commit 清单留档在 `production/logs/releases-archive-20260920.tsv`。
数据库回滚用 `backups/<stamp>/platform.db`（备份保留 **7 天**；2026-09-21 从 14 天收紧，见下）。

发布后要在**服务器上**做公网验收（本机出口封 HTTPS）：

```bash
for u in https://iicili.cyou/ https://iicili.cyou/admin/ https://iicili.cyou/org/ \
         https://iicili.cyou/student/ https://iicili.cyou/api/health; do
  printf "%s " "$u"; curl -s -o /dev/null -m 12 -w "%{http_code}\n" "$u"; done
```

### 长期 SSH 通道（用户已授权保留）

- 服务器 `39.106.183.200`，用户 `root`；本机私钥 `C:/Users/Administrator/.ssh/ai_kids_platform_ecs_temp_ed25519`
  （文件名保留历史 `temp` 字样，自 2026-09-04 起按用户授权长期保留）。
- 服务器 `authorized_keys` 里对应公钥注释：`codex-temporary-ai-kids-platform-20260904`，**不得删除**，除非负责人明确撤销。
- **严禁**在仓库、日志、聊天输出或文档里粘贴私钥内容、口令、token —— 只记路径与公钥注释。
- 安全组：SSH 只对当前出口 IP 放行 TCP 22，**不要**用 `0.0.0.0/0`；出口 IP 会变，不在文档里写死。
  SSH 超时先查本机网络，再让用户在云控制台改来源 IP。
  - 规则在 `sg-2zeizq00z60kv5xenlmg`（入方向）里，是那条描述为 `Codex temporary SSH` 的
    「自定义 TCP / SSH(22)」规则；**改它的「访问来源」**即可，别新增 0.0.0.0/0。
  - 该组里 `100.104.0.0/16 → SSH(22)` 是阿里云内网/云助手用的，**别动**。
  - 实测：2026-09-18 出口 IP 从 `120.235.9.178` 变成 `123.90.5.82` → SSH 直接超时，
    而 `ping` 通（网络层通、22 不通就是这个特征，别误判成服务器挂了）。
    两个来源核对出口 IP：`curl -s https://ifconfig.me` 与 `curl -s https://ipinfo.io/ip`。
- **发布自检用「HEAD 包含该提交」而不是「HEAD 完全等于该提交」**：
  文档提交会让 HEAD 前进一格，那是正常的（生产要的是**功能提交**在其中）；
  而「pull 静默空转、构建的是旧代码」照样挡得住 —— 那种情况下期望提交不会是 HEAD 的祖先。
  发布脚本见 `.tmp/deploy-002.sh`（用法：`bash deploy-002.sh <期望提交短 sha>`；
  它在拉到代码后、切软链前各有一次自检，任一不过就中止）。
- 复杂远程操作走「本地写脚本 → 转 LF → `scp` 上传 → `ssh bash /tmp/...`」，
  避开 Windows CRLF 与 PowerShell 转义（`node -e` 里写多行 SQL/JSX 必翻车）。
  ⚠️ 别用 `perl -pi -e` 在本地改这类脚本：替换串里的 `$VAR` 会被 perl 当变量吃掉，
  把脚本改成 `HEAD_COMMIT=197121git rev-parse ...` 这种**半截语法**（我干过）；要改就整份重写。

## 服务器上的系统级依赖（换机器 / 重装时必须补）

平台代码之外，服务器还依赖两个**系统包**，缺了不会报错、只会让功能静默失效：

```bash
# 教学素材在线预览：PPT/Word 要服务端转 PDF（2026-09-15 起）
export DEBIAN_FRONTEND=noninteractive
apt-get install -y libreoffice-impress libreoffice-writer fonts-noto-cjk
soffice --version          # 期望 LibreOffice 26.x
fc-list | grep -c cjk      # 期望 >0 —— 不装中文字体，转出来的 PDF 里中文是方块
```

- **`fonts-noto-cjk` 不能省**：只装 LibreOffice 也能转，但中文会渲染成方块，而且**不报错**。
- 上传目录（`FILE_UPLOAD_ROOT`）必须归服务账号 `ai-kids-prod` 所有。若运维以 root 在里面留下过
  目录，预览转换会因 `EACCES` 失败（对外表现为「这份课件暂时无法预览」，日志里有
  `[materialPreview] 转换失败`）。修法：`chown -R ai-kids-prod:ai-kids-prod <上传目录>`。

### 宿主特权代理（2026-09-16 起，**取代了 sudoers**）

平台要让宿主干三件要 root 的事（开环境 / 收环境 / 取产物）。**不能用 sudo**：
平台服务的单元里有 `NoNewPrivileges=true`，那个标志会让 sudo 直接拒绝提权
（实测原文：`sudo: The "no new privileges" flag is set, which prevents sudo from running as root`），
跟 sudoers 怎么写无关。所以宿主上跑一个 root 常驻的**特权代理**（socket 上按白名单执行那三个脚本）：

```bash
systemctl status dsh-host-broker --no-pager
ls -la /run/dsh-host-user/broker.sock     # 期望 srw-rw---- root ai-kids-prod
journalctl -u dsh-host-broker -n 30 --no-pager   # 每次操作一行（只记 op/身份，不记密钥）
# 平台侧开关：/etc/ai-kids-platform/production.env
#   DSH_RUNTIME_MODE=user
#   DSH_RUNTIME_TRANSPORT=broker     # 默认；设成 script 才回去直接跑脚本（容器版/本地守卫）
```
安装与安全边界见 `deploy/dsh-student/host-user/README.md`。旧的
`/etc/sudoers.d/dsh-students` 已撤（备份 `.removed-*`），要回滚就改回来并把 transport 设成 `script`。

### ⚠️ 文件安全扫描与内存（2026-09-16 实测，**这条是个已知风险**）

> **2026-09-23 更正**：生产上 `FILE_UPLOAD_SCANNER` 指的**不是** `/usr/bin/clamscan`，而是
> `/usr/local/bin/clamscan-limited` —— 一个只存在于服务器上的包装脚本（`ulimit -v` 限住峰值内存后
> exec clamscan）。下面的内存分析与缓解措施仍然成立，但**换机器时那个包装必须一起装**，
> 否则扫描器不可执行 → 生产 fail-closed → 上传一律被拒。它现在也进了仓库：
> `deploy/production/clamscan-limited`（迁移脚本 01 会安装它）。

生产配的是 `FILE_UPLOAD_SCANNER=/usr/bin/clamscan` —— 独立扫描器，**每次调用都重新加载
108MB 病毒库**：冷启动 16–40 秒、热缓存约 10 秒，进程 RSS 峰值可达 **618MB**。
这台机器只有 1607MB，两个学生环境就占约 940MB —— 一旦同时有学生在创作，
扫描会掉进 swap（实测从 9.7 秒退化到 59 秒），把所有文件上传拖成超时。

- 已经把超时从 30s 放宽到 **120s**（`FILE_UPLOAD_SCANNER_TIMEOUT_MS` 可调）——
  这只是让空闲时能用，**没有解决根因**；
- 根因方案（常驻 clamd / 异步扫描 / 只在发布时扫）**要定口径**，
  见 `docs/operations/新对话交接-dsh迁移-20260916-第四轮.md` 第四节；
- 排查这类问题先看这三个数：`free -m`（swap）、`ps -eo pid,rss,cmd | grep clams`（扫描进程多大）、
  `journalctl -u learning-platform-production | grep FILE_SCANNER`。

### 学生运行时网关的环境变量（2026-09-16 起）

`RUNTIME_GATEWAY_SECRET` 必须写进 `/etc/ai-kids-platform/production.env`（生成用 `openssl rand -base64 48`）。
它是「学生容器 → 平台网关」那把运行时密钥的 HMAC 密钥；**不配的话 `/api/gateway/v1/*` 一律拒绝服务**
（故意的 fail-closed：这个端点能让调用方花平台的算力钱，没密钥就不该开）。
换密钥 = 所有正在上课的容器立刻失效（它们手里的密钥验不过），所以挑没有课堂的时候换。
确认生效：不带密钥调一次应当得到 401/409，**不是** 500。

### 学生创作环境的端口（2026-09-16 起）

学生端 VibeCoding 用 dsh 之后，每个学生一个入口端口（`18201-18220`）。这一段要**两处**放行，
少一处就是从公网连不上：

```bash
# ① 阿里云控制台 → 安全组（入方向）：自定义 TCP、端口 18201/18220、来源 0.0.0.0/0
# ② 宿主主机防火墙（ufw 默认 deny incoming，只开了 22/80/443）
ufw allow 18201:18220/tcp comment "学生创作环境 dsh"
ufw status | head
```

**排查顺序**（2026-09-16 实际卡过一轮）：
1. 从公网 `nc -vz <公网IP> 18201` → 超时；
2. 在宿主 `ss -tln | grep 18201` 有监听；
3. 在宿主 `tcpdump -n -i any "tcp port 18201"` **抓得到 SYN** → 说明包到了主机、是**主机防火墙**丢的，
   不是安全组（安全组丢包时抓不到）。

学生端口平时没有监听（nginx 的 server 块开课时生成、下课时删），暴露窗口只在课堂期间；
每个端口后面有平台票据闸门，dsh 自己还有一层会话票据。

## 当前架构

- 域名：`https://iicili.cyou`
- 服务：`learning-platform-production`
- API：`127.0.0.1:8789`，仅回环；生产 env 必须设置 `API_HOST=127.0.0.1`
- 数据库：`/srv/ai-kids-platform/production/data/platform.db`
- 回滚路径：切换 `production/current` 软链到上一 release（`deploy/production/rollback-production.sh`）后重启服务；原内测服务 `learning-platform-internal-test` 已下线（2026-09-08 复核为 not-found），见 `docs/operations/交接说明.md`

## 启停与健康检查

```bash
sudo systemctl status learning-platform-production --no-pager
sudo systemctl restart learning-platform-production
curl -fsS http://127.0.0.1:8789/health
```

## 日志

```bash
sudo journalctl -u learning-platform-production -n 200 --no-pager
sudo journalctl -u learning-platform-production --since '30 min ago' --no-pager
tail -100 /srv/ai-kids-platform/production/logs/monitoring-health.log
```

## 备份与恢复

```bash
PATH=/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin:$PATH bash /srv/ai-kids-platform/internal-test/source/deploy/production/backup-production.sh
bash /srv/ai-kids-platform/internal-test/source/deploy/production/rollback-production.sh \
  --release /srv/ai-kids-platform/production/releases/<known-good>
```

## 每日备份与恢复演练

```bash
systemctl list-timers --all | grep ai-kids-platform-production-daily-backup
cat /srv/ai-kids-platform/production/state/last-backup-state.json
bash /srv/ai-kids-platform/production/bin/daily-backup.sh
bash /srv/ai-kids-platform/production/bin/restore-drill.sh
```

- 每日 03:00 Asia/Shanghai 自动备份，保留 **7 天**（2026-09-21 由 14 天收紧：每次发布都会整库备份，一份 ~21MB、忙时一天 ~30 份，14 天要 7.3G）；
  timer 为 `ai-kids-platform-production-daily-backup.timer`，留存天数由 `PRODUCTION_BACKUP_RETENTION_DAYS` 控制（脚本在 `production/bin/daily-backup.sh`，**不在 release 里、发布不会更新它**）。
- 备份必须通过 SHA256 与 SQLite `integrity_check`，状态写入 `production/state/last-backup-state.json`。
- 恢复演练只使用隔离目录与 `127.0.0.1:18789`，结束必须释放端口；不得覆盖生产库或停生产服务。
- 每月至少执行一次真实备份恢复演练，并把结果追加到 P9 运维记录。

## 最小告警

`ai-kids-platform-production-healthcheck.timer` 每分钟执行 `monitoring-healthcheck.sh`，检查：

1. API：`http://127.0.0.1:8789/health` 失败即 failed。
2. 磁盘：使用率 ≥80% 即 failed。
3. 证书：`/etc/letsencrypt/live/iicili.cyou/fullchain.pem` 14 天窗口失效即 failed。
4. 备份：最新成功备份超过 26 小时或状态非 ok 即 failed。

状态 JSON 写入 `production/state/last-alert-state.json`，人类可读日志写入 `production/logs/monitoring-health.log`。当前最小告警只保证失败可被 systemd 状态与 journal 检出；外部短信 / 飞书 / 邮件推送尚未接入，不得宣称 7x24 有人值守。

## 敏感路径只读复核

在具备生产公网访问的 Node 24 环境执行；该检查只发起 GET，不登录、不写库、不输出响应体：

```bash
cd /srv/ai-kids-platform/internal-test/source
node scripts/p9-live-security-smoke.mjs
```

`/server.js`、`/package.json`、`/apps/`、`/packages/`、`/node_modules/`、`/scripts/`、`/deploy/`、`/.env` 等必须返回 404；`/api/health` 必须返回 200，入口安全头必须存在。若任一路径返回 200，先不要标记 P9-D05 完成，按 Nginx 变更窗口处理并保留变更前配置备份。
## 发布记录（2026-09-08）

- 本次实际公网域名由 Nginx 指向 `/srv/ai-kids-platform/production/current`，不是 `internal-test/current`。
- 生产发布版本：`20260908T051403Z`。
- 对应提交：`b6020c1`。
- 发布前备份：`/srv/ai-kids-platform/production/backups/before-20260908T051403Z.db`。
- 本次修复了管理端机构充值入口、机构端配额/流水路由、官网学生积分接口，并移除生产构建脚本对已删除 `apps/student` 的依赖。
- 生产服务：`learning-platform-production`，API 回环端口 `8789`；健康检查已通过。
- 以后发布必须构建并切换 `production/releases/<stamp>`，不要只切换 `internal-test/releases`；切换后重启 `learning-platform-production`，再检查 `curl -fsS http://127.0.0.1:8789/health`。
- 服务器运行时 Node 路径为 `/srv/ai-kids-platform/runtime/node/bin/node`；源码构建可使用 `/opt/nodejs/node-v24.20.0-linux-x64/bin` 加入 `PATH`。
- 构建脚本的 `pnpm` 元数据仅供记录；若服务器 PATH 没有 pnpm，不能因此跳过构建产物和健康检查。

## 公网验收

在服务器 Node 24 环境执行：

```bash
cd /srv/ai-kids-platform/internal-test/source
node scripts/verify-production-entrypoints.mjs --mode public
```

验收必须包含四端页面、标题、登录文案、资源前缀、无 `X-Internal-Test`、非 noindex、无内测横幅、HTTPS 安全头和 `/api/health`。

## 收口生产 Nginx 敏感路径

P9-D05 当前唯一服务器侧遗留是源码 / 配置 / 依赖路径不能回退到 SPA `index.html`。授权运维人员在服务器仓库 checkout 更新后执行：

```bash
cd /srv/ai-kids-platform/internal-test/source
git pull --ff-only origin main
sudo bash deploy/production/apply-nginx-sensitive-path-hardening.sh
```

脚本只修改 `/etc/nginx/sites-enabled/iicili.cyou`，先创建带 UTC 时间戳的备份，再执行 `nginx -t`、reload 和公网 404 冒烟；任一步失败会尝试恢复本次备份。它不修改 release、数据库或 `internal-test` 回滚资产。成功输出 `NGINX_SENSITIVE_PATH_HARDENING_OK` 后，运行：

```bash
node scripts/p9-live-security-smoke.mjs
```

所有敏感路径均为 404 后，才可将 P9-D05 从 `[-]` 更新为 `[x]`。

## 回滚到内测（已失效，2026-09-08）

> ⚠️ 内测服务 `learning-platform-internal-test` 已删除（`systemctl` 报 not-found），下面这套回滚**不可再执行**，仅作历史记录。
> 现在回滚走 release 软链：`bash deploy/production/rollback-production.sh --release /srv/ai-kids-platform/production/releases/<known-good>`，
> 或直接切 `production/current` 软链后 `systemctl restart learning-platform-production`。
> 详见 `docs/operations/交接说明.md` 第六节。

生产切换失败且需要回到切换前版本时（历史做法）：

```bash
sudo cp /etc/nginx/backups/iicili.cyou.before-production-switch.<stamp> /etc/nginx/sites-enabled/iicili.cyou
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl stop learning-platform-production
sudo systemctl start learning-platform-internal-test   # 该单元已不存在
```

若 production 已产生写入，按切换前内测库快照处理数据回滚；原内测库不再覆盖生产库。

## 固定生产检测账号（2026-09-05）

生产环境已保留 4 个检测账号，其他账号已停用并软删除，历史审计与业务关联不物理删除：

| 端 | 登录名 | 角色 | 入口 |
|---|---|---|---|
| 平台端 | `root` | `SUPER_ADMIN` | `/admin/` |
| 机构端 | `org-admin` | `ORG_ADMIN` | `/org/` |
| 教师端 | `teacher-1` | `TEACHER` | `/org/` |
| 学生账号 | `student-1` | `STUDENT` | `/login` -> `/learn` |

密码保存在仓库外的本机受限 Markdown 文件：

```text
D:\学习平台\生产检测账号-20260905.md
```

禁止把密码写入仓库、服务器源码、日志或聊天记录。账号变更后，必须更新该本机文件并执行四角色登录与 `/api/me` 验证。

## 事故边界

- 不在日志、文档或对话中输出 `.env`、密码、token。
- 不宣传 `local-mock` 为真实 AI。
- 法律页为准备稿，不代表正式法务结论。
- 举报、申诉、内容审核、监护人功能暂缓。

## 生产真实业务闭环验收（2026-09-05）

已使用固定生产检测账号完成一次可回滚范围内的真实业务验收：

1. 教师创建临时班级；
2. 教师添加学生；
3. 教师为班级分配已授权课时；
4. 教师开启课堂；
5. 学生读取课堂与课程，创建并保存项目；
6. 学生提交作品；
7. 教师查看待批作品、审核并点评；
8. 学生读取审核结果与点评；
9. 教师结束课堂并归档临时班级。

- 结果：**24/24 项检查通过**。
- 验收后备份：`/srv/ai-kids-platform/production/backups/20260905T051314Z/platform.db`。
- 本次验收没有遗留进行中的课堂；已审核作品和项目作为历史验收数据保留，未直接删除生产关联记录。
- 该闭环再次确认：创建班级、加学生、配置课程、开课和课堂反馈均属于教师职责；机构管理员侧保留账号、机构和授权管理职责。

## 账号停用与清除补充

- 机构管理员可以先将教师 / 学生账号停用，再执行删除（软删除）；删除后账号不再出现在机构名册，历史业务关联和审计记录保留。
- 生产回归已验证“已停用账号直接删除”成功；无需先恢复为 ACTIVE。
- 远程备份脚本依赖 Node 运行时，执行前必须把 `/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin` 放入 `PATH`，避免出现 `node: not found`。

## 2026-09-05 生产修复发布记录

- 发布 commit：`04fd0773cf4ed60adf4cee372df6c3b999437808`。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T051622Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T045348Z` 保留可回滚。
- 切换前备份：`/srv/ai-kids-platform/production/backups/20260905T051639Z/platform.db`；账号回归后备份：`/srv/ai-kids-platform/production/backups/20260905T051738Z/platform.db`。
- 变更内容：允许机构管理员删除已经处于 `DISABLED` 状态的成员账号，避免“停用后无法清除”的状态机阻塞；仍为软删除，不物理删除历史数据。
- 发布后：服务 `active`，`/health` 返回 `status=ok`，四端公网入口 4/4 通过，敏感路径安全冒烟 14/14 通过。
- 生产回归：创建临时学生 → 停用 → 直接删除 → 名册不可见，全部通过；临时账号已清理。

## 2026-09-05 教师成员名册页面修复与发布记录

- 发布 commit：`27e71a4b092fadeb9ae50af3b2aa24e657fdc3ce`。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T053145Z`；切换前 release `/srv/ai-kids-platform/production/releases/20260905T051622Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T053201Z/platform.db`。
- 修复内容：教师访问“成员管理”时按 `role=STUDENT` 读取本机构学生名册；教师不获得创建账号、批量导入、停用、删除或机构成员写权限。
- 本地构建：四端 production build 通过；本地教师职责回归 **9/9** 通过。
- 页面级生产回归：机构管理员、教师、学生 **12/12** 通过；教师可查看学生名册但不显示账号创建 / 批量导入区。
- 发布后：服务 `active`，`/health` 正常；四端公网入口 **4/4** 通过；敏感路径安全冒烟 **14/14** 通过。

### 2026-09-05 页面级功能验收闭环

- [x] 机构管理员页面：创建临时学生账号、批量导入临时学生账号（预览 + 整批提交）、重置密码、停用账号，全部通过。
- [x] 教师页面：创建临时班级、加入 `student-1`、配置已授权课时、开始课堂、结束课堂并归档临时班级，全部通过。
- [x] 学生页面：从课堂课时创建项目、打开魔法画布、保存画布版本、回到项目列表并确认版权后提交作品，全部通过。
- [x] 清理收口：本轮 5 个临时账号已通过机构管理员接口软删除；临时验收班级已归档；没有遗留进行中的课堂。已提交作品和项目按状态机保留为历史验收数据，未直接删除生产关联记录。
- [x] 页面级验收时间：2026-09-05 13:49 CST；未修改生产源码、配置或固定检测账号密码。
- [x] 本轮页面功能检查：**12/12 通过**（账号创建、导入预览、导入提交、重置密码、停用、班级创建、加入学生、配置课程、开课、项目创建 / 画布保存、作品提交、结束并归档）。

## 2026-09-05 首页视频加载兜底修复发布记录

- 发布 commit：`1cae22d`（`fix(website): prevent homepage video loader from hanging`）。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T074802Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T070953Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T074822Z/platform.db`。
- 修复内容：首页外部视频加载失败、超时、加载中断或错过媒体事件时，加载遮罩最多 5 秒自动退出；视频不可用时保留首页色块、文案和交互，不再永久停留在 `LOADING SCROLL STREAM...`。
- 发布后：`learning-platform-production` active；`/health` 返回 `status=ok`；四端公网入口验证 **4/4** 通过。
- 首页生产验证：视频资源未及时就绪时两个加载遮罩均自动隐藏，首页不再被加载提示阻塞。

## 2026-09-05 首页首屏静态兜底与快速加载发布记录

- 发布 commit：`470f451`（`fix(website): render fast local homepage fallback`）。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T080206Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T074802Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T080223Z/platform.db`。
- 修复内容：首页首屏改为本地 CSS 静态视觉优先，React 尚未挂载时由 `index.html` boot shell 先显示；外部视频改为 `preload="metadata"` 的渐进增强层，视频未就绪、超时或失败时不遮挡页面、不阻塞文案和交互。
- 发布后：`learning-platform-production` active；`/health` 返回 `status=ok`；四端公网入口验证 **4/4** 通过；敏感路径安全冒烟 **14/14** 通过。
- 首页生产验证：两个 `.ic-video-fallback` 均存在，视频未就绪时首页仍显示导航、标题、按钮和课程卡片；不再依赖外部视频才能出现首屏。

## 2026-09-05 首页动物素材本地化发布记录

- 发布 commit：`4d94efe`（`fix(website): serve local hero animal media`）。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T081523Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T080206Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T081545Z/platform.db`。
- 修复内容：下载并托管首页动物视频到 `/assets/hero-animal.mp4`，同时生成 `/assets/hero-animal-poster.webp`；首页首屏先显示本地动物海报，视频作为本地增强层加载，不再依赖外部 `r2.motionsites.dev`。
- 素材优化：视频去除无用音轨并启用 fast-start，首屏海报约 38 KB，视频约 1.8 MB。
- 发布后：`learning-platform-production` active；`/health` 返回 `status=ok`；生产浏览器确认海报加载完成（1280px 宽），本地视频 `readyState=4`、时长 4 秒。

## 2026-09-05 首页重复兔子图层修复发布记录

- 发布 commit：`bb0cb1b`（`fix(website): hide hero poster after video readiness`）。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T082038Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T081523Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T082109Z/platform.db`。
- 问题原因：本地动物海报和正在播放的视频同时叠加，视频透明度为 72%，导致同一只兔子以两个不同姿势同时出现。
- 修复内容：视频进入 `ready` 状态后自动淡出海报层；视频未就绪或失败时才显示海报层，保证始终只有一个动物视觉层。
- 发布后生产浏览器确认：海报 `opacity=0`、视频 `readyState=4`、本地视频正常播放；生产服务 active，`/health` 正常。

## 2026-09-05 首页第二屏兔子恢复与动画流畅度修复发布记录

- 发布 commit：`bd86a5e`（`fix(website): restore rabbit on manifesto screen`）。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T082806Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T082038Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T082823Z/platform.db`。
- 问题原因：第二屏仍引用外部 `r2.motionsites.dev` 视频，加载失败时此前又移除了粉色 CSS 兜底，因此第二屏只剩背景和文案；首屏兔子卡顿则来自滚动驱动时持续修改 `video.currentTime`，浏览器频繁 seek。
- 修复内容：第二屏改为复用本地 `/assets/hero-animal.mp4` 与 `/assets/hero-animal-poster.webp`，保证兔子素材与首屏一致且不依赖外部域名；首屏改用浏览器原生 `autoplay + loop` 连续播放，停止滚动期间的逐帧 seek；第二屏不再渲染粉色圆形 CSS 兜底图。
- 发布后：生产 `/health` 返回 `status=ok`；四端公网入口验证 **4/4** 通过。

## 文件 / 媒体安全上传（P10）

上传目录必须位于 Web 根目录之外，并由服务账号单独持有：

```bash
sudo install -d -o ai-kids-platform -g ai-kids-platform -m 0750 /srv/ai-kids-platform/production/uploads
```

生产环境默认 `FILE_UPLOAD_REQUIRE_SCANNER=true`。正式开放上传前安装并确认 ClamAV：

```bash
sudo apt-get install clamav
sudo -u ai-kids-platform /usr/bin/clamscan --no-summary /srv/ai-kids-platform/production/current/package.json
```

在生产环境文件中设置 `FILE_UPLOAD_SCANNER=/usr/bin/clamscan` 后重启服务。未配置、不可执行、扫描失败或命中恶意文件时，API 会拒绝上传，不会把文件元数据写入数据库；若数据库写入失败，已落盘文件会清理。Nginx 的 `client_max_body_size` 应与服务端默认 25 MB 限制保持为 26 MB，禁止为 `/srv/ai-kids-platform/production/uploads` 增加静态目录映射。

上传限流与配额：FILE_UPLOAD_USER_PER_HOUR、FILE_UPLOAD_ORG_PER_HOUR、FILE_UPLOAD_MAX_CONCURRENT、FILE_UPLOAD_USER_QUOTA_BYTES、FILE_UPLOAD_ORG_QUOTA_BYTES 分别控制用户/机构小时频率、并发数和容量。生产环境应显式配置，修改后重启服务。


## 2026-09-05 生产环境五项收口记录

- 当前生产 release：/srv/ai-kids-platform/production/releases/20260905T092036Z。
- 当前发布 commit：4255b88cb789a483b5d9e6341d90cc278ea9be0。
- 发布前数据库备份：/srv/ai-kids-platform/production/backups/20260905T092032Z/platform.db。
- 在线 UAT：平台管理员、机构管理员、教师、学生账号登录均通过；平台管理员和机构管理员真实上传均返回 HTTP 200；教师上传入口隐藏；学生端登录与工作台通过。
- 上传安全：生产已安装 ClamAV，/usr/bin/clamscan 可由服务账号执行；安全上传返回 scanner PASSED；上传目录位于 Web 根目录之外并由服务账号持有。
- 文件管理：生产已启用文件列表、元数据、状态启停、审核状态、机构授权、删除/移除及受控下载接口；跨机构授权由服务端校验。
- 监控：learning-platform-production、i-kids-platform-healthcheck.timer、i-kids-platform-production-daily-backup.timer 均为 enabled；磁盘使用率 15%；公网 /api/health 正常。
- 公网入口与安全冒烟：四端入口 4/4 通过；敏感路径、HSTS、CSP、nosniff、frame/referrer 策略检查通过。
- 结论：本次生产环境运维 1—5 项已完成并收口；后续转入日常监控、备份校验和按需迭代。
## 2026-09-05 教师点评闭环与 AI 队列恢复发布记录

- 发布 commit：`f05823b`。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T102834Z`；切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T102834Z/platform.db`。
- 发布内容：教师任务提交、查看、评分、通过 / 驳回、重新提交闭环；教师与学生班级权限收紧；AI 异步任务增加数据库恢复、worker 租约、重试退避、超时回收和取消清理。
- 发布后验证：`learning-platform-production` active；内外 `/health` 均返回 `status=ok`；四端公网入口 `/`、`/admin/`、`/org/`、`/student/` 均返回 200；P9 敏感路径冒烟 **14/14**；生产 SQLite `PRAGMA integrity_check` 返回 `ok`。
- 本次仍使用 `AI_PROVIDER=local-mock`，不对外宣称已接入真实 AI 供应商。
- 备份恢复演练：`restore-drill=passed`，使用同一备份在隔离目录 `127.0.0.1:18789` 启动并通过健康检查，未触碰生产服务。


## 2026-09-05 生产发布门禁与 P10 收口

- 发布 commit：`eabb231`；release：`20260905T111322Z`。
- 发布前新增门禁：服务端 / 数据库 JavaScript 全量 `node --check`，关键路由 import smoke test；门禁失败不生成可发布制品。
- P10 隔离测试：文件上传安全 **9/9**，文件访问矩阵 **6/6**，四端构建通过。
- 发布前备份：`/srv/ai-kids-platform/production/backups/20260905T111358Z`，备份状态 `ok`，生产库完整性检查 `ok`。
- 发布后：四端入口 4/4、`/api/health` 200、安全响应头通过，服务 active/enabled，`NRestarts=0`。
- 本次未执行生产业务数据写入型 UAT；后续需在明确测试数据和回滚窗口后进行。

## 2026-09-05 19:36 生产稳定观察记录

- 检查时间：2026-09-05 19:36（Asia/Shanghai）。
- 当前 release：`/srv/ai-kids-platform/production/releases/20260905T111322Z`。
- `learning-platform-production`：`active`、`enabled`、`running`，`ExecMainStatus=0`，`NRestarts=0`。
- 本地 `/health` 与公网 `/api/health` 均返回成功；`/`、`/admin/`、`/org/`、`/student/` 均返回 HTTP 200。
- 敏感路径只读冒烟：全部通过，敏感路径均为 404，`/api/health` 为 200，安全响应头齐全。
- Nginx：active，`nginx -t` 通过；证书有效期至 2026-11-30 09:38:33 UTC。
- 监控：healthcheck timer active/enabled，最近一次执行成功；每日备份 timer active/enabled，最近一次备份服务退出码 0/SUCCESS。
- 备份状态：`ok`；磁盘使用率 15%；SQLite `PRAGMA integrity_check`：`ok`。
- 最近 60 分钟服务 journal 无 warning/emerg。Nginx 中发现的 405/401/400 为外部扫描或未登录请求，未发现 5xx。
- `verify-production-entrypoints.mjs --mode public` 未完成，原因是服务器缺少脚本所需的 `C:\Program Files\Google\Chrome\Application\chrome.exe`；这属于验收工具依赖缺失，不代表生产入口失败。已用 HTTP 状态和安全冒烟完成只读替代检查。
- 结论：本次只读稳定观察通过；当前无须重启、回滚或重新发布。

## 2026-09-05 P6-A01 供应商目录、预算与学生外发策略发布记录

- 发布 commit：`2770bbb`（供应商目录、平台 / 机构 AI 预算策略、学生内容外发策略）。
- 当前生产 release：`/srv/ai-kids-platform/production/releases/20260905T143653Z`；当前软链接：`/srv/ai-kids-platform/production/current`。
- 发布前备份：`/srv/ai-kids-platform/production/backups/20260905T143653Z`。
- 供应商目录：`local-mock`、`openai-compatible`、`aliyun-bailian`、`volcengine`、`zhipu`、`custom`；平台端可维护供应商 / 模型 / Endpoint / 平台单次与每日预算，机构端可维护本机构单次与每日预算。
- 学生创作内容外发策略：已由平台管理员开启；机构端只读查看当前状态。开启策略不等于已产生外部请求。
- 生产 AI 配置仍为 `AI_PROVIDER=local-mock`；真实 provider adapter 尚未接入，不能对外宣称已经接入真实 AI。未配置完整的真实 provider 时，生成请求明确失败，不回退为假成功。
- 真实 API key 仅允许配置在服务器受限环境文件 `/etc/ai-kids-platform/production.env` 的 `AI_PROVIDER_API_KEY` 中，不写入 Git、数据库、前端构建产物、日志或聊天记录。
- 回归验证：P6-A01 provider 契约 `8/8`、供应商目录与隔离 `13/13`、策略 E2E `23/23`；P4-O12 队列恢复、P4-O13 失败重试、P4-O15 任务取消均通过；四端 production build 通过；`git diff --check` 通过。
- 发布后只读状态：`learning-platform-production` 为 `active/running`、`enabled`，`NRestarts=0`；健康检查通过。此次文档更新不产生新的生产发布。
- 配置入口：平台端 `/admin/` → 平台管理 → 计费与用量 → AI 供应商与预算；机构端 `/org/` → 机构管理 → 账户与计费 → AI 预算。


## 2026-09-05 P6-A01 真实 provider adapter 代码接入记录

- 新增 `openai-compatible` 通用 Chat Completions 文本 adapter；`custom` 供应商复用该协议。当前首期支持 `TEXT`，其他模态必须等待对应 adapter，不会伪造生成结果。
- adapter 支持服务端 Bearer key、超时中止、429 / 5xx / 安全拒绝 / 无效响应映射；API key 仍只能来自 `/etc/ai-kids-platform/production.env`，请求参数不得传入密钥。
- 用户配置真实供应商后，必须同时填写平台端模型 / Endpoint 和服务器端 `AI_PROVIDER_API_KEY`，并将 `AI_PROVIDER` 切换为 `openai-compatible` 或 `custom`；仅填写网页配置不会自动产生真实请求。
- 本次代码接入尚未切换生产 provider，生产继续保持 `AI_PROVIDER=local-mock`；此次发布不产生外部 AI 费用。
- 隔离验证：`p6-a01-openai-compatible-adapter` `12/12`；P6-A01 目录 / 策略测试、P4-O12 / O13 / O15 与四端构建通过。

## 2026-09-05 P6-A01 真实 AI adapter 代码发布记录

- 发布 commit：`b8469b685d19c7f05606b3d5d2be91eecf6485a4`（短号 `b8469b6`）。
- 新生产 release：`/srv/ai-kids-platform/production/releases/20260905T155255Z`；`/srv/ai-kids-platform/production/current` 已切换至该 release。
- 发布前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T155255Z/platform.db`；本次没有重新 seed，也没有业务数据写入型发布测试。
- 发布后验证：本地 `/health` 与公网 `/api/health` 返回成功；四端 `/`、`/admin/`、`/org/`、`/student/` 均 HTTP 200；服务 `active/running`、`enabled`、`NRestarts=0`、`ExecMainStatus=0`。
- 当前生产环境仍为 `AI_PROVIDER=local-mock`。本次只是把真实 adapter 代码上线，未产生外部 AI 请求或费用；填写网页供应商配置后仍需在 `/etc/ai-kids-platform/production.env` 配置 API key，并显式切换 provider 后才会真实调用。
- 支持：`openai-compatible` 与 `custom` 的 OpenAI-compatible Chat Completions `TEXT`；`IMAGE`、`MUSIC`、`VIDEO`、`PODCAST`、`DUBBING` 仍返回不支持，不伪造成功。

## 2026-09-05 P6-A01 六类真实媒体 adapter 代码发布记录


- 本次发布的 `openai-compatible` / `custom` 真实 adapter 支持 `TEXT`、`IMAGE`、`MUSIC`、`VIDEO`、`PODCAST`、`DUBBING` 六类能力。
- `TEXT`、`IMAGE`、`DUBBING` 使用常见兼容路径；`MUSIC`、`VIDEO`、`PODCAST` 的接口没有统一标准，供应商实际路径必须通过服务器环境变量 `AI_PROVIDER_MODALITY_ENDPOINTS` 配置。未配置或供应商不提供对应接口时，调用明确失败，不回退 `local-mock`，不创建假资产。
- 真实配置位置：`/etc/ai-kids-platform/production.env`。填写 `AI_PROVIDER=openai-compatible` 或 `custom`、`AI_PROVIDER_MODEL`、`AI_PROVIDER_ENDPOINT`、`AI_PROVIDER_API_KEY`；必要时填写模态 endpoint map、`AI_PROVIDER_VOICE` 和轮询间隔，保存后重启服务。
- 验证：`p6-a01-openai-compatible-adapter` `23/23`；四端生产构建通过。当前生产仍保持 `AI_PROVIDER=local-mock`，本次代码发布不产生外部 AI 费用。

## 2026-09-06 计费口径更新

AI 不再使用平台预算或机构预算。机构充值后获得共享积分，AI 成功调用从机构积分账户原子扣减；余额为 0 时机构、教师、学生均不能生成。机构管理员可在成员管理中为教师和学生设置累计 AI 积分上限，留空表示不限。API Key 仍只能放服务器受限环境变量，不得填写网页。

## 2026-09-06 AI 渠道 401 修复发布

- Commit：`6ac323e`；release：`/srv/ai-kids-platform/production/releases/20260906T154630Z`。
- 备份：`/srv/ai-kids-platform/production/backups/20260906T154718Z`。
- 修复内容：AI 渠道测试 / 读取模型支持当前表单临时 Key；渠道 `apiKey` 不再写入普通策略 JSON，只保存到服务器受限密钥存储。
- 验证：服务 active，health 通过，Nginx 回环五个入口均 HTTP 200。

## 2026-09-06 课程 AI 创作开通记录

- 课程：`AI古诗词创意营`，已发布、`ALL_ORGS`，已授权测试机构。
- 课时能力：5 个已发布课时均已开启 `text`、`image`、`video`。
- 测试班：`三年级AI创作一班`；当前有效会话 `csession_9a324227086a4eb59c85` 的 `allow_video=1`。
- 生产变更前备份：`/srv/ai-kids-platform/production/backups/20260906T161959Z/platform.db`。
- 学生测试入口：访问 `https://iicili.cyou/login` 登录后进入 `https://iicili.cyou/learn`，选择“AI古诗词创意营” -> 课时 -> “进入课堂画布” -> “AI生成” -> “故事短片”。当前不再使用独立 `/student/` 学生后台。

## 2026-09-06 官网课堂画布 AI 生成入口发布记录

- 修复 Commit：`bc57de1`（`feat: expose ai generation panel in web classroom canvas`）。
- 修复内容：官网 `/learn/canvas` 共享课堂画布补充“AI生成”工具栏和“AI 素材工坊”，按当前课时能力显示画面素材、故事短片等类型；生成完成后自动加入未保存画布。
- 生产 release：`/srv/ai-kids-platform/production/releases/20260906T170059Z`。
- 发布前生产数据库备份：`/srv/ai-kids-platform/production/backups/20260906T170118Z`。
- 发布后验证：`learning-platform-production` 为 `active`；`127.0.0.1:8789/health` 返回 `status=ok`；当前 release 静态包已包含 `AI生成`、`AI 素材工坊`。
- 测试入口：`https://iicili.cyou/learn/canvas/`；若旧页面仍缓存，请执行 `Ctrl + F5` 后重新进入课堂画布。

### 预览类响应要允许同源内嵌（2026-09-16 修复，**两处都要改**）

课件预览与学生作品里的 PPT/PDF 都是**在我们自己的页面里用 iframe 打开的**，而站点级安全头是
`X-Frame-Options: DENY` + `frame-ancestors 'none'` → 浏览器直接拒收，教师看到的是
「iicili.cyou 拒绝了我们的连接请求」。（用户报的「教师素材在线预览全部失效」就是它。）

**应用侧**：`prepareFilePreview`（`apps/server/src/routes/fileAssets.js`）的响应里显式写
`x-frame-options: SAMEORIGIN` + `content-security-policy: frame-ancestors 'self'` ——
因为 `lib.js` 的 `securityHeaders()` 会给**所有**响应加 DENY，只改 nginx 不够。

**nginx 侧**：`/api/**/preview` 单独放行（见 `nginx.conf.example` 里那条正则 location）。
⚠️ 两条要点：① `add_header` 是**子层级覆盖父层级**，该 location 里 CSP 必须一起重写，
否则 `frame-ancestors 'none'` 仍然挡；② 正则 location 的优先级高于普通前缀（`location /api/` 不是 `^~`）。

已在生产上生效并实测：真实预览响应 `200` + `%PDF` + 只有 SAMEORIGIN；普通接口与首页仍是 DENY。
要再核对：`curl -s -o /dev/null -D - --resolve iicili.cyou:443:127.0.0.1 "<一个真实的预览地址>" | grep -i x-frame`

### 数据库结构迁移会在服务启动时自动跑

本轮起，`packages/database/src/schema.js` 里多了一次**重建表**迁移（课包 `visibility` 三值→两值）。
它是幂等的（DDL 里看不到旧值就跳过），但**发布顺序不能颠倒**：先备份、再切 release、再重启，
否则重启时迁移已经改了库而备份还是旧的（实际上备份在 build 之前做，顺序天然正确）。

迁移后核对：
```bash
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/srv/ai-kids-platform/production/data/platform.db');console.log(db.prepare('SELECT visibility, COUNT(*) n FROM course_series GROUP BY visibility').all())"
# 期望只有 PUBLIC / PRIVATE
```

### ⚠️ 新机（广州）的发布通道：**用 15 脚本，别用 git pull**（2026-09-24 实测）

RUNBOOK 上面那句"上服务器 `git pull --ff-only`"在新机上是**坏的**：服务器取不到 GitHub
（`git@github.com-peixunwangzhan` 这个别名只在本机 `~/.ssh/config` 里；服务器上 `git fetch` 报
`Could not resolve hostname`）。改成本机推：

```bash
bash deploy/production/migrate/15-push-from-dev-machine.sh          # 推 + 服务器快进合并
bash deploy/production/migrate/15-push-from-dev-machine.sh --build  # 再跑 04：构建 + 切 release + 重启 + 验收
```

要恢复"服务器自己拉"的老路，得在服务器上生成一把 deploy key 并把公钥加到 GitHub 仓库
（**这一步需要仓库管理员**：2026-09-24 本机 `gh` 未登录，做不了）。在那之前，15 脚本是唯一通道。

另有一条硬要求：**服务器源码树必须保持干净**（`git status --porcelain` 为空）。2026-09-24 之前它
长期带着未跟踪/被改过的文件，直接 pull/merge 会被挡住或静默盖过仓库版本；那次是把它们
`git stash -u` 之后才对齐的（备份见服务器 `/tmp/src-dirty-*.tar.gz`）。
