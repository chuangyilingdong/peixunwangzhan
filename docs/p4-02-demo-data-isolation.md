# P4-02 演示数据隔离规范

- 状态：盘点与规范完成；生产数据处置未执行
- 日期：2026-09-04
- 适用环境：本地临时 SQLite、内测回滚资产和生产数据库的后续变更窗口
- 关联：`packages/database/src/seed.js`、`packages/database/src/schema.js`、`scripts/p4-02-demo-data-inventory.mjs`

## 1. 目标与边界

本规范用于区分 seed 演示资产与真实业务数据，避免把演示账号产生的学习、作品、AI 用量、通知或隐私请求混入生产运营统计。

本次仅在临时 SQLite 中初始化并执行 seed 盘点：

- 不打开、不复制、不迁移、不写入生产 `platform.db`。
- 不删除 `internal-test` 的 release、数据库、systemd unit、Nginx 备份或其他回滚资产。
- 不修改 `packages/canvas`。
- 不改变线上账号状态；生产种子账号当前已禁用，真实管理员账号已建立。

## 2. Seed 锚点

`seed.js` 使用稳定登录名复用用户，并以固定机构 / 课程 / 班级名称补齐基础演示结构。当前可识别锚点：

| 类型 | 锚点 |
|---|---|
| 用户登录名 | `root`、`org-admin`、`teacher-1`、`teacher-2`、`student-1`、`student-2` |
| 机构 | `示例创新学校` |
| 班级 | `三年级AI创作一班` |
| 课程系列 | `AI创作启蒙课` |
| 课程课时 | 由课程系列下 `sort=1..5` 识别 |

锚点不是通用的“所有历史演示数据”判定器。真实生产数据若使用相同登录名、机构名或业务关系，不得仅凭名称自动删除。

## 3. 数据分类

### 3.1 可保留的基础配置 / 教学模板

Fresh seed 中用于让平台可运行的基础资产可以保留，但应在报表中标记为 `seed/base`，不计入真实经营指标：

- 平台配置、网站默认内容及其版本记录。
- 示例机构基础资料、机构账务账户与期初积分流水。
- 套餐、课程系列、课时、课程授权、示例班级、班级成员和课程计划。

这些数据可以作为内部演示和回归测试基线；若未来作为正式课程 / 机构资料使用，应由授权人员重新确认归属并去除演示标识，而不是直接视为真实经营数据。

### 3.2 应隔离或归档的演示行为数据

以下记录若由 seed 用户或示例机构产生，默认标记为 `demo`，从运营、财务、转化和学习成效报表排除：

- `sessions`、`audit_logs`、`analytics_events`、`help_feedback`。
- `student_enrollments`、`student_enrollment_events`、`class_sessions`。
- `student_projects`、`project_snapshots`、`works`、`work_submissions`、`work_annotations`、`work_feedback_reads`、`work_publish_requests`、`work_reports`。
- `usage_records`、`generation_jobs`、`media_assets`。
- `notifications`、`notification_recipients`、`notification_events`、`notification_dispatch_jobs`。
- `promo_materials` 及其 assignments/events、`recharge_orders`、`account_requests`、`legal_consents`。
- `file_assets` 与 `file_access_grants`：若属于演示资源，只能在授权确认后归档或清理；不得凭 URL 或文件名盲删。

### 3.3 不得自动处理的记录

- 真实管理员 `owner` 及其会话、审计记录。
- 任何无法通过用户、机构、项目、班级或明确事件链确认来源的记录。
- 生产中的财务、审计、法律同意、账号请求、作品与文件记录。
- `internal-test` 回滚数据库及其备份。

## 4. 报表规则

运营与财务查询应优先使用明确的演示排除条件，而非事后手工删数据：

1. 排除 seed 登录名对应的用户行为记录。
2. 排除示例机构及其班级 / 课程关系产生的行为记录。
3. 机构聚合、用户聚合和 AI 用量聚合必须同时按 `org_id` / `user_id` / 关联项目过滤，避免只过滤单一维度造成漏数。
4. 审计、法务和安全报表默认保留原始记录；如需展示真实运营指标，另建过滤视图或查询条件，不删除原始审计数据。
5. `local-mock` 任务可用于技术回归，但不得换算成真实模型成本，也不得对外宣称已接入真实 AI。

## 5. 生产执行前置条件

生产处置必须单独建立变更单并获得明确批准，至少包括：

- 变更前生产备份，并确认备份可读、哈希和 `integrity_check` 正常。
- 逐表盘点、导出脱敏计数和候选记录 ID；不在文档、日志或对话输出密码、密钥、`.env` 内容。
- 明确“保留基础教学资产 / 归档行为数据 / 永久删除”三类清单。
- 先在复制的临时 SQLite 演练清理，再做恢复演练和行数对账。
- 生产执行时停止写入或采用明确维护窗口；执行后复测登录、课程、班级、作品、账务、审计和告警。
- 保留回滚路径；不得删除 internal-test 回滚资产。

在 2026-09-05 20:24 CST 生产 24 小时观察窗口结束前，不执行生产演示数据清理或归档。

## 6. 验证记录

脚本：`scripts/p4-02-demo-data-inventory.mjs`

执行方式：Node v24.19.0；自动创建临时目录，初始化 schema 后运行 seed，以只读方式重新打开 SQLite 盘点；生产数据库未打开。

结果摘要：

- 6 个 seed 用户均为 `ACTIVE`；非 seed 用户为 0。
- 1 个示例机构、1 个课程系列、5 个课时、1 个班级、3 个班级成员。
- 会话、学生项目、作品、用量、AI 任务、通知、隐私请求等行为表初始为 0。
- `node --check scripts/p4-02-demo-data-inventory.mjs` 通过。

完整 JSON 输出：`artifacts-p4-02-inventory.txt`（仅包含临时 SQLite 盘点结果，不含密码、密钥或 `.env` 内容）。
