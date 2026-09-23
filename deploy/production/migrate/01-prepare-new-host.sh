#!/usr/bin/env bash
# 01 · 新机准备（在**新机器**上以 root 执行）
#
# 做什么：把「平台代码之外、但缺了就静默失效」的那一堆系统级东西一次装齐。
# 为什么单独一个脚本：这些东西散落在 RUNBOOK 的注释、旧机的 /usr/local/bin、
# /etc/nginx/nginx.conf、systemd drop-in 里，**仓库里原本一处都没有**；
# 2026-09-23 迁移前逐条从旧机抄回来的（见 deploy/production/nginx-site.conf 顶部注释）。
#
# 用法（新机上，root）：
#   bash 01-prepare-new-host.sh
#
# 幂等：可以反复跑。
set -Eeuo pipefail

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "要用 root 跑"

PLATFORM_ROOT="/srv/ai-kids-platform"
PROD="$PLATFORM_ROOT/production"
SERVICE_USER="ai-kids-prod"
REPO_DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log "0. 环境确认"
. /etc/os-release
echo "  OS          : ${PRETTY_NAME:-unknown}"
echo "  架构        : $(uname -m)"
echo "  内存        : $(free -m | awk '/^Mem:/{print $2" MB"}')"
echo "  磁盘可用    : $(df -h / | awk 'NR==2{print $4}')"
echo "  CPU         : $(nproc) vCPU"
[[ "$(uname -m)" == "x86_64" ]] || warn "不是 x86_64 —— 旧机的 node 运行时是 x86_64 的，搬过来不能直接用。"
MEM_MB="$(free -m | awk '/^Mem:/{print $2}')"
if (( MEM_MB < 3500 )); then
  warn "内存只有 ${MEM_MB}MB。旧机就是 1.6G 被 OOM 压垮过（学生创作环境 + clamscan 峰值 ≈900MB）。"
  warn "这台机器上不要跑真浏览器核验（Chromium 会再压一次内存）。"
fi

log "1. 系统包（平台依赖、缺了会静默失效的那几个）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  nginx certbot python3-certbot-nginx \
  rsync git curl ca-certificates tzdata sqlite3 \
  clamav \
  libreoffice-impress libreoffice-writer fonts-noto-cjk \
  ufw unattended-upgrades >/dev/null
# ↑ 为什么是这几个：
#   · libreoffice-* + fonts-noto-cjk → 教学素材（PPT/Word）服务端转 PDF 预览。
#     只装 LibreOffice 也能转，但**中文会渲染成方块且不报错**；字体包不能省。
#   · clamav → 上传安全扫描。生产 FILE_UPLOAD_REQUIRE_SCANNER=true，扫描器不可用
#     时上传**一律被拒**（fail-closed），不是"降级放行"。
#   · sqlite3 → 迁移与恢复演练里用命令行校验库完整性。
echo "  nginx       : $(nginx -v 2>&1 | sed 's/nginx version: //')"
echo "  python3     : $(certbot --version 2>&1)"
echo "  soffice     : $(soffice --version 2>/dev/null | head -1 || echo '（缺！）')"
echo "  中文字体    : $(fc-list 2>/dev/null | grep -ci cjk) 条（要 >0）"
echo "  clamscan    : $(clamscan --version 2>/dev/null | head -1 || echo '（缺！）')"
echo "  sqlite3     : $(sqlite3 --version 2>/dev/null | cut -d' ' -f1)"

log "2. 服务账号与目录布局"
getent group "$SERVICE_USER" >/dev/null || groupadd --system "$SERVICE_USER"
if ! getent passwd "$SERVICE_USER" >/dev/null; then
  useradd --system --gid "$SERVICE_USER" --home-dir "$PLATFORM_ROOT" \
          --shell /usr/sbin/nologin --comment "AI Kids Platform (production)" "$SERVICE_USER"
fi
echo "  账号：$(id "$SERVICE_USER")"

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$PLATFORM_ROOT"
install -d -o root           -g root           -m 0755 "$PLATFORM_ROOT/downloads"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$PLATFORM_ROOT/public-media"
install -d -o root           -g root           -m 0755 "$PLATFORM_ROOT/runtime"
install -d -o root           -g root           -m 0755 "$PROD"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$PROD/data"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$PROD/logs"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$PROD/uploads"
install -d -o root           -g "$SERVICE_USER" -m 0770 "$PROD/backups"
install -d -o root           -g root           -m 0755 "$PROD/releases"
install -d -o root           -g root           -m 0755 "$PROD/bin"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$PROD/state"
install -d -o root           -g root           -m 0755 "$PROD/restore-drills"
install -d -o root           -g root           -m 0700 /etc/ai-kids-platform
echo "  目录："
ls -ld "$PROD" "$PROD"/{data,logs,uploads,backups,releases,bin,state} "$PLATFORM_ROOT"/{downloads,public-media,runtime} | sed 's/^/    /'

log "3. swap（旧机 2G；新机没有的话补一份，OOM 时是最后一道缓冲）"
if swapon --show | grep -q .; then
  echo "  已有 swap："; swapon --show | sed 's/^/    /'
