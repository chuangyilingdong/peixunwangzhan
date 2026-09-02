# AI少儿编程平台 P4 非画布真实业务缺口清单

> 建立日期：2026-09-02
> 工程根目录：`D:\学习平台\platform-v2`
> 对照基准：`D:\学习平台\docs\AI魔法学院基准\00-总览.md`、`02-页面路由清单.md`、`03-API契约清单.md`、`04-数据模型与状态机.md`
> 边界：`packages/canvas` 冻结；不伪造 AI、支付、上传与运营数据；验证一律使用临时 SQLite；不触碰 `iicili.cyou` 线上环境。

## 1. 状态定义

| 状态 | 含义 |
|---|---|
| `真实已有` | 页面已调用真实 API，数据来自本地 SQLite，具备业务闭环的最低能力。 |
| `本轮实现中` | 已列入当前批次，正在补 API、权限和真实页面。 |
| `页面壳层` | 导航与视觉壳层已存在，但未接真实 API，不能展示或写入业务数据。 |
| `外部决策` | 依赖支付、真实 AI、外部存储、微信、正式产品文案或用户提供测试账号。 |
| `产品取消` | 用户已明确确认不做；不再设计数据表、API、业务页面或验收场景，历史壳层后续清理。 |

## 2. 第一批 P0 范围与完成标准

本轮只处理非画布、已有表结构足以支撑、且可本地验收的五项：

| 序号 | 页面 | 本地路由 | 新增/复用 API | 完成标准 |
|---|---|---|---|---|
| 1 | 平台端 · 平台用户 | `/users` | 新增 `GET /api/admin/platform-users` | 支持角色、机构、关键词筛选；返回用户、机构名、套餐名、状态与有效期；未登录 401、越权 403。 |
| 2 | 平台端 · 平台管理员 | `/admins` | 新增 `GET/POST/PUT /api/admin/platform-admins` | 支持创建、编辑、启停、重置密码、权限码白名单；不能停用自己；重复登录名 409；非法权限码 400。 |
| 3 | 机构端 · 课程中心 | `/courses` | 复用 `GET /api/org/course-series` | 展示授权来源、可见范围、版本、课时数与课时明细；教师和管理员均可读，不出现伪造课件资源。 |
| 4 | 机构端 · 套餐与学员开通 | `/packages`、`/enrollment` | 套餐 `GET/POST/PUT /api/org/billing/packages`；开通单 `GET/POST /api/org/billing/enrollments` 及登记、开通、停用、恢复、续费、作废动作 | 管理员可配置套餐席位、创建待开通单并按状态机完成履约；教师无开通单访问权限；数据来自 `billing_packages`、`student_enrollments` 与事件表。 |
| 5 | 机构端 · 积分用量 | `/usage` | 复用 `GET /api/org/billing/usage-overview`，新增 `GET /api/org/billing/usage-records` | 展示余额、能力汇总、Top 用户和可筛选用量明细；课堂上下文通过 `class_sessions -> classes` 关联，不得错误直连班级。 |

第一批完成前，对应页面状态保持 `本轮实现中`；接口正反向验证、P3 回归、前端构建和总控更新全部通过后才可改判 `真实已有`。

## 3. 平台端入口清单（12 个，含 1 个历史取消入口）

