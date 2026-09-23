#!/usr/bin/env bash
# 迁移搬运 · 在**旧机**上跑（推方向）
#
# 为什么是"推"而不是"拉"：
#   两台机的安全组都只放行了我的出口 IP 的 22 —— 新旧机之间 22 互不相通。
#   但新机的 443 对 0.0.0.0/0 开放，于是新机上起了一个**临时 sshd 监听 443**
#   （/usr/sbin/sshd -p 443 -o PidFile=/run/sshd-443.pid，迁移完 kill 掉，不动主配置）。
#   数据经这条临时通道从旧机推到新机，**不需要动控制台**。
#
# 实测：旧机出网带宽 3.0–3.2 Mbps（并发 4 条也一样，是整机限额不是每连接）→
#      全量 5.06GB ≈ 3.6 小时。所以分两梯队：关键小件先到，大件后到。
set -Eeuo pipefail

NEW="${NEW:-8.134.80.184}"
PORT="${PORT:-443}"
KEY="${KEY:-/root/.ssh/push-to-new-gz}"
P=/srv/ai-kids-platform
PROD="$P/production"
REL="$(readlink -f "$PROD/current")"

# ⚠️ 不要加 --numeric-ids：两台机的 ai-kids-prod uid/gid **不一样**
#   （旧机 982，新机 999/988）。带 numeric-ids 会把旧机的数字 id 原样写过去，
#   结果文件属主在新机上是个不存在的号 → 平台进程写不了自己的数据目录。
#   不加它，rsync 按**用户名**映射，两边都叫 ai-kids-prod，正好对上。
RSYNC=(rsync -aHAX --partial --timeout=300 --info=progress2
       -e "ssh -p $PORT -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new")

push() { echo; echo "### $(date -u +%H:%M:%SZ)  $1"; "${RSYNC[@]}" "$2" "root@$NEW:$3"; }

echo "================================================================"
echo "迁移搬运开始 $(date -u +%FT%TZ)"
echo "  源（旧机）$P"
echo "  目标（新机）root@$NEW  （经 :$PORT 临时通道）"
echo "  当前 release：$REL"
echo "================================================================"

echo
echo "############ 第一梯队：小而关键（把站搭起来用；约 50MB）############"
push "数据库 + 运行状态"        "$PROD/data/"    "$PROD/data/"
push "运行状态 state"           "$PROD/state/"   "$PROD/state/"
push "运维脚本 bin"             "$PROD/bin/"     "$PROD/bin/"
push "日志 logs"                "$PROD/logs/"    "$PROD/logs/"
push "当前 release（自包含产物）" "$REL/"          "$REL/"
push "环境文件与密钥"           "/etc/ai-kids-platform/" "/etc/ai-kids-platform/"
push "nginx 站点与 dsh 片段"    "/etc/nginx/sites-available/" "/etc/nginx/sites-available/"
push "nginx sites-enabled"     "/etc/nginx/sites-enabled/"   "/etc/nginx/sites-enabled/"
push "nginx dsh-students"      "/etc/nginx/dsh-students/"    "/etc/nginx/dsh-students/"
"${RSYNC[@]}" "/etc/nginx/dsh-proxy-headers.conf" "root@$NEW:/etc/nginx/dsh-proxy-headers.conf"
echo; echo "### systemd 单元 + drop-in"
for u in learning-platform-production.service dsh-host-broker.service dsh-host-reap.service dsh-host-reap.timer \
         ai-kids-platform-production-daily-backup.service ai-kids-platform-production-daily-backup.timer \
         ai-kids-platform-production-healthcheck.service ai-kids-platform-production-healthcheck.timer; do
  "${RSYNC[@]}" "/etc/systemd/system/$u" "root@$NEW:/etc/systemd/system/$u" 2>/dev/null || true
done
"${RSYNC[@]}" "/etc/systemd/system/learning-platform-production.service.d/" \
              "root@$NEW:/etc/systemd/system/learning-platform-production.service.d/" 2>/dev/null || true
echo "### 最新 1 份备份"
LATEST="$(ls -1d "$PROD"/backups/*/ 2>/dev/null | sort | tail -1)"
[[ -n "$LATEST" ]] && push "备份 $(basename "$LATEST")" "$LATEST" "$PROD/backups/$(basename "$LATEST")/"

echo
echo "第一梯队完成 $(date -u +%FT%TZ) —— 新机此刻已可搭建站点"

echo
echo "############ 第二梯队：大件（约 5.0GB；按 3Mbps ≈ 3.5 小时）############"
push "上传文件（课件等）"    "$PROD/uploads/"        "$PROD/uploads/"
push "广场媒体"              "$P/public-media/"      "$P/public-media/"
push "客户端安装包与清单"     "$P/downloads/"         "$P/downloads/"
push "node 运行时（含 pnpm）" "$P/runtime/"           "$P/runtime/"
push "源码（含 .git/node_modules）" "$P/internal-test/source/" "$P/source/"
push "学生创作环境运行时（1.33G，**不可重建**）" "/opt/dsh-runtime/" "/opt/dsh-runtime/"
push "学生创作环境 宿主脚本"  "/opt/dsh-host-user/"   "/opt/dsh-host-user/"
push "学生创作环境 旧容器版"  "/opt/dsh-host/"        "/opt/dsh-host/"
push "PPT 包"                "/opt/ppt-bundles/"     "/opt/ppt-bundles/"
push "学生产物与日志"         "/srv/dsh-runtime/"     "/srv/dsh-runtime/"

echo
echo "================================================================"
echo "全部搬运完成 $(date -u +%FT%TZ)"
echo "下一步（在**新机**上）："
echo "  ln -sfn $REL /srv/ai-kids-platform/production/current"
echo "  chown -R ai-kids-prod:ai-kids-prod /srv/ai-kids-platform/production/{data,uploads,state} /srv/ai-kids-platform/public-media"
echo "  systemctl daemon-reload"
echo "  （再按 migrate/README 改域名、装站点、certbot、验收）"
echo "================================================================"
