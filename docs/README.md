# AI 魔法学院学习平台 · 最终文档（唯一入口）

> 版本：2026-09-15　｜　**当前 HEAD 2a3ce32 已推送，生产只读核验为同一提交；课堂深度交互后续改动仍在本地，未提交、未部署，整体 MVP / 1–7 项不能标为完成。**
> 其它文档都从属于它：结构看 `docs/architecture/代码结构与路由.md`，
> 设计口径看 `docs/项目重梳理-03-平台侧重做梳理.md`，
> 操作命令看 `deploy/production/RUNBOOK.md`，
> 历史（怎么一步步变成现在这样的）看 `docs/archive/`。

## 一、这是什么

面向**机构与课堂**的青少年 AI 创作平台。三方角色：

- **平台**：管课包库、授权给机构、配模型与算力单价、看全平台数据。
- **机构 / 教师**：看课包内容、把课包**分给学员**、**开课堂**、看学员与作品。
- **学员**：在课堂上用 AI 画布或 VibeCoding 做出作品、提交作品。

一句话口径（2026-09-13 定稿，与早前文档冲突时**以本文件为准**）：

> **课堂是唯一的主对象，班级已经彻底退场。**
> 学员能不能进操作环境，只看「有没有许可 + 有没有被老师排进这节课的课堂 + 课堂是否正在上」。

## 二、现在的状态（生产）

```text
入口：https://iicili.cyou/{admin,org,student}/     （官网在根路径 /）
仓库：E:\学习平台正常　branch feature/vibecoding-ppt-quality-20260915
代码提交：f02d3ee6833846bac97f05dde58aee8f6b6ab2c0（= 生产版本；其后只有文档提交）
生产：release 20260916T035836Z / commit f02d3ee（服务 learning-platform-production @127.0.0.1:8789）
      部署后核验：BUILD-METADATA commit 与本地一致；active/running、NRestarts=0、ExecMainStatus=0；
      /、/admin/、/org/、/student/、/api/health、/vibe-preview.html 全 200；未登录读私有作品 401；日志无异常
      上一版（可回滚）：release 20260915T141240Z / commit 2a3ce32
账号：平台 root；机构 org-admin；教师 teacher-1；学生 student-1（凭据不写入文档）
对外售价：对话 1 / 图片 1 / 视频 5 / 音乐 2 元每次（库里按**分**存：100 / 100 / 500 / 200）
          ⚠️ 只是**观测口径**的对外公告价：不扣学生、不计收入、不进真实毛利公式
          （详见 `docs/operations/真实三账对照-20260914.md`）
历史数据快照（非本次复核）：3 个已发布课包（含 2 个演示）+ 1 个草稿 + 9 个课堂 + 5 条学员许可 + 2 件学生作品
```

**本轮课堂深度交互（已部署到上面的 release）**：p96 / p78 / p66 / p69 已通过（Node 22，本机实测）；三端生产构建通过；
GUI（隔离库 `127.0.0.1:15175`，非生产数据）已走通：创建 → 改名 → 加人 → 移除的取消/确认 → 换课清空确认 → 重新加人 →
同课程切环境保留名单 → 开始 → 上课中补加 → 结束/解散后只读；并实测了私有作品只读预览（画布快照图片与 Vibe 沙箱内
`Add one` 计数 0→1、私有图片在沙箱内以 data 地址正常显示）。390px 下弹窗与表格可操作（名单表横向滚动）。
生产上只读复核过：课堂列表/详情正常渲染，机构管理员打开**其他老师**的课堂显示「只读课堂：仅负责老师可以管理此课堂」且没有写操作入口。

**仍未完成 / 不能标完成**：整个 MVP 与「1–7 阶段」改造仍未全量验收；CU 预留账本只接入部分 AI 链路，不是全闭环。

**CU 实现边界**：CU 预留账本仅接入部分 AI 链路，尚非全闭环；旧摘要中“CU 全实现”类表述不代表当前实际能力。下文既往核验及梳理记录按历史时点理解，不作为本轮全量验收证据。

平台里已经有一套**演示数据**（`deploy/production/seed-demo-teaching-data.mjs`，幂等可重跑），
要给人演示时照着走：机构端「课堂」→ 打开「演示 · 第二课（上课中）」→ 让学生真生成一次
（这笔会进算力池）→ 老师「结束课堂」→ 学员结算成**已完课**。