| 本地路由 | 基准路由 / 页面 | 角色 | 当前状态 | 主要数据表 | 后端 API | 状态机 / 权限 | 缺失项 | 验收方法 |
|---|---|---|---|---|---|---|---|---|
| `/dashboard` | `/super/dashboard` 平台概览 | SUPER_ADMIN | `真实已有` | `organizations`、`usage_records` | `GET /api/admin/organizations`、`GET /api/admin/billing/usage-overview` | `ADMIN_DASHBOARD` 目标权限；当前角色级 SUPER_ADMIN | 用户数、课程数、作品数汇总待补 | seed 登录后页面显示真实机构与用量；401/403 校验 |
| `/organizations` | `/super/organizations` 机构管理 | SUPER_ADMIN | `真实已有` | `organizations`、`users`、`org_billing_accounts`、`credit_entries` | `GET/POST /api/admin/organizations`、`GET/PUT /:orgId`、credit/seat adjustments | 机构 `TRIAL/ACTIVE`；目标 `ADMIN_ORGANIZATIONS` | 机构详情页、试用转正、账务资料、管理员管理 | API 联调中创建/更新机构、调整积分席位，错误场景失败 |
| `/users` | `/super/platform-users` 平台用户 | SUPER_ADMIN | `真实已有（2026-09-02）` | `users`、`organizations`、`billing_packages` | 新增 `GET /api/admin/platform-users` | 用户 `ACTIVE/DISABLED`；目标 `ADMIN_USERS` | 单用户启停、重置密码、解绑手机接口 | role/orgId/search 正反向验证；org/student token 403 |
| `/courses` | `/super/courses` 平台课程 | SUPER_ADMIN | `真实已有` | `course_series`、`course_lessons`、`course_assignments` | `GET/POST /api/admin/course-series`、assignments | 课包 `DRAFT/PUBLISHED/ARCHIVED` | 详情编辑、课时/资产 CRUD、封面与课件上传 | 创建课包并授权机构；重复标题 409 |
| `/marketplace` | `/super/course-marketplace` 课程广场 | SUPER_ADMIN | `页面壳层` | `course_series.marketplace_status` | 待定 | `marketplace_status`、奖励积分 | 分区、蒸馏、上下架与奖励规则 | 基准登录态逐页对照后实施 |
| `/works` | `/super/published-works` 作品库 | SUPER_ADMIN | `真实已有（2026-09-02）` | `works`、`student_projects`、`users`、`organizations`、`classes`、`course_lessons` | 新增 `GET /api/admin/works`、`PUT /api/admin/works/:id/unpublish` | `PENDING/APPROVED/REJECTED/PUBLISHED`；仅 `SUPER_ADMIN`；下架写为 `REJECTED`、记录原因与审核人并审计 `PLATFORM_WORK_UNPUBLISH` | 作品详情、精选、举报、违规处理、公开分享；服务端尚未强制仅 `PUBLISHED` 可下架，当前由前端操作边界约束 | 临时库验证状态/机构/关键词筛选、搜索、下架、审计与机构/学生 403 |
| `/hackathon` | `/super/hackathon` 黑客松审核 | SUPER_ADMIN | `产品取消（2026-09-02）` | 不新增 | 不新增 | 不建设赛季、报名、投稿或评审状态机 | 用户已明确确认不做；现有页面仅为历史壳层 | 不进入开发与验收；后续导航 / 路由清理时移除 |
| `/billing` | `/super/usage-records + recharge + billing-settings` | SUPER_ADMIN | `真实已有（2026-09-02，用量汇总与明细；在线充值/计费设置仍外部决策）` | `org_billing_accounts`、`usage_records`、`recharge_orders`、`users`、`organizations`、`class_sessions`、`classes` | 现有 `GET /api/admin/billing/usage-overview`；新增 `GET /api/admin/billing/usage-records` | 仅 `SUPER_ADMIN`；支持 `days/orgId/modality/status/search`；无效 `days` 返回 `VALIDATION_ERROR` | 在线支付回调、计费规则/模型开关配置、冻结与预警、导出对账 | 临时库验证汇总、筛选、搜索、上下文关联、非法参数与越权 403 |
| `/materials` | `/super/materials + promo-materials` | SUPER_ADMIN | `真实已有（2026-09-02，元数据、外链与统计）` | `promo_materials`、`promo_material_assignments`、`promo_material_events` | `GET/POST/PUT /api/admin/materials`、`GET /api/admin/materials/:id/stats` | 物料 `DRAFT/ACTIVE/DISABLED`；平台超管写入 | 真实文件上传、OSS、封面上传、下载代理与签名 | 当前维护元数据和可选外部资源地址；统计详情返回汇总、机构聚合与最近事件；未配置资源时下载明确拒绝 |
| `/inbox` | `/super/inbox` 站内信 | SUPER_ADMIN | `真实已有（2026-09-02，两批）` | `notifications`、`notification_recipients`、`notification_templates` | `GET/POST/PUT /api/admin/inbox`、`GET/POST/PUT /api/admin/notification-templates` | `DRAFT/SCHEDULED/PUBLISHED/RECALLED`（`SCHEDULED` 为 `DRAFT + publish_at` 的逻辑状态）；仅平台超管管理 | 投递失败重试、高可用异步队列、邮件/短信/微信渠道 | 支持模板、按机构/角色投递、草稿、立即/定时发布、撤回、置顶和跳转；定时到期生成接收记录并审计 |
| `/admins` | `/super/platform-admins` 平台管理员 | SUPER_ADMIN | `真实已有（2026-09-02）` | `users(role=SUPER_ADMIN)` | 新增 `GET/POST/PUT /api/admin/platform-admins` | 用户 `ACTIVE/DISABLED`；`ADMIN_*` 权限码 | 独立 enabled/password/permissions 子路径可在后续扩展 | 创建/编辑/停自己失败/非法权限码/重复登录名 |
| `/login`、`/forbidden` 等壳层 | 登录、无权限 | public / 登录 | `真实已有` | `sessions` | `/api/auth/*`、`/api/me` | 会话失效与顶替错误码 | 手机绑定、改密、被顶提示 | 现有 P3 认证回归覆盖 |

## 4. 机构 / 教师端入口清单（14 个，含 1 个历史取消入口）

