# AI 少儿编程平台｜P9-I01 内部测试部署基线

## 目标

本目录提供可重复的线上受控内部测试构建和部署模板。目标为 `https://iicili.cyou/` 单域名路径，不执行正式公开上线，不修改真实线上数据库，不包含任何真实密钥。

## 目录约定

- 发布目录：`/srv/ai-kids-platform/internal-test/releases/<UTC-时间戳>`
- 当前版本软链接：`/srv/ai-kids-platform/internal-test/current`
- 测试数据库：`/srv/ai-kids-platform/internal-test/data/platform.db`
- 环境变量：`/etc/ai-kids-platform/internal-test.env`
- API 服务：systemd `learning-platform-internal-test`，仅监听 `127.0.0.1:8788`
- 前端：Nginx 在 `iicili.cyou` 下按 `/`、`/admin/`、`/org/`、`/student/` 提供四端

## 本地 / CI 构建

Windows：

```powershell
$node='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$pnpm='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
$env:PATH="$(Split-Path $node);$env:PATH"
Set-Location 'D:\学习平台\platform-v2'
& .\deploy\internal-test\build-internal-test.ps1 -PnpmCommand $pnpm
```

Linux 服务器应使用同等版本的 Node.js 22.5+ / pnpm 11：

```bash
cd /srv/ai-kids-platform/source
bash deploy/internal-test/build-internal-test.sh
```

脚本使用新的时间戳发布目录，不直接删除或覆盖旧制品；发布前应先核对 commit、构建输出和 `BUILD-METADATA.txt`。

## 测试库初始化

在 `/etc/ai-kids-platform/internal-test.env` 注入独立 `PLATFORM_DB_PATH` 后执行：

```bash
set -a
. /etc/ai-kids-platform/internal-test.env
set +a
node packages/database/src/db.js
node packages/database/src/seed.js
```

禁止将 `PLATFORM_DB_PATH` 指向仓库默认 `packages/data/platform.db`，禁止从 `iicili.cyou` 复制真实业务数据到内测库。

## 启动与健康检查

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now learning-platform-internal-test
curl -fsS http://127.0.0.1:8788/health
sudo journalctl -u learning-platform-internal-test -n 100 --no-pager
```

## 发布切换与回滚原则

1. 新版本构建到新的 release 目录。
2. 在隔离环境执行迁移 / seed / 健康检查。
3. 备份当前 `current` 指向、测试数据库和环境配置。
4. 原子切换 `current` 到新 release。
5. 健康检查失败立即切回上一 release，并恢复数据库备份（若迁移已改变数据）。
6. 记录 commit、时间、执行人、日志、备份位置和结果。

## Nginx 与访问控制

`nginx.conf.example` 只提供模板。启用前必须：

- 将主机名替换成内部 DNS / hosts 地址；
- 创建仅供内部测试的 Basic Auth 账号，或在网络层使用 VPN / IP 白名单；
- 确认 API 8788 没有公网放行，且服务仅绑定回环地址；
- 验证 SPA 回退、`/api/` 代理、`X-Robots-Tag` 和 `X-Internal-Test`；
- 页面和协议准备稿仍标识为内部测试，不代表正式服务。
