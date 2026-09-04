# P9-R06 运营与技术交接包（生产版）

- 版本：v0.1
- 编制日期：2026-09-04
- 适用环境：生产 `https://iicili.cyou`
- 当前性质：生产已切换；本交接包为技术与运营初稿，24 小时观察、首次自动备份复核和外部通知渠道仍未收口。

> **边界声明**：生产 `AI_PROVIDER=local-mock`，仅为本地演示占位，不是真实 AI 服务；法律页为准备稿，不代表正式合规完成；真实支付、OSS、短信、邮件、微信通道均未接入。本文不包含任何密码、密钥、Token 或 `.env` 内容。

## 1. 生产资产与运行基线

| 项目 | 当前值 |
|---|---|
| 公网入口 | `https://iicili.cyou` |
| ECS | `39.106.183.200` |
| systemd 服务 | `learning-platform-production`（active / enabled） |
| API 监听 | `127.0.0.1:8789`（不直接公网暴露） |
| 当前 release | `20260904T122323Z` |
| 数据目录 | `/srv/ai-kids-platform/production/data/` |
| 备份目录 | `/srv/ai-kids-platform/production/backups/` |
| 备份 timer | `ai-kids-platform-production-daily-backup.timer`，每日 03:00（Asia/Shanghai），保留 14 天 |
| 健康检查 timer | `ai-kids-platform-production-healthcheck.timer`，每分钟 |
| 回滚资产 | `internal-test` 服务、release、数据库、systemd unit、Nginx 变更前备份均保留；禁止删除 |

## 2. 账号与权限台账（不含凭据）

| 账号类别 | 账号 | 状态 | 用途 / 处置 |
|---|---|---|---|
| 真实负责人 | `owner` | ACTIVE | `SUPER_ADMIN`；真实负责人日常管理账号 |
| 历史种子 | `root` | DISABLED | 不得重新启用作日常账号 |
| 历史种子 | `org-admin` | DISABLED | 不得重新启用作日常账号 |
| 历史种子 | `teacher-1` / `teacher-2` | DISABLED | 仅保留历史数据关联，不作登录账号 |
| 历史种子 | `student-1` / `student-2` | DISABLED | 仅保留历史数据关联，不作登录账号 |
| 服务器运维 | 受控 SSH / systemd 权限 | 受控 | 凭据由服务器安全文件或受控密钥管理，不写入仓库 |

账号变更要求：先建立实名接管账号，再禁用旧账号；改密 / 禁用后确认会话失效；严禁把凭据复制到工单、日志、聊天或前端。

## 3. 日常巡检 SOP

### 3.1 应用与入口

```bash
sudo systemctl is-active learning-platform-production
sudo systemctl is-enabled learning-platform-production
curl -fsS http://127.0.0.1:8789/health
curl -fsSI https://iicili.cyou/
```

只记录状态、HTTP 状态码和时间，不记录响应中的凭据或环境变量。

### 3.2 日志与磁盘

```bash
sudo journalctl -u learning-platform-production --since '1 hour ago' --no-pager
sudo df -h /srv/ai-kids-platform
sudo ss -lntp | grep -E ':(80|443|8789)'
```

告警阈值：API 失败、磁盘使用率 `>=80%`、证书剩余 `<=14` 天、备份超过 26 小时或最近一次失败。

### 3.3 备份检查

```bash
sudo systemctl status ai-kids-platform-production-daily-backup.timer --no-pager
sudo systemctl list-timers --all | grep ai-kids-platform-production
sudo find /srv/ai-kids-platform/production/backups -maxdepth 2 -name MANIFEST.json -type f -printf '%TY-%Tm-%Td %TH:%TM %p\n' | tail
```

必须检查最近备份目录中的 `MANIFEST.json`、校验摘要、SQLite `integrity_check` 和备份状态文件；不要把数据库文件直接复制到聊天或工单。

## 4. 发布与回滚 SOP

1. 变更进入 Git，先通过 CI；禁止直接在生产目录改文件。
2. 生产候选必须人工批准；当前 GitHub Actions 仅验证 / 制品 staging，不自动登录服务器部署。
3. 发布前确认 commit、release 目录、配置版本、备份状态和回滚资产均可定位。
4. 发布后执行 `/health`、公网 HTTPS、四端入口和关键角色冒烟。
5. 失败时先停止继续发布，保留日志与 release 指纹，再由授权运维人员按已验证的 release 回切；不得删除 internal-test 回滚资产。
6. 数据库变更必须先备份、临时库演练、恢复验证；不得直接在生产 SQLite 上试验 SQL。