| 本地路由 | 基准路由 / 页面 | 角色 | 当前状态 | 主要数据表 | 后端 API | 状态机 / 权限 | 缺失项 | 验收方法 |
|---|---|---|---|---|---|---|---|---|
| `/dashboard` | `/org/home` 机构/教学首页 | ORG_ADMIN、TEACHER | `真实已有（2026-09-02，P4-O01 第一批）` | `organizations`、`users`、`classes`、`class_members`、`class_sessions`、`works`、`notifications`、`notification_recipients`、`org_billing_accounts` | `GET /api/org/overview` | 管理员经营视图 / 教师教学视图分化；教师仅本人负责 / 授权班级 | 班级、作品等既有教务接口的教师授权范围待 P4-O02 统一；运营分析下钻待 P4-O06 | 临时 SQLite 验证管理员 / 教师范围、跨教师、跨机构、未读消息、预警、空态和明细复算；P3 回归与四端构建通过 |
| `/classes` | `/org/classes` 班级与课堂 | ORG_ADMIN、TEACHER | `真实已有（2026-09-02，P4-O03）` | `classes`、`class_members`、`class_curriculum_items`、`class_sessions`（含 `session_kind` 兼容迁移字段） | `GET /api/org/classes/:id`、`GET /api/org/classes/:id/sessions`、`GET /api/org/classes/:id/progress`、`PUT /api/org/classes/:id/curriculum`、课堂 start/end/makeup/cancel | 班级 `ACTIVE/ARCHIVED`；课堂 `ACTIVE/ENDED`；教师仅本人负责 / 授权班级；归档后禁止成员、课单和开课写操作；学生仅能看到已加入且已发布课时 | 课程资产、归档恢复、跨课包拖动、导入替换规则 | 临时 SQLite 主验收 + 跨机构 / 未发布内容隔离 + P3 API 回归 + 四端构建 |
| `/members` | `/org/accounts` 账号管理 | ORG_ADMIN、TEACHER 按权限 | `真实已有` | `users`、`billing_packages` | `GET/POST/PUT/DELETE /api/org/users` 等 | 用户 `ACTIVE/DISABLED`；`MANAGE_MEMBERS` | 批量导入、变更记录、统一走开通策略 | 创建/编辑/禁用/重置密码/权限越权失败 |
| `/works` | `/org/published-works` 作品点评 | ORG_ADMIN、TEACHER | `真实已有` | `works`、`work_annotations` | works、review、annotations | `PENDING/APPROVED/REJECTED/PUBLISHED`；教师只能管本班 | 下架、访客统计、公开分享 | P3 回归含审核与批注 |
| `/courses` | `/org/courses` 课程中心 | ORG_ADMIN、TEACHER | `真实已有（2026-09-02）` | `course_series`、`course_lessons`、`course_assignments` | `GET /api/org/course-series` | 平台公开/授权/机构自有；只含 `PUBLISHED` | 课件资产、上课入口聚合 | 管理员/教师可读，未登录 401，student 403 |
| `/packages`、`/enrollment` | `/org/billing-packages` 积分套餐、`/org/enrollment` 学员开通 | ORG_ADMIN；TEACHER 无开通单权限 | `真实已有（2026-09-02，P4-O07）` | `billing_packages`、`student_enrollments`、`student_enrollment_events` | 套餐 `GET/POST/PUT`；开通单列表 / 详情 / 创建、线下履约登记、开通 / 停用 / 恢复 / 续费 / 作废 | `PENDING/ACTIVE/SUSPENDED/VOIDED/EXPIRED`；仅 `ACTIVE` 占席位；停用 / 到期失效学生会话与套餐权限 | 在线支付、支付回调、自动续费和自动消息提醒 | 临时 SQLite 验证席位上限、状态迁移、到期扫描、权限失效与审计；教师读取开通单 403 |
| `/usage` | `/org/usage-records` 积分用量 | ORG_ADMIN、TEACHER 按权限 | `真实已有（2026-09-02）` | `org_billing_accounts`、`usage_records`、`class_sessions`、`classes` | overview 已有；新增 usage-records | `SUCCESS/FAILED/BLOCKED` | 今日/7日/30日切换与导出 | SQL 关联经 class_sessions；筛选与越权校验 |
| `/classes`（课堂内 AI 控制） | `/org/classes/:id` 课堂 AI 控制与用量审计 | ORG_ADMIN、TEACHER | `真实已有（2026-09-02，P4-O04）` | `class_sessions`、`usage_records`、`generation_jobs`、`student_projects`、`classes` | `PUT /api/org/classes/:classId/sessions/:sessionId/ai-controls`、`GET /api/org/ai-usage`、`POST /api/ai/usage`、`POST /api/ai/generations` | 课堂 `ACTIVE`；暂停 / 能力开关 / 单学生次数 / 课堂积分上限由服务端强制；教师按负责 / 授权课堂查询 | 真实外部 AI provider、异步队列与账单策略仍按后续基础设施处理 | 临时 SQLite 验证普通调用与生成任务的成功 / BLOCKED 审计、课时 / 项目 / job 关联、教师范围和越权 |
| `/inbox` | `/org/inbox` 站内信 | ORG_ADMIN、TEACHER | `真实已有（2026-09-02，两批）` | `notifications`、`notification_recipients` | `GET/POST /api/org/inbox`、`PUT /api/org/inbox/:id/read`、`PUT /api/org/inbox/read-all` | 平台即时/定时公告接收；机构通知仅 ORG_ADMIN 可发；按当前机构与本人接收记录隔离 | 高可用异步队列、失败重试、忽略状态、邮件/短信/微信渠道 | 临时库验证管理员/教师接收、单条/全部已读、机构发送权限、定时到期和撤回隐藏 |
| `/work-data` | `/org/published-work-data` 作品数据中心 | ORG_ADMIN | `真实已有（2026-09-02，P4-O06）` | `student_projects`、`works`、`work_annotations`、`usage_records`、`classes`、`course_lessons`、`users`、`audit_logs` | `GET /api/org/work-data`、`GET /api/org/work-data/export` | 仅 ORG_ADMIN；7/14/30 日；班级/课时/学员范围校验；导出审计 | 访问去重、趋势、授权访客、公开分享 | 仅统计已有创作、审核发布、反馈与成功 AI 用量；导出仅含脱敏学员别名 |
| `/enrollment` | `/org/student-orders` 学员开通 | ORG_ADMIN | `页面壳层` | 需新增开通单/商品表 | 待新增 | 履约、收款、作废状态机 | 数据模型与 API | 设计迁移后实施 |
| `/recharge` | `/org/recharge` 积分充值 | ORG_ADMIN | `真实账务视图（2026-09-02）；在线支付仍外部决策` | `org_billing_accounts`、`recharge_orders`、`credit_entries` | 新增 `GET /api/org/billing/account-overview` | 仅 `ORG_ADMIN`；教师返回 `ORG_BILLING_PERMISSION_DENIED`；充值单 `PENDING/PAID/CANCELLED/EXPIRED` | 微信/支付宝支付回调、冻结金额、退款/冲正、人工调整、导出对账 | 管理员可读余额/累计/订单/流水；教师 403；不伪造到账数据 |
| `/materials` | `/org/promo-materials` 宣传物料 | ORG_ADMIN、TEACHER | `真实已有（2026-09-02，查看与使用）` | `promo_materials`、`promo_material_assignments`、`promo_material_events` | `GET /api/org/materials`、`POST /api/org/materials/:id/events` | 仅当前机构可见；物料 `ACTIVE`；查看/使用/下载事件受服务端校验 | 真实上传、OSS、封面、下载代理、访问签名和统计详情 | 临时库验证全局/指定机构可见范围、使用事件和未配置资源时下载拒绝 |
| `/hackathon` | `/org/hackathon` 黑客松 | ORG_ADMIN | `产品取消（2026-09-02）` | 不新增 | 不新增 | 不建设报名、投稿、初审或排名状态机 | 用户已明确确认不做；现有页面仅为历史壳层 | 不进入开发与验收；后续导航 / 路由清理时移除 |
| `/afee` | `/org/mp-notify` 阿飞提醒 | ORG_ADMIN | `页面壳层` | 需新增微信绑定/访客表 | 待新增 | 绑定状态机 | 微信开放平台对接 | 外部决策 |

