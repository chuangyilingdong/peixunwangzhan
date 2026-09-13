# AI 魔法学院学习平台 · 最终文档（唯一入口）

> 版本：2026-09-13　｜　这份文件是**读代码之前先读的那一份**。
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
仓库：E:\学习平台正常　branch main
生产：release 20260913T101458Z / commit cefd73a（服务 learning-platform-production @127.0.0.1:8789）
账号：平台 root/liuyuchi123　机构 org-admin/OrgTest@2026!
      教师 teacher-1/TeacherTest@2026!　学生 student-1/StudentTest@2026!
单价：对话 1 / 图片 1 / 视频 5 / 音乐 2 元**每次**（真实售价，含毛利）
数据：3 个课包（含 2 个演示课包）+ 9 个课堂 + 5 条学员许可 + 2 件学生作品
```

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
   一个课堂带**一种**入口类型（画布 或 VibeCoding）；**一个学生在一节课上只能属于一个未结束的课堂**。
4. **学员六态**：未加入任何课堂 / 待上课 / 上课中 / 已完课 / 未完课 / 被移除。
5. **完课判定 = 这个学生在这节课消耗过算力**（成功调用且 `cost_fen > 0`）——**不是**「交过作品」。
   没花过钱的算**未完课**，可以重新排进课堂再上；已完课不能再被排进同一节课。
6. **额度只走算力池**（`services/computePool.js`，学生 × 课包、四种模态共用一个上限）；
   **积分系统已整体删除**。课包留空预算 = 不限制，只记账。
7. **教师只看得到自己创建的课堂**（课包库全机构可见）；机构管理员看全机构。
   这条是**安全相关**的：改数据范围之前先跑 `scripts/p69-teacher-data-scope.mjs`。
8. **班级那三张表是历史表**（`classes` / `class_members` / `class_curriculum_items`）：
   保留数据与 DDL，**不再被读写**。旧 `/api/org/classes/*` 已全部下线。

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
node .tmp/smoke-run.mjs                    # 全量 85 个守卫（别用 bash 的 timeout，Windows 上杀不掉子进程）
node scripts/p70-pages-render.mjs          # 三端页面真渲染 —— 改前端之后必跑（能拦白屏）
node scripts/p66-student-grant-gate.mjs    # 进课三层门禁
node scripts/p69-teacher-data-scope.mjs    # 教师数据范围（安全相关改动）
node scripts/p73-session-migration.mjs     # 课堂表迁移（在有数据的库上真跑）
node scripts/p74-session-scope-columns.mjs # 范围字段必须被写入 + 回填只按证据
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
| `docs/项目重梳理-03-平台侧重做梳理.md` | 设计口径（三端各板块该有什么、算力总控怎么做） |
| `docs/项目重梳理-01-决策基线.md` | 早期产品决策（部分章节已被本文件覆盖） |
| `docs/architecture/代码结构与路由.md` | 代码放哪儿、接口有哪些 |
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

**没动的**
- 上面「保留待决策」以外的后端接口逐个核过：其余无调用方的接口要么被守卫使用（`guard-only`，
  不能删），要么是**模板字符串动态拼**出来的（自动化扫描会误判为死代码，例如
  `/api/public/works/:token`、`/api/org/sessions/:id`、`/api/admin/billing-config/modalities/:code`）。
