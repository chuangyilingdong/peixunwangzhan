# P9-D01 生产部署架构决策记录（ADR）

- 日期：2026-09-04
- 状态：已实施并验证（2026-09-04）
- 用户决策：`iicili.cyou` 就是生产域名，直接复用，不使用子域名，不做内测 / 生产域名隔离；按本 ADR 全部执行
- 切换时间：2026-09-04 20:25 CST\n- 当前生产：release `20260904T122323Z`，commit `e98ba46`，`mode=public`\n- 当前线上：`iicili.cyou` 由 `learning-platform-production`（8789，仅回环）承载
- 旧站状态：已按用户授权清除，无备份、无旧站回滚能力

## 1. 结论

采用**单 ECS + 双环境目录 + Nginx 单域名入口 + SQLite（WAL）+ 版本化 release 原子切换**的架构。当前内测数据继承为生产数据；生产写入开始后，内测库保持只读保留作为切换前快照与代码回滚路径。达到阈值后再评估迁移 PostgreSQL 或引入对象存储 / CDN。

## 2. 目标架构

### 2.1 计算与进程

- ECS：北京 `i-2zeiku41s3lrgopw134b`
- 进程管理：systemd
- 生产服务：`learning-platform-production.service`
- 运行用户：`ai-kids-prod`（独立于 `ai-kids-test`）
- API：仅监听 `127.0.0.1:8789`，生产 env 必须显式设置 `API_HOST=127.0.0.1`
- 内测回滚服务：`learning-platform-internal-test`，8788，切换成功后停止并禁用，但不删除 release、数据库、unit 与配置

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
- 切换策略：先备份并停止内测服务，再将内测库复制为生产库；原内测库保留，不重新 seed。

### 2.4 网络与入口

- 生产域名：`https://iicili.cyou`
- 公网只开放 80 / 443，80 强制 301 HTTPS。
- 8788 / 8789 仅回环，不进安全组。
- Nginx：SPA 四端静态入口 + `/api/` 反代 8789。
- HTTPS 证书：Let's Encrypt 自动续期，续期后 reload。
- public 模式：不输出 `X-Internal-Test`，不输出 noindex；保留 HSTS、CSP、`X-Content-Type-Options`、`X-Frame-Options`、Referrer-Policy、Permissions-Policy。
- 用户已授权直接公开；公开前必须先重置或禁用内测种子账号，公开后如需临时收口可再启用 IP 白名单 / Basic Auth。

### 2.5 备份与恢复

- 生产 SQLite：发布前 + 每日 03:00 本机备份，保留 14 天。
- 每周归档到独立存储 / 异机；恢复演练每月一次。
- 处置：备份必须记录 SHA256、大小、时间、release 对应关系。
- 边界：旧站无备份、不可恢复；切换前内测库备份是生产继承数据的唯一快照。

### 2.6 CI/CD 与发布

- 当前阶段：服务器源码工作区执行生产构建脚本，产出 `/srv/ai-kids-platform/production/releases/<timestamp>`。
- 部署入口：手动批准后执行。
- 切换闸门：健康检查通过后切换 `current`；失败自动停止；上一 release 保留可回滚。
- 生产发布前必须通过 RBAC、列表、集成、E2E、入口回归。
- GitHub Actions / 异机构建可后续演进，不阻塞本次生产切换。

## 3. 环境隔离

| 环境 | 服务 | 端口 | 数据库 | 域名 |
|---|---|---|---|---|
| 内测回滚路径 | `learning-platform-internal-test` | 8788 | `/internal-test/data/platform.db`（切换后只读保留） | 切换完成后不再承载 `iicili.cyou` |
| 生产 | `learning-platform-production` | 8789 | `/production/data/platform.db` | `https://iicili.cyou` |

过渡期结束后，`iicili.cyou` 的 Nginx enabled 配置指向 production current；internal-test 保留代码回滚路径，不与生产共写数据库。

## 4. 容量与成本

- 当前磁盘 40G，已用约 3.6G，余量充足。
- 初期单实例足够；建议监控 CPU、内存、磁盘、API P95、SQLite 锁等待。
- 扩容路径：垂直升级 ECS → 对象存储 / CDN → PostgreSQL → 多实例。

## 5. 安全基线

- 服务非 root 运行，目录最小权限。
- `.env` 仅 root / 服务用户可读，不进 Git；继承 `AUTH_PEPPER` 时不得输出内容。
- systemd hardening：`NoNewPrivileges`、`ProtectSystem=strict`、`PrivateTmp`、限定 `ReadWritePaths`。
- 依赖漏洞扫描纳入 CI；失败发布阻断。
- 不伪造外部服务能力；真实 AI / OSS / 支付接入前保持边界声明，生产仍为 `AI_PROVIDER=local-mock`。
- 公开前必须处理全部种子默认账号：`root/admin123`、`org-admin/org123`、`teacher-1/teach123`、`teacher-2/teach123`、`student-1/study123`、`student-2/study123`。

## 6. 已确认决策

1. 接受 SQLite 起步，达到阈值后迁 PostgreSQL。
2. 生产直接复用 `iicili.cyou`，不新购域名，不使用子域名。
3. 用户授权本轮直接 public 暴露；默认账号必须先重置或禁用。
4. 批准建立 production 目录、系统用户、8789 服务与 Nginx 生产配置。
5. 内测数据继承为生产数据，不重新 seed；原内测库保留作切换前快照。
6. 旧站备份不需要，已直接清除且不可恢复。

## 7. 验收清单