## 5. 学生端入口清单（11 个）

|---|---|---|---|---|---|---|---|---|
| `/dashboard` | 学生学习首页 | STUDENT | `真实已有` | `student_projects`、`works`、`classes`、`class_members` | 现有项目/画布/作品 API | 项目与作品状态机已有 | 班级、课程、课单、任务、套餐用量 | 需先补班级视角 API |
| `/projects` | 我的创作项目 | STUDENT | `真实已有` | `student_projects`、`project_snapshots` | projects CRUD、版本、导入导出 | 草稿/归档 | 云同步冲突、批量管理 | P3 项目回归 |
| `/projects/:projectId/canvas` | 创作画布 | STUDENT | `真实已有（画布冻结）` | `student_projects`、`project_snapshots` | projects API | 草稿/提交 | 不修改 `packages/canvas` | 仅回归，不做画布改动 |
| `/works` | 我的作品 / 提交记录 | STUDENT | `真实已有` | `works` | works submit/status | `PENDING/APPROVED/REJECTED/PUBLISHED` | 独立发布、重新发布、下架 | 学生只能访问本人作品 |
| `/showcase` | 公开作品墙 | STUDENT | `真实已有` | `works` | showcase | `PUBLISHED` | 浏览计数与访客模型 | 当前只显示已发布作品 |
| `/courses` | 我的课程 | STUDENT | `真实已有（2026-09-02）` | `class_members`、`class_curriculum_items`、`course_series`、`course_lessons`、`student_projects`、`works` | `GET /api/student/courses` | 课单进度；学生本人 / 机构隔离 | 学习首页任务、老师通知、继续创作聚合待补 | 临时库验证课程、班级、课时、作品状态与空态；学生只能看到本人数据 |
| `/credits` | 套餐与用量 | STUDENT | `真实已有（2026-09-02）` | `users`、`billing_packages`、`usage_records`、`student_projects`、`class_sessions`、`classes` | `GET /api/student/credits` | 套餐有效期；学生本人 / 机构隔离 | 真实扣费服务、充值与对账仍属后续 / 外部决策 | 临时库验证额度、模态 / 状态 / 天数筛选、课堂上下文与越权 |
| `/account` | 账号安全 | STUDENT | `真实已有（2026-09-02）` | `users`、`sessions`、`organizations`、`classes`、`class_members` | `GET/PUT /api/student/account`、`/profile`、`/password`、`/sessions/:id/revoke` | 账号状态；敏感操作需本人当前密码；学生不可改机构归属 | 头像、监护人资料、隐私设置、注销 / 数据请求入口待补 | 临时库验证资料校验、旧密码 / 弱密码 / 重放、当前及跨学生会话撤销 |
| `/inbox` | 消息中心 | STUDENT | `真实已有（2026-09-02）` | `notifications`、`notification_recipients` | `GET /api/student/inbox`、`PUT /api/student/inbox/:id/read`、`PUT /api/student/inbox/read-all` | 仅本人已投递且当前机构范围内的 `PUBLISHED` 消息；支持单条/全部已读 | 忽略状态、失败重试、外部通知通道 | 临时库验证平台公告、机构学生通知、定时到期、已读持久化、撤回隐藏与跨端越权 |
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
2. **P4-02 学生课程与账号闭环（2026-09-02 第一批已完成）**：学生课程、额度、账号安全已接通现有表和真实 API；学习首页任务聚合、AI 能力中心增强、头像 / 监护人 / 隐私 / 注销等剩余项转入后续批次。
3. **P4-03 通知与物料闭环（2026-09-02 第二批已完成）**：在第一批基础上补齐通知模板、逻辑定时发布与补偿扫描、学生消息中心、物料统计详情和接收范围同步；失败重试、高可用队列、外部通知通道、真实上传与下载代理转入后续基础设施批次。
4. **P4-04 黑客松 / 运营活动（2026-09-02 产品取消）**：用户明确确认不做；平台端和机构端均不新增相关数据表、API 或真实页面，历史 `/hackathon` 壳层后续从导航与路由移除。
5. **P4-O01 机构首页真实经营看板第一批闭环（2026-09-02 已完成）**：`GET /api/org/overview` 已实现机构管理员经营视图、教师教学视图、本人负责 / 授权班级范围、近期课堂、待点评作品、未读消息及合同 / 席位 / 余额预警；不依赖支付、OSS 或真实 AI。
6. [x] **P4-O03 班级、课程与排课闭环增强（2026-09-02 已完成）**：已补齐班级详情、成员与课程计划聚合、课时连续排序、普通 / 补课课堂、结束 / 取消、课堂历史和课程进度，并统一教师范围、归档保护及学生已发布内容隔离。
7. [x] **P4-O04 课堂内 AI 能力控制与使用审计（2026-09-02 已完成）**：已接通服务端课堂暂停、能力开关、单学生调用上限、课堂积分上限、普通调用 / 生成任务审计和机构端用量查询。
8. [x] **P4-O05 作品社区运营闭环（2026-09-02 已完成）**：已补齐版权 / 机构内展示授权确认、`PENDING → APPROVED → PUBLISHED` 审核发布、精选、举报处理、下架、作者脱敏、教师负责 / 授权班级范围和审计；评论 / 点赞未启用。
9. [x] **P4-O06 作品数据中心（2026-09-02 已完成）**：已按班级 / 课程课时 / 学员下钻活跃、完成、提交、发布、反馈与成功 AI 用量，补齐 ORG_ADMIN 权限、过滤校验、统计口径和脱敏导出审计。`/work-data` 已从壳层接通真实 API，不包含访问量、访客或公开分享统计。
10. [x] **P4-O07 套餐、学员开通与席位管理（2026-09-02 已完成）**：已形成套餐席位配置、待开通单、线下履约登记、开通 / 停用 / 恢复 / 续费 / 作废、到期扫描、学生权限失效和审计 / 事件留痕闭环；仅 `ACTIVE` 占用席位。在线支付、支付回调、自动续费和自动消息提醒未实现。
11. [x] **P4-O08 积分充值、用量和对账（2026-09-03 已完成）**：机构积分账务已形成期初流水、冻结、人工调整、退款 / 冲正、原子扣减、流水复算、筛选导出和失败任务不扣费规则；在线支付、支付回调、自动续费与真实充值成功状态未接入，也未伪装。

