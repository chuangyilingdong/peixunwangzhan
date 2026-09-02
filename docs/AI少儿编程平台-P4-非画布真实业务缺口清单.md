# AI少儿编程平台 P4 非画布真实业务缺口清单

> 建立日期：2026-09-02
> 工程根目录：`D:\学习平台\platform-v2`
> 对照基准：`D:\学习平台\docs\AI魔法学院基准\00-总览.md`、`02-页面路由清单.md`、`03-API契约清单.md`、`04-数据模型与状态机.md`
> 边界：`packages/canvas` 冻结；不伪造 AI、支付、上传与运营数据；验证一律使用临时 SQLite；不触碰 `iicili.cyou` 线上环境。

## 1. 状态定义

| 状态 | 含义 |
|---|---|
| `真实已有` | 页面已调用真实 API，数据来自本地 SQLite，具备业务闭环的最低能力。 |
| `本轮实现中` | 已列入 P4-00 第一批 P0，正在补 API、权限和真实页面。 |
| `页面壳层` | 导航与视觉壳层已存在，但未接真实 API，不能展示或写入业务数据。 |
| `外部决策` | 依赖支付、真实 AI、外部存储、微信、正式产品文案或用户提供测试账号。 |

## 2. 第一批 P0 范围与完成标准

本轮只处理非画布、已有表结构足以支撑、且可本地验收的五项：

| 序号 | 页面 | 本地路由 | 新增/复用 API | 完成标准 |
|---|---|---|---|---|
| 1 | 平台端 · 平台用户 | `/users` | 新增 `GET /api/admin/platform-users` | 支持角色、机构、关键词筛选；返回用户、机构名、套餐名、状态与有效期；未登录 401、越权 403。 |
| 2 | 平台端 · 平台管理员 | `/admins` | 新增 `GET/POST/PUT /api/admin/platform-admins` | 支持创建、编辑、启停、重置密码、权限码白名单；不能停用自己；重复登录名 409；非法权限码 400。 |
| 3 | 机构端 · 课程中心 | `/courses` | 复用 `GET /api/org/course-series` | 展示授权来源、可见范围、版本、课时数与课时明细；教师和管理员均可读，不出现伪造课件资源。 |
| 4 | 机构端 · 积分套餐 | `/packages` | 复用 `GET/POST`，新增 `GET/PUT /api/org/billing/packages/:id` | 管理员可创建、编辑、启停套餐；教师只读；教师写操作 403；数据来自 `billing_packages`。 |
| 5 | 机构端 · 积分用量 | `/usage` | 复用 `GET /api/org/billing/usage-overview`，新增 `GET /api/org/billing/usage-records` | 展示余额、能力汇总、Top 用户和可筛选用量明细；课堂上下文通过 `class_sessions -> classes` 关联，不得错误直连班级。 |

第一批完成前，对应页面状态保持 `本轮实现中`；接口正反向验证、P3 回归、前端构建和总控更新全部通过后才可改判 `真实已有`。

## 3. 平台端入口清单（12 个）

