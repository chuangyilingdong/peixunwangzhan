#!/usr/bin/env bash
# 02 · 从旧机拉数据（在**新机器**上以 root 执行）
#
# 方向是「新机 pull 旧机」而不是「旧机 push 新机」：凭据只留在新机上，
# 旧机（即将退役）不需要持有任何访问新机的钥匙。
#
# 用法（新机上，root）：
#   bash 02-pull-from-old-host.sh <旧机公网IP> [最新备份份数，默认 2]
#
# 第一次跑会生成一把专用密钥并**停在那里**，把打印出来的公钥加到旧机的
# /root/.ssh/authorized_keys（我是从开发机 SSH 到旧机追加的），再重跑本脚本。
set -Eeuo pipefail

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "要用 root 跑"
OLD="${1:-}"
[[ -n "$OLD" ]] || die "用法：bash 02-pull-from-old-host.sh <旧机公网IP> [最新备份份数]"
BACKUP_KEEP="${2:-2}"

PLATFORM_ROOT="/srv/ai-kids-platform"
PROD="$PLATFORM_ROOT/production"
SERVICE_USER="ai-kids-prod"
KEY=/root/.ssh/migrate_from_old

log "0. 检查去旧机的通道"
if [[ ! -f "$KEY" ]]; then
  install -d -m 0700 /root/.ssh
  ssh-keygen -t ed25519 -N '' -C "migrate-pull-$(hostname)-$(date -u +%Y%m%d)" -f "$KEY" >/dev/null
  echo "  已生成 $KEY"
fi
cat <<EOF

  ────────────────────────────────────────────────────────────────────────
  把下面这行公钥加到**旧机**的 /root/.ssh/authorized_keys：

$(cat "${KEY}.pub")

  加好后重跑本脚本。开发机（Windows）上可以直接这样追加：
    ssh -i ~/.ssh/ai_kids_platform_ecs_temp_ed25519 root@${OLD} \\
      "grep -qF '$(cut -d' ' -f2 "${KEY}.pub")' /root/.ssh/authorized_keys || \\
       echo '$(cat "${KEY}.pub")' >> /root/.ssh/authorized_keys"
  ────────────────────────────────────────────────────────────────────────
EOF

if ! ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
        "root@$OLD" 'echo ok' >/dev/null 2>&1; then
  warn "还连不上旧机（公钥可能还没加）。加好之后重跑本脚本即可。"
  exit 0
fi
echo "  通道正常：$(ssh -i "$KEY" -o BatchMode=yes "root@$OLD" 'hostname')"

RSYNC=(rsync -aHAX --partial --timeout=300 --info=progress2 -e "ssh -i $KEY -o BatchMode=yes")
# ⚠️ 这里**故意不加 --numeric-ids**：两台机的 ai-kids-prod uid/gid 不一样
#   （2026-09-23 实测：旧机 uid=995/gid=982，新机 uid=999/gid=988）。
#   带上 numeric-ids 会把旧机的数字 id 原样写进新机的文件属主 —— 那个号在新机上根本不存在，
#   表现是"数据都在、权限也对不上"，平台进程（ai-kids-prod）写不了自己的 data/uploads。
#   不加它，rsync 按**用户名**映射，两边都叫 ai-kids-prod，正好对上。
#   搬完再 chown 一次是双保险（见第 9 步）。
pull() { # pull <远端路径> <本地路径>
  log "拉取 $1"
  "${RSYNC[@]}" "root@$OLD:$1" "$2"
}

log "1. 平台数据（库 + 上传 + 状态 + 运维脚本）"
pull "$PROD/data/"   "$PROD/data/"
pull "$PROD/uploads/" "$PROD/uploads/"
pull "$PROD/state/"  "$PROD/state/"
pull "$PROD/bin/"    "$PROD/bin/"

log "2. 站点资源（广场媒体 + 客户端安装包）"
pull "$PLATFORM_ROOT/public-media/" "$PLATFORM_ROOT/public-media/"
pull "$PLATFORM_ROOT/downloads/"    "$PLATFORM_ROOT/downloads/"

log "3. node 运行时（**保持与旧机同一版本**，免得换了小版本才暴露怪问题）"
pull "$PLATFORM_ROOT/runtime/" "$PLATFORM_ROOT/runtime/"