## 三、必须记住的领域口径（改错这里 = 出 bug）

1. **进课三层门禁**（`services/studentContext.js` 的 `resolveStudentLessonContext`，唯一权威）：
   ① 课时/课包已发布 → ② 机构对课包有生效授权 → ③ 学员持有效许可 → ④ 这节课上有他的课堂名单记录
   → ⑤ 课堂正在进行 → ⑥ 课堂入口类型与他要走的入口一致。**每一步失败都给不同的错误码**，
   为的是让学生知道该找谁（没许可找老师要课包、没排进课堂找老师加人）。
2. **有许可 ≠ 能进**。许可只代表「能看课包与课时的信息」。进了课堂名单 + 老师点了开始上课，才能创作。
3. **课堂四态**：待上课 PENDING / 上课中 ACTIVE / 已结束 ENDED / 已解散 DISSOLVED。
   一个课堂带**一种**入口类型（画布 或 VibeCoding）；**一个学生全局最多属于一个未终态课堂（PENDING / ACTIVE），不限于同一课程或课时**。
4. **学员六态**：未加入任何课堂 / 待上课 / 上课中 / 已完课 / 未完课 / 被移除。
5. **真实 SUCCESS 才算完课**：完课判定看该学生在本课堂是否存在真实成功的 AI 调用（`status=SUCCESS`），不依赖金额；失败、预检拦截、未知结果都不算。已完课不能再被排进同一节课；学生重进同一课堂必须幂等。
   **结课即冻结（2026-09-15）**：结算只发生在「结束课堂」那一刻（`orgAdmin` 的 end 动作在同一事务里跑 `settleSessionStudents`，再落 `ENDED`）。
   课堂一旦 `ENDED`/`DISSOLVED`，完课结果不再改变；迟到的上游成功回执**只进用量账本**（`usage_records`），不回头改写学员状态。
   代价要说清楚：老师点结束之后才落库的在途成功调用，不会把学员补成已完课 —— 这是「结果固定」换来的，不要当成 bug 去"修"。
6. **课包发布必须形成七字段版本快照**；机构授权与库存按课包版本约束。机构库存是有限次数，学生容量由机构字段控制；教师只能管理自己创建的课堂，单教师对应单课堂职责。
7. **平台承担算力成本**：不向学生展示或扣减积分、售价余额；每次调用按机构、学生、课时和课堂记入平台成本账本。课时金额是每场课堂的成本预警基准，超过只提醒平台，不阻断学生生成。
8. **成本必须区分来源**：ESTIMATED、REPORTED、UNKNOWN、MOCK 各自保留语义；供应商账单匹配后的金额才是实际结算成本。机构实收、许可确认收入、结算成本和真实毛利分账核算；旧数据没有证据时保持 UNKNOWN，不能猜成本。**对外售价**（模型与算力 → 对外售价）只是逐笔对照用的公告价，不扣学生、不计收入；调用账按「对外售价 / 上游成本 / 实际核销 / 差额」显示，未知或未核销时差额留空。操作见 `docs/operations/真实三账对照-20260914.md`。**机构端/学员端看到的「消耗」= 对外售价合计（只计成功尝试）**；平台自己的上游成本与毛利只在平台端「用量与成本」看，机构看不到。
    **金额单位的口径（2026-09-15 定，全文见该文档）**：一切都以**分**计；**配置里的单价必须是整数分**
    （文本按「分/百万 token」，见下），但**逐笔折算出来的成本可以是小数分**（保留 4 位）——
    因为便宜模型的单笔成本小于 1 分（DeepSeek 一次课堂对话约 0.2~0.4 分），按整数分取整会把每一笔都记成 0、
    整节课的文本成本凭空消失。`compute_attempts` 的金额列在库里是 REAL，正是为了存这种小数分。
