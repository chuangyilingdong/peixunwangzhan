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
bash /srv/ai-kids-platform/internal-test/source/deploy/production/backup-production.sh
bash /srv/ai-kids-platform/internal-test/source/deploy/production/rollback-production.sh \
  --release /srv/ai-kids-platform/production/releases/<known-good>
```

## 公网验收

在服务器 Node 24 环境执行：

```bash
cd /srv/ai-kids-platform/internal-test/source
node scripts/verify-production-entrypoints.mjs --mode public
```

验收必须包含四端页面、标题、登录文案、资源前缀、无 `X-Internal-Test`、非 noindex、无内测横幅、HTTPS 安全头和 `/api/health`。

## 回滚到内测

生产切换失败且需要回到切换前版本时：

```bash
sudo cp /etc/nginx/backups/iicili.cyou.before-production-switch.<stamp> /etc/nginx/sites-enabled/iicili.cyou
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl stop learning-platform-production
sudo systemctl start learning-platform-internal-test
```

若 production 已产生写入，按切换前内测库快照处理数据回滚；原内测库不再覆盖生产库。

## 事故边界

- 不在日志、文档或对话中输出 `.env`、密码、token。
- 不宣传 `local-mock` 为真实 AI。
- 法律页为准备稿，不代表正式法务结论。
- 举报、申诉、内容审核、监护人功能暂缓。