## 8. 本轮总验收（P4-00 / P4-01 / P4-02 / P4-03 / P4-O01 / P4-O02 / P4-O03 / P4-O04 / P4-O05 / P4-O06 / P4-O07 / P4-O08）

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

### 8.3 P4-02 第一批验收记录（2026-09-02）

- [x] `node --check apps/server/src/routes/student.js` 通过。
- [x] 临时 SQLite 初始化 + seed 后，P4-02 API 验收 `11 pass / 0 fail`：覆盖学生登录、课程 / 额度 / 账号返回结构、非法天数 / 状态、平台 / 机构 / 教师越权、跨学生会话撤销与未登录访问。
- [x] `node .\p3-api-integration.mjs` 回归通过，`46 pass / 0 fail`。
- [x] `pnpm.cmd run build` 四端生产构建全部通过。
- [x] 学生端 `/courses`、`/credits`、`/account` 已由页面壳层升级为真实 API 页面；账号改名、改密后强制重新登录、会话撤销已形成闭环。
- [x] 本次仅修改非画布代码与文档，`packages/canvas` 无改动，不触碰真实 `platform.db`，不部署线上环境。
- [ ] 已知边界：学习首页任务聚合、真实 AI / 充值服务、头像 / 监护人 / 隐私 / 注销与数据请求入口仍未实现。

### 8.4 P4-03 第一批验收记录（2026-09-02）

- [x] `node --check apps/server/src/routes/communication.js` 通过。
- [x] 临时 SQLite 初始化 + seed 后，P4-03 API 验收 `19 pass / 0 fail`：覆盖平台通知空态、发布、机构/教师接收、单条已读、机构内部通知权限、物料空态、元数据创建、机构可见范围、使用事件、未配置资源时下载拒绝、撤回隐藏和跨端越权。
- [x] `node .\p3-api-integration.mjs` 回归通过，`46 pass / 0 fail`。
- [x] `pnpm.cmd run build` 四端生产构建全部通过；`git diff --check` 通过。
- [x] 平台端 `/inbox`、`/materials` 与机构端 `/inbox`、`/materials` 已由页面壳层升级为真实通知/物料元数据页面；通知按机构/角色投递，物料按机构隔离，事件和权限在服务端校验。
- [x] 第一批结束时登记的边界中，通知定时发布、模板、物料统计详情和学生端通知中心已在第二批完成；当前仍缺失败重试、高可用异步队列、邮件/短信/微信、真实文件上传、OSS、封面上传、下载代理/签名和阿飞提醒。
- [x] 本次仅修改非画布代码与文档，`packages/canvas` 无改动，不触碰真实 `platform.db`，不部署线上环境。

### 8.5 P4-03 第二批验收记录（2026-09-02）

