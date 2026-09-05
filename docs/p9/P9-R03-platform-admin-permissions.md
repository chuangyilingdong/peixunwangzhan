# P9-R03 平台管理员权限逐域收紧

更新时间：2026-09-05

## 当前状态

- 状态：`[x]` 本地功能开发与专项测试完成，尚未生产发布；统一核验后置。
- 交付策略：本轮只开发功能；机构交付、平台权限、API、页面和生产环境统一核验后置。
- 数据边界：不修改生产数据库，不读取、记录或输出生产密码。

## 权限域

| 权限码 | 覆盖范围 | 平台管理台入口 |
|---|---|---|
| `ADMIN_ORGANIZATIONS` | 机构、平台用户 | `/organizations`、`/users` |
| `ADMIN_COURSES` | 平台课程、课程广场 | `/courses`、`/marketplace` |
| `ADMIN_WORKS` | 作品、举报与作品数据 | `/works` |
| `ADMIN_BILLING` | 计费、模型、额度和账务 | `/billing` |
| `ADMIN_CONTENT` | 通知、物料、官网内容、客户端、站内信、商机等运营内容 | `/materials`、`/website-content`、`/notifications`、`/client-releases`、`/inbox`、`/leads` |
| `ADMIN_ANALYTICS` | 平台概览、转化与用量分析 | `/dashboard`、`/analytics` |
| `ADMIN_FEATURE_FLAGS` | Feature Flag 配置 | `/feature-flags` |
| `ADMIN_AUDIT` | 平台管理员与操作审计 | `/admins`、`/audit` |

## 服务端实现

- `platformPermissionForPathname()` 将 `/api/admin/*` 路径映射到唯一业务域；未显式登记的管理 API 默认进入 `ADMIN_CONTENT`，避免新增接口因忘记授权而意外按角色放行。
- `requirePlatformPermission()` 先校验 `SUPER_ADMIN`，再校验权限码；拒绝统一为 HTTP 403 / `PERMISSION_DENIED`，响应 details 仅返回所需权限码。
- `root` 账号永远保留完整八域权限；拥有全部八个权限码或 `*` 的管理员也视为全量管理员。
- 更新平台管理员时，禁止自己停用；停用最后一个有效管理员，或清空最后一个有效管理员全部业务域权限，均返回 `LAST_SUPER_ADMIN_FORBIDDEN`。
- 既有平台管理员的空权限数组不再代表全量权限；只有默认 `root` 账号保留兼容性全量访问。

## 前端实现

- 菜单项携带业务域权限码，无权限项和空分组隐藏。
- 直接打开无权限页面时不加载业务数据，展示“暂无访问权限”和所需权限码。
- 平台管理员编辑页仅展示八个正式权限码，并说明接口会同步执行服务端权限校验。

## 专项测试计划

1. 每个权限码允许矩阵：具备单域权限的管理员只能访问对应业务域。
2. 拒绝矩阵：跨域 API 返回 403 `PERMISSION_DENIED`，未知管理 API 不回退为角色全量放行。
3. 边界保护：自己停用、最后一个有效管理员停用、最后一个有效管理员清空权限。
4. 审计：权限修改写入 `PLATFORM_ADMIN_UPDATE`，包含权限前后值；拒绝请求不写入业务变更审计。
5. 回归：root 完整权限、登录 / `/api/me`、四端构建，均不涉及生产数据库。

## 本轮完成记录

- 代码变更：`apps/server/src/lib.js`、`apps/server/src/index.js`、平台管理路由、平台管理台页面及专项脚本。
- `node scripts/p9-r02-feature-flags.mjs`：Feature Flag 隔离矩阵 `3/3` 通过。
- `node scripts/p9-r03-platform-permissions.mjs`：八域允许 / 拒绝、跨域、未知管理 API 默认域、root、自己停用、最后管理员保护、审计记录通过。
- 四端 `pnpm build`：admin、org、student、website 全部通过；其中 org / student 保留既有 chunk 大小告警，不影响构建成功。
- `git diff --check`：通过（仅提示既有文件 CRLF/LF 转换警告）。
- 生产发布、生产数据库修改和统一机构交付核验：本轮明确不执行。