9. **教师只看得到自己创建的课堂**（课包库全机构可见）；机构管理员看全机构。这条是安全相关的：改数据范围之前先跑 `scripts/p69-teacher-data-scope.mjs`。
10. **班级那三张表是历史表**（`classes` / `class_members` / `class_curriculum_items`）：保留数据与 DDL，不再被读写。旧 `/api/org/classes/*` 已全部下线。
11. **教学素材（备课资料）在机构/老师端只能在线预览、不提供下载**（2026-09-15，口径 A）：
    预览走 `/api/org/file-assets/{id}/preview?t=<短时票据>`，`content-disposition: inline`，每次预览写
    `FILE_PREVIEW` 审计。**PPT / Word 由服务端用 LibreOffice 转成 PDF 后再发，原始文件不出服务器**。
    边界（不是实现缺陷，是 web 的物理限制）：视频/PDF 只要浏览器能渲染就拦不住录屏/截屏；
    这里保证的是「没有下载入口 + 链接短时失效 + 原始 Office 文件不外发 + 审计可溯源」。
    ⚠️ **部署依赖**：服务器必须装 `libreoffice-impress`/`writer` + **中文字体**（`fonts-noto-cjk`，
    不装的话转出来的 PDF 中文是方块）；上传目录必须归服务账号所有，否则转换会因 EACCES 失败。
12. **VibeCoding 按「产物」提交，不是按对话提交**（2026-09-15）：学生做完一个游戏、一份 PPT，
    **各自有提交按钮**（工作台的预览工具栏 / 文档预览上），平台在后台把每一条分别发布到作品广场，
    官网访客就能点开玩。数据层唯一性是 `(conversation_id, entry_file)` —— 同一份产物重复提交是
    **覆盖**（round+1），不同产物各自成条、各自审核、各自上下架。
    ⚠️ 老库改这条要**重建表**（SQLite 改不了列级 UNIQUE）；迁移在生成库副本上验证过：
    行数/列集合/每行内容一字不差。改这张表的约束前先跑 `p94`，并照 `p73` 的做法在**有数据的库**上真跑迁移。
    ⚠️ 学生作品预览的 CSP 在服务器的 `/vibe-preview.html`（`sites-enabled` 里那份**不是** `sites-available` 的软链，
    两份会各自漂移，改的时候两份都要改）；想让作品用 CDN 样式表和 WebSocket，`style-src` 要有 `https:`、
    `connect-src` 要有 `wss:`。它还被 Cloudflare 边缘缓存，改完要在 Cloudflare 上 Purge 那个 URL。

13. **VibeCoding 的“小程序”是浏览器手机作品，不是微信小程序**：工作台可在桌面/390×844 手机模拟器间切换，
    HTML/CSS/JS 在沙箱内真实运行、可点击和输入；运行错误进入控制台，并可一键把错误交给 AI 修复。
14. **课堂详情里看学生私有作品 = 走机构鉴权只读接口，不借公开路**（2026-09-15）：
    `GET /api/org/sessions/:id/works/:source/:workId`（`CANVAS` | `VIBECODING`），作品必须**同时**属于本机构、
    属于这节课（VibeCoding 还要经 `conversation.class_session_id` 对上）；画布作品返回 `canvasSnapshot`，
    VibeCoding 返回**已提交快照**的 `files`/`artifacts`/`entryFile`（绝不回落到对话里的实时文件）。
    私有图片走同作品的 `/images/:fileId`，白名单只从该提交自己的快照里提取（画布取 `previewUrl`/`assetUrl`/`referenceUrl`，
    Vibe 走 `snapshotImageFileIds`），并且文件必须是 `ACTIVE`、属于提交学生（或平台公开素材）、MIME 在白名单内；
    列表里的 `previewUrl` 故意保持 `null` —— 不给机构一个能直接挂在 `<a href>` 上的私有地址。
    ⚠️ **坑（实测过）**：这些图片必须转成 **`data:` 地址**再喂给学生代码。学生 HTML 跑在 `/vibe-preview.html`
    的 `sandbox="allow-scripts"`（opaque 起源）里，**父页面的 `blob:` 地址在沙箱内一定 `onerror`**
    （实测 blob 失败、data 成功）；画布与文档预览虽然在父页面里，也统一用 data 地址，少一条分支。
15. **结课后的课堂是只读的**：机构管理员能看本机构**所有**课堂，但只有**课堂负责人**（`teacher_id`）能改名/换课/换环境/
    加人/开始/结束/解散；教师看不到别人的课堂（403），跨机构一律 404。终态课堂（已结束/已解散）的详情只给结果、作品与事件，
    不给任何写操作入口。
14. **PPT 走统一结构化规格与质量门禁**：站内预览和服务端下载共用 `packages/shared/src/deckSpec.js`；支持
    指标、时间线、对比、横/柱图、表格、流程、图文、章节、金句和结束页。metrics/chart/table 必须带 `source`，
    缺来源则拒绝导出；表格/图表/流程都有硬容量上限，不能靠 PowerPoint 自动缩成小字。

