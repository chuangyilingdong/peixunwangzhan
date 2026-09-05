# 生产环境运行手册

## 当前架构

- 域名：`https://iicili.cyou`
- 服务：`learning-platform-production`
- API：`127.0.0.1:8789`，仅回环；生产 env 必须设置 `API_HOST=127.0.0.1`
- 数据库：`/srv/ai-kids-platform/production/data/platform.db`
- 回滚路径：`learning-platform-internal-test`（8788，切换后停止并禁用，不删除）

## 启停与健康检查

```bash
sudo systemctl status learning-platform-production --no-pager
sudo systemctl restart learning-platform-production
curl -fsS http://127.0.0.1:8789/health
```

## 日志

```bash
sudo journalctl -u learning-platform-production -n 200 --no-pager
sudo journalctl -u learning-platform-production --since '30 min ago' --no-pager
tail -100 /srv/ai-kids-platform/production/logs/monitoring-health.log
```

## 备份与恢复

```bash
PATH=/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin:$PATH bash /srv/ai-kids-platform/internal-test/source/deploy/production/backup-production.sh
bash /srv/ai-kids-platform/internal-test/source/deploy/production/rollback-production.sh \
  --release /srv/ai-kids-platform/production/releases/<known-good>
```

## 每日备份与恢复演练

```bash
systemctl list-timers --all | grep ai-kids-platform-production-daily-backup
cat /srv/ai-kids-platform/production/state/last-backup-state.json
bash /srv/ai-kids-platform/production/bin/daily-backup.sh
bash /srv/ai-kids-platform/production/bin/restore-drill.sh
```

- 每日 03:00 Asia/Shanghai 自动备份，保留 14 天；timer 为 `ai-kids-platform-production-daily-backup.timer`。
- 备份必须通过 SHA256 与 SQLite `integrity_check`，状态写入 `production/state/last-backup-state.json`。
- 恢复演练只使用隔离目录与 `127.0.0.1:18789`，结束必须释放端口；不得覆盖生产库或停生产服务。
- 每月至少执行一次真实备份恢复演练，并把结果追加到 P9 运维记录。

## 最小告警

`ai-kids-platform-production-healthcheck.timer` 每分钟执行 `monitoring-healthcheck.sh`，检查：

1. API：`http://127.0.0.1:8789/health` 失败即 failed。
2. 磁盘：使用率 ≥80% 即 failed。
3. 证书：`/etc/letsencrypt/live/iicili.cyou/fullchain.pem` 14 天窗口失效即 failed。
4. 备份：最新成功备份超过 26 小时或状态非 ok 即 failed。

状态 JSON 写入 `production/state/last-alert-state.json`，人类可读日志写入 `production/logs/monitoring-health.log`。当前最小告警只保证失败可被 systemd 状态与 journal 检出；外部短信 / 飞书 / 邮件推送尚未接入，不得宣称 7x24 有人值守。

## 敏感路径只读复核

在具备生产公网访问的 Node 24 环境执行；该检查只发起 GET，不登录、不写库、不输出响应体：

```bash
cd /srv/ai-kids-platform/internal-test/source
node scripts/p9-live-security-smoke.mjs
```

`/server.js`、`/package.json`、`/apps/`、`/packages/`、`/node_modules/`、`/scripts/`、`/deploy/`、`/.env` 等必须返回 404；`/api/health` 必须返回 200，入口安全头必须存在。若任一路径返回 200，先不要标记 P9-D05 完成，按 Nginx 变更窗口处理并保留变更前配置备份。
## 公网验收

在服务器 Node 24 环境执行：

```bash
cd /srv/ai-kids-platform/internal-test/source
node scripts/verify-production-entrypoints.mjs --mode public
```

验收必须包含四端页面、标题、登录文案、资源前缀、无 `X-Internal-Test`、非 noindex、无内测横幅、HTTPS 安全头和 `/api/health`。

## 收口生产 Nginx 敏感路径

P9-D05 当前唯一服务器侧遗留是源码 / 配置 / 依赖路径不能回退到 SPA `index.html`。授权运维人员在服务器仓库 checkout 更新后执行：

```bash
cd /srv/ai-kids-platform/internal-test/source
git pull --ff-only origin main
sudo bash deploy/production/apply-nginx-sensitive-path-hardening.sh
```

脚本只修改 `/etc/nginx/sites-enabled/iicili.cyou`，先创建带 UTC 时间戳的备份，再执行 `nginx -t`、reload 和公网 404 冒烟；任一步失败会尝试恢复本次备份。它不修改 release、数据库或 `internal-test` 回滚资产。成功输出 `NGINX_SENSITIVE_PATH_HARDENING_OK` 后，运行：