- [x] 新增 `notification_templates` 表及平台模板查询、创建、更新 / 启停 API；平台页面可保存当前通知为模板并套用。
- [x] 通知支持逻辑 `SCHEDULED`：数据库保持现有约束，以 `status='DRAFT' + publish_at` 保存；服务进程每 15 秒扫描，平台 / 机构 / 学生收件箱 GET 时补偿扫描，到期后生成投递并写入原发送人审计。
- [x] 学生端新增 `/inbox` 与本人收件箱、单条已读、全部已读 API；平台公告和机构学生通知均通过本人接收记录、机构范围和发布状态校验。
- [x] 平台物料新增 `GET /api/admin/materials/:id/stats`，返回 VIEW / USE / DOWNLOAD 汇总、机构 / 用户数量、按机构聚合与最近事件。
- [x] 发布 / 重新发布会删除不再属于新目标范围的旧接收记录，同时保留仍在范围内用户的既有已读状态。
- [x] 临时 SQLite 初始化 + seed 后，P4-03 第二批 API 验收 `35 pass / 0 fail`；覆盖模板、即时 / 定时通知、学生与机构收件箱、已读持久化、物料事件统计、撤回隐藏和跨端越权。
- [x] `node .\p3-api-integration.mjs` 回归通过，`46 pass / 0 fail`；`pnpm.cmd run build` 四端生产构建通过；后端语法与 `git diff --check` 通过。
- [x] 本次仅修改非画布代码与文档，`packages/canvas` 无改动，不触碰真实 `platform.db`，不部署线上环境。
- [ ] 当前边界：投递失败重试、高可用异步队列、邮件 / 短信 / 微信、真实上传 / OSS / 下载代理与签名、阿飞提醒；未将这些外部能力伪装为已完成。

### 8.6 P4-O01 第一批验收记录（2026-09-02）

- [x] `GET /api/org/overview` 已返回角色化 `scope`、机构经营 / 教师教学统计、`breakdown`、近期课堂、待点评作品、未读消息摘要和预警；管理员与教师数据均按当前机构隔离。
- [x] 教师范围验证通过：仅能统计本人负责班级或 `class_members.role='TEACHER'` 且未移除的授权班级；跨教师课堂 / 作品 / 用量不可见；不返回机构积分余额和教师总席位。
- [x] 机构管理员范围验证通过：可看到本机构活跃班级、活跃课堂、学员、教师、作品、积分余额、合同 / 席位 / 余额预警；第二机构数据不可见。
- [x] 通知验证通过：发布平台公告后，教师首页只返回本人未读且已投递的消息摘要；空数据使用真实空态，不伪造数字或消息。
- [x] `apps/org/src/main.jsx` 已展示角色化标题、统计口径、提醒、未读消息、近期课堂、待点评作品和刷新入口；修正教师席位展示文案模板错误。
- [x] 临时 SQLite 验证完成；后端语法、P3 API 回归 `46 pass / 0 fail`、`pnpm run build` 四端生产构建和 `git diff --check` 通过。
- [x] 本批仅修改非画布代码与文档，`packages/canvas` 无改动，不触碰真实 `platform.db`，不部署线上环境。
- [x] 教师授权班级的统一读取 / 管理规则已在 P4-O02 收敛到 `/api/org/classes`、班级详情 / 课单、课堂、`/api/org/works`、作品点评和机构用量接口；更深层作品数据下钻、统计和导出转入 P4-O06。
### 8.7 P4-O02 验收记录（2026-09-02）

- [x] 已复用并核对 `users`、`sessions`、`class_members`、`classes`、`audit_logs` 结构；未新增表，未触碰真实 `platform.db`。
- [x] 机构管理员账号管理闭环已完成：创建 / 编辑 / 启停、手机号 / 登录名冲突校验、教师权限码校验、教师席位校验、重置密码及会话撤销、禁止自停用。
- [x] 批量导入支持 CSV / TSV 前端解析、预览逐行错误、教师席位检查和提交时整批原子写入；无效班级、重复登录名 / 手机号等失败不会留下部分数据。
- [x] 教师授权班级和学生调班已接入 `PUT /api/org/users/:id/classes`；教师可访问本人负责或未移除授权班级，班级、课堂、作品、点评和用量接口统一执行同一范围规则。
- [x] 机构管理员可通过 `GET /api/org/audit-logs` 查询成员、班级授权和账号状态等操作审计；跨机构数据隔离通过。
- [x] 临时 SQLite P4-O02 API 验收 `38 pass / 0 fail`；P3 API 回归 `46 pass / 0 fail`；`node --check apps/server/src/routes/adminOrg.js`、四端 `pnpm.cmd run build` 和 `git diff --check` 通过。
- [x] 本批仅修改非画布代码与文档，`D:\学习平台\platform-v2\packages\canvas` 无改动，不部署线上环境。
- [x] 已知边界：更深层作品数据中心、统计下钻 / 导出、外部身份同步和邮件 / 短信 / 微信通知不在 P4-O02；P4-O03 已完成，后续按 P4-O04 及后续批次推进。
### 8.8 P4-O03 验收记录（2026-09-02）