## 四、代码地图（详见 `docs/architecture/代码结构与路由.md`）

```text
apps/server/   后端（Node ESM，自己分发路由；services/ 里 studentContext、classroomSessions、
               computePool、modelCapabilities 是承重的）
apps/admin/    平台管理端
apps/org/      机构端 / 教师端（pages/Classrooms 是课堂页）
apps/website/  官网 **+ 学生端**（同一个 app；/learn 是学习环境）
packages/shared/  三端共用组件与样式
packages/canvas/  画布编辑器
scripts/       守卫（p*.mjs）—— 见下
```

## 五、怎么跑、怎么自证

```bash
# 本地起后端（临时库 + 种子）
PLATFORM_DATA_DIR=.tmp/x PLATFORM_DB_PATH=.tmp/x/platform.db node packages/database/src/db.js --init
PLATFORM_DATA_DIR=.tmp/x PLATFORM_DB_PATH=.tmp/x/platform.db node packages/database/src/seed.js
PLATFORM_DATA_DIR=.tmp/x PLATFORM_DB_PATH=.tmp/x/platform.db PORT=18888 node apps/server/src/index.js
```

**改完必跑**（守卫是这份代码的「别踩这里」）：

```bash
node .tmp/smoke-run.mjs                    # 全量守卫（当前至少含 p95 VibeCoding 精品化守卫）
node scripts/p70-pages-render.mjs          # 三端页面真渲染 —— 改前端之后必跑（能拦白屏）
node scripts/p66-student-grant-gate.mjs    # 进课三层门禁
node scripts/p78-classroom-student-flow.mjs # 课堂名单/开始/结束/结算（含「结课结果冻结」断言）
node scripts/p96-classroom-detail-api.mjs  # 课堂详情：改名只改名称、换课确认、环境切换、终态只读、私有作品与图片鉴权
node scripts/p69-teacher-data-scope.mjs    # 教师数据范围（安全相关改动）
node scripts/p73-session-migration.mjs     # 课堂表迁移（在有数据的库上真跑）
node scripts/p74-session-scope-columns.mjs # 范围字段必须被写入 + 回填只按证据
node scripts/p88-financial-reconciliation-ui.mjs  # 财务四视图 + 对账表
node scripts/p90-contract-cost-computation.mjs    # 合同价折算的精确金额
node scripts/p91-provider-bill-reconciliation.mjs # 账单适配器 / 幂等 / 凭据不外泄
node scripts/p92-sale-price-scope.mjs             # 机构端/学员端「消耗」= 对外售价（只计成功尝试）
node scripts/p93-material-preview.mjs             # 教学素材在线预览：形态判定 / 票据 / 转换失败不回落
node scripts/p94-artifact-submission.mjs          # VibeCoding 按产物提交：(对话,产物) 唯一、重复提交走覆盖
node scripts/p95-vibecoding-quality.mjs            # 手机预览、错误修复、提交隔离、私有素材、PPT 专业组件与共享规格
```

改前端还要 `vite build` 三端（`node_modules/vite/bin/vite.js build apps/<app> --config apps/<app>/vite.config.mjs`，
注意用 `C:\Program Files\nodejs\node`，默认 PATH 的 node 是 v16 不支持）。

浏览器验收：起后端 + `node .tmp/serve-plaza.mjs http://127.0.0.1:<port> 6178`，然后开 `http://127.0.0.1:6178/org/`。
⚠️ **起之前先确认端口干净**（`netstat -ano | grep :6178`）—— 残留的旧实例会让请求打到旧库上，
症状伪装成「代码 bug」（我为此查了半天代码）。

## 六、发布

唯一权威步骤在 `deploy/production/RUNBOOK.md` 的「发布流程（当前）」。要点：
服务器上**先 `export PATH=/srv/ai-kids-platform/runtime/node/bin:$PATH`**（不然 `node: not found`），
然后 `git pull --ff-only` → `backup-production.sh` → `build-production.sh` → 切 `current` 软链 → 重启 → 核验。
回滚 = 把 `current` 切回上一版 release 目录再重启；数据库回滚用 `backups/<stamp>/platform.db`。

## 七、约定与坑（踩过的，别再踩）

