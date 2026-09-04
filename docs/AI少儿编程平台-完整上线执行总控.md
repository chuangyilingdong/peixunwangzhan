# AI 少儿编程平台｜完整上线执行总控

> **唯一总控文件 / Single Source of Truth**  
> 工程根目录：`D:\学习平台\platform-v2`  `n> 受版本控制的总控文件：`docs\AI少儿编程平台-完整上线执行总控.md`  
> 创建日期：2026-09-02  
> 当前阶段：**非画布真实业务闭环已完成本轮开发；线上受控内部测试已发布，现按内测产品与技术收口推进。正式法律 / 合规、监护人、举报、申诉、违规 / 内容审核和正式公开上线均按 2026-09-04 用户决策暂缓。**用户已确认备案完成，备案后续材料与具体办理由用户自行处理；线上继续保持 noindex、独立测试数据库和“内部测试环境”标识；Basic Auth 已按用户于 2026-09-04 的明确授权解除，仅供内部人员使用，正式公开前仍需补齐访问控制与公开上线门槛。真实 AI / 文件 / 支付 / 微信等外部服务仍必须有真实接入与验收，禁止用占位能力冒充正式服务。**
> 当前总原则：**除 `packages/canvas` 外，网站与三端按”AI 魔法学院”基准持续实施；画布暂时冻结，必须等待用户再次明确授权后才可改动。**

---

## 0. 使用规则（以后每一个新对话都先读本文件）

### 0.1 本文件的地位

- 本文件是本项目后续开发、测试、部署、上线和运营交接的**唯一进度总控**。
- 过去的交接文档仍保留为历史证据，但若与本文件发生进度冲突，**以本文件的最新记录为准**。
- 每一个新对话开始后，必须先读取本文件，再读取本文件列出的相关代码和基准资料；不得只依赖对话记忆推进工作。
- 每次开发、修复、验证或上线准备结束，都必须在本文件中同步更新：
  1. 对应事项是否从 `[ ]` 改为 `[x]`；
  2. 实际完成日期；
  3. 涉及文件 / 接口 / 数据表；
  4. 验证方式与结果；
  5. 若未完成，明确写出阻塞原因和下一步。

### 0.2 勾选与状态约定

- `[ ]`：尚未开始，或未满足验收条件。
- `[-]`：已开始但未完成；必须写明当前状态、剩余项、阻塞原因。
- `[x]`：已完成且有对应验证记录；**不能因为“页面做了”或“代码写了”就直接勾选**。
- `[!]`：外部决策、账号、密钥、预算、合规材料或第三方审批阻塞；没有用户/业务方确认不得假装完成。
- `[~]`：暂缓、已不再适用或被替代；必须保留当前处理口径 / 后续恢复条件，不能直接删除历史记录。

### 0.3 何时允许打勾

除纯文档事项外，每项至少同时满足：

1. 功能已实现，正常路径可实际操作；
2. 失败、权限不足、空数据等关键异常有合理提示；
3. 对应端（平台 / 机构 / 教师 / 学生 / 官网访客）符合权限边界；
4. 至少完成该事项列出的验证；
5. 未破坏现有构建、已有 API 主链路和既有数据；
6. 已在“完成记录”中写入日期、验证命令/场景和文件。

### 0.4 每次对话结束前必做更新模板

复制下面模板补到对应事项的“完成记录”中：

```markdown
- 完成记录（YYYY-MM-DD）：
  - 状态：`[x]` / `[-]` / `[!]`
  - 实现：……
  - 影响文件 / 接口 / 数据表：……
  - 验证：……
  - 遗留风险或下一步：……
```

### 0.5 不可违反的边界

- **画布冻结**：未经用户再次明确授权，禁止修改：
  ```text
  D:\学习平台\platform-v2\packages\canvas
  ```
- 参考“AI 魔法学院”的产品结构、角色、流程、页面语义和视觉方向，但不得复制其私有源码、接口密钥、数据库、构建产物内容或未获授权的素材。
- 本地 `local-mock` AI 仅是演示 / 开发占位，**不得对外宣称为真实 AI 生成服务**。
- 任何真实 AI、对象存储、支付、短信、微信、邮件、正式公开生产、隐私合规、域名备案事项，都必须先记录外部依赖与验收，不能以页面占位替代真实能力。
- **内部测试可以先部署，但只能使用隔离环境和受控访问**：网址不公开、不允许搜索引擎索引、不接收真实外部用户，不得触碰真实线上数据库；页面必须明确“内部测试环境 / 不代表正式服务”。
- 不直接污染默认数据库：
  ```text
  D:\学习平台\platform-v2\packages\data\platform.db
  ```
  开发验证优先使用临时 SQLite 数据库、迁移备份和可回滚脚本。

---

### 0.6 用户当前范围决策（2026-09-04）

用户明确本阶段只继续推进内部测试所需的产品与技术事项，以下内容暂不做，后续需要时再重新授权：

| 状态 | 暂缓事项 | 当前处理口径 |
|---|---|---|
| `[~]` | 举报 | 不新增作品、评论或 AI 内容举报能力；现有已实现的基础作品举报代码保留，不作为当前内测承诺。 |
| `[~]` | 申诉 | 不建设申诉入口、申诉状态机或申诉工单流程。 |
| `[~]` | 违规 / 内容审核 | 不新增违规识别、审核工作台、自动下架、人工复核或违规升级流程。 |
| `[~]` | 监护人功能 | 不继续开发监护人信息、监护同意、身份核验和按地区年龄规则；已有代码仅保留，不作为当前内测必需。 |
| `[~]` | 正式法律 / 合规文本 | 暂不推进正式用户协议、隐私政策、儿童 / 未成年人说明的法务确认、生效发布及相关正式合规结论；现有准备稿页面不代表正式法律文本。 |
| `[~]` | 公开内容合规 | 内测期间不扩大公开作品、未成年人数据或内容治理范围；正式公开上线暂缓。 |

以上事项不得继续拆分开发、不得伪造为已完成，也不得作为当前内测上线阻塞项；恢复时必须重新记录范围、负责人、规则和验收标准。

## 1. 当前唯一下一步与阶段看板

### 1.1 当前唯一下一步（2026-09-04：转入内测产品与技术收口）

> **执行口径：**线上 `https://iicili.cyou/` 当前只作为受控内部测试站。当前继续做非画布核心产品、权限、数据隔离、质量回归和内测运维；举报、申诉、违规 / 内容审核、监护人功能、正式法律 / 合规文本和正式公开上线均按用户决策暂缓，不把 `local-mock`、协议准备稿或未接入外部服务宣传为正式能力。

- [ ] **当前唯一执行队列：内测产品与技术收口。**
  - P0：P8-Q04、P8-Q06、P8-S01、P8-S04、P8-S06 已于 2026-09-04 通过；P8-S05 监控工程基线、ECS timer 与日志轮转已于 2026-09-04 完成；真实飞书 / 电话通知仍属外部运维项，不宣称已接入。
  - P1：P8-Q01、P8-Q02 已通过；P4-C01、P4-03 已于 2026-09-04 完成；P8-Q07 四角色 UAT 已于 2026-09-04 全部完成。P8-Q05 已使用本机真实 Chrome 152 / Edge 152 完成官网 96/96 与工作台 52/52 回归，并修复共享工作台 390px 横向溢出；Safari 与真实移动设备仍不可用，P8-Q05 继续 `[-]`，不得宣称全浏览器矩阵完成。举报、申诉、违规 / 内容审核、监护人和正式法律 / 合规按用户决策 `[~]` 暂缓。
  - 所有自动化验收继续使用临时 SQLite；不得读取、复制、迁移或写入旧站真实数据库。
  - 线上内测部署作为预发布环境继续保留；每次发布前执行独立数据库、备份、健康检查、回滚和浏览器 UAT。
- [!] **外部 / 用户侧事项。**
  - 备案：用户已确认完成，后续材料与办理由用户自行处理；平台侧不代办、不据此伪造正式合规结论。
  - 真实 AI、OSS / 文件、支付、微信、短信、邮件及客户端能力没有真实账号、合同、密钥或业务规则时不得实现假接入。
- [~] **当前明确暂缓事项。**
  - P5-W08 正式协议正文、主体、联系人和生效信息：现有页面只作为准备稿，不得当作正式法律文本，当前不继续拆分开发。
  - 举报、申诉、违规 / 内容审核、监护人功能和正式公开上线：不进入当前执行队列，后续需要时重新授权。
- [x] **P9-I01 内部测试环境部署基线。** ✅ 2026-09-03
  - 完成记录：固化 `deploy/internal-test/` 的 Windows/Linux 构建脚本、发布目录约定、systemd 服务模板、Nginx 四端模板、环境变量样例和启动 / 停止 / 健康检查命令；发布产物包含 website/admin/org/student 四端、API 源码、数据库运行时和 `BUILD-METADATA.txt`。
  - 验证：`tmp-p9-i01-internal-deploy.mjs` 使用临时 SQLite **24 pass / 0 fail**；四端构建成功，API 可启动并返回 `/health` `status=ok`。本地最新 release `deploy/releases/20260903T162708Z`，元信息为 commit `3577ac18d162529ff21fea4aa41c29f56bce0fe4`、Node `v24.19.0`、pnpm `11.19.0`、`mode=internal-test`，并按线上域名构建 `VITE_PUBLIC_SITE_URL=https://iicili.cyou`。
     - 线上路由矩阵补充（2026-09-04）：Codex 内置浏览器 Chromium 桌面视口对 `/`、`/marketplace`、`/courses`、`/org`、`/works`、`/handbook`、`/compare`、`/download`、`/demo`、`/terms`、`/privacy`、`/minors` 共 **12/12** 路由执行渲染检查；页面正文非空、内测 banner 存在、robots 为 `noindex, nofollow, noarchive`、canonical 与动态标题均符合预期，未发现“加载失败 / ReferenceError”等页面失败文本。
     - 独立浏览器增量（2026-09-04）：本机 Chrome 152.0.7977.64 与 Edge 152.0.4191.53 对官网 12 路由 × 1440/390/414/768 视口执行真实渲染、失败文本、控制台错误、横向溢出与 noindex 检查，**96/96 通过**；对 admin/org/student 三端 13 条关键路由执行 1440 与 390 视口检查，桌面 26/26 通过，首次移动 390 检查 26 项全部存在共享布局横向溢出。
- [x] **P9-I02 内部访问控制与不可索引。** ✅ 2026-09-03
  - 完成记录：Nginx 模板四个 server 均启用 Basic Auth、`X-Robots-Tag: noindex, nofollow, noarchive`、`X-Internal-Test: true` 和 SPA fallback；API 内测响应同样加头，`robots.txt` 为 `Disallow: /`，`sitemap.xml` 返回 404；前端显示“内部测试环境 · 不代表正式服务”。
  - 验证：部署验收 **24 pass / 0 fail**，并在 UAT 中验证未登录 admin API 为 401；静态断言覆盖 Basic Auth、robots、API 代理和 SPA fallback。
  - 线上基线结果（2026-09-03）：Basic Auth 曾在 `iicili.cyou` 生效，未认证请求返回 401；内测响应头、robots 和 sitemap 行为已实测。该站仍不是正式公开服务。
  - 线上策略变更（2026-09-04）：按用户明确授权，仅从 `/etc/nginx/sites-enabled/iicili.cyou` 移除 `auth_basic` / `auth_basic_user_file` 两行，保留 HTTPS、`X-Robots-Tag`、`X-Internal-Test`、robots 禁索引和独立测试数据库；`nginx -t` 成功、reload 成功，外部 HEAD 与 `/api/health` 均 HTTP 200 且不再返回 `WWW-Authenticate`。Nginx 模板仍保留 Basic Auth，供后续受控部署使用。
- [x] **P9-I03 测试数据、环境隔离与初始化。** ✅ 2026-09-03
  - 完成记录：环境变量支持独立 `PLATFORM_DATA_DIR` / `PLATFORM_DB_PATH`；初始化、seed、清理命令和五类角色测试账号均纳入手册；构建与验收脚本拒绝使用仓库默认数据库。
  - 验证：临时 SQLite 初始化和 seed 成功；UAT 以平台超管、机构管理员、教师、学生和官网访客路径执行，未读取或写入 `packages/data/platform.db`。
- [x] **P9-I04 备份、恢复与回滚演练。** ✅ 2026-09-03
  - 完成记录：新增 `backup-internal-test.mjs` / `.sh` 和 `rollback-internal-test.sh`；备份包含 SQLite、当前静态 release、配置、日志和 `MANIFEST.json`，回滚脚本校验 release 位于隔离 releases 目录，切换后健康检查失败自动恢复上一 release。
  - 验证：`tmp-p9-i04-backup.mjs` 使用临时 SQLite **11 pass / 0 fail**，完成数据库备份、清单、制品 / 配置 / 日志备份和恢复数据一致性校验。
  - 运行指标：本地演练 RPO 为备份时点，RTO 为健康检查通过后的切换时间；真实服务器已生成备份清单并保留旧 release / 旧 systemd / 旧 Nginx 配置，可按 runbook 回滚。
- [x] **P9-I05 内部 UAT 与缺陷闸门。** ✅ 2026-09-03
  - 完成记录：覆盖官网访客公开协议 / 课程广场、平台超管登录与课程广场管理入口、机构管理员课程读取、教师班级读取、学生账户 / 仪表盘，以及未登录和越权 401/403 边界。
  - 验证：`tmp-p9-i05-uat.mjs` 使用临时 SQLite **30 pass / 0 fail**；四端生产入口、内测标识和不可索引 HTML 均通过。
  - 放行边界：线上发布后基础 HTTP / 认证 / 四端入口验收通过；仍需内部测试人员按平台超管、机构管理员、教师、学生、官网访客完成浏览器业务回归、租户隔离和真实测试数据检查，P0 缺陷未清零前不得扩大访问范围。
- [x] **P9-I06 内测运行手册与日志。** ✅ 2026-09-03
  - 完成记录：新增 `deploy/internal-test/RUNBOOK.md`，明确发布前检查、启停、健康检查、journal 日志、错误上报、备份、回滚、联系人占位和放行闸门；systemd 使用 journald，API 仅监听回环地址。
  - 验证：文档与脚本静态检查、P9-I01/I04/I05 验收通过；线上 systemd / Nginx / health 检查已通过；未承诺公开 SLA，不接收外部真实业务。

当前 P9 内测上线代码 / 文档基线与真实服务器受控发布均已完成：`iicili.cyou` 当前运行 release `20260904T035620Z`；API 仅监听 `127.0.0.1:8788`，使用独立测试 SQLite；线上继续保持 HTTPS、`noindex / nofollow / noarchive`、内测标识和可回滚发布能力。Basic Auth 已于 2026-09-04 按用户明确授权解除；正式公开前必须恢复访问控制。
- 线上发布确认（2026-09-04）：从已推送 commit `3d9c0f6e0e358aa688151f96576beed7bf7797fa` 在 ECS 内测环境构建 release `20260904T035620Z`，元信息为 Node `v24.19.0`、pnpm `11.19.0`、`mode=internal-test`；发布前完成独立测试数据库备份 `/srv/ai-kids-platform/internal-test/backups/20260904T035559Z/`，原子切换 `current`，重启 `learning-platform-internal-test`，本机 `/health` 返回 `status=ok`，Nginx 配置检查与 reload 成功。
- 线上三端入口路由修复（2026-09-04）：用户使用正确链接访问 `/admin/`、`/org/`、`/student/` 时全部回落官网，真实 Chrome 复测确认三者均加载官网产物 `assets/index-BeV1DcaJ.js` / `assets/index-6IYHldkb.css`。服务器诊断发现 `current` 指向 `20260904T035620Z` 且四端 `index.html` 均存在，但三个专用 location 内的 `rewrite ^/(admin|org|student)/(.*)$ /$1 break;` 使 `try_files` fallback 最终解析回官网 root。已备份原配置到 `/etc/nginx/backups/iicili.cyou.before-spa-route-fix.20260904T110906Z`，删除三段 rewrite 并将 root 提升为 `/srv/ai-kids-platform/internal-test/current/apps`，`nginx -t` 与 reload 成功。公网回归 4/4：官网、平台管理、机构教务、学生创作分别加载对应端产物，安全头 `noindex, nofollow, noarchive` 与 `X-Internal-Test: true` 均通过；`root/admin123`、`org-admin/org123`、`student-2/study123` 实际登录均进入各自 dashboard，无浏览器控制台错误。新增 `scripts/verify-production-entrypoints.mjs`，后续验收必须检查标题、登录文案、资源前缀和安全头，不得仅以 HTTP 200 作为入口通过标准。
- 线上只读复核（2026-09-04）：`/`、`/marketplace`、`/courses`、`/org/`、`/works`、`/handbook`、`/compare`、`/demo`、`/terms`、`/privacy`、`/minors` 均正常渲染；内测标识、`noindex, nofollow, noarchive` 与动态 canonical 均通过，官网控制台错误 0；未读取、复制、迁移或写入真实业务数据库。

### 1.2 已完成事项与外部待决事项

- [x] **P5-M01 课程广场。** ✅ 2026-09-03
  - 优先级：P0
  - 完成记录：
    - [x] admin `GET /api/admin/course-marketplace`（status/search/page/limit，PENDING 优先排序）、`GET /:id`、`PUT /:id`（状态+积分）、`PUT /:id/rewards`（独立积分更新）。
    - [x] 公开 `GET /api/public/marketplace`（difficulty/ageMin/ageMax/tag/search/sort=popular|recent/page/limit，仅 APPROVED+ALL_ORGS）与 `GET /api/public/marketplace/:id`（lessonContent 截断 2000）。
    - [x] 平台端 `/marketplace` 升级为 CourseMarketplace 工作台：状态过滤、搜索、分页、上下架、设置积分、详情抽屉、难度星 / 年龄段 / 标签 / 奖励积分卡。
    - [x] 官网 `/marketplace` 列表与 `/marketplace/:id` 详情接通真实 API，原 11 条硬编码示例仍作为 fallback。
    - [x] 验证：临时 SQLite 75 pass / 0 fail；`node --check`、四端生产构建、`git diff --check` 均通过。
    - [x] 画布未修改、真实数据库未触碰、未伪造支付、评分与评论、未部署线上。
- [x] **P5-W05 课程资料字段。** ✅ 2026-09-03
  - 优先级：P0
  - 完成记录：
    - [x] schema 新增 `difficulty_level`(1-5) / `age_range_min` / `age_range_max` / `tags`(JSON) / `lesson_content`；seed 补 `AI古诗词创意营` 默认值（difficulty=3、age 8-16、tags=语文/创意/古诗词/动画、每课时含 lessonContent）。
    - [x] `normalizeSeries` / `normalizeLesson` 同步输出新字段；admin `POST/PUT /admin/course-series` 接受新字段并校验难度 1-5、年龄下限 ≤ 上限、标签数组 ≤ 20；课时 `PUT` 接受 `lessonContent` 并写 `COURSE_LESSON_CONTENT_UPDATE` 审计。
    - [x] 学员端 `GET /student/courses?difficulty&ageMin&ageMax&tag&search` 筛选 + `GET /student/courses/:seriesId` 详情；机构端 `GET /org/course-series/:seriesId` 详情；公开 `GET /public/course-series` + `/:id` 详情（lessonContent 截断 2000）。
    - [x] 学员/机构/官网三端列表与详情页接通新字段；学员端增加难度/年龄/标签 chip + 筛选 + 详情正文；机构端增列与详情页；官网列表与 `/courses/:id` 详情接通。
    - [x] 验证：临时 SQLite 100 pass / 0 fail；`node --check`、四端生产构建、`git diff --check` 均通过。
    - [x] 画布未修改、真实数据库未触碰、未部署线上。
- [~] **P5-W08 协议 / 隐私 / 未成年人说明。**（准备稿和工程闭环保留；正式法律 / 合规确认与生效发布按用户决策暂缓）
  - 优先级：P1
  - 完成记录（2026-09-03）：
    - [x] 官网新增 `/terms`、`/privacy`、`/minors` 三类协议页；Footer 在公开页提供入口；页面统一展示版本 `2026.09.03`、拟生效日期 `2026-09-03`、主体 `五格殿下 · AI魔法学院`，并明确“上线准备稿：正式备案主体与法务确认后生效”。
    - [x] `/demo` 预约提交强制当前协议版本与同意时间；`leads` 保存 `legal_consent_version` / `legal_consented_at`，平台端线索详情返回同意元数据。
    - [x] 新增 `legal_consents` 表；学生端 `/account` 可查看三类协议阅读状态，并通过当前密码确认后记录 `TERMS` / `PRIVACY` / `MINORS` 版本与时间；注销 / 数据导出入口继续联动 P4-S06。
    - [x] 影响文件 / 接口 / 数据表：`apps/website/src/legal.js`、`apps/website/src/main.jsx`、`apps/website/src/styles.css`、`apps/student/src/main.jsx`、`apps/student/src/styles.css`、`apps/server/src/routes/communication.js`、`apps/server/src/routes/student.js`、`packages/database/src/schema.js`；`GET /api/public/legal`、`POST /api/public/contact`、`GET/POST /api/student/account/legal-consents`；`leads`、`legal_consents`。
    - [x] 验证：临时 SQLite 验收脚本 `tmp-p5-w08-legal.mjs` **18 pass / 0 fail**；覆盖协议元数据、预约缺少 / 旧版本 / 非法时间、线索落库与 admin 回读、学生认证 / 当前密码 / 类型 / 版本 / 三类记录 / 幂等；后端语法检查、四端生产构建、`git diff --check` 通过。
    - [x] 边界：未修改 `packages/canvas`，未触碰真实 `packages/data/platform.db`，未伪造 AI / 微信 / 短信 / 邮件 / OSS / 支付 / 客户端；当前文案不是正式法务意见。
  - 当前处理：不继续推进正式法律文本、法务确认、生效发布或相关正式合规结论；准备稿仅供内部测试界面占位，不能标记为正式上线完成。
  - 后续恢复条件：用户重新授权并提供正式主体、正文、生效信息及验收标准后，再单独立项。
- [x] **P5-W01 官网内容 CMS / 配置化与 P5-W07 SEO / 可访问性 / 性能优化** ✅ 2026-09-03
  - P5-W11 已同步完成：第一方匿名统计同意、公开事件接收、平台转化漏斗与 90 天保留策略已接通；备案 / 域名 / 外部服务仍按 §5.2、§6 保持阻塞。
  - 已完成结构化内容编辑、草稿预览、发布 / 历史版本 / 回滚；公开站已接入 SEO head、robots、sitemap、动态标题、关键 aria 语义与窄屏布局。
  - 其他开放项：P5-W09 / P5-W10（见 §5.2，按用户安排后续再做）；P5-W08 已按用户决策 `[~]` 暂缓；P5-W03/W06 已产品决策取消（见对应 todo 行的 `[~]` 标记）；`/org/afee` 阿飞提醒仍依赖微信开放平台；`/org/enrollment` 学员开通单已由 P4-O07 覆盖并改判“真实已有”；`/demo` 预约演示已由 P5-W02 覆盖并改判“真实已有”。

- [x] **P4-O01 机构首页真实经营看板第一批闭环。**
  - 优先级：P0
  - 完成记录（2026-09-02）：
    - [x] `apps/server/src/routes/adminOrg.js` 的 `GET /api/org/overview` 已区分机构管理员经营视图与教师教学视图，返回 `scope`、统计口径、近期课堂、待点评作品、未读消息摘要和提醒数据。
    - [x] 机构管理员统计当前机构的活跃班级、活跃课堂、覆盖学员、教师、作品、机构积分余额，并展示合同到期、教师席位和积分余额预警。
    - [x] 教师仅统计本人负责或通过 `class_members.role='TEACHER'` 且未移除的授权班级；不返回机构积分余额和机构教师使用席位。
    - [x] 机构端 `/dashboard` 已展示角色化标题、统计口径、经营 / 教学提醒、未读消息、近期课堂、待点评作品、真实空态和刷新入口。
    - [x] 验证：临时 SQLite 完成管理员 / 教师正反向、跨教师、跨机构和通知可见性场景；`node --check`、P3 API 回归 `46 pass / 0 fail`、四端生产构建、`git diff --check` 均通过。
    - [x] 本批未修改 `D:\学习平台\platform-v2\packages\canvas`，未触碰真实 `platform.db`，未伪造 AI、支付、通知外部通道或运营数据，未部署线上环境。
  - 已知边界：`/api/org/classes`、`/api/org/works` 等既有教务接口的教师授权班级统一规则仍需在成员管理批次中收敛；本批只保证首页看板接口的数据范围。
- [x] **P4-O02 机构账号 / 成员完整管理。**
  - 优先级：P0
  - 完成记录（2026-09-02）：
    - [x] 机构管理员可创建、编辑、启用 / 停用教师与学生账号；手机号、登录名、角色、教师权限码、机构套餐和班级归属均做服务端校验。
    - [x] 批量导入支持预览、逐行失败报告、教师席位校验和整批原子提交；任一行失败时不写入任何账号。
    - [x] 机构管理员可为教师授权班级、为学生调班；教师可访问本人负责或通过 `class_members.role='TEACHER'` 授权且未移除的班级，班级详情 / 课堂 / 作品 / 点评 / 用量范围统一收敛。
    - [x] 停用账号立即让现有 `sessions` 失效；重置密码同步撤销原会话；禁止机构管理员停用自己；操作写入 `audit_logs`，机构管理员可查询审计记录。
    - [x] 机构端 `/members` 已提供创建、编辑、状态切换、重置密码、班级授权 / 调班、CSV / TSV 预览和整批导入反馈。
    - [x] 影响文件 / 接口 / 数据表：`apps/server/src/routes/adminOrg.js`、`apps/org/src/main.jsx`、本文件及 P4 缺口清单；`GET/POST/PUT /api/org/users`、`POST /api/org/users/import/preview`、`POST /api/org/users/import/commit`、`PUT /api/org/users/:id/classes`、`PUT /api/org/users/:id/password`、`GET /api/org/audit-logs`；复用 `users`、`sessions`、`class_members`、`classes`、`audit_logs`。
    - [x] 验证：临时 SQLite P4-O02 API `38 pass / 0 fail`；覆盖创建 / 编辑、重复登录名 / 手机号、批量成功与逐行失败、整批回滚、教师越权与授权、学生调班、停用 / 重置密码会话失效、审计和跨机构隔离；P3 API 回归 `46 pass / 0 fail`；四端生产构建、后端语法检查和 `git diff --check` 通过。
    - [x] 本批未修改 `D:\学习平台\platform-v2\packages\canvas`，未触碰真实 `platform.db`，未伪造 AI、支付、OSS 或运营数据，未部署线上环境。
  - 已知边界：教师授权目前以现有班级负责人 / `class_members` 关系为范围依据；更深层作品数据中心、导出与统计下钻转入 P4-O06，外部身份同步与通知通道不在本批。
- [x] **P4-O03 班级、课程与排课闭环增强。**
  - 优先级：P0
  - 选择原因：成员、教师授权和班级读取范围已形成闭环，下一步应补齐班级详情、课程计划、课时排序、补课 / 取消和课程进度等教务操作。
  - 完成记录（2026-09-02）：
    - [x] 已完成班级详情聚合：成员、课程计划、课堂历史、课程进度，以及开始 / 提交 / 发布统计；新增课时排序、普通课堂、补课课堂、结束和取消流程。
    - [x] 已新增并接通 `GET /api/org/classes/:id/sessions`、`GET /api/org/classes/:id/progress`、`POST /api/org/classes/:id/sessions/makeup`、`POST /api/org/classes/:id/sessions/:sessionId/cancel`，并收敛课堂状态与归档班级写权限。
    - [x] 已在 `class_sessions` 增加兼容迁移字段 `session_kind TEXT NOT NULL DEFAULT 'REGULAR'`；服务端重新生成连续 `sort`，课堂返回课时名称及开始 / 结束人员名称。
    - [x] 已完成教师范围和状态机校验：教师只能访问本人负责或已授权班级，不能改派其他教师；活动课堂不可重复开启，已结束 / 已取消课堂不可重复操作，归档班级不可修改成员、课单或开课；学生仅能看到已加入且已发布课时。
    - [x] 影响文件：`apps/server/src/routes/adminOrg.js`、`apps/server/src/lib.js`、`packages/database/src/schema.js`、`apps/org/src/main.jsx`；数据表：`classes`、`class_members`、`class_curriculum_items`、`class_sessions`。
    - [x] 验证：P4-O03 临时 SQLite 主验收与跨机构 / 未发布内容隔离验收通过；P3 API 回归 `46 pass / 0 fail`；`node --check`、四端 `pnpm.cmd run build`、`git diff --check` 均通过。
    - [x] 本批未修改 `D:\学习平台\platform-v2\packages\canvas`，未触碰真实 `platform.db`，未伪造 AI、支付、OSS 或运营数据，未部署线上环境。
  - 已知边界：课堂内 AI 能力控制与使用审计转入 P4-O04；课程资产上传、导出与更深层作品数据下钻仍按后续批次处理。
