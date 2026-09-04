# AI 少儿编程平台｜生产部署基线

## 范围

`iicili.cyou` 是唯一生产域名。本目录提供生产构建、备份、回滚、监控模板；不包含任何真实密钥，禁止提交 `.env` 或私钥。

## 目录与服务

- 发布目录：`/srv/ai-kids-platform/production/releases/<UTC-时间戳>`
- 当前版本软链接：`/srv/ai-kids-platform/production/current`
- 生产数据库：`/srv/ai-kids-platform/production/data/platform.db`
- 环境变量：`/etc/ai-kids-platform/production.env`
- API 服务：systemd `learning-platform-production`，仅监听 `127.0.0.1:8789`
- 运行用户：`ai-kids-prod`
- 前端：Nginx 在 `https://iicili.cyou` 下按 `/`、`/admin/`、`/org/`、`/student/` 提供四端

## 构建与切换

```bash
cd /srv/ai-kids-platform/internal-test/source
bash deploy/production/build-production.sh
ln -sfn /srv/ai-kids-platform/production/releases/<timestamp> /srv/ai-kids-platform/production/current
```

构建元信息必须为 `mode=public`。首次启动前必须先完成数据库继承与默认账号重置。

## 备份

```bash
bash deploy/production/backup-production.sh
```

备份包含 SQLite 快照、release、配置副本、日志副本和 `MANIFEST.json`（含 SHA256）。

## 回滚 / release 切换

```bash
bash deploy/production/rollback-production.sh \
  --release /srv/ai-kids-platform/production/releases/<known-good> \
  --db-backup /srv/ai-kids-platform/production/backups/<stamp>/platform.db
```

脚本校验 release 必须位于生产 releases 目录；健康检查使用 `127.0.0.1:8789`。

## 监控

每分钟探测 `/health` 与磁盘，输出到 `/srv/ai-kids-platform/production/logs/monitoring-health.log`，logrotate 保留 30 天。

## 必守边界

- API 只监听回环地址，不得在安全组放行 8789。
- `.env`、私钥、真实密钥不得进入 Git。
- 生产仍使用 `AI_PROVIDER=local-mock`，不得宣传为真实 AI。
- 法律页仍是准备稿；举报、申诉、内容审核、监护人功能继续暂缓。
- 旧站无备份、不可恢复；内测库在切换前必须先备份。