- **静默失败是这个项目最主要的 bug 类型**：字段没人写、权限范围写错、页面渲染崩 —— 都不报错。
  所以规矩是：改数据范围先确认**那个字段有没有被写过**；改前端必跑 `p70`；改安全范围必跑 `p69`。
- **给状态加新值前先看 CHECK 约束**（加 `UNPUBLISHED` 差点带着 500 上线，是守卫当场报出来的）。
- **新索引别写进基础 DDL**（老库没有新列会当场 `no such column`），要放在重建迁移之后。
- **重建表迁移必须逐项验**：子表会不会被 CASCADE 连带清空、索引有没有重建、幂等性。
- **回填只按证据、且必须幂等**；不硬猜（`p74` 钉着这条）。
- **别用内联 `node -e` 改多行 JSX/SQL**（引号与模板字符串必翻车）；写脚本文件或精确编辑。
- **往 SQL 里写 `//` 注释 = 全库初始化失败**（SQLite 只认 `--`）—— 症状是全量冒烟「大片红」，其实一处语法。
- **ESM 里 import 一个已删除的导出是链接期错误**（整个服务起不来），删导出必须同步清 import 名单。
- **`includes('文件名')` 判断「导入是否已加」会被注释骗过**，因此漏加 import 会让服务能起、一调就 500。
- **夹具/种子别顺手发许可、别塞演示课堂**：那会篡改被验的前提。

## 八、文档索引

| 文档 | 用途 |
|---|---|
| `docs/README.md` | **本文件**：唯一入口 |
| `docs/operations/新对话交接-20260915.md` | **新开对话先看这份**：开工顺序 + 当天实测 + 待决策（只当时点交接，口径以本文件为准） |
| `docs/项目重梳理-03-平台侧重做梳理.md` | 设计口径（三端各板块该有什么、算力总控怎么做） |
| `docs/项目重梳理-01-决策基线.md` | 早期产品决策（部分章节已被本文件覆盖） |
| `docs/architecture/代码结构与路由.md` | 代码放哪儿、接口有哪些 |
| `docs/operations/真实三账对照-20260914.md` | **三账与金额口径**：对外售价、合同单价折算、官方账单自动对账的操作与边界 |
| `docs/operations/上游实扣接入-20260915.md` | **上游逐笔实扣**（Seedance 直连）：接口面、实测币种「¥」、合同单价填法、验证证据与边界 |
| `docs/operations/全流程重梳理-20260913.md` | 课堂 / 课包 / 机构授权的当前规则 |
| `docs/operations/后台算力改造-20260913.md` | 算力账本与成本来源改造记录 |
| `docs/operations/交接说明.md` | 现状 + 环境 + 设计约定 + 运维 + 本地验证（**已精简**） |
| `docs/operations/验收清单.md` | 发布前人工验收清单 |
| `deploy/production/RUNBOOK.md` | 运维命令与发布流程 |
| `docs/archive/` | **历史**：早期 P0/P1 报告、拆出去的部署历史、旧内测文档 |
| `THIRD-PARTY-NOTICES.md` | 第三方许可（OpenSquilla 设计令牌） |

## 九、2026-09-13 文档与代码梳理结论

**删掉的（过期或已无价值）**
- `docs/archive/` 里 14 份早期 P0/P1 报告、`docs/architecture/积分系统设计.md`、
  `docs/项目重梳理-02-执行路线图.md`、`docs/项目重梳理-03-思维导图.md`：
  描述的都是**已删除的功能**（积分系统、班级课单、`apps/student`）或已完成的计划。
- `deploy/internal-test/`：内测服务早已删除；其中仍然有效的「长期 SSH 通道 + 发布流程」已并入
  `deploy/production/RUNBOOK.md`。
- 交接说明的 §三 部署历史（2700 余行）拆到 `docs/archive/交接说明-部署历史.md`，主文件 4601 → 1889 行。
- 本地 `deploy/releases/`（31MB / 539 文件的旧构建产物，未受版本控制）—— 它会让全仓搜索出现
  双份旧代码，我为此误判过一次；已删除并加进 `.gitignore`。
- 后端零调用方的接口：`/api/org/billing-config/*`（整块 7 个分支）、
  `/api/student/billing-config/modalities`、`/api/ai/generations/history`（GET 列表 + POST 重试，
  与 `/api/ai/generations` 返回同一份 payload）。

