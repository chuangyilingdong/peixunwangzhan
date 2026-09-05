# P10 文件 / 媒体安全上传专项

日期：2026-09-05
状态：开发中（本轮先开发，不修改生产数据库、不直接发布）

## 目标

为平台、机构和后续媒体业务提供统一的安全上传入口，避免把用户文件直接写入 Web 根目录或直接信任客户端提供的 MIME 类型。

## 已开始实现

- `POST /api/admin/file-assets/upload`：平台管理员上传入口，受 `ADMIN_CONTENT` 权限码保护。
- `POST /api/org/file-assets/upload`：机构管理员上传入口，强制机构范围。
- `multipart/form-data` 原始请求体大小限制，默认 25 MB，最大可配置上限 100 MB。
- 文件名规范化及路径穿越、防双扩展名、危险扩展名拦截。
- MIME 类型、扩展名和文件签名三重校验；拒绝 SVG、可执行文件和签名不匹配文件。
- 随机 UUID 存储键，按 UTC 年/月分层；存储根目录通过 `FILE_UPLOAD_ROOT` 配置，默认不在 Web 根目录内。
- SHA-256 校验和和内置文件签名结果写入 `file_assets.metadata.upload.security`。
- 上传行为写入审计事件 `FILE_UPLOAD`；拒绝、恶意命中和扫描失败写入 `FILE_UPLOAD_REJECTED`，并沿用 `file_access_grants` 做访问范围控制。
- `INTERNAL_PROXY` 下载先执行授权，再从 `FILE_UPLOAD_ROOT` 流式输出；校验存储键不越界，返回安全 `Content-Disposition`、`nosniff`、私有缓存头并支持单 Range。
- 文件名拒绝 NUL、控制字符、路径分隔符、盘符和双点；补充 WebP / OGG 文件签名识别。
- 可配置 ClamAV：`FILE_UPLOAD_SCANNER=/usr/bin/clamscan`；`NODE_ENV=production` 默认 fail-closed，扫描器未配置、不可用或扫描失败均拒绝上传。开发环境无扫描器时仅使用内置签名校验并标记 `BUILTIN_ONLY`。
- Nginx `client_max_body_size` 与默认 25 MB 文件限制保持一致（26 MB 预留 multipart 开销）；上传目录必须位于 Web root 外。

## 接口约定

上传字段：

- `file`：唯一文件字段，必填。
- `category`：可选，默认 `MEDIA_ASSET`。
- `visibility`：平台默认 `PRIVATE`，机构默认 `ORG`；机构只能使用 `PRIVATE`、`ORG`、`ASSIGNED_ORGS`。
- `audience`：`ASSIGNED_ORGS` 时传 JSON，例如 `{"orgIds":["org_xxx"]}`。
- `expiresAt`：可选 ISO 时间。

上传成功后创建 `file_assets` 元数据，`storage_kind=INTERNAL_PROXY`，不返回真实磁盘路径；后续下载必须继续经过授权代理。

## 待完成

1. 增加上传频率、并发数和按用户/机构配额限制。
2. 增加前端上传组件和进度、失败提示。
3. 增加专项测试：MIME/扩展名/签名、空文件、超限、路径穿越、恶意扩展名、跨机构访问、审计、清理失败。
6. 更新生产环境变量、Nginx 私有路径规则和上线运行手册。

## 验收标准

- 不信任客户端 MIME；服务端签名校验必须通过。
- 任何用户输入都不能影响最终存储路径。
- 上传目录不可被 Nginx 直接列目录或执行脚本。
- 无权限访问返回统一 `FILE_ACCESS_DENIED` / `403`。
- 上传成功、拒绝、扫描命中和删除均可在审计中追溯。
- 本专项完成前不发布生产，不修改生产数据库中的业务数据。
