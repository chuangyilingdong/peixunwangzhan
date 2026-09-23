# 迁移到新服务器（阿里云广州）· 执行手册

> 依据文档：`docs/operations/迁移-新服务器广州-20260923.md`（已定事实、为什么这么排、还缺什么）。
> 本目录是**能直接跑的那部分**。全部脚本都在**新机器**上以 root 执行；旧机只被读、不写。

## 这套东西为什么存在

2026-09-23 逐条核对旧机时发现：**平台跑起来所依赖的东西，有相当一部分不在仓库里**，
只活在那台机器上 —— 仓库里没有、任何文档里也没写。换台机器照文档重建，会出现一批
**不报错的失效**（上传全挂、中文预览变方块、学生进不了课堂、mjs 被浏览器拒收）。
所以先把它们抄回仓库，再写成本目录的脚本：

| 抄回来的东西 | 原本只在 | 缺了会怎样 |
|---|---|---|
| `clamscan-limited` | 旧机 `/usr/local/bin/` | 扫描器不可执行 → 生产 fail-closed → **所有上传被拒** |
| `nginx-site.conf` | 旧机 `/etc/nginx/sites-enabled/` | 仓库里的 `nginx.conf.example` **已过期**：缺 `/downloads/` 与 `/media/`、`client_max_body_size` 还是 26m → 安装包下不了、广场图全裂、大课件传不上 |
| `systemd/…service.d/uploads.conf` | 旧机 `/etc/systemd/system/…d/` | `ProtectSystem=strict` 下 uploads 不在可写路径 → **上传写不进去** |
| `systemd/…service.d/oom-policy.conf` | 同上 | 子进程被 OOM 杀掉会连带重启整个服务 |
| nginx 两处服务器级前置（mjs、`dsh-students` include） | 旧机的 `mime.types` / `nginx.conf` | `.mjs` 回落成 octet-stream 被 nosniff 拒收；学生端所有入口端口不通 |

## 顺序

```text
01  bash 01-prepare-new-host.sh                    新机准备（系统包/账号/目录/swap/扫描器/nginx 前置/ufw）
02  bash 02-pull-from-old-host.sh <旧机IP> [备份份数]  从旧机拉数据与配置（新机 pull 旧机）
    —— 第一次会打印一把公钥，加到旧机 authorized_keys 后重跑
03  bash 03-verify-new-host.sh --local             切解析**之前**的验收
    （此时还要装站点配置 + systemd 单元 + 起服务，见下面第 3 步）
04  bash 04-build-and-switch-release.sh            （可选）以后要发版时才用；搬家当天不需要
03  bash 03-verify-new-host.sh --public <新域名>    切解析**之后**的验收
```

### 详细步骤（含必须手做的三处）

```text
1. 准备新机                      bash 01-prepare-new-host.sh
   验收：脚本末尾打印的 soffice / 中文字体 / clamscan / sqlite3 都在

2. 拉数据                        bash 02-pull-from-old-host.sh <旧机IP>
   （第一次会停下要你加公钥；加完重跑）
   验收：脚本末尾自检全绿；重点看 库完整性=ok、上传 282、current 指向 release

3. 装站点与单元（**手做，域名在这一步才用上**）
   sed 's/__SITE_DOMAIN__/<新域名>/g' deploy/production/nginx-site.conf \
     > /etc/nginx/sites-enabled/<新域名>
   install -o root -g root -m 0644 deploy/production/systemd/learning-platform-production.service /etc/systemd/system/
   install -D -o root -g root -m 0644 deploy/production/systemd/learning-platform-production.service.d/uploads.conf \
     /etc/systemd/system/learning-platform-production.service.d/uploads.conf
   install -D -o root -g root -m 0644 deploy/production/systemd/learning-platform-production.service.d/oom-policy.conf \
     /etc/systemd/system/learning-platform-production.service.d/oom-policy.conf
   nginx -t && systemctl reload nginx
   # 先不要跑 certbot：没有证书时 nginx 会因为找不到 ssl_certificate 直接起不来。
   # 顺序是「先 certbot 拿证书 → 再 reload」。拿证书用 --standalone 或先放一份自签占位。

4. 改 env 域名（**AUTH_PEPPER / RUNTIME_GATEWAY_SECRET 一个字都不要动**）
   /etc/ai-kids-platform/production.env 里改：
     PUBLIC_SITE_URL / ADMIN_APP_ORIGIN / ORG_APP_ORIGIN / STUDENT_APP_ORIGIN /
     CORS_ALLOWED_ORIGINS / VITE_PUBLIC_SITE_URL / VITE_ORG_APP_URL
   注意 STUDENT_APP_ORIGIN 在旧机上是 https://<旧域名>/student（学生端的实际入口）
   验收：bash 03-verify-new-host.sh --local

5. 证书                            certbot --nginx -d <新域名>
   验收：03 脚本第 8 节

6. 切解析                          新域名的 A 记录 → 新机公网 IP（提前把 TTL 调到 60s）
   验收：bash 03-verify-new-host.sh --public <新域名>，再用真账号登 /admin/ /org/ /student/

7. 收尾
   · 客户端钉的是旧域名 → 要么发一版指向新域名的客户端，要么旧域名 301
   · 旧机**先别关**，留一周；它就是回滚点（DNS 改回去即可）
   · dsh：新机上的 broker 要 active，且**开一节课实测**学生环境能不能起、18201 能不能连
```

## 三个最容易翻车的点

1. **`AUTH_PEPPER` 一字不改**。它是密码哈希的盐，改一个字节 = 所有人登不进去。
   `RUNTIME_GATEWAY_SECRET` 同理（改了我们自己的 dsh 网关全拒）。
2. **备案是绑实例的**。新域名已备案，但若备案挂在旧机实例上，要走阿里云「接入备案」
   把新机加进去，否则新机换了域名照样被拦。（旧域名 `iicili.cyou` 现在就是被备案拦截页挡着的。）
3. **`/opt/dsh-runtime`（1.4G）在旧机之外无法重建** —— `/srv/dsh-runtime/images` 是空的、
   docker 里也没有镜像。这 1.4G 是学生端跑起来的前提，必须整份搬（02 脚本已包含）。

## 回滚

```text
任何一步出错：DNS 改回旧机 IP（旧机全程不动、不停服）→ 观察新机日志定位
切了解析之后要退：同上，DNS 改回；旧机一直活着，这是最省事的回滚点。
```

## 搬家当天**不要**做的事

- 不要顺手把数据库换成 RDS（那是换引擎：schema、所有 SQL、JSON 函数、迁移脚本、几十条守卫）。
  新机继续用搬过来的 SQLite，先站稳。
- 不要顺手把上传/媒体改成 OSS（私有 bucket + 签名 URL 是独立一件事）。
- 不要在新机上跑真浏览器核验（Chromium 峰值会再压一次内存；旧机就是这么崩的）。