| 本地路由 | 基准路由 / 页面 | 角色 | 当前状态 | 主要数据表 | 后端 API | 状态机 / 权限 | 缺失项 | 验收方法 |
|---|---|---|---|---|---|---|---|---|
| `/dashboard` | `/super/dashboard` 平台概览 | SUPER_ADMIN | `真实已有` | `organizations`、`usage_records` | `GET /api/admin/organizations`、`GET /api/admin/billing/usage-overview` | `ADMIN_DASHBOARD` 目标权限；当前角色级 SUPER_ADMIN | 用户数、课程数、作品数汇总待补 | seed 登录后页面显示真实机构与用量；401/403 校验 |
| `/organizations` | `/super/organizations` 机构管理 | SUPER_ADMIN | `真实已有` | `organizations`、`users`、`org_billing_accounts`、`credit_entries` | `GET/POST /api/admin/organizations`、`GET/PUT /:orgId`、credit/seat adjustments | 机构 `TRIAL/ACTIVE`；目标 `ADMIN_ORGANIZATIONS` | 机构详情页、试用转正、账务资料、管理员管理 | API 联调中创建/更新机构、调整积分席位，错误场景失败 |
| `/users` | `/super/platform-users` 平台用户 | SUPER_ADMIN | `真实已有（2026-09-02）` | `users`、`organizations`、`billing_packages` | 新增 `GET /api/admin/platform-users` | 用户 `ACTIVE/DISABLED`；目标 `ADMIN_USERS` | 单用户启停、重置密码、解绑手机接口 | role/orgId/search 正反向验证；org/student token 403 |
| `/courses` | `/super/courses` 平台课程 | SUPER_ADMIN | `真实已有` | `course_series`、`course_lessons`、`course_assignments` | `GET/POST /api/admin/course-series`、assignments | 课包 `DRAFT/PUBLISHED/ARCHIVED` | 详情编辑、课时/资产 CRUD、封面与课件上传 | 创建课包并授权机构；重复标题 409 |
| `/marketplace` | `/super/course-marketplace` 课程广场 | SUPER_ADMIN | `页面壳层` | `course_series.marketplace_status` | 待定 | `marketplace_status`、奖励积分 | 分区、蒸馏、上下架与奖励规则 | 基准登录态逐页对照后实施 |
| `/works` | `/super/published-works` 作品库 | SUPER_ADMIN | `真实已有（2026-09-02）` | `works`、`student_projects`、`users`、`organizations`、`classes`、`course_lessons` | 新增 `GET /api/admin/works`、`PUT /api/admin/works/:id/unpublish` | `PENDING/APPROVED/REJECTED/PUBLISHED`；仅 `SUPER_ADMIN`；下架写为 `REJECTED`、记录原因与审核人并审计 `PLATFORM_WORK_UNPUBLISH` | 作品详情、精选、举报、违规处理、公开分享；服务端尚未强制仅 `PUBLISHED` 可下架，当前由前端操作边界约束 | 临时库验证状态/机构/关键词筛选、搜索、下架、审计与机构/学生 403 |
| `/hackathon` | `/super/hackathon` 黑客松审核 | SUPER_ADMIN | `页面壳层` | 现无赛季表，需迁移 | 待新增 | `DRAFT/ACTIVE/ENDED`；投稿 `PENDING/APPROVED/REJECTED/WITHDRAWN` | 数据模型、赛季配置、审核流 | 表迁移后用临时库验证状态机 |
| `/billing` | `/super/usage-records + recharge + billing-settings` | SUPER_ADMIN | `真实已有（2026-09-02，用量汇总与明细；在线充值/计费设置仍外部决策）` | `org_billing_accounts`、`usage_records`、`recharge_orders`、`users`、`organizations`、`class_sessions`、`classes` | 现有 `GET /api/admin/billing/usage-overview`；新增 `GET /api/admin/billing/usage-records` | 仅 `SUPER_ADMIN`；支持 `days/orgId/modality/status/search`；无效 `days` 返回 `VALIDATION_ERROR` | 在线支付回调、计费规则/模型开关配置、冻结与预警、导出对账 | 临时库验证汇总、筛选、搜索、上下文关联、非法参数与越权 403 |
| `/materials` | `/super/materials + promo-materials` | SUPER_ADMIN | `页面壳层` | `media_assets` 可承接 | 待新增 | 素材/物料启停 | 文件上传、OSS、下载地址 | 上传与外部存储为外部决策 |
| `/inbox` | `/super/inbox` 站内信 | SUPER_ADMIN | `页面壳层` | 现无 inbox 表，需迁移 | 待新增 | 已读/未读 | 建表、发送、已读状态 | 迁移后用临时库验证 |
| `/admins` | `/super/platform-admins` 平台管理员 | SUPER_ADMIN | `真实已有（2026-09-02）` | `users(role=SUPER_ADMIN)` | 新增 `GET/POST/PUT /api/admin/platform-admins` | 用户 `ACTIVE/DISABLED`；`ADMIN_*` 权限码 | 独立 enabled/password/permissions 子路径可在后续扩展 | 创建/编辑/停自己失败/非法权限码/重复登录名 |
| `/login`、`/forbidden` 等壳层 | 登录、无权限 | public / 登录 | `真实已有` | `sessions` | `/api/auth/*`、`/api/me` | 会话失效与顶替错误码 | 手机绑定、改密、被顶提示 | 现有 P3 认证回归覆盖 |