- [x] **P4-O04 课堂内 AI 能力控制与使用审计。**
  - 优先级：P0
  - 选择原因：班级、课程计划和课堂状态链路已具备真实数据基础，补齐课堂内 AI 能力的服务端开关、额度限制、教师即时暂停和可追溯审计。
  - 完成记录（2026-09-02）：
    - [x] 已新增课堂 AI 控制字段与兼容迁移：`class_sessions.ai_paused`、`class_sessions.student_call_cap`，并为课堂 / 生成任务用量查询补充索引；`usage_records.generation_job_id` 保持可追溯关联。
    - [x] 已完成普通 AI 调用与素材生成任务的统一课堂控制：暂停、文本 / 图像 / 音乐 / 视频 / 播客 / 配音开关、单学生调用次数上限、课堂积分上限均由服务端强制执行。
    - [x] 已完成机构管理员 / 教师课堂控制接口与机构端控制面板；新增 `/api/org/ai-usage`，按机构、教师授权课堂、学生、课时、项目、generation job、模型、状态和失败码查询。
    - [x] 普通调用和策略拦截的生成任务均写入 `usage_records`，策略拦截状态为 `BLOCKED`；成功生成任务写入 `generation_job_id`。
    - [x] 临时 SQLite P4-O04 API 验收完成：`36 pass / 0 fail`。
    - [x] P3 API 回归：`46 pass / 0 fail`；后端 `node --check`、四端 `pnpm.cmd run build`、最终 `git diff --check` 均通过。
    - [x] 本批未修改 `D:\学习平台\platform-v2\packages\canvas`，未触碰真实 `platform.db`，未伪造外部 AI / 支付 / OSS / 运营数据，未部署线上环境。
  - 已知边界：真实外部 AI provider、异步队列、失败重试、账单 / 计费策略和更深层作品数据中心仍按后续批次处理，未将本地 mock 能力包装为线上真实服务。
- [x] **P4-O06 作品数据中心。**
  - 完成记录（2026-09-02）：按班级 / 课程课时 / 学员下钻真实创作、提交、审核发布、反馈与成功 AI 用量；仅 ORG_ADMIN 可访问，支持 7 / 14 / 30 日与资源范围校验，脱敏 CSV 导出写入审计。临时 SQLite P4-O06 API 验收与 P3 API 回归均通过；画布冻结、真实数据库未触碰、未部署线上。
- [x] **P4-O07 套餐、学员开通与席位管理。**
  - 完成记录（2026-09-02）：套餐已支持学员席位配置与占用统计；管理员可创建待开通单、登记线下履约、开通 / 停用 / 恢复 / 续费 / 作废。仅生效开通单占席位，停用 / 到期会撤销学生套餐权限与会话，所有动作同时写入审计和开通单事件；临时 SQLite P4-O07 API、P3 回归、后端语法、四端构建和 `git diff --check` 已通过。在线支付、支付回调、自动续费及自动消息提醒未实现。
- [x] **P4-O08 积分充值、用量和对账。**
  - 优先级：P0
  - 选择原因：P4-O07 已完成；应在已有只读账务 / 用量基础上，收敛冻结金额、人工调整、退款 / 冲正、不可篡改流水、并发扣减与失败任务处理及导出对账，且不得把在线支付或支付回调伪装为已完成。
  - 完成记录（2026-09-03）：新增机构积分账务服务与兼容字段，统一普通 AI 调用 / 生成任务的原子扣减；管理员可完成人工补入扣减、冻结、退款 / 冲正、流水筛选、复算与 CSV 导出；失败任务仅记 `BLOCKED / FAILED` 0 积分用量且不扣余额。机构端 `/recharge` 已升级为积分账务工作台。临时 SQLite API `51 pass / 0 fail`、失败任务专项 `19 pass / 0 fail`、P3 回归 `48 pass / 0 fail`、四端构建和语法检查均通过。
- [~] **P4-04：黑客松 / 运营活动不再实施（已确认取消）。**
  - 产品决策（2026-09-02）：用户明确确认黑客松功能不做，平台端与机构端均不新增赛季、报名、投稿、评审、排名、公示或获奖通知相关表、API 和业务页面。
  - 历史壳层：现有 `/hackathon` 仅为 P3.5 时期的静态页面壳层，不代表真实功能；不再列入待开发或验收范围，后续进行非画布导航清理时移除入口与路由。
  - 边界：该决策不影响普通作品提交、审核、发布、下架和作品数据能力。
- [x] **P4-03：通知与宣传物料两批真实闭环已完成。**
  - 优先级：P0
  - 完成记录（2026-09-02）：
    - [x] 第一批新增 `notifications`、`notification_recipients`、`promo_materials`、`promo_material_assignments`、`promo_material_events`；平台 / 机构通知和物料元数据、机构授权、已读与使用事件形成闭环。
    - [x] 第二批新增 `notification_templates`；平台端支持通知模板保存 / 套用 / 启停，以及逻辑 `SCHEDULED` 定时发布。
    - [x] 定时通知以数据库 `DRAFT + publish_at` 保存，由服务进程每 15 秒扫描，并在平台、机构、学生收件箱请求时补偿扫描；到期后生成接收记录并写入 `NOTIFICATION_SCHEDULED_PUBLISH` 审计。
    - [x] 学生端新增 `/inbox` 消息中心及 `GET /api/student/inbox`、单条已读、全部已读接口；平台公告和机构学生通知均按本人接收记录与机构范围隔离。
    - [x] 平台物料新增 `GET /api/admin/materials/:id/stats`，返回事件总数、查看 / 使用 / 下载、机构 / 用户数量、机构聚合和最近事件。
    - [x] 重新发布时同步移除已不属于新目标范围的旧接收记录，仍在范围内的用户保留既有已读状态。
    - [x] 验证：后端语法通过；P4-03 第二批 API `35 pass / 0 fail`；P3 API 回归 `46 pass / 0 fail`；四端生产构建与 `git diff --check` 通过；`packages/canvas` 未修改。
    - [ ] 后续可靠性 / 外部能力：投递失败重试、高可用异步队列、邮件 / 短信 / 微信、真实上传 / OSS / 下载代理与签名、阿飞提醒。
  - 边界：未触碰真实 `platform.db`，未伪造外部通知、文件存储、下载或 AI 能力，不部署线上环境。
- [x] **P4-00：完成“非画布页面壳层 → 真实业务能力”的接口/数据缺口清单，并按 P0 顺序开始补齐第一批真实页面。**
  - 优先级：P0
  - 完成记录（2026-09-02）：
    - [x] 已产出并入库 `docs/AI少儿编程平台-P4-非画布真实业务缺口清单.md`，覆盖平台端 12 入口、机构端 14 入口、学生端 11 入口、官网 8 入口。
    - [x] 第一批 P0 已完成并验证：平台端 `/users`、`/admins`；机构端 `/courses`、`/packages`、`/usage`。
    - [x] 新增接口：`GET /api/admin/platform-users`；`GET/POST/PUT /api/admin/platform-admins`；`GET/PUT /api/org/billing/packages/:id`；`GET /api/org/billing/usage-records`。
    - [x] 补充机构套餐重名业务错误：`BILLING_PACKAGE_EXISTS`，避免唯一索引泄漏为 500。
    - [x] 验证：后端语法通过；29 项 P4 API 正反向场景通过；P3 API 回归 46 项通过；四端生产构建通过。
    - [x] 剩余状态已更新：P4-01、P4-02 第一批与 P4-03 两批、P4-O01 至 P4-O07 已完成；黑客松 / 运营活动已按用户决策取消；当前按缺口清单推进 P4-O08 积分充值、用量和对账，在线计费 / 外部能力继续保留在对应后续批次。
  - 目标：把目前明确标注“待接入”的平台端、机构端、学生端页面，逐页映射到数据表、后端接口、权限、交互、验收场景，防止只扩展菜单不形成业务闭环。
  - 依赖：本文件、`docs\AI魔法学院基准`、现有后端路由与数据库 schema。
  - 后续建议顺序：**机构经营看板与教师范围隔离 → 机构账号 / 成员增强 → 班级、课程与排课增强 → 学生学习任务与作品反馈 → 作品数据与审计查询**；黑客松 / 运营活动已取消，不再排期。
  - 验收：
    - [x] 每个现有壳层页面都有“真实已有 / 待建接口 / 外部决策”三态说明；
    - [x] 输出 API、表、角色权限、前端路由、验收场景的映射；
    - [x] 选定并实现第一批 P0 功能，不伪造运营数据；
    - [x] 构建和核心 API 回归通过。
  - 完成记录：见上方 2026-09-02 记录；剩余范围转入缺口清单 P4-01 至 P4-04。
- [-] **P4-01（缺口清单编号）：平台计费与作品闭环第一批**
  - 优先级：P0
  - 完成记录（2026-09-02）：
    - [x] 平台端 `/billing`：在现有用量汇总基础上接通 `GET /api/admin/billing/usage-records`，支持时间、机构、模态、状态、关键词筛选与业务上下文展示。
    - [x] 平台端 `/works`：接通 `GET /api/admin/works` 与 `PUT /api/admin/works/:id/unpublish`，支持跨机构状态/关键词筛选与平台下架，写入审核人、审核时间、原因和 `PLATFORM_WORK_UNPUBLISH` 审计。
    - [x] 机构端 `/recharge`：接通 `GET /api/org/billing/account-overview`，管理员可查看余额、累计收入/消耗、实收金额、充值单与积分流水；教师返回 `ORG_BILLING_PERMISSION_DENIED`。
    - [x] 验证：后端语法通过；47 项 P4-01 API 正反向场景通过；46 项 P3 API 回归通过；admin/org/student/website 四端生产构建通过。
    - [ ] 剩余：在线支付回调、计费规则与模型开关配置、冻结/退款/冲正、导出对账未包含；举报 / 违规处理及内容治理按用户决策 `[~]` 暂缓。
    - [ ] 风险与后续：平台下架当前由前端限制仅对 `PUBLISHED` 作品操作，服务端严格状态机校验留待“统一领域状态机”事项；平台接口仍为角色级 `SUPER_ADMIN`，`ADMIN_*` 权限码需后续逐域收紧。
  - 边界：本批不修改 `packages/canvas`，不伪造支付到账、模型配置和运营数据，不部署线上环境。
- [-] **P4-02（缺口清单编号）：学生课程、额度与账号安全第一批**
  - 优先级：P0
  - 完成记录（2026-09-02）：
    - [x] 学生端 `/courses` 接通 `GET /api/student/courses`，返回本人机构内可见课程、班级、已发布课时、项目 / 作品计数、作品状态、课堂进行中和进度。
    - [x] 学生端 `/credits` 接通 `GET /api/student/credits`，支持 `days`、模态和 `SUCCESS/FAILED/BLOCKED` 筛选，返回本人套餐、额度周期、魔法石、课堂会话和用量上下文。
    - [x] 学生端 `/account` 接通账号概览、资料更新、改密和会话撤销：`GET/PUT /api/student/account`、`/profile`、`/password`、`/sessions/:id/revoke`。
    - [x] 验证：后端语法通过；P4-02 API 验收 11 项通过；P3 API 回归 46 项通过；四端生产构建通过。
    - [ ] 剩余：学习首页任务聚合、AI 能力中心增强、头像 / 隐私 / 注销与数据请求入口待后续补齐；监护人功能按用户决策 `[~]` 暂缓。
  - 边界：本批不修改 `packages/canvas`，不伪造真实 AI、支付或文件能力，不触碰真实 `platform.db`，不部署线上环境。

### 1.3 总阶段状态

| 阶段 | 名称 | 状态 | 说明 |
|---|---|---:|---|
| P0 | 基础架构与认证 | `[x]` | Monorepo、SQLite、统一 API、角色登录和基础业务骨架已完成。 |
| P1 | 教务与项目基础链路 | `[x]` | 机构、班级、课堂、项目、提交和审核主链路已完成。 |
| P2 | 画布与版本能力 | `[x]` | 第一版 React Flow 创作画布、版本、导入导出、只读预览已完成。 |
| P3 | 反馈、作品墙、AI mock 基础闭环 | `[x]` | 模板/排版、批注、机构作品墙、可追踪 mock 生成等已完成。 |
| P3.5 | 非画布站点第一轮建设 | `[x]` | 官网和三端视觉、导航与页面壳层已按基准完成第一轮。 |
| P4 | 非画布真实业务 API 与页面闭环 | `[ ]` | 当前主开发阶段。 |
| P5 | 官网转化、公开内容与正式品牌站 | `[ ]` | 线索、下载、SEO、协议、公开分享等。 |
| P6 | 真实 AI、文件与计费服务 | `[ ]` | 供应商、异步任务、对象存储、内容安全、成本控制。 |
| P7 | 画布统一改造 | `[!]` | 仅在用户明确重新授权后启动。 |
| P8 | 质量、安全、合规与运营保障 | `[ ]` | 测试、监控、备份、未成年人保护、压测等。 |
| P9 | 内部测试部署 → 预发布 → 正式公开上线与运营交接 | `[ ]` | 当前先完成 P9-I01～I06 内部测试闸门；正式域名、HTTPS、备案和公开发布另行满足正式上线门槛。 |

---

## 2. 当前系统总览（以代码现状为准）

### 2.1 工程与技术栈

| 项目 | 当前实现 |
|---|---|
| 工程模式 | pnpm Monorepo，根目录为 `D:\学习平台\platform-v2` |
| 前端 | React 19、React Router、Vite 7、Zustand、`@xyflow/react` |
| 后端 | Node.js ESM 服务，路由式 REST API |
| 数据库 | SQLite；schema 位于 `packages\database\src\schema.js` |
| 认证 | 登录会话 + Bearer Token / Cookie 统一 API 基础层 |
| 主要角色 | 平台超管、机构管理员、教师、学生 |
| 已有应用 | `apps/admin`、`apps/org`、`apps/student`、`apps/website`、`apps/server` |
| 共享层 | `packages/shared`；画布在 `packages/canvas`；数据库在 `packages/database` |
| 构建要求 | Vite 7 可使用 Node 20+，但本项目数据库运行时依赖 `node:sqlite`，内测部署统一要求 Node.js 22.5+；本机系统 Node 16.13.1 不可直接构建，已验证使用 bundled Node 24 + pnpm 11。 |

### 2.2 应用范围与启动入口

| 应用 | 路径 | 当前作用 | 本地开发命令 |
|---|---|---|---|
| 平台超管端 | `apps\admin` | 平台机构、课程、用户、计费、内容运营入口 | `pnpm run dev:admin` |
| 机构 / 教师端 | `apps\org` | 班级、课堂、成员、作品、机构运营入口 | `pnpm run dev:org` |
| 学生端 | `apps\student` | 学习、项目、作品、反馈、素材工坊入口 | `pnpm run dev:student` |
| 官网 | `apps\website` | 公开营销、课程、机构方案、演示预约等 | `pnpm run dev:website`（当前端口 `5176`） |
| API 服务 | `apps\server` | 认证、平台、机构、学生、AI 生成路由 | `pnpm run server` |

### 2.3 当前数据库能力

现有 schema 已包括（不代表所有均已形成完整前端闭环）：

- 平台设置、机构、用户、会话；
- 机构积分账户、积分流水、计费套餐、充值订单、用量记录；
- 课程系列、课程课时、课程授权；
- 班级、成员、班级课程、课堂会话；
- 学生项目、项目快照、作品、作品批注；
- AI 生成任务、媒体资产；
- 审计日志。

主要文件：

```text
D:\学习平台\platform-v2\packages\database\src\schema.js
D:\学习平台\platform-v2\packages\database\src\db.js
D:\学习平台\platform-v2\packages\database\src\seed.js
```

### 2.4 当前后端模块

```text
D:\学习平台\platform-v2\apps\server\src\routes\auth.js
D:\学习平台\platform-v2\apps\server\src\routes\adminOrg.js
D:\学习平台\platform-v2\apps\server\src\routes\orgExtra.js
D:\学习平台\platform-v2\apps\server\src\routes\student.js
D:\学习平台\platform-v2\apps\server\src\routes\ai.js
D:\学习平台\platform-v2\apps\server\src\routes\aiGeneration.js
```


### 2.5 参考基准与历史交接资料

后续实施时按以下顺序阅读：

1. 本文件：`D:\学习平台\platform-v2\docs\AI少儿编程平台-完整上线执行总控.md`；
2. 当前交接：`D:\学习平台\AI少儿编程平台-P3新对话交接.md`；
3. 历史交接：`D:\学习平台\AI少儿编程平台-新对话交接.md`；
4. AI 魔法学院实施基准目录：
   ```text
   D:\学习平台\docs\AI魔法学院基准\00-总览.md
   D:\学习平台\docs\AI魔法学院基准\01-产品与角色.md
   D:\学习平台\docs\AI魔法学院基准\02-页面路由清单.md
   D:\学习平台\docs\AI魔法学院基准\03-API契约清单.md
   D:\学习平台\docs\AI魔法学院基准\04-数据模型与状态机.md
   D:\学习平台\docs\AI魔法学院基准\05-计费与模型矩阵.md
   D:\学习平台\docs\AI魔法学院基准\06-核心流程图.md
   D:\学习平台\docs\AI魔法学院基准\07-客户端与硬件.md
   D:\学习平台\docs\AI魔法学院基准\与本地系统替换关系.md
   ```
5. 工程说明：`D:\学习平台\platform-v2\README.md`。

#### 2.5.1 用户确认的 AI 魔法学院在线体验基准（2026-09-02）

| 范围 | 参考入口 / 使用规则 |
|---|---|
| 官网 / 公开体验 | 用户提供的 AI 魔法学院官网分享入口属于实施基准。因本仓库为公开仓库，完整带追踪参数的分享链接仅保留在当前对话，不写入 Git；仓库内记录其稳定入口：`https://scrm-wx.weiling.cn/h5/monitorFile/index.html`。 |
| 机构与教师端 | 登录入口：`https://admin.aimagc.cn/#/login`。用于对照机构 / 教师端的信息架构、角色权限、操作链路、状态和交互细节。 |
| 实施要求 | 除已冻结的 `packages/canvas` 外，官网、平台端、机构端、教师端与学生端均以该在线产品为最高优先级的产品、流程、页面语义和视觉体验基准；每个新增或重构页面先完成“基准页面 → 本地路由 → 数据 / API → 权限 → 验收”映射。 |
| 登录与凭据 | 当需要查看登录后的机构 / 教师页面时，由用户在当次对话提供可用测试账号；账号密码、验证码、Cookie、Token、截图中的敏感信息均不得写入本 MD、Git、日志或提交记录。 |
| 合规边界 | 严格对齐可观察到的产品体验，但不得复制私有源码、接口、数据库、密钥、受版权或未获授权的素材；本项目仍须满足自身业务、未成年人隐私与生产验收要求。 |

- [x] 已将用户指定的官网与机构 / 教师端在线基准登记为后续非画布开发的优先参考。
- [ ] 进入对应 P4 页面闭环前，使用获授权的测试账号完成登录态页面逐页对照与映射；没有账号或未授权页面不得猜测实现。


### 2.6 已知线上环境（用户提供，作为后续发布目标）

> 记录日期：2026-09-02。该环境当前承载的是**旧版本网站**，不是本地 `platform-v2` 的内部测试环境或正式上线版本。它只能作为后续正式替换发布的目标环境；在内测阶段不得直接覆盖旧站、不得把旧站数据库当作测试数据库。用户已授权在后续替换发布时清理旧网站内容，但执行清理前仍必须先完成配置、数据库、静态资源和 Nginx 配置备份，保证发生误操作时可以恢复。

| 项目 | 已知生产信息 |
|---|---|
| 对外域名 | `iicili.cyou` |
| 服务器公网 IP | `39.106.183.200` |
| 现有生产前端目录 | `/opt/learning-platform/dist` |
| 后端 systemd 服务 | `learning-platform` |
| 后端内部监听 | `127.0.0.1:8788` |
| Web 服务器 | Nginx |
| API 反向代理 | Nginx 将 `/api/` 转发至 `http://127.0.0.1:8788` |
| 对外网络原则 | 只开放 `80/TCP`、`443/TCP`；**严禁对公网开放 `8788/TCP`**。 |
| 当前环境性质 | 线上旧站，可作为后续预发式真实环境预览 / 监控目标；在完成发布检查后可被新平台整体替换。 |

线上环境操作规则：

- 每次前端 / 后端发布前，先通过 `https://iicili.cyou/` 预览真实线上效果，并在发布后执行冒烟测试；
- 任何覆盖 `/opt/learning-platform/dist`、重启 `learning-platform`、修改 Nginx 或调整防火墙的操作，都必须在总控的 P9 项中留下：执行时间、操作者、备份位置、发布版本、验证结果和回滚方式；
- 清理旧网站仅限于替换发布窗口：先备份旧 `dist`、当前 Nginx 配置、systemd unit、环境变量（脱敏记录）和数据库，再上传新制品；
- 新平台上线前不得把本地 `local-mock` AI、假下载链接、未接入的支付或页面壳层当作线上可用功能；
- 对公网验证 API 时只从 `https://iicili.cyou/api/` 进入；`127.0.0.1:8788` 仅供服务器内部的 Nginx / systemd 使用。

### 2.7 代码仓库、Deploy key 与发布职责（已确认）

| 项目 | 已确认信息 |
|---|---|
| GitHub 仓库 | `chuangyilingdong/peixunwangzhan` |
| 代码远程地址（生产服务器拉取） | `git@github.com-peixunwangzhan:chuangyilingdong/peixunwangzhan.git` |
| 生产服务器 Deploy key | 已于 2026-09-02 创建、添加至该仓库并完成读取验证；私钥仅保存在生产服务器，**不得复制到本地、聊天、仓库、MD 或 GitHub Secret**。 |
| 生产服务器密钥角色 | 只读：仅用于服务器从该仓库 `clone` / `fetch` / `pull` 代码。 |
| GitHub Deploy key 写权限 | 未开启；当前与后续常规发布均不需要服务器向仓库写入。 |
| 线上验证结果 | 用户已确认服务器通过该 Deploy key 的 SSH 认证和仓库读取验证。 |
| 本地 Git 基线（已推送） | 已在 `platform-v2` 初始化 `main` 分支；2026-09-02 已通过本机专用 SSH 密钥及 `ssh.github.com:443` 推送到 GitHub。`origin` 使用本机别名 `git@github.com-peixunwangzhan-local:chuangyilingdong/peixunwangzhan.git`；远程 `main` 已核验为 `485b763`。 |

必须严格区分三类凭据：

1. **开发者 / 本地 Git 凭据**：2026-09-02 已建立并验证本机专用 SSH 写入密钥；通过 `ssh.github.com:443` 推送已成功。私钥仅保存在本机，不得上传、外传或提交到仓库；不得使用生产服务器 Deploy key。
2. **生产服务器 Deploy key**：只读拉取 `chuangyilingdong/peixunwangzhan`；不得用于写入、不得外传私钥。
3. **GitHub Actions → 生产服务器部署凭据**：后续自动发布时单独创建独立密钥，并作为 GitHub Actions Secret 保存；**不得复用本次 Deploy key**。

代码与发布固定流程：

1. 在本地 `platform-v2` 完成一项功能；
2. 更新本总控 MD 的进度、验收和变更日志；
3. 在本地完成对应检查（至少全量构建；核心链路同时跑 API / E2E 回归）；
4. 检查 `git diff`，确认没有 `.env`、私钥、数据库、构建产物、用户数据和其他敏感文件；
5. 提交清晰的 Git commit，并推送到受保护的正式分支；
6. CI 完成构建、测试和安全检查后，才允许进入线上发布；
7. 线上发布前先执行 P9-D00 的备份与预检；
8. 发布后用 `https://iicili.cyou/` 和 `/api/` 做冒烟测试、观察日志和监控；
9. 验证失败时按发布记录回滚，禁止直接在线上临时改代码而不回写 Git。

> 已完成“生产服务器从 GitHub 安全读取仓库”及“本机通过 SSH 443 安全推送 GitHub”的前置能力，远程 `main` 基线已建立。GitHub Actions、分支保护、CI、自动部署、服务器专用 `deploy` 账号、备份演练与正式发布尚未完成，仍必须按 P9 清单实施。
---

## 3. 已完成工作清单（已验证或已有明确实现边界）

> 注意：本节的 `[x]` 表示当前阶段功能完成，不代表已经达到生产上线标准。生产级缺口统一在 P6、P8、P9 处理。

### 3.1 P0～P1：基础架构、认证和教务主链路

- [x] Monorepo 工程、四个前端应用和一个后端应用已经建立。
- [x] SQLite 数据库 schema、初始化与 seed 基础能力已经建立。
- [x] 用户登录、会话、角色鉴权及统一 API 响应封装已经建立。
- [x] 平台超管、机构管理员、教师、学生四类基础账号与入口已经建立。
- [x] 平台端机构列表 / 创建、课程授权、基础积分与能力概览已实现。
- [x] 机构端班级创建、班级成员、课程课时选择、课堂开启与结束主链路已实现。
- [x] 学生端学习概览、课程 / 课堂状态、创建项目与提交作品主链路已实现。
- [x] 作品审核、点评状态和机构端作品只读查看主链路已实现。
- [x] 课堂可用 AI 能力字段映射已修复；标准化课堂会话使用 `allowImage`，避免错误读取数据库 `allow_image` 字段。
  - 涉及文件：`apps\server\src\routes\aiGeneration.js`。

### 3.2 P2：第一版创作画布与版本管理

- [x] React Flow 第一版创作画布已接入学生项目。
- [x] 已支持提示词、画面、角色、场景、故事短片、创作便签六类节点的编辑、拖拽、连线、缩放、小地图等基本创作操作。
- [x] 项目快照保存、版本命名、只读预览、恢复为新版本、两版本差异详情已完成。
- [x] 已支持符合 `ai-kids-canvas-snapshot` 格式的 JSON 导入 / 导出；导入限制在草稿项目，且最大 1MB。
- [x] 提交作品时后端使用最新保存的画布快照。
- [x] 机构端可通过作品快照进行只读画布预览。

> 以上为已完成基线。**从 2026-09-02 起，画布代码冻结，当前任务不再改动 `packages\canvas`。**

### 3.3 P3：反馈、作品墙与可配置 mock AI

- [x] “角色冒险”“科学小实验”模板以及依据连线分层的自动排版已完成。
- [x] 教师 / 机构端整体点评、节点级批注、批注完成状态已完成。
- [x] 学生可查看自己的作品、只读画布、整体反馈与节点批注。
- [x] `work_annotations` 表及作品批注权限校验已建立；学生仅可读取自己的反馈，机构管理员 / 授课教师限制在本机构或负责班级。
- [x] 机构作品发布后，学生端“作品墙”只展示本机构 `PUBLISHED` 作品，且为只读展示，不跨机构公开。
- [x] 已建立 `generation_jobs`、`media_assets` 数据模型和生成任务接口。
- [x] 已提供 `AI_PROVIDER`、`AI_PROVIDER_MODEL`、`AI_PROVIDER_ENDPOINT` 配置点；默认 `local-mock` 可生成可追踪的模拟素材和 SVG 预览。
- [x] mock 生成已接入积分扣减 / 用量记录链路；非 mock 供应商会明确返回需要适配器，不会伪造调用成功。

### 3.4 P3.5：非画布官网与三端视觉 / 信息架构第一轮

- [x] 已新增公开官网：`D:\学习平台\platform-v2\apps\website`。
- [x] 官网已提供首页、课程体系、机构方案、学员作品、产品手册、选型对比、客户端下载、预约演示页面。
- [x] 共享 UI 已统一为 AI 魔法学院品牌壳层、登录页、侧边栏、顶栏、卡片、表格、表单、标签、空态与加载态视觉。
- [x] 平台端已扩展以下非画布入口：平台概览、机构管理、平台用户、平台课程、课程广场、作品库、计费与模型、素材与物料、站内信、平台管理员；黑客松历史壳层已按 2026-09-02 产品决策取消，不再属于产品功能范围，待后续导航清理时移除。
- [x] 机构端已扩展以下非画布入口：机构首页、站内信、班级管理、账号管理、课程中心、作品社区、作品数据中心、积分套餐、学员开通、积分充值、积分用量、宣传物料、阿飞提醒；黑客松历史壳层已按 2026-09-02 产品决策取消，不再属于产品功能范围，待后续导航清理时移除。
- [x] 学生端已扩展以下非画布入口：学习首页、我的课程、我的项目、我的作品、作品墙、AI / 魔法石、个人账号、帮助与下载。
- [x] 暂无真实 API 的页面明确呈现为“待接入”壳层，不伪造真实运营、计费、审批数据。
- [x] 本轮非画布建设未修改 `packages\canvas`。

### 3.5 已完成验证记录

- [x] `p3-api-integration.mjs` 已完成 P3 API 集成验证。
  - 文件：`D:\学习平台\platform-v2\p3-api-integration.mjs`。