- [x] 班级详情已聚合成员、课程计划、课堂历史、课程进度，以及开始 / 提交 / 发布统计；机构端班级页面已支持教师选择、成员加入 / 移出、课单配置、课时添加 / 移除 / 上移 / 下移、普通课堂 / 补课、结束 / 取消和历史 / 进度查看。
- [x] 后端已接通 `GET /api/org/classes/:id`、`GET /api/org/classes/:id/sessions`、`GET /api/org/classes/:id/progress`、`PUT /api/org/classes/:id/curriculum`、`POST /api/org/classes/:id/sessions/start`、`POST /api/org/classes/:id/sessions/makeup`、`POST /api/org/classes/:id/sessions/:sessionId/end`、`POST /api/org/classes/:id/sessions/:sessionId/cancel`；教师仅可访问本人负责 / 授权班级。
- [x] 已复用 `classes`、`class_members`、`class_curriculum_items`、`class_sessions`，并为 `class_sessions` 增加兼容迁移字段 `session_kind TEXT NOT NULL DEFAULT 'REGULAR'`；服务端重新生成连续 `sort`，返回课时名称及开始 / 结束人员名称。
- [x] 状态机与权限验收通过：活动课堂不可重复开启；已结束 / 已取消课堂不可重复操作；归档班级不可修改成员、课程计划或开课；非法教师、跨教师、跨机构和学生未发布课时访问均被拒绝。
- [x] 临时 SQLite P4-O03 主验收、跨机构 / 未发布内容隔离验收均通过；P3 API 回归 `46 pass / 0 fail`；`node --check`、四端 `pnpm.cmd run build` 和 `git diff --check` 通过。
- [x] 本批仅修改非画布代码与文档，`D:\学习平台\platform-v2\packages\canvas` 无改动，不触碰真实 `platform.db`，不伪造 AI、支付、OSS 或运营数据，不部署线上环境。
- [x] 已知边界：课堂内 AI 能力控制与使用审计切换为 P4-O04；课程资产、导出与更深层作品数据下钻等能力继续保留在后续批次，未将这些能力伪装为已完成。
### 8.9 P4-O04 完整验收记录（2026-09-02）

- [x] 已新增 `class_sessions.ai_paused`、`class_sessions.student_call_cap` 及兼容旧 SQLite 的迁移；`usage_records.generation_job_id` 与课堂 / 生成任务查询索引可用。
- [x] 已接通机构课堂 AI 控制接口、机构端控制面板、机构 AI 使用审计接口，以及学生普通 AI 调用 / 素材生成的课堂策略校验。
- [x] 临时 SQLite API 验收 `36 pass / 0 fail`：暂停、能力关闭、单学生调用次数上限、课堂积分上限、普通调用 BLOCKED 审计、生成任务失败审计、成功任务关联、教师课堂范围和机构接口越权均通过。
- [x] P3 API 回归 `46 pass / 0 fail`、四端生产构建、后端语法检查和最终 `git diff --check` 全部通过；总控与本清单已完成最终勾选，并将下一步切换为 P4-O05。
- [x] 本阶段仅修改非画布代码与文档；`D:\学习平台\platform-v2\packages\canvas` 无改动，不触碰真实 `platform.db`，不部署线上环境。

### 8.10 P4-O05 验收记录（2026-09-02）

- [x] 数据模型：`works` 新增版权 / 展示授权确认、精选时间 / 操作人 / 原因字段；新增 `work_reports`、状态 / 动作约束和机构 / 作品查询索引；旧 SQLite `works` 表兼容迁移通过。
- [x] 服务端：学生提交需 `copyrightConfirmed: true`；作品审核按 `PENDING → APPROVED → PUBLISHED` 执行；发布、精选、下架与举报处理均在服务端强制权限、状态和审计。
- [x] 未成年人保护：仅当前机构内已发布作品可见，作者名脱敏；无公开分享、评论或点赞；学生只能举报他人作品，举报不可重复待处理，机构 / 平台均有留痕处理闭环。
- [x] 页面：学生端提交授权、作品墙搜索 / 精选 / 举报；机构端审核 / 举报队列；平台端作品精选 / 下架 / 举报处理均已接通真实 API。
- [x] 验证：临时 SQLite P4-O05 API `52 pass / 0 fail`，旧 SQLite 迁移演练通过；P3 回归 `46 pass / 0 fail`、后端语法、四端 `pnpm.cmd run build` 和 `git diff --check` 通过。
- [x] 边界：评论 / 点赞本批不启用；作品数据下钻、统计和导出转入 P4-O06。画布未修改，真实 `platform.db` 未触碰，未部署线上环境。

### 8.11 P4-O06 验收记录（2026-09-02）

- [x] 服务端已新增 `GET /api/org/work-data`、`GET /api/org/work-data/export`：仅 `ORG_ADMIN` 可访问，周期只允许 7 / 14 / 30 日；`classId`、`lessonId`、`studentId` 均按当前机构校验，跨机构或不存在资源返回明确 404。
- [x] 统计按班级、课程课时、学员三层下钻，返回活跃学员 / 项目、完成项目、提交、审核发布、教师反馈、成功 AI 调用 / 积分及最近活动；统计口径随接口返回。活跃、完成、发布、反馈、AI 均基于已有业务记录，未捏造访客、浏览、趋势或公开分享数据。
- [x] 机构端 `/work-data` 已从静态壳层切换为真实页面，支持周期及班级 / 课时 / 学员筛选、指标卡、三层表格、口径说明和刷新；机构管理员导航可见，教师进入时显示权限说明。
- [x] 导出由服务端提供列与汇总行、前端生成 UTF-8 BOM CSV；仅包含“张同学”式脱敏别名与数字，不返回学员 ID、登录名、手机号或完整姓名；每次导出写入 `ORG_WORK_DATA_EXPORT` 审计。
- [x] 已增加统计查询索引：`student_projects(org_id,class_id,course_lesson_id,updated_at)`、`works(org_id,class_id,course_lesson_id,submitted_at)`、`usage_records(org_id,project_id,created_at)`。
- [x] 临时 SQLite P4-O06 API 验收通过：覆盖 7 / 14 / 30 日、非法周期、三层筛选、真实项目保存 / 提交 / 审核发布 / 批注 / 成功 AI 用量、FAILED / BLOCKED 不计入、脱敏导出和审计、教师 / 学员 403、跨机构过滤及空数据机构；P3 API 回归 `46 pass / 0 fail` 通过。
- [x] 边界：访问去重、访客趋势、授权访客与公开分享模型仍是后续能力；本批未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上环境。

