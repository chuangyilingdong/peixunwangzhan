# P9-D00 旧线上环境只读盘点与替换发布方案

- 日期：2026-09-04
- 状态：已完成（2026-09-04 用户授权免备份直接清除旧站，清理与回归通过）
- 服务器：`39.106.183.200`（`iicili.cyou`）
- 证据：`evidence/p9-d00-20260904/readonly-inventory-redacted.txt`
- 可重复脚本：`scripts/p9-d00-readonly-inventory.sh`
- 边界：未读取、复制、迁移或写入任何数据库文件内容；未读取 `.env` 内容；未修改服务器状态。

## 1. 当前服务与端口

| 项目 | 旧站 | 新平台内测 |
|---|---|---|
| systemd | `learning-platform.service`，active / enabled | `learning-platform-internal-test.service`，active / enabled |
| 运行用户 | `root` | `ai-kids-test` |
| API | `127.0.0.1:8787` | `127.0.0.1:8788` |
| API 目录 | `/opt/learning-platform/server/learning-platform-server.mjs` | `/srv/ai-kids-platform/internal-test/current/apps/server/src/index.js` |
| 环境文件 | `/opt/learning-platform/.env`（内容未读取） | `/etc/ai-kids-platform/internal-test.env`（内容未读取） |
| 前端 | `/opt/learning-platform/dist` | 四端 release 目录 |
| 当前 health | `/health` 返回 404（`接口不存在`） | `/health` 返回 `status=ok` |

公网只由 Nginx 监听 `80/443`；`8787/8788` 均未直接暴露。内测站点健康探测 timer 每分钟运行。

## 2. Nginx 现状

- 当前启用配置：`/etc/nginx/sites-enabled/iicili.cyou`，来源为 `/etc/nginx/sites-available/iicili.cyou.internal-test`。
- 80 端口 301 到 HTTPS；HTTPS 证书来自 `/etc/letsencrypt/live/iicili.cyou/`。
- `/api/` 代理 `127.0.0.1:8788`；`/admin/`、`/org/`、`/student/` 和官网分别指向内测 release。
- 保留 `noindex, nofollow, noarchive`、`X-Internal-Test: true`、`robots.txt Disallow: /`、`sitemap.xml 404`。
- 旧站配置备份存在：`iicili.cyou.legacy-20260903T172106Z`、`iicili.cyou.enabled-backup-20260903T172106Z` 等。

## 3. 数据与备份现状

- 旧站 SQLite：`/opt/learning-platform/server/data/learning-platform.sqlite`，仅 **4096 字节**，最后修改 **2026-09-01 18:28:50**。本轮仅记录元数据，未读取内容。
- 内测数据库：`/srv/ai-kids-platform/internal-test/data/platform.db`，约 888832 字节；已有 3 份发布前备份。
- 内测备份目录均包含 release、日志和 `platform.db`，并有 `MANIFEST.json`。
- Nginx 配置已有 3 份 2026-09-04 备份。
- 尚未对旧站完整目录、systemd unit、Nginx legacy 配置和 `.env` 做替换前归档。
- 磁盘剩余约 34G，足够先做本机归档；仍建议后续增加异机 / 对象存储备份。

## 4. 风险盘点

1. **旧服务以 root 运行**：`learning-platform.service` 使用 `User=root`，源码目录大量 `0777` 目录 / `0666` 文件，不满足生产最小权限。
2. **旧 API 无统一健康检查**：8787 `/health` 当前 404，替换前无法用它做自动健康判据。
3. **旧库极小且未更新**：4KB SQLite 很可能是初始化空库，不能据此认为旧站无业务数据；仍必须先完整备份再删除。
4. **当前 Nginx 已指向新平台**：`iicili.cyou` 已由内测新平台接管，旧站配置保留但未启用。替换风险主要是删除旧目录时破坏可回滚证据，而非路由切换。
5. **旧 `.env` 与源码可能含密钥**：盘点只记录存在性；备份时需加密、限权，并禁止进入 Git。
6. **Basic Auth 已解除**：正式公开前必须恢复访问控制，或完成正式公开决策与安全加固。

## 5. 建议的目标生产布局