## 4. 机构 / 教师端入口清单（14 个）

| 本地路由 | 基准路由 / 页面 | 角色 | 当前状态 | 主要数据表 | 后端 API | 状态机 / 权限 | 缺失项 | 验收方法 |
|---|---|---|---|---|---|---|---|---|
| `/dashboard` | `/org/home` 机构/教学首页 | ORG_ADMIN、TEACHER | `真实已有` | `organizations`、`users`、`classes`、`class_sessions`、`works` | `GET /api/org/overview` | 管理员经营视图 / 教师教学视图分化 | 教师首页个性化待补 | 管理员与教师 token 均返回本机构数据 |
| `/classes` | `/org/classes` 班级与课堂 | ORG_ADMIN、TEACHER | `真实已有` | `classes`、`class_members`、`class_curriculum_items`、`class_sessions` | classes、curriculum、sessions | 班级 `ACTIVE/ARCHIVED`；课堂 `ACTIVE/ENDED`；教师需 `MANAGE_CLASSES` | 归档恢复、跨课包拖动、导入替换规则 | P3 API 回归 + 前端课单展示 |
| `/members` | `/org/accounts` 账号管理 | ORG_ADMIN、TEACHER 按权限 | `真实已有` | `users`、`billing_packages` | `GET/POST/PUT/DELETE /api/org/users` 等 | 用户 `ACTIVE/DISABLED`；`MANAGE_MEMBERS` | 批量导入、变更记录、统一走开通策略 | 创建/编辑/禁用/重置密码/权限越权失败 |
| `/works` | `/org/published-works` 作品点评 | ORG_ADMIN、TEACHER | `真实已有` | `works`、`work_annotations` | works、review、annotations | `PENDING/APPROVED/REJECTED/PUBLISHED`；教师只能管本班 | 下架、访客统计、公开分享 | P3 回归含审核与批注 |
| `/courses` | `/org/courses` 课程中心 | ORG_ADMIN、TEACHER | `真实已有（2026-09-02）` | `course_series`、`course_lessons`、`course_assignments` | `GET /api/org/course-series` | 平台公开/授权/机构自有；只含 `PUBLISHED` | 课件资产、上课入口聚合 | 管理员/教师可读，未登录 401，student 403 |
| `/packages` | `/org/billing-packages` 积分套餐 | ORG_ADMIN 写、TEACHER 只读 | `真实已有（2026-09-02）` | `billing_packages` | `GET/POST` 已有；新增 `GET/PUT /:id` | 套餐 `ACTIVE/DISABLED`；写操作 ORG_ADMIN | 与学员开通单联动 | 教师读 200、写 403；管理员编辑启停成功 |
| `/usage` | `/org/usage-records` 积分用量 | ORG_ADMIN、TEACHER 按权限 | `真实已有（2026-09-02）` | `org_billing_accounts`、`usage_records`、`class_sessions`、`classes` | overview 已有；新增 usage-records | `SUCCESS/FAILED/BLOCKED` | 今日/7日/30日切换与导出 | SQL 关联经 class_sessions；筛选与越权校验 |
| `/inbox` | `/org/inbox` 站内信 | ORG_ADMIN、TEACHER | `页面壳层` | 现无 inbox 表 | 待新增 | 已读/未读 | 建表与发送读取链路 | 迁移后临时库验证 |
| `/work-data` | `/org/published-work-data` 作品数据中心 | ORG_ADMIN | `页面壳层` | `works` + 未来 visit 表 | 待新增 | 7/14/30 日统计 | 访问去重、趋势、授权访客 | 需公开分享与访客模型迁移 |
| `/enrollment` | `/org/student-orders` 学员开通 | ORG_ADMIN | `页面壳层` | 需新增开通单/商品表 | 待新增 | 履约、收款、作废状态机 | 数据模型与 API | 设计迁移后实施 |
| `/recharge` | `/org/recharge` 积分充值 | ORG_ADMIN | `真实账务视图（2026-09-02）；在线支付仍外部决策` | `org_billing_accounts`、`recharge_orders`、`credit_entries` | 新增 `GET /api/org/billing/account-overview` | 仅 `ORG_ADMIN`；教师返回 `ORG_BILLING_PERMISSION_DENIED`；充值单 `PENDING/PAID/CANCELLED/EXPIRED` | 微信/支付宝支付回调、冻结金额、退款/冲正、人工调整、导出对账 | 管理员可读余额/累计/订单/流水；教师 403；不伪造到账数据 |
| `/materials` | `/org/promo-materials` 宣传物料 | ORG_ADMIN | `页面壳层` | `media_assets` 可承接 | 待新增 | 物料启停 | 上传与下载地址 | 外部存储与文件大小策略待定 |
| `/hackathon` | `/org/hackathon` 黑客松 | ORG_ADMIN | `页面壳层` | 需新增赛季/投稿表 | 待新增 | 投稿状态机 | 建表、配置、推送审核 | 数据模型迁移后实施 |
| `/afee` | `/org/mp-notify` 阿飞提醒 | ORG_ADMIN | `页面壳层` | 需新增微信绑定/访客表 | 待新增 | 绑定状态机 | 微信开放平台对接 | 外部决策 |