log "4. 配置"
pull "/etc/ai-kids-platform/" "/etc/ai-kids-platform/"
pull "/etc/nginx/sites-available/" "/etc/nginx/sites-available/"
pull "/etc/nginx/sites-enabled/" "/etc/nginx/sites-enabled/"
pull "/etc/nginx/dsh-students/" "/etc/nginx/dsh-students/"
"${RSYNC[@]}" "root@$OLD:/etc/nginx/dsh-proxy-headers.conf" /etc/nginx/dsh-proxy-headers.conf
"${RSYNC[@]}" "root@$OLD:/etc/nginx/nginx.conf"           /etc/nginx/nginx.conf.migrated-from-old
"${RSYNC[@]}" "root@$OLD:/etc/nginx/mime.types"           /etc/nginx/mime.types.migrated-from-old
"${RSYNC[@]}" "root@$OLD:/etc/systemd/system/learning-platform-production.service" /etc/systemd/system/
"${RSYNC[@]}" "root@$OLD:/etc/systemd/system/learning-platform-production.service.d/" /etc/systemd/system/learning-platform-production.service.d/
"${RSYNC[@]}" "root@$OLD:/etc/systemd/system/dsh-host-broker.service" /etc/systemd/system/
"${RSYNC[@]}" "root@$OLD:/etc/systemd/system/dsh-host-reap.service"   /etc/systemd/system/
"${RSYNC[@]}" "root@$OLD:/etc/systemd/system/dsh-host-reap.timer"     /etc/systemd/system/
"${RSYNC[@]}" "root@$OLD:/etc/systemd/system/ai-kids-platform-production-daily-backup.service" /etc/systemd/system/
"${RSYNC[@]}" "root@$OLD:/etc/systemd/system/ai-kids-platform-production-daily-backup.timer"   /etc/systemd/system/
"${RSYNC[@]}" "root@$OLD:/etc/systemd/system/ai-kids-platform-production-healthcheck.service"  /etc/systemd/system/
"${RSYNC[@]}" "root@$OLD:/etc/systemd/system/ai-kids-platform-production-healthcheck.timer"    /etc/systemd/system/
"${RSYNC[@]}" "root@$OLD:/usr/local/bin/clamscan-limited" /usr/local/bin/clamscan-limited
echo "  提示：nginx.conf / mime.types 拉到的是 .migrated-from-old 副本，只作对照；"
echo "        要用的那份由 01-prepare-new-host.sh 就地打补丁生成。"

log "5. 正在跑的那个 release（**原样搬家 = 跑同一份产物，不是现场重新构建**）"
# 一个 release 只有 ~19M，而且是自包含的（apps/{admin,org,website} 静态包 + apps/server/src
# + packages/* + node_modules/@platform/database 存根），nginx 与 systemd 都直接指它。
# 搬它而不是现场 build 的理由：现场 build 出来的产物和此刻线上跑的**未必逐字节相同**
# （依赖解析、构建时间戳），而搬家当天要的是"行为与现在完全一致"，不是"理论上等价"。
CURRENT_RELEASE="$(ssh -i "$KEY" -o BatchMode=yes "root@$OLD" 'basename "$(readlink -f /srv/ai-kids-platform/production/current)"')"
echo "  旧机 current → $CURRENT_RELEASE"
pull "$PROD/releases/$CURRENT_RELEASE/" "$PROD/releases/$CURRENT_RELEASE/"
ln -sfn "$PROD/releases/$CURRENT_RELEASE" "$PROD/current"
echo "  已把 current 指向 $CURRENT_RELEASE"
echo "  BUILD-METADATA："; sed 's/^/    /' "$PROD/releases/$CURRENT_RELEASE/BUILD-METADATA.txt" 2>/dev/null || warn "  没有 BUILD-METADATA.txt"

log "6. 学生创作环境（dsh）——**学生进不了课堂就靠这一坨**"
# ⚠️ /opt/dsh-runtime 在旧机之外**无法重建**：/srv/dsh-runtime/images 是空的、docker 里也没有镜像。
#    这 1.4G 是整个学生端跑起来的前提（node + dsh + 烤好的插件 profile），必须整份搬。
pull "/opt/dsh-runtime/"  "/opt/dsh-runtime/"
pull "/opt/dsh-host-user/" "/opt/dsh-host-user/"
pull "/opt/dsh-host/"     "/opt/dsh-host/"      # 旧的容器版（小，带上备用）
pull "/opt/ppt-bundles/"  "/opt/ppt-bundles/"
pull "/srv/dsh-runtime/"  "/srv/dsh-runtime/"