```bash
node scripts/p9-live-security-smoke.mjs
```

所有敏感路径均为 404 后，才可将 P9-D05 从 `[-]` 更新为 `[x]`。

## 回滚到内测

生产切换失败且需要回到切换前版本时：

```bash
sudo cp /etc/nginx/backups/iicili.cyou.before-production-switch.<stamp> /etc/nginx/sites-enabled/iicili.cyou
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl stop learning-platform-production
sudo systemctl start learning-platform-internal-test
```

若 production 已产生写入，按切换前内测库快照处理数据回滚；原内测库不再覆盖生产库。

## 固定生产检测账号（2026-09-05）

生产环境已保留 4 个检测账号，其他账号已停用并软删除，历史审计与业务关联不物理删除：

| 端 | 登录名 | 角色 | 入口 |
|---|---|---|---|
| 平台端 | `root` | `SUPER_ADMIN` | `/admin/` |
| 机构端 | `org-admin` | `ORG_ADMIN` | `/org/` |
| 教师端 | `teacher-1` | `TEACHER` | `/org/` |
| 学生端 | `student-1` | `STUDENT` | `/student/` |

密码保存在仓库外的本机受限 Markdown 文件：

```text
D:\学习平台\生产检测账号-20260905.md
```

禁止把密码写入仓库、服务器源码、日志或聊天记录。账号变更后，必须更新该本机文件并执行四角色登录与 `/api/me` 验证。

## 事故边界

- 不在日志、文档或对话中输出 `.env`、密码、token。
- 不宣传 `local-mock` 为真实 AI。
- 法律页为准备稿，不代表正式法务结论。
- 举报、申诉、内容审核、监护人功能暂缓。

## 生产真实业务闭环验收（2026-09-05）

已使用固定生产检测账号完成一次可回滚范围内的真实业务验收：

1. 教师创建临时班级；
2. 教师添加学生；
3. 教师为班级分配已授权课时；
4. 教师开启课堂；
5. 学生读取课堂与课程，创建并保存项目；
6. 学生提交作品；
7. 教师查看待批作品、审核并点评；
8. 学生读取审核结果与点评；
9. 教师结束课堂并归档临时班级。

- 结果：**24/24 项检查通过**。
- 验收后备份：`/srv/ai-kids-platform/production/backups/20260905T051314Z/platform.db`。
- 本次验收没有遗留进行中的课堂；已审核作品和项目作为历史验收数据保留，未直接删除生产关联记录。
- 该闭环再次确认：创建班级、加学生、配置课程、开课和课堂反馈均属于教师职责；机构管理员侧保留账号、机构和授权管理职责。

## 账号停用与清除补充

- 机构管理员可以先将教师 / 学生账号停用，再执行删除（软删除）；删除后账号不再出现在机构名册，历史业务关联和审计记录保留。
- 生产回归已验证“已停用账号直接删除”成功；无需先恢复为 ACTIVE。
- 远程备份脚本依赖 Node 运行时，执行前必须把 `/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin` 放入 `PATH`，避免出现 `node: not found`。

## 2026-09-05 生产修复发布记录

- 发布 commit：`04fd0773cf4ed60adf4cee372df6c3b999437808`。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T051622Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T045348Z` 保留可回滚。
- 切换前备份：`/srv/ai-kids-platform/production/backups/20260905T051639Z/platform.db`；账号回归后备份：`/srv/ai-kids-platform/production/backups/20260905T051738Z/platform.db`。
- 变更内容：允许机构管理员删除已经处于 `DISABLED` 状态的成员账号，避免“停用后无法清除”的状态机阻塞；仍为软删除，不物理删除历史数据。
- 发布后：服务 `active`，`/health` 返回 `status=ok`，四端公网入口 4/4 通过，敏感路径安全冒烟 14/14 通过。
- 生产回归：创建临时学生 → 停用 → 直接删除 → 名册不可见，全部通过；临时账号已清理。

## 2026-09-05 教师成员名册页面修复与发布记录

- 发布 commit：`27e71a4b092fadeb9ae50af3b2aa24e657fdc3ce`。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T053145Z`；切换前 release `/srv/ai-kids-platform/production/releases/20260905T051622Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T053201Z/platform.db`。
- 修复内容：教师访问“成员管理”时按 `role=STUDENT` 读取本机构学生名册；教师不获得创建账号、批量导入、停用、删除或机构成员写权限。
- 本地构建：四端 production build 通过；本地教师职责回归 **9/9** 通过。
- 页面级生产回归：机构管理员、教师、学生 **12/12** 通过；教师可查看学生名册但不显示账号创建 / 批量导入区。
- 发布后：服务 `active`，`/health` 正常；四端公网入口 **4/4** 通过；敏感路径安全冒烟 **14/14** 通过。

