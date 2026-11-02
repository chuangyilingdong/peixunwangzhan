# 客户端问题反馈平台接收 Spec

- 状态：实现中（2026-11-02）
- 范围：`packages/database`、`apps/server`、`apps/admin`
- 客户端契约：灵动ai 客户端 `docs/specs/lingdong-client-feedback.md`

## 1. 目标

接收灵动ai 桌面客户端的问题反馈，并只在平台管理后台展示和处理。机构端和老师端不得读取这些记录。

## 2. 数据所有权

- `client_feedback`：客户端反馈工单唯一事实，包含提交人、类型、严重度、模块、环境快照、状态和处理结果。
- `client_feedback_attachments`：工单附件关联表。
- `client_feedback_messages`：用户补充说明与平台回复。
- `file_assets`：附件字节和文件访问权限唯一所有者。

## 3. 不变量

1. 客户端反馈只写 `client_feedback`，不写机构 `help_feedback`。
2. 机构 `/api/org/help-feedback` 不查询 `client_feedback`。
3. 平台后台接口统一要求平台管理员权限。
4. 相同 `(user_id, idempotency_key)` 只能产生一条工单。
5. 附件必须关联到当前用户拥有的工单；平台管理员可下载，其他用户不可访问。
6. 状态只允许 `SUBMITTED -> IN_PROGRESS -> RESOLVED -> CLOSED`，处理结果写回同一行。

## 4. 事件顺序

```text
客户端 POST /api/client-feedback
  -> 校验平台登录与幂等键
  -> 插入 client_feedback(SUBMITTED)
  -> 返回稳定工单 ID

客户端 POST attachments
  -> 校验工单归属
  -> file_assets 保存附件（PRIVATE）
  -> client_feedback_attachments 建立关联

平台管理员 GET /api/admin/client-feedback
  -> 只读平台聚合列表
  -> 详情读取环境、附件、消息
  -> PUT 状态与处理结果
```

## 5. 接口

### 客户端

- `POST /api/client-feedback`
- `GET /api/client-feedback`
- `GET /api/client-feedback/:id`
- `POST /api/client-feedback/:id/messages`
- `POST /api/client-feedback/:id/attachments`
- `GET /api/client-feedback/:id/attachments/:attachmentId/download`

### 平台后台

- `GET /api/admin/client-feedback`
- `GET /api/admin/client-feedback/:id`
- `PUT /api/admin/client-feedback/:id`
- `POST /api/admin/client-feedback/:id/messages`

平台后台接口挂 `ADMIN_CONTENT` 权限。

## 6. 失败语义

- 未登录：401，不创建工单。
- 非本人工单：404，避免泄漏存在性。
- 幂等键冲突：返回已有工单。
- 附件写入失败：不建立附件关联行，工单仍存在。
- 状态非法：400。
- 机构账号访问平台后台：403。

## 7. 验收

1. 学生提交反馈后平台后台可见，机构端不可见。
2. 相同幂等键重复提交只产生一条记录。
3. 平台后台可查看客户端版本、系统、架构、设备标识、模型上下文。
4. 日志附件可由平台管理员下载。
5. 管理员处理状态可在客户端“我的反馈”读取。
6. 冒烟脚本覆盖提交、幂等、附件、平台列表、处理回显和机构隔离。
## 8. 发布与迁移

- SQLite 由 `packages/database/src/schema.js` 自动建表。
- 生产 MySQL 使用 `deploy/production/migrate/48-client-feedback-mysql.sql`。
- 平台服务端和后台先发布，再发布客户端反馈适配器；客户端未切换前继续走原 ZCode 反馈链路。
- 回滚只停止客户端平台反馈模式；已写入的 `client_feedback` 数据保留，不回迁到 `help_feedback`。

## 9. 验证

- `pnpm test:client-feedback`：提交、幂等、附件、平台列表/详情、回复、处理回显、机构隔离。
- `pnpm build`：平台管理后台可构建。