## 5. 应急处理

### API 失败 / 服务不健康

- 确认 `systemctl status`、最近 1 小时 journal、监听端口和磁盘。
- 若为单次异常，记录时间、请求路径和错误码；不要记录 Token / 密码。
- 若发布后出现，暂停流量扩大与后续发布，由授权人员执行 release 回滚。
- 若疑似数据问题，先停止写入风险操作并保留现场，禁止直接修生产库。

### 磁盘超过 80%

- 先确认增长来源（journal、备份、release、上传文件），不要盲删。
- 仅按保留策略清理过期备份 / 日志，并保留最近可恢复副本。
- 释放空间后复核服务、数据库完整性和备份 timer。

### 证书临近过期

- 检查 certbot timer、Nginx 配置测试和证书有效期。
- 续期后执行 `nginx -t`、reload、HTTPS HEAD 与 `/api/health`。
- 证书操作不改变应用数据与回滚资产。

### 备份失败

- 检查 timer、磁盘、权限、SQLite 锁和备份状态文件。
- 不覆盖上一份可用备份；修复后手动运行一次受控备份并做校验 / 恢复验证。

## 6. 运营 SOP

### 6.1 机构 / 教师日常

- 机构管理员：查看站内信、课程 / 班级、作品审核、物料和余额状态。
- 教师：维护班级与课程安排，审阅学生作品，反馈只通过已实现的站内闭环。
- 学生：仅访问本人课程、项目、作品和通知；跨学生访问必须保持 404 / 无数据泄露。
- 自动提醒：低余额、合同到期、作品审核 / 举报处理目前只生成站内通知；邮件、短信、微信未接入。

### 6.2 课程维护

1. 先在非生产临时 SQLite 演练课程 / 课时结构变更。
2. 检查机构分配、班级课程表、教师和学生可见范围。
3. 变更前记录版本与负责人；涉及生产数据时建立独立变更窗口。
4. 复核学生任务状态、作品状态和权限隔离，不修改 `packages/canvas`。

### 6.3 财务与数据

- 余额、积分流水、充值订单以服务端账务表为准；不得用前端展示数字对账。
- `local-mock` 不产生真实模型成本，不得生成 AI 成本报表或对外宣传为真实消耗。
- 演示基础课程 / 班级可保留；seed 用户行为数据、审计、财务和法律记录不得凭名称自动删除。
- 生产演示数据归档 / 清理必须在 24 小时观察结束后另立窗口，先备份、演练、恢复验证。

## 7. 数据字典与接口索引

- 用户 / 机构：`users`、`organizations`、`sessions`
- 课程 / 班级：`course_series`、`course_lessons`、`classes`、`class_members`、`class_curriculum_items`、`class_sessions`
- 学习 / 作品：`student_projects`、`works`、`work_submissions`、`work_feedback_reads`
- 通知：`notifications`、`notification_recipients`、`notification_dispatch_jobs`
- 账务：`org_billing_accounts`、`credit_entries`、`recharge_orders`
- 审计 / 合规：`audit_logs`、`legal_consents`、`help_feedback`

接口以服务端路由为准，重点入口包括：`/api/health`、`/api/org/*`、`/api/student/*`、`/api/platform/*`、`/api/admin/*`。变更接口时同步更新对应路由注释、验收脚本和总控记录。

## 8. 值班、升级与交接

当前仍缺少已确认的外部通知渠道、值班表、联系人和升级电话，因此本节只能作为模板：

| 等级 | 触发条件 | 首响应 | 升级 |
|---|---|---:|---|
| P0 | 服务不可用、数据疑似损坏、凭据泄露 | 15 分钟 | 立即通知负责人和主机 / 域名服务商 |
| P1 | API 持续失败、备份连续失败、磁盘持续超阈值 | 30 分钟 | 1 小时内升级负责人 |
| P2 | 单功能异常、非阻塞 UI 缺陷 | 1 个工作日 | 纳入下一次发布 |

接管人员必须获得：服务器受控访问、GitHub 仓库权限、生产操作审批权、回滚说明和备份恢复演练记录；凭据通过安全渠道单独交接。

## 9. 未完成清单

- [ ] GitHub Actions 至少一次实际运行留证；
- [ ] P9-D04 密钥轮换、Secret 台账、变更审计和通知渠道；
- [ ] 24 小时观察与 7 / 30 天复盘；
- [ ] 外部通知渠道、值班人员和升级联系人确认；
- [ ] 每月恢复演练与异机 / 对象存储副本。