### 2026-09-05 页面级功能验收闭环

- [x] 机构管理员页面：创建临时学生账号、批量导入临时学生账号（预览 + 整批提交）、重置密码、停用账号，全部通过。
- [x] 教师页面：创建临时班级、加入 `student-1`、配置已授权课时、开始课堂、结束课堂并归档临时班级，全部通过。
- [x] 学生页面：从课堂课时创建项目、打开魔法画布、保存画布版本、回到项目列表并确认版权后提交作品，全部通过。
- [x] 清理收口：本轮 5 个临时账号已通过机构管理员接口软删除；临时验收班级已归档；没有遗留进行中的课堂。已提交作品和项目按状态机保留为历史验收数据，未直接删除生产关联记录。
- [x] 页面级验收时间：2026-09-05 13:49 CST；未修改生产源码、配置或固定检测账号密码。
- [x] 本轮页面功能检查：**12/12 通过**（账号创建、导入预览、导入提交、重置密码、停用、班级创建、加入学生、配置课程、开课、项目创建 / 画布保存、作品提交、结束并归档）。

## 2026-09-05 首页视频加载兜底修复发布记录

- 发布 commit：`1cae22d`（`fix(website): prevent homepage video loader from hanging`）。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T074802Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T070953Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T074822Z/platform.db`。
- 修复内容：首页外部视频加载失败、超时、加载中断或错过媒体事件时，加载遮罩最多 5 秒自动退出；视频不可用时保留首页色块、文案和交互，不再永久停留在 `LOADING SCROLL STREAM...`。
- 发布后：`learning-platform-production` active；`/health` 返回 `status=ok`；四端公网入口验证 **4/4** 通过。
- 首页生产验证：视频资源未及时就绪时两个加载遮罩均自动隐藏，首页不再被加载提示阻塞。

## 2026-09-05 首页首屏静态兜底与快速加载发布记录

- 发布 commit：`470f451`（`fix(website): render fast local homepage fallback`）。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T080206Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T074802Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T080223Z/platform.db`。
- 修复内容：首页首屏改为本地 CSS 静态视觉优先，React 尚未挂载时由 `index.html` boot shell 先显示；外部视频改为 `preload="metadata"` 的渐进增强层，视频未就绪、超时或失败时不遮挡页面、不阻塞文案和交互。
- 发布后：`learning-platform-production` active；`/health` 返回 `status=ok`；四端公网入口验证 **4/4** 通过；敏感路径安全冒烟 **14/14** 通过。
- 首页生产验证：两个 `.ic-video-fallback` 均存在，视频未就绪时首页仍显示导航、标题、按钮和课程卡片；不再依赖外部视频才能出现首屏。

## 2026-09-05 首页动物素材本地化发布记录

- 发布 commit：`4d94efe`（`fix(website): serve local hero animal media`）。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T081523Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T080206Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T081545Z/platform.db`。
- 修复内容：下载并托管首页动物视频到 `/assets/hero-animal.mp4`，同时生成 `/assets/hero-animal-poster.webp`；首页首屏先显示本地动物海报，视频作为本地增强层加载，不再依赖外部 `r2.motionsites.dev`。
- 素材优化：视频去除无用音轨并启用 fast-start，首屏海报约 38 KB，视频约 1.8 MB。
- 发布后：`learning-platform-production` active；`/health` 返回 `status=ok`；生产浏览器确认海报加载完成（1280px 宽），本地视频 `readyState=4`、时长 4 秒。

## 2026-09-05 首页重复兔子图层修复发布记录

- 发布 commit：`bb0cb1b`（`fix(website): hide hero poster after video readiness`）。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T082038Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T081523Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T082109Z/platform.db`。
- 问题原因：本地动物海报和正在播放的视频同时叠加，视频透明度为 72%，导致同一只兔子以两个不同姿势同时出现。
- 修复内容：视频进入 `ready` 状态后自动淡出海报层；视频未就绪或失败时才显示海报层，保证始终只有一个动物视觉层。
- 发布后生产浏览器确认：海报 `opacity=0`、视频 `readyState=4`、本地视频正常播放；生产服务 active，`/health` 正常。

## 2026-09-05 首页第二屏兔子恢复与动画流畅度修复发布记录

