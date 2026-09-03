# P9-I06 内测运行手册与日志

## 适用范围

本手册只适用于受控内部测试环境，不代表正式生产服务。当前环境必须显著显示“内部测试环境 · 不代表正式服务”，使用 Basic Auth / VPN / IP 白名单保护，不能接收真实外部用户，也不能使用真实线上数据库。

## 发布前检查

1. 从已推送 commit 构建，确认 `BUILD-METADATA.txt` 的 commit、Node.js 22.5+、pnpm 11 和 `mode=internal-test`。
2. 确认 `/srv/ai-kids-platform/internal-test/data/platform.db` 不存在或是隔离测试库；不得指向仓库 `packages/data/platform.db`。
3. 执行数据库初始化和 seed，确认五类测试账号均为测试账号。
4. 配置 Nginx Basic Auth / VPN / IP 白名单，检查 `nginx -t` 后再 reload。
5. 运行部署验收脚本和核心 UAT；任何 P0 权限、租户隔离、数据越权或真实外部服务伪接入问题均不得放行。

## 启停与健康检查

```bash
sudo systemctl start learning-platform-internal-test
sudo systemctl stop learning-platform-internal-test
sudo systemctl restart learning-platform-internal-test
curl -fsS http://127.0.0.1:8787/health
sudo systemctl status learning-platform-internal-test --no-pager
```

API 只监听 `127.0.0.1:8787`；外部访问必须经过 Nginx 访问控制。

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