log "7. 源码（搬家当天用不上；之后要不要发版、构建新 release 才用）"
# 带 .git：build-production.sh 里要 git rev-parse HEAD 写进 BUILD-METADATA。
# 也带 node_modules（152M）——省一次 pnpm install；不带的话新机上补跑一次也行。
pull "/srv/ai-kids-platform/internal-test/source/" "/srv/ai-kids-platform/source/"

log "8. 最近的备份（只取最新 ${BACKUP_KEEP} 份；旧机上共 5.6G，全搬没必要）"
mapfile -t BK < <(ssh -i "$KEY" -o BatchMode=yes "root@$OLD" \
  "ls -1d $PROD/backups/*/ 2>/dev/null | sort" | tail -n "$BACKUP_KEEP")
for d in "${BK[@]:-}"; do
  [[ -n "$d" ]] || continue
  log "  $(basename "$d")"
  "${RSYNC[@]}" "root@$OLD:$d" "$PROD/backups/"
done

log "9. 属主与权限"
chown -R "$SERVICE_USER:$SERVICE_USER" "$PROD/data" "$PROD/uploads" "$PROD/state" "$PLATFORM_ROOT/public-media"
chown -R root:root "$PLATFORM_ROOT/downloads" "$PLATFORM_ROOT/runtime" "$PLATFORM_ROOT/source"
chown -R root:root /etc/ai-kids-platform && chmod 0700 /etc/ai-kids-platform
chmod 0600 /etc/ai-kids-platform/production.env
chmod 0750 "$PROD/bin" && chmod 0750 "$PROD/bin"/* 2>/dev/null || true
if [[ -f "$PROD/data/provider-secrets/provider-secrets.json" ]]; then
  chown "$SERVICE_USER:$SERVICE_USER" "$PROD/data/provider-secrets/provider-secrets.json"
  chmod 0600 "$PROD/data/provider-secrets/provider-secrets.json"
fi
install -o root -g root -m 0755 /usr/local/bin/clamscan-limited /usr/local/bin/clamscan-limited 2>/dev/null || true

log "10. 拉完自检"
DB="$PROD/data/platform.db"
[[ -f "$DB" ]] && echo "  库大小      : $(du -h "$DB" | cut -f1)" || warn "没有 $DB"
echo "  上传文件数  : $(find "$PROD/uploads" -type f 2>/dev/null | wc -l)  （旧机是 282）"
echo "  广场媒体数  : $(find "$PLATFORM_ROOT/public-media" -type f 2>/dev/null | wc -l)  （旧机是 832）"
echo "  下载目录    :"; ls -l "$PLATFORM_ROOT/downloads" 2>/dev/null | sed 's/^/    /'
echo "  库完整性    : $(sqlite3 -readonly "$DB" 'pragma quick_check;' 2>&1 | head -1)   （期望 ok）"
echo "  dsh 运行时  : $(du -sh /opt/dsh-runtime 2>/dev/null | cut -f1)  （旧机是 1.4G）"
echo "  env 键数    : $(grep -cE '^\s*[A-Za-z_][A-Za-z0-9_]*=' /etc/ai-kids-platform/production.env 2>/dev/null)  （旧机是 36）"
echo "  current     : $(readlink -f "$PROD/current" 2>/dev/null || echo '（没有！）')"
ls "$PROD/current/apps/website/index.html" >/dev/null 2>&1 \
  && echo "  静态包      : 在（current/apps/website/index.html）" \
  || warn "  current 下没有 website/index.html —— release 没拉全"

cat <<'NEXT'

  下一步：
    · 改 /etc/ai-kids-platform/production.env 里的域名（PUBLIC_SITE_URL / ADMIN_APP_ORIGIN /
      ORG_APP_ORIGIN / STUDENT_APP_ORIGIN / CORS_ALLOWED_ORIGINS / VITE_*），
      **AUTH_PEPPER 与 RUNTIME_GATEWAY_SECRET 一个字都不要动**。
    · 然后跑 03-verify-new-host.sh，或按迁移文档继续。
NEXT