**已按你的决定废掉的**（2026-09-13）
- **学员自助合规套件**：`/api/student/account/` 的 profile / guardian / privacy / legal-consents /
  requests 六个端点与它们的 helper/常量全部删除；`studentAccountOverview` 不再返回
  `legalConsents` / `profileOptions` / `requests`。
  ⚠️ **连带影响（要知道）**：`users.privacy_showcase_anonymous` 与 `privacy_allow_feature` 这两个
  开关**从此没有任何界面能改**（学生自助入口没了），只能按默认值走 —— 默认是**不匿名**、**允许精选**。
  另：`privacy_showcase_anonymous` 被公开作品广场读取、`privacy_allow_feature` 被「设精选」的门禁读取，
  **所以这两列与它们的读取都不能删**；`legal_consents` / `account_requests` 两张表按惯例保留数据不删。
  官网协议/隐私/未成年人说明里那些「可在个人账号查看/清空/申请」的承诺已同步改成实际渠道（联系机构管理员）。
- **学员站内信**：`/student/inbox`（列表 / 单条已读 / 全部已读）三个分支删除。
  站内信功能本身没废 —— 机构端与平台端的 inbox 仍在，所以那几个通知 helper 保留（否则会连带删坏）。
- 顺带删掉平台端 `orgAccountRequestRow(s)`（账号申请那套的残留，只在 import 名单里、没人调用）。

**保留但**建议**你决策的**
- **`/api/public/legal`**、`/api/me/display-name`：各三五行，零调用方，但都挨着合规/资料编辑，留给你判断。
- **CSS 有压缩后的整块**（`packages/shared/src/styles.css` 最长行 10522 字符、`apps/website/src/styles.css`
  最长行 10745 字符）：不影响运行，但**没法 diff、没法读**。建议单独做一次「用格式化器重排」的
  纯空白改动（行为等价，但要三端真浏览器过一遍），我没有在本轮顺手做 —— 风险与收益不匹配。
- 平台端 `/api/admin/leads`（官网预约线索）后端保留、无管理界面：这是**之前有意保留**的，不是遗漏。
- **学员数据导出 `buildStudentDataExport()` 没有任何路由调用它**（2026-09-15 发现）：其它导出
  （`/organizations/export`、`/platform-users/export`、`/works/export`、`/audit-logs/export`、
  `/billing/org-student-usage/export`）都接了路由，只有它是一整个函数没人调 —— 合规/可携带导出
  这块要么接出来、要么删掉，属于产品决定。
  （顺带：它内部 `aiTasks` 的金额原来读 `job.cost_fen`，而 `generation_jobs` 根本没有这一列，
  所以永远导出 0 —— 这个潜在错误已随本轮口径改动修掉，但函数仍不可达。）
- **生产账号口令被硬编码在两个受控文件里**（2026-09-15 发现，早于本轮、已在远端历史里）：
  `deploy/production/seed-demo-teaching-data.mjs:19-21`（`process.env.XXX_PASSWORD || '明文口令'` 这种兜底）
  与 `docs/operations/交接说明.md:198-199`（四个账号口令列成表）。这与本文件「凭据不写入文档」
  以及 `RUNBOOK` 「严禁在仓库/文档里粘贴口令」的约定直接冲突。
  ⚠️ **改文件删不掉历史** —— 真正的处置是**轮换这四个口令**，那是你的决定（会影响演示与内测账号）。
  建议顺序：① 轮换口令 → ② 把 seed 脚本的明文兜底改成**缺失即报错** → ③ 文档里只写「凭据见运维口令库」。
- **`compute_attempts` 的金额列在库里声明成 `REAL`**（`upstream_cost_fen` / `sale_price_fen`，
  2026-09-15 实测确认）：所以 `4` 存进去读出来是 `4.0`。这是既有的表结构，与「金额一律非负整数分」
  的约定不一致；分位金额在 2^53 内还精确，眼下没出错。要改成 INTEGER 得重建表 + 迁移 + 回填，
  **没有擅自改**，等你决定（详见 `docs/operations/上游实扣接入-20260915.md` 第五节之二）。

**没动的**
- 上面「保留待决策」以外的后端接口逐个核过：其余无调用方的接口要么被守卫使用（`guard-only`，
  不能删），要么是**模板字符串动态拼**出来的（自动化扫描会误判为死代码，例如
  `/api/public/works/:token`、`/api/org/sessions/:id`、`/api/admin/billing-config/modalities/:code`）。