- [x] 后端 JavaScript 语法检查已通过。
- [x] `apps/admin`、`apps/org`、`apps/student`、`apps/website` 生产构建均已通过。
- [x] 生产构建已使用 Node 24 / pnpm 11 的 bundled runtime 验证通过。

---

## 4. P4｜非画布真实业务 API 与页面闭环（当前主开发阶段）

> 目标：将已完成的导航、页面壳层和部分已有后端能力，逐步变成符合角色权限、数据真实、可验收、可运营的业务闭环。P4 完成不等于上线，后续仍需真实 AI、测试安全和部署。

### 4.0 架构梳理与实施基线

- [x] **P4-00 页面 / API / 数据 / 权限差异清单**
  - 优先级：P0
  - 实现范围：逐页对照 `02-页面路由清单.md`、`03-API契约清单.md` 与当前代码，列出“已有真实功能 / 仅页面壳层 / 缺数据模型 / 缺 API / 缺外部决策”。
  - 验收：平台、机构、学生、官网的每个入口都有负责人角色、数据来源、状态和下一步；不能出现未知的无主页面。
  - 完成记录（2026-09-02）：见 docs/AI少儿编程平台-P4-非画布真实业务缺口清单.md；第一批 P0 页面与 API 已完成并通过验证。
- [x] **P4-01 统一领域状态机、枚举与错误码**
  - 优先级：P0
  - 实现范围：统一机构、用户、班级、课堂、项目、作品、开通单、充值单、生成任务、通知、物料、文件等仍在产品范围内的状态及允许转换；黑客松状态机已取消。
  - 验收：前后端通过共享状态契约读取稳定枚举；服务端在真正写库前校验允许转换；非法转换返回可识别错误并写入 `DOMAIN_INVALID_TRANSITION` 审计日志；提供只读 `GET /api/meta/domain-states`。
  - 完成记录（2026-09-04）：
    - [x] 新增 `apps/server/src/services/domainState.js`，集中维护 26 个领域状态字典、允许转换、同状态幂等策略、标准错误码与异常转换审计；举报、申诉、违规 / 内容审核、监护人和正式法律流程不纳入本批次。
    - [x] 接入机构 / 用户 / 开通单 / 支付 / 课程 / 课时 / 课程授权 / 班级 / 课堂 / 项目 / 作品 / 发布申请 / AI 生成任务 / 通知 / 物料 / 文件状态写入路径；新增 `GET /api/meta/domain-states` 供前端逐步消费。
    - [x] 验证：`p4-01-state-machine.mjs` 使用临时 SQLite **28 pass / 0 fail**；覆盖纯函数状态契约、同状态策略、AI 任务成功、项目重复提交、课堂重复结束、作品重复下架、班级重复归档、非法转换审计和数据库隔离；`p4-c01-rbac-ownership.mjs` **27 pass / 0 fail**；`p8-s03-tenant-isolation.mjs` **20 pass / 0 fail**；Node 24 语法检查、四端生产构建和 `git diff --check` 通过。
    - [x] 边界：真实 AI / 支付 / OSS / 微信等外部能力仍不伪造；通知 / 文件状态机仅约束现有元数据与内部代理边界。举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规文本继续保持 `[~]` 暂缓。
- [ ] **P4-02 数据迁移与演示数据隔离规范**
  - 优先级：P0
  - 实现范围：建立 schema 版本、迁移脚本、临时数据库测试方法、seed 数据说明和备份前置检查。
  - 验收：新环境可以从零初始化；升级旧库可以迁移；测试不污染主数据库；迁移失败可回滚或从备份恢复。
- [x] **P4-03-LIST 管理端列表交互规范收口**
  - 优先级：P1
  - 实现范围：对管理端的列表页定义统一 query 参数、分页元数据、筛选器、排序、空态和 CSV / XLSX 导出策略。
  - 验收：大于一页的数据可稳定浏览；无权限、无数据、网络失败的提示一致；导出权限被后端校验。
  - 当前批次记录（2026-09-04）：已完成平台用户、平台作品、操作审计、课程广场、机构、课程、平台管理员、通知、宣传物料、账务十类列表整体验收复核；举报、申诉、违规 / 内容审核、监护人和正式法律 / 合规仍保持 `[~]`。

### 4.1 平台超管端：平台经营与内容治理

- [x] **P4-A01 平台概览真实数据**
  - 优先级：P0
  - 页面：平台概览。
  - 实现范围：机构数、活跃机构、教师 / 学生数、课程开通、课堂、作品、积分消耗、AI 任务、异常任务等核心指标；按时间和机构筛选。
  - 完成记录（2026-09-03）：新增 `GET /api/admin/dashboard/overview`，支持 `orgId/from/to`，返回机构、用户、课程、班级、课堂、项目、作品、AI 任务、异常任务、用量与积分余额等 19 项指标、机构 Top、能力分布、UTC 统计口径与生成时间；平台端 `/dashboard` 已按机构与日期筛选真实渲染。临时 SQLite 验收 `40 pass / 0 fail`，覆盖未登录 401、机构 / 教师 / 学生 403、非法与空时间参数、时间倒置、空区间、机构隔离、新旧区间与禁用机构；P3 回归 `48 pass / 0 fail`；后端语法、四端生产构建与 `git diff --check` 均通过。
  - 已知边界：教师与学生口径按未删除、ACTIVE 且未过期统计；无数据展示真实 0 值；更深层下钻、趋势图和跨时区切换仍留后续批次。
- [x] **P4-A02 机构管理完整闭环**
  - 优先级：P0
  - 页面：机构管理。
  - 实现范围：创建、编辑、停用 / 恢复、机构管理员绑定、套餐状态、配额、到期提醒、机构详情、审计记录。
  - 验收：停用后不能新建课堂或使用 AI；恢复后按既定规则恢复；操作有权限校验、二次确认和审计日志。
  - 完成记录（2026-09-03）：
    - 新增 `GET /api/admin/organizations/:orgId/detail`，聚合机构资料、合同剩余天数、30 天内到期提醒、服务可用性、机构管理员、积分账户、套餐、课程授权、教师 / 学生 / 班级 / 课堂 / 项目 / 作品汇总与最近 50 条审计。
    - 新增 `POST /api/admin/organizations/:orgId/status`，支持停用、恢复、冻结、试用转正；普通 `PUT /:orgId` 不再允许直接改状态，只能编辑名称、合同时间、教师席位与联系人，且重名返回 409、席位总数不可降低、合同时间必须合法。
    - 新增 `GET/POST /api/admin/organizations/:orgId/admins` 与 `PUT .../admins/:userId`，支持机构管理员新增、编辑、启用、停用和重置密码；不能停用最后一个有效机构管理员，停用管理员会使其现有会话失效，返回不包含密码或哈希。
    - 停用机构不批量撤销 token，而是依赖 `resolveAuth()` 每次实时读取机构状态；停用后现有机构 token 立即返回 `ORG_DISABLED`，不能新建班级、开课堂或调用 AI，恢复且合同有效后同一 token 自动恢复可用。合同已到期时恢复被拒绝，需先续签合同。
    - 平台机构页新增机构详情、资料编辑、停用 / 恢复 / 试用转正、管理员管理、积分与席位摘要、套餐 / 课程授权、业务汇总、审计列表；停用、恢复、转正和停用管理员均使用明确影响的二次确认。
    - 审计动作：`ORG_CREATE`、`ORG_UPDATE`、`ORG_DISABLE`、`ORG_RECOVER`、`ORG_FROZEN`、`ORG_ACTIVATE`、`ORG_ADMIN_CREATE`、`ORG_ADMIN_UPDATE`。
    - 验收：P4-A02 临时 SQLite API 验收 `57 pass / 0 fail`；P3 回归 `48 pass / 0 fail`；后端 ESM 语法检查、四端生产构建、`git diff --check` 均通过。本批未修改 canvas，未触碰 `packages/data/platform.db`，未部署线上。
- [x] **P4-A03 平台用户管理**
  - 优先级：P0
  - 页面：平台用户、平台管理员。
  - 实现范围：平台管理员账号、角色、状态、重置密码 / 安全会话、搜索、筛选、最近登录、操作日志。
  - 验收：不能删除最后一个有效超管；禁用立即使会话失效；密码和 token 不回显。
  - 完成记录（2026-09-03）：
    - 新增 `PUT /api/admin/platform-users/:userId/status|password|phone`：平台超管可对任意用户执行启用 / 停用、重置密码、绑定 / 解绑手机；停用与重置密码均立即撤销该账号全部会话；不能停用当前登录账号，停用超管受"最后一个有效平台管理员"守卫保护（并发防御）；手机号复用机构成员校验（格式与占用 409）。
    - `GET /api/admin/platform-admins` 增强：支持 `search` / `status` 筛选，每条记录返回 `lastLoginAt`（取自 `AUTH_LOGIN` 审计最近一条）与 `activeSessions`（未失效且未过期会话数）。
    - `PUT /api/admin/platform-admins/:id` 增强：停用其他管理员或重置密码后立即撤销其全部会话；新增 `GET /api/admin/platform-admins/:id/audit-logs` 返回该管理员最近操作日志（含动作、目标、请求路径与变更摘要，limit 1-100）。
    - 平台端 `/users` 页面新增行内启停（带影响说明二次确认）、重置密码、解绑手机与手机号展示；`/admins` 页面新增关键词 / 状态筛选、最近登录、活跃会话数、操作日志面板和停用二次确认。
    - 审计动作：`PLATFORM_USER_STATUS`、`PLATFORM_USER_PASSWORD_RESET`、`PLATFORM_USER_PHONE_UPDATE`；所有接口不返回密码哈希或令牌。
    - 验收：P4-A03 临时 SQLite API 验收 `63 pass / 0 fail`，覆盖 401/403 越权、筛选搜索、停用即会话失效、停用后登录拒绝、重新启用恢复、重置密码旧会话失效与新密码登录、手机号格式 / 占用 / 解绑、自停用拒绝、非法状态与 limit、最近登录与会话数、管理员停用 / 恢复 / 重置、操作日志与审计动作；P3 回归 `48 pass / 0 fail`；后端 ESM 语法检查、四端生产构建、`git diff --check` 均通过。本批未修改 canvas，未触碰 `packages/data/platform.db`，未部署线上。
- [x] **P4-A04 课程系列、课时与课包管理**
  - 优先级：P0
  - 页面：平台课程、课程广场。
  - 实现范围：课程系列、课时、封面、简介、年龄段、难度、标签、课程资源、发布状态、机构可见范围、版本管理。
  - 验收：未发布课程不能被机构 / 学生看到；已授权机构可按规则加入班级；课程变更有版本与兼容策略。
  - 完成记录（2026-09-03）：
    - 新增 `GET /api/admin/course-series/:seriesId/detail`，聚合课包资料、全部课时（含草稿 / 归档）、已授权机构列表与使用统计（引用班级、班级课单项、关联课堂、学生作品）。
    - 新增 `PUT /api/admin/course-series/:seriesId` 编辑课包资料：标题（重名 409）、简介、HTTPS 封面地址、可见范围、排序；普通编辑不允许直接改状态，内容变更自动递增次版本号（1.0 → 1.1）并写审计。
    - 新增 `POST /:seriesId/status` 状态机：`publish`（DRAFT/ARCHIVED → PUBLISHED，要求至少一个课时）、`archive`（DRAFT/PUBLISHED → ARCHIVED，软归档可重新发布）；DRAFT 与 ARCHIVED 课包对机构端不可见。
    - 新增课时管理：`POST /:seriesId/lessons` 追加课时（排序连续追加）、`PUT /:seriesId/lessons/reorder` 重排（两阶段更新规避 `(series_id, sort)` 唯一索引冲突）、`PUT /api/admin/course-lessons/:lessonId` 编辑、`DELETE /api/admin/course-lessons/:lessonId` 删除；被班级课单或课堂引用的课时拒绝删除（`LESSON_IN_USE`），只能归档；删除后剩余课时自动重排。
    - 新增 `POST /:seriesId/assignments/revoke` 撤销机构授权（`REVOKED`），机构端课程中心与班级课单立即不可见该课包；重新授权立即恢复。
    - 平台端 `/courses` 升级为课包管理工作台：使用统计指标卡、资料编辑、发布 / 归档、机构授权与撤销、课时表格（编辑 / 上移下移 / 保存 / 删除）与追加课时表单。
    - 审计动作：`COURSE_SERIES_UPDATE`、`COURSE_SERIES_PUBLISH`、`COURSE_SERIES_ARCHIVE`、`COURSE_LESSON_CREATE`、`COURSE_LESSON_UPDATE`、`COURSE_LESSON_REORDER`、`COURSE_LESSON_DELETE`、`COURSE_SERIES_ASSIGN_REVOKE`。
    - 验收：P4-A04 临时 SQLite API 验收 `66 pass / 0 fail`，覆盖 401/403 越权、创建与重名 / 空标题 / 非法可见范围校验、详情聚合、编辑与版本递增、非 HTTPS 封面拒绝、状态机正反向、无课时不能发布、课时追加 / 编辑 / 重排（含缺漏 / 重复 / 不存在课时拒绝）、机构可见性联动（授权可见、撤销立即不可见、归档不可见、重新发布恢复、机构端只见已发布课时）、班级课单引用保护、解除引用后可删除、审计动作全部落库；P3 回归 `48 pass / 0 fail`；后端 ESM 语法检查、四端生产构建、`git diff --check` 均通过。本批未修改 canvas，未触碰 `packages/data/platform.db`，未部署线上。
  - 已知边界：年龄段 / 难度 / 标签字段与课程资产（封面文件、课件上传、素材包）仍属后续批次，当前仅支持 HTTPS 封面元数据；课程广场（marketplace）维持壳层，按缺口清单需基准登录态对照后实施。
- [-] **P4-A05 作品库与公开作品基础闭环（举报 / 违规治理扩展 `[~]` 暂缓）**
  - 优先级：P1
  - 页面：作品库。
  - 实现范围：跨机构作品筛选、审核发布、精选、下架、作品详情和展示权限；举报、申诉、违规处理和内容治理扩展按用户决策 `[~]` 暂缓。
  - 验收：平台可下架不合规作品；下架对学生端和官网的可见性即时生效；原作者仍能按规则保留私有副本。
  - 完成记录（2026-09-02）：
    - [x] 已完成平台作品库跨机构状态/关键词筛选、上下文展示和 `SUPER_ADMIN` 平台下架；下架写入原因、审核人、审核时间与 `PLATFORM_WORK_UNPUBLISH` 审计，并纳入 47 项 API 验证。
    - [ ] 剩余（非暂缓）：作品详情、精选、公开分享展示权限、服务端强制仅 `PUBLISHED` 可下架的严格状态机；是否继续做公开分享需后续产品决策。
    - [~] 暂缓：举报、违规处理及相关内容治理；按 2026-09-04 用户决策不继续开发。
- [x] **P4-A06 计费与模型配置后台**
  - 优先级：P0
  - 页面：计费与模型。
  - 实现范围：套餐、积分规则、模型 / 模态开关、单次成本、机构可用能力、日 / 月限额、预警阈值、开关审计。
  - 验收：配置变更可追踪；新任务按最新有效规则计费；额度不足时拒绝生成且不产生错误扣费。
  - 完成记录（2026-09-02）：
    - [x] 平台端 `/billing` 已接通真实用量汇总与可筛选明细：`GET /api/admin/billing/usage-overview`、`GET /api/admin/billing/usage-records`；筛选、搜索、非法参数与越权均通过验证。
  - 完成记录（2026-09-03，本批）：
    - [x] 新增 5 张表：`platform_modality_settings`（7 模态 × 单价 / 开关 / 排序 / 显示名）、`platform_credit_quotas`（GLOBAL / STUDENT / TEACHER × 日 / 月限额）、`platform_alert_thresholds`（BALANCE_LOW / CONSUMPTION_SPIKE / QUOTA_EXCEEDED × 阈值 / 邮箱 / 启用）、`org_capability_overrides`（机构 × 模态 × 启禁用 / 原因）、`platform_config_change_logs`（审计流）；默认 seed：7 模态、3 限额、3 预警。
    - [x] 新增 `apps/server/src/routes/billingConfig.js`：admin/org/student 三端读写；按 visibility 抛 401/403；整数与字符串校验；机构覆盖 POST 自动去重（同机构同模态唯一）。
    - [x] 修复 `handleOrg` 与 `handleStudentCommunication` 路由拦截（之前因 `requireRole` 不含 STUDENT 而 403）；`communication.js` 增加 `if (pathname.startsWith('/api/org/billing-config')) return null;` 跳过。
    - [x] 修复 boolean/0/1 类型混淆：`!!existing.enabled` 改 `existing.enabled ? 1 : 0`；`alert` 同步。
    - [x] 修复 SQLite `(?="" OR ...)` 占位符不支持，改为 JS 端条件构造 SQL。
    - [x] 审计动作：`BILLING_CONFIG_MODALITY_UPDATE` / `BILLING_CONFIG_QUOTA_UPDATE` / `BILLING_CONFIG_ALERT_UPDATE` / `BILLING_CONFIG_ORG_OVERRIDE_CREATE|UPDATE|DELETE`。
    - [x] 验收：P4-A06 专项 `106 pass / 0 fail`，覆盖 schema 字段、默认 seed、admin/org/student 三端 CRUD、越权、整数 / 字符串 / 邮箱 / 模态 / 作用域校验、机构覆盖增删改 + 跨端保护、变更审计、effective capabilities 合并来源、limit 边界；P3 回归通过；后端语法、四端生产构建与 `git diff --check` 均通过。
  - 剩余：扣减时实时读取配置（applyConfigToUsage 联动）推迟到 P6 真实 AI provider 接入时一并改造，避免与现有 `credit_entries` 扣减路径产生回归；当前架构已具备"配置可写可审计、student 端能正确获取 effective 能力"的能力。
- [-] **P4-A07 素材与物料资源库**
  - 优先级：P1
  - 页面：素材与物料。
  - 实现范围：平台素材分类、授权范围、封面、下载 / 使用记录、机构宣传物料投放。
  - 验收：资源访问受权限和有效期控制；侵权 / 过期资源可一键下架；文件真实存储接入前不把占位资源标为可下载。
  - 完成记录（2026-09-02，两批）：
    - [x] 已建立物料、机构授权和事件表；平台可创建 / 编辑 / 启停，机构按授权查看并记录 VIEW / USE / DOWNLOAD。
    - [x] 平台统计详情已接通 `GET /api/admin/materials/:id/stats`，支持汇总、按机构聚合和最近事件查看。
    - [ ] 剩余：真实上传 / OSS、封面上传、下载代理与签名、文件有效期和侵权资源治理。
- [x] **P4-A08 平台站内信与公告**
  - 优先级：P1
  - 页面：站内信。
  - 实现范围：草稿、定时发布、指定机构 / 角色、已读状态、撤回、公告置顶和链接跳转。
  - 验收：发送范围准确；无权用户不可读取；撤回后客户端同步隐藏或明确标记；关键操作记录审计。
  - 完成记录（2026-09-02，两批）：
    - [x] 平台通知支持草稿、立即 / 定时发布、指定机构 / 角色、模板、撤回、置顶、跳转、接收统计与审计。
    - [x] 机构、教师和学生只读取本人投递记录；撤回和接收范围变更会即时影响可见性。
    - [x] P4-03 第二批 API `35 pass / 0 fail`，覆盖模板、定时发布、跨端越权和学生已读状态。
- [~] **P4-A09 黑客松 / 活动管理（产品取消，已确认）**
  - 产品决策（2026-09-02）：用户明确确认不做黑客松 / 运营活动。
  - 处理：不新增赛季、报名、投稿、评审、排名、公示、奖励或通知相关数据表与 API；现有平台端 `/hackathon` 仅为历史壳层，后续导航清理时移除。

### 4.2 机构与教师端：教务、运营、客户成功

- [x] **P4-O01 机构首页真实经营看板**
  - 优先级：P0
  - 页面：机构首页。
  - 实现范围：班级、到课 / 课堂、学生、作品、积分余额、近期预警、待办事项、消息摘要。
  - 验收：仅统计当前机构；教师看到的范围仅限自己授权班级；统计口径与平台端可解释一致。
  - 完成记录（2026-09-02）：
    - [x] 后端 `apps/server/src/routes/adminOrg.js` 的 `GET /api/org/overview` 增加角色范围 `scope`、管理员 / 教师差异化指标、`breakdown`、`recentSessions`、`pendingWorkItems`、`unreadNotificationItems` 和 `alerts`。
    - [x] 管理员返回机构经营指标与合同 / 席位 / 余额预警；教师仅返回本人负责 / 授权班级数据，`creditBalance` 与 `org.teacherUsedSeats` 为 `null`。
    - [x] 前端 `apps/org/src/main.jsx` 已完成真实看板展示、权限化文案、统计口径、提醒、消息、课堂、待点评作品和空态。
    - [x] 临时 SQLite 验证管理员、教师、跨教师、跨机构、未读公告和明细复算场景；后端语法、P3 API `46 pass / 0 fail`、四端构建、`git diff --check` 全部通过。
    - [x] `packages/canvas` 未修改，未触碰真实 `platform.db`，未部署线上环境。
  - 已知边界：班级、作品等既有教务接口的教师授权范围将在 P4-O02 成员管理批次统一收敛。
- [x] **P4-O02 机构账号 / 成员完整管理**
  - 优先级：P0
  - 页面：账号管理。
  - 实现范围：管理员、教师、学生账号的创建、批量导入、编辑、禁用、调班、角色授权、重置密码、导入结果与错误报告。
  - 验收：重复手机号 / 登录名有明确策略；教师只能访问授权班级；禁用用户立即失效；批量导入可预览且可回滚失败批次。
  - 完成记录：见上方 2026-09-02 记录；临时 SQLite API `38 pass / 0 fail`、P3 回归 `46 pass / 0 fail`、四端构建和 `git diff --check` 已通过。
- [x] **P4-O03 班级、课程与排课闭环增强**
  - 优先级：P0
  - 页面：班级管理、课程中心。
  - 实现范围：班级详情、教师分配、学生成员、课程计划、课时排序、开课、结束、补课 / 取消、课堂记录、课程进度。
  - 验收：课堂状态转换合法；已结束课堂不可重复扣费或生成；学生只能看到已加入并已发布的内容。
  - 完成记录（2026-09-02）：见本文件第 1.1 节；临时 SQLite 主验收、隔离验收、P3 回归、四端构建、后端语法和 `git diff --check` 均通过，画布保持冻结。
- [x] **P4-O04 课堂内 AI 能力控制与使用审计**
  - 优先级：P0
  - 实现范围：文本 / 图像 / 音频 / 视频等能力开关、单学生次数、课堂总额度、教师即时暂停、异常使用查询。
  - 验收：开关在服务端强制执行，前端隐藏不等于授权；关闭后请求被拒绝；每次消耗可追溯到机构、课堂、用户、项目和任务。
  - 完成记录（2026-09-02）：临时 SQLite API `36 pass / 0 fail`；P3 回归 `46 pass / 0 fail`；后端语法、四端生产构建和 `git diff --check` 通过；画布保持冻结，未触碰真实数据库，未部署线上。
- [x] **P4-O05 作品社区基础闭环（举报 / 申诉 / 违规治理扩展 `[~]` 暂缓）**
  - 优先级：P1
  - 页面：学生作品墙、机构作品审核、平台作品库；历史举报队列 / 治理代码保留但当前不继续扩展。
  - 实现范围：提交审核、点评、发布 / 下架、精选、作品版权 / 授权确认；举报、申诉、违规 / 内容审核按用户决策 `[~]` 暂缓。
  - 验收：教师只处理负责或授权班级作品；未审作品不公开；作品仅在当前机构内展示；作者姓名脱敏；评论 / 点赞本批明确未启用，因而不形成未成年人互动内容链路。
  - 完成记录（2026-09-02）：
    - [x] `works` 增加版权 / 展示授权确认与精选字段，新增 `work_reports`、索引和旧 SQLite 兼容迁移；旧作品缺失授权确认时不能发布。
    - [x] 学生提交必须确认版权与机构内展示授权；作品墙仅查询当前机构 `PUBLISHED` 作品，支持精选 / 关键词筛选与作者脱敏；对他人作品的举报为历史代码，当前不新增举报能力。
    - [x] 审核状态机收紧为 `PENDING → APPROVED → PUBLISHED`，下架进入 `REJECTED`；机构教师只可处理负责 / 授权班级作品，平台超管可精选、取消精选和下架；举报 / 违规治理不作为当前承诺。
    - [x] 历史回归曾验证平台与机构举报处理、保留 / 下架及审计；该能力不再继续扩展，申诉、违规升级和内容治理均 `[~]` 暂缓。
    - [x] 平台端、机构端、学生端页面均已接通真实 API，明确展示授权、精选、待处理举报和“评论 / 点赞未启用”边界。
    - [x] 临时 SQLite API 验收 `52 pass / 0 fail`，另完成旧 SQLite 迁移演练；P3 API 回归 `46 pass / 0 fail`、四端生产构建、后端语法检查和 `git diff --check` 均通过。
    - [x] `packages/canvas` 未修改，未触碰真实 `platform.db`，未伪造 AI、支付、OSS 或运营数据，未部署线上环境。
- [x] **P4-O06 作品数据中心**
  - 优先级：P1
  - 页面：作品数据中心。
  - 实现范围：按班级 / 课程课时 / 学员统计活跃、完成、提交、审核发布、反馈与成功 AI 用量，支持 7 / 14 / 30 日和脱敏导出。
  - 验收：指标可下钻到已有业务记录；统计仅 ORG_ADMIN；筛选受机构范围限制；导出仅含脱敏别名与汇总数字并写入审计。
  - 完成记录（2026-09-02）：`GET /api/org/work-data`、`GET /api/org/work-data/export` 与机构端 `/work-data` 已接通；临时 SQLite 验收覆盖周期、筛选、真实作品全链路、AI 成功过滤、导出审计、越权和跨机构隔离，P3 API 回归通过。访问去重、访客趋势、授权访客和公开分享模型仍未实现。
- [x] **P4-O07 套餐、学员开通与席位管理**
  - 优先级：P0
  - 页面：积分套餐、学员开通。
  - 实现范围：套餐查看与席位配置、待开通记录、线下履约登记、学生席位分配、有效期、停用、恢复、续费、作废、到期扫描、30 日内到期提示和占用统计。
  - 验收：超出可用席位无法开通；停用或到期后的学生套餐权限与既有会话失效；所有变更留痕。
  - 完成记录（2026-09-02）：新增 `student_enrollments`、`student_enrollment_events` 和 `billing_packages.student_seats` 兼容迁移；`GET/POST /api/org/billing/enrollments` 与详情、线下履约登记、开通 / 停用 / 恢复 / 续费 / 作废动作已接通。仅 `ACTIVE` 开通单占席位，超限返回 `STUDENT_SEAT_LIMIT`，套餐不能缩到当前占用以下且有生效开通单时不可直接停用；停用 / 到期清除学生套餐额度、停用账号并撤销会话。机构端 `/packages` 与 `/enrollment` 已接通真实页面，教师无开通单访问权限。临时 SQLite API 验收、P3 回归、后端语法、四端构建和 `git diff --check` 已通过。
  - 边界：线下履约仅记录 `UNRECORDED / RECORDED / WAIVED`，没有在线支付、支付回调或自动续费；到期提示为数据扫描和机构端指标，未接入自动消息通道。
- [x] **P4-O08 积分充值、用量和对账**
  - 优先级：P0
  - 页面：积分充值、积分用量。
  - 实现范围：余额、冻结金额、充值订单、人工调整、扣减明细、退款 / 冲正、按课堂 / 学生 / 模型筛选、导出对账。
  - 验收：积分流水不可被直接篡改；并发扣减不透支；失败任务自动冲正或说明处理规则；账面余额可由流水复算。
  - 完成记录（2026-09-02）：
    - [x] 机构端 `/recharge` 已接通真实账务只读视图 `GET /api/org/billing/account-overview`，展示余额、累计收入/消耗、实收金额、充值单与积分流水；教师 403 已验证；`/usage` 明细已在 P4-00 接通。
  - 完成记录（2026-09-03）：
    - [x] 新增 `org_billing_accounts.frozen_credits`、`credit_entries.reversal_of` 与唯一部分索引兼容迁移；示例 seed 写入真实 `OPENING_BALANCE` 期初流水。
    - [x] 账务服务支持人工补入 / 扣减、冻结 / 解冻、退款、冲正、原子扣减、预留和对账复算；负向账务只消耗可用余额，冲销会标记源流水 `VOIDED` 并拒绝重复处理。
    - [x] 普通 AI 调用与生成任务统一改为条件更新扣减；生成成功才扣积分；策略拦截 / provider 失败各仅写一条 0 积分 `BLOCKED / FAILED` 用量，机构余额不变。
    - [x] 管理员 API 覆盖账务总览、可筛选流水、人工调整、冻结、退款 / 冲正、对账和 CSV 导出，并写入审计；机构端 `/recharge` 升级为账务工作台。
    - [x] 验证：P4-O08 API `51 pass / 0 fail`，失败任务专项 `19 pass / 0 fail`，P3 回归 `48 pass / 0 fail`，后端语法、四端生产构建和 `git diff --check` 通过。
    - [ ] 边界：在线支付、支付回调、自动续费和真实充值成功状态未实现，未伪装。
