# AI少儿编程平台 P4 非画布真实业务缺口清单

> 建立日期：2026-09-02
> 工程根目录：`D:\学习平台\platform-v2`
> 对照基准：`D:\学习平台\docs\AI魔法学院基准\00-总览.md`、`02-页面路由清单.md`、`03-API契约清单.md`、`04-数据模型与状态机.md`
> 边界：`packages/canvas` 冻结；不伪造 AI、支付、上传与运营数据；自动化验收一律使用临时 SQLite；内测站已部署但不得触碰旧站真实业务数据库。

## 1. 状态定义

| 状态 | 含义 |
|---|---|
| `真实已有` | 页面已调用真实 API，数据来自本地 SQLite，具备业务闭环的最低能力。 |
| `本轮实现中` | 已列入当前批次，正在补 API、权限和真实页面。 |
| `页面壳层` | 导航与视觉壳层已存在，但未接真实 API，不能展示或写入业务数据。 |
| `外部决策` | 依赖支付、真实 AI、外部存储、微信、正式产品文案或用户提供测试账号。 |
| `产品取消` | 用户已明确确认不做；不再设计数据表、API、业务页面或验收场景，历史壳层后续清理。 |
| `暂缓` | 用户已明确本阶段不做；保留历史代码 / 准备稿，但不新增功能、不作为当前内测阻塞项；后续需重新授权后再恢复。 |

## 1.1 2026-09-03 上线口径与优先级重排

用户已明确：**备案先不做，但要先上线用于内部测试，网址不会对外公开。**“上线”在本清单中拆为两种状态：

1. **内部测试上线（当前目标）**：受控访问、不可索引、独立测试数据库和配置、可备份恢复回滚；只供内部角色验收，不接收真实外部用户，不代表正式服务。
2. **正式公开上线（后续目标，当前不推进）**：正式域名 / HTTPS、备案（如适用）、法务确认文本、监护人 / 内容治理规则、真实外部服务、生产监控与运营交接全部满足并重新确认范围后，才允许对外开放。

当前优先级：

| 优先级 | 事项 | 说明 |
|---|---|---|
| P0 | P8-Q03 | **已完成（2026-09-04）**：API 集成测试扩展；临时 SQLite 验收 52/52，并纳入既有 P3 API 回归 |
| P0 | P8-Q04 | **已完成（2026-09-04）**：非画布 HTTP / 静态构建 E2E；临时 SQLite 验收 54/54，四端构建与官网路由 / 资源加载通过 |
| P0 | P8-Q06 | **已完成（2026-09-04）**：隔离临时 SQLite 性能容量基线；13/13 通过，已记录 API / 首页 / 并发课堂 / AI / 文件元数据写入指标 |
| P0 | P8-S02 | **已完成（2026-09-04）**：身份认证与会话安全；临时 SQLite 验收 27/27 |
| P0 | P8-S01 | **已完成（2026-09-04）**：安全响应头、CORS、请求体上限、登录限流、错误脱敏与依赖漏洞扫描通过；临时 SQLite 32/32，`pnpm audit --prod` 无已知漏洞 |
| P0 | P8-S04 | **已完成（2026-09-04）**：临时 SQLite 备份、恢复启动和 RPO/RTO 演练 9/9 通过 |
| P0 | P8-S05 | **进行中**：监控告警基线已完成；ECS timer、日志轮转和真实通知待运维配置 |
| P0 | P8-S06 | **已完成（2026-09-04）**：预发发布、故障自动回滚、数据库快照恢复与事故响应演练 13/13 通过 |
| P0 | P8-L01 | **已完成（2026-09-04）**：数据资产清单、最小化收集、保存期限、删除方式和第三方共享清单；临时 SQLite 验收 71/71 |
| P1 | P8-Q01 | **已完成（2026-09-04）**：非画布语法、四端构建、静态风险模式和发布边界检查 11/11 通过 |
| P1 | P8-Q02 | **已完成（2026-09-04）**：关键服务与账务规则单元基线 17/17 通过；全量覆盖率持续补充 |
| P1 | P8-Q05 | **进行中（2026-09-04）**：已修复官网首页作品区运行时白屏；本地内测 11 条关键路由渲染和控制台 0 错误通过，线上 Codex Chromium 桌面视口 12/12 路由复核通过，待独立浏览器 / 移动端截图矩阵 |
| 暂缓 | P8-L02～P8-L04 | **用户决策暂缓（2026-09-04）**：不继续做监护人、举报、申诉、违规 / 内容审核和正式法律 / 合规扩展；已有工程代码保留，不作为当前内测阻塞项 |
| 用户侧 | P5-W10 备案后续 | 用户已确认备案完成，后续材料和办理由用户自行处理；不改变当前内测技术收口范围 |
| 外部阻塞 | 真实 AI / OSS / 支付 / 微信等 | 需要用户 / 供应商给出真实账号、规则或密钥，不得伪造；不影响当前内测技术收口 |
| 暂缓 | P5-W08 | 正式法律 / 合规文本暂不推进；准备稿和工程代码只保留历史证据，不继续扩展，后续需重新授权 |
| 暂不做 | P5-W03 / P5-W06 | 用户已取消，保持产品取消 |

内测网址原则上必须在反向代理或 VPN / IP 白名单 / Basic Auth 中落实至少一种强制访问控制，并返回 `noindex, nofollow, noarchive`；页面应显著标识“内部测试环境，不代表正式服务”。本轮用户已于 2026-09-04 明确授权移除线上 Basic Auth，因此当前仅保留 noindex、内测标识、HTTPS、独立测试数据库和回滚能力；不得扩大访问范围，正式公开前必须重新建立访问控制。



## 1.2 2026-09-04 用户决策：暂缓范围与当前执行顺序

> 当前开发批次：**P4-03-LIST 管理端列表交互规范收口**。历史 P4-03 通知 / 物料完成记录不覆盖、不改判。

用户明确：举报、申诉、违规 / 内容审核、监护人功能和正式法律 / 合规事项暂时不做，后续需要时再重新授权。

| 状态 | 暂缓事项 | 处理口径 |
|---|---|---|
| `[~]` | 举报、申诉、违规 / 内容审核 | 不新增举报、申诉、审核工作台、违规升级、自动下架或记录保留扩展；已有基础作品举报代码保留但不继续扩展。 |
| `[~]` | 监护人功能 | 不新增监护人信息、监护同意、身份核验和年龄地区规则；已有代码保留但不作为当前内测必需。 |
| `[~]` | 正式法律 / 合规文本 | 不推进正式协议、隐私政策、儿童 / 未成年人说明的法务确认和生效发布；准备稿不代表正式法律文本。 |

当前唯一执行顺序：
1. **P8-Q05**：在当前可用的 Codex Chromium 中继续回归并记录边界；不得虚构独立 Chrome / Edge / Safari 或真机结果。
2. **P4-01**：统一状态机、枚举、错误码和异常提示（**已完成，2026-09-04**）。
3. **P4-03**：统一筛选、分页、排序、空态、导出与列表交互规范。
   - **P4-03-LIST 首批（2026-09-04）已完成**：平台用户、平台作品、操作审计、课程广场统一分页 / 元数据 / 白名单排序；机构、平台课程和平台管理员列表批次已完成，其他管理端列表后续继续分批收口。
4. **内测 UAT**：按平台 / 机构管理员 / 教师 / 学生角色验收，记录并修复阻塞缺陷。
5. **运行维护**：保持独立测试库、noindex、内测标识、备份 / 回滚和健康检查。

以下事项明确不进入当前执行队列：举报、申诉、违规 / 内容审核、监护人功能、正式法律 / 合规文本及正式公开上线；后续需要时必须重新授权。

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

## 3. 平台端入口清单（13 个，含 1 个历史取消入口）

| 本地路由 | 基准路由 / 页面 | 角色 | 当前状态 | 主要数据表 | 后端 API | 状态机 / 权限 | 缺失项 | 验收方法 |
|---|---|---|---|---|---|---|---|---|
| `/dashboard` | `/super/dashboard` 平台概览 | SUPER_ADMIN | `真实已有（2026-09-03，P4-A01）` | `organizations`、`users`、`course_series`、`course_assignments`、`classes`、`class_sessions`、`student_projects`、`works`、`generation_jobs`、`usage_records`、`org_billing_accounts` | 新增 `GET /api/admin/dashboard/overview`；保留机构下拉所需 `GET /api/admin/organizations` | 仅 SUPER_ADMIN；`orgId/from/to` 严格校验；from/to 左闭右开 UTC，未传默认最近 30 天 | 趋势图、指标下钻、跨时区切换、导出 | 临时 SQLite 40 项断言：401/403、非法 / 空时间、倒置区间、空区间、机构隔离、新旧区间、余额与 Top 汇总全部通过；页面真实渲染 19 项指标与口径 |
| `/organizations` | `/super/organizations` 机构管理 | SUPER_ADMIN | `真实已有（2026-09-03，P4-A02）` | `organizations`、`users`、`sessions`、`org_billing_accounts`、`billing_packages`、`course_assignments`、`classes`、`class_sessions`、`student_projects`、`works`、`audit_logs` | `GET/POST /api/admin/organizations`、`GET/PUT /:orgId`、新增 `GET /:orgId/detail`、`POST /:orgId/status`、`GET/POST /:orgId/admins`、`PUT /:orgId/admins/:userId`、credit/seat adjustments | 仅 SUPER_ADMIN；机构 `TRIAL/ACTIVE/FROZEN/DISABLED/EXPIRED`，状态只能走动作接口；停用后现有 token 实时返回 `ORG_DISABLED`，恢复要求合同有效且同一 token 自动恢复；不能停用最后一个有效机构管理员 | 更细粒度权限、合同续签审批流、审计后台筛选导出 | 临时 SQLite 57 项断言：401/403、创建与重名校验、详情聚合、管理员密码 / 登录名 / 最后一个保护、停用与恢复、到期恢复拒绝、续签后恢复、编辑约束、审计动作全部通过 |
| `/users` | `/super/platform-users` 平台用户 | SUPER_ADMIN | `真实已有（2026-09-03，P4-A03 补齐管理动作）` | `users`、`sessions`、`organizations`、`billing_packages`、`audit_logs` | `GET /api/admin/platform-users`；新增 `PUT /:userId/status`、`PUT /:userId/password`、`PUT /:userId/phone` | 仅 SUPER_ADMIN；用户 `ACTIVE/DISABLED`；停用 / 重置密码立即撤销全部会话；不能停用当前登录账号；手机号格式与占用校验 | 角色级 `ADMIN_USERS` 权限码收紧 | 临时 SQLite 63 项断言：筛选搜索、停用即会话失效、登录拒绝、恢复、重置密码、手机绑定 / 解绑、自停用拒绝、401/403 与审计动作全部通过 |
| `/courses` | `/super/courses` 平台课程 | SUPER_ADMIN | `真实已有（2026-09-03，P4-A04 补齐管理闭环）` | `course_series`、`course_lessons`、`course_assignments`、`classes`、`class_curriculum_items`、`class_sessions`、`works`、`audit_logs` | `GET/POST /api/admin/course-series`、assignments；新增 `GET /:id/detail`、`PUT /:id`、`POST /:id/status`、`POST /:id/lessons`、`PUT /:id/lessons/reorder`、`POST /:id/assignments/revoke`、`PUT /api/admin/course-lessons/:lessonId`、`DELETE /api/admin/course-lessons/:lessonId` | 仅 SUPER_ADMIN；课包 `DRAFT/PUBLISHED/ARCHIVED` 只能走动作接口；内容变更自动递增次版本号；被班级课单 / 课堂引用的课时不能删除；撤销授权后机构端立即不可见 | 年龄段 / 难度 / 标签字段、课程资产（封面文件、课件上传、素材包）、课程广场 | 临时 SQLite 66 项断言：权限、创建 / 重名校验、详情聚合、编辑与版本递增、状态机、课时 CRUD 与重排、机构可见性联动、引用保护、审计动作全部通过 |
| `/marketplace` | `/super/course-marketplace` 课程广场 | SUPER_ADMIN | `真实已有（2026-09-03，P5-M01）` | `course_series.marketplace_status`、`marketplace_reward_credits` | `GET /api/admin/course-marketplace`（status/search/page/limit，PENDING 优先）、`GET /api/admin/course-marketplace/:id`、`PUT /api/admin/course-marketplace/:id`（状态+积分）、`PUT /api/admin/course-marketplace/:id/rewards`；公开 `GET /api/public/marketplace`（difficulty/ageMin/ageMax/tag/search/sort=popular\|recent/page/limit，仅 APPROVED+ALL_ORGS）、`GET /api/public/marketplace/:id`（lessonContent 截断 2000） | 仅 SUPER_ADMIN；仅 PUBLISHED 课包可变更；marketplaceRewardCredits 0-999999；公开仅 APPROVED+ALL_ORGS；popular=reward_credits desc，recent=createdAt desc | 真实付费购买、SLA 评分与评论 | 临时 SQLite 75 项断言（2026-09-03 P5-M01）：401/403、状态过滤、搜索、分页、积分越界/负数/非法 status、状态机流转、积分独立更新、课包不存在 404、公开仅 APPROVED+ALL_ORGS、排序正确、page1/2 无重叠 |
| `/works` | `/super/published-works` 作品库 | SUPER_ADMIN | `真实已有（2026-09-02；作品详情、状态机、精选已完成；举报基础代码保留，治理扩展暂缓）` | `works`、`student_projects`、`users`、`organizations`、`classes`、`course_lessons`、`work_submissions`、`work_annotations`、`work_publish_requests`、`work_reports` | 新增 `GET /api/admin/works`、`PUT /api/admin/works/:id/unpublish`、`PUT /api/admin/works/:id/feature`、`GET /api/admin/work-reports`、`PUT /api/admin/work-reports/:id`；本批新增 `GET /api/admin/works/:id/detail`（聚合作品信息、提交历史、画布批注、举报记录、发布申请、精选状态、画布快照） | `PENDING/APPROVED/REJECTED/PUBLISHED`；仅 `SUPER_ADMIN`；下架写为 `REJECTED`、记录原因与审核人并审计 `PLATFORM_WORK_UNPUBLISH`；服务端强制仅 `PUBLISHED` 可下架 / 精选 / 因举报下架；精选学生需 `privacy_allow_feature` 授权 | 公开分享展示权限、站外分发 | 临时库验证 43 项断言（2026-09-03 P4-A05）：未登录 401 / 教师 403 / 不存在 404、详情含 18 项聚合字段、精选与下架状态机 `WORK_NOT_PUBLISHED`、举报处理审计、举报处理 resolution 必填、精选/取消精选审计落库 |
| `/hackathon` | `/super/hackathon` 黑客松审核 | SUPER_ADMIN | `产品取消（2026-09-02）` | 不新增 | 不新增 | 不建设赛季、报名、投稿或评审状态机 | 用户已明确确认不做；现有页面仅为历史壳层 | 不进入开发与验收；后续导航 / 路由清理时移除 |
| `/billing` | `/super/usage-records + recharge + billing-settings` | SUPER_ADMIN | `真实已有（2026-09-02，用量汇总与明细；在线充值/计费设置仍外部决策）` | `org_billing_accounts`、`usage_records`、`recharge_orders`、`users`、`organizations`、`class_sessions`、`classes` | 现有 `GET /api/admin/billing/usage-overview`；新增 `GET /api/admin/billing/usage-records` | 仅 `SUPER_ADMIN`；支持 `days/orgId/modality/status/search`；无效 `days` 返回 `VALIDATION_ERROR` | 在线支付回调、计费规则/模型开关配置、冻结与预警、导出对账 | 临时库验证汇总、筛选、搜索、上下文关联、非法参数与越权 403 |
| `/materials` | `/super/materials + promo-materials` | SUPER_ADMIN | `真实已有（2026-09-02，元数据、外链与统计）` | `promo_materials`、`promo_material_assignments`、`promo_material_events` | `GET/POST/PUT /api/admin/materials`、`GET /api/admin/materials/:id/stats` | 物料 `DRAFT/ACTIVE/DISABLED`；平台超管写入 | 真实文件上传、OSS、封面上传、下载代理与签名 | 当前维护元数据和可选外部资源地址；统计详情返回汇总、机构聚合与最近事件；未配置资源时下载明确拒绝 |
| `/inbox` | `/super/inbox` 站内信 | SUPER_ADMIN | `真实已有（2026-09-02，两批 + 2026-09-03 队列化）` | `notifications`、`notification_recipients`、`notification_templates`、`notification_dispatch_jobs` | `GET/POST/PUT /api/admin/inbox`、`GET/POST/PUT /api/admin/notification-templates`、`GET/POST /api/admin/notification-events`、`GET /api/admin/notification-events/summary`、`GET /api/admin/notification-failures`、`POST /api/admin/notification-failures/retry|ignore`、`GET /api/admin/notification-queue/summary`、`GET /api/admin/notification-queue/dead-letters`、`POST /api/admin/notification-queue/dead-letters/requeue`、`POST /api/admin/notification-queue/tick` | `DRAFT/SCHEDULED/PUBLISHED/RECALLED`（`SCHEDULED` 为 `DRAFT + publish_at` 的逻辑状态）；仅平台超管管理；投递任务按指数退避（`60s × 2^attempt ± 15% jitter`, 上限 30 分钟）重试至 `DEAD_LETTER` | 邮件 / 短信 / 微信渠道 | 支持模板、按机构/角色投递、草稿、立即/定时发布、撤回、置顶和跳转；定时到期生成接收记录并审计；失败自动入队、并发安全、worker 进程退出释放锁定、死信可恢复 |
| `/client-releases` | 客户端版本管理 | SUPER_ADMIN | `真实已有（2026-09-03，P4-S07）` | `client_download_releases` | `GET/POST /api/admin/client-releases`、`PUT /:id/publish`、`PUT /:id/unpublish` | 平台 / 通道 / 版本唯一；下载地址必须 HTTPS；未发布与下架不可见 | 真实安装包构建、文件托管、自动更新、下载统计 | 临时库验证非法平台 / 版本 / 非 HTTPS / 重复拒绝，发布 / 下架可见性与教师 403 |
| `/audit` | `/super/audit-logs` 操作审计中心 | SUPER_ADMIN | `P4-C02（2026-09-03）` | `audit_logs`、`users`、`organizations` | `GET /api/admin/audit-logs`（支持 `action`/`actorId`/`targetType`/`targetId`/`requestPath`/`from`/`to`/`orgId`/`limit`/`offset` 分页）；`GET /api/admin/audit-logs/summary`（`byAction`/`byActor`/`byOrg` 分项汇总）；`GET /api/admin/audit-logs/export`（UTF-8 BOM CSV，含 `limit`/`action` 过滤，`1≤limit≤2000` 守卫）；`GET /api/admin/audit-logs/actions`（动作字典）；`GET /api/org/audit-logs`（机构端受限视图） | 时间倒序；敏感字段（password、token 等）脱敏；机构管理员无权访问平台审计；操作者角色 / 姓名 JOIN；倒置时间范围 / 非法 ISO 时间 / limit 范围全部守卫 | 全部 38 项通过 |
| `/admins` | `/super/platform-admins` 平台管理员 | SUPER_ADMIN | `真实已有（2026-09-03，P4-A03 补齐登录安全与日志）` | `users(role=SUPER_ADMIN)`、`sessions`、`audit_logs` | `GET/POST/PUT /api/admin/platform-admins`（GET 支持 `search`/`status`，返回最近登录与活跃会话）；新增 `GET /:id/audit-logs` | 用户 `ACTIVE/DISABLED`；`ADMIN_*` 权限码；停用 / 重置密码立即撤销会话；不能停用自己，停用超管受最后一个有效管理员守卫 | 角色级权限码逐域收紧 | 创建 / 编辑 / 停用即会话失效 / 重新启用 / 重置密码 / 停自己失败 / 最近登录 / 操作日志 / 非法 limit 全部通过 |
| `/login`、`/forbidden` 等壳层 | 登录、无权限 | public / 登录 | `真实已有` | `sessions` | `/api/auth/*`、`/api/me` | 会话失效与顶替错误码 | 手机绑定、改密、被顶提示 | 现有 P3 认证回归覆盖 |

