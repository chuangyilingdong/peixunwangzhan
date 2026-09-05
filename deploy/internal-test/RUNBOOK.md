# P9-I06 内测运行手册与日志

## 适用范围

本手册只适用于受控内部测试环境，不代表正式生产服务。当前环境必须显著显示“内部测试环境 · 不代表正式服务”，保持 noindex、HTTPS、独立测试数据库和回滚能力；线上 Basic Auth 已按用户于 2026-09-04 的明确授权解除，因此不得扩大访问范围或接收真实外部用户，也不得使用真实线上数据库。正式公开前必须重新启用 Basic Auth / VPN / IP 白名单之一。

## 发布前检查

1. 从已推送 commit 构建，确认 `BUILD-METADATA.txt` 的 commit、Node.js 22.5+、pnpm 11 和 `mode=internal-test`。
2. 确认 `/srv/ai-kids-platform/internal-test/data/platform.db` 不存在或是隔离测试库；不得指向仓库 `packages/data/platform.db`。
3. 执行数据库初始化和 seed，确认五类测试账号均为测试账号。
4. 新部署默认配置 Nginx Basic Auth / VPN / IP 白名单之一，检查 `nginx -t` 后再 reload；当前线上例外为用户已明确授权解除 Basic Auth，仅用于内部测试。
5. 运行部署验收脚本和核心 UAT；任何 P0 权限、租户隔离、数据越权或真实外部服务伪接入问题均不得放行。

## 启停与健康检查

```bash
sudo systemctl start learning-platform-internal-test
sudo systemctl stop learning-platform-internal-test
sudo systemctl restart learning-platform-internal-test
curl -fsS http://127.0.0.1:8788/health
sudo systemctl status learning-platform-internal-test --no-pager
```

API 只监听 `127.0.0.1:8788`；外部访问必须经过 Nginx 访问控制。

## 日志与错误上报

```bash
sudo journalctl -u learning-platform-internal-test -n 200 --no-pager
sudo journalctl -u learning-platform-internal-test --since '30 min ago' --no-pager
sudo journalctl -u learning-platform-internal-test -f
sudo mkdir -p /srv/ai-kids-platform/internal-test/logs
sudo journalctl -u learning-platform-internal-test --since '24 hours ago' > /srv/ai-kids-platform/internal-test/logs/api-$(date -u +%Y%m%dT%H%M%SZ).log
```

错误记录至少包含：发生时间（含时区）、页面 / API、测试账号角色、复现步骤、期望与实际结果、浏览器控制台 / API 响应、release commit、是否涉及真实数据。不得在日志或工单中粘贴密码、Cookie、token、真实儿童信息或真实线上数据。

## 备份、发布与回滚

```bash
bash deploy/internal-test/backup-internal-test.sh
bash deploy/internal-test/rollback-internal-test.sh --release /srv/ai-kids-platform/internal-test/releases/<timestamp> --db-backup /srv/ai-kids-platform/internal-test/backups/<timestamp>/platform.db
```

备份包含测试数据库、当前静态 release、配置快照、日志快照和 `MANIFEST.json`。切换 release 前保留旧 `current`，健康检查失败自动切回；数据库恢复前先停止服务。每次演练记录 RPO、RTO、commit、执行人、结果和备份路径。

## 联系与放行闸门

- 内测负责人：由项目负责人指定（当前不写入个人联系方式）。
- 发布窗口：仅在内部测试人员可在线配合时执行。
- 放行条件：部署验收、核心角色 UAT、权限 / 租户隔离检查全部通过；P0 缺陷为 0，或有书面豁免。
- 本阶段不承诺公开 SLA，不做正式域名、备案、品牌邮箱、真实 AI / 支付 / 微信 / 短信 / 邮件 / OSS / 客户端承诺。

## 快速发布 SSH 通道（用户已授权长期保留）

- 服务器：`39.106.183.200`，SSH 用户：`root`，用于维护隔离内测目录 `/srv/ai-kids-platform/internal-test/`。
- 本机私钥路径：`C:/Users/Administrator/.ssh/ai_kids_platform_ecs_temp_ed25519`；文件名保留历史 `temp` 字样，但自 2026-09-04 起按用户授权长期保留使用。
- 服务器 `authorized_keys` 对应公钥注释：`codex-temporary-ai-kids-platform-20260904`；不得删除该公钥，除非项目负责人明确要求撤销通道。
- 严禁在本仓库、日志、聊天输出或文档中粘贴私钥内容、口令、token；文档只记录私钥路径和公钥注释。
- 安全组要求：SSH 仅对当前办公 / 家庭出口 IP 放行 TCP `22`，不使用 `0.0.0.0/0`；公网出口 IP 会变化，不在本文写死。
- 若 SSH 超时：先确认本机网络，再由用户在云控制台把安全组来源 IP 更新为当前出口 IP；不得要求放宽为全网开放。

常用连接：

```powershell
$key = 'C:/Users/Administrator/.ssh/ai_kids_platform_ecs_temp_ed25519'
ssh -i $key -o IdentitiesOnly=yes -o ServerAliveInterval=30 root@39.106.183.200
```

快速发布入口（先确认最新 commit 已推送）：