- [x] 架构图与资产清单入库。
- [x] production 用户、目录、端口、服务名确定。
- [x] 数据库、备份、扩容、回滚策略确定。
- [x] 访问控制与安全头策略确定。
- [x] 生产每日备份自动排程：`ai-kids-platform-production-daily-backup.timer`，03:00 Asia/Shanghai，保留 14 天；首次备份与恢复演练已于 2026-09-04 通过。
- [x] 生产默认账号处置：真实负责人账号 `owner` 已创建并验证；全部种子账号已 `DISABLED` 且会话作废。
- [x] 最小告警工程基线：API、磁盘 80%、证书 14 天、备份 26 小时；外部通知渠道未接入。
- [x] 当前范围确认：外部通知渠道、值班联系人和外部升级电话不属于线下机构平台当前范围；由平台负责人 / 授权运维人员按内部 SOP 处理。

## 8. 已知公开风险

- 法律页仍是准备稿，不得宣称正式法务文本。
- 举报、申诉、内容审核、监护人功能继续暂缓。
- AI 仍为 `local-mock`，不得宣传为真实 AI。
- 真实支付、短信、邮件、OSS、微信能力未接入。

## 9. 实施验证记录（2026-09-04）

- production release：`20260904T122323Z`，commit `e98ba46`，Node `v24.19.0`，pnpm `11.19.0`，`mode=public`。
- 数据：切换前备份 `/srv/ai-kids-platform/internal-test/backups/20260904T122349Z/platform.db`；内测库复制为生产库，原库保留。
- 账号：全部 6 个种子账号重置为随机强密码，旧会话作废；新密码登录通过，旧密码 401。
- 服务：`learning-platform-production` active/enabled，API 仅监听 `127.0.0.1:8789`，`/health=ok`，journal 错误 0。
- 入口：Nginx production 配置启用，切换前配置已备份；四端 Playwright 回归 4/4，public 模式与 HTTPS 安全头通过。
- 回滚资产：internal-test 服务停止并禁用，release、数据库、unit、Nginx 配置均保留；Nginx 切换前配置备份存在。
- 监控：`ai-kids-platform-production-healthcheck.timer` active，每分钟记录健康与磁盘。
## 10. P9-D02 运维补强记录（2026-09-04）

- 备份：首次生产备份 `/srv/ai-kids-platform/production/backups/20260904T124238Z`，SHA256 校验与 SQLite `integrity_check=ok` 通过；包含数据库快照、release 与有限日志快照。
- 保留：每日 03:00 Asia/Shanghai，保留 14 天；`Persistent=true`。
- 恢复演练：隔离实例 `127.0.0.1:18789` 健康检查通过，active_users=6，演练后端口释放；未覆盖生产数据库。
- 账号：`owner` 真实负责人 `SUPER_ADMIN` 创建并验证；6 个种子账号 `DISABLED`，全部会话作废。密码仅保存在服务器 0600 凭据文件，未进入 Git / 文档 / 日志。
- 告警：API 失败、磁盘 ≥80%、证书 14 天、备份超 26 小时；正常与故障注入验证通过。外部通知渠道未接入。
## 11. P9-D02 安全暴露面加固（2026-09-04）

- Nginx：已移除 default 站点；备份保留于 `/etc/nginx/backups/`。2026-09-05 服务器侧已安装源码 / 配置 / 依赖路径显式 404 规则，`nginx -t`、reload 与 `scripts/p9-live-security-smoke.mjs` 通过；14/14 检查通过，`/server.js`、`/package.json`、`/apps/` 等敏感路径均为 404，`/api/health` 为 200，HTTPS 安全头齐全。
- 主机防火墙：ufw active，默认 incoming deny，仅放行 22/80/443。
- 遗留：CUPS snap 仍监听 631 但已被防火墙拦截；snapd 全局安装锁释放后应停用 `cups.cupsd` 与 `cups.cups-browsed`。

## 12. P9-D02/P9-D05 服务器复核记录（2026-09-05）

- 生产源码 checkout 已快进到 `f9dd7b7`；未修改 production release、生产数据库或 internal-test 回滚资产。
- 生产每日备份 timer 已于 2026-09-05 03:00 CST 成功执行，最新备份目录为 `20260904T190027Z`，状态为 `ok`，保留策略 14 天。
- 2026-09-05 12:02 CST 恢复演练通过：使用最新备份在隔离目录拉起 `127.0.0.1:18789`，健康检查通过，`active_users=7`，演练结束后端口释放，生产服务未中断。
- 账号只读盘点通过：`owner` 为唯一 `SUPER_ADMIN/ACTIVE`；6 个种子账号均为 `DISABLED`，活跃会话均为 0。未读取或输出密码、密钥和环境变量值。
- 最小告警复核通过：API、磁盘 14%、证书剩余 86 天、备份新鲜度均为 `ok`；生产服务 `active/enabled`、`NRestarts=0`，观察窗口内未发现 API 错误或 Nginx 5xx。
- P9-D05 服务器侧收口：创建 Nginx 变更前备份 `/etc/nginx/backups/iicili.cyou.before-sensitive-path-hardening.20260905T040434Z`；完整公网安全冒烟 14/14 通过。


## 13. 线下机构平台范围确认（2026-09-05）

- 平台不是面向公众的开放注册 / 交易网站，生产入口服务线下机构的受控教学交付。
- 账号生命周期：平台负责人创建机构及机构管理员；机构管理员创建或导入教师、学生，并维护班级、课程授权、席位和账号状态。
- 外部短信、邮件、飞书告警、值班电话和外部升级联系人不作为当前验收项；systemd timer、journal、备份状态和站内通知满足当前内部运维需求。
- 正式法律页、公开合规宣传和真实 AI / 支付 / 消息供应商接入不作为当前线下交付前置项；保留既有边界声明，不将 `local-mock` 宣传为真实 AI。