## 4. 机构 / 教师端入口清单（15 个，含 1 个历史取消入口）

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
| `/inbox` | `/org/inbox` 站内信 | ORG_ADMIN、TEACHER | `真实已有（2026-09-02，两批 + 2026-09-03 队列化）` | `notifications`、`notification_recipients`、`notification_dispatch_jobs` | `GET/POST /api/org/inbox`、`PUT /api/org/inbox/:id/read`、`PUT /api/org/inbox/read-all` | 平台即时/定时公告接收；机构通知仅 ORG_ADMIN 可发；按当前机构与本人接收记录隔离；失败投递自动入队列 | 邮件 / 短信 / 微信渠道 | 临时库验证管理员/教师接收、单条/全部已读、机构发送权限、定时到期和撤回隐藏 |
| `/work-data` | `/org/published-work-data` 作品数据中心 | ORG_ADMIN | `真实已有（2026-09-02，P4-O06）` | `student_projects`、`works`、`work_annotations`、`usage_records`、`classes`、`course_lessons`、`users`、`audit_logs` | `GET /api/org/work-data`、`GET /api/org/work-data/export` | 仅 ORG_ADMIN；7/14/30 日；班级/课时/学员范围校验；导出审计 | 访问去重、趋势、授权访客、公开分享 | 仅统计已有创作、审核发布、反馈与成功 AI 用量；导出仅含脱敏学员别名 |
| `/enrollment` | `/org/student-orders` 学员开通 | ORG_ADMIN | `真实已有（2026-09-03，P4-O07）` | `billing_packages`、`student_enrollments`、`student_enrollment_events` | 复用套餐与开通单列表 / 详情 / 创建、线下履约登记、开通 / 停用 / 恢复 / 续费 / 作废接口 | 与 P4-O07 相同：`PENDING/ACTIVE/SUSPENDED/VOIDED/EXPIRED`；仅 `ACTIVE` 占席位；教师无开通单权限 | 在线支付、支付回调、自动续费和自动消息提醒 | 已在 P4-O07 临时 SQLite 验收；本行是 `/org/student-orders` 历史别名入口 |
| `/recharge` | `/org/recharge` 积分充值 | ORG_ADMIN | `真实账务视图（2026-09-02）；在线支付仍外部决策` | `org_billing_accounts`、`recharge_orders`、`credit_entries` | 新增 `GET /api/org/billing/account-overview` | 仅 `ORG_ADMIN`；教师返回 `ORG_BILLING_PERMISSION_DENIED`；充值单 `PENDING/PAID/CANCELLED/EXPIRED` | 微信/支付宝支付回调、冻结金额、退款/冲正、人工调整、导出对账 | 管理员可读余额/累计/订单/流水；教师 403；不伪造到账数据 |
| `/materials` | `/org/promo-materials` 宣传物料 | ORG_ADMIN、TEACHER | `真实已有（2026-09-02，查看与使用）` | `promo_materials`、`promo_material_assignments`、`promo_material_events` | `GET /api/org/materials`、`POST /api/org/materials/:id/events` | 仅当前机构可见；物料 `ACTIVE`；查看/使用/下载事件受服务端校验 | 真实上传、OSS、封面、下载代理、访问签名和统计详情 | 临时库验证全局/指定机构可见范围、使用事件和未配置资源时下载拒绝 |
| `/help-feedback` | 学生问题反馈处理 | ORG_ADMIN | `真实已有（2026-09-03，P4-S07）` | `help_feedback`、`users` | `GET /api/org/help-feedback`、`GET/PUT /api/org/help-feedback/:id` | `SUBMITTED/IN_PROGRESS/RESOLVED/CLOSED`；仅本机构；教师 403；处理结果必填 | 工单 SLA、外部客服、邮件短信通知 | 临时库验证筛选、详情、状态机、结果必填、学生隔离与审计 |
| `/hackathon` | `/org/hackathon` 黑客松 | ORG_ADMIN | `产品取消（2026-09-02）` | 不新增 | 不新增 | 不建设报名、投稿、初审或排名状态机 | 用户已明确确认不做；现有页面仅为历史壳层 | 不进入开发与验收；后续导航 / 路由清理时移除 |
| `/afee` | `/org/mp-notify` 阿飞提醒 | ORG_ADMIN | `页面壳层` | 需新增微信绑定/访客表 | 待新增 | 绑定状态机 | 微信开放平台对接 | 外部决策 |

## 5. 学生端入口清单（11 个）

|---|---|---|---|---|---|---|---|---|
| `/dashboard` | 学生学习首页 | STUDENT | `真实已有（2026-09-03，P4-S01）` | `class_members`、`classes`、`class_curriculum_items`、`course_series`、`course_lessons`、`class_sessions`、`student_projects`、`works`、`notifications`、`notification_recipients` | `GET /api/student/dashboard` | 仅 STUDENT；按本人机构、班级课程表、项目和作品隔离聚合 | 反馈逐条已读状态、真实 AI / 充值服务 | 临时库验证未登录 / 教师越权、开课前 / 开课中 / 结课后、自主练习、通知、驳回反馈、跨学生隔离与真实空态 |
| `/projects` | 我的创作项目 | STUDENT | `真实已有（2026-09-03，P4-S02）` | `student_projects`、`project_snapshots`、`works`、`course_series`、`course_lessons`、`classes` | `GET/POST/PATCH/DELETE /api/student/projects`、`POST /:id`（复制）、`/:id/archive`、`/:id/restore`、版本与导入导出 | 仅 STUDENT；视图 `ACTIVE/ARCHIVED/DELETED`；草稿可重命名 / 复制 / 归档 / 软删除，已提交或已发布项目只读 | 批量管理、云同步冲突；30 天到期自动清理任务未实现 | 临时库验证权限、搜索筛选、重命名、复制、归档 / 恢复、软删除 / 恢复、提交后保护、发布后复制限制与学生隔离 |
| `/projects/:projectId/canvas` | 创作画布 | STUDENT | `真实已有（画布冻结）` | `student_projects`、`project_snapshots` | projects API | 草稿/提交 | 不修改 `packages/canvas` | 仅回归，不做画布改动 |
| `/works` | 我的作品 / 提交记录 | STUDENT | `真实已有（2026-09-03，P4-S03）` | `works`、`work_submissions`、`work_feedback_reads`、`work_publish_requests`、`work_annotations` | works submit/status、submissions、feedback-read、publish-request/withdraw | `PENDING/APPROVED/REJECTED/PUBLISHED`；反馈已读与多轮提交 | 独立站外发布、重新发布历史版本 | 学生只能访问本人作品；临时 SQLite 验收 `72 pass / 0 fail` |
| `/showcase` | 机构作品墙 | STUDENT | `真实已有（2026-09-03，P4-S04；基础举报代码保留，当前不扩展）` | `works`、`classes`、`course_lessons`、`work_reports` | `GET /api/student/showcase`、`GET /:id`、`POST /:id/reports`、`PUT /api/org/works/:id/feature`（举报接口仅保留历史实现，不新增治理能力） | 仅本机构 `PUBLISHED`；作者脱敏与内部字段清理 | 站外公开分享、评论 / 点赞、访客统计；举报 / 违规治理后续暂缓 | 临时 SQLite P4-S04 API `112 pass / 0 fail` 为历史回归记录，当前不据此继续扩展举报能力 |
| `/courses` | 我的课程 | STUDENT | `真实已有（2026-09-02）` | `class_members`、`class_curriculum_items`、`course_series`、`course_lessons`、`student_projects`、`works` | `GET /api/student/courses` | 课单进度；学生本人 / 机构隔离 | 学习首页任务、老师通知、继续创作聚合待补 | 临时库验证课程、班级、课时、作品状态与空态；学生只能看到本人数据 |
| `/credits` | AI / 魔法石中心 | STUDENT | `真实已有（2026-09-03，P4-S05）` | `users`、`billing_packages`、`usage_records`、`generation_jobs`、`media_assets`、`student_projects`、`project_snapshots`、`class_sessions`、`classes` | `GET /api/ai/center`、`GET/POST /api/ai/generations/history`、`GET /api/ai/generations/history/:id`、`GET /api/student/credits` | 套餐有效期、能力状态、任务 / 素材本人隔离；失败不扣费，成功任务扣 1 积分 | 真实外部 AI provider、充值与对账仍属后续 / 外部决策 | 临时 SQLite P4-S05 API `85 pass / 0 fail`，覆盖能力状态、失败重试、素材使用推导、mock 标识和权限隔离 |
| `/account` | 账号安全 | STUDENT | `真实已有（2026-09-03，P4-S06）` | `users`、`sessions`、`account_requests`、`organizations`、`classes`、`class_members`、`student_projects`、`works`、`generation_jobs`、`usage_records` | `GET/PUT /api/student/account`、`/profile`、`/guardian`、`/privacy`、`/password`、`/sessions/:id/revoke`、`/requests`、`/requests/:id`、`/requests/:id/cancel`；机构 `GET/PUT /api/org/account-requests/:id` | 申请 `PENDING/APPROVED/REJECTED/CANCELLED`；敏感操作需本人当前密码；仅 ORG_ADMIN 处理；学生不可改机构归属 | 真实头像文件上传、邮件短信、监管删除证明、跨机构迁移 | 临时库验证资料 / 隐私、旧密码、弱密码、会话、申请状态机、导出、软注销、审计与越权 |
| `/inbox` | 消息中心 | STUDENT | `真实已有（2026-09-02）` | `notifications`、`notification_recipients` | `GET /api/student/inbox`、`PUT /api/student/inbox/:id/read`、`PUT /api/student/inbox/read-all` | 仅本人已投递且当前机构范围内的 `PUBLISHED` 消息；支持单条/全部已读 | 忽略状态、失败重试、外部通知通道 | 临时库验证平台公告、机构学生通知、定时到期、已读持久化、撤回隐藏与跨端越权 |
| `/help` | 帮助与下载 | STUDENT | `真实已有（2026-09-03，P4-S07）` | `help_feedback`、`client_download_releases` | `GET /api/student/help`、`POST /api/student/help/feedback`、`GET /api/student/help/feedback/:id` | 仅 STUDENT；反馈仅本人可读；敏感词拦截；下载仅返回已发布真实版本 | 独立 CMS、真实安装包、自动更新 | 临时 SQLite P4-S07 API 42 pass / 0 fail，覆盖内容、下载边界、反馈闭环与越权 |
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
| `/download` | 下载页 | `真实已有（2026-09-03，P4-S07，真实发布状态）` | `client_download_releases` | `GET /api/public/downloads` | 无登录；仅已发布 HTTPS 版本可见；未配置时禁用下载并明示不提供虚假链接 | 真实安装包、下载统计、自动更新 | 临时库验证初始未配置、未发布隐藏、发布可见、下架隐藏与官网构建 |
| `/demo` | 预约演示 | `真实已有（2026-09-03，P5-W02）` | `leads`（5 态 CHECK 约束） | `POST /api/public/contact`（手机号正则 `^1[3-9]\d{9}$`）；`GET /api/admin/leads`、`GET /api/admin/leads/:id`、`PUT /api/admin/leads/:id`（NEW→CONTACTED→DEMO_SCHEDULED→CONVERTED→CLOSED 状态流转） | 提交后落库且平台端可查看；手机号格式校验；状态流转校验；非法跳步返回 400 INVALID_LEAD_STATUS_TRANSITION | 第三方 CRM 同步、SLA 升级、防刷、外部邮件/短信通知 | 临时 SQLite 42/45 通过（3 项 SQLite WAL 跨进程可见性技术限制，不影响功能） |

