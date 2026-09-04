# P9-D01 生产部署架构决策记录（ADR）

- 日期：2026-09-04
- 状态：草案，等待用户确认
- 当前线上：`iicili.cyou` 运行新平台内测 release `20260904T113559Z`
- 旧站状态：已按用户授权清除，无备份、无旧站回滚能力

## 1. 结论建议

采用**单 ECS + 双环境目录 + Nginx 单域名入口 + SQLite（WAL）+ 版本化 release 原子切换**的架构，先完成生产环境目录与治理，再视真实用户量评估是否迁移 PostgreSQL 或引入对象存储 / CDN。

## 2. 目标架构

### 2.1 计算与进程

- ECS：北京 `i-2zeiku41s3lrgopw134b`
- 进程管理：systemd
- 生产服务：`learning-platform-production.service`
- 运行用户：`ai-kids-prod`（独立于 `ai-kids-test`）
- API：仅监听 `127.0.0.1:8789`
- 预留回环端口：8788 继续归内测环境

### 2.2 目录布局

- production root：`/srv/ai-kids-platform/production/`
- release：`/srv/ai-kids-platform/production/releases/<timestamp>/`
- 原子切换：`production/current -> releases/<timestamp>`
- 数据：`/srv/ai-kids-platform/production/data/`
- 日志：`/srv/ai-kids-platform/production/logs/`
- 备份：`/srv/ai-kids-platform/production/backups/`
- 环境文件：`/etc/ai-kids-platform/production.env`

### 2.3 数据库

- 初期：SQLite WAL，独立生产库，每日 + 发布前备份。
- 迁移触发条件（满足其一）：并发写峰值 > 20/s、库 > 2GB、需要多实例、需要跨地域容灾。
- 迁移目标：PostgreSQL 16 + 每日基础备份 + PITR。

### 2.4 网络与入口

- 公网只开放 80 / 443，80 强制 301 HTTPS。
- 8788 / 8789 仅回环，不进安全组。
- Nginx：SPA 四端静态入口 + `/api/` 反代 8789。
- HTTPS 证书：Let's Encrypt 自动续期，续期后 reload。
- 安全头：`X-Robots-Tag`、内测阶段保留 `X-Internal-Test`；正式公开时移除 noindex 并补齐 HSTS、CSP、Referrer-Policy、Permissions-Policy。
- 正式公开前访问控制：Basic Auth / VPN / IP 白名单至少一项。

### 2.5 备份与恢复

- 生产 SQLite：发布前 + 每日 03:00 本机备份，保留 14 天。
- 每周归档到独立存储 / 异机；恢复演练每月一次。
- 备份必须记录 SHA256、大小、时间、release 对应关系。

### 2.6 CI/CD 与发布

- GitHub Actions 构建四端 + API 制品。
- 部署入口：手动批准 tag。
- 服务器接收制品，解包到新 release，健康检查通过后切换 `current`。
- 失败自动停止；上一 release 保留可回滚。
- 生产发布前必须通过 RBAC、列表、集成、E2E、入口回归。

## 3. 环境隔离

| 环境 | 服务 | 端口 | 数据库 | 域名 |
|---|---|---|---|---|
| 内测 | `learning-platform-internal-test` | 8788 | `/internal-test/data/platform.db` | `iicili.cyou` |
| 生产 | `learning-platform-production` | 8789 | `/production/data/platform.db` | 正式公开后确定 |

过渡期可使用 `iicili.cyou` 承载内测，生产域名待定；若共用域名，必须先完成 Nginx 灰度 / 路由隔离设计。

## 4. 容量与成本

- 当前磁盘 40G，已用约 3.6G，余量充足。
- 初期单实例足够；建议监控 CPU、内存、磁盘、API P95、SQLite 锁等待。
- 扩容路径：垂直升级 ECS → 对象存储 / CDN → PostgreSQL → 多实例。

## 5. 安全基线

- 服务非 root 运行，目录最小权限。
- `.env` 仅 root / 服务用户可读，不进 Git。
- systemd hardening：`NoNewPrivileges`、`ProtectSystem=strict`、`PrivateTmp`、限定 `ReadWritePaths`。
- 依赖漏洞扫描纳入 CI；失败发布阻断。
- 不伪造外部服务能力；真实 AI / OSS / 支付接入前保持边界声明。

## 6. 决策点

1. 是否接受“SQLite 起步，达到阈值后迁 PostgreSQL”？
2. 生产是否复用 `iicili.cyou`，还是新购正式域名 / 子域名？
3. 正式公开前访问控制选择：Basic Auth、VPN，还是 IP 白名单？
4. 是否批准建立 production 目录、系统用户、8789 服务与 Nginx 生产配置？

## 7. 验收清单

- [ ] 架构图与资产清单入库。
- [ ] production 用户、目录、端口、服务名确定。
- [ ] 数据库、备份、扩容、回滚策略确定。
- [ ] 访问控制与安全头策略确定。
- [ ] 联系人 / 值班 / 故障升级路径确定。