### 8.12 P4-O07 验收记录（2026-09-02）

- [x] 数据模型：`billing_packages` 增加 `student_seats` 及旧 SQLite 兼容迁移；新增 `student_enrollments` 与 `student_enrollment_events`，保存套餐 / 价格快照、有效期、线下履约状态、操作者和过程事件。
- [x] 状态与席位：开通单仅允许 `PENDING → ACTIVE / VOIDED`、`ACTIVE → SUSPENDED / EXPIRED / VOIDED`、`SUSPENDED / EXPIRED → ACTIVE` 等服务端校验后的转移；仅 `ACTIVE` 占用套餐席位，超额开通返回 `409 STUDENT_SEAT_LIMIT`，套餐不得降到已占用席位以下，存在生效开通单时不能直接停用套餐。
- [x] 权限失效：停用或到期时，服务端停用学生账号、清除套餐关联和个人套餐额度并撤销既有会话；恢复 / 续费重新校验可用席位。列表 / 详情请求会执行到期扫描，机构页显示 30 日内到期数量和记录。
- [x] API 与页面：机构管理员已可使用套餐列表 / 配置及开通单列表、详情、创建、线下履约登记、开通、停用、恢复、续费、作废接口；机构端 `/packages`、`/enrollment` 已接通真实页面。教师访问开通单被服务端拒绝并显示权限说明。
- [x] 验证：临时 SQLite P4-O07 API 验收通过，覆盖管理员 / 教师权限、套餐席位统计、待开通单、线下登记、完成开通、超席位拒绝、套餐保护、停用释放席位与登录拒绝、续费、到期扫描、到期后登录拒绝、审计和事件留痕；P3 API 回归通过。
- [x] 最终检查：`node --check apps/server/src/routes/adminOrg.js`、`node --check apps/server/src/lib.js`、`node --check packages/database/src/schema.js`、`node --check packages/database/src/seed.js`、`pnpm.cmd run build` 与 `git diff --check` 通过。画布未修改，真实 `platform.db` 未触碰，未部署线上。
- [ ] 边界：线下履约仅登记 `UNRECORDED / RECORDED / WAIVED`，未接入或伪造在线支付、支付回调、自动续费；到期仅提供数据扫描和机构端提示指标，未接入自动消息推送。

### 8.13 P4-O08 验收记录（2026-09-03）

- [x] 数据模型：`org_billing_accounts` 新增 `frozen_credits`；`credit_entries` 新增 `reversal_of` 与唯一部分索引；旧 SQLite 兼容迁移通过；seed 为示例机构写入真实 `OPENING_BALANCE` 期初流水，未伪造充值订单。
- [x] 账务规则：人工调整仅允许 `ORG_ADJUSTMENT_IN / ORG_ADJUSTMENT_OUT` 且原因必填；退款 / 冲正会插入反向流水、将源流水标记 `VOIDED` 并拒绝重复处理；负向调整、退款和扣减只消耗可用余额，冻结积分不可被直接动用。
- [x] 冻结与复算：冻结 / 解冻写入 `FROZEN_HOLD / FROZEN_RELEASE` 留痕但不计入收支净额；对账恒等式为“可用余额 + 冻结积分 = 排除冻结留痕与已冲销反向记录后的流水净额”。
- [x] 原子扣减：普通 AI 调用与生成任务统一走条件更新，扣减成功才写流水；0 积分调用跳过账务流水但保留用量记录；并发验证 12 笔 10000 积分扣减仅成功 9 笔，最终不透支且复算一致。
- [x] 失败任务规则：AI 生成任务成功后才扣积分；策略拦截记录一条 `BLOCKED`，provider / 生成失败记录一条 `FAILED`，均为 0 积分并保留失败码，不产生自动退款流水。专项验收确认 job `FAILED`、仅一条 0 积分用量、机构余额不变。
- [x] API 与页面：管理员可用账务总览、可筛选积分流水、人工调整、冻结设置、退款、冲正、对账与 CSV 导出接口；机构端 `/recharge` 升级为积分账务工作台；教师访问账务接口返回 403。
- [x] 验证：临时 SQLite P4-O08 API 验收 `51 pass / 0 fail`；失败任务专项 `19 pass / 0 fail`；P3 API 回归 `48 pass / 0 fail`；后端 `node --check`、四端 `pnpm.cmd run build`、`git diff --check` 均通过。
- [x] 边界：在线支付、支付回调、自动续费和真实充值成功状态未实现；导出动作写入审计。本批未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上环境。