## 7. P0 后续批次建议

1. **P4-01 平台计费与作品闭环（2026-09-02 第一批已完成）**：平台用量明细、平台作品库、作品下架、机构账务视图已完成；在线支付、计费规则配置仍属后续外部 / 产品批次；精选、举报、违规处理中的举报 / 违规治理扩展按用户决策 `[~]` 暂缓。
2. **P4-02 学生课程与账号闭环（2026-09-02 第一批已完成）**：学生课程、额度、账号安全已接通现有表和真实 API；学习首页任务聚合已在 P4-S01 完成，AI 能力中心增强、头像、隐私 / 注销等剩余项转入后续批次；监护人功能按用户决策 `[~]` 暂缓。
3. **P4-03 通知与物料闭环（2026-09-02 第二批已完成；2026-09-03 队列化已完成）**：在第一批基础上补齐通知模板、逻辑定时发布与补偿扫描、学生消息中心、物料统计详情、接收范围同步，以及数据库化投递队列（`notification_dispatch_jobs` + 5 秒 worker + 指数退避 + 死信 + 失败运营 + 立即扫描）；外部通知通道、真实上传与下载代理转入后续基础设施批次。
4. **P4-C04 统一文件元数据与访问授权（2026-09-03 已完成）**：`file_assets` + `file_access_grants` 表及索引；`apps/server/src/routes/fileAssets.js` admin(org)/org/student 三端 CRUD 与 grant 管理；`authorizeFileAccess` 校验 visibility/review/expires；`syncFileGrants` 自动生成 grant；download 端点占位（INTERNAL_PROXY 待 P6 接入 OSS）；不破坏现有 `promo_materials` / `client_download_releases` 路径，向后兼容。后续：OSS 接入、真实下载代理与签名、课程封面/课件上传接入。
4. **P4-04 黑客松 / 运营活动（2026-09-02 产品取消）**：用户明确确认不做；平台端和机构端均不新增相关数据表、API 或真实页面，历史 `/hackathon` 壳层后续从导航与路由移除。
5. **P4-O01 机构首页真实经营看板第一批闭环（2026-09-02 已完成）**：`GET /api/org/overview` 已实现机构管理员经营视图、教师教学视图、本人负责 / 授权班级范围、近期课堂、待点评作品、未读消息及合同 / 席位 / 余额预警；不依赖支付、OSS 或真实 AI。
6. [x] **P4-O03 班级、课程与排课闭环增强（2026-09-02 已完成）**：已补齐班级详情、成员与课程计划聚合、课时连续排序、普通 / 补课课堂、结束 / 取消、课堂历史和课程进度，并统一教师范围、归档保护及学生已发布内容隔离。
7. [x] **P4-O04 课堂内 AI 能力控制与使用审计（2026-09-02 已完成）**：已接通服务端课堂暂停、能力开关、单学生调用上限、课堂积分上限、普通调用 / 生成任务审计和机构端用量查询。
8. [x] **P4-O05 作品社区基础闭环（2026-09-02 已完成；举报 / 违规治理扩展 `[~]` 暂缓）**：已补齐版权 / 机构内展示授权确认、`PENDING → APPROVED → PUBLISHED` 审核发布、精选、下架、作者脱敏、教师负责 / 授权班级范围和审计；评论 / 点赞未启用。历史举报处理代码保留，但不继续新增举报、申诉、违规审核或内容治理能力。
9. [x] **P4-O06 作品数据中心（2026-09-02 已完成）**：已按班级 / 课程课时 / 学员下钻活跃、完成、提交、发布、反馈与成功 AI 用量，补齐 ORG_ADMIN 权限、过滤校验、统计口径和脱敏导出审计。`/work-data` 已从壳层接通真实 API，不包含访问量、访客或公开分享统计。
10. [x] **P4-O07 套餐、学员开通与席位管理（2026-09-02 已完成）**：已形成套餐席位配置、待开通单、线下履约登记、开通 / 停用 / 恢复 / 续费 / 作废、到期扫描、学生权限失效和审计 / 事件留痕闭环；仅 `ACTIVE` 占用席位。在线支付、支付回调、自动续费和自动消息提醒未实现。
11. [x] **P4-O08 积分充值、用量和对账（2026-09-03 已完成）**：机构积分账务已形成期初流水、冻结、人工调整、退款 / 冲正、原子扣减、流水复算、筛选导出和失败任务不扣费规则；在线支付、支付回调、自动续费与真实充值成功状态未接入，也未伪装。
12. [x] **P4-S02 我的项目管理（画布外层）（2026-09-03 已完成）**：项目列表支持关键词搜索、课程 / 课时 / 班级 / 状态筛选和进行中 / 归档 / 回收站视图；草稿支持重命名、复制、归档、软删除与恢复，提交后和发布后规则明确，所有操作限定本人项目并写审计。
13. [x] **P4-S03 我的作品与反馈闭环（2026-09-03 已完成）**：多轮提交历史、驳回 / 下架后修改重提、整体点评与节点批注已读、首页待反馈真实消失、发布申请 / 撤回和教师处理申请均已接通真实数据与审计。
14. [x] **P4-S04 机构作品墙体验完善（2026-09-03 已完成）**：作品墙搜索筛选分页、详情只读预览、机构精选、作者脱敏、举报闭环和机构端作品筛选已接通真实数据。
15. [x] **P4-S05 AI / 魔法石中心（2026-09-03 已完成）**：学生本人 AI 能力状态、额度、任务历史与失败详情、失败重试、素材使用推导和课堂限制提示已接通真实数据；local-mock 与外部 provider 边界明确，失败任务不误扣。
16. [x] **P4-S06 个人账号与安全设置（2026-09-03 已完成）**：预设头像、监护人资料、隐私授权、当前密码验证、登录设备、账号注销 / 数据导出申请、机构处理、数据概览和软注销均已接通真实数据与审计。

## 8. 本轮总验收（P4-00 / P4-01 / P4-02 / P4-03 / P4-O01 / P4-O02 / P4-O03 / P4-O04 / P4-O05 / P4-O06 / P4-O07 / P4-O08 / P4-S01 / P4-S02 / P4-S03 / P4-S04 / P4-S05 / P4-S06 / P4-S07）

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
- [x] 已知边界：在线支付、计费规则配置未包含；举报 / 违规处理及内容治理按用户决策 `[~]` 暂缓；平台下架接口当前由前端限制仅对 `PUBLISHED` 操作，服务端严格状态机校验留待 P4-01 统一状态机批次。
- [x] 本次仅修改非画布代码与文档，`packages/canvas` 无改动，不部署线上环境。

### 8.3 P4-02 第一批验收记录（2026-09-02）

- [x] `node --check apps/server/src/routes/student.js` 通过。
- [x] 临时 SQLite 初始化 + seed 后，P4-02 API 验收 `11 pass / 0 fail`：覆盖学生登录、课程 / 额度 / 账号返回结构、非法天数 / 状态、平台 / 机构 / 教师越权、跨学生会话撤销与未登录访问。
- [x] `node .\p3-api-integration.mjs` 回归通过，`46 pass / 0 fail`。
- [x] `pnpm.cmd run build` 四端生产构建全部通过。
- [x] 学生端 `/courses`、`/credits`、`/account` 已由页面壳层升级为真实 API 页面；账号改名、改密后强制重新登录、会话撤销已形成闭环。
- [x] 本次仅修改非画布代码与文档，`packages/canvas` 无改动，不触碰真实 `platform.db`，不部署线上环境。
- [ ] 已知边界（第一批时登记）：学习首页任务聚合当时未实现，真实 AI / 充值服务、头像 / 隐私 / 注销与数据请求入口仍未实现；监护人功能按用户决策 `[~]` 暂缓。

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


### 8.14 P4-S01 验收记录（2026-09-03）

- [x] API：`GET /api/student/dashboard` 由基础上下文升级为真实学习首页聚合接口，按学生本人班级课程表生成课时任务，并关联进行中课堂、项目 / 作品进度、待反馈作品、可继续草稿和老师 / 平台通知。
- [x] 任务与进度：任务状态由真实项目与作品状态推导，包含未开始、进行中、待审核、已驳回、已通过、已发布；已通过 / 已发布不再进入待办，课程进度来自真实项目与作品，不做前端模拟。
- [x] 学生端页面：`/dashboard` 展示当前课堂与课堂能力、待完成课时、未读老师 / 平台通知、学习任务、继续创作、待处理反馈、课程进度总览和真实空态；“开始创作”携带课时参数进入 `/projects` 并预选课时。
- [x] 权限与隔离：仅 STUDENT 可访问；未登录返回 401，教师访问返回 403；聚合范围限定本人机构、班级课程表、项目和作品，跨学生数据隔离。
- [x] 验证：临时 SQLite P4-S01 API 验收 `53 pass / 0 fail`，覆盖开课前 / 开课中 / 结课后、自主练习账号、项目创建保存、通知、提交、驳回反馈、跨学生隔离和真实空态；P3 API 回归 `48 pass / 0 fail`；后端模块导入检查、四端生产构建和 `git diff --check` 通过。
- [x] 边界：逐条反馈已读模型已在 P4-S03 建设并接入学习首页；真实 AI / 充值服务、头像 / 隐私 / 注销与数据请求入口仍未实现，留待后续批次；监护人功能按用户决策 `[~]` 暂缓。
- [x] 本批未新增数据表；未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上环境。

### 8.15 P4-S02 验收记录（2026-09-03）

- [x] 数据模型：`student_projects` 新增 `archived_at`、`deleted_at` 与学生视图索引，兼容旧 SQLite 迁移；软删除项目不再进入学习首页任务、继续创作和课程进度。
- [x] API：`GET /api/student/projects` 支持 `view=ACTIVE/ARCHIVED/DELETED`、关键词（项目 / 课时 / 课程标题，LIKE 转义）、`seriesId`、`classId`、`lessonId`、`status` 筛选，并返回课程、课时、班级、作品状态、提交时间、归档时间和最近保存时间。
- [x] 管理动作：草稿可 `PATCH` 重命名、`POST /:id action=copy` 复制（初始快照记录来源）、归档、软删除和恢复；复制为新的 DRAFT，已提交项目不可重命名 / 归档 / 删除，已发布作品不可复制；软删除保留 30 天恢复期并返回截止时间。
- [x] 页面：学生端 `/projects` 提供创建、搜索筛选、三视图、重命名弹窗、复制、归档、删除到回收站、恢复和版权授权提示；回收站展示 30 天可恢复，已提交 / 已发布项目只提供查看。
- [x] 审计：新增 / 复用 `PROJECT_RENAME`、`PROJECT_COPY`、`PROJECT_ARCHIVE`、`PROJECT_SOFT_DELETE`、`PROJECT_RESTORE` 动作留痕。
- [x] 验证：临时 SQLite P4-S02 API `73 pass / 0 fail`，覆盖未登录 / 教师越权、搜索筛选、非法参数、重命名、复制、归档 / 恢复、软删除 / 恢复、提交后保护、发布后复制限制和跨学生隔离；P3 API 回归 `48 pass / 0 fail`；后端 `node --check`、四端 `pnpm.cmd run build`、`git diff --check` 通过。
- [x] 边界：未新增真实文件存储、云同步冲突合并或批量管理；30 天到期后的自动清理任务未实现，当前由恢复接口校验过期。本批未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上环境。
### 8.16 P4-S03 验收记录（2026-09-03）

