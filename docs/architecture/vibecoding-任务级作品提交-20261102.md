# VibeCoding 作品按「任务」提交（平台侧已实现 · 2026-11-02）

> 给客户端的接入说明。平台侧代码、迁移、守卫都已完成；客户端按本文改完并发版即可。
> 关联守卫：`scripts/p202-client-task-submit.mjs`（10 条断言全绿）。
> 关联迁移：`deploy/production/migrate/49-vibecoding-task-submit-mysql.sql`。

## 一句话

平台现在支持 `POST /api/student/runtime/submit-upload` 多带一个可选的 `taskId`：

- **不同任务**产出的作品 → 各自成条（哪怕入口都叫 `index.html`）；
- **同一个任务**重复提交同一入口 → 仍是覆盖（`round + 1`）；
- **老客户端不传 `taskId`** → 空串任务，行为与改动前**完全一致**。

判重键从 `(conversation_id, entry_file)` 升级为 `(conversation_id, client_task_id, entry_file)`。

## 平台侧改了什么

### 数据

- `vibecoding_submissions` 新增 `client_task_id VARCHAR(200) NOT NULL DEFAULT ''`。
- 唯一索引换成 `idx_vibe_submission_conversation_task_entry (conversation_id, client_task_id, entry_file)`。
- 老数据全部回填空串，原来的两列唯一性仍然成立，不需要清洗数据。

### 接口

`POST /api/student/runtime/submit-upload` 的 body 新增可选字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `taskId` | `string` | 客户端当前任务 id；trim 后 1~200 字符。不传 / 空串 = 老行为。超长返回 `400 VIBECODING_TASK_ID_TOO_LONG` |

返回值新增 / 回显：

- 提交响应顶层：`taskId`
- 提交响应 `works[]` 的每一条：`taskId`
- `GET /api/student/works` 的 VIBECODING 条目：`taskId`
- `GET /api/student/vibecoding/submissions` 的每一条：`taskId`

网页端老的 `/api/student/vibecoding/conversations/:id/submit` 固定用空串任务，
不会误碰客户端按任务交上来的作品。

### 语义表

| 场景 | 结果 |
|---|---|
| 同一任务 + 同一入口，重复提交 | 同一件作品，`round + 1`（覆盖） |
| 不同任务 + 同名入口（都叫 `index.html`） | **两件作品，两个 id** |
| 不同任务 + 不同入口 | 两件作品 |
| 同一任务 + 不同入口（一个任务产出两个可提交文件） | 两件作品（平台支持，产品上可只交一件） |
| 老客户端不传 `taskId` | 空串任务；同名入口仍按老规则覆盖 |

## 客户端需要做的（按优先级）

### 1. 把当前任务 id 带上来（必须）

- 取当前任务：ZCode 的 `activeTaskId`（`taskId` 与 agent `sessionId` 一致，重启/恢复会话不变）。
- 草稿态（还没发第一条消息）没有 taskId：可以先不传（走老行为），或用 `draftSessionId` 作为临时 id；推荐**发过消息之后才允许提交**，避免草稿 id 与真正任务 id 不一致。
- `submitWork` payload 增加 `taskId`，Main 原样放进 `submit-upload` 的 body。平台只认字段名 `taskId`。
- 必须是稳定 id：不要用任务标题、时间戳、文件 mtime 拼。

### 2. 本地提交指纹的 key 要带任务（必须）

当前客户端把「已提交」状态按 `workspaceIdentity + entryRelativePath` 存
（`packages/desktop/src/main/lingdongPlatformGate.ts` 的 `readSubmissionRecord` / `writeSubmissionRecord`）。
两个任务都叫 `index.html` 时会共享同一条「已提交」状态，导致：

- B 任务提交后，A 任务也显示「已提交，无新产出」；
- 或者反过来，A 改了文件却因为 key 命中而不让交。

改成 `taskId + entryRelativePath`（没有 taskId 时退回原 key）。

### 3. 平台兜底匹配要带任务（必须）

`findLatestPlatformSubmission` 现在按 `entryFile + classSessionId` 匹配最近一次提交。
平台已经回传 `taskId`，请把匹配条件加上 `taskId`，否则同名入口的两个任务会互相误判「交过了」。

### 4. 默认标题建议用任务标题（建议）

平台现在的默认标题来自会话（`创作环境`），而客户端当前传的是 `title: entry.name`。
两个任务都交 `index.html` 时，学生主页会出现两件都叫 `index.html` 的作品。
建议客户端把 `title` 设成任务标题（例如「排查 Intel Mac 侧栏预览」），学生一眼能分清。

### 5. 入口选择（建议）

最小改动：保留「取最近修改的可提交入口」，但**只在当前任务写过的文件里取**。
ZCode 每个任务都持久化了 `fileChanges`（`ZCodeSessionFile.fileChanges`）：

- 过滤 `fileState === 'applied'`；
- 只看 `.html / .htm / .docx / .xlsx / .pptx`；
- 取其中最新写入的一个作为主作品，引用素材仍由 `resolveSubmitPlan` 自动打包。

更稳的做法：面板里列出当前任务的可提交入口，让学生选；一个任务产出多个入口时，
按产品口径只交一个，或逐个提交（平台会各自成条）。