```powershell
$key = 'C:/Users/Administrator/.ssh/ai_kids_platform_ecs_temp_ed25519'
ssh -i $key -o IdentitiesOnly=yes root@39.106.183.200 "cd /srv/ai-kids-platform/internal-test/source && git fetch origin main && git reset --hard origin/main && git clean -fd && PATH=/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin:`$PATH bash deploy/internal-test/build-internal-test.sh"
ssh -i $key -o IdentitiesOnly=yes root@39.106.183.200 "cd /srv/ai-kids-platform/internal-test/source && bash deploy/internal-test/backup-internal-test.sh"
ssh -i $key -o IdentitiesOnly=yes root@39.106.183.200 "cd /srv/ai-kids-platform/internal-test/source && bash deploy/internal-test/rollback-internal-test.sh --release /srv/ai-kids-platform/internal-test/releases/<timestamp>"
```

- `git clean -fd` 仅允许在服务器隔离 source 工作区执行；发布前必须确认不会删除未推送的本地修改。
- 快速通道只降低登录成本，不降低发布闸门：仍需确认 commit、构建元数据、隔离数据库备份、健康检查、入口回归和日志无新增 P0/P1 错误。
- 复杂远程操作继续采用“本地写 shell 脚本 → 转 LF → `scp` 上传 → `ssh bash /tmp/...`”，避免 Windows CRLF 与 PowerShell 转义问题。

## 生产发布流程（使用同一长期 SSH 通道）

生产发布前先确认本地最新 commit 已推送到 `origin/main`，再在服务器执行以下受控流程。不得直接覆盖生产数据库；切换前必须保留当前 release 和数据库备份。

```powershell
$key = 'C:/Users/Administrator/.ssh/ai_kids_platform_ecs_temp_ed25519'
$host = 'root@39.106.183.200'
ssh -i $key -o IdentitiesOnly=yes $host "cd /srv/ai-kids-platform/internal-test/source && git fetch origin main && git reset --hard origin/main && git clean -fd && PATH=/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin:`$PATH VITE_DEPLOYMENT_MODE=public bash deploy/production/build-production.sh"
ssh -i $key -o IdentitiesOnly=yes $host "cd /srv/ai-kids-platform/internal-test/source && bash deploy/production/backup-production.sh"
ssh -i $key -o IdentitiesOnly=yes $host "cd /srv/ai-kids-platform/internal-test/source && bash deploy/production/rollback-production.sh --release /srv/ai-kids-platform/production/releases/<new-release>"
ssh -i $key -o IdentitiesOnly=yes $host "systemctl is-active learning-platform-production; curl -fsS --retry 10 --retry-delay 2 --retry-connrefused --max-time 10 http://127.0.0.1:8789/health"
```

生产发布完成后，在本机执行公网验收：

```powershell
$env:CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
& 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/verify-production-entrypoints.mjs --mode public
```

同时执行服务器安全冒烟：

```powershell
ssh -i $key -o IdentitiesOnly=yes $host "cd /srv/ai-kids-platform/internal-test/source && PATH=/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin:`$PATH node scripts/p9-live-security-smoke.mjs"
```

发布记录至少保存：release 时间戳、commit、生产数据库备份路径、健康检查、四端入口验收、回滚 release。当前生产固定检测账号密码见仓库外文件 `D:\学习平台\生产检测账号-20260905.md`，不得写入本仓库。

## 2026-09-04 内测发布记录：20260904T113559Z

- 发布来源：已推送 commit `aad396d0dd9ee63b56dc01bbb4c7518e7a228b41`（含低余额字段修复 `6849e49` 与服务优雅退出修复）。
- 发布产物：`/srv/ai-kids-platform/internal-test/releases/20260904T113559Z`；`BUILD-METADATA.txt` 显示 Node `v24.19.0`、pnpm `11.19.0`、`mode=internal-test`。
- 发布前备份：`/srv/ai-kids-platform/internal-test/backups/20260904T113647Z/platform.db` 与完整 `MANIFEST.json`；旧 release 为 `20260904T035620Z`。
- 切换与健康：使用 `rollback-internal-test.sh` 原子切换 `current`，服务 active，`127.0.0.1:8788/health` 返回 `status=ok`；Nginx `nginx -t` 通过。
- 入口回归：`scripts/verify-production-entrypoints.mjs` 4/4 通过，官网、`/admin/`、`/org/`、`/student/` 均加载各自产物，`noindex` 与内测标识通过。
- 角色回归：`root / admin123` 返回 `SUPER_ADMIN`，`org-admin / org123` 返回 `ORG_ADMIN`，`student-2 / study123` 返回 `STUDENT`，登录与 `/api/me` 均 HTTP 200。
- 低余额修复：临时 SQLite 验证命中余额 0 机构且通知 1 名管理员；发布后自新进程启动以来日志未再出现 `no such column: ba.balance`。
- 优雅退出：在真实 release 布局下发送 SIGTERM，进程 9ms 内以退出码 0 退出；systemd 重启后 246ms 恢复健康。已为服务器 unit 应用 `TimeoutStopSec=15s` 并同步模板。
- 发布事故与处置：首次切换 `20260904T112644Z` 时旧进程因历史 SIGTERM 处理缺陷等待 90 秒被 SIGKILL，切换脚本健康检查只尝试一次导致误判并自动回滚旧 release；随后修复服务入口优雅退出、发布脚本健康检查重试与 systemd 停止超时，重新构建发布后成功。
- 快速发布 SSH 通道按用户 2026-09-04 授权长期保留；仅记录私钥路径与公钥注释，不得输出私钥内容。