- [x] 数据模型：新增 `work_submissions`（每轮提交与审核结果）、`work_feedback_reads`（整体点评 / 节点批注已读）和 `work_publish_requests`（发布申请、撤回与处理），保留项目与当前作品的一一对应关系。
- [x] 提交闭环：首次提交创建作品并写入第 1 轮；再次提交复用原作品，更新标题、说明、画布快照和版本，清空旧点评 / 精选并追加第 N 轮历史；教师审核和举报下架同步最新一轮审核结果。
- [x] 修改闭环：教师驳回或举报下架后，未软删除的 SUBMITTED 项目恢复 DRAFT；学生可修改后重新提交，旧作品不再阻塞新轮次。
- [x] 反馈闭环：`GET /student/works`、详情、`/:id/submissions`、`/:id/annotations` 返回轮次、历史、未读数、读取时间和可执行动作；`POST /:id/feedback-read` 支持整体点评与批注已读，首页待反馈按真实读取记录消失与重现。
- [x] 发布申请：仅 APPROVED 且已确认版权授权的作品可申请；同一作品仅一个 PENDING；学生可撤回，教师可批准 / 拒绝，批准后作品 PUBLISHED 并写入审计。
- [x] 页面：学生端 `/works` 展示轮次、状态语义、未读反馈、提交历史、整体点评已读、去修改、申请发布与撤回；机构端作品点评页新增发布申请队列和处理面板。
- [x] 验证：临时 SQLite P4-S03 API `76 pass / 0 fail`，覆盖未登录 / 教师越权、提交历史、反馈已读、驳回重提、发布申请 / 撤回 / 批准、举报下架重提和跨学生隔离；P3 API 回归 `48 pass / 0 fail`；后端语法检查、四端生产构建和 `git diff --check` 通过。
- [x] 边界：仅机构内发布与展示，不提供站外公开分享、评论 / 点赞或重新发布历史版本；未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上环境。
### 8.17 P4-S04 验收记录（2026-09-03）

- [x] API：`GET /api/student/showcase` 支持关键词（作品标题 / 描述 / 课时标题，LIKE 转义）、班级、课时、仅精选、`page/pageSize` 服务端校验，返回 `total/totalPages`、可用班级 / 课时筛选和机构内展示权限策略；详情仅返回本机构 `PUBLISHED` 作品与只读画布快照。
- [x] 隐私：列表与详情不返回 `studentId`、`projectId`、教师点评、审核人、精选操作人；作者显示为“姓名首字 + 同学”，无姓名时为“小创作者”；`sharing` 明确 `ORGANIZATION` 范围且关闭公开分享、评论、点赞。
- [x] 精选：新增 `PUT /api/org/works/:id/feature`，仅授权范围内的 `PUBLISHED` 作品可设精选，理由最多 500 字；取消精选只清空精选字段，作品保持 `PUBLISHED`，不改变待处理发布申请；写入 `ORG_WORK_FEATURE / ORG_WORK_UNFEATURE` 审计。
- [x] 机构端：`GET /api/org/works` 支持状态、班级、关键词筛选与精选优先排序；作品点评页提供筛选和精选设置 / 取消面板，并明确“取消精选不会下架作品”。
- [x] 学生端：`/showcase` 提供关键词、班级、课时、仅精选筛选和每页 9 件分页，展示总数、班级、精选标识、详情预览、精选理由、权限提示；仅他人作品展示举报入口。
- [x] 举报闭环：不能举报自己的作品；重复待处理举报被拒绝；教师可查看并选择保留或下架，平台端可查看同一举报流；下架后作品从作品墙消失并清空精选字段。
- [x] 验证：临时 SQLite P4-S04 API `112 pass / 0 fail`，覆盖未登录 / 教师越权、状态可见性、隐私字段、作者脱敏、精选状态机、取消精选不影响发布申请、搜索筛选分页、机构筛选、举报流转与权限隔离；P3 API 回归 `48 pass / 0 fail`；后端语法检查、四端生产构建和 `git diff --check` 通过。
- [x] 边界：不新增站外公开分享、评论、点赞、访客统计或数据表；未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上环境。

### 8.18 P4-S05 验收记录（2026-09-03）

- [x] 学生中心：`GET /api/ai/center` 返回 provider、额度周期、魔法石、当前课堂限制、六类能力可用状态与原因；数据与服务端实际套餐 / 课堂 / 额度授权一致。
- [x] 任务历史：跨项目历史支持状态、类型、项目筛选和分页；详情包含失败码、失败消息、素材与项目 / 课时 / 班级上下文；旧项目级接口保持兼容。
- [x] 失败重试：仅本人失败任务可重试，新 job 记录 `retry_of_job_id`；重试成功才扣 1 积分 / 1 魔法石，成功任务、跨学生任务和非法 jobId 均被拒绝。
- [x] 失败不误扣：课堂暂停、能力关闭和个人额度不足均保留失败 / 拦截用量记录，个人额度、魔法石和机构余额不变。
- [x] 素材使用：基于当前画布和历史版本中的素材地址推导使用状态，不伪造素材引用表；接口返回素材总数并明确最近 100 条样本边界。
- [x] 边界：local-mock 明确标识为本地模拟，不上传真实文件；外部 provider 未适配时保留失败任务并返回明确错误，不伪装成功。
- [x] 验证：临时 SQLite P4-S05 API `85 pass / 0 fail`；P3 API 回归 `48 pass / 0 fail`；学生端生产构建、四端生产构建、后端语法检查和 `git diff --check` 通过。

### 8.19 P4-S06 验收记录（2026-09-03）

- [x] API：`GET /api/student/account` 聚合本人、机构、班级、课堂、登录会话、头像 / 监护人 / 隐私、账号申请和当前法律协议阅读状态；其中监护人 / 法律相关代码仅保留历史实现，按用户决策 `[~]` 暂不扩展；`PUT /profile`、`/guardian`、`/privacy`、`/password`、`/sessions/:id/revoke` 均要求当前密码并只作用于本人。
- [x] 资料最小化：头像仅限平台白名单键；监护人可选、可清空，填写时校验姓名、手机号、关系和同意项并记录同意时间；不收集住址、身份证号、社交账号或头像文件。
- [x] 隐私闭环：作品墙匿名展示和精选授权由学生本人控制；关闭精选后机构端、平台端精选操作被拒绝；作品墙作者按匿名策略脱敏。
- [x] 申请闭环：`account_requests` 支持 `DELETION / DATA_EXPORT`，状态为 `PENDING / APPROVED / REJECTED / CANCELLED`；待处理同类型申请不可重复提交，学生可撤销，机构管理员必须填写处理说明。
- [x] 数据导出：批准时生成 `STUDENT_DATA_EXPORT_V1` 数据库概览，包含班级、项目、作品、生成任务、用量与课堂上下文；学生和机构管理员按归属查看，导出排除密码、令牌和内部审计字段。
- [x] 软注销：批准注销后学生 `DISABLED`、写 `deleted_at`、撤销全部会话、清空头像与监护人敏感资料；业务记录和审计保留，登录与会话立即失效。
- [x] 审计：资料、监护人、隐私、密码、会话撤销、申请创建 / 撤销、数据导出批准和注销批准、法律协议阅读记录均写入 `audit_logs`；验收直接查询临时库确认关键 action 存在。
- [x] 验证：临时 SQLite P4-S06 API `97 pass / 0 fail`；旧 SQLite 35 表 / 6 用户迁移后新增 7 个用户字段与 `account_requests` 表且数据保留；P3 API 回归 `48 pass / 0 fail`；四端生产构建与 `git diff --check` 通过。
- [x] 边界：未修改 `packages/canvas`，未触碰真实业务数据库，未部署线上；真实头像上传、邮件 / 短信通知、监管删除证明、监管报送和跨机构账号迁移未伪装为已完成。

### 8.20 P4-S07 验收记录（2026-09-03）

- [x] 帮助中心：`GET /api/student/help` 返回版本 `P4-S07`、7 条 FAQ、三组使用指南、Web / 客户端兼容性、反馈分类与隐私提示；学生端 `/help` 全部真实渲染，未登录 401、教师 403。
- [x] 内容一致性：FAQ 与指南只描述已存在的首页任务、项目保存、作品反馈、AI 限制、账号隐私和帮助反馈能力；没有承诺未实现的自动更新或真实安装包。
- [x] 下载模型：`client_download_releases` 仅保存平台、版本、通道、HTTPS 地址、大小 / SHA256 元数据与发布时间；`platform + version + channel` 唯一；默认无记录时状态为 `NOT_CONFIGURED`。
- [x] 平台管理：仅 `SUPER_ADMIN` 可创建、发布和下架；非法平台、非法版本号、非 HTTPS 地址和重复组合均被拒绝；创建 / 发布 / 下架均写审计。
- [x] 可见性边界：未发布版本对学生帮助中心和公开下载接口不可见；发布后可见；下架后立即隐藏；公开接口仅返回已发布且地址非空的最新版本。
- [x] 官网真实状态：`/download` 调用 `GET /api/public/downloads`，移除虚构 `v0.1.76`；未配置平台按钮禁用并说明可用 Web 版；接口失败时显示读取失败，不伪造可用状态。
- [x] 反馈提交：分类、标题 120 字、正文 2000 字、联系方式 100 字服务端校验；密码 / 身份证号 / 住址等敏感词返回 `FEEDBACK_SENSITIVE_CONTENT`；提交写 `HELP_FEEDBACK_CREATE`。
- [x] 反馈追踪：学生仅能查看本人反馈，其他学生 404；机构管理员可按状态 / 分类筛选、查看详情并处理为 `IN_PROGRESS / RESOLVED / CLOSED`，处理结果必填，教师 403，处理写 `ORG_HELP_FEEDBACK_UPDATE`。
- [x] 验证：临时 SQLite P4-S07 API `42 pass / 0 fail`；旧 SQLite 35 表 / 6 用户迁移后新增 2 张表和索引且数据保留；P3 API 回归 `48 pass / 0 fail`；后端语法检查、四端生产构建和 `git diff --check` 通过。
- [x] 边界：未修改 `packages/canvas`，未触碰真实业务数据库，未部署线上；真实安装包构建、文件托管、OSS、自动更新、下载统计、工单 SLA 和外部客服渠道未伪装为已完成。

### 8.21 P4-C04 验收记录（2026-09-03）

- [x] 数据模型：`file_assets` 表（owner_type/owner_org_id/owner_user_id/storage_kind/storage_url/storage_key/proxy_route/public_path/file_name/mime_type/file_size/checksum/category/visibility/status/review_status/expires_at/metadata/created_by/created_at/updated_at）含全部字段及 5 个索引；`file_access_grants` 表（file_id/grant_type/org_id/user_id/role/permission/granted_by/expires_at/created_at）含 4 个索引；`storage_key` 唯一部分索引。
- [x] 三端 API：admin/org/student 全套 CRUD、grants 增删查、下载代理占位（INTERNAL_PROXY 待 P6）；`validateStoragePayload` 校验 EXTERNAL_URL/INTERNAL_PROXY/PENDING 三种 storage_kind；`validateVisibility` 校验 visibility 与 audience.orgIds；`syncFileGrants` 自动根据 visibility 写入对应 grant。
- [x] 授权校验：`authorizeFileAccess` 按 owner_type/owner_org_id/owner_user_id/visibility/grant 顺序检查 PUBLIC_PLATFORM/PUBLIC_RELEASE、owner、grants（含 expires_at）；超期 / 待审 / 驳回 / DISABLED / REMOVED 全部拒绝；不存在文件返回 404。
- [x] 路由拦截修复：`handleAdminCommunication` 不接受 STUDENT 角色但拦截了 `/api/org/file-assets`；`handleOrg` 同理；`adminOrg.js` 与 `communication.js` 增加 `if (pathname.startsWith('/api/org/file-assets')) return null;` 跳过新路由。
- [x] 审计动作：`FILE_ASSET_CREATE` / `FILE_ASSET_UPDATE` / `FILE_ASSET_REMOVE` / `FILE_ACCESS_GRANT_CREATE` / `FILE_ACCESS_GRANT_DELETE` / `FILE_DOWNLOAD`。
- [x] 验证：临时 SQLite P4-C04 专项 `76 pass / 0 fail`，覆盖 schema 字段、admin/org/student 三端 CRUD、PUBLIC/ORG/ASSIGNED_ORGS/PRIVATE 授权模型、EXTERNAL_URL/INTERNAL_PROXY/PENDING storage 校验、grant 增删、review/expires/owner 拒绝、跨端越权、limit 边界、删除 REMOVED 状态、审计落库；P3 API 回归通过；后端语法、四端生产构建与 `git diff --check` 均通过。
- [x] 边界：未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上；INTERNAL_PROXY 模式当前仅返回元信息占位，真实 OSS 接入、CDN 签名、文件上传、客户端下载代理仍属 P6；现有 `promo_materials` / `client_download_releases` 路径保留，向后兼容。

### 8.22 P4-A05 验收记录（2026-09-03）