- 发布 commit：`bd86a5e`（`fix(website): restore rabbit on manifesto screen`）。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T082806Z`；旧 release `/srv/ai-kids-platform/production/releases/20260905T082038Z` 保留可回滚。
- 切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T082823Z/platform.db`。
- 问题原因：第二屏仍引用外部 `r2.motionsites.dev` 视频，加载失败时此前又移除了粉色 CSS 兜底，因此第二屏只剩背景和文案；首屏兔子卡顿则来自滚动驱动时持续修改 `video.currentTime`，浏览器频繁 seek。
- 修复内容：第二屏改为复用本地 `/assets/hero-animal.mp4` 与 `/assets/hero-animal-poster.webp`，保证兔子素材与首屏一致且不依赖外部域名；首屏改用浏览器原生 `autoplay + loop` 连续播放，停止滚动期间的逐帧 seek；第二屏不再渲染粉色圆形 CSS 兜底图。
- 发布后：生产 `/health` 返回 `status=ok`；四端公网入口验证 **4/4** 通过。

## 文件 / 媒体安全上传（P10）

上传目录必须位于 Web 根目录之外，并由服务账号单独持有：

```bash
sudo install -d -o ai-kids-platform -g ai-kids-platform -m 0750 /srv/ai-kids-platform/production/uploads
```

生产环境默认 `FILE_UPLOAD_REQUIRE_SCANNER=true`。正式开放上传前安装并确认 ClamAV：

```bash
sudo apt-get install clamav
sudo -u ai-kids-platform /usr/bin/clamscan --no-summary /srv/ai-kids-platform/production/current/package.json
```

在生产环境文件中设置 `FILE_UPLOAD_SCANNER=/usr/bin/clamscan` 后重启服务。未配置、不可执行、扫描失败或命中恶意文件时，API 会拒绝上传，不会把文件元数据写入数据库；若数据库写入失败，已落盘文件会清理。Nginx 的 `client_max_body_size` 应与服务端默认 25 MB 限制保持为 26 MB，禁止为 `/srv/ai-kids-platform/production/uploads` 增加静态目录映射。

上传限流与配额：FILE_UPLOAD_USER_PER_HOUR、FILE_UPLOAD_ORG_PER_HOUR、FILE_UPLOAD_MAX_CONCURRENT、FILE_UPLOAD_USER_QUOTA_BYTES、FILE_UPLOAD_ORG_QUOTA_BYTES 分别控制用户/机构小时频率、并发数和容量。生产环境应显式配置，修改后重启服务。


## 2026-09-05 生产环境五项收口记录

- 当前生产 release：/srv/ai-kids-platform/production/releases/20260905T092036Z。
- 当前发布 commit：4255b88cb789a483b5d9e6341d90cc278ea9be0。
- 发布前数据库备份：/srv/ai-kids-platform/production/backups/20260905T092032Z/platform.db。
- 在线 UAT：平台管理员、机构管理员、教师、学生账号登录均通过；平台管理员和机构管理员真实上传均返回 HTTP 200；教师上传入口隐藏；学生端登录与工作台通过。
- 上传安全：生产已安装 ClamAV，/usr/bin/clamscan 可由服务账号执行；安全上传返回 scanner PASSED；上传目录位于 Web 根目录之外并由服务账号持有。
- 文件管理：生产已启用文件列表、元数据、状态启停、审核状态、机构授权、删除/移除及受控下载接口；跨机构授权由服务端校验。
- 监控：learning-platform-production、i-kids-platform-healthcheck.timer、i-kids-platform-production-daily-backup.timer 均为 enabled；磁盘使用率 15%；公网 /api/health 正常。
- 公网入口与安全冒烟：四端入口 4/4 通过；敏感路径、HSTS、CSP、nosniff、frame/referrer 策略检查通过。
- 结论：本次生产环境运维 1—5 项已完成并收口；后续转入日常监控、备份校验和按需迭代。
## 2026-09-05 教师点评闭环与 AI 队列恢复发布记录

- 发布 commit：`f05823b`。
- 新 release：`/srv/ai-kids-platform/production/releases/20260905T102834Z`；切换前数据库备份：`/srv/ai-kids-platform/production/backups/20260905T102834Z/platform.db`。
- 发布内容：教师任务提交、查看、评分、通过 / 驳回、重新提交闭环；教师与学生班级权限收紧；AI 异步任务增加数据库恢复、worker 租约、重试退避、超时回收和取消清理。
- 发布后验证：`learning-platform-production` active；内外 `/health` 均返回 `status=ok`；四端公网入口 `/`、`/admin/`、`/org/`、`/student/` 均返回 200；P9 敏感路径冒烟 **14/14**；生产 SQLite `PRAGMA integrity_check` 返回 `ok`。
- 本次仍使用 `AI_PROVIDER=local-mock`，不对外宣称已接入真实 AI 供应商。
- 备份恢复演练：`restore-drill=passed`，使用同一备份在隔离目录 `127.0.0.1:18789` 启动并通过健康检查，未触碰生产服务。