elif (( MEM_MB < 8000 )); then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "  已建 2G /swapfile 并写入 /etc/fstab"
  else
    swapon /swapfile 2>/dev/null || true
    echo "  /swapfile 已存在，已尝试启用"
  fi
  # 让学生/扫描吃内存时优先被换出而不是触发 OOM 杀进程
  sysctl -qw vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
else
  echo "  内存充足（${MEM_MB}MB），跳过 swap"
fi

log "4. 上传扫描器包装 /usr/local/bin/clamscan-limited"
# 旧机的 production.env 里 FILE_UPLOAD_SCANNER 指的就是这个包装（不是 /usr/bin/clamscan）。
# 缺了它 → 扫描器不可执行 → 生产 fail-closed → **所有上传被拒**。
if [[ -f "$REPO_DEPLOY/clamscan-limited" ]]; then
  install -o root -g root -m 0755 "$REPO_DEPLOY/clamscan-limited" /usr/local/bin/clamscan-limited
  echo "  已装：$(ls -l /usr/local/bin/clamscan-limited)"
  echo "  （内存 ≥4G 时可以把 CLAMSCAN_VMEM_KB 放到 3000000，或直接改用 /usr/bin/clamscan）"
else
  warn "找不到 $REPO_DEPLOY/clamscan-limited —— 请确认迁移包完整（这份文件只存在于旧机和仓库）"
fi

log "5. nginx 的两处服务器级前置"
# ① mime.types 的 application/javascript 要带 mjs（否则 .mjs 变 octet-stream，nosniff 下浏览器拒收）
if grep -qE '^\s*application/javascript\s+.*\bmjs\b' /etc/nginx/mime.types; then
  echo "  ① mime.types：mjs 已在（跳过）"
else
  cp -a /etc/nginx/mime.types "/etc/nginx/mime.types.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  # 幂等：已经带 mjs 的行不再追加（否则连跑两次会变成 `js mjs mjs`）
  sed -i '/^[[:space:]]*application\/javascript.*[[:space:]]mjs[;[:space:]]*$/!s|^\( *\)application/javascript\( *\)\(.*\);[[:space:]]*$|\1application/javascript\2\3 mjs;|' /etc/nginx/mime.types
  grep -n "application/javascript" /etc/nginx/mime.types | sed 's/^/  ① /'
  echo "  ① mime.types：已补 mjs"
fi

# ② nginx.conf 里要 include dsh-students/*.conf（学生每个入口一条 server 块）
if grep -q 'dsh-students' /etc/nginx/nginx.conf; then
  echo "  ② nginx.conf：dsh-students include 已在（跳过）"
else
  cp -a /etc/nginx/nginx.conf "/etc/nginx/nginx.conf.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  sed -i 's|^\(\s*\)include /etc/nginx/sites-enabled/\*;|\1include /etc/nginx/dsh-students/*.conf;\n\1include /etc/nginx/sites-enabled/*;|' /etc/nginx/nginx.conf
  grep -n 'dsh-students\|sites-enabled' /etc/nginx/nginx.conf | sed 's/^/  ② /'
  echo "  ② nginx.conf：已补 include"
fi

install -d -o root -g root -m 0755 /etc/nginx/dsh-students
if [[ -f "$REPO_DEPLOY/nginx/dsh-students-README.conf" ]]; then
  install -o root -g root -m 0644 "$REPO_DEPLOY/nginx/dsh-students-README.conf" /etc/nginx/dsh-students/README.conf
fi
if [[ -f "$REPO_DEPLOY/nginx/dsh-proxy-headers.conf" ]]; then
  install -o root -g root -m 0644 "$REPO_DEPLOY/nginx/dsh-proxy-headers.conf" /etc/nginx/dsh-proxy-headers.conf
fi
echo "  /etc/nginx/dsh-students 与 dsh-proxy-headers.conf 已就位"

log "6. 防火墙（ufw）"
# 18201-18220 是学生的创作环境入口，每个学生一个端口。**两处**都要放行才能从公网连：
# 云控制台的安全组 + 这里的 ufw。少一处就是连不上。
ufw allow 22/tcp    >/dev/null
ufw allow 80/tcp    >/dev/null
ufw allow 443/tcp   >/dev/null
ufw allow 18201:18220/tcp comment "学生创作环境 dsh" >/dev/null
ufw --force enable  >/dev/null
ufw status | sed 's/^/  /'
warn "别忘了**云控制台安全组**也要放行：22（只放行你的出口 IP，别用 0.0.0.0/0）、80、443、18201/18220。"

log "7. 完成。下一步："
cat <<'NEXT'
  1) 把数据从旧机拉过来（在新机上跑）：
       bash 02-pull-from-old-host.sh <旧机公网IP>
  2) 装站点配置（拉完之后域名才知道写哪个；把 <新域名> 换掉）：
       sed 's/__SITE_DOMAIN__/<新域名>/g' ../nginx-site.conf > /etc/nginx/sites-enabled/<新域名>
       nginx -t && systemctl reload nginx
  3) 装 systemd 单元 + 两个 drop-in（见 ../systemd/ 顶部注释）
  4) 构建 release（注意：**先在当前 shell 里 export 域名变量**，否则前端会烤进旧域名）
  5) certbot --nginx -d <新域名>
NEXT