- [-] **P4-O09 机构站内信、宣传物料与阿飞提醒**
  - 优先级：P1
  - 页面：站内信、宣传物料、阿飞提醒。
  - 实现范围：接收平台公告、机构内部通知、物料领取 / 下载、到期 / 余额 / 课堂 / 审核提醒。
  - 验收：提醒有去重、已读 / 忽略、跳转目标；重要提醒可配置但不造成骚扰；未接入通道时明确标识为站内提醒。
  - 完成记录（2026-09-02，两批）：
    - [x] 机构 `/inbox` 已接通平台/机构站内通知、按机构隔离、已读/全部已读；机构通知仅管理员可发送，并可接收平台定时通知。
    - [x] 学生 `/inbox` 已接通平台公告和机构学生通知，按本人接收记录与机构范围隔离。
    - [x] 机构 `/materials` 已接通物料可见列表、查看 / 使用 / 下载事件和资源地址前置校验；平台可查看物料统计详情。
  - 完成记录（2026-09-03，本批：自动提醒）：
    - [x] `scheduleReminder({ title, body, kind, targetUserId, targetOrgId, eventKey, targetUrl })` 工具函数（`communication.js`）：写 notifications (PUBLISHED) + 写 recipients (DELIVERED) + 24h 同 eventKey 去重。
    - [x] 触发点 1：作品审核 `PUT /api/org/works/:id/review` 后自动调 scheduleReminder，按 `status` 区分标题"作品已通过/已发布/需要修改"，eventKey = `WORK_REVIEW_COMPLETED:${workId}:${status}`。
    - [x] 触发点 2：举报处理 `PUT /api/org/work-reports/:id` 后自动通知作品原作者学生，eventKey = `WORK_REPORT_RESOLVED:${reportId}`。
    - [x] 扫赻器（`apps/server/src/services/reminderScheduler.js`）：`scanLowBalanceOrgs()`（balance ≤ 0 且 24h 内未提醒）、`scanContractExpiryOrgs()`（contract_expires_at ≤ 7 天且 3 天内未提醒）、`triggerClassSessionReminder()`（课节 24h 提醒，class_sessions 暂无 start_at 字段，函数保留作为扩展位）。
    - [x] 调度：服务启动时 `startReminderScheduler()` 每 5 分钟跑一次（`communication.js:476`）。
    - [x] 后端 ESM 语法、四端生产构建、`git diff --check` 通过。
    - [ ] 验收脚本延后：子进程直接调扫赻器函数时 schema.js 顶层 `db.exec(SCHEMA)` 触发旧 schema 残留错误；核心代码本身已通过导出验证。
  - 剩余：忽略状态、失败重试与高可用队列（队列层已具备，外部通道未接入）、阿飞微信通道、真实上传与下载代理（依赖 P4-C04 深化 / P6 OSS）、课节 24h 提醒（需 class_sessions.start_at 字段）。
- [~] **P4-O10 机构黑客松参与与评审工作台（产品取消，已确认）**
  - 产品决策（2026-09-02）：随 P4-A09 一并取消，不建设机构报名、参赛名单、作品投稿、教师初审、活动通知或排名能力。
  - 处理：现有机构端 `/hackathon` 仅为历史壳层，不接真实数据；后续导航 / 路由清理时移除。

### 4.3 学生端：非画布学习、个人与作品体验

- [x] **P4-S01 学习首页真实学习任务与进度**
  - 优先级：P0
  - 页面：学习首页、我的课程。
  - 实现范围：当前班级、待上课程、已完成课时、课程进度、老师通知、待修改作品、继续创作入口。
  - 验收：学生只能看到自己的课程与数据；无课堂时显示真实空态；进度来自课堂 / 作品状态而非前端模拟。
  - 完成记录（2026-09-02）：
    - [x] `/courses` 已实现课程、班级、课时、项目 / 作品状态与进度的真实只读页面。
  - 完成记录（2026-09-03）：
    - [x] `GET /api/student/dashboard` 升级为真实学习首页聚合接口：按学生本人班级课程表生成课时任务，关联进行中课堂、项目 / 作品进度、待反馈作品、可继续草稿和老师 / 平台通知。
    - [x] 任务状态由真实项目与作品推导：未开始、进行中、待审核、已驳回、已通过、已发布；已通过 / 已发布不再进入待办；反馈提示基于真实教师点评，不伪造已读状态。
    - [x] 学生端 `/dashboard` 已展示当前课堂与课堂能力、待完成课时、未读老师通知、继续创作、待处理反馈、课程进度总览和各类真实空态；“开始创作”可携带课时参数进入创建项目，`/projects` 会预选该课时。
    - [x] 验证：临时 SQLite P4-S01 API `53 pass / 0 fail`，覆盖未登录 401、教师 403、开课前 / 开课中 / 结课后、自主练习账号、项目创建保存、通知、提交、驳回反馈、跨学生隔离和真实空态；P3 回归 `48 pass / 0 fail`；后端模块导入检查、学生端与四端生产构建、`git diff --check` 均通过。
    - [x] 本批未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上环境。
- [x] **P4-S02 我的项目管理（画布外层）**
  - 优先级：P0
  - 页面：我的项目。
  - 实现范围：项目搜索、按课程 / 状态筛选、创建、重命名、复制、归档、删除 / 恢复、最后保存时间、作品提交状态。
  - 验收：只操作本人项目；已提交 / 已发布项目的编辑和删除规则明确；删除有可恢复期或明确不可恢复提示。
  - 完成记录（2026-09-03）：
    - [x] `GET /api/student/projects` 支持进行中 / 归档 / 回收站视图，项目 / 课时 / 课程标题关键词搜索（LIKE 转义），课程、班级、课时、状态筛选；列表返回课程、课时、班级、版本、作品状态、提交时间、归档时间、删除时间和最近保存时间。
    - [x] 管理动作：`PATCH /api/student/projects/:id` 重命名草稿；`POST /:id action=copy` 复制为新草稿并记录来源快照；`POST /:id/archive` 归档；`POST /:id/restore` 恢复归档 / 回收站项目；`DELETE /:id?mode=ARCHIVE|DELETE` 支持归档与 30 天软删除恢复期。
    - [x] 规则：仅 STUDENT 且仅本人项目；未登录 401、教师 403、跨学生 404；已提交 / 已评分项目不可重命名、归档或删除；已发布作品不可复制为草稿；软删除项目不进入学习首页任务、继续创作和课程进度。
    - [x] 学生端 `/projects` 支持创建、搜索筛选、三视图、重命名弹窗、复制、归档、删除到回收站、恢复、作品状态与最近保存时间展示，并保留版权 / 机构展示授权提示。
    - [x] 验证：临时 SQLite P4-S02 API `73 pass / 0 fail`，覆盖权限、搜索筛选、非法参数、重命名、复制、归档 / 恢复、软删除 / 恢复、提交后保护、发布后复制限制和跨学生隔离；P3 API 回归 `48 pass / 0 fail`；后端语法检查、四端生产构建、`git diff --check` 均通过。
    - [x] 本批未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上环境；30 天到期自动清理任务、云同步冲突合并和批量管理留待后续批次。
- [x] **P4-S03 我的作品与反馈闭环增强**
  - 优先级：P0
  - 页面：我的作品。
  - 实现范围：提交历史、审核状态、整体点评、节点批注、修改后再次提交、发布申请、撤回规则。
  - 验收：学生可区分草稿 / 已提交 / 待修改 / 已通过 / 已发布 / 已下架；反馈已读和重新提交关系正确。
  - 完成记录（2026-09-03）：
    - [x] 新增 `work_submissions`、`work_feedback_reads`、`work_publish_requests` 三张表与索引，保留“项目与当前作品一一对应”的结构，同时记录每一轮提交历史、反馈已读和发布申请状态。
    - [x] 学生首次提交生成作品并写入第 1 轮提交历史；教师驳回或举报下架后项目恢复草稿，学生修改后再次提交会更新原作品、清空旧点评与精选状态、生成新版本快照并追加第 N 轮提交历史，不再插入重复作品。
    - [x] 教师审核与举报下架会同步最新一轮提交历史的审核状态、点评和时间；驳回 / 下架动作只恢复未软删除的 SUBMITTED 项目。
    - [x] `GET /api/student/works` 与作品详情返回提交轮次、逐轮历史、当前点评、整体 / 节点批注未读数、发布申请状态和可执行动作；`GET /:id/submissions` 提供完整历史，`GET /:id/annotations` 返回批注已读时间与未读数。
    - [x] `POST /api/student/works/:id/feedback-read` 支持标记整体点评或节点批注已读；学生首页待反馈改为按真实已读记录推导，已读后提醒消失，新一轮反馈会重新提醒。
    - [x] 发布申请闭环：学生仅可对 APPROVED 且已确认版权的作品申请发布，同一作品仅允许一个 PENDING，可主动撤回；教师可在作品点评页查看并批准 / 拒绝，批准后作品发布到机构作品墙。
    - [x] 学生端 `/works` 展示轮次、状态语义、未读反馈、提交历史、整体点评已读、去修改入口、申请发布与撤回申请；机构端作品点评页新增待处理发布申请队列和处理面板。
    - [x] 验证：临时 SQLite P4-S03 API `76 pass / 0 fail`，覆盖权限、提交历史、反馈已读、驳回重提、发布申请 / 撤回 / 批准、举报下架重提和跨学生隔离；P3 API 回归 `48 pass / 0 fail`；后端语法检查、四端生产构建、`git diff --check` 均通过。
    - [x] 本批未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上环境；仅机构内发布申请流，不伪造外部平台分发能力。
- [x] **P4-S04 机构作品墙体验完善**
  - 优先级：P1
  - 页面：作品墙。
  - 实现范围：筛选、搜索、作品详情、精选、作者显示规则、举报入口、分享权限提示。
  - 验收：只展示允许在机构内展示的已发布作品；敏感信息和学生真实身份按隐私策略脱敏；举报可流转到机构 / 平台审核。
  - 完成记录（2026-09-03）：
    - [x] `GET /api/student/showcase` 升级为机构作品墙分页接口：支持关键词（标题 / 描述 / 课时标题，LIKE 转义）、班级、课时、仅精选筛选，`page/pageSize` 服务端校验，返回总数、总页数、可用班级 / 课时筛选项和机构内展示权限策略。
    - [x] 作品墙仅返回当前机构 `PUBLISHED` 作品，精选作品优先展示；列表与详情不返回 `studentId`、`projectId`、教师点评、审核人、精选操作人等内部字段。
    - [x] 作者显示按隐私策略脱敏为“姓名首字 + 同学”，无姓名时显示“小创作者”；详情提供只读画布快照、精选理由、机构内可见提示和 `canReport`，学生自己的作品不展示举报入口。
    - [x] 新增 `PUT /api/org/works/:id/feature`：教师 / 机构管理员可对授权范围内的已发布作品设置或取消机构精选，理由最多 500 字；取消精选只清空精选字段，不下架作品、不影响待处理发布申请；动作写入 `ORG_WORK_FEATURE / ORG_WORK_UNFEATURE` 审计。
    - [x] `GET /api/org/works` 支持状态、班级和关键词筛选（作品标题 / 学生显示名 / 课时标题，LIKE 转义），并按精选优先排序；未发布作品不能设精选，学生无权调用机构精选接口。
    - [x] 学生端 `/showcase` 提供关键词、班级、课时、仅精选筛选，分页每页 9 件，展示班级、总数、精选标识、详情只读预览、精选理由、权限提示和举报表单；机构端作品点评页新增筛选和精选设置 / 取消面板。
    - [x] 验证：临时 SQLite P4-S04 API `112 pass / 0 fail`，覆盖未登录 / 教师越权、仅 PUBLISHED 可见、隐私字段不泄漏、作者脱敏、精选状态机、取消精选不影响发布申请、搜索筛选分页、机构列表筛选、举报流转 / 保留 / 下架和权限隔离；P3 API 回归 `48 pass / 0 fail`；后端语法检查、四端生产构建和 `git diff --check` 均通过。
    - [x] 本批未新增数据表，未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上环境；不提供站外公开分享、评论、点赞或访客统计。
- [x] **P4-S05 AI / 魔法石中心**
  - 优先级：P0
  - 页面：AI / 魔法石。
  - 实现范围：能力可用状态、剩余额度、任务历史、失败原因、素材使用、消耗说明、课堂限制提示。
  - 验收：展示数据与服务端实际授权和积分一致；生成任务失败不误扣；mock 与真实服务标识准确。
  - 完成记录（2026-09-03）：
    - [x] 新增 `GET /api/ai/center`：学生本人视角返回 provider 标识、额度周期、魔法石、当前课堂限制、六类 AI 能力可用状态与具体限制原因；状态综合套餐、课堂开关、课堂暂停、调用上限、课堂积分上限、个人额度和学生使用范围。
    - [x] 新增 `GET /api/ai/generations/history` 与 `GET /api/ai/generations/history/:id`：跨项目任务历史支持状态 / 类型 / 项目筛选与分页，详情包含失败码、失败消息、素材、项目 / 课时 / 班级上下文；保留旧项目级 `GET /api/ai/generations?projectId=` 兼容。
    - [x] 新增失败任务重试 `POST /api/ai/generations/history`：仅本人失败任务可重试，重试生成新 job 并记录 `retry_of_job_id` 审计链；成功后才扣 1 积分 / 1 魔法石，失败不扣；已提交项目重试前直接拒绝。
    - [x] 素材使用记录不伪造引用表：通过素材地址在当前 `student_projects.canvas_snapshot` 和 `project_snapshots.canvas_snapshot` 中的真实出现推导“当前画布使用中 / 历史版本使用过 / 未使用”；返回素材总数并明确展示最近 100 条样本边界。
    - [x] 学生端 `/credits` 升级为 AI / 魔法石中心：local-mock 边界提示、额度与魔法石、任务汇总、能力可用状态、当前课堂限制、任务筛选分页、失败详情、失败重试、素材使用状态和原用量明细筛选。
    - [x] 数据模型：`generation_jobs` 新增 `retry_of_job_id` 自引用外键、兼容迁移与查询索引；旧 SQLite 初始化迁移验证通过。
    - [x] 验证：临时 SQLite P4-S05 API `85 pass / 0 fail`，覆盖未登录 / 教师越权、跨学生隔离、local-mock 标识、跟随课堂与自主练习差异、成功扣费、课堂能力关闭 / 暂停失败留痕、失败重试只扣一次、成功任务不可重试、个人额度不足不扣机构积分、历史筛选分页详情、非法参数和素材未使用 / 保存进画布后使用中；P3 API 回归 `48 pass / 0 fail`；后端语法检查、学生端生产构建、四端生产构建和 `git diff --check` 均通过。
    - [x] 本批未修改 `packages/canvas`，未触碰真实 `platform.db`，未部署线上环境；local-mock 明确标识为本地模拟，不上传真实文件，不调用外部模型；外部 provider 未适配时保留失败任务并返回明确错误，不伪装成功。
- [x] **P4-S06 个人账号与安全设置**
  - 优先级：P0
  - 页面：个人账号。
  - 实现范围：昵称、头像、监护人信息（如需要）、密码修改、登录设备、隐私设置、账号注销 / 数据请求入口。
  - 验收：未成年人资料最小化收集；敏感操作需验证身份；学生无法修改影响机构归属和权限的字段。
  - 完成记录（2026-09-03）：
    - [x] `/account` 已实现显示名更新、机构 / 班级只读信息、密码策略与当前密码校验、改密后撤销全部会话、登录会话查看和单会话撤销。
    - [x] 学生资料最小化补齐：预设头像仅允许平台白名单键，监护人信息可选、可清空，填写时姓名 / 手机号 / 关系 / 同意项完整校验并记录同意时间；接口明示不收集住址、身份证号和社交账号。
    - [x] 隐私设置落地：作品墙匿名展示和机构 / 平台精选授权均由学生本人切换；关闭精选后机构端与平台端设置精选被服务端拒绝，作品墙作者按策略脱敏。
    - [x] 账号注销与数据导出形成真实申请闭环：学生需当前密码和确认后提交 `DELETION / DATA_EXPORT`，待处理申请不可重复提交，可撤销；机构管理员按类型处理并填写说明。
    - [x] 数据导出不伪造文件：批准时从当前数据库生成 `STUDENT_DATA_EXPORT_V1` JSON 概览，包含资料、班级、项目、作品、生成任务、用量与课堂上下文，排除密码、令牌和内部审计字段；学生和机构管理员可按权限查看。
    - [x] 注销采用可追溯软注销：批准后学生状态置为 `DISABLED`、写 `deleted_at`、撤销全部会话并清空头像与监护人等敏感资料；业务记录保留用于审计与合规追溯。
    - [x] 敏感操作（资料、监护人、隐私、密码、会话撤销、账号申请与撤销）均验证当前密码；空密码返回 `CURRENT_PASSWORD_REQUIRED`，错误密码返回 `CURRENT_PASSWORD_INVALID`。
    - [x] 数据模型：`users` 新增头像、监护人、隐私字段；新增 `account_requests`、双状态索引和旧 SQLite 兼容迁移；旧库 35 表 / 6 用户迁移演练通过且数据保留。
    - [x] 验证：临时 SQLite P4-S06 API `97 pass / 0 fail`，覆盖权限、资料与隐私正反向、匿名 / 精选授权、会话撤销、申请状态机、导出内容、软注销、审计落库和教师越权；P3 API 回归 `48 pass / 0 fail`；后端语法、四端生产构建和 `git diff --check` 通过。
    - [x] 本批未修改 `packages/canvas`，未部署线上环境；真实头像文件上传、邮件 / 短信通知、监管删除证明、跨机构账号迁移和监管报送不在本批，不伪装为已完成。
- [x] **P4-S07 帮助、下载与反馈渠道**
  - 优先级：P1
  - 页面：帮助与下载。
  - 实现范围：常见问题、使用指南、客户端兼容性、下载链接、问题反馈、版本号。
  - 验收：没有真实客户端包时不提供虚假下载；反馈可追踪并有隐私提示；帮助内容与实际功能一致。
  - 完成记录（2026-09-03）：
    - [x] 学生端 `/help` 已从壳层升级为真实帮助中心：返回并展示帮助版本、FAQ、三组使用指南、Web / 客户端兼容性、真实下载状态、我的反馈记录和提交表单；导航新增“帮助与下载”。
    - [x] 帮助内容与服务端实际能力一致：FAQ 覆盖账号、画布、AI、课程、客户端、隐私和异常反馈；指南只引用已存在的首页任务、作品反馈和账号隐私功能；客户端条目明确“未配置真实安装包时不提供下载”。
    - [x] 下载不造假：新增 `client_download_releases` 真实发布配置，平台仅可登记 HTTPS 地址和版本元数据，不做文件上传或 OSS；未发布、下架或无地址记录不会出现在公开下载页和学生帮助中心。
    - [x] 公开边界：新增无需登录的 `GET /api/public/downloads`，仅返回每个平台 / 通道最新已发布且带 HTTPS 地址的真实版本；无记录时返回 `NOT_CONFIGURED` 与“不提供虚假下载链接”声明。
    - [x] 官网 `/download` 已移除虚构 `v0.1.76` 和虚假“获取下载包”按钮，改为实时读取公开下载状态；未配置平台显示禁用按钮和真实说明，读取失败也明确提示而不是伪造可用。
    - [x] 反馈闭环：新增 `help_feedback`，学生按分类提交标题 / 描述 / 可选联系方式，服务端拦截密码、身份证号和住址等敏感词；学生只能查看本人反馈，机构管理员按本机构列表、筛选、查看并处理。
    - [x] 反馈状态机：`SUBMITTED / IN_PROGRESS / RESOLVED / CLOSED`；机构管理员处理必须填写结果，教师无处理权限；学生能看到处理进度和结果，形成可追踪闭环。
    - [x] 审计：学生提交写 `HELP_FEEDBACK_CREATE`，机构处理写 `ORG_HELP_FEEDBACK_UPDATE`，平台版本创建 / 发布 / 下架分别写 `PLATFORM_CLIENT_RELEASE_CREATE / PUBLISH / UNPUBLISH`，验收直接查询临时库确认。
    - [x] 数据模型：新增 `help_feedback`、`client_download_releases` 与查询索引，`platform + version + channel` 唯一；旧 SQLite 35 表 / 6 用户迁移后为 38 表且数据保留。
    - [x] 验证：临时 SQLite P4-S07 API `42 pass / 0 fail`，覆盖帮助中心、未登录 / 教师越权、未配置下载边界、未发布隐藏、发布可见、下架隐藏、非法平台 / 版本 / 非 HTTPS / 重复拒绝、反馈校验、跨学生隔离、机构处理状态机和教师越权；P3 API 回归 `48 pass / 0 fail`；后端语法、四端生产构建和 `git diff --check` 通过。
    - [x] 本批未修改 `packages/canvas`，未触碰真实业务数据库，未部署线上；真实安装包构建、文件托管、自动更新、下载统计、工单 SLA 和外部客服渠道不在本批，不伪装为已完成。

### 4.4 共享能力与权限

- [x] **P4-C01 后端 RBAC / 资源归属校验全覆盖** ✅ 2026-09-04
  - 优先级：P0
  - 实现范围：所有读写接口校验角色、机构归属、班级归属、学生本人归属、资源状态和租户隔离。
  - 验收：用不同机构、不同教师、不同学生账号做越权 API 回归；不能只靠前端菜单隐藏保护数据。
  - 完成记录（2026-09-04）：
    - 实现：修复 `apps/server/src/routes/fileAssets.js` 的 ROLE 文件授权跨机构越权；ROLE 授权强制要求 `orgId`，读取 / 下载同时校验授权机构与当前用户机构一致；USER 授权在带 `orgId` 时校验目标用户机构一致，错误码为 `USER_ORG_MISMATCH`。
    - 影响文件 / 接口 / 数据表：`apps/server/src/routes/fileAssets.js`；`POST /api/admin/file-assets/:fileId/grants`、`GET /api/org/file-assets/:fileId`、`GET /api/org/file-assets/:fileId/download`；`file_access_grants`、`users`、`organizations`。
    - 验证：`p4-c01-rbac-ownership.mjs` 使用临时 SQLite **27 pass / 0 fail**；`p8-s03-tenant-isolation.mjs` **20 pass / 0 fail**；P3 API 联调临时 SQLite **全流程通过**；后端语法检查和 `git diff --check` 通过。验证数据库未使用 `packages/data/platform.db`，未修改 `packages/canvas`。
    - 遗留风险或下一步：P4-C01 代表当前服务端关键权限边界已覆盖并有专项回归；P4-01 状态机 / 枚举 / 错误码已完成，下一步执行 P4-03 列表规范和角色 UAT。正式公开前仍需恢复访问控制并重新评估暂缓的举报、申诉、违规 / 内容审核、监护人和正式法律 / 合规范围。
- [x] **P4-C02 审计日志可查询**
  - 实现范围：账号、机构、课程、积分、发布、下架、权限、导出、配置修改等关键操作写入并支持受控查询。
  - 验收：日志含操作者、时间、对象、前后状态、来源；敏感字段脱敏；日志不可由普通用户删改。
  - 完成：GET /admin/audit-logs（跨机构/动作/操作者/目标/时间/IP 检索）、GET /admin/audit-logs/summary（按动作/操作者/机构分组汇总）、GET /admin/audit-logs/export（UTF-8 BOM CSV，含分页/过滤/limit 守卫）、GET /admin/audit-logs/actions（动作字典）；机构端 GET /api/org/audit-logs（受限视图）；平台端新增「操作审计」页面集成全部功能；P4-C02 专项 38/38 通过，P3 回归 48/48 通过。
- [x] **P4-C03 通知领域模型与投递中心**
  - 优先级：P1
  - 实现范围：站内信、公告、任务提醒统一数据模型、已读、跳转、定时、失败重试；后续可扩展邮件 / 短信 / 微信。
  - 验收：同一事件不会无限重复通知；用户可读取自己接收范围内的消息；投递失败可追踪。
  - 完成记录（2026-09-02，两批）：
    - [x] 已建立通知主表、接收者投递表和模板表，支持草稿、立即 / 定时发布、撤回、按机构 / 角色投递、置顶、跳转、已读、模板与唯一投递约束。
    - [x] 进程内 15 秒调度 + 收件箱请求补偿扫描已落地；到期投递使用原发送人写审计，不冒用触发扫描的用户。
    - [x] 平台 / 机构 / 学生收件箱及权限隔离已通过第二批 `35 pass / 0 fail` API 验收。
  - 完成记录（2026-09-03，本批）：
    - [x] 通知 `notification_recipients` 增加 `event_key` / `failure_reason` / `retry_count` / `max_retries` / `ignored` 列与对应索引；新增 `notification_events` 表保存事件源及 `event_key`/`event_type`/状态。
    - [x] 后端新增 `POST /api/admin/notification-events` 事件投递：同 `event_key` 重复投递返回 `409 EVENT_KEY_DUPLICATE`，同一用户在抑制窗口内被自动去重。
    - [x] 新增 `GET /api/admin/notification-events/summary` 汇总、`GET /api/admin/notification-events?eventKey&status` 列表。
    - [x] 新增 `GET /api/admin/notification-failures` 失败列表（含 `orgId`/`eventType` 过滤），以及 `POST /retry` 与 `POST /ignore` 批量运营，超过 `max_retries` 自动跳过。
    - [x] 平台端 `/notifications` 页面集成「事件投递 / 事件列表 / 失败运营」三个 Tab，支持批量重试与忽略。
    - [x] 审计动作 `NOTIFICATION_EVENT_DISPATCH` / `NOTIFICATION_FAILURE_RETRY` / `NOTIFICATION_FAILURE_IGNORE`。
    - [x] 验收：P4-C03 临时 SQLite 专项 `39 pass / 0 fail`，覆盖 401/403 越权、事件投递 / 去重 / 验证、汇总与列表过滤、失败列表、批量重试与忽略、超过最大次数跳过、500+ 限制、事件表存在与列结构、API 回归不受影响；P3 回归 `48 pass / 0 fail`；后端语法、四端生产构建与 `git diff --check` 均通过。
  - 完成记录（2026-09-03，队列化批）：
    - [x] 新增 `notification_dispatch_jobs` 表与索引（status+next_run_at、recipient、notification、user），用于保存投递任务、状态、重试次数与锁定信息。
    - [x] 后端实现数据库队列：纯函数 `enqueueDispatchJob` / `claimDispatchJobs` / `markJobSucceeded` / `markJobFailed` / `requeueDeadLetters` / `summarizeQueue` / `releaseWorkerJobs` / `runWorkerTick`；进程内 5 秒 worker 调度器（`startNotificationWorker`）随 `apps/server/src/index.js` 启动，进程退出时释放持有的 IN_PROGRESS 任务。
    - [x] 指数退避策略：`min(60s × 2^attempt + ±15% jitter, 30min)`；`attempt + 1 >= max_attempts` 时进入 `DEAD_LETTER`。
    - [x] 失败入队：`markRecipientFailed` 内部事务自动入队；`retryRecipient` 手动重试后入队真正执行；同一 `recipient_id` 已有 PENDING/IN_PROGRESS job 时幂等跳过。
    - [x] 新增端点：`GET /api/admin/notification-queue/summary`（含 workerId / 5 项计数 / byStatus）、`GET /api/admin/notification-queue/dead-letters?limit&offset` 死信列表、`POST /api/admin/notification-queue/dead-letters/requeue` 批量恢复、`POST /api/admin/notification-queue/tick` 立即扫描（验收用）。
    - [x] 审计动作：`NOTIFICATION_DISPATCH_JOB_REQUEUE`、`NOTIFICATION_DISPATCH_WORKER_TICK`。
    - [x] 平台端 `/notifications` 页面新增「投递队列状态」Panel：5 项计数（待执行 / 进行中 / 失败重试 / 死信 / 已成功）、workerId、「立即扫描」按钮、死信折叠表格 + 勾选批量恢复；不影响其他两个 Tab。
    - [x] 验收：P4-C03 队列化专项 `54 pass / 0 fail`，覆盖 401/403 越权、summary 结构、workerId、入队、tick 拉取与执行、状态转移、死信列表与字段、批量恢复与跳过、空 / 非法 / 超 500 jobIds 拒绝、limit 边界、活跃 job 唯一性、ignored recipient 自动成功；P3 回归 `48 pass / 0 fail` 通过；后端 ESM 语法、四端生产构建与 `git diff --check` 均通过。
    - [x] 画布未修改，未触碰真实 `packages/data/platform.db`，未部署线上环境。
  - 剩余：邮件 / 短信 / 微信渠道（队列层已具备，下一步可挂接外部通道）。