- 生产服务：`learning-platform-production.service`
- 生产 root：`/srv/ai-kids-platform/production/`
- release：`/srv/ai-kids-platform/production/releases/<timestamp>/`
- `current`：原子软链接
- 数据：独立系统用户运行；数据库、上传文件、日志分别独立目录并最小权限
- 配置：`/etc/ai-kids-platform/production.env`
- Nginx：`iicili.cyou.production`，保留 HTTPS、SPA、API 代理、安全头、访问日志与缓存策略
- 旧站归档：`/srv/ai-kids-platform/legacy-archive/<timestamp>/`，只读保存，不直接删除

## 6. 实际执行记录（2026-09-04）

1. **冻结窗口**：确认无内测人员正在操作，公告内测短暂停机。
2. **替换前完整备份**：
   - `/opt/learning-platform`（排除 `node_modules`、构建缓存；包含源码、dist、配置、数据库文件本体）
   - `/etc/systemd/system/learning-platform.service`
   - `/opt/learning-platform/.env`（单独限权加密备份）
   - Nginx legacy 配置与当前有效配置
   - 记录 SHA256 与备份清单。
3. **验证备份可读**：检查 tar 完整性、清单条数、哈希一致；密钥备份单独验证可解密但不输出内容。
4. **建立生产布局**：创建 production 用户、目录、环境文件与 systemd hardening。
5. **发布新平台生产 release**：沿用内测 release 机制，执行构建、上传、健康检查、原子切换。
6. **切换 Nginx**：生成 production 配置，`nginx -t` 后 reload，验证官网、四端入口、API、安全头。
7. **停用旧服务**：确认新生产健康后 `disable --now learning-platform`，不立即删除数据。
8. **观察期**：30～60 分钟日志与健康监测；失败执行回滚。
9. **归档旧站**：观察期通过后移动或压缩至 legacy archive，至少保留一个发布周期。
10. **正式公开前闸门**：恢复 Basic Auth / VPN / IP 白名单，或按正式公开方案补齐安全、合规、容量与监控。

## 7. 回滚方案

- Nginx：恢复 legacy 配置或当前内测配置备份，`nginx -t` + reload。
- API：`systemctl start learning-platform`（8787）。
- 新平台生产：切换 `current` 到上一 release，重启 production 服务。
- 数据：旧库备份只读恢复，不做反向合并；内测库与新生产库保持隔离。

## 8. P9-D00 验收状态

- [x] 只读盘点脚本与脱敏证据已入库。
- [x] 服务、端口、systemd、timer、Nginx、目录、备份、数据库元数据已清点。
- [x] 替换发布方案、风险清单与回滚方案已形成。
- [x] 用户已于 2026-09-04 明确拒绝旧站备份并授权直接清除；旧站完整备份按用户决策不执行。
- [ ] 生产目录、systemd、Nginx production 配置尚未创建。
- [x] 旧站清除与公网复验已于 2026-09-04 完成（6/6）；新平台回滚能力继续由内测 release 机制提供。

## 9. 原待确认事项（已被第 10 节用户决策覆盖）

1. 是否按第 5 节目标布局建立 production 环境？
2. 是否批准第 6 节第 2 步的旧站完整备份（包含 `.env` 与数据库文件本体，备份后限权加密）？
3. 替换窗口选择：现在执行，还是先保持内测站点继续观察？

## 10. 2026-09-04 用户决策与清除结果

- 用户决策原文：“旧站的备份我不需要，直接清除即可，然后进行下一步”。本决策免除第 6 节原建议的旧站备份要求。
- 实际执行前复验：`learning-platform-internal-test` active；`current -> /srv/ai-kids-platform/internal-test/releases/20260904T113559Z`；enabled Nginx 配置无 `/opt/learning-platform` 引用。
- 清除内容：`learning-platform.service`（stop / disable / 删除）、`/opt/learning-platform`、三份旧 Nginx 配置副本。
- 保留内容：`/etc/nginx/sites-enabled/iicili.cyou`、`/etc/nginx/sites-available/iicili.cyou.internal-test`、新平台 release / 数据库 / systemd / timer。
- 清除后验证：`daemon-reload` 与 `nginx -t` 通过；旧服务 inactive；8787 关闭；8788 仅回环监听；`/health=ok`；官网 / admin / org / student / API 安全头回归 **6/6 通过**。
- 不可回滚边界：旧站源码、`.env`、旧 SQLite 与旧 Nginx 配置副本已删除且无备份，不能恢复旧站；后续不得宣称已备份旧站或可回滚到旧站。