## 2026-09-05 生产发布门禁与 P10 收口

- 发布 commit：`eabb231`；release：`20260905T111322Z`。
- 发布前新增门禁：服务端 / 数据库 JavaScript 全量 `node --check`，关键路由 import smoke test；门禁失败不生成可发布制品。
- P10 隔离测试：文件上传安全 **9/9**，文件访问矩阵 **6/6**，四端构建通过。
- 发布前备份：`/srv/ai-kids-platform/production/backups/20260905T111358Z`，备份状态 `ok`，生产库完整性检查 `ok`。
- 发布后：四端入口 4/4、`/api/health` 200、安全响应头通过，服务 active/enabled，`NRestarts=0`。
- 本次未执行生产业务数据写入型 UAT；后续需在明确测试数据和回滚窗口后进行。

## 2026-09-05 19:36 生产稳定观察记录

- 检查时间：2026-09-05 19:36（Asia/Shanghai）。
- 当前 release：`/srv/ai-kids-platform/production/releases/20260905T111322Z`。
- `learning-platform-production`：`active`、`enabled`、`running`，`ExecMainStatus=0`，`NRestarts=0`。
- 本地 `/health` 与公网 `/api/health` 均返回成功；`/`、`/admin/`、`/org/`、`/student/` 均返回 HTTP 200。
- 敏感路径只读冒烟：全部通过，敏感路径均为 404，`/api/health` 为 200，安全响应头齐全。
- Nginx：active，`nginx -t` 通过；证书有效期至 2026-11-30 09:38:33 UTC。
- 监控：healthcheck timer active/enabled，最近一次执行成功；每日备份 timer active/enabled，最近一次备份服务退出码 0/SUCCESS。
- 备份状态：`ok`；磁盘使用率 15%；SQLite `PRAGMA integrity_check`：`ok`。
- 最近 60 分钟服务 journal 无 warning/emerg。Nginx 中发现的 405/401/400 为外部扫描或未登录请求，未发现 5xx。
- `verify-production-entrypoints.mjs --mode public` 未完成，原因是服务器缺少脚本所需的 `C:\Program Files\Google\Chrome\Application\chrome.exe`；这属于验收工具依赖缺失，不代表生产入口失败。已用 HTTP 状态和安全冒烟完成只读替代检查。
- 结论：本次只读稳定观察通过；当前无须重启、回滚或重新发布。

## 2026-09-05 P6-A01 供应商目录、预算与学生外发策略发布记录

- 发布 commit：`2770bbb`（供应商目录、平台 / 机构 AI 预算策略、学生内容外发策略）。
- 当前生产 release：`/srv/ai-kids-platform/production/releases/20260905T143653Z`；当前软链接：`/srv/ai-kids-platform/production/current`。
- 发布前备份：`/srv/ai-kids-platform/production/backups/20260905T143653Z`。
- 供应商目录：`local-mock`、`openai-compatible`、`aliyun-bailian`、`volcengine`、`zhipu`、`custom`；平台端可维护供应商 / 模型 / Endpoint / 平台单次与每日预算，机构端可维护本机构单次与每日预算。
- 学生创作内容外发策略：已由平台管理员开启；机构端只读查看当前状态。开启策略不等于已产生外部请求。
- 生产 AI 配置仍为 `AI_PROVIDER=local-mock`；真实 provider adapter 尚未接入，不能对外宣称已经接入真实 AI。未配置完整的真实 provider 时，生成请求明确失败，不回退为假成功。
- 真实 API key 仅允许配置在服务器受限环境文件 `/etc/ai-kids-platform/production.env` 的 `AI_PROVIDER_API_KEY` 中，不写入 Git、数据库、前端构建产物、日志或聊天记录。
- 回归验证：P6-A01 provider 契约 `8/8`、供应商目录与隔离 `13/13`、策略 E2E `23/23`；P4-O12 队列恢复、P4-O13 失败重试、P4-O15 任务取消均通过；四端 production build 通过；`git diff --check` 通过。
- 发布后只读状态：`learning-platform-production` 为 `active/running`、`enabled`，`NRestarts=0`；健康检查通过。此次文档更新不产生新的生产发布。
- 配置入口：平台端 `/admin/` → 平台管理 → 计费与用量 → AI 供应商与预算；机构端 `/org/` → 机构管理 → 账户与计费 → AI 预算。