### 客户端代码落点（当前 0.2.11 版本，供参考）

1. `packages/shared/src/platform.ts` 的 `ClassroomWorkSubmission` 增加可选 `taskId?: string`。
2. `packages/ui/src/WorkspaceSidebarFooter.tsx` 已有 `activeTaskId`（约 115/135 行），
   传给对话框：`<LingdongWorksDialog ... activeTaskId={activeTaskId} />`。
3. `packages/ui/src/LingdongWorksDialog.tsx` 提交时：
   ```ts
   await classroom.submitWork({
     copyrightConfirmed: true,
     taskId: activeTaskId ?? undefined,
     items: [{ path: preview.entry.path, name: preview.entry.relativePath }],
   });
   ```
4. `packages/desktop/src/main/lingdongPlatformGate.ts` 的 `submitWorkFromDesktop`：
   ```ts
   if (typeof input.taskId === "string" && input.taskId.trim()) {
     body.taskId = input.taskId.trim().slice(0, 200);
   }
   ```
   本地指纹的 key 改成带任务：
   ```ts
   const recordKey = `${taskId}\u0000${prepared.entryRelativePath}`;
   ```
5. `findLatestPlatformSubmission` 的匹配加一条：
   ```ts
   if (taskId && String(item.taskId || "") !== taskId) continue;
   ```

## 必须提前知道的边界

1. **同名文件在磁盘上会互相覆盖。** 两个任务都在工作区根目录写 `index.html` 时，
   后跑的任务已经把前一个覆盖了。平台只能收「提交那一刻磁盘上的内容」，
   拿不到被覆盖的旧版本（`fileChanges` 里有文本历史，但图片/视频等二进制恢复不了）。
   要彻底支持「两个同名产物都保留」，需要客户端在任务结束时把产物快照到任务目录，
   或约定不同任务用不同文件名/子目录。
2. **任务间互相编辑。** 任务 B 改了任务 A 的入口文件时，两个任务都会在 `fileChanges` 里
   认领同一文件。建议归属规则：按入口文件的**最后写入任务**归属，或让学生选。
3. **`fileChanges` 是文本快照。** Bash 生成的文件不计入；自动归属只能当「候选提示」，
   不能当唯一真相。提交前仍以磁盘上的实际文件为准。
4. **taskId 是客户端本地的。** 换机器、清应用数据后，同一逻辑任务会变成新 id → 新作品。
   如果要求跨机器稳定，需要客户端另做「任务 ↔ 平台作品」的映射并把映射存到平台；
   当前版本不要求。

## 联调顺序

1. 平台先执行迁移 `49-vibecoding-task-submit-mysql.sql`，再发版（新列 + 新索引就位）。
2. 客户端发带 `taskId` 的版本。
3. 验收：
   - 同一工作区、任务 A 交 `index.html`，任务 B 再交 `index.html` → 学生主页/广场看到 **2 件**；
   - 任务 A 再交一次 → 仍是 **1 件**，`round` 变成 2；
   - 老版本客户端（不传 taskId）提交 → 行为与现在一致。
4. 平台守门：`node scripts/p202-client-task-submit.mjs`。

### 上线 checklist（平台侧）

- [ ] 备份 `vibecoding_submissions`（`mysqldump`）。
- [ ] 执行 `49-vibecoding-task-submit-mysql.sql`（幂等，可重复跑）。
- [ ] `SHOW COLUMNS ... LIKE 'client_task_id'` 有值；`SHOW INDEX` 能看到三列唯一索引、看不到旧两列索引。
- [ ] 再发版（顺序不能反）。
- [ ] 发版后跑 `p202` / `p119` / `p94`（仓库根目录，Node 版本按 `.nvmrc`）。

## 请求 / 响应示例

请求：

```http
POST /api/student/runtime/submit-upload
Authorization: Bearer <学生 token>
Content-Type: application/json

{
  "name": "index.html",
  "title": "任务：打地鼠",
  "taskId": "3f2c9a1e-....",
  "copyrightConfirmed": true,
  "files": [
    { "name": "index.html", "content": "<!doctype html>...", "binary": false }
  ]
}
```

响应（节选）：

```json
{
  "id": "vibesub_...",
  "entryFile": "index.html",
  "taskId": "3f2c9a1e-....",
  "round": 1,
  "works": [
    { "id": "vibesub_...", "taskId": "3f2c9a1e-....", "entryFile": "index.html" }
  ]
}
```

## 平台侧改动文件

- `packages/database/src/schema.js` —— 新列 + 三列唯一索引（SQLite/开发/测试）。
- `deploy/production/migrate/12-sqlite-to-mysql-ddl.mjs` —— 索引列宽度覆盖（空库也生成 `VARCHAR(200)`，与界面/接口上限一致）。
- `apps/server/src/routes/studentRuntime.js` —— 解析并校验 `taskId`。
- `apps/server/src/routes/vibecoding.js` —— 判重、落库、`normalizeSubmission` / `vibecodingWorkItem` 回传 `taskId`。
- `deploy/production/migrate/49-vibecoding-task-submit-mysql.sql` —— 生产 MySQL 迁移。
- `scripts/p202-client-task-submit.mjs` —— 守卫（不同任务同名入口 / 同任务覆盖 / 老客户端兼容）。