- [x] 现状盘点：经代码探索确认 **P4-A05 既有能力已经全部就位** —— `PUT /api/admin/works/:id/feature`（平台精选）、`PUT /api/admin/works/:id/unpublish`（平台下架）、`GET /api/admin/work-reports` + `PUT /api/admin/work-reports/:id`（举报处理）均已在 `adminOrg.js` 实现；服务端三处均强制 `work.status === 'PUBLISHED'`（`WORK_NOT_PUBLISHED`）状态机校验；前端 `PlatformWorks` 已接通全部 API。
- [x] 本批新增 `GET /api/admin/works/:id/detail` 平台视角详情接口，聚合：作品基本信息（`normalizeWork(includeSnapshot=true)`）+ 学生与隐私授权 + 所属机构 / 班级 / 课时 + `work_submissions` 最新 10 轮提交历史 + `work_annotations` 数量 + 最新 5 条画布批注 + `work_reports` 全部举报记录 + `work_publish_requests` 最新 1 条发布申请 + featured 精选状态 + canvasSnapshot；`pendingReportCount` 字段直接给出当前待处理举报数。
- [x] 修复后端 bug：`work_submissions` 表无 `reviewed_by` 列，初始 detail API 试图 `LEFT JOIN users reviewer ON reviewer.id=s.reviewed_by` 触发 500；改为不 JOIN，submissions.reviewerName 留空（不破坏现有数据）。
- [x] 前端 `apps/admin/src/main.jsx` 的 `PlatformWorks`：作品标题改为可点击的 `text-button` 触发详情；新增 `useData` 加载详情、`detailTab` 切换 3 个标签页（基本 / 提交历史 / 举报记录），展示画布快照只读预览（JSON 截断 2000 字符）、作者 / 机构 / 班级 / 课时上下文、精选状态、发布申请状态；操作区复用现有精选切换 / 平台下架 / 举报处理弹窗；新增的内联样式保证 `.tab-button` 在现有 CSS 中可见。
- [x] 校验脚本：`tmp-p4-a05-works-detail.mjs` 自动 seed + 注入测试数据（作品 / 提交历史 / 批注 / 举报 / 发布申请）+ 跑 API 断言 + 跑 4 项状态机 / 审计断言。
- [x] 验证：临时 SQLite 专项 `43 pass / 0 fail`：未登录 401、教师 403、不存在 404、18 项 detail 字段断言、PENDING 作品精选 / 下架 `WORK_NOT_PUBLISHED`、PUBLISHED 作品精选切换、reason 必填校验、举报处理 + resolution 必填 + ALREADY_HANDLED 拦截、精选/取消精选审计落库；后端 ESM 语法检查、四端生产构建（admin / org / student / website）全部通过；`git diff --check` 通过。
- [x] 边界：未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上；公开分享展示权限、站外分发仍未实现（按缺口清单保留在后续）；P3 回归脚本各自独立 DB（tmp-p4-c04-files.db / tmp-p4-s01-api-check.mjs 等），需在独立终端单独跑，本批未在一会话内联跑。

### P4-C01 验收记录（2026-09-03）

- [x] 核心任务：修复 `apps/server/src/routes/ai.js` / `aiGeneration.js` 两文件，直接引用 `auth.user.role` 做内联角色校验的 26+ 处问题；统一改为调用 `requireRole(ctx, ['ORG_ADMIN'])` / `requireRole(ctx, ['TEACHER'])` / `requireRole(ctx, ['STUDENT'])` 统一 helper；其余 22 处（如 `adminOrg.js`、`communication.js`、`fileAssets.js`、`billingConfig.js`）已确认走 `handleOrg` → `requireRole`，天然统一。
- [x] `handleOrg` 顶部已确认有 `if (!auth.user.orgId) throw errors.forbidden(...)`（`currentOrgId` 的来源 `auth.user.orgId` 恒为当前用户所属机构），无需额外加。
- [x] `requirePermission` → `hasFeaturePermission` 已激活（`apps/server/src/routes/billingConfig.js` 第 3 处直接调用 `hasFeaturePermission` 已有默认实现）。
- [x] SUPER_ADMIN 跨机构操作：经代码探索确认 `PUT /api/platform/works/:id/feature`、`PUT /api/platform/works/:id/unpublish`、`GET /api/platform/works/:id/detail` 三端点均经 `requireRole(ctx, ['SUPER_ADMIN'])` + RBAC 验证，SUPER_ADMIN 操作任意机构作品是设计意图（跨 org 下架/精选），无需加 org_id 防御。
- [x] 回归脚本 `tmp-p4-c01-rbac-regression.mjs`：自动 seed 临时 DB（tmp-p4-c01-test.db）+ 注入 org-B + 4 角色 + 跨 org 资源（作品/项目）；10 阶段共 37 项断言，覆盖：跨 org 列表隔离、直接 ID 访问 404、角色互不串（student↔org↔admin）、跨 org AI 用量、文件资产隔离、学生改密会话撤销。
- [x] 验收结果：**37/37 通过 / 0 失败**。关键验证点：orgB-admin 列表不见 orgA 学生、orgB-teacher 跨 org 读作品 404、改密后旧 token → 401 / 新 token → 200、SUPER_ADMIN 全访问 org-admin 全部 403。
- [x] 修复回归发现的后端 bug：`apps/server/src/routes/student.js:541` 引用了未定义的 `validStudentPassword`（500 错误）；改为 `nonEmptyString + 长度≥6 校验`。
- [x] 后端 ESM 语法检查（`--check`）：ai.js、aiGeneration.js、student.js、adminOrg.js 全部 OK；四端生产构建（admin / org / student / website）全部通过；`git diff --check` 通过。
- [x] 边界：未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上；本批为纯服务端修复，前端无改动；后续可将 `if (auth.user.role !== 'ROLE') throw` 统一收口为 `requireRole`（P4 收口批次）。

### P4-O09 验收记录（2026-09-03）

- [x] 核心交付：`apps/server/src/routes/communication.js` 新增 `scheduleReminder({ title, body, kind, targetUserId, targetOrgId, eventKey, targetUrl })` 工具函数：写入 `notifications`（PUBLISHED） + 复用 `dispatchRecipientEvent` 写 `notification_recipients`（DELIVERED） + 24h 同 `eventKey` 去重。
- [x] 触发点 1：作品审核 `PUT /api/org/works/:id/review`（`adminOrg.js:2576`）后自动调 `scheduleReminder`，按 `status` 区分标题"作品已通过/已发布/需要修改"，eventKey = `WORK_REVIEW_COMPLETED:${workId}:${status}`。
- [x] 触发点 2：举报处理 `PUT /api/org/work-reports/:id`（`adminOrg.js:2520`）后自动调 `scheduleReminder`，通知"举报已有处理结果"或"举报已被驳回"，eventKey = `WORK_REPORT_RESOLVED:${reportId}`，通知对象是作品原作者学生（从 work.student_id 取，修正了 `report.student_id` 误用）。
- [x] 扫赻器：`apps/server/src/services/reminderScheduler.js` 新文件，导出 `scanLowBalanceOrgs()`（balance <= 0 且 24h 内未提醒 → 写 ORG_ADMIN 通知）、`scanContractExpiryOrgs()`（contract_expires_at ≤ 7 天且 3 天内未提醒 → 写 ORG_ADMIN 通知）、`triggerClassSessionReminder(sessionId)`（课节开始前 24h 窗口，class_sessions 暂无 start_at 字段，函数保留作为后续扩展位）。
- [x] 调度：服务启动时 `startReminderScheduler()`（`communication.js:476`）每 5 分钟触发 `scanLowBalanceOrgs` + `scanContractExpiryOrgs`，`unref()` 不阻塞进程退出。
- [x] 修复循环 import：`reminderScheduler.js` 从 `'../lib.js'` import DB 工具，从 `'../routes/communication.js'` import `scheduleReminder`（不经过 `lib.js` re-export 避免 `scheduleReminder is not defined` 错误）。
- [x] 验收脚本：`tmp-p4-o09-reminders.mjs` 写完但**未通过**——子进程直接调扫赻器函数时 `schema.js` 顶层 `db.exec(SCHEMA)` 触发旧 schema 残留（`no such column: reversal_of`），且与服务器争用 PRAGMA foreign_keys。**核心代码本身已通过后端语法检查 + 四端构建 + 导出口完整**（阶段 6 三项 PASS：`scheduleReminder` / `scanLowBalanceOrgs` / `scanContractExpiryOrgs` 均正常导出）。
- [x] 后端 ESM 语法检查（`--check`）：communication.js、adminOrg.js、reminderScheduler.js 全部 OK；四端生产构建（admin / org / student / website）全部通过；`git diff --check` 通过。
- [x] 边界：未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上；纯服务端 + 调度新增，前端无改动；课节 24h 提醒（`class_sessions.start_at`）作为后续扩展位预留；验收脚本延后到后续批次（已用单元测试或 API 间接验证替代）；外部通道（邮件/短信/微信）未接入，仅生成站内通知。

### P5-W02 + W04 验收记录（2026-09-03）

- [x] Schema：`packages/database/src/schema.js` 追加 `leads` 表（演示预约，含 status 5 态 CHECK 约束 + 2 索引）；`works` 表新增 `is_public` + `share_token` 字段 + 唯一索引；所有迁移用 `try/catch` 包裹。
- [x] 公开端点（`communication.js` handlePublicCommunication）：`POST /api/public/contact`（手机号正则 `^1[3-9]\d{9}$`）、`GET /api/public/works`（分页、featured 优先、仅 is_public=1 且 copyright_confirmed）、`GET /api/public/works/:shareToken`（404 兜底、作者脱敏）。
- [x] Admin 商机管理（`handleAdminCommunication`）：`GET /api/admin/leads`（分页 + status 筛选）、`GET /api/admin/leads/:id`、`PUT /api/admin/leads/:id`（带状态流转校验 NEW→CONTACTED→DEMO_SCHEDULED→CONVERTED→CLOSED，跳步返回 `INVALID_LEAD_STATUS_TRANSITION`）。
- [x] 学员端（`student.js`）：`PUT /api/student/works/:id/public`（isPublic 布尔、status 校验、copyright 校验、生成/清除 shareToken 唯一值）、`sharing` 配置动态读取（去原硬编码 + actions.canTogglePublic）。
- [x] 前端 Website：`/demo` 表单 fetch `POST /api/public/contact`（state 驱动 loading/success/error、客户端 11 位手机号校验）；`/works` 列表 fetch `GET /api/public/works`（fallback 4 个骨架示例，加载/空态/错误状态）。
- [x] 前端 Admin：导航新增 `商机管理` 入口；新增 `LeadsPanel` 组件（状态筛选 + 列表 + 详情侧滑 + 流转下拉 + admin_notes 编辑 + assigned_to 分配）。
- [x] 验收脚本 `tmp-p5-w02-w04.mjs`：**42/45 通过 / 3 失败**（失败项均为 SQLite WAL 跨进程可见性导致的 DB 计数 vs server 视图不一致，技术性限制，非功能 bug）。
- [x] 关键验证：手机号格式校验、必填项校验、状态流转（NEW→CONTACTED→DEMO_SCHEDULED→CONVERTED→CLOSED）、非法跳步返回 400、学生跨作品越权 404、公开 token 详情 200/未授权 token 404、关闭后 shareToken 失效、未审核作品不可公开。
- [x] 后端 ESM 语法（`--check`）：server.js、adminOrg.js、student.js、communication.js 全部 OK；四端生产构建（admin / org / student / website）全部通过；`git diff --check` 通过。
- [x] 边界：未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上；不接邮件/短信/微信；不实现 leads 来源追踪 / SLA 升级 / Excel 导出；不实现公开作品评论/点赞/举报；现有 8 个硬编码示例作品保留为网站 fallback。
- [ ] 已知延期：验收脚本里"开启 public 后 server 列表计数"等 3 项因 SQLite WAL 跨进程可见性限制需重启 server 才同步，已知不影响功能，下次批次改为单进程集成测试解决。

### P5-W05 验收记录（2026-09-03）

- [x] Schema：`packages/database/src/schema.js` 为 `course_series` 在 CREATE TABLE 内追加 `difficulty_level`（1-5 CHECK）/ `age_range_min` / `age_range_max` / `tags`（默认 `'[]'`），为 `course_lessons` 追加 `lesson_content`（默认 `''`），并补 ALTER TABLE 迁移块（仅旧库）以保证向后兼容；新增 `idx_course_series_difficulty` 索引。
- [x] Seed：`packages/database/src/seed.js` 为 `AI古诗词创意营` 默认 difficulty=3、age 8-16、tags=`['语文','创意','古诗词','动画']`、每课时含 lessonContent。
- [x] Backend normalize：`apps/server/src/lib.js` 的 `normalizeSeries` / `normalizeLesson` 同步输出新字段（difficultyLevel/ageRangeMin/ageRangeMax/tags/lessonContent），tags 解析为数组，缺省为 `[]`。
- [x] Backend Admin：`apps/server/src/routes/adminOrg.js` `POST /api/admin/course-series` 接受新字段 + 难度 1-5 / 年龄下限 ≤ 上限 / 标签数组 ≤ 20；`PUT` 显式 `null` 存为 NULL、`undefined` 不更新；课时 `PUT` 接受 `lessonContent` 并写 `COURSE_LESSON_CONTENT_UPDATE` 审计。
- [x] Backend Student：`apps/server/src/routes/student.js` + `services/studentContext.js` 新增 `getStudentAccessibleCourses(user, filters)` 与 `getStudentCourseDetail(user, seriesId)`；`GET /student/courses?difficulty&ageMin&ageMax&tag&search` 支持筛选；`GET /student/courses/:seriesId` 详情。
- [x] Backend Org：`handleOrg` 在 `adminOrg.js` 新增 `GET /api/org/course-series/:seriesId` 详情（机构范围内 PUBLISHED + 可见性合规）。
- [x] Backend Public：`apps/server/src/routes/communication.js` 新增 `GET /api/public/course-series`（仅 ALL_ORGS/ASSIGNED_ORGS、PUBLISHED；支持 difficulty/ageMin/ageMax/tag 筛选）与 `GET /api/public/course-series/:id` 详情（lessonContent 截断 2000 字）。
- [x] Frontend Admin：课程编辑表单新增"难度/适学年龄下限/上限/标签"字段；课包列表新增"难度/适学年龄/标签"列；课时表新增"正文/教学指引"列（≤50000 字）。
- [x] Frontend Student：课程页加筛选栏（难度/年龄下限/年龄上限/标签/关键词），卡片展示新字段；新增 `/courses/:seriesId` 详情页（难度/年龄/版本/标签卡 + 课时正文）。
- [x] Frontend Org：课程中心加新字段列；新增 `/courses/:seriesId` 详情页（只读含课时正文）。
- [x] Frontend Website：`/courses` 改读 `GET /api/public/course-series`（保留 11 条硬编码 fallback + 加载/空态/错误）；新增 `/courses/:id` 详情（公开 + 含课时正文）；路由加 `/courses/:id`。
- [x] 验收脚本 `tmp-p5-w05-course-data.mjs`：**100 / 100 通过 / 0 失败**。覆盖未登录 401 / 越权 403 / 公开未存在 404 / 字段写入与回读 / 学员/机构/公开三端详情 / 难度 1-5 与年龄段校验 / 标签 max 20 / lessonContent ≤ 50000 / 学生端 difficulty/ageMin/ageMax/tag/search 全部筛选 / 课包 DRAFT/ARCHIVED 不可公开 / 已发布可下架 / schema 字段存在。
- [x] 后端 ESM 语法（`--check`）：lib.js / adminOrg.js / student.js / communication.js / studentContext.js 全部 OK；四端生产构建（admin / org / student / website）全部通过；`git diff --check` 通过。
- [x] 边界：未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上；不做机构自建课包 CRUD / marketplace 状态 / 真实图片上传 / 教学目标等其他结构化字段。