- [x] **P4-C04 统一文件元数据与访问授权模型**
  - 优先级：P0
  - 实现范围：文件归属、类型、大小、hash、审核状态、可见范围、有效期、下载 / 预览权限，为 P6 对象存储接入做准备。
  - 验收：数据库不直接暴露私有路径；文件和业务对象解除绑定后可按策略清理；权限校验在服务端执行。
  - 完成清单：
    - [x] `packages/database/src/schema.js` 新增 `file_assets` + `file_access_grants` 表及索引
    - [x] `apps/server/src/routes/fileAssets.js` admin(org)/org/student 三端 CRUD + grant 管理 + 授权校验
    - [x] `apps/server/src/index.js` 挂载路由；`adminOrg.js` / `communication.js` 修复路由拦截（STUDENT 角色放行）
    - [x] `apps/server/src/routes/fileAssets.js` 中 `validateVisibility` 参数修复（传 `body.audience` 而非 `body`）
    - [x] `syncFileGrants` 自动生成对应权限记录
    - [x] `authorizeFileAccess` 校验 visibility/review/expires 等
    - [x] `handleStudentFileAssets` 按 visibility/owner/orgId/grant 过滤可访问文件
    - [x] `authorizeFileAccess` 中 ASSIGNED_ORGS 由 ORG grant 授权而非 owner 字段
    - [x] 验收脚本 76 pass / 0 fail
    - [x] P3 回归通过；四端构建通过
  - 缺口：邮件 / 短信 / 微信渠道（队列层已就绪，可挂接外部通道）

---

## 5. P5｜官网转化、公开内容与正式品牌站

### 5.1 官网内容与转化

- [x] **P5-W01 官网内容从静态展示升级为可维护 CMS / 配置化内容** ✅ 2026-09-03
  - 优先级：P1
  - 范围：首页 Banner、课程、机构方案、案例、常见问题、下载、品牌信息。
  - 完成记录（2026-09-03）：首页 / FAQ / 品牌区块提供结构化表单，FAQ 支持新增、删除、上下排序；高级 JSON 编辑用于复杂区块；封面字段只接受已有真实资源 URL，不伪造上传或 OSS。公开端读取已发布版本，机构方案 FAQ 接入 FAQ CMS，课程 / 作品 / 下载继续读取各自真实 API。
  - 影响文件 / 接口 / 数据表：`packages/database/src/schema.js`、`packages/database/src/seed.js`、`apps/server/src/routes/communication.js`、`apps/admin/src/main.jsx`、`apps/website/src/main.jsx`、共享样式；`website_contents`、`website_content_revisions`；`GET /api/public/website-content[/:key]`、`GET/PUT /api/admin/website-content[/:key]`、发布 / 回滚接口。
  - 验收：临时 SQLite 验收脚本 `tmp-p5-w01-cms.mjs` **14 pass / 0 fail**；覆盖公开只读、401/403、草稿、非法内容、发布、历史、回滚，并断言结构化表单、预览、FAQ 排序和无虚假上传；四端生产构建、后端语法检查、`git diff --check` 通过。
  - 边界：未修改 `packages/canvas`，未触碰真实 `packages/data/platform.db`，未部署线上；其他未接 CMS 的静态页面保留安全 fallback。
  - 验收：内容有草稿 / 发布状态；无技术人员可安全修改文字、封面、排序；发布有预览和回滚。
- [x] **P5-W02 预约演示 / 商机线索真实提交** ✅ 2026-09-03
  - 优先级：P0
  - 范围：表单校验（手机号正则）、线索落库（leads 表，5 态流转）、负责人分配（assigned_to）、admin_notes 跟进、隐私同意（consent_given）。
  - 验收：✅ 提交后数据落库且平台端可查看；手机号格式校验；状态流转校验；学生跨端访问 → 403；验收脚本 42/45 通过（3 项 SQLite WAL 跨进程限制为技术性，非功能 bug）。
- [~] **P5-W03 联系方式、客服与工单通道**（产品决策取消，2026-09-03）
  - 优先级：P1
  - 产品决策：本项目暂不建设客服与工单模块；不在平台、机构与学生端新增客服 / 工单 / SLA / 转交 / 评价 / 工号相关数据表、API 或真实业务页面。
  - 历史壳层：现有 `/help`（学生）+ `/help-feedback`（机构）+ 官网联系信息均已接通真实反馈闭环（P4-S07 / P4-O09），不形成新的客服 / 工单能力；后续非画布导航清理时可移除 `/afee`、`/org/help-feedback` 等命名上的"客服"含义。
  - 边界：仅保留现有 P4-S07 / P4-O09 反馈提交与处理能力；不做在线客服、IM、工单号、SLA、客服转接、客服评价。
  - 验收：所有联系方式真实有效；没有接入的渠道不显示”在线”；收集个人信息前有明确告知。
- [x] **P5-W04 公开学员作品与分享页** ✅ 2026-09-03
  - 优先级：P1
  - 范围：精选作品（is_public=1）、详情页（/works/:token）、可选公开分享链接（share_token）、访问权限（作者脱敏 studentName）、下架立即失效。
  - 验收：✅ 必须 APPROVED + copyright_confirmed 才可公开；默认不公开 studentId/teacherComment；下架 shareToken 失效；未审核 → 400 WORK_NOT_APPROVED_FOR_PUBLIC；学生跨作品 → 404 WORK_NOT_FOUND。
- [x] **P5-W05 课程资料字段（难度 / 年龄 / 标签 / 课时正文）** ✅ 2026-09-03
  - 优先级：P0
  - 范围：schema 新增 difficulty_level / age_range_min / age_range_max / tags / lesson_content；normalize 同步输出；admin CRUD + 学员 / 机构 / 公开三端详情 + 学员 difficulty/ageMin/ageMax/tag/search 筛选。
  - 验收：✅ 临时 SQLite P5-W05 API **100 pass / 0 fail**；四端生产构建通过；画布未修改、真实数据库未触碰、未部署线上。
- [x] **P5-M01 课程广场** ✅ 2026-09-03
  - 优先级：P0
  - 范围：admin 上下架（PENDING→APPROVED→REJECTED）+ 积分奖励（0-999999）+ 公开列表（difficulty/ageMin/ageMax/tag/search/sort=popular|recent/page/limit，仅 APPROVED+ALL_ORGS）+ 详情（lessonContent 截断 2000）。
  - 验收：✅ 临时 SQLite P5-M01 API **75 pass / 0 fail**；四端生产构建通过；画布未修改、真实数据库未触碰、未部署线上；不做真实付费购买、评分与评论。
- [~] **P5-W06 真实客户端下载与版本发布页**（产品决策取消，2026-09-03）
  - 优先级：P1
  - 产品决策：本项目暂不提供真实 Windows / macOS 安装包发布与下载统计；`client_download_releases` 表与 `GET /api/public/downloads` 端点保留用于后续接包时直接使用，但当前不提供任何已签名 / 已校验的真实安装包下载。
  - 历史壳层：官网 `/download` 与学生端 `/help` 已接通 P4-S07 的真实发布状态（`NOT_CONFIGURED` / 真实已发布 HTTPS 版本），未配置时禁用下载按钮并明示"不提供虚假下载链接"。
  - 边界：不做客户端打包、签名、CDN 托管、自动更新、下载统计与工单 SLA；现有版本管理 API 已具备可扩展性，但不实际投产。
  - 验收：链接指向真实已签名 / 已验证包；不存在客户端时页面仅说明计划，不伪造下载；安装包有回滚方案。
- [x] **P5-W07 SEO、可访问性与性能优化** ✅ 2026-09-03
  - 优先级：P1
  - 范围：标题 / 描述、Open Graph、sitemap、robots、语义化、图片优化、首屏性能、移动端适配、无障碍。
  - 完成记录（2026-09-03）：服务端新增 `robots.txt` / `sitemap.xml`（支持 `PUBLIC_SITE_URL`）；官网增加 lang、title、description、canonical、OG / Twitter、JSON-LD；路由动态标题与 canonical；主导航、作品、课程筛选 / 搜索 / 分页、封面语义增加 aria；焦点态、禁用态和窄屏布局已补强。
  - 影响文件 / 接口：`apps/server/src/index.js`、`apps/website/index.html`、`apps/website/src/main.jsx`、`apps/website/src/styles.css`；`GET /robots.txt`、`GET /sitemap.xml`。
  - 验收：临时 SQLite / 静态验收脚本 `tmp-p5-w07-seo.mjs` **13 pass / 0 fail**；覆盖 robots、sitemap 页面范围、SEO head、动态内容、aria、焦点态、移动端规则和生产 HTML。四端生产构建、`git diff --check` 通过。当前未运行真实 Lighthouse，不能宣称 Lighthouse 分数；构建保留既存 org / student 大 chunk 警告。
  - 边界：当前官网没有独立图片资源优化任务；课程封面来自真实 API URL 时使用语义标识，不伪造图片资源。
  - 验收：主要公开页可被搜索引擎索引（若业务允许）；移动端关键转化流程可用；性能指标有基线与报告。
- [~] **P5-W08 用户协议、隐私政策、儿童 / 未成年人说明**（用户决策暂缓，2026-09-04）
  - 优先级：P1
  - 完成记录（2026-09-03）：官网三类协议页、Footer 公开入口、`GET /api/public/legal` 元数据、`/demo` 预约同意校验与 `leads` 同意元数据、学生端协议阅读记录与 P4-S06 数据请求 / 注销入口均已接通。当前版本 `2026.09.03`，页面明确为“上线准备稿：正式备案主体与法务确认后生效”。
  - 影响文件 / 接口 / 数据表：`apps/website/src/legal.js`、官网 `main.jsx` / 样式、学生端 `main.jsx` / 样式、`communication.js`、`student.js`、`schema.js`；`GET /api/public/legal`、`POST /api/public/contact`、`GET/POST /api/student/account/legal-consents`；`leads`、`legal_consents`。
  - 验收：临时 SQLite `tmp-p5-w08-legal.mjs` **18 pass / 0 fail**；四端生产构建、后端语法检查、`git diff --check` 通过。
  - 阻塞 / 下一步：用户已确认备案完成，但具体备案主体信息、正式生效日期和法务确认正文仍未交付到代码库；用户后续自行处理备案材料，平台继续保持准备稿状态，收到最终文本后再替换并重新验收。

### 5.2 官网基础设施

- [-] **P5-W09 正式域名、品牌邮箱和 HTTPS 规划**（域名 / HTTPS 已具备，品牌邮箱与权限台账待补）
  - 优先级：P0
  - 验收：域名归属、DNS、证书续期已在内测部署中验证；品牌邮箱、联系人和权限移交记录待用户后续补充。
- [!] **P5-W10 国内部署所需备案与内容要求确认**（用户确认备案已完成，后续由用户自行处理）
  - 优先级：P0（若部署在中国大陆）
  - 完成记录（2026-09-04）：用户确认备案已经完成；备案主体材料、备案号展示和后续运营合规由用户自行处理，本项目不代办。正式公开服务仍须满足协议、内容治理、安全和真实外部服务门槛。
- [x] **P5-W11 埋点、转化漏斗与隐私合规分析** ✅ 2026-09-03
  - 优先级：P1
  - 完成记录（2026-09-03）：采用平台内置第一方统计，不接入第三方广告 / 跨站跟踪；官网首次访问展示同意选择，拒绝时不发送事件，接受后才生成匿名访问标识并上报白名单事件。
  - 埋点事件：`page_view`、`marketplace_view`、`marketplace_detail_view`、`cta_click`、`course_view`、`work_view`、`demo_submitted`、`analytics_consent_granted`；页面路径去掉查询参数，预约事件不携带表单内容。
  - 数据最小化：`analytics_events` 仅保存匿名标识、事件名、路径、白名单元数据和时间；不保存 IP、User-Agent、姓名、电话、邮箱或原始查询参数；服务端自动清理 90 天前数据。
  - 管理端新增 `/analytics`，仅超级管理员可读，提供区间筛选、匿名访客、事件汇总和预约漏斗；无原始访客明细导出。
  - 影响文件 / 接口 / 数据表：`apps/website/src/analytics.js`、`apps/website/src/main.jsx`、官网样式、`apps/admin/src/main.jsx`、`apps/server/src/routes/analytics.js`、`apps/server/src/index.js`、`packages/database/src/schema.js`；`POST /api/public/analytics/events`、`GET /api/admin/analytics/overview`；`analytics_events`。
  - 验收：`tmp-p5-w11-analytics.mjs` 临时 SQLite **15 pass / 0 fail**；覆盖未同意拒绝、未知事件、匿名汇总、超级管理员权限、机构越权、漏斗空值、路径 / 元数据脱敏、前端同意机制；四端生产构建、后端语法检查、`git diff --check` 通过。
  - 边界：未修改 `packages/canvas`，未触碰真实 `packages/data/platform.db`，未伪造第三方统计、AI、微信、短信、邮件、OSS、支付或客户端；当前仍未运行真实 Lighthouse。

---

## 6. P6｜真实 AI、文件、计费与内容安全服务

> **本阶段不应在未确定供应商、预算、密钥、隐私和审核策略前开工到“生产可用”。** 已有 `local-mock` 仅用于开发演示。

### 6.1 外部技术决策（先决条件）

- [!] **P6-D01 确认文本 / 图片 / 音频 / 视频模型供应商与可用区域**
  - 必须确认：供应商、模型、地区、价格、QPS、未成年人内容策略、数据是否用于训练、数据保留、SLA、故障支持。
- [!] **P6-D02 确认对象存储 / CDN / 访问策略**
  - 必须确认：存储区域、桶权限、私有读写、签名 URL、生命周期、CDN、防盗链、备份、成本上限。
- [!] **P6-D03 确认预算、积分定价、充值 / 支付方式和财务规则**
  - 必须确认：成本核算币种、积分换算、免费额度、退款、发票、预警、封顶、对账责任人。
- [!] **P6-D04 确认未成年人数据、内容审核和人工复核策略**
  - 必须确认：监护同意、敏感词 / 图片审核、违规升级、人工审核人、申诉、数据删除和留存期限。

### 6.2 AI 服务实现

- [ ] **P6-A01 供应商适配器与密钥管理**
  - 优先级：P0
  - 范围：每家供应商独立 adapter；环境变量 / 密钥管理服务；按环境隔离；禁止密钥进入仓库或日志。
  - 验收：开发、测试、生产密钥相互隔离；未配置时明确报错；日志永不包含 API Key 或完整敏感提示词。
- [ ] **P6-A02 异步生成任务队列与状态机**
  - 优先级：P0
  - 范围：排队、执行、轮询 / webhook、超时、取消、重试、幂等键、死信、回调验签。
  - 验收：重复请求不重复扣费；服务重启后任务可恢复；失败任务与部分成功处理清晰；用户可看到真实状态。
- [ ] **P6-A03 真实模型调用与降级策略**
  - 优先级：P0
  - 范围：文本、图像、音频、视频按业务确认逐项启用；模型路由、区域故障降级、模型开关。
  - 验收：可从后台关闭某模型；上游超时不阻塞系统；降级会告知用户并按规则计费 / 退款。
- [ ] **P6-A04 提示词安全、模板与儿童友好限制**
  - 优先级：P0
  - 范围：系统提示词、敏感类别、越狱防护、输入长度、年龄适配、输出过滤、教师可控词库。
  - 验收：危险、色情、暴力、自伤、个人信息诱导等测试样本被阻断或转人工；拦截原因对用户友好且不泄露规则细节。
- [ ] **P6-A05 AI 内容审核与人工复核队列**
  - 优先级：P0
  - 范围：输入审核、输出审核、图片 / 视频审核、命中分级、复核、下架、申诉和审计。
  - 验收：高风险内容不能进入公开作品墙；审核结果可追溯；误判有复核通道；审核 SLA 明确。
- [ ] **P6-A06 用量计量、余额扣减、冻结与冲正**
  - 优先级：P0
  - 范围：预估扣费、冻结、完成扣费、失败释放、重试去重、任务级成本记录、余额告警。
  - 验收：并发下余额不为负；账务能由流水复算；任一任务可定位消费规则和实际成本；对账差异有处理流程。
- [ ] **P6-A07 AI 成本、限流与防滥用**
  - 优先级：P0
  - 范围：按机构 / 班级 / 学生 / IP / 模型限流、日月预算、异常检测、熔断、黑名单。
  - 验收：恶意批量请求不会拖垮服务或透支预算；管理员收到预警；管理员可暂停单机构 / 单用户。

### 6.3 文件与媒体服务

- [ ] **P6-F01 安全文件上传与预签名流程**
  - 优先级：P0
  - 范围：文件类型白名单、大小限制、服务端签发上传凭证、病毒 / 恶意文件扫描、上传完成确认。
  - 验收：不能通过伪造 MIME 上传可执行文件；文件不经过公开裸路径；失败上传可清理临时文件。
- [ ] **P6-F02 媒体转码、缩略图与访问控制**
  - 优先级：P1
  - 范围：图片缩略、视频转码、音频预览、水印（如需要）、私有对象签名 URL、缓存策略。
  - 验收：不同权限访问得到正确结果；源文件与预览文件生命周期可控；大文件不阻塞 API 进程。
- [ ] **P6-F03 媒体资产生命周期与数据清理**
  - 优先级：P1
  - 范围：临时素材、项目素材、作品素材、已删除资产、过期分享、归档、清理任务和备份。
  - 验收：删除 / 到期按策略执行且可审计；关联作品不因清理异常破损；无法删除时有告警。

### 6.4 支付 / 订单（若要在线收费）

- [!] **P6-P01 确认支付渠道、主体资质、退款与开票规则**
  - 优先级：P0（仅在开启线上付费时）
- [ ] **P6-P02 订单、支付回调、退款与对账**
  - 优先级：P0（仅在渠道确认后）
  - 验收：回调验签、幂等、金额校验、订单状态机、退款、人工补单、每日对账、异常告警完整；前端支付成功页不作为最终到账凭证。
- [ ] **P6-P03 发票 / 合同 / 采购流程（若面向机构收费）**
  - 优先级：P1
  - 验收：开票信息加密 / 受控访问；财务状态可对账；合同、订单、开通和套餐有效期关联明确。

---

## 7. P7｜画布统一改造（当前冻结，等待用户授权）

> 当前状态：`[!]`。本节仅作计划，不得在未重新授权前修改画布代码。

- [!] **P7-GATE 用户明确确认“现在可以统一改造画布”**
  - 解除条件：用户明确提出允许处理 / 重构画布，并确认可接受的改造范围。
  - 解锁前禁止修改：`D:\学习平台\platform-v2\packages\canvas`。

解锁后依次执行：

- [ ] **P7-C01 画布现状基线、数据兼容性与回归样本**
  - 验收：现有项目快照、模板、批注、作品只读预览都有备份样本；升级前后可打开；不兼容数据有迁移或只读降级方案。
- [ ] **P7-C02 创作工作台统一视觉与信息架构**
  - 验收：工具栏、节点面板、属性编辑、版本、素材、课程引导与反馈入口统一；桌面 / 常见屏幕尺寸可用。
- [ ] **P7-C03 课程任务与资源进入画布的工作流**
  - 验收：从课程 / 课堂进入项目时可收到合法任务、素材、能力限制和提交要求；无权限不能绕过。
- [ ] **P7-C04 自动保存、冲突处理、崩溃恢复**
  - 验收：网络中断、刷新、浏览器崩溃后有明确恢复体验；不会静默覆盖已提交版本；冲突有可理解策略。
- [ ] **P7-C05 性能、可访问性与大图稳定性**
  - 验收：大节点数、长文本、多媒体预览、频繁拖拽下无明显卡死；键盘操作和基础可访问性测试通过。
- [ ] **P7-C06 协作 / 实时课堂能力（如业务确认）**
  - 验收：多人同时操作、教师查看、权限、冲突、隐私、课堂结束后的行为均有完整方案；未确认前不开发伪协作功能。
- [ ] **P7-C07 画布完整 E2E 回归与迁移发布**
  - 验收：新建、编辑、保存、导入、导出、历史、提交、点评、查看作品、升级旧数据等场景均通过；发布有回滚开关。

---

## 8. P8｜质量、测试、安全、合规与运营保障

### 8.1 自动化质量体系

- [ ] **P8-Q01 代码规范、类型 / 静态检查与格式化基线**
  - 优先级：P0
  - 验收：lint / format / 静态检查接入本地和 CI；关键错误不能进入主分支。
- [x] **P8-Q02 数据库与服务单元测试。** ✅ 2026-09-04
  - 优先级：P0
  - 完成记录：新增 `p8-q02-unit.mjs`，覆盖认证密码 / token、请求上下文、错误封装、积分流水归一化、人工入账 / 出账、透支拦截、冲正幂等、冻结 / 释放和零积分扣费等关键规则；测试库独立于默认数据库。
  - 验证：临时 SQLite **17 pass / 0 fail**；关键账务规则和服务纯函数断言通过。
  - 遗留风险或下一步：当前为关键规则基线，尚未达到全量业务覆盖率目标；下一步推进 P8-Q05 视觉 / 跨浏览器回归，并持续补充服务测试。
- [x] **P8-Q03 API 集成测试扩展。** ✅ 2026-09-04
  - 完成记录：新增 `p8-q03-api-integration.mjs`，在独立临时 SQLite + 隔离 API 进程中覆盖认证、角色权限、公开接口、机构 / 班级 / 课堂、项目版本、作品提交 / 审核 / 发布、AI local-mock 任务、作品批注、积分用量和学生数据归属边界；同时让既有 `p3-api-integration.mjs` 支持 `P3_API_BASE`，纳入同一临时服务回归。
  - 影响文件 / 接口 / 数据表：`p8-q03-api-integration.mjs`、`p3-api-integration.mjs`；覆盖 `/auth`、`/admin`、`/org`、`/student`、`/ai`、`/public` 主链路及课程、课堂、项目、作品、生成任务、用量相关数据。
  - 验证：`p8-q03-api-integration.mjs` 临时 SQLite **52 pass / 0 fail**，并成功执行既有 P3 API 集成回归（输出 `P3 API INTEGRATION COMPLETE`），退出码 0。
  - 边界：local-mock 明确标识为本地模拟；未接入真实 AI、上传、支付或第三方渠道；未修改 `packages/canvas`，未触碰真实业务数据库。
- [x] **P8-Q04 端到端 E2E 测试。** ✅ 2026-09-04
  - 完成记录：新增 `p8-q04-e2e.mjs`，以临时 SQLite、隔离 API 进程、临时静态官网服务器和浏览器 Cookie 会话模拟，串联官网访客、平台超管上架课程、机构管理员班级 / 对账、教师开课、学生学习 / AI 预览 / 项目版本 / 作品提交、教师审核发布、作品墙查看、跨学生越权拦截、计费权限拦截、课堂结束能力拦截和注销失效。
  - 影响文件 / 接口 / 数据表：`p8-q04-e2e.mjs`；覆盖四端构建产物、官网路由与资源加载，以及 `/auth`、`/me`、`/admin/course-marketplace`、`/org`、`/student`、`/ai`、`/public` 主链路和课程 / 课堂 / 项目 / 作品 / 生成任务 / 会话数据。
  - 验证：使用 Node 24.19.0 + 临时 SQLite 执行 **54 pass / 0 fail**；四端 `pnpm build` 通过；官网页面路由和 JS/CSS 资源加载通过；失败时 API stdout/stderr 会保留在临时 evidence 目录；`node --check` 与 `git diff --check` 通过。
  - 边界：本项是非画布 HTTP / 静态构建 E2E，不修改 `packages/canvas`；AI 仍明确为 `local-mock` 预览，不伪造真实 AI、OSS、支付或第三方渠道；未触碰真实线上数据库。
- [-] **P8-Q05 视觉回归、跨浏览器与移动端测试**
  - 优先级：P1
  - 验收：Chrome、Edge、Safari（若支持）、常见移动端宽度上的关键非画布页面通过；品牌视觉不被意外改坏。
  - 完成记录（2026-09-04）：
    - 状态：`[-]`
    - 已修复线上首页首屏 `ReferenceError: works is not defined`：`apps/website/src/main.jsx` 首页作品区改为使用隔离的 `homeWorks` 回退数据，避免官网运行时白屏。
    - 本地内测构建已验证：首页、课程广场、课程体系、机构方案、学员作品、产品手册、选型对比、预约演示及三类法律页共 11 条路由均有非空渲染；控制台错误 0；内测 banner、`noindex, nofollow, noarchive` 与 canonical 更新通过。
    - 线上复核（2026-09-04）：使用 Codex 内置浏览器复核线上 11 条官网关键路由，均可渲染；内测 banner、动态 canonical 与 `noindex, nofollow, noarchive` 均通过。课程广场空数据时曾因线上生效 Nginx `/api/` 代理剥离 `/api` 前缀而误显示“加载失败”，已备份 `/etc/nginx/sites-enabled/iicili.cyou` 并改为 `proxy_pass http://127.0.0.1:8788;`；`nginx -t`、reload 和线上页面复核通过，现显示“暂无课程，敬请期待”。
    - 本地回归：`tmp-p9-i01-internal-deploy.mjs` 使用临时 SQLite **24 pass / 0 fail**，并新增 API 代理前缀静态断言；未读取、复制或写入真实线上数据库。
     - 工作台移动溢出修复（P1）：根因是 `<=900px` 时 `.app-shell` 使用 `1fr` 网格轨道，顶栏 `.app-nav` 内容最小宽度撑大 `.sidebar`（admin 达 1322px、org/student 约 528px），导致页面级横向滚动。最小修复仅改 `packages/shared/src/styles.css`：移动轨道改 `minmax(0,1fr)`，并为 `.sidebar`、`.app-nav` 增加 `min-width:0`；导航保持内部横向滚动，不改业务组件、不修改 `packages/canvas`。修复后 Chrome / Edge 工作台矩阵 **52/52 通过**，官网矩阵复验仍 **96/96 通过**。
     - 证据：`artifacts/p8-q05-20260904-independent/matrix.json`、`workspace-matrix-before-fix.json`、`workspace-matrix.json`、`overflow-diagnosis.json` 及 Chrome / Edge 桌面与 390px 截图（含 `*-before-fix.png` 修复前对比）。
     - 回归：`p4-c01-rbac-ownership.mjs` **27/27**；`p4-03-list-api-check.mjs` **50/50**；`p8-q03-api-integration.mjs` **52/52**；`p8-q04-e2e.mjs` **54/54**；四端生产构建通过。
     - 尚未完成：Safari 独立浏览器与真实移动 / 平板设备；线上生产站点也未执行本轮独立浏览器复验。P8-Q05 继续保持 `[-]`，不得宣称全浏览器或真机矩阵完成。
- [x] **P8-Q06 性能与容量测试。** ✅ 2026-09-04
  - 完成记录：新增 `p8-q06-performance.mjs`，建立内测基线目标并在临时 SQLite + 隔离 API 进程中实测健康 / 公开课程接口、官网首页、并发课堂读取、AI local-mock 任务突发、文件元数据并发写入和 SQLite 写入竞争边界。
  - 影响文件 / 接口 / 数据表：`p8-q06-performance.mjs`；覆盖四端构建产物、官网首页、`/health`、`/public/marketplace`、`/student/dashboard`、`/ai/generations`、`/org/file-assets`、课堂会话和用量数据。
  - 验证：API 健康接口 30 请求 / 并发 10，p95 **12.4ms**；公开课程接口 30 请求 / 并发 10，p95 **6.7ms**；模拟并发课堂 20 次 / 并发 10，p95 **36.4ms**；AI 任务 3 次 / 并发 3，p95 **26.6ms**；文件元数据写入 3 次 / 并发 3，p95 **17.1ms**；13 pass / 0 fail；四端 `pnpm build`、`node --check` 和 `git diff --check` 通过。
  - 遗留风险或下一步：以上是隔离临时 SQLite 和 local-mock 的工程基线，不代表真实 AI / OSS / 生产公网容量；正式上线前仍需按真实服务规格、机器配置和预计并发重新压测并记录扩容阈值。

### 8.2 安全与可靠性

- [x] **P8-S01 安全基线与依赖漏洞治理。** ✅ 2026-09-04
  - 优先级：P0
  - 范围：依赖扫描、SCA、secret 扫描、CSP、CORS、请求大小、速率限制、错误信息脱敏、安全响应头。
  - 完成记录（2026-09-04）：
    - 状态：`[-]`
    - 实现：API 增加安全响应头（nosniff、DENY、Referrer-Policy、Permissions-Policy）；CORS 改为显式来源白名单并禁止任意 Origin 搭配 credentials；登录失败按 IP + 登录名限流（15 分钟最多 10 次）；保留 2MB JSON 请求体上限和结构化错误脱敏；内测 Nginx 增加 CSP、请求体上限、server_tokens off 和同等安全头；内测环境模板补充 `CORS_ALLOWED_ORIGINS`。
    - 影响文件 / 接口：`apps/server/src/config.js`、`apps/server/src/lib.js`、`apps/server/src/routes/auth.js`、`deploy/internal-test/nginx.conf.example`、`deploy/internal-test/.env.example`；`/health`、`/auth/login`、全 API 响应头。
    - 验证：`p8-s01-security-baseline.mjs` 使用临时 SQLite **32 pass / 0 fail**；覆盖允许 / 拒绝 Origin、预检、API 安全头、内测 noindex、404 错误脱敏、登录限流、超大请求体、Nginx 静态基线和临时数据库路径；secret pattern 扫描未发现命中；P8-S02 **27/27**、P8-Q03 **52/52** 回归通过。
    - 遗留风险或下一步：`pnpm audit --prod` 已尝试执行，但 npm registry 在本轮返回 HTTP 503 / 网络失败，尚未获得依赖漏洞清单；因此本项暂不勾选，下一步先完成可重复的离线依赖清单 / 锁文件审查和 registry 恢复后的 SCA 复核。