## 5. 学生端入口清单（10 个）

|---|---|---|---|---|---|---|---|---|
| `/dashboard` | 学生学习首页 | STUDENT | `真实已有` | `student_projects`、`works`、`classes`、`class_members` | 现有项目/画布/作品 API | 项目与作品状态机已有 | 班级、课程、课单、任务、套餐用量 | 需先补班级视角 API |
| `/projects` | 我的创作项目 | STUDENT | `真实已有` | `student_projects`、`project_snapshots` | projects CRUD、版本、导入导出 | 草稿/归档 | 云同步冲突、批量管理 | P3 项目回归 |
| `/projects/:projectId/canvas` | 创作画布 | STUDENT | `真实已有（画布冻结）` | `student_projects`、`project_snapshots` | projects API | 草稿/提交 | 不修改 `packages/canvas` | 仅回归，不做画布改动 |
| `/works` | 我的作品 / 提交记录 | STUDENT | `真实已有` | `works` | works submit/status | `PENDING/APPROVED/REJECTED/PUBLISHED` | 独立发布、重新发布、下架 | 学生只能访问本人作品 |
| `/showcase` | 公开作品墙 | STUDENT | `真实已有` | `works` | showcase | `PUBLISHED` | 浏览计数与访客模型 | 当前只显示已发布作品 |
| `/courses` | 我的课程 | STUDENT | `页面壳层` | `class_members`、`class_curriculum_items`、`course_series`、`course_lessons` | 待新增 | 课单进度 | 学生班级课程、课时进度、任务入口 | 先补只读 API，不涉及画布内部 |
| `/credits` | 套餐与用量 | STUDENT | `页面壳层` | `users`、`billing_packages`、`usage_records` | 待新增 | 套餐有效期 | 本人额度、剩余、本月明细 | 只能查看本人，机构隔离 |
| `/account` | 账号安全 | STUDENT | `页面壳层` | `users`、`sessions` | 待新增 | 账号状态 | 改名、改密、会话管理 | 需防旧密码/重放 |
| `/help` | 学习帮助 | STUDENT | `页面壳层` | 静态内容 | 无 | 无 | 正式帮助内容 | 内容属产品决策，可接静态 CMS |
| `/login` | 登录 | public | `真实已有` | `sessions` | auth | 账号状态与会话错误码 | 手机流程 | 现有认证回归 |