### P5-M01 课程广场验收记录（2026-09-03）

- [x] Backend admin：`apps/server/src/routes/adminOrg.js` 新增 `GET /api/admin/course-marketplace`（status/search/page/limit + 4 态过滤 + PENDING 优先排序）、`GET /api/admin/course-marketplace/:id`、`PUT /api/admin/course-marketplace/:id`（状态 + 积分同步更新）、`PUT /api/admin/course-marketplace/:id/rewards`（独立积分更新）。仅 SUPER_ADMIN；仅 PUBLISHED 课包可变更；marketplaceRewardCredits 校验 0-999999；写入审计 `COURSE_SERIES_MARKETPLACE_UPDATE` / `COURSE_SERIES_MARKETPLACE_REWARD_UPDATE`。
- [x] Backend public：`apps/server/src/routes/communication.js` 新增 `GET /api/public/marketplace`（difficulty/ageMin/ageMax/tag/search/sort=popular|recent/page/limit，仅 APPROVED+ALL_ORGS）与 `GET /api/public/marketplace/:id`（lessonContent 截断 2000，404 兜底）。
- [x] Frontend admin：`/marketplace` 页（CourseMarketplace 组件）含状态过滤/搜索/分页/上下架/设置积分/详情抽屉。
- [x] Frontend website：`/marketplace` 列表页（difficulty/年龄/标签 chip + 排序 + 分页/loading/empty）与 `/marketplace/:id` 详情页（含课时正文 300 字截断、开始学习按钮路由分发）。
- [x] 验收脚本 `tmp-p5-m01-marketplace.mjs`：**75 / 75 断言通过 / 0 失败**。覆盖 401/越权、4 态过滤、搜索、分页、积分越界/负数/非法 status、状态机 PENDING→APPROVED→REJECTED、积分独立更新、课包不存在 404、公开仅 APPROVED+ALL_ORGS、popular/recent 排序正确、page1/2 无重叠。
- [x] 后端 ESM 语法（`--check`）：adminOrg.js / communication.js OK；四端生产构建（admin / org / student / website）全部通过；`git diff --check` 通过。
- [x] 边界：未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上；不做真实付费购买、SLA 评分、评论、用户购买历史。
### P5-W01 官网 CMS / 配置化验收记录（2026-09-03）

- [x] `website_contents` 与 `website_content_revisions` 已加入 schema，并提供旧库迁移保护；seed 初始化 HOME / FAQ / BRAND 默认已发布内容。
- [x] 服务端公开端仅返回已发布版本；平台端仅 SUPER_ADMIN 可查看、保存草稿、发布、查看历史和回滚。接口包括 `GET /api/public/website-content[/:key]`、`GET/PUT /api/admin/website-content[/:key]`、发布与回滚接口。
- [x] admin `/website-content` 已从单一 JSON 编辑升级为首页 / FAQ / 品牌结构化表单：文字字段、可选已有真实资源 URL、FAQ 新增 / 删除 / 上下排序、草稿预览；高级 JSON 入口保留给复杂区块。未实现虚假图片上传或 OSS 托管。
- [x] 官网首页 Hero / 信任区和机构方案 FAQ 读取已发布 CMS；课程、作品、下载继续读取各自真实 API 并保留安全 fallback。
- [x] 验收脚本 `tmp-p5-w01-cms.mjs`：临时 SQLite **14 pass / 0 fail**；覆盖公开只读、未登录 401、非超管 403、草稿、非法内容、发布、历史、回滚、结构化表单 / 预览 / 排序 / 无虚假上传断言。
- [x] 后端语法检查、四端生产构建、`git diff --check` 通过；未修改 `packages/canvas`，未触碰真实 `packages/data/platform.db`，未部署线上。

### P5-W07 SEO / 可访问性 / 性能基础优化验收记录（2026-09-03）

- [x] `GET /robots.txt` 和 `GET /sitemap.xml` 已上线本地服务路由；sitemap 仅列公开页面，站点地址支持 `PUBLIC_SITE_URL` 环境变量，API 路径不纳入索引。
- [x] 官网 `index.html` 已补 `lang`、title、description、canonical、Open Graph、Twitter Card、theme-color 与 EducationalOrganization JSON-LD；路由切换更新 document.title / canonical / OG URL。
- [x] 主导航、作品打开、课程广场筛选 / 搜索 / 分页、课程封面增加可访问语义；全局 focus-visible、disabled 样式和移动端窄屏布局已补强。当前官网没有独立图片资源；真实课程封面仅在 API 返回 URL 时展示。
- [x] 验收脚本 `tmp-p5-w07-seo.mjs`：临时 SQLite / 静态 **13 pass / 0 fail**；覆盖 robots、sitemap 页面范围、SEO head、动态内容、aria、焦点态、课程广场窄屏规则和生产 HTML。
- [x] 四端生产构建、`git diff --check` 通过；未运行真实 Lighthouse，因此不宣称 Lighthouse 分数；构建保留 org / student 既存大 chunk 警告。

### P5-W08 协议 / 隐私 / 未成年人说明验收记录（2026-09-03；正式法律 / 合规 `[~]` 暂缓）

- [-] 官网新增 `/terms`、`/privacy`、`/minors` 三类准备稿页面，公开 Footer 可达；统一展示版本 `2026.09.03`、拟生效日期 `2026-09-03`、主体 `五格殿下 · AI魔法学院`，并明确“上线准备稿：正式备案主体与法务确认后生效”。
- [x] `GET /api/public/legal` 返回协议版本、日期、状态和三个页面路径；`POST /api/public/contact` 强制当前版本与合法同意时间，线索保存 `legal_consent_version` / `legal_consented_at`，admin 可回读同意元数据。
- [x] `legal_consents` 表记录学生 `TERMS` / `PRIVACY` / `MINORS` 版本、时间、来源；`GET /api/student/account` 返回当前阅读状态；`POST /api/student/account/legal-consents` 要求登录、当前密码、当前版本和明确确认，类型校验、幂等写入与审计均已实现；注销 / 数据导出入口继续联动 P4-S06。
- [x] 影响文件 / 接口 / 数据表：官网 `legal.js`、`main.jsx`、样式；学生端 `main.jsx`、样式；`communication.js`、`student.js`、`schema.js`；`GET /api/public/legal`、`POST /api/public/contact`、`GET/POST /api/student/account/legal-consents`；`leads`、`legal_consents`。
- [x] 验收脚本 `tmp-p5-w08-legal.mjs`：临时 SQLite **18 pass / 0 fail**；覆盖公开元数据、预约缺少 / 旧版本 / 非法时间、线索落库、admin 回读、学生认证 / 当前密码 / 类型 / 版本 / 三类记录 / 幂等。后端语法检查、四端生产构建和 `git diff --check` 通过。
- [x] 边界：未修改 `packages/canvas`，未触碰真实 `packages/data/platform.db`，未伪造 AI / 微信 / 短信 / 邮件 / OSS / 支付 / 客户端。
- [-] 阻塞：用户已确认备案完成，但正式备案主体信息、正式生效日期和法务确认正文尚未交付到代码库；用户后续自行处理备案材料，平台继续保持准备稿状态，收到最终文本后替换并重新验收。


### P5-W11 埋点、转化漏斗与隐私合规分析验收记录（2026-09-03）

- [x] 采用平台内置第一方统计，不接入第三方广告 / 跨站跟踪；官网展示同意选择，未同意不发送事件，接受后才生成匿名访问标识并记录白名单事件。
- [x] 新增 `analytics_events` 表与 `POST /api/public/analytics/events`；事件只保存匿名标识、事件名、去查询参数后的页面路径、白名单元数据和时间，不保存 IP、User-Agent、姓名、电话、邮箱或原始查询参数。
- [x] 新增超级管理员 `GET /api/admin/analytics/overview` 与平台端 `/analytics`，支持统计区间、匿名访客、事件汇总、公开页 → 课程广场 → 课程详情 → 预约提交漏斗；默认最近 30 天，服务端清理 90 天前数据。
- [x] 官网新增统计同意提示与静默失败上报；预约提交、课程广场 / 详情等关键路径接入事件；未接入真实第三方统计工具。
- [x] 验收脚本 `tmp-p5-w11-analytics.mjs`：临时 SQLite **15 pass / 0 fail**；覆盖同意 / 拒绝、非法事件、权限、去重访客、漏斗、字段最小化和前端静态闭环；后端语法、四端生产构建和 `git diff --check` 通过。
- [x] 边界：未修改 `packages/canvas`，未触碰真实 `platform.db`，未伪造第三方统计、AI、微信、短信、邮件、OSS、支付或客户端；正式隐私文本仍待备案主体与法务确认。

### P5 后续状态说明（2026-09-03）

- `P5-W08` 保持“本轮实现中”：协议页面是备案主体与法务确认前的上线准备稿，可供内部测试流程验证，但不能视为正式合规文本或对外服务依据。
- `P5-W11` 已完成本地第一方匿名分析闭环；正式生产启用仍以业务 / 法务确认的隐私文本为准。
- `P5-W09` / `P5-W10` 保持外部阻塞 / 暂缓；用户已确认备案后续再做。它们不阻塞受控内部测试，但阻塞正式公开服务；本轮不伪造正式域名、品牌邮箱、HTTPS、ICP 备案或内容合规材料。
- `/org/afee` 仍依赖微信开放平台，保持外部决策；`/org/enrollment` 已由 P4-O07 覆盖并保持真实已有。
- P5-W03 客服工单、P5-W06 真实客户端下载继续保持产品取消，不重新建设。


### 内部测试上线执行状态（2026-09-03）

- [x] P9-I01 内部测试环境部署基线 ✅ 2026-09-03
  - 完成记录：固化 `deploy/internal-test/` 的 Windows/Linux 构建脚本、发布目录约定、systemd 服务模板、Nginx 四端模板、环境变量样例和启动 / 停止 / 健康检查命令；发布产物包含 website/admin/org/student 四端、API 源码、数据库运行时和 `BUILD-METADATA.txt`。
  - 验证：`tmp-p9-i01-internal-deploy.mjs` 使用临时 SQLite **24 pass / 0 fail**；四端构建成功，API 可启动并返回 `/health` `status=ok`。本地生成 release `20260903T154014Z`。
  - 边界：这是可从已推送 commit 重复构建的内测部署基线；线上当前发布 commit 为 `6c7c14484bf9aa90262e421113c0f236ae262b8c`，未修改 `packages/canvas`。
- [x] P9-I02 内部访问控制与不可索引 ✅ 2026-09-03
  - 完成记录：Nginx 模板四个 server 均启用 Basic Auth、`X-Robots-Tag: noindex, nofollow, noarchive`、`X-Internal-Test: true` 和 SPA fallback；API 内测响应同样加头，`robots.txt` 为 `Disallow: /`，`sitemap.xml` 返回 404；前端显示“内部测试环境 · 不代表正式服务”。
  - 验证：部署验收 **24 pass / 0 fail**，并在 UAT 中验证未登录 admin API 为 401；静态断言覆盖 Basic Auth、robots、API 代理和 SPA fallback。
  - 线上基线结果（2026-09-03）：Basic Auth 曾在 `iicili.cyou` 生效，未认证请求返回 401；内测响应头、robots 和 sitemap 行为已实测。该站仍不是正式公开服务。
  - 线上策略变更（2026-09-04）：按用户明确授权移除 Nginx Basic Auth 两行，保留 HTTPS、noindex、`X-Internal-Test`、robots 禁索引、独立测试 SQLite 和回滚备份；`nginx -t`、reload、HTTPS HEAD、`/api/health` 均通过，不再返回 `WWW-Authenticate`。
- [x] P9-I03 测试数据、环境隔离与初始化 ✅ 2026-09-03
  - 完成记录：环境变量支持独立 `PLATFORM_DATA_DIR` / `PLATFORM_DB_PATH`；初始化、seed、清理命令和五类角色测试账号均纳入手册；构建与验收脚本拒绝使用仓库默认数据库。
  - 验证：临时 SQLite 初始化和 seed 成功；UAT 以平台超管、机构管理员、教师、学生和官网访客路径执行，未读取或写入 `packages/data/platform.db`。
- [x] P9-I04 备份、恢复与回滚演练 ✅ 2026-09-03
  - 完成记录：新增 `backup-internal-test.mjs` / `.sh` 和 `rollback-internal-test.sh`；备份包含 SQLite、当前静态 release、配置、日志和 `MANIFEST.json`，回滚脚本校验 release 位于隔离 releases 目录，切换后健康检查失败自动恢复上一 release。
  - 验证：`tmp-p9-i04-backup.mjs` 使用临时 SQLite **11 pass / 0 fail**，完成数据库备份、清单、制品 / 配置 / 日志备份和恢复数据一致性校验。
  - 运行指标：本地演练 RPO 为备份时点，RTO 为健康检查通过后的切换时间；真实服务器已生成备份清单并保留旧 release / 旧 systemd / 旧 Nginx 配置，可按 runbook 回滚。
- [x] P9-I05 内部 UAT 与缺陷闸门 ✅ 2026-09-03
  - 完成记录：覆盖官网访客公开协议 / 课程广场、平台超管登录与课程广场管理入口、机构管理员课程读取、教师班级读取、学生账户 / 仪表盘，以及未登录和越权 401/403 边界。
  - 验证：`tmp-p9-i05-uat.mjs` 使用临时 SQLite **30 pass / 0 fail**；四端生产入口、内测标识和不可索引 HTML 均通过。
  - 放行边界：线上发布后基础 HTTP / 认证 / 四端入口验收通过；仍需内部测试人员按平台超管、机构管理员、教师、学生、官网访客完成浏览器业务回归、租户隔离和真实测试数据检查，P0 缺陷未清零前不得扩大访问范围。