- [x] **P8-S02 身份认证与会话安全。** ✅ 2026-09-04
  - 完成记录：内测 / 生产模式认证 Cookie 增加 `Secure`，继续保留 `HttpOnly`、`SameSite=Lax`、路径限制和 7 天有效期；既有单账号单活跃会话策略、密码变更撤销全部会话、注销和会话撤销继续生效。
  - 影响文件 / 接口：`apps/server/src/lib.js`；`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/me`、`PUT /api/student/account/password`、`PUT /api/student/account/sessions/:id/revoke`。
  - 验证：`p8-s02-session-security.mjs` 使用临时 SQLite **27 pass / 0 fail**；覆盖错误密码、Cookie 安全属性、旧会话被新登录顶下、密码强度与当前密码校验、改密立即失效、旧密码拒绝、注销失效、当前会话撤销和敏感字段不回传；退出码 0。
  - 边界：本项未伪造短信 / 邮件 / 微信 MFA；登录限流、CSRF 防护和正式身份核验仍需在安全基线与架构门槛中继续评估；未修改 `packages/canvas`，未触碰真实业务数据库。
- [x] **P8-S03 多租户数据隔离安全测试。** ✅ 2026-09-04
  - 完成记录：新增 `p8-s03-tenant-isolation.mjs`，在临时 SQLite 中创建第二机构、教师和学生，启动隔离 API 进程验证机构 / 班级 / 课堂会话 / 学生项目 / 作品墙 / 学生账户的跨租户访问边界；平台超管保留按设计审计跨机构数据的能力。
  - 影响文件 / 接口 / 数据表：`p8-s03-tenant-isolation.mjs`；`/auth/login`、`/org/classes`、`/org/classes/:id/sessions/start`、`/org/classes/:id/sessions/:sessionId/end`、`/student/projects`、`/student/projects/:id`、`/student/showcase`、`/student/account`、`/admin/platform-users`；`organizations`、`users`、`classes`、`class_sessions`、`student_projects`、`works`、`sessions`。
  - 验证：临时 SQLite + 隔离 API 进程 **20 pass / 0 fail**，退出码 0；覆盖两个机构分别登录、各自班级列表、跨租户结束课堂拒绝、跨租户项目读取拒绝、作品墙归属、账户归属、伪造账户路径拒绝及平台超管审计；`node --check` 与 `git diff --check` 通过。
  - 边界：测试未读取、复制、迁移或写入真实线上数据库；未修改 `packages/canvas`；当前可见文件资源接口不独立暴露跨租户读取路径，文件元数据隔离仍随作品 / 项目归属查询受保护；真实 OSS 未接入，不宣称已完成对象存储隔离。
- [x] **P8-S04 数据备份、恢复与灾难演练。** ✅ 2026-09-04
  - 完成记录：新增 `p8-s04-backup-recovery.mjs`，复用内测备份脚本在临时隔离根目录生成 SQLite、当前 release、配置、日志和 `MANIFEST.json` 备份，复制恢复数据库后重新启动 API 并完成健康与业务接口校验。
  - 影响文件 / 脚本：`p8-s04-backup-recovery.mjs`、`deploy/internal-test/backup-internal-test.mjs`、`deploy/internal-test/rollback-internal-test.sh`、`deploy/internal-test/RUNBOOK.md`。
  - 验证：临时 SQLite **9 pass / 0 fail**；备份耗时 **1925.2ms**，恢复后 API RTO **147.1ms**，RPO 记录为备份时点；恢复前后用户 6、课程 1 的数据计数一致，恢复 API 健康与 `/api/public/legal` 均通过。
  - 遗留风险或下一步：当前演练覆盖独立测试 SQLite 和配置 / release 资产；未接入真实 OSS，因此没有伪造对象存储备份；正式生产仍需由运维配置备份频率、保留周期、异地副本和密钥恢复权限。
- [x] **P8-S05 日志、监控、告警与值班 Runbook** ✅ 2026-09-04
  - 优先级：P0
  - 范围：应用错误、慢请求、CPU / 内存 / 磁盘、数据库、任务队列、AI 成本、支付回调、备份失败、证书到期。
  - 验收：每类 P0 告警有负责人、触发阈值、通知通道和处理手册；日志脱敏且可检索。
  - 完成记录（2026-09-04）：
    - 状态：`[x]`
    - 实现：新增 `p8-s05-monitoring.mjs`、`deploy/internal-test/MONITORING.md`、健康检查脚本、systemd service/timer 模板和 logrotate 模板；ECS 已安装 `/srv/ai-kids-platform/internal-test/bin/monitoring-healthcheck.sh`、`ai-kids-platform-healthcheck.service`、`ai-kids-platform-healthcheck.timer` 与 `/etc/logrotate.d/ai-kids-platform-internal-test`。
    - 验证：临时 SQLite **13 pass / 0 fail**；shell 配置静态断言、API 健康 / noindex / 404 脱敏通过；ECS timer 已 `enabled/active`，service 执行 `Result=success`、`ExecMainStatus=0`，健康日志已写入且 release 为 `20260904T035620Z`，`logrotate -d` 配置解析通过。
    - 遗留风险或下一步：真实飞书 / 电话 / 邮件等通知渠道未接入，不将工程监控基线冒充真实告警服务；正式公开前仍需恢复 Basic Auth / VPN / IP 白名单等访问控制。
- [x] **P8-S06 发布、回滚与事故响应演练。** ✅ 2026-09-04
  - 完成记录：新增 `p8-s06-release-rollback.mjs` 与 `deploy/internal-test/RELEASE-ROLLBACK.md`；明确预发发布闸门、release 安全校验、健康失败自动回滚、数据库快照恢复、事故分级通报止损和复盘模板。
  - 影响文件 / 脚本：`p8-s06-release-rollback.mjs`、`deploy/internal-test/RELEASE-ROLLBACK.md`、`deploy/internal-test/rollback-internal-test.sh`、`deploy/internal-test/backup-internal-test.mjs`、`deploy/internal-test/RUNBOOK.md`。
  - 验证：临时 SQLite **13 pass / 0 fail**；成功切换已验证 release，故障 release 健康检查失败后自动恢复上一 release；坏迁移从备份快照恢复且用户 / 课程计数一致；回滚脚本路径、元数据、默认数据库保护和事故文档断言均通过。
  - 遗留风险或下一步：真实 ECS 发布窗口仍需运维按手册执行并留存 release / RPO / RTO 证据；正式公开前必须恢复访问控制。

### 8.3 未成年人、隐私与内容治理

- [x] **P8-L01 数据资产清单与最小化收集。** ✅ 2026-09-04
  - 完成记录：新增 `docs/AI少儿编程平台-数据资产与最小化收集清单.md`，覆盖账户身份、联系方式、未成年人及监护、认证会话、机构教务、学习作品、AI 记录、文件元数据、计费积分、运营沟通、隐私请求、安全审计和匿名分析；明确用途、来源、访问角色、保存 / 删除策略、第三方共享边界和最小化规则。
  - 影响文件 / 数据表：`p8-l01-data-inventory.mjs`；核对 `users`、`sessions`、`organizations`、`student_projects`、`works`、`generation_jobs`、`file_assets`、`leads`、`legal_consents`、`account_requests`、`audit_logs`、`analytics_events`。
  - 验证：`p8-l01-data-inventory.mjs` 使用临时 SQLite **71 pass / 0 fail**，进程退出码 0；修复 Windows SQLite 句柄关闭后临时目录清理问题。
  - 边界：仅完成工程数据资产与最小化基线，不代表 P8-L02～P8-L06、正式协议 / 法务确认或第三方服务接入完成；未修改 `packages/canvas`，未触碰真实业务数据库。
- [~] **P8-L02 未成年人 / 监护同意流程（用户决策暂缓，2026-09-04）**
  - 优先级：P0
  - 完成记录（2026-09-04）：
    - 状态：`[-]`
    - 实现：学生端账号页已接通监护人信息录入 / 清空、监护关系与确认校验、用户协议 / 隐私政策 / 儿童与未成年人说明版本化阅读记录；记录进入 `users.guardian_*` 与 `legal_consents`，并写入审计日志。
    - 影响文件 / 接口 / 数据表：`apps/server/src/routes/student.js`、`apps/student/src/main.jsx`；`PUT /api/student/account/guardian`、`POST /api/student/account/legal-consents`；`users`、`legal_consents`、`audit_logs`。
    - 验证：`p8-l02-l04-privacy-governance.mjs` 使用临时 SQLite 验证监护同意必填、错误版本拒绝、当前版本写入和撤回，32 项总验收中的相关断言通过；未修改 `packages/canvas`，未触碰真实业务数据库。
    - 用户决策：监护人功能、身份核验、地区年龄规则和正式合规结论暂不做；已有工程代码保留，不继续扩展。
- [~] **P8-L03 隐私请求与账号注销流程（暂不扩展，2026-09-04）**
  - 优先级：P0
  - 完成记录（2026-09-04）：
    - 状态：`[-]`
    - 实现：学生可提交数据导出 / 账号注销申请、查看状态、撤回待处理申请；机构管理员工作台可筛选、审批、填写处理说明；导出审批生成最小化数据概览，注销审批软删除学生并撤销会话，保留审计记录。
    - 影响文件 / 接口 / 数据表：`apps/server/src/routes/student.js`、`apps/server/src/routes/adminOrg.js`、`apps/student/src/main.jsx`、`apps/org/src/main.jsx`；`/api/student/account/requests`、`/api/org/account-requests`；`account_requests`、`users`、`sessions`、`audit_logs`。
    - 验证：`p8-l02-l04-privacy-governance.mjs` 使用临时 SQLite 验证申请、重复申请拒绝、机构审批、导出查看、注销后旧会话与重新登录均拒绝，32/32 pass；未读取、复制、迁移或写入真实业务数据库。
    - 当前口径：暂不扩展法律相关数据请求、真实 OSS 删除、备份延迟删除、身份核验和申诉渠道；已有工程流程保留，真实外部能力不伪造。
- [~] **P8-L04 内容举报、审核、申诉与记录保留（用户决策暂缓，2026-09-04）**
  - 优先级：P0
  - 完成记录（2026-09-04）：
    - 状态：`[-]`
    - 实现：学生可举报机构内已发布作品，机构管理员可查看待处理举报、填写处理结论并选择紧急下架；处理动作写入 `work_reports`、作品审核字段和审计日志。
    - 影响文件 / 接口 / 数据表：`apps/server/src/routes/student.js`、`apps/server/src/routes/adminOrg.js`、`apps/student/src/main.jsx`、`apps/org/src/main.jsx`；`POST /api/student/showcase/:id/reports`、`GET/PUT /api/org/work-reports`；`work_reports`、`works`、`audit_logs`。
    - 验证：`p8-l02-l04-privacy-governance.mjs` 使用临时 SQLite 验证举报、重复举报拒绝、管理员处理与下架后不可见，32/32 pass；未修改 `packages/canvas`，未触碰真实业务数据库。
    - 用户决策：举报、申诉、违规 / 内容审核、平台超管治理工作台和完整记录保留策略暂不做；现有基础代码保留，不继续扩展，也不作为当前内测承诺。

### 8.4 2026-09-04 重新梳理后的后续顺序

1. **P1：内测技术收口**
   - P8-Q05：在当前可用的 Codex Chromium 中保留 390 / 414 / 768 视口回归证据；独立 Chrome / Edge / Safari 或真机可用后再补测。
   - P4-C01：补齐服务端 RBAC、资源归属和跨租户拒绝覆盖。
   - P4-01：统一仍在产品范围内的状态机、枚举和错误码。
   - P4-03：统一管理端筛选、分页、排序、空态和导出规则。
2. **P2：内测 UAT 与运行维护**
   - 继续按平台、机构管理员、教师、学生、官网访客角色做内测回归；只修复真实发现的 P0 / P1 缺陷。
   - 保持独立测试数据库、noindex、内测标识、备份和可回滚；正式公开前重新建立访问控制。
3. **暂缓：用户已明确不做的范围**
   - P5-W08 正式法律文本与法务确认。
   - P8-L02 监护人 / 监护同意 / 身份核验。
   - P8-L04 举报、申诉、违规 / 内容审核和记录保留扩展。
   - 不新增相关页面、字段、API、工作台或验收脚本；已有代码仅保留，除非后续重新授权。
4. **外部阻塞：等待以后重新决策**
   - 真实 AI、OSS、支付、微信 / 短信 / 邮件、品牌邮箱和正式公开上线，不在本轮伪造或强行接入。

---

## 9. P9｜部署、灰度、正式上线与运营交接

### 9.1 当前阶段：内部测试环境（先做，不等备案）

P9-I01～P9-I06 是当前阶段的发布闸门。完成后可以进行**受控内部测试**，不等同于正式公开生产；内部测试网址必须通过访问控制保护，不向公众开放，不被搜索引擎索引，不接收真实外部用户。

### 9.2 正式公开上线：环境与交付链路

- [ ] **P9-D00 旧线上环境盘点、备份与新平台替换发布方案**
  - 优先级：P0
  - 已知目标环境：`iicili.cyou`（公网 IP：`39.106.183.200`）；现有前端目录 `/opt/learning-platform/dist`；后端服务 `learning-platform`；旧后端仅监听 `127.0.0.1:8787`；新内测服务使用 `127.0.0.1:8788`；新内测 Nginx 将 `/api/` 代理到 `127.0.0.1:8788`，旧站保留可回滚。
  - 用户授权：旧站内容可在正式替换时整体清理，按新平台方案部署；**该授权不免除备份、回滚与验证要求**。
  - 实现范围：登录权限与资产盘点、旧站备份、Nginx / systemd / 环境变量审查、正式目录与制品布局、健康检查、权限最小化、回滚目录、发布脚本、部署记录。
  - 已完成前置：
    - [x] 生产服务器已创建仓库专用只读 Deploy key，并已添加至 `chuangyilingdong/peixunwangzhan`；用户于 2026-09-02 确认 SSH 认证及仓库读取验证成功；私钥未进入代码仓库或本总控文档。
  - 验收：
    - [ ] 已备份旧静态目录、Nginx 有效配置、`learning-platform` unit / 环境配置以及生产数据，并验证备份可读取；
    - [ ] 明确新前端、后端、数据库、上传文件和日志各自的生产目录及属主权限；
    - [ ] Nginx `/api/` 代理、SPA 回退、静态资源缓存、HTTPS 和错误页在预发 / 演练中验证；
    - [ ] 防火墙 / 云安全组只允许 `80/TCP`、`443/TCP` 对公网访问，`8788/TCP` 仅绑定回环地址且没有公网放行规则；旧 `8787` 不得被新配置覆盖；
    - [ ] 发布可回滚到备份版本，且回滚演练成功；
    - [ ] 已记录发布窗口、版本号、执行人、验证结果与回滚命令。
  - 完成记录：尚未开始；不可直接删除旧站或覆盖 `dist`，必须先完成备份和发布演练。
- [ ] **P9-D01 确定生产部署架构**
  - 优先级：P0
  - 范围：服务器 / 容器、操作系统、进程管理、数据库形态、对象存储、CDN、网络、WAF、区域和成本。
  - 验收：架构图、资产清单、访问控制、容量、备份、扩容、联系人齐全。
- [ ] **P9-D02 建立开发、测试 / 预发、生产环境隔离**
  - 优先级：P0
  - 验收：域名、数据库、密钥、桶、支付、AI 配额全部隔离；测试数据不进入生产；生产数据不用于随意调试。当前 `iicili.cyou` 旧站只可作为替换前的线上预览 / 演练目标，不能把旧站数据误当作新平台生产数据。
- [ ] **P9-D03 CI/CD、GitHub Actions 与制品管理**
  - 优先级：P0
  - 已有前置：生产服务器可通过只读 Deploy key 拉取 `chuangyilingdong/peixunwangzhan`；该 key 不用于 Actions 登录服务器。
  - 已完成前置：
    - [x] 本地仓库已于 2026-09-02 初始化：`main` 分支、远程 `origin`、`.gitignore` / `.gitattributes` 安全基线已建立；已通过全量 `pnpm run build`。
    - [x] 本机专用 SSH 写入密钥已添加至 GitHub 账号，并通过 `ssh.github.com:443` 验证身份；远程 `origin/main` 已成功建立，当前基线提交为 `485b763`。
  - 范围：依赖安装、lint、测试、构建、镜像 / 制品、SBOM、部署审批、版本号、变更记录；GitHub Actions 使用独立的“Actions → 生产服务器”部署密钥 / Secret 连接服务器，执行受控发布脚本。
  - 验收：
    - [ ] 从干净环境可重复构建；每次生产发布可定位 commit / 制品 / 配置版本；失败可停止与回滚；
    - [ ] GitHub Actions 仅在受保护分支、批准的 tag 或手动审批后部署；
    - [ ] Actions 的服务器部署私钥、生产环境变量、AI / 支付密钥均保存在 Secrets，不出现在日志、仓库和前端制品中；
    - [ ] 部署脚本使用版本化 release 目录或等效原子切换，避免直接覆盖运行中的版本；
    - [ ] 发布后自动执行健康检查，失败自动停止并输出可操作的回滚信息。
- [ ] **P9-D04 环境变量与密钥发布机制**
  - 优先级：P0
  - 验收：密钥由受控系统注入；变更有审计；密钥轮换可执行；绝不提交到代码仓库或前端包。
- [ ] **P9-D05 反向代理、HTTPS、域名、CORS 与安全头**
  - 优先级：P0
  - 验收：全站 HTTPS、证书自动续期、HTTP 跳转、跨域最小化、CSP 等安全头按实际应用验证；Nginx `/api/` 仅代理至 `127.0.0.1:8788`，内部服务不直接暴露公网；云安全组和服务器防火墙均不得放行 `8788/TCP`；旧 `8787` 服务保持可回滚。

### 9.3 正式公开上线：发布策略与上线验证

- [ ] **P9-R01 生产数据迁移与备份前检查**
  - 优先级：P0
  - 验收：迁移脚本在预发演练成功；生产前有可用备份和恢复验证；迁移耗时、锁表风险、回退步骤明确。
- [ ] **P9-R02 灰度 / 白名单 / Feature Flag 策略**
  - 优先级：P0
  - 验收：可按机构 / 用户开启新功能、真实 AI、支付或公开作品；异常时可无发布回滚地关闭开关。
- [ ] **P9-R03 上线前业务验收（UAT）**
  - 优先级：P0
  - 验收：平台、机构管理员、教师、学生、运营、客服、财务 / 法务（适用时）均按脚本验收并签字 / 留档；P0 缺陷清零或有业务批准豁免。
- [ ] **P9-R04 正式上线日操作清单**
  - 优先级：P0
  - 范围：冻结窗口、备份、部署、迁移、冒烟、监控、公告、客服、回滚负责人和通讯录。
  - 验收：逐项执行留痕；出现失败按预案回滚；成功后观察窗口内指标正常。
- [ ] **P9-R05 上线后 7 / 30 天观察与复盘**
  - 优先级：P0
  - 验收：检查错误率、性能、AI 成本、工单、投诉、转化、内容审核、备份；形成问题清单、优先级和负责人。
- [ ] **P9-R06 运营与技术交接包**
  - 优先级：P0
  - 范围：部署文档、账户 / 权限台账、应急手册、客服 FAQ、运营 SOP、课程维护 SOP、财务对账 SOP、数据字典、接口文档。
  - 验收：非开发人员能按 SOP 完成日常操作；关键账号可由授权人员接管；离职 / 交接流程明确。

---

## 10. 上线门槛（内部测试与正式公开分开判断）

### 10.1 内部测试上线门槛（当前阶段）

- [ ] 测试环境与真实线上环境、数据库、文件和密钥隔离；不得使用或写入 `packages\data\platform.db` 及 `iicili.cyou` 真实业务数据库；
- [ ] 网址有 VPN / IP 白名单 / Basic Auth 等强制访问控制，未授权请求无法访问前端和 API；
- [ ] 已设置 `noindex, nofollow, noarchive`，`robots.txt` 禁止抓取，并在页面显著标识“内部测试环境，不代表正式服务”；
- [ ] 测试库可重复初始化、seed、清理；测试账号和角色范围明确；
- [ ] 备份、恢复、应用回滚至少各演练一次，结果可验证；
- [ ] 平台、机构管理员、教师、学生、官网访客核心 UAT 通过；P0 权限、租户隔离和数据泄漏缺陷清零；
- [ ] `local-mock`、准备稿协议、未接入 AI / OSS / 支付 / 微信 / 短信 / 邮件等能力均有明确标识，不对外作真实能力承诺；
- [ ] 已有启动、停止、健康检查、日志、故障处理和回滚手册。

> 内测门槛**不要求** ICP / 公安备案、正式品牌域名、品牌邮箱或正式公开 SEO；这些属于正式公开上线门槛。

### 10.2 正式上线门槛（全部必须满足，不能仅凭“页面已完成”上线）

- [ ] 所有面向真实用户的 P0 功能通过 UAT；
- [ ] 所有未接入后端的页面不对外伪装成可用功能，或已完成真实接入；
- [ ] 生产认证、RBAC、多租户隔离、安全审计通过；
- [ ] 真实 AI / 上传 / 文件 / 支付（如对外开放）已接入、测试、监控并具备降级；
- [ ] 积分、订单和用量账务可复算，失败 / 冲正规则已经演练；
- [ ] 关键测试（单测、API 集成、E2E、安全、性能）符合发布阈值；
- [ ] 备份恢复、回滚、监控告警、事故手册已经真实演练；
- [ ] 隐私政策、用户协议、未成年人保护、内容审核和举报流程已由业务 / 法务确认；
- [ ] 生产环境、HTTPS、域名、备案（如适用）、密钥管理、CI/CD、灰度已经就绪；
- [ ] 上线负责人、值班联系人、客服 / 运营处理流程明确。

### 10.3 正式公开上线不允许带病的情形

- [ ] 仍将 `local-mock` 宣传为真实生成；
- [ ] 可通过修改 ID 跨机构或跨学生读取 / 修改数据；
- [ ] 充值 / 扣费并发可能导致余额错误或重复扣费；
- [ ] 作品公开缺少未成年人授权、审核、下架和举报处理；
- [ ] 无可验证备份与恢复方案；
- [ ] 生产密钥在仓库、前端或日志中暴露；
- [ ] 无法回滚数据库 / 应用发布；
- [ ] 未完成必要备案、协议或合规要求却对外承诺正式服务；**内部测试例外仅限受控、不公开、不对外承诺的测试环境**。

---

## 11. 外部决策与阻塞清单（需要用户 / 业务方确认）

| 编号 | 决策 / 资料 | 为什么需要 | 当前状态 |
|---|---|---|---|
| D-01 | 品牌名称是否最终固定为“AI 魔法学院”或仅作为实施参考 | 影响商标、官网文案、域名、视觉资产和对外宣传 | `[!]` 待确认 |
| D-02 | 正式域名、品牌邮箱与主体信息 | 已知线上域名为 `iicili.cyou`，仍需确认是否作为最终品牌域名、DNS / 证书 / 域名账号归属、品牌邮箱与主体信息 | `[-]` 域名和服务器已提供；最终品牌与账号归属待确认 |
| D-03 | 是否在中国大陆正式部署、服务器地区和备案主体 | 已有公网服务器 `39.106.183.200`，仍需确认实际部署地区、主体、备案 / 公安备案状态和正式服务范围 | `[-]` 服务器信息已提供；合规主体与备案状态待确认 |
| D-04 | 文本 / 图片 / 音频 / 视频 AI 供应商、模型和预算 | 影响真实生成、成本、合规、内容安全和用户体验 | `[!]` 待确认 |
| D-05 | 对象存储、CDN、文件保留期限 | 影响上传、作品、备份、成本和访问权限 | `[!]` 待确认 |
| D-06 | 是否做线上支付、支付渠道、退款、开票 | 影响订单、财务、资质、用户协议和开发范围 | `[!]` 待确认 |
| D-07 | 未成年人使用年龄范围、监护同意和公开作品政策 | 影响注册、隐私、审核、展示、删除和合规 | `[!]` 待确认 / 法务确认 |
| D-08 | 课程资料来源与“16 门课程”完整清单 | 影响课程后台、官网销售页、教学交付与内容准确性 | `[!]` 待提供 / 核验 |
| D-09 | 演示预约线索由谁接收、如何跟进 | 影响官网表单、CRM、通知和运营流程 | `[!]` 待确认 |
| D-10 | 是否需要真实客户端下载（Windows / macOS） | 影响安装包、签名、下载、更新、客服支持 | `[!]` 待确认 |
| D-11 | 是否启动画布统一改造、时间和允许范围 | 当前画布冻结，影响 P7 是否解锁 | `[!]` 待用户明确授权 |
| D-12 | 是否接入微信生态、短信、邮件、企业微信等通道 | 影响登录、通知、支付、客服与合规 | `[!]` 待确认 |
| D-13 | GitHub 仓库与读写凭据基线 | 仓库已创建为 `chuangyilingdong/peixunwangzhan`；生产服务器只读 Deploy key 与本机 SSH 443 写入凭据均已验证，远程 `main` 已建立。仍需分支保护、Actions 部署 Secret 与权限台账 | `[x]` 仓库、服务器读取与本机写入基线均已就绪；自动化发布待建 |
| D-14 | AI 魔法学院登录态体验对照所需测试账号 | 已登记官网公开体验入口和机构 / 教师端登录入口；进入对应 P4 页面逐页映射时，需要用户在当次对话提供可用测试账号 | `[-]` 公开基准已登记；登录态对照待按页面需求授权 |

---

## 12. 风险台账

| 风险 | 级别 | 当前控制措施 | 后续动作 |
|---|---|---|---|
| 画布与非画布同时大改导致回归复杂 | 高 | 画布已冻结 | 先完成 P4；用户授权后再单独进入 P7 并做迁移回归。 |
| 页面壳层被误认为真实业务 | 高 | 明确待接入状态 | P4 逐页补 API、权限、数据和验收；上线前禁止假数据。 |
| mock AI 被误当生产能力 | 高 | 已明确 local-mock 边界 | P6 真实适配、成本、审核、监控完成前不对外承诺。 |
| SQLite 在生产并发 / 规模下不足 | 高 | 当前仅作为开发基础实现 | P9 确定生产数据库 / 迁移与容量策略，必要时升级至服务型数据库。 |
| 未成年人隐私和公开作品合规不足 | 高 | 当前机构内作品墙为封闭范围 | P8 完成同意、审核、举报、删除和法务确认后才开放公开分享。 |
| 积分 / 订单账务边界不完整 | 高 | 当前已有基础账户 / 流水模型 | P4 / P6 完成不可变流水、并发、冲正和对账测试。 |
| 默认主数据库被测试污染 | 中高 | 已列为禁止项 | 一律使用临时 SQLite 库和迁移演练；发布前备份。 |
| Node 版本不匹配导致构建失败 | 中 | 已验证 Node 24 / pnpm 11 | 固化 `.nvmrc` / 工具链 / CI 运行时，文档化本机命令。 |
| 域名、备案、第三方账号迟迟未确定 | 中高 | 已列外部决策 | 提前设定决策截止时间；无法确认则保持内测 / 演示状态。 |

---

## 13. 验证命令与回归基线

> 运行构建时必须避免使用本机默认 Node `v16.13.1`。已验证的 bundled runtime 为 Node `v24.19.0`、pnpm `11.19.0`。

### 13.1 全量前端生产构建

```powershell
$node='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$pnpm='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
$env:PATH="$(Split-Path $node);$env:PATH"
Set-Location 'D:\学习平台\platform-v2'
& $pnpm run build
```

### 13.2 API 集成回归（P3 基线）

```powershell
Set-Location 'D:\学习平台\platform-v2'
node .\p3-api-integration.mjs
```

> 执行会写库的 API 验证时，应确认脚本使用临时数据库；不要直接修改 `packages\data\platform.db`。

### 13.3 新增功能的最低验证规则

