# P9-D02 生产环境 24 小时观察记录

- 观察对象：`https://iicili.cyou` / `learning-platform-production`
- 生产 release：`20260904T122323Z`（commit `e98ba46`）
- 观察开始：2026-09-04 20:24:38 CST（生产服务当前 ActiveEnterTimestamp）
- 观察截止目标：2026-09-05 20:24:38 CST
- 记录人：Codex 运维会话
- 状态：`[-]` 已建立观察记录与自动探测；24 小时窗口尚未结束，不能宣称完成

## 边界

- 不修改 `packages/canvas`。
- AI 仍为 `AI_PROVIDER=local-mock`，不得宣传为真实 AI。
- 法律页仍是准备稿，不得宣称正式合规完成。
- internal-test 全部回滚资产保留，不删除。
- 本文件不记录任何密码、密钥或 `.env` 值。

## 采集项与当前基线（2026-09-04 20:44 CST）

| 采集项 | 当前结果 | 结论 |
|---|---:|---|
| systemd 状态 | active/enabled | 正常 |
| 自动重启次数 NRestarts | 0 | 正常 |
| API journal 错误关键词 | 0 | 正常 |
| API journal 警告关键词 | 0 | 正常 |
| API 监听 | 仅 `127.0.0.1:8789` | 正常 |
| Nginx 5xx | 0 | 正常 |
| Nginx 4xx | 0 | 正常 |
| 四端公网入口 | `/`、`/admin/`、`/org/`、`/student/` 均 200 | 正常 |
| `/api/health` | 200，`status=ok` | 正常 |
| 磁盘 | 10%（阈值 80%） | 正常 |
| 证书 | 14 天窗口内有效，certbot.timer active | 正常 |
| 最新备份 | `20260904T124238Z`，SHA256/integrity 通过 | 正常 |
| 恢复演练 | 2026-09-04 20:43 CST 通过，临时端口已释放 | 正常 |

## 2026-09-04 20:55 CST 安全加固记录

- 访问日志巡检发现公网扫描密集：`.env`、`.git/config`、`actuator`、WordPress 等探测路径曾因 SPA fallback 返回 200。
- 已加固 Nginx：常见敏感路径与扫描器目标返回 404；复测 `/.env`、`/.env.production`、`/.git/config`、`/.aws/credentials`、`/.ssh/id_rsa`、`/config.json`、`/wp-login.php`、`/phpmyadmin`、`/actuator` 等 16 项全部 404。
- 已移除 Nginx default 站点；直接 IP HTTP 访问不再返回默认欢迎页，而是 301 到 HTTPS。
- 已启用主机 ufw：默认 incoming deny，仅放行 22/80/443；SSH 与四端入口复测正常。
- CUPS snap 服务仍监听 `0.0.0.0:631`，但 631 已被 ufw 拦截。停用尝试被 snapd 正在进行的 `chromium` 安装全局锁阻塞，未强行 kill snapd；待 snapd 空闲后停用 `cups.cupsd` / `cups.cups-browsed`。
- TLS 证书当前有效期：2026-09-01 ～ 2026-11-30；certbot.timer active。
- 观察基线未受影响：production active，四端 200，`/api/health=ok`，安全头保持。
- 回滚资产：`/etc/nginx/backups/iicili.cyou.before-scanner-hardening.20260904T1255Z`、`/etc/nginx/backups/default.before-disable.20260904T1255Z`；internal-test 回滚资产未触碰。

## 24 小时结论

待 2026-09-05 20:24 CST 后补充。验收条件：

1. `systemctl is-active learning-platform-production` 持续 active，`NRestarts` 无非计划增长。
2. journal 无新增 P0/P1 错误；Nginx 无持续 5xx。
3. `ai-kids-platform-production-daily-backup.timer` 在 2026-09-05 03:00 CST 成功执行。
4. 四项最小告警检查保持 `status=ok`。
5. 观察期间任何变更均记录变更点与回滚资产。

## 复查命令（服务器）

```bash
systemctl is-active learning-platform-production
systemctl show learning-platform-production -p NRestarts -p ActiveEnterTimestamp --no-pager
journalctl -u learning-platform-production --since '24 hours ago' --no-pager | grep -Ei 'error|exception|unhandled|failed|fatal' || true
journalctl -u nginx --since '24 hours ago' --no-pager | grep -E ' 5[0-9]{2} ' || true
curl -fsS http://127.0.0.1:8789/health
cat /srv/ai-kids-platform/production/state/last-alert-state.json
cat /srv/ai-kids-platform/production/state/last-backup-state.json
```