## 6. 官网入口清单（8 个）

| 本地路由 | 基准 / 作用 | 当前状态 | 数据表 | 后端 API | 缺失项 | 验收方法 |
|---|---|---|---|---|---|---|
| `/` | 品牌首页 | `真实已有（静态品牌页）` | 无 | 无 | 转化埋点 | 静态构建与链接可达 |
| `/courses` | 课程介绍 | `真实已有（静态课程页）` | 无 | 无 | 与真实课包联动 | 静态构建 |
| `/org` | 机构合作 | `真实已有（静态页）` | 无 | 无 | 线索落库 | P5 线索表与通知 |
| `/works` | 公开作品 | `真实已有（静态作品页）` | `works` 可承接 | 待新增 public works | 真实公开作品流、访客统计 | P5 公开分享链路 |
| `/handbook` | 学习手册 | `真实已有（静态页）` | 无 | 无 | CMS | 静态构建 |
| `/compare` | 对比页 | `真实已有（静态页）` | 无 | 无 | 正式数据口径 | 静态构建 |
| `/download` | 下载页 | `真实已有（静态页）` | 无 | 待新增下载记录 | 下载统计 | P5 转化闭环 |
| `/demo` | 预约演示 | `页面壳层（仅前端行为）` | 需线索表 | 待新增 | 线索落库、通知、防刷 | P5 与 `/org` 一并实施 |

## 7. P0 后续批次建议

1. **P4-01 平台计费与作品闭环（2026-09-02 第一批已完成）**：平台用量明细、平台作品库、作品下架、机构账务视图；在线支付、计费规则配置、精选/举报/违规处理未包含，转入后续批次。
2. **P4-02 学生课程与账号闭环**：学生课程、额度、账号安全，仅使用现有表。
3. **P4-03 通知与物料闭环**：先补 inbox / promo-materials 表，再接两端页面。
4. **P4-04 运营活动与外部能力**：黑客松、微信提醒、支付、上传、真实 AI 均需先迁移或明确外部决策。

## 8. 本轮总验收（P4-00 / P4-01）

### 8.1 P4-00 第一批验收记录

- [x] `node --check apps/server/src/routes/adminOrg.js` 通过。
- [x] 临时 SQLite 初始化 + seed 后，API 正反向场景全部符合第 2 节完成标准。
- [x] `node .\p3-api-integration.mjs` 在同一临时库服务上通过。
- [x] `pnpm run build` 全量通过。
- [x] 平台端 `/users`、`/admins` 与机构端 `/courses`、`/packages`、`/usage` 不再是壳层。
- [x] 总控 P4-00 更新，并追加变更日志。
- [x] Git 提交并推送 `main`；不部署线上环境。

### 8.2 P4-01 第一批验收记录（2026-09-02）

- [x] `node --check apps/server/src/routes/adminOrg.js` 通过。
- [x] 临时 SQLite 初始化 + seed 后，`47 pass / 0 fail`：覆盖平台用量筛选、搜索、上下文关联、非法 `days=0`、平台作品筛选/搜索/下架/审计、机构与学生越权 403、机构账务聚合、教师账务 403。
- [x] `node .\p3-api-integration.mjs` 回归通过，`46 pass / 0 fail`。
- [x] `pnpm run build` 四端生产构建全部通过。
- [x] 平台端 `/works`、`/billing` 与机构端 `/recharge` 从壳层/部分真实升级为真实只读或治理视图；不伪造支付到账、模型配置和运营数据。
- [x] 已知边界：在线支付、计费规则配置、精选/举报/违规处理未包含；平台下架接口当前由前端限制仅对 `PUBLISHED` 操作，服务端严格状态机校验留待统一状态机批次。
- [x] 本次仅修改非画布代码与文档，`packages/canvas` 无改动，不部署线上环境。