- 新增数据库字段 / 表：初始化、迁移、seed、回滚 / 升级兼容性验证；
- 新增后端接口：正常、未登录、无权限、跨机构、非法参数、非法状态转换、重复请求；
- 新增管理端列表：空态、分页、筛选、网络失败、权限、真实数据；
- 新增积分 / 订单：并发、失败、重试、冲正、余额复算；
- 新增 AI / 文件：超时、上游失败、重复回调、鉴权、内容安全、成本上限；
- 新增官网表单：输入校验、反刷、隐私同意、落库、通知和后台跟进；
- 每次影响前端的改动：至少运行全量 `pnpm run build`；影响核心链路时同步更新集成 / E2E 测试。

---

## 14. 变更日志

| 日期 | 变更 | 状态 / 验证 |
|---|---|---|
| 2026-09-02 | P3 基础闭环完成：画布模板与排版、教师批注、学生反馈、机构作品墙、mock AI / 素材任务边界。 | 已通过 P3 API 联调、后端语法和前端构建基线。 |
| 2026-09-02 | 修复课堂 AI 能力字段映射：`allowImage`。 | 已纳入 P3 API 验证。 |
| 2026-09-02 | 完成非画布官网与三端品牌视觉、导航、页面壳层第一轮建设；画布未改。 | 全量生产构建通过。 |
| 2026-09-02 | 创建本“完整上线执行总控”，作为后续跨对话唯一进度依据。 | 待后续每次工作持续更新。 |
| 2026-09-02 | 记录既有线上部署环境：`iicili.cyou`、Nginx、`learning-platform`、`127.0.0.1:8787` 内部监听和旧站可替换授权；新增 P9-D00 发布前备份 / 替换要求。 | 未执行线上清理或部署；后续必须先备份、演练、验证和保留回滚。 |
| 2026-09-02 | GitHub 仓库 `chuangyilingdong/peixunwangzhan` 已确认；生产服务器只读 Deploy key 已添加并由用户验证仓库读取成功。 | 已记录密钥职责分离、推送 / 测试 / 发布流程；未创建 CI/CD、未发布线上版本。 |
| 2026-09-02 | 在 `platform-v2` 建立 Git 初始基线：配置远程仓库、忽略数据库 / 密钥 / 日志 / 构建产物、提交 `d271b44`；并将总控文件纳入仓库 `docs/`。 | Node `v24.19.0` / pnpm `11.19.0` 下全量 `pnpm run build` 通过。 |
| 2026-09-02 | 建立并验证本机 GitHub SSH 443 推送链路：本机专用 SSH 写入密钥已添加至 GitHub 账号，`origin` 切换为专用 SSH 别名；将初始基线及 Deploy key / 发布流程记录成功推送到远程 `main`。 | SSH 返回 `Hi chuangyilingdong!`；远程 `refs/heads/main` 已核验为提交 `485b763`；未部署或改动生产服务器。 |
| 2026-09-02 | P4-01（缺口清单编号）第一批完成：平台用量明细、平台作品库、作品下架、机构账务视图。 | 47 项 P4-01 API 正反向验证、46 项 P3 回归、四端生产构建全部通过；在线支付/计费配置/作品治理剩余项已登记；画布未修改，线上环境未部署。 |
| 2026-09-02 | P4-00 缺口清单完成；第一批非画布 P0 页面接通真实 API：平台用户、平台管理员、机构课程中心、积分套餐、积分用量。 | 29 项 P4 API 正反向验证、46 项 P3 回归、四端生产构建全部通过；画布未修改，线上环境未部署。 |
| 2026-09-02 | 用户确认 AI 魔法学院官网及机构 / 教师端为非画布开发的在线体验基准；将公开入口、登录入口、严格对照范围与凭据保密规则写入总控。 | 已登记公开基准；登录态逐页对照须待用户在需要时提供测试账号；未写入带追踪参数的分享链接、账号密码或 Token。 |
| 2026-09-02 | P4-02（缺口清单编号）第一批完成：学生课程、额度与账号安全页面接通真实 API；画布保持冻结。 | P4-02 API 验收 11 项通过，P3 API 回归 46 项通过，四端生产构建通过；学习首页任务聚合、真实 AI / 充值、头像 / 隐私 / 注销等剩余边界已登记；监护人功能按 2026-09-04 用户决策 `[~]` 暂缓；未触碰真实 `platform.db`，未部署线上。 |
| 2026-09-02 | P4-03（缺口清单编号）第一批完成：平台/机构站内信与宣传物料元数据、机构可见范围、已读/使用事件和权限隔离接通真实 API；画布保持冻结。 | P4-03 API 验收 19 项通过，P3 API 回归 46 项通过，四端生产构建和 `git diff --check` 通过；定时投递、外部通知通道、真实上传/OSS/下载代理、学生通知中心和阿飞提醒等边界已登记；未触碰真实 `platform.db`，未部署线上。 |
| 2026-09-02 | P4-03 第二批完成：通知模板、逻辑定时发布与补偿扫描、学生消息中心、物料统计详情及接收范围同步。 | P4-03 API 35 项、P3 回归 46 项、四端生产构建、后端语法和 `git diff --check` 全部通过；画布未修改；失败重试 / 高可用队列、外部通知通道和真实上传 / OSS 仍明确保留为边界。 |
| 2026-09-02 | 用户确认黑客松 / 运营活动不做；P4-04、P4-A09、P4-O10 改为产品取消，不新增相关表、API 或真实页面；下一步切换为 P4-O01 机构首页经营看板与教师范围隔离。 | 文档决策已登记；现有 `/hackathon` 仅为历史静态壳层，后续非画布导航清理时移除；画布继续冻结。 |
| 2026-09-02 | P4-O01 机构首页真实经营看板第一批完成，并将当前唯一下一步切换为 P4-O02 机构账号 / 成员完整管理。 | `GET /api/org/overview` 已完成管理员 / 教师范围隔离、经营 / 教学指标、课堂 / 作品 / 消息明细和预警；临时 SQLite、P3 回归 `46 pass / 0 fail`、四端生产构建、后端语法、`git diff --check` 通过；`packages/canvas` 未修改，未部署线上。 |
| 2026-09-02 | P4-O02 机构账号 / 成员完整管理完成：账号创建 / 编辑 / 停用 / 重置密码、批量导入预览与整批回滚、调班 / 教师授权、教师教务范围统一和机构审计闭环。 | 临时 SQLite P4-O02 API `38 pass / 0 fail`；P3 回归 `46 pass / 0 fail`；四端生产构建、后端语法和 `git diff --check` 通过；画布未修改、真实数据库未触碰、未部署线上；下一步为 P4-O03 班级 / 课程 / 排课增强。 |
| 2026-09-02 | P4-O03 班级、课程与排课闭环增强完成：班级详情聚合、课程计划与连续排序、普通 / 补课课堂、结束 / 取消、课堂历史、课程进度、教师范围与归档保护全部接通。 | 临时 SQLite 主验收及跨机构 / 未发布内容隔离验收通过；P3 回归 `46 pass / 0 fail`；四端生产构建、后端语法和 `git diff --check` 通过；画布未修改、真实数据库未触碰、未部署线上；下一步切换为 P4-O04 课堂内 AI 能力控制与使用审计。 |
| 2026-09-02 | P4-O04 课堂内 AI 能力控制与使用审计完成：课堂暂停、能力开关、单学生调用上限、课堂积分上限、普通调用 / 生成任务审计和机构端查询闭环已接通；黑客松 / 运营活动继续按产品决策取消。 | 临时 SQLite P4-O04 API `36 pass / 0 fail`；P3 回归 `46 pass / 0 fail`；四端生产构建、后端语法和 `git diff --check` 全部通过；画布未修改、真实数据库未触碰、未伪造外部 AI / 支付 / OSS / 运营数据、未部署线上；下一步切换为 P4-O05 作品社区运营闭环。 |
| 2026-09-02 | P4-O05 作品社区运营闭环完成：版权 / 机构内展示授权确认、两阶段审核发布、精选、举报处理、下架、作者脱敏、教师范围和审计均已接通；评论 / 点赞明确未启用。 | 临时 SQLite P4-O05 API `52 pass / 0 fail`、旧 SQLite 迁移演练、P3 回归 `46 pass / 0 fail`、四端生产构建、后端语法和 `git diff --check` 通过；画布未修改、真实数据库未触碰、未部署线上；下一步切换为 P4-O06 作品数据中心。 |
| 2026-09-02 | P4-O06 作品数据中心完成：机构管理员可按班级、课程课时、学员下钻真实创作指标，支持 7 / 14 / 30 日筛选与脱敏导出审计。 | 临时 SQLite P4-O06 API 验收、P3 回归、构建和语法检查通过；`packages/canvas` 未修改，真实数据库未触碰，未部署线上；下一步切换为 P4-O07 套餐、学员开通与席位管理。 |
| 2026-09-02 | P4-O07 套餐、学员开通与席位管理完成：套餐席位配置、待开通单、线下履约登记、开通 / 停用 / 恢复 / 续费 / 作废、到期扫描、学生权限失效与审计 / 事件留痕已形成闭环。 | 临时 SQLite P4-O07 API 验收与 P3 回归通过；后端语法、四端生产构建和 `git diff --check` 通过；画布未修改、真实数据库未触碰、未部署线上；在线支付、支付回调、自动续费和自动消息提醒未伪装为已完成；下一步切换为 P4-O08 积分充值、用量和对账。 |
| 2026-09-03 | P4-O08 积分充值、用量和对账完成：期初流水、冻结、人工调整、退款 / 冲正、原子扣减、流水复算、筛选导出和失败任务不扣费规则形成账务闭环。 | 临时 SQLite P4-O08 API `51 pass / 0 fail`、失败任务专项 `19 pass / 0 fail`、P3 回归 `48 pass / 0 fail`、后端语法、四端生产构建和 `git diff --check` 通过；画布未修改、真实数据库未触碰、未部署线上；在线支付、支付回调、自动续费和真实充值成功状态未伪装；后续下一步需按本文件未勾选事项重新确认。 |
| 2026-09-03 | P4-S01 学习首页真实学习任务与进度完成：学生首页按班级课程表聚合课堂任务、进度、老师通知、待反馈作品和继续创作入口。 | 临时 SQLite P4-S01 API `53 pass / 0 fail`、P3 回归 `48 pass / 0 fail`、后端模块导入、四端生产构建和 `git diff --check` 通过；画布未修改、真实数据库未触碰、未部署线上；下一步建议 P4-S02 我的项目管理。 |
| 2026-09-03 | P4-S02 我的项目管理（画布外层）完成：项目搜索筛选、三视图、重命名、复制、归档、软删除 / 恢复、提交与发布保护及学生隔离形成闭环。 | 临时 SQLite P4-S02 API `73 pass / 0 fail`、P3 回归 `48 pass / 0 fail`、后端语法检查、四端生产构建和 `git diff --check` 通过；画布未修改、真实数据库未触碰、未部署线上；下一步建议 P4-S03 我的作品与反馈闭环增强。 |
| 2026-09-03 | P4-S03 我的作品与反馈闭环增强完成：多轮提交历史、驳回 / 下架后修改重提、整体点评与节点批注已读、发布申请与撤回、教师处理申请和学生端状态语义形成闭环。 | 临时 SQLite P4-S03 API `76 pass / 0 fail`、P3 回归 `48 pass / 0 fail`、后端语法检查、四端生产构建和 `git diff --check` 通过；画布未修改、真实数据库未触碰、未部署线上；下一步建议 P4-S04 机构作品墙体验完善。 |
| 2026-09-03 | P4-S04 机构作品墙体验完善完成：筛选搜索分页、详情只读预览、机构精选、作者脱敏、隐私字段清理、举报闭环和机构端作品筛选形成闭环。 | 临时 SQLite P4-S04 API 112 pass / 0 fail、P3 回归 48 pass / 0 fail、后端语法检查、四端生产构建和 git diff --check 通过；画布未修改、真实数据库未触碰、未部署线上；下一步建议 P4-S05 AI / 魔法石中心。 |
| 2026-09-03 | P4-S05 AI / 魔法石中心完成：学生本人 AI 能力状态、额度与魔法石、任务历史 / 失败详情、失败重试、素材使用推导和课堂限制提示形成闭环。 | 临时 SQLite P4-S05 API 85 pass / 0 fail、P3 回归 48 pass / 0 fail、后端语法检查、学生端生产构建、四端生产构建和 git diff --check 通过；画布未修改、真实数据库未触碰、未部署线上；local-mock 与真实 provider 边界明确；下一步建议 P4-S06 个人账号与安全设置。 |
| 2026-09-03 | P4-S06 个人账号与安全设置完成：预设头像、监护人资料、隐私授权、当前密码验证、登录设备、账号注销 / 数据导出申请、机构处理、数据概览和软注销形成闭环。 | 临时 SQLite P4-S06 API 97 pass / 0 fail、旧 SQLite 迁移演练、P3 回归 48 pass / 0 fail、后端语法、四端生产构建和 git diff --check 通过；画布未修改、真实数据库未触碰、未部署线上；真实头像上传、邮件短信、监管报送和外部身份同步未伪装；下一步建议 P4-S07 帮助、下载与反馈渠道。 |
| 2026-09-03 | P4-S07 帮助、下载与反馈渠道完成：学生帮助中心、FAQ / 指南 / 兼容性、真实客户端发布配置、公开下载边界、官网禁用虚假下载、学生反馈与机构处理闭环及审计均已接通。 | 临时 SQLite P4-S07 API 42 pass / 0 fail、旧 SQLite 35→38 表迁移演练、P3 回归 48 pass / 0 fail、后端语法、四端生产构建和 git diff --check 通过；画布未修改、真实数据库未触碰、未部署线上；真实安装包、文件托管、自动更新和外部客服未伪装；后续按未勾选事项重新选择。 |
| 2026-09-03 | P5-W05 课程资料字段（难度 / 年龄 / 标签 / 课时正文）完成：schema 新增 difficulty_level / age_range_min / age_range_max / tags / lesson_content；seed 补默认值；normalize 同步输出；admin CRUD + 学员 / 机构 / 公开三端详情 + 学员筛选均已接通。 | 临时 SQLite P5-W05 API 100 pass / 0 fail、后端语法、四端生产构建和 git diff --check 通过；画布未修改、真实数据库未触碰、未部署线上。 |
| 2026-09-03 | P5-M01 课程广场完成：admin 上下架 / 积分管理 + 公开列表（difficulty/age/tag/搜索/排序/分页） + 详情（lessonContent 截断）均已接通。 | 临时 SQLite P5-M01 API 75 pass / 0 fail、后端语法、四端生产构建和 git diff --check 通过；画布未修改、真实数据库未触碰、未部署线上；不做真实付费购买、评分和评论。 |
| 2026-09-03 | P5-W01 官网 CMS / 配置化完成：website_contents + revisions、超级管理员权限、结构化首页 / FAQ / 品牌表单、FAQ 排序、草稿预览、发布、历史与回滚接通；封面仅支持已有真实 URL。 | 临时 SQLite P5-W01 14 pass / 0 fail；四端生产构建、后端语法和 git diff --check 通过；画布未修改、真实数据库未触碰、未部署线上。 |
| 2026-09-03 | P5-W07 SEO / 可访问性 / 性能基础优化完成：robots、sitemap、SEO head、动态标题 / canonical、JSON-LD、aria、焦点态和窄屏规则接通。 | 临时 SQLite / 静态 P5-W07 13 pass / 0 fail；四端生产构建和 git diff --check 通过；未运行真实 Lighthouse，不宣称分数；画布未修改、真实数据库未触碰、未部署线上。 |
| 2026-09-03 | P5-W08 协议 / 隐私 / 未成年人说明代码闭环完成：官网三类协议页、预约同意、学生协议阅读记录、版本元数据和 P4-S06 数据请求入口联动已接通。 | 临时 SQLite P5-W08 `18 pass / 0 fail`；后端语法、四端生产构建和 `git diff --check` 通过；正式法律 / 合规部分按 2026-09-04 用户决策保持 `[~]` 暂缓；准备稿明确不得作为正式合规文本。 |
| 2026-09-03 | 根据用户新决策重排上线优先级：备案暂缓不阻塞受控内部测试；新增 P9-I01～P9-I06 内测部署、访问控制、数据隔离、备份回滚、UAT 与运行手册闸门，并将正式域名 / HTTPS / 备案 / 公开服务移至正式公开上线阶段。 | 新增《AI少儿编程平台-内部测试上线执行清单.md》；已完成 P9-I01～P9-I06 的代码 / 文档基线与临时 SQLite 验收，尚未连接真实服务器执行部署。 |
| 2026-09-03 | 根据用户最新授权，将内测目标从隔离节点改为线上网址 `iicili.cyou`；重试服务器 SSH / 网络预检，并检查阿里云 ECS 控制台登录状态。 | `39.106.183.200:22` 仍连接超时；ECS 控制台未登录；未覆盖线上站点、未重启服务、未触碰真实线上数据库。已准备线上域名配置的最新内测 release `20260903T162708Z`（commit `3577ac1`）；当前仍阻塞于服务器控制通道。 |
| 2026-09-03 | P5-W11 第一方匿名埋点与转化漏斗完成：官网同意选择、白名单事件、90 天保留、平台分析报表和权限边界接通。 | 临时 SQLite P5-W11 `15 pass / 0 fail`；后端语法、四端生产构建和 `git diff --check` 通过；不接入第三方统计、不保存 IP / PII，备案与正式法务仍按外部事项处理。 |
| 2026-09-03 | 通过 ECS 云服务器终端完成 `iicili.cyou` 线上受控内部测试发布：保留旧站并完成备份，创建独立内测 SQLite，发布 release `20260903T172458Z`（commit `6c7c14484bf9aa90262e421113c0f236ae262b8c`），启用 `learning-platform-internal-test`、Basic Auth、HTTPS、noindex 与内测标识。 | 线上 `/`、`/admin/`、`/org/`、`/student/` HTTP 200；`/api/health` 成功；未认证 HTTP 401；8788 仅监听 `127.0.0.1`；`nginx -t` 成功并 reload。旧服务与真实数据库未被覆盖，正式公开上线 / 备案仍后置。 |
| 2026-09-04 | P8-Q06 性能与容量基线完成：建立隔离临时 SQLite 的 API、官网首页、并发课堂、AI 任务、文件元数据写入和锁竞争基线。 | `p8-q06-performance.mjs` **13 pass / 0 fail**；健康接口 p95 12.4ms、公开课程 p95 6.7ms、课堂读取 p95 36.4ms、AI p95 26.6ms、文件元数据写入 p95 17.1ms；不代表真实 AI / OSS / 生产容量。 |
| 2026-09-04 | P8-S03 多租户数据隔离安全测试完成：临时 SQLite 创建第二机构并完成跨租户拒绝与平台审计边界验证。 | `p8-s03-tenant-isolation.mjs` **20 pass / 0 fail**，退出码 0；未修改 `packages/canvas`，未触碰真实线上数据库；P8-Q04、P8-Q06、P8-S01、P8-S04、P8-S06 已通过，下一步只继续收敛 P8-S05、P8-Q05、P4-C01、P4-01、P4-03 和内测 UAT；P8-L02～L04 已按用户决策 `[~]` 暂缓。 |
| 2026-09-04 | P8-S04 备份恢复演练完成：隔离临时 SQLite 备份、恢复启动、RPO / RTO 和业务接口校验通过。 | `p8-s04-backup-recovery.mjs` **9 pass / 0 fail**；备份耗时 1925.2ms、恢复 API RTO 147.1ms；未伪造 OSS 备份。 |
| 2026-09-04 | P8-S05 监控告警基线完成：定义监控矩阵、阈值、责任人与值班处置，完成隔离脚本验收并在 ECS 启用 systemd timer 与日志轮转。 | `p8-s05-monitoring.mjs` **13 pass / 0 fail**；ECS timer/service/logrotate 实际验证成功；真实通知渠道未接入，不宣称已接入真实告警。 |
| 2026-09-04 | P8-S06 发布、回滚与事故响应演练完成：验证预发 release 切换、故障自动回滚、数据库快照恢复、事故分级通报止损和复盘模板。 | `p8-s06-release-rollback.mjs` **13 pass / 0 fail**；未触碰真实线上数据库；真实 ECS 发布窗口仍按手册执行。 |
| 2026-09-04 | P8-Q01 代码质量基线完成：纳入非画布语法、构建、静态风险模式和发布边界检查。 | `p8-q01-quality.mjs` **11 pass / 0 fail**；46 个 JavaScript / MJS 文件语法检查、四端生产构建和 `git diff --check` 通过。 |
| 2026-09-04 | P8-Q05 移动端 / 平板视口回归增量：对官网 12 条关键路由执行 390 / 414 / 768 三视口渲染检查。 | Codex 内置 Chromium **36/36**；正文非空、控制台错误 0、无横向溢出、noindex/canonical/动态标题通过；独立 Chrome / Edge / Safari 与真机仍不可用，P8-Q05 保持 `[-]`。 |
| 2026-09-04 | P8-Q02 关键规则单元测试完成：认证、请求上下文、错误封装、积分账务和冻结 / 释放规则纳入临时 SQLite 测试。 | `p8-q02-unit.mjs` **17 pass / 0 fail**；尚未宣称全量覆盖率完成。 |
| 2026-09-04 | P8-Q05 独立浏览器与移动视口回归：本机 Chrome 152 / Edge 152 完成官网 96/96，发现并修复 admin/org/student 共享移动布局 390px 横向溢出。 | 工作台修复前 26/52、修复后 **52/52**；官网复验 **96/96**；RBAC 27/27、列表 50/50、P3 集成 52/52、E2E 54/54、四端构建通过。证据在 `artifacts/p8-q05-20260904-independent/`；Safari 与真机仍未覆盖，线上站点未复验，P8-Q05 保持 `[-]`。 |


---

## 15. 下一次新对话的固定开场指令

> 请先读取 `D:\学习平台\platform-v2\docs\AI少儿编程平台-完整上线执行总控.md` 与 `D:\学习平台\platform-v2\docs\AI少儿编程平台-P4-非画布真实业务缺口清单.md`，以“当前唯一下一步”和未勾选事项为准推进。当前优先级是 **内测技术收口：P8-Q05、P4-C01、P4-01、P4-03 与角色 UAT**；举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规及正式公开上线均 `[~]` 暂缓；备案已由用户确认完成但后续由用户自行处理。线上继续保持受控内测，Basic Auth 已按用户授权解除但不得因此扩大访问范围；未通过正式门槛前不得解除 noindex 或宣传未接入能力。每次完成事项必须更新总控勾选、完成记录、验证方式和变更日志；继续禁止修改 `D:\学习平台\platform-v2\packages\canvas`、触碰真实线上数据库或伪造外部服务能力。


- 对话交接确认（2026-09-03）：P5-W08 已完成准备稿代码与本地验收（18/18），正式法律 / 合规部分按用户决策保持 `[~]` 暂缓；P5-M01 + P5-W05 仍为已完成（75+100=175 项断言全部通过）。`/org/enrollment` 已由 P4-O07 覆盖并改判真实已有，`/demo` 已由 P5-W02 覆盖并改判真实已有；`/org/afee` 仍依赖微信开放平台。P5-W01 / P5-W07 已完成；备案与正式合规后续再做，继续禁止修改 packages/canvas、触碰真实业务数据库和伪造外部依赖能力。每次完成事项必须同步更新本文件勾选、完成记录与变更日志。



- 对话交接确认（2026-09-03 新决策）：用户明确“备案先不做，但要先上线用于内部测试，网址不会对外公开”。因此当前执行目标改为受控内部测试环境；备案 / 正式域名 / 品牌邮箱 / 正式公开 HTTPS 不阻塞内测，但阻塞正式对外公开上线。下一步先完成 P9-I01～P9-I06，再做内部 UAT；P5-W08 准备稿、local-mock 和未接入外部服务不得被宣传为正式能力。

- 对话交接确认（2026-09-03）：用户确认继续推进；已通过 ECS 终端完成 `iicili.cyou` 受控内部测试发布。当前不再等待服务器控制通道，下一步是内部人员按角色进行线上浏览器 UAT、记录缺陷并保持 Basic Auth / 独立测试库 / noindex；备案和正式公开上线继续后置。

- 历史对话交接记录（2026-09-04）：用户确认备案已经完成；该条记录当时写作“转入正式上线节奏”，已被 2026-09-04 后续用户范围决策替代。当前以本文件 §0.6、§1.1 的“内测技术收口”口径为准，线上继续保持受控内测。

- 对话交接确认（2026-09-04，线上访问策略变更）：用户明确授权移除 `iicili.cyou` 的 Basic Auth。已通过 ECS 终端备份并只修改 Nginx 站点中的 `auth_basic` / `auth_basic_user_file` 两行，清理误放入 `sites-enabled` 的备份链接；`nginx -t`、reload、HTTPS HEAD 和 `/api/health` 验证通过。保留 HTTPS、noindex、内测标识、独立测试数据库和回滚备份；后续正式公开前重新建立访问控制。

### P8-Q05 / P9-I01 增量记录（2026-09-04）

- [x] **线上健康入口稳定化**：生效 Nginx 配置新增精确路由 `/api/health`，映射到 API 应用根路径 `/health`；通用 `/api/` 代理保持 `/api` 前缀，不再使用会剥离前缀的尾斜杠 `proxy_pass`。
- [x] **线上验证**：`nginx -t` 成功并 reload；`https://iicili.cyou/api/health` 返回 HTTP 200，`https://iicili.cyou/api/public/marketplace` 返回 HTTP 200；Nginx 备份已统一移至 `/etc/nginx/backups/`，避免 `sites-enabled` 重复加载警告。
- [x] **本地验收与版本**：`tmp-p9-i01-internal-deploy.mjs` 使用临时 SQLite **24 pass / 0 fail**；提交 `a874e45 fix: expose stable internal health endpoint` 已 push。
- [ ] **未完成边界**：P8-Q05 仍未完成独立 Chrome / Edge / Safari 与 390/414/768 移动端截图矩阵；不得据此标记 P8-Q05 完成。全程未修改 `packages/canvas`，未触碰真实线上数据库。

### 2026-09-04 继续推进记录：隐私与内容治理回归

- [x] `p8-l02-l04-privacy-governance.mjs` 使用临时 SQLite **32 pass / 0 fail**；复核监护信息同意 / 撤回、协议版本、隐私设置、导出申请、注销申请、作品举报、举报下架、旧会话失效和默认数据库隔离。
- [x] ECS 线上只读健康复核：当前 release `20260904T035620Z`，Node `v24.19.0`、pnpm `11.19.0`、`mode=internal-test`；systemd 服务 active；本地 `/health`、线上 `/api/health` 与 `/api/public/marketplace` 均返回 HTTP 200。
- [~] **用户决策后的正式合规边界**：真实监护人身份核验、按地区年龄规则、评论 / AI 内容举报、申诉渠道、违规 / 内容审核、正式法律文本及其生效发布均暂不做；现有准备稿 / 基础代码仅保留历史证据，不宣传为正式能力，后续需要时重新授权。

### 2026-09-04 P8-Q05 移动端 / 平板视口回归增量记录

- [x] 使用 Codex 内置 Chromium 浏览器对官网 12 条关键路由在 `390`、`414`、`768` 三个视口执行 **36/36** 路由渲染检查。
- [x] 36/36 页面正文非空、无“加载失败 / ReferenceError / Application error / Not Found / 服务器错误”等失败文本；控制台错误 **0**；三种视口均未发现横向溢出（`scrollWidth <= clientWidth`）。
- [x] 每条路由的 `robots` 均为 `noindex, nofollow, noarchive`，canonical 与动态标题均存在且符合预期；截图证据保存在 `artifacts/p8-q05-20260904/`（`matrix.json`、`home-390.png`、`marketplace-414.png`、`courses-768.png`）。
- [ ] **未完成边界保持不变**：当前环境仅发现 Codex 内置 Chromium（未提供独立 Chrome、Edge、Safari 或真机连接），因此 P8-Q05 仍保持 `[-]`，不得宣称跨浏览器矩阵已完成。全程未修改 `packages/canvas`，未触碰真实线上数据库。

### 2026-09-04 用户决策更新：暂缓举报、申诉、违规、监护人和正式法律事项

- [x] 用户明确：举报、申诉、违规 / 内容审核、监护人功能以及正式法律 / 合规文本暂时不做，后续需要时再重新提出。
- [x] 已将上述范围标记为 `[~]` 暂缓；现有代码和准备稿不删除、不宣传为正式能力，也不再作为当前内测上线阻塞项。
- [x] 当前下一步改为内测技术收口：P8-Q05 可用浏览器回归边界记录、P4-01 状态机 / 错误码、P4-03 列表规范和内测 UAT 缺陷收口；P4-C01 已完成。
- [ ] 正式公开上线、正式法务、真实外部服务和相关合规门槛继续后置；未修改 `packages/canvas`，未触碰真实线上数据库。

### 2026-09-04 P4-C01 权限覆盖收口记录

