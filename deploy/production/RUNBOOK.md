# 生产环境运行手册

## 当前架构

- 域名：`https://iicili.cyou`
- 服务：`learning-platform-production`
- API：`127.0.0.1:8789`，仅回环；生产 env 必须设置 `API_HOST=127.0.0.1`
- 数据库：`/srv/ai-kids-platform/production/data/platform.db`
- 回滚路径：`learning-platform-internal-test`（8788，切换后停止并禁用，不删除）

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

- 每日 03:00 Asia/Shanghai 自动备份，保留 14 天；timer 为 `ai-kids-platform-production-daily-backup.timer`。
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

## 回滚到内测

生产切换失败且需要回到切换前版本时：

```bash
sudo cp /etc/nginx/backups/iicili.cyou.before-production-switch.<stamp> /etc/nginx/sites-enabled/iicili.cyou
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl stop learning-platform-production
sudo systemctl start learning-platform-internal-test
```

若 production 已产生写入，按切换前内测库快照处理数据回滚；原内测库不再覆盖生产库。

## 固定生产检测账号（2026-09-05）

生产环境已保留 4 个检测账号，其他账号已停用并软删除，历史审计与业务关联不物理删除：

| 端 | 登录名 | 角色 | 入口 |
|---|---|---|---|
| 平台端 | `root` | `SUPER_ADMIN` | `/admin/` |
| 机构端 | `org-admin` | `ORG_ADMIN` | `/org/` |
| 教师端 | `teacher-1` | `TEACHER` | `/org/` |
| 学生端 | `student-1` | `STUDENT` | `/student/` |

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