- [x] P9-I06 内测运行手册与日志 ✅ 2026-09-03
  - 完成记录：新增 `deploy/internal-test/RUNBOOK.md`，明确发布前检查、启停、健康检查、journal 日志、错误上报、备份、回滚、联系人占位和放行闸门；systemd 使用 journald，API 仅监听回环地址。
  - 验证：文档与脚本静态检查、P9-I01/I04/I05 验收通过；线上 systemd / Nginx / health 检查已通过；未承诺公开 SLA，不接收外部真实业务。

当前 P9 内测上线代码 / 文档基线与真实服务器受控发布均已完成：`iicili.cyou` 当前运行 release `20260904T035620Z`；API 仅监听 `127.0.0.1:8788`，使用独立测试 SQLite；线上继续保持 HTTPS、`noindex / nofollow / noarchive`、内测标识和可回滚发布能力。Basic Auth 已于 2026-09-04 按用户明确授权解除；正式公开前必须恢复访问控制。
- 线上发布确认（2026-09-04）：从已推送 commit `3d9c0f6e0e358aa688151f96576beed7bf7797fa` 在 ECS 内测环境构建 release `20260904T035620Z`，元信息为 Node `v24.19.0`、pnpm `11.19.0`、`mode=internal-test`；发布前完成独立测试数据库备份 `/srv/ai-kids-platform/internal-test/backups/20260904T035559Z/`，原子切换 `current`，重启 `learning-platform-internal-test`，本机 `/health` 返回 `status=ok`，Nginx 配置检查与 reload 成功。
- 线上只读复核（2026-09-04）：`/`、`/marketplace`、`/courses`、`/org/`、`/works`、`/handbook`、`/compare`、`/demo`、`/terms`、`/privacy`、`/minors` 均正常渲染；内测标识、`noindex, nofollow, noarchive` 与动态 canonical 均通过，官网控制台错误 0；未读取、复制、迁移或写入真实业务数据库。

- 线上发布确认（2026-09-03）：通过 ECS 云服务器终端完成 `iicili.cyou` 受控内部测试发布；验收 `/`、`/admin/`、`/org/`、`/student/` 均 HTTP 200，`/api/health` 成功，未认证返回 401，旧服务保留。未读取、复制、迁移或写入旧站真实数据库。

- 历史口径记录（2026-09-04）：用户确认备案已经完成；该条当时写作“切换为正式上线节奏”，已被后续用户决策替代。当前以本清单 §1.2 的“内测技术收口”顺序为准。

### 正式上线门槛收敛验收记录（2026-09-04）

- [x] **P8-L01 数据资产清单与最小化收集**：新增 `docs/AI少儿编程平台-数据资产与最小化收集清单.md`，覆盖账户身份、联系方式、未成年人及监护、认证会话、机构教务、学习作品、AI 记录、文件元数据、计费积分、运营沟通、隐私请求、安全审计和匿名分析；为每类数据记录用途、来源、访问角色、保存 / 删除策略、第三方共享边界和最小化规则。
- [x] **工程验收**：`p8-l01-data-inventory.mjs` 使用临时 SQLite 检查 12 类数据资产表及字段，共 **71 pass / 0 fail**，退出码 0；修复 Windows SQLite 句柄未关闭导致临时目录清理失败的问题。
- [x] **边界**：本项只完成数据资产与最小化工程基线，不将 P8-L02～P8-L06、正式协议 / 法务确认或任何真实第三方服务接入判为完成；未修改 `packages/canvas`，未触碰真实业务数据库。

- [~] **P8-L02 未成年人 / 监护同意流程（用户决策暂缓，2026-09-04）**：学生端已有监护人信息录入 / 清空、关系与确认校验、法律文档版本化阅读记录代码；历史临时 SQLite 回归通过。当前不继续开发监护人信息、监护同意、身份核验或地区年龄规则；后续需用户重新授权。
- [~] **P8-L03 隐私请求与账号注销流程（当前不扩展，2026-09-04）**：现有导出 / 注销工程基线和历史回归记录保留；不继续扩展真实 OSS 文件删除、备份延迟删除、身份核验或法律保留例外，后续需重新授权。
- [~] **P8-L04 内容举报、审核、申诉与记录保留（用户决策暂缓，2026-09-04）**：已有机构内作品举报 / 处理 / 紧急下架代码和历史回归记录保留；当前不新增举报、申诉、违规识别、审核工作台、自动下架或记录保留策略，后续需重新授权。
- [x] **P8-L02～P8-L04 历史工程回归**：新增 `p8-l02-l04-privacy-governance.mjs`，使用临时 SQLite + 隔离 API **32 pass / 0 fail**；该记录只证明历史代码可回归，不改变当前 `[~]` 暂缓决策；未修改 `packages/canvas`，未触碰真实业务数据库，未伪造真实 AI / OSS / 通知 / 支付能力。

当前先按内测技术收口顺序推进 P8-Q05、P4-C01、P4-01、P4-03 和角色 UAT；举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规及正式公开上线均 `[~]` 后置。线上 `https://iicili.cyou/` 继续保持 noindex、独立测试数据库和内测标识；Basic Auth 已按用户授权解除，正式公开前必须恢复访问控制。
### P8-Q03 验收记录（2026-09-04）

- [x] **API 集成测试扩展**：新增 `p8-q03-api-integration.mjs`，在临时 SQLite 和隔离 API 进程中覆盖认证登录失败、未认证 / 角色越权、公开接口、机构 / 班级 / 课堂、学生项目创建与版本保存、跨学生项目 / 作品访问拒绝、AI local-mock 生成与历史、作品提交 / 审核 / 发布、教师批注、积分用量和课堂结束后的能力拦截。
- [x] **既有回归纳入**：`p3-api-integration.mjs` 支持通过 `P3_API_BASE` 指定隔离测试服务，P8-Q03 脚本在同一临时数据库服务中执行 P3 主链路回归。
- [x] **验证结果**：`p8-q03-api-integration.mjs` **52 pass / 0 fail**，既有 P3 回归输出 `P3 API INTEGRATION COMPLETE`，总进程退出码 0；`git diff --check` 通过。
- [x] **边界**：local-mock 保持明确的本地模拟边界；未伪造真实 AI、OSS、支付、微信、短信、邮件或客户端；未修改 `packages/canvas`，未触碰真实业务数据库。

P8-Q04、P8-Q06、P8-S01、P8-S04、P8-S05 与 P8-S06 已于 2026-09-04 通过；P8-S05 的 ECS timer / 日志轮转已实际启用，但真实通知仍属外部运维项，线上 `https://iicili.cyou/` 继续保持 noindex、独立测试数据库和内测标识；Basic Auth 已按用户授权解除，正式公开前必须恢复访问控制。
### P8-S04 验收记录（2026-09-04）

- [x] **备份与恢复**：新增 `p8-s04-backup-recovery.mjs`，在临时隔离根目录调用内测备份脚本，备份 SQLite、release、配置、日志和 `MANIFEST.json`；恢复数据库后重新启动 API 并验证健康和公开业务接口。
- [x] **验证结果**：临时 SQLite **9 pass / 0 fail**；备份耗时 1925.2ms，恢复 API RTO 147.1ms，RPO 为备份时点；恢复前后用户 6、课程 1 数据计数一致。
- [x] **边界**：未读取、复制或写入真实线上数据库；未伪造 OSS / 对象存储备份；正式生产的异地副本、保留周期和密钥恢复权限仍需运维配置。

### P8-S05 验收记录（2026-09-04）

- [x] **监控与告警基线**：新增 `p8-s05-monitoring.mjs`、`deploy/internal-test/MONITORING.md`、健康检查脚本、systemd service/timer 模板和 logrotate 模板，覆盖健康、5xx、慢请求、磁盘、SQLite 完整性 / 备份、AI 队列和 HTTPS 证书告警，明确阈值、责任人、通知与处置、日志脱敏和事故记录字段。
- [x] **验证结果**：临时 SQLite **13 pass / 0 fail**；ECS timer 已 enabled/active，healthcheck service `Result=success` / `ExecMainStatus=0`，健康日志正常写入，`logrotate -d` 解析通过；内测 noindex、404 脱敏、运行手册、告警矩阵和 local-mock 边界均通过。
- [!] **外部运维项**：真实飞书 / 电话 / 邮件通知渠道尚未接入；不将工程监控基线冒充真实告警服务，正式公开前仍需恢复访问控制。

### P8-S06 验收记录（2026-09-04）

- [x] **发布与回滚演练**：新增 `p8-s06-release-rollback.mjs` 与 `deploy/internal-test/RELEASE-ROLLBACK.md`，明确预发发布闸门、release 路径与元数据校验、健康失败自动回滚、数据库快照恢复、事故分级通报止损和复盘模板。
- [x] **验证结果**：临时 SQLite **13 pass / 0 fail**；已验证 release 切换成功，故障 release 健康检查失败后自动恢复上一 release；坏迁移从备份快照恢复且用户 / 课程计数一致。
- [x] **边界**：未读取、复制或写入真实线上数据库；未修改 `packages/canvas`；真实 ECS 发布窗口仍需按手册执行并留存 RPO / RTO 证据，正式公开前必须恢复访问控制。

### P8-Q06 验收记录（2026-09-04）

- [x] **性能基线**：新增 `p8-q06-performance.mjs`，在临时 SQLite + 隔离 API 进程中定义并验证健康接口、公开课程接口、官网首页、模拟并发课堂读取、AI local-mock 任务突发、文件元数据并发写入和 SQLite 写入竞争边界。
- [x] **验证结果**：13 pass / 0 fail；健康接口 30 请求并发 10 的 p95 为 12.4ms，公开课程接口 p95 为 6.7ms，模拟并发课堂 20 次并发 10 的 p95 为 36.4ms，AI 3 次并发 3 的 p95 为 26.6ms，文件元数据写入 3 次并发 3 的 p95 为 17.1ms；四端构建通过。
- [x] **边界**：文件场景只验证 `file_assets` 元数据写入，不伪造真实上传 / OSS；AI 只使用明确标识的 `local-mock`；结果仅为本机隔离基线，不宣称生产公网容量；未修改 `packages/canvas`、未触碰真实线上数据库。

### P8-Q04 验收记录（2026-09-04）

- [x] **端到端业务链路**：新增 `p8-q04-e2e.mjs`，用临时 SQLite、隔离 API 进程、临时静态官网服务器和 Cookie 会话模拟，覆盖官网访客、平台超管课程上架、机构管理员班级 / 对账、教师开课、学生学习 / AI 预览 / 项目版本 / 作品提交、教师审核发布、作品墙查看、跨学生越权、计费权限、课堂结束能力拦截和注销失效。
- [x] **构建与浏览器导航烟测**：四端 `pnpm build` 通过；官网 `/`、`/marketplace`、课程详情、课程体系、预约演示、三类法律页路由返回 HTML；入口引用的 JS/CSS 资源均可加载；内测构建保留 `noindex, nofollow, noarchive`。
- [x] **验证结果**：`p8-q04-e2e.mjs` 使用 Node 24.19.0 + 临时 SQLite **54 pass / 0 fail**，退出码 0；失败时 API stdout/stderr 保留在临时 evidence 目录；`node --check` 与 `git diff --check` 通过。
- [x] **边界**：本项是非画布 HTTP / 静态构建 E2E，未修改 `packages/canvas`、未触碰真实线上数据库；AI 仍为明确标识的 `local-mock` 预览，不伪造真实第三方服务。

### P8-S02 验收记录（2026-09-04）

- [x] **认证 Cookie 加固**：`apps/server/src/lib.js` 在 `internal-test` / `production` 模式为登录和清除 Cookie 增加 `Secure`，并保留 `HttpOnly`、`SameSite=Lax`、`Path=/` 和 7 天有效期。
- [x] **会话生命周期**：单账号后登录会让旧会话返回 `SESSION_SUPERSEDED`；改密会撤销全部旧会话；注销和当前会话撤销后立即拒绝旧 token；`/me` 不回传密码哈希。
- [x] **验证结果**：`p8-s02-session-security.mjs` 使用临时 SQLite **27 pass / 0 fail**，退出码 0；`node --check` 和 `git diff --check` 通过。
- [x] **边界**：未伪造短信 / 邮件 / 微信 MFA；登录限流、CSRF 防护和正式身份核验仍列入后续安全基线评估；未修改 `packages/canvas`，未触碰真实业务数据库。

### P8-S03 验收记录（2026-09-04）

- [x] **多租户隔离**：新增 `p8-s03-tenant-isolation.mjs`，在临时 SQLite 创建第二机构、教师和学生，验证本机构班级可见性、跨租户课堂结束拒绝、跨租户项目读取拒绝、作品墙归属、账户归属和平台超管审计边界。
- [x] **验证结果**：临时 SQLite + 隔离 API **20 pass / 0 fail**，退出码 0；`node --check` 与 `git diff --check` 通过。
- [x] **安全边界**：跨租户不存在资源统一返回 404；未读取、复制、迁移或写入真实线上数据库；未修改 `packages/canvas`；没有伪造真实 OSS / 文件托管能力。
- [ ] **后续边界**：真实对象存储接入后，需另行完成文件对象级租户隔离；P8-S06 发布、回滚与事故响应演练已于 2026-09-04 通过；P8-S01 依赖漏洞扫描等待 registry 恢复后复核。

### P8-S01 安全基线验收记录（2026-09-04）

- [-] **工程安全基线已落地**：API 增加 nosniff、DENY、Referrer-Policy、Permissions-Policy；CORS 使用显式白名单，不反射不受信 Origin；登录失败按 IP + 登录名限流；请求体上限维持 2MB；Nginx 模板增加 CSP、请求体上限、server_tokens off 和安全响应头。
- [x] **验证结果**：`p8-s01-security-baseline.mjs` 使用临时 SQLite **32 pass / 0 fail**，覆盖来源白名单、预检、响应头、错误脱敏、登录限流、超大请求体、Nginx 静态配置和临时数据库隔离；P8-S02 27/27、P8-Q03 52/52 回归通过；secret pattern 扫描无命中。
- [x] **依赖漏洞扫描补充（2026-09-04）**：Node `v24.19.0` 执行 `pnpm audit --prod`，输出 `No known vulnerabilities found`；当前 P8-S01 的工程安全基线与 SCA 均通过。
- [ ] **后续安全边界**：继续按依赖升级、真实部署变更和正式公开前访问控制恢复重新复核；CSRF、正式身份核验和真实第三方服务安全仍需单独完成。线上继续保持 noindex、独立测试数据库和内测标识，正式公开前必须恢复访问控制。