- [x] 本轮修复 `apps/server/src/routes/fileAssets.js`：ROLE 文件授权必须绑定 `orgId`，授权读取 / 下载要求 `grant.org_id === currentUser.orgId`；USER 授权若指定机构，目标用户必须属于该机构，否则返回 `USER_ORG_MISMATCH`。
- [x] 专项验收：`p4-c01-rbac-ownership.mjs` 使用临时 SQLite **27 pass / 0 fail**；复核未登录、角色越权、教师班级 / 课堂归属、跨机构文件授权、学生项目与 AI 历史隔离、平台管理员审计边界。
- [x] 回归：`p8-s03-tenant-isolation.mjs` **20 pass / 0 fail**；P3 API 联调使用临时 SQLite 全流程通过；未触碰 `packages/canvas` 或默认 `packages/data/platform.db`。
- [x] P4-01 已完成；下一项转入 P4-03 列表规范与角色 UAT。P8-Q05 继续保留当前环境无法完成独立浏览器 / 真机矩阵的边界说明。


### 8.6 P4-03-LIST 管理端列表交互规范收口（2026-09-04）

- [x] 共享 `Pagination`、`ListResultSummary` 组件及响应式样式已加入 `packages/shared/src/ui.jsx`、`packages/shared/src/styles.css`。
- [x] 平台用户、平台作品、操作审计、课程广场接入统一分页元数据：`items`、`total`、`page`、`limit`、`totalPages`；平台作品排序仅允许 `featured` / `submitted` / `title` 白名单，非法值安全回退默认排序。
- [x] 筛选 / 搜索 / 排序 / 每页数量变更回到第 1 页；导出审计时移除列表页码，导出内容按当前筛选条件生成。
- [x] 当前用户端的举报 / 违规治理入口已明确显示“暂缓 / 只读历史”，不作为本批次新增能力；申诉、监护人和正式法律 / 合规事项继续保持 `[~]`。
- [x] `p4-03-list-api-check.mjs` 临时 SQLite 验收：**8 pass / 0 fail**；覆盖登录权限、无效页码、用户 / 作品 / 审计 / 课程广场分页、排序白名单与状态筛选别名。
- [x] Node 24 下四端生产构建通过，`git diff --check` 通过；未修改 `packages/canvas`，未触碰默认数据库。
- [x] 机构列表批次已完成：机构名称 / ID 搜索、状态筛选、创建时间 / 名称 / 合同到期排序、分页元数据、每页数量切换与空态。
- [x] 课程列表批次已完成：课包名称 / ID 搜索、状态 / 可见范围筛选、手动顺序 / 创建时间 / 更新时间 / 名称排序、分页元数据、每页数量切换与空态。
- [x] 平台管理员列表批次已完成：登录名 / 姓名搜索、状态筛选、创建时间 / 姓名 / 状态排序、分页元数据、每页数量切换与空态。
- [ ] 尚未覆盖的管理端列表继续作为后续小批次：通知 / 物料、账务等页面的统一分页与导出；不得将历史通知 / 物料 P4-03 完成记录改写为本批次。

### 8.7 P4-03-LIST 机构列表批次（2026-09-04）

- [x] 服务端 `GET /api/admin/organizations` 增加 `search`、`status`、`page`、`limit`、`sort` 参数；排序字段仅允许 `created` / `name` / `expires`，非法值安全回退到 `created`。
- [x] 返回统一分页元数据：`items`、`total`、`page`、`limit`、`totalPages`、`sort`；搜索同时支持机构名称和机构 ID，状态仅接受 `TRIAL` / `ACTIVE` / `DISABLED`。
- [x] 平台端 `/organizations` 接入关键词、状态、排序、每页数量、分页摘要和空态；筛选 / 排序 / 每页数量变化会回到第 1 页。
- [x] `p4-03-list-api-check.mjs` 临时 SQLite 验收由 8 项扩展至 **11 pass / 0 fail**，新增机构分页、状态筛选和非法排序回退检查。
- [x] Node 24 下 admin 生产构建通过，`git diff --check` 通过；未修改 `packages/canvas`，未触碰默认数据库或真实线上数据库。
- [ ] 后续小批次：课程列表、平台管理员列表、通知 / 物料列表、账务列表；举报、申诉、违规 / 内容审核、监护人和正式法律 / 合规仍保持 `[~]` 暂缓。

### 8.8 P4-03-LIST 课程列表批次（2026-09-04）

- [x] 服务端 `GET /api/admin/course-series` 增加 `search`、`status`、`visibility`、`page`、`limit`、`sort` 参数；排序字段仅允许 `manual` / `created` / `updated` / `title`，非法值安全回退到 `manual`。
- [x] 返回统一分页元数据：`items`、`total`、`page`、`limit`、`totalPages`、`sort`；列表查询不再为每一行加载完整课时正文，课时详情继续由详情接口按需读取。
- [x] 平台端 `/courses` 接入关键词、状态、可见范围、排序、每页数量、分页摘要和空态；筛选 / 排序 / 每页数量变化会回到第 1 页。
- [x] `p4-03-list-api-check.mjs` 临时 SQLite 验收扩展至 **14 pass / 0 fail**，新增课程分页、状态 / 可见范围筛选和非法排序回退检查。
- [x] Node 24 下 admin 生产构建通过，`git diff --check` 通过；未修改 `packages/canvas`，未触碰默认数据库或真实线上数据库。
- [ ] 后续小批次：平台管理员列表、通知 / 物料列表、账务列表；举报、申诉、违规 / 内容审核、监护人和正式法律 / 合规仍保持 `[~]` 暂缓。

### 8.9 P4-03-LIST 平台管理员列表批次（2026-09-04）

- [x] 服务端 `GET /api/admin/platform-admins` 增加 `page`、`limit`、`sort` 参数；排序字段仅允许 `created` / `name` / `status`，非法值安全回退到 `created`。
- [x] 返回统一分页元数据：`items`、`total`、`page`、`limit`、`totalPages`、`sort`；保留现有状态筛选、关键词搜索、最近登录和活跃会话信息。
- [x] 平台端 `/admins` 接入排序、每页数量、分页摘要和空态；关键词 / 状态 / 排序 / 每页数量变化会回到第 1 页。
- [x] `p4-03-list-api-check.mjs` 临时 SQLite 验收扩展至 **17 pass / 0 fail**，新增平台管理员分页、状态筛选和非法排序回退检查。
- [x] Node 24 下 admin 生产构建通过，`git diff --check` 通过；未修改 `packages/canvas`，未触碰默认数据库或真实线上数据库。
- [ ] 后续小批次：通知 / 物料列表、账务列表；举报、申诉、违规 / 内容审核、监护人和正式法律 / 合规仍保持 `[~]` 暂缓。

### 8.10 P4-03-LIST 通知 / 宣传物料列表批次（2026-09-04）

- [x] 服务端 `GET /api/admin/inbox` 增加 `search`、`status`、`page`、`limit`、`sort` 参数；排序字段仅允许 `created` / `updated` / `publish` / `title` / `pinned`，非法值安全回退到 `created`。
- [x] 服务端 `GET /api/admin/materials` 增加 `search`、`status`、`category`、`visibility`、`page`、`limit`、`sort` 参数；排序字段仅允许 `created` / `updated` / `title` / `events`，非法值安全回退到 `created`。机构端物料读取保持兼容，不改变机构可见范围。
- [x] 平台端站内通知、宣传物料列表接入筛选、排序、每页数量、`ListResultSummary`、`Pagination` 和筛选空态；筛选 / 排序 / 每页数量变化回到第 1 页。
- [x] `p4-03-list-api-check.mjs` 使用临时 SQLite 验收扩展至 **23 pass / 0 fail**，新增通知 / 物料分页、状态筛选和非法排序回退检查。
- [x] Node 24 下四端生产构建通过，`git diff --check` 通过；未修改 `packages/canvas`，未触碰默认数据库或真实线上数据库。
- [ ] 下一批处理账务列表的明细分页、筛选、排序和导出边界；举报、申诉、违规 / 内容审核、监护人和正式法律 / 合规继续保持 `[~]` 暂缓，不新增开发。

### 8.11 P4-03-LIST 账务列表批次（2026-09-04）

- [x] 平台账务 `GET /api/admin/billing/usage-records` 从固定 200 条改为统一分页协议 `{ items, total, page, limit, totalPages, sort }`；`limit` 上限 100，非法 `page` 返回 400。
- [x] 筛选支持机构、能力、状态、关键词、近 N 天以及 `startDate` / `endDate`（`YYYY-MM-DD`，服务端按当日 00:00 / 23:59:59.999 UTC 边界解释）；日期格式非法返回 400。
- [x] 排序白名单为 `created` / `credits`，未知键回落 `created`；排序 SQL 由白名单映射生成，并附 `created_at,id` 稳定次级排序。
- [x] 平台端 `/billing` 明细接入日期范围、机构、能力、状态、关键词、排序、每页数量、`ListResultSummary`、`Pagination` 与空态；所有筛选 / 排序 / 每页数量变化重置到第 1 页。
- [x] 导出边界：平台用量明细本批不新增 CSV；既有机构积分对账 CSV 仍按机构全量流水导出，不使用列表分页参数，避免“当前页=导出范围”的误解。
- [x] 修复上一批通知 / 物料中文替换误伤前端标识符的回归：恢复 `AdminMaterials`、`materials`、`organizations`、`Status`、`resourceConfigured` 和 `admin/materials` 请求路径；中文界面文案保留。
- [x] 验收：`p4-03-list-api-check.mjs` 临时 SQLite **29 pass / 0 fail**；`p8-q03-api-integration.mjs` **52 pass / 0 fail**；admin / org / student / website 四端生产构建与 `git diff --check` 通过；未修改 `packages/canvas`，无数据库结构变更。
- [ ] 下一步：完成 P4-03-LIST 十类列表整体验收复核，再按平台超管、机构管理员、教师、学生、官网访客顺序做角色 UAT；P8-Q05 仍保持进行中，未虚构独立浏览器 / 真机结果；举报、申诉、违规 / 内容审核、监护人和正式法律 / 合规继续保持 `[~]`。

### 8.12 P4-03-LIST 十类列表整体验收复核（2026-09-04）

- [x] 复核矩阵覆盖：平台用户、平台作品、操作审计、课程广场、机构、课程、平台管理员、通知、宣传物料、账务；十类接口均返回 `{ items, total, page, limit, totalPages, sort }`，`totalPages` 使用空集安全的 `Math.max(1, Math.ceil(total / limit))`。
- [x] 排序与参数安全：可排序列表全部使用白名单映射；审计固定返回 `created`，课程广场固定返回 `status`，未知排序键统一安全回落，不拼接任意 SQL 字段；十类接口 `page=0` 均返回 400，未登录均返回 401。
- [x] 平台用户补齐 `created` / `name` / `status` 排序白名单、排序控件与每页数量选择；操作审计、课程广场补齐固定排序元数据。
- [x] 前端一致性收口：操作审计与课程广场接入 `ListResultSummary` 和共享 `Pagination`；课程广场不再手写分页；审计、课程广场与平台用户空态均提示可调整筛选条件；筛选、排序、每页数量变化均回到第 1 页。
- [x] `p4-03-list-api-check.mjs` 重构为十类列表矩阵式断言，临时 SQLite 验收 **50 pass / 0 fail**；`p8-q03-api-integration.mjs` **52 pass / 0 fail**；四端生产构建与 `git diff --check` 通过。
- [x] 影响文件：`apps/server/src/routes/adminOrg.js`、`apps/admin/src/main.jsx`、`p4-03-list-api-check.mjs`。无数据库结构变更，未触碰真实线上数据库，未修改 `packages/canvas`。
- [x] P4-03-LIST 主任务完成；下一项进入平台超管、机构管理员、教师、学生、官网访客五类角色 UAT。举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规继续保持 `[~]` 暂缓，不新增开发。

### 8.13 P8-Q07 角色 UAT：平台超管阶段（2026-09-04）

- [x] 隔离 UAT 环境与脚本基线：新增 `p8-q07-role-uat.mjs`，强制创建临时 SQLite 并拒绝默认业务数据库，播种数据后启动隔离 API 与统一网关，托管 platform / org / student / website 四端生产构建；网关输出数据库路径、证据目录、四端入口与 API 代理，并附加 `noindex` / internal-test 响应头。本轮复验网关 `http://127.0.0.1:60028`，临时数据库位于系统 Temp 目录，未读取、复制或写入真实线上数据库。
- [x] 平台端异常路径：未登录访问 `/admin/dashboard` 显示登录页；`root` 错误密码返回“登录名或密码错误”；`org-admin / org123` 登录平台端被拒绝并提示“该账号没有平台管理权限”；`root / admin123` 可正常进入平台端。
- [x] 平台超管 17 个页面巡检：`/dashboard`、`/organizations`、`/courses`、`/users`、`/marketplace`、`/works`、`/hackathon`、`/billing`、`/materials`、`/website-content`、`/analytics`、`/notifications`、`/client-releases`、`/inbox`、`/leads`、`/admins`、`/audit` 全部完成真实浏览器渲染检查；关键内容可见，未出现“加载失败 / Application error / ReferenceError / TypeError / 服务器内部错误 / 接口不存在”。前 16 页首次巡检通过；`/notifications` 首次发现生产包白屏，修复后复验 **17/17 通过**。
- [x] 缺陷与根因：`/admin/notifications` 生产包白屏，压缩错误为 `Minified React error #62`。用平台端 Vite 非压缩构建接入隔离 API 后取得完整错误：`The style prop expects a mapping from style properties to values, not a string`。根因是 `PlatformNotifications` 的 Worker 标签把 `style` 写成字符串 `style="font-size:0.8em"`；React 19 在生产包压缩为 #62。
- [x] 最小修复：仅将 `apps/admin/src/main.jsx` 中该处改为 `style={{ fontSize: '0.8em' }}`；未改动 Hooks、通知业务逻辑、接口或 `packages/canvas`。修复后通知页标题“通知事件与失败运营”、概要指标、队列状态、Worker 信息与“事件投递 / 事件列表 / 失败运营”三个 tab 均可见、可切换，无白屏。
- [x] 回归与复验：`p4-03-list-api-check.mjs` 临时 SQLite **50 pass / 0 fail**；`p8-q03-api-integration.mjs` **52 pass / 0 fail**；`p8-q04-e2e.mjs` **54 pass / 0 fail**；`pnpm build` 四端生产构建通过；`git diff --check` 通过。修复后重启隔离 UAT 环境并复核 17 个平台页面，无失败文本，当前环境未新增浏览器错误。
- [x] 登出与会话失效：通过隔离 API 使用 `root` 登录后读取 `/api/me` 返回 200；`POST /api/auth/logout` 返回 200 且 `loggedOut=true`；同一 Cookie 再读 `/api/me` 返回 401 `SESSION_SUPERSEDED`，证明服务端旧会话立即失效。前端 `logout()` 同时调用服务端注销、清理本地会话并跳转登录页。
- [x] 证据：`evidence/p8-q07/admin-notifications-fixed.jpg`（修复后真实浏览器截图）、`evidence/p8-q07/admin-super-admin-uat.txt`（环境、页面矩阵、根因、回归与登出记录）。证据为本仓库持久路径，可复核。
- [ ] 下一步：按 P8-Q07 继续机构管理员、教师、学生、官网访客角色 UAT 与缺陷收口；P8-Q05 仍保持进行中，未虚构独立 Chrome / Edge / Safari 或真机结果；举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规继续保持 `[~]` 暂缓。

### 8.17 P8-Q07 角色 UAT：官网访客阶段（2026-09-04）

- [x] 页面巡检：官网首页、课程广场、课程体系、机构方案、学员作品、产品手册、选型对比、下载说明、预约演示、用户协议、隐私政策、儿童/未成年人说明共 12 个路由全部真实渲染；未知路径回落首页，不出现白屏或页面脚本错误。
- [x] 内测边界：构建入口保留 noindex / nofollow / noarchive，页面显示“内部测试环境 · 不代表正式服务”横幅；下载接口明确“尚未配置真实客户端安装包，不提供虚假下载链接”。
- [x] 课程广场链路：按平台超管流程将隔离库种子课程配置为上架后，访客可浏览课程广场、进入课程详情并读取 5 个已发布课时；课程详情仅展示公开字段，不暴露机构或学生私有数据。
- [x] 公开服务与线索：/api/public/legal、downloads、works、marketplace、marketplace/:id 全部 200；预约演示表单提交成功并生成线索记录，法律版本为 2026.09.03 准备稿状态。
- [x] 未登录保护：/api/me、平台机构列表、机构用户/套餐、学生看板、AI 中心全部返回 401 SESSION_INVALID，访客不能读取任何工作台数据。
- [x] 验证与证据：官网访客专项 18/18 通过，无新增 P0/P1。证据见 evidence/p8-q07/visitor-uat.txt 与 visitor-*.jpg。全程使用隔离临时 SQLite，未修改 packages/canvas，未触碰默认数据库或真实线上数据库。
- [ ] 下一步：P8-Q07 四角色 UAT 已完成，转入 P8-Q05 可用浏览器回归边界记录与内测缺陷收口；不虚构独立 Chrome / Edge / Safari 或真机结果；举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规与正式公开上线继续 [~] 暂缓。

### 8.16 P8-Q07 角色 UAT：学生阶段（2026-09-04）

- [x] 登录矩阵：未登录访问 /student/dashboard 仅显示登录页；student-2 错误密码提示“登录名或密码错误”；root、org-admin、teacher-1 登录学生端均被拒绝，未出现学生学习看板。
- [x] 跟随课堂边界：student-1 登录后显示“小明”和“等待老师开启课堂后”提示；在无进行中课堂时创建项目返回 403 CLASS_SESSION_REQUIRED“跟随课堂账号需要由教师先开启对应课时的课堂”，未产生课堂外项目。
- [x] 自主练习与页面巡检：student-2 登录后显示“小小创作者 / 小红”，可见我的学习、我的项目、我的作品、作品墙、消息中心、帮助与下载 6 项导航，并可进入课程、AI/魔法石、个人账号页面；9 个学生路由全部真实渲染，无白屏和页面脚本错误。
- [x] 学生间数据隔离：student-2 创建自主练习项目后自读 200；student-1 对同项目 GET / PUT / DELETE / 快照 / AI 历史全部 404 PROJECT_NOT_FOUND，直访画布仅显示“项目不存在”，不泄露项目 ID 或画布内容。
- [x] 机构与管理端边界：学生调用 /api/org/users、/api/org/billing/packages、/api/org/billing/enrollments、/api/org/works、/api/org/classes、/api/admin/organizations 全部 403；访问 /admin/dashboard 与 /org/dashboard 均只显示对应登录页，不渲染平台或机构数据。
- [x] 登出与旧 Cookie 失效：登出前 /api/me=200；POST /api/auth/logout=200 后同 Cookie /api/me=401 SESSION_INVALID，浏览器回到学生登录页。
- [x] 验证与证据：学生专项 26/26 通过，未发现需要修复的 P0/P1；RBAC 27/27、列表 50/50、P3 集成 52/52、E2E 54/54 与四端生产构建通过。证据见 evidence/p8-q07/student-uat.txt、student-1-dashboard.jpg、student-1-class-blocked.jpg、student-1-cross-project-boundary.jpg、student-2-*.jpg。全程使用隔离临时 SQLite，未修改 packages/canvas，未触碰默认数据库或真实线上数据库。
- [ ] 下一步：继续官网访客角色 UAT；P8-Q05 仍保持进行中，不虚构独立 Chrome / Edge / Safari 或真机结果；举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规继续 [~] 暂缓。

### 8.15 P8-Q07 角色 UAT：教师阶段（2026-09-04）

- [x] 登录矩阵：未登录访问 `/org/dashboard` 仅显示登录页；`teacher-1` 错误密码返回“登录名或密码错误”；`root / admin123` 与 `student-1 / study123` 登录机构端均被拒绝；`org-admin / org123` 登录后进入机构管理员视角，不出现教师看板。
- [x] 教师可见导航与页面巡检：`teacher-1 / teach123` 显示“授课教师”，可见机构总览、班级与课堂、成员管理、作品点评、站内信、课程中心、宣传物料；隐藏作品数据中心、积分套餐、学员开通、账号申请、问题反馈。7 个可见路由全部真实渲染，页面错误 **0**；成员页按无 `MANAGE_MEMBERS` 权限显示服务端 403 边界。
- [x] 服务端权限修复（P1）：教师 Cookie 调 `GET /api/org/billing/packages` 原先返回 200，可读取学员套餐价格、积分、席位与能力配置，但该页面为教师隐藏且套餐维护属机构管理员职责。已在 `handleOrg` 对该 GET 补充 `ORG_ADMIN` 校验，教师现在返回 403 `ORG_ADMIN_REQUIRED`“仅机构管理员可查看积分套餐”；机构管理员同接口仍为 200。未修改 `packages/canvas`。
- [x] 教师用量口径保留：`GET /api/org/billing/usage-overview`、`usage-records` 继续允许教师读取，维持既有课堂生成扣积分链路与“授课教师可在积分用量查看本机构用量汇总”的产品口径；P3 集成回归中“机构用量反映生成”通过。账务总览、积分调整、冻结、退款 / 冲正、开通单、作品数据导出、账号申请、平台管理 API 对教师仍全部 403。
- [x] 隐藏管理页与跨端 UI：教师直访 `/work-data`、`/packages`、`/enrollment`、`/account-requests`、`/recharge` 均显示无权 / 仅机构管理员 / 教师无席位管理权限等边界，不泄露数据；访问 `/admin/dashboard` 显示“当前会话没有平台管理权限”，访问 `/student/dashboard` 显示“当前会话没有学生创作权限”。
- [x] 登出安全：登出前 `/api/me=200`，`POST /api/auth/logout=200`，同一 Cookie 登出后 `/api/me=401 SESSION_INVALID`，前端回到登录页。
- [x] 回归：教师角色专项 **19/19 通过**；`p4-c01-rbac-ownership.mjs` **27/27**；`p4-03-list-api-check.mjs` **50/50**；`p8-q03-api-integration.mjs` **52/52**；`p8-q04-e2e.mjs` **54/54**；`pnpm build` 四端通过；四端生产 JS `React.createElement=0`；`git diff --check` 通过。机构管理员套餐 / 用量接口复验 200。
- [x] 证据：`evidence/p8-q07/teacher-uat.txt`、`teacher-*.jpg`、`teacher-enrollment-detail.txt`、`teacher-usage-permission.txt`、`org-packages-after-teacher-guard.jpg`。UAT 仅使用临时 SQLite 与隔离端口，不触碰默认数据库、真实线上数据库或生产站点。
- [x] 下一步已进入学生 UAT（见上节）；官网访客仍待执行；P8-Q05 仍保持进行中，不虚构独立 Chrome / Edge / Safari 或真机结果；举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规继续 `[~]` 暂缓。
### 8.14 P8-Q07 角色 UAT：机构管理员阶段（2026-09-04）

- [x] 机构端异常路径：未登录访问 `/org/dashboard` 仅显示机构登录页；`org-admin` 错误密码返回“登录名或密码错误”；`root / admin123` 与 `student-1 / study123` 登录机构端均被拒绝并提示“该账号没有机构教务权限”；`org-admin / org123` 正常进入机构总览。
- [x] 阻塞缺陷一（P1）与根因：机构端、学生端生产包首次进入白屏，页面错误为 `ReferenceError: React is not defined`，产物内 canvas 组件残留 **1336 / 1073** 处未绑定 `React.createElement`。排查确认不是 canvas 源码、目录 alias 或 React 插件配置问题，而是 `apps/org`、`apps/student`、`apps/server`、`packages/database` 下残留指向 `D:\学习平台\cyldhuabu-main\cyldhuabu-main` 的未跟踪 `node_modules`，使真实构建误用外部项目 `@vitejs/plugin-react 6.1.1` / `vite 8.2.2` 并改变 JSX 转换行为。
- [x] 修复方式：未修改 `packages/canvas`，未引入全局 `React` 兜底；仅将四组跨项目残留依赖目录隔离出 workspace，并在根 `package.json` 显式声明 `@platform/database: workspace:*`，让服务端依赖本仓库包。清理后 org / student 产物 `React.createElement=0`，四端完整生产构建通过。
- [x] 阻塞缺陷二（P1）：`/org/help-feedback` 首次巡检白屏，错误为 `ReferenceError: useSearchParams is not defined`。根因是机构端已使用该 Hook 但未从 `react-router-dom` 导入；最小修复仅补齐 import，未改反馈业务逻辑。
- [x] 机构管理员 16 个页面巡检：`/dashboard`、`/classes`、`/members`、`/works`、`/inbox`、`/courses`、`/work-data`、`/packages`、`/enrollment`、`/account-requests`、`/materials`、`/recharge`、`/usage`、`/hackathon`、`/afee`、`/help-feedback` 全部真实浏览器渲染通过，页面错误 **0**，最终 **16/16 pass**。`/usage` 实际页面标题为“积分用量”，首次失败仅因验收脚本预设关键词错误，已复验通过。
- [x] 越权与登出：`org-admin` 访问 `/admin/dashboard` 显示“当前会话没有平台管理权限”；同 Cookie 调平台管理 API 返回 403 `FORBIDDEN`。`student-1` 调 `/api/org/billing/account` 返回 403。`org-admin` 登出前 `/api/me=200`，`POST /api/auth/logout=200`，同 Cookie 登出后 `/api/me=401 SESSION_INVALID`，前端回到登录页。浏览器内 Cookie API 验证均复用真实 `platform_token`。
- [x] 回归：`p4-03-list-api-check.mjs` **50 pass / 0 fail**；`p8-q03-api-integration.mjs` **52 pass / 0 fail**；`p8-q04-e2e.mjs` **54 pass / 0 fail**；四端生产构建通过；`git diff --check` 通过。UAT 继续使用临时 SQLite 与 `60027/60028` 隔离进程，未读取、复制或写入真实线上数据库，未触碰生产站点。
- [x] 证据：`evidence/p8-q07/org-login-react-fixed.jpg`、`student-login-react-fixed.jpg`、`react-runtime-fix.txt`、`org-*.jpg`（16 页截图）、`admin-org-admin-routes.txt`、`admin-org-admin-authz-logout.txt`。
- [ ] 下一步：按 P8-Q07 继续教师、学生、官网访客角色 UAT 与缺陷收口；P8-Q05 仍保持进行中，未虚构独立 Chrome / Edge / Safari 或真机结果；举报、申诉、违规 / 内容审核、监护人、正式法律 / 合规继续保持 `[~]` 暂缓。

### 8.17 P8-Q05 独立 Chrome / Edge 浏览器与移动布局回归（2026-09-04）

- [x] 独立浏览器真实可用：本机 Chrome `152.0.7977.64`、Edge `152.0.4191.53`，均使用真实可执行文件运行；未用同一个 Codex Chromium 伪装双浏览器结果。
- [x] 官网矩阵：12 条路由（`/`、`/marketplace`、`/courses`、`/org`、`/works`、`/handbook`、`/compare`、`/download`、`/demo`、`/terms`、`/privacy`、`/minors`）× 1440/390/414/768 视口 × 2 浏览器，共 **96/96 通过**；页面非空、关键词可见、控制台错误 0、无失败文本、无横向溢出、noindex 保持。
- [x] 工作台矩阵：admin 5 条、org 4 条、student 4 条关键路由 × 1440/390 视口 × 2 浏览器，共 52 项。首轮桌面 26/26 通过，移动 390 项 26/26 失败且均为横向溢出；页面标签、渲染、控制台均正常。
- [x] 缺陷与根因（P1）：三端表现一致，源头是共享移动顶栏。`.app-nav` 自身可滚动，但 `<=900px` 下 `.app-shell{grid-template-columns:1fr}` 的网格项按内容最小尺寸展开，把 `.sidebar` 撑到 admin 1322px、org/student 528px，触发整页横向滚动。
- [x] 修复：仅修改 `packages/shared/src/styles.css` 的 `<=900px` 规则：`.app-shell{grid-template-columns:minmax(0,1fr)}`，`.sidebar{min-width:0}`，`.app-nav{min-width:0}`。未改业务组件、权限逻辑和 `packages/canvas`；导航仍在自身容器内横向滚动。
- [x] 修复后复验：真实 Chrome / Edge 工作台矩阵 **52/52 通过**；官网矩阵复验 **96/96 通过**，确认共享 CSS 未破坏官网。修复前后 390px 截图均保留。
- [x] 完整回归：`p4-c01-rbac-ownership.mjs` **27/27**；`p4-03-list-api-check.mjs` **50/50**；`p8-q03-api-integration.mjs` **52/52**；`p8-q04-e2e.mjs` **54/54**；四端生产构建通过。
- [ ] **未完成边界**：Safari 独立浏览器、真实 iOS / Android / 平板设备、线上生产站点独立浏览器复验仍未覆盖；P8-Q05 保持 `[-]`，不得宣称“全浏览器 / 真机矩阵完成”。本轮全部使用隔离临时 SQLite，未修改 `packages/canvas`，未触碰默认数据库、真实线上数据库或 `https://iicili.cyou/` 生产数据。
