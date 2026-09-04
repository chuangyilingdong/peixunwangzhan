# P8-S06 发布、回滚与事故响应演练

> 适用环境：`learning-platform-internal-test`。本文是预发发布和故障演练规则，不代表已完成正式公开上线。所有自动化验收使用临时 SQLite；不得触碰真实线上数据库，不得把 `local-mock` 当作真实 AI。

## 发布闸门

1. 从已推送 commit 构建 `mode=internal-test` release，核对 `BUILD-METADATA.txt`、commit、Node / pnpm 版本。
2. 确认目标数据库位于 `/srv/ai-kids-platform/internal-test/data/platform.db`，与旧站真实数据库隔离。
3. 发布前执行备份；备份必须包含数据库、当前 release、配置、日志和 `MANIFEST.json`，记录 UTC 时间、RPO、执行人和 release。
4. 在预发环境先执行 API / 四端构建 / 权限 / 租户隔离 / noindex 冒烟；P0 缺陷不得放行。
5. 通过 `rollback-internal-test.sh` 切换 release；脚本必须校验 release 位于隔离 `releases` 目录且存在 `BUILD-METADATA.txt`。
6. 切换后检查 `/health`、官网首页、登录、公开课程和角色入口；失败时立即停止扩大访问并回滚。

## 回滚与数据库迁移

```bash
bash deploy/internal-test/backup-internal-test.sh
bash deploy/internal-test/rollback-internal-test.sh --release /srv/ai-kids-platform/internal-test/releases/<known-good> --db-backup /srv/ai-kids-platform/internal-test/backups/<stamp>/platform.db
```

- release 回滚和数据库快照恢复分开执行；先停止服务，再恢复隔离数据库，最后启动并检查健康。
- 迁移必须可前向执行、可通过备份快照恢复；没有经过验证的 down migration，不得在内测中直接运行破坏性迁移。
- 当前演练以临时 SQLite 验证：坏 release 健康检查失败自动切回上一 release；坏迁移加入探针表后从备份快照恢复，用户 / 课程计数一致。
- 任何路径必须保持在隔离内测根目录；拒绝仓库默认数据库 `packages/data/platform.db`。

## 事故分级、通报与止损

| 等级 | 触发示例 | 首要动作 | 通报范围 |
|---|---|---|---|
| P0 | 数据越权、认证失效、连续 5xx、数据库损坏、真实外部数据误接入 | 立即暂停测试访问、保留现场、停止服务 / 回滚、通知负责人 | 项目负责人 + 技术负责人 + 运维值班 |
| P1 | 核心流程不可用、慢请求持续超阈值、备份失败、证书临近到期 | 限制新增测试、采集日志、修复或回滚 | 技术负责人 + 相关测试人员 |
| P2 | 非核心页面问题、可绕过的提示或样式问题 | 建单、排期、保留复现证据 | 研发与测试 |

通报必须只包含：时间（UTC + Asia/Shanghai）、影响页面 / API、release commit、影响角色、复现步骤、当前止损动作和负责人。禁止粘贴密码、Cookie、token、儿童真实信息或真实数据库内容。

## 复盘模板

- 事故编号 / 等级：
- 发生与发现时间（UTC / Asia/Shanghai）：
- 影响范围与用户角色：
- 触发信号、页面 / API 与 release commit：
- 止损、回滚或恢复动作及 RPO / RTO：
- 根因与未触发的防线：
- 数据与隐私影响判断：
- 修复项、负责人、截止时间：
- 是否需要更新测试、监控、Runbook 或放行闸门：

## 当前边界

当前线上 `https://iicili.cyou/` 仍是内部测试站，保持 noindex、内测标识、独立测试 SQLite 和回滚能力；Basic Auth 已按用户明确授权解除，正式公开前必须恢复访问控制。尚未配置真实飞书 / 电话通知，也未接入真实 AI、OSS、支付、微信、短信、邮件或客户端能力。
