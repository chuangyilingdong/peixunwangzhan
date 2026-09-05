# P9-R02 Feature Flag 灰度 / 白名单能力

更新时间：2026-09-05

## 当前状态

- 状态：`[~]` 本地功能开发完成，尚未生产发布与统一核验。
- 交付策略：本轮先做功能，跳过张老师机构的再次核验；所有功能完成后统一核验。
- 约束：默认不启用任何新业务；不读取、不记录或输出生产密码。

## 已实现

### 服务端

- `feature_flags` 表：`flag_key`、名称、说明、总开关、默认开关、稳定灰度比例、机构白名单、用户白名单、创建 / 更新审计字段。
- `GET /api/feature-flags`：要求登录，返回当前用户可见的布尔判定结果。
- 平台超管管理接口：
  - `GET /api/admin/feature-flags`
  - `POST /api/admin/feature-flags`
  - `PATCH /api/admin/feature-flags/:key`
  - `DELETE /api/admin/feature-flags/:key`
- 判定顺序：总开关关闭直接返回 false；否则用户白名单 → 机构白名单 → 默认开关 → 基于 `sha256(flagKey:subject)` 的稳定灰度。
- 输入限制：key 格式与长度、名称长度、灰度比例 `0..100`、白名单最多 500 项；非法输入拒绝。
- 创建、修改、删除写入 `audit_logs`，动作分别为 `FEATURE_FLAG_CREATE`、`FEATURE_FLAG_UPDATE`、`FEATURE_FLAG_DELETE`。

### 平台管理台

- 新增“灰度开关”导航页。
- 支持创建、编辑、删除和刷新。
- 支持机构 ID / 用户 ID 每行或逗号分隔录入。
- 页面明确提示：配置开关不会自动接入真实 AI、支付或公开作品。

## 本地验证记录

- Node v24.19.0：服务端、数据库和路由语法检查通过。
- `node scripts/p9-r02-feature-flags.mjs`：隔离 SQLite 的创建、机构白名单命中、总开关关闭矩阵 3/3 通过。
- `pnpm build`：admin / org / student / website 四端构建通过。
- `git diff --check`：通过。

## 待办与统一核验

1. 在统一核验批次中补充平台超管权限、接口参数边界、机构 / 用户命中矩阵和删除后结果。
2. 确认具体业务接入点后，再逐个把真实 AI、支付、公开作品等能力接入 Flag；接入前保持关闭。
3. 生产发布前备份数据库、执行迁移检查、发布后检查健康状态与回滚路径。
4. 完成生产发布和统一核验后，再将本项从 `[~]` 更新为 `[x]`。
