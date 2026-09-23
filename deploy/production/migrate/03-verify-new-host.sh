#!/usr/bin/env bash
# 03 · 新机验收（在**新机器**上以 root 执行）
#
# 两个阶段用同一个脚本：
#   bash 03-verify-new-host.sh --local             切解析**之前**：用 --resolve 把域名指到本机
#   bash 03-verify-new-host.sh --public <域名>     切解析**之后**：从公网真打
#
# 为什么切之前也要用域名而不是打 127.0.0.1：nginx 是按 server_name 分发的，
# 拿 IP 打会落到 default server —— 测不到真正的那套配置。
set -Eeuo pipefail

MODE="${1:---local}"
DOMAIN="${2:-}"
PLATFORM_ROOT="/srv/ai-kids-platform"
PROD="$PLATFORM_ROOT/production"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[1;31m✗\033[0m %s\n' "$*"; }
log()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
chk()  { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

if [[ "$MODE" == "--local" ]]; then
  DOMAIN="${DOMAIN:-$(grep -E '^PUBLIC_SITE_URL=' /etc/ai-kids-platform/production.env | cut -d= -f2- | sed 's|https\?://||; s|/.*||')}"
  RESOLVE=(--resolve "$DOMAIN:443:127.0.0.1")
  echo "阶段：切解析之前（把 $DOMAIN 强行指到本机）"
else
  [[ -n "$DOMAIN" ]] || { echo "用法：bash 03-verify-new-host.sh --public <域名>"; exit 2; }
  RESOLVE=()
  echo "阶段：切解析之后（从公网真打 $DOMAIN）"
fi

log "1. 服务与进程"
chk "learning-platform-production active" "systemctl is-active --quiet learning-platform-production"
chk "learning-platform-production enabled" "systemctl is-enabled --quiet learning-platform-production"
chk "服务重启次数为 0" "[[ \$(systemctl show -p NRestarts --value learning-platform-production) == 0 ]]"
chk "API 回环 /health 200" "curl -fsS --max-time 8 http://127.0.0.1:8789/health"

log "2. 五入口（$DOMAIN）"
for path in / /admin/ /org/ /student/ /api/health; do
  code="$(curl -sk -o /dev/null -m 15 -w '%{http_code}' "${RESOLVE[@]}" "https://$DOMAIN$path" || echo 000)"
  if [[ "$code" == "200" ]]; then ok "https://$DOMAIN$path → 200"; else bad "https://$DOMAIN$path → $code"; fi
done

log "3. 数据"
DB="$PROD/data/platform.db"
chk "库 quick_check = ok" "[[ \$(sqlite3 -readonly '$DB' 'pragma quick_check;' 2>/dev/null) == ok ]]"
n_up="$(find "$PROD/uploads" -type f 2>/dev/null | wc -l | tr -d ' ')"
[[ "$n_up" -gt 0 ]] && ok "上传文件 $n_up 个（旧机 282）" || bad "上传目录是空的"
n_pm="$(find "$PLATFORM_ROOT/public-media" -type f 2>/dev/null | wc -l | tr -d ' ')"
[[ "$n_pm" -gt 0 ]] && ok "广场媒体 $n_pm 个（旧机 832）" || bad "广场媒体目录是空的"
chk "客户端安装包在" "ls '$PLATFORM_ROOT/downloads/'*.exe"
chk "客户端更新清单在" "ls '$PLATFORM_ROOT/downloads/manifest.json'"
chk "上传目录属主是 ai-kids-prod" "[[ \$(stat -c %U '$PROD/uploads') == ai-kids-prod ]]"

log "4. 配置没被搬坏"
chk "AUTH_PEPPER 非空" "grep -qE '^AUTH_PEPPER=..*' /etc/ai-kids-platform/production.env"
chk "RUNTIME_GATEWAY_SECRET 非空" "grep -qE '^RUNTIME_GATEWAY_SECRET=..*' /etc/ai-kids-platform/production.env"
chk "provider-secrets.json 在" "ls '$PROD/data/provider-secrets/provider-secrets.json'"
chk "production.env 权限 600" "[[ \$(stat -c %a /etc/ai-kids-platform/production.env) == 600 ]]"
chk "env 域名字段指向 $DOMAIN" "grep -q \"PUBLIC_SITE_URL=https://$DOMAIN\" /etc/ai-kids-platform/production.env"
chk "nginx -t" "nginx -t"

log "5. 那些「缺了会静默失效」的系统依赖"
chk "soffice 在" "command -v soffice"
chk "中文字体 > 0" "[[ \$(fc-list | grep -ci cjk) -gt 0 ]]"
chk "clamscan 在" "command -v clamscan"
chk "clamscan-limited 在且可执行" "[[ -x /usr/local/bin/clamscan-limited ]]"
chk "mime.types 带 mjs" "grep -qE '^\s*application/javascript\s+.*\bmjs\b' /etc/nginx/mime.types"
chk "nginx.conf 有 dsh-students include" "grep -q 'dsh-students' /etc/nginx/nginx.conf"
chk "dsh-students 占位文件在" "ls /etc/nginx/dsh-students/README.conf"
chk "drop-in uploads.conf 在" "ls /etc/systemd/system/learning-platform-production.service.d/uploads.conf"
chk "drop-in oom-policy.conf 在" "ls /etc/systemd/system/learning-platform-production.service.d/oom-policy.conf"

log "6. 上传扫描真的能跑（拿小文件实测，不看配置看行为）"
SCAN_SRC="$PROD/data/platform.db"
SCANNER="$(grep -E '^FILE_UPLOAD_SCANNER=' /etc/ai-kids-platform/production.env | cut -d= -f2- || true)"
SCANNER="${SCANNER:-/usr/bin/clamscan}"
if timeout 180 "$SCANNER" --no-summary "$SCAN_SRC" >/dev/null 2>&1; then
  ok "扫描器可执行且返回 0（$SCANNER）"
else
  bad "扫描器跑不通（$SCANNER）—— 生产 fail-closed，上传会一律被拒"
fi

log "7. 学生创作环境（浏览器版）—— **已按用户口径下线**，这里反过来验它确实关着"
# 2026-09-23 用户口径：vibecoding 课堂只在**学生自己的电脑**上跑（桌面客户端），
# 平台只负责校验 / 上传作品 / 模型网关 / 开课结课。服务器上那套（broker + 每学生一个 Linux 用户
# + 18201-18600 端口）**没人用**，已下线（只关运行面，代码与运行时保留，随时能开回来）。
# 所以这里断言的是"它必须处于关闭状态"—— 若哪天有人又把它打开而没人知道，这里会红。
for u in dsh-host-broker dsh-host-reap.timer; do
  if systemctl is-active --quiet "$u" || systemctl is-enabled --quiet "$u" 2>/dev/null; then
    bad "$u 应为已下线，实际 $(systemctl is-active "$u")/$(systemctl is-enabled "$u" 2>&1)"
  else
    ok "$u 已下线（inactive/disabled）"
  fi
done
chk "broker socket 已消失" "! test -e /run/dsh-host-user/broker.sock"
chk "dsh 运行时仍在（留着当备用，删了就没法快速开回来）" "/opt/dsh-runtime/opt/node/bin/node -v"
echo "  ℹ️ 客户端那条路不依赖这套：它只用 client-context / gateway / submit-upload，验过是好的。"

log "8. 证书与防火墙"
chk "certbot timer active" "systemctl is-active --quiet certbot.timer"
if certbot certificates 2>/dev/null | grep -q "$DOMAIN"; then ok "有 $DOMAIN 的证书"; else bad "没有 $DOMAIN 的证书（跑 certbot --nginx -d $DOMAIN）"; fi
chk "ufw 未开放 18201:18220（服务器侧学生环境已下线）" "! ufw status | grep -q 18201:18220"

log "9. 资源"
echo "  内存：$(free -m | awk '/^Mem:/{print $3" used / "$2" total"}')   磁盘：$(df -h / | awk 'NR==2{print $3" used / "$2" ("$5")"}')"
echo "  ⚠️ 这台机器上别跑真浏览器核验（Chromium 峰值会再压一次内存；旧机就这么崩过）。"

log "结果：${PASS} 通过 / ${FAIL} 失败"
(( FAIL == 0 )) || exit 1