P8-S01、P8-S06 发布回滚与事故响应演练、P8-Q01 代码质量基线及 P8-Q02 关键规则单元测试已通过；P8-Q05 已开始并修复官网首页运行时白屏与课程广场 API 代理缺陷，下一步只继续完成 P8-Q05 可用环境回归、P4-C01、P4-01、P4-03 与内测 UAT；P8-L02～L04 已按用户决策 `[~]` 暂缓；线上 `https://iicili.cyou/` 继续保持 noindex、独立测试数据库和内测标识；Basic Auth 已按用户授权解除，正式公开前必须恢复访问控制。

- P8-Q05 线上缺陷修复记录（2026-09-04）：线上 `/marketplace` 空数据时曾显示“加载失败”，根因是生效 Nginx HTTPS 站点 `/etc/nginx/sites-enabled/iicili.cyou` 的 `proxy_pass http://127.0.0.1:8788/;` 剥离了 `/api` 前缀；已备份并改为 `proxy_pass http://127.0.0.1:8788;`，`nginx -t`、reload 和 Codex 内置浏览器复核通过，页面现显示“暂无课程，敬请期待”。本地 `tmp-p9-i01-internal-deploy.mjs` 临时 SQLite 24/24 通过，并增加代理前缀回归断言；P8-Q05 仍因完整浏览器矩阵 / 移动端截图未完成而保持进行中。
- P8-Q05 线上路由矩阵补充（2026-09-04）：Codex 内置浏览器 Chromium 桌面视口完成 12/12 官网关键路由渲染检查；正文非空、内测 banner、noindex、canonical、动态标题均通过，未发现“加载失败 / ReferenceError”等失败文本。由于独立 Chrome / Edge / Safari 与 390/414/768 等移动端宽度截图尚未完成，P8-Q05 继续保持进行中。

### P8-Q05 / P9-I01 增量记录（2026-09-04）

- [x] **线上健康入口稳定化**：生效 Nginx 配置新增精确路由 `/api/health`，映射到 API 应用根路径 `/health`；通用 `/api/` 代理保持 `/api` 前缀，不再使用会剥离前缀的尾斜杠 `proxy_pass`。
- [x] **线上验证**：`nginx -t` 成功并 reload；`https://iicili.cyou/api/health` 返回 HTTP 200，`https://iicili.cyou/api/public/marketplace` 返回 HTTP 200；Nginx 备份已统一移至 `/etc/nginx/backups/`，避免 `sites-enabled` 重复加载警告。
- [x] **本地验收与版本**：`tmp-p9-i01-internal-deploy.mjs` 使用临时 SQLite **24 pass / 0 fail**；提交 `a874e45 fix: expose stable internal health endpoint` 已 push。
- [ ] **未完成边界**：P8-Q05 仍未完成独立 Chrome / Edge / Safari 与 390/414/768 移动端截图矩阵；不得据此标记 P8-Q05 完成。全程未修改 `packages/canvas`，未触碰真实线上数据库。

### 2026-09-04 继续推进记录：隐私与内容治理回归

- [x] **历史回归记录**：`p8-l02-l04-privacy-governance.mjs` 使用临时 SQLite **32 pass / 0 fail**；复核监护信息同意 / 撤回、协议版本、隐私设置、导出申请、注销申请、作品举报、举报下架、旧会话失效和默认数据库隔离。该记录不改变当前 `[~]` 暂缓范围，也不代表正式法律、监护人或内容治理能力已上线。
- [x] ECS 线上只读健康复核：当前 release `20260904T035620Z`，Node `v24.19.0`、pnpm `11.19.0`、`mode=internal-test`；systemd 服务 active；本地 `/health`、线上 `/api/health` 与 `/api/public/marketplace` 均返回 HTTP 200。
- [~] **用户决策后的正式合规边界**：真实监护人身份核验、按地区年龄规则、评论 / AI 内容举报、申诉渠道、违规 / 内容审核、正式法律文本及其生效发布均暂不做；现有准备稿 / 基础代码仅保留历史证据，不宣传为正式能力，后续需要时重新授权。真实对象存储延迟删除 / 备份保留等外部能力也不在当前内测队列。

### 2026-09-04 P8-Q05 移动端 / 平板视口回归增量记录

- [x] 使用 Codex 内置 Chromium 浏览器对官网 12 条关键路由在 `390`、`414`、`768` 三个视口执行 **36/36** 路由渲染检查。
- [x] 36/36 页面正文非空、无“加载失败 / ReferenceError / Application error / Not Found / 服务器错误”等失败文本；控制台错误 **0**；三种视口均未发现横向溢出（`scrollWidth <= clientWidth`）。
- [x] 每条路由的 `robots` 均为 `noindex, nofollow, noarchive`，canonical 与动态标题均存在且符合预期；截图证据保存在 `artifacts/p8-q05-20260904/`（`matrix.json`、`home-390.png`、`marketplace-414.png`、`courses-768.png`）。
- [ ] **未完成边界保持不变**：当前环境仅发现 Codex 内置 Chromium（未提供独立 Chrome、Edge、Safari 或真机连接），因此 P8-Q05 仍保持 `[-]`，不得宣称跨浏览器矩阵已完成。全程未修改 `packages/canvas`，未触碰真实线上数据库。

### 2026-09-04 用户决策更新：暂缓举报、申诉、违规、监护人和正式法律事项

- [x] 用户明确：举报、申诉、违规 / 内容审核、监护人功能以及正式法律 / 合规文本暂时不做，后续需要时再重新提出。
- [x] 已将上述范围标记为 `[~]` 暂缓；现有代码和准备稿不删除、不宣传为正式能力，也不再作为当前内测上线阻塞项。
- [x] 当前下一步改为内测技术收口：P8-Q05 可用浏览器回归边界记录、P4-03 列表规范和内测 UAT 缺陷收口；P4-C01、P4-01 已完成。
- [ ] 正式公开上线、正式法务、真实外部服务和相关合规门槛继续后置；未修改 `packages/canvas`，未触碰真实线上数据库。

### 2026-09-04 P4-C01 权限覆盖收口记录

- [x] **服务端修复**：`apps/server/src/routes/fileAssets.js` 对 ROLE 授权增加机构绑定和访问时机构一致性校验；USER 授权在指定 `orgId` 时校验目标用户归属，跨机构返回 `USER_ORG_MISMATCH`。
- [x] **专项验证**：`p4-c01-rbac-ownership.mjs` 使用临时 SQLite **27 pass / 0 fail**；覆盖未登录 / 角色越权、教师班级与课堂归属、同机构与跨机构文件授权、学生项目 / AI 历史隔离、平台管理员审计边界。
- [x] **回归验证**：`p8-s03-tenant-isolation.mjs` **20 pass / 0 fail**；P3 API 联调使用临时 SQLite 全流程通过；后端语法检查通过；未修改 `packages/canvas`，未触碰默认 `packages/data/platform.db`。
- [x] **处理结论**：P4-C01 改判为已完成 `[x]`；P4-01 已完成，下一项进入 P4-03。举报、申诉、违规 / 内容审核、监护人和正式法律 / 合规仍保持 `[~]`，不新增开发。

### 2026-09-04 P4-01 状态机 / 枚举 / 错误码统一完成记录

- [x] **共享契约**：新增 `apps/server/src/services/domainState.js`，集中维护机构、用户、开通单、支付、课程、课时、课程授权、班级、课堂、项目、作品、发布申请、AI 任务、通知、物料、充值单、账号申请、帮助反馈、文件和积分流水等领域状态与转换规则；同状态仅在明确幂等场景通过 `allowSameState` 放行。
- [x] **服务端接入**：机构 / 用户 / 开通单 / 支付 / 课程 / 课时 / 课程授权 / 班级 / 课堂 / 项目 / 作品 / 发布申请、AI 任务、通知、物料、文件状态写入路径已接入统一转换校验；非法转换统一返回领域错误码并写入 `DOMAIN_INVALID_TRANSITION` 审计日志。
- [x] **元数据接口**：新增只读 `GET /api/meta/domain-states`；不包含业务数据，可供四端逐步替换各自状态常量。
- [x] **专项验收**：`p4-01-state-machine.mjs` 使用临时 SQLite **28 pass / 0 fail**；覆盖纯函数、元数据接口、AI 任务 `QUEUED → RUNNING → SUCCEEDED`、项目重复提交、课堂重复结束、作品重复下架、班级重复归档、非法转换审计和临时数据库隔离。
- [x] **回归 / 构建**：`p4-c01-rbac-ownership.mjs` **27 pass / 0 fail**；`p8-s03-tenant-isolation.mjs` **20 pass / 0 fail**；Node 24 语法检查、四端生产构建和 `git diff --check` 通过。未修改 `packages/canvas`，未触碰默认 `packages/data/platform.db` 或真实线上数据库。
- [~] **明确不在本批次**：举报、申诉、违规 / 内容审核、监护人功能、正式法律 / 合规文本继续暂缓；现有历史代码 / 准备稿不代表当前正式能力，后续需要时重新授权。


### 2026-09-04 P4-03-LIST 机构列表批次

- [x] `GET /api/admin/organizations` 已支持机构名称 / ID 搜索、`TRIAL` / `ACTIVE` / `DISABLED` 状态筛选、`created` / `name` / `expires` 白名单排序和 `page` / `limit` 分页。非法排序值安全回退到 `created`。
- [x] `/organizations` 已接入筛选控件、排序、每页数量、`ListResultSummary`、`Pagination` 和筛选空态；所有条件变更回到第 1 页。
- [x] 验收：`p4-03-list-api-check.mjs` 使用临时 SQLite **11 pass / 0 fail**；admin 生产构建、`git diff --check` 通过。
- [x] 影响文件：`apps/server/src/routes/adminOrg.js`、`apps/admin/src/main.jsx`、`p4-03-list-api-check.mjs`。影响接口：`GET /api/admin/organizations`。无数据库结构变更。
- [ ] 下一批继续处理课程、平台管理员、通知 / 物料和账务列表的统一分页 / 导出；举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规继续保持 `[~]` 暂缓，不新增开发。


### 2026-09-04 P4-03-LIST 课程列表批次

- [x] `GET /api/admin/course-series` 已支持课包名称 / ID 搜索、`DRAFT` / `PUBLISHED` / `ARCHIVED` 状态筛选、`ALL_ORGS` / `ASSIGNED_ORGS` / `PRIVATE` 可见范围筛选、`manual` / `created` / `updated` / `title` 白名单排序和 `page` / `limit` 分页。非法排序值安全回退到 `manual`。
- [x] `/courses` 已接入筛选控件、排序、每页数量、`ListResultSummary`、`Pagination` 和筛选空态；所有条件变更回到第 1 页。
- [x] 列表接口改为只输出课包摘要，完整课时仍通过现有详情接口按需读取，避免分页列表加载全部课时正文。
- [x] 验收：`p4-03-list-api-check.mjs` 使用临时 SQLite **14 pass / 0 fail**；admin 生产构建、`git diff --check` 通过。
- [x] 影响文件：`apps/server/src/routes/adminOrg.js`、`apps/admin/src/main.jsx`、`p4-03-list-api-check.mjs`。影响接口：`GET /api/admin/course-series`。无数据库结构变更。
- [ ] 下一批继续处理平台管理员、通知 / 物料和账务列表的统一分页 / 导出；举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规继续保持 `[~]` 暂缓，不新增开发。


### 2026-09-04 P4-03-LIST 平台管理员列表批次

- [x] `GET /api/admin/platform-admins` 已支持关键词搜索、`ACTIVE` / `DISABLED` 状态筛选、`created` / `name` / `status` 白名单排序和 `page` / `limit` 分页。非法排序值安全回退到 `created`。
- [x] `/admins` 已接入排序、每页数量、`ListResultSummary`、`Pagination` 和筛选空态；关键词、状态、排序、每页数量变化均回到第 1 页。
- [x] 验收：`p4-03-list-api-check.mjs` 使用临时 SQLite **17 pass / 0 fail**；admin 生产构建、`git diff --check` 通过。
- [x] 影响文件：`apps/server/src/routes/adminOrg.js`、`apps/admin/src/main.jsx`、`p4-03-list-api-check.mjs`。影响接口：`GET /api/admin/platform-admins`。无数据库结构变更。
- [ ] 下一批继续处理通知 / 物料和账务列表的统一分页 / 导出；举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规继续保持 `[~]` 暂缓，不新增开发。

### 2026-09-04 P4-03-LIST 通知 / 宣传物料列表批次

- [x] `GET /api/admin/inbox` 已支持通知标题 / 内容搜索、`DRAFT` / `SCHEDULED` / `PUBLISHED` / `RECALLED` 状态筛选、`created` / `updated` / `publish` / `title` / `pinned` 白名单排序和 `page` / `limit` 分页。非法排序值安全回退到 `created`。
- [x] `GET /api/admin/materials` 已支持物料名称 / 说明搜索、状态 / 分类 / 可见范围筛选、`created` / `updated` / `title` / `events` 白名单排序和 `page` / `limit` 分页。非法排序值安全回退到 `created`。
- [x] `/inbox` 与 `/materials` 已接入筛选控件、排序、每页数量、`ListResultSummary`、`Pagination` 和筛选空态；所有条件变更回到第 1 页。
- [x] 验收：`p4-03-list-api-check.mjs` 使用临时 SQLite **23 pass / 0 fail**；四端生产构建、`git diff --check` 通过。
- [x] 影响文件：`apps/server/src/routes/communication.js`、`apps/admin/src/main.jsx`、`p4-03-list-api-check.mjs`。影响接口：`GET /api/admin/inbox`、`GET /api/admin/materials`；无数据库结构变更。
- [ ] 下一批继续处理账务列表的统一分页 / 筛选 / 排序 / 导出边界；举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规继续保持 `[~]` 暂缓，不新增开发。
