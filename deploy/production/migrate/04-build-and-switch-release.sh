#!/usr/bin/env bash
# 04 · 构建一个新 release 并切换（在**新机器**上以 root 执行）
#
# ⚠️ 搬家当天**不需要**跑这个 —— 那天用的是从旧机原样搬过来的 release（见 02 脚本第 5 步）。
#    这个脚本是给"以后要发版"用的。
#
# 用法：bash 04-build-and-switch-release.sh [源码目录，默认 /srv/ai-kids-platform/source]
#
# 本脚本存在的唯一理由，是绕开一个**很容易踩、而且踩了不报错**的坑：
set -Eeuo pipefail

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "要用 root 跑"
SRC="${1:-/srv/ai-kids-platform/source}"
PROD="/srv/ai-kids-platform/production"
[[ -d "$SRC/apps" ]] || die "源码目录不像仓库根：$SRC"

log "1. 环境变量：**必须先 export 域名字段**"
# 为什么单独强调：build-production.sh 里 VITE_PUBLIC_SITE_URL / VITE_ORG_APP_URL 有写死的
# 兜底默认值（https://iicili.cyou）。而 /etc/ai-kids-platform/production.env 是 **systemd**
# 读的，**不会**自动出现在你手动跑的 shell 里 —— 于是"忘了 export 就直接 build"会把**旧域名**
# 烤进前端产物，而且构建成功、页面也能开，只有跳转和分享链接指向旧域名（不报错的那种错）。
set -a
# shellcheck disable=SC1091
. /etc/ai-kids-platform/production.env
set +a
DOMAIN="$(printf '%s' "${PUBLIC_SITE_URL:-}" | sed 's|https\?://||; s|/.*||')"
[[ -n "$DOMAIN" ]] || die "production.env 里没有 PUBLIC_SITE_URL"
echo "  域名         : $DOMAIN"
echo "  VITE_API_BASE: ${VITE_API_BASE:-/api}"
echo "  VITE_ORG_APP : ${VITE_ORG_APP_URL:-（空）}"

log "2. 构建前的备份（换 release 之前先把库备一份，回滚才有得回）"
export PATH=/srv/ai-kids-platform/runtime/node/bin:$PATH

# ⚠️ 国内机器上必须先把源指到镜像，否则 pnpm **静默卡死**（2026-09-23 实测）：
#   · runtime 里的 pnpm 是 corepack 壳，第一次用要去网上取 pnpm 二进制；
#   · pnpm install 还会按 node_modules/.modules.yaml 里记的 registry.npmjs.org 去核对 ——
#     国内直连是"连上但不传数据"，而 build-production.sh 用了 --reporter=silent，
#     日志里一个字都没有，看起来像死机（实测 60 秒零字节增长）。
# 这两行只在没设过时生效，海外机器可以覆盖成空值跳过。
export COREPACK_NPM_REGISTRY="${COREPACK_NPM_REGISTRY:-https://registry.npmmirror.com}"
export npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}"

echo "  node: $(node -v)   pnpm: $(timeout 120 pnpm --version 2>/dev/null || echo '（取不到——先看 COREPACK_NPM_REGISTRY / .npmrc 的源）')"
echo "  npm 源: $(npm config get registry 2>/dev/null)"
if [[ -f "$SRC/deploy/production/backup-production.sh" ]]; then
  bash "$SRC/deploy/production/backup-production.sh"
else
  warn "找不到 backup-production.sh，跳过备份（风险自负）"
fi

log "3. 构建"
cd "$SRC"
BEFORE="$(readlink -f "$PROD/current" 2>/dev/null || true)"
COMMIT="$(git rev-parse HEAD)"
echo "  源码 HEAD: $COMMIT"
bash deploy/production/build-production.sh
NEW="$(ls -1dt "$PROD"/releases/*/ | head -1)"
NEW="${NEW%/}"
echo "  新 release: $NEW"
[[ "$NEW" != "$BEFORE" ]] || die "新 release 和当前 release 是同一个目录，构建可能没产出"
sed 's/^/  /' "$NEW/BUILD-METADATA.txt"

log "4. 切换 + 重启"
ln -sfn "$NEW" "$PROD/current"
systemctl restart learning-platform-production
sleep 3
if systemctl is-active --quiet learning-platform-production; then
  echo "  服务 active"
else
  warn "服务没起来 —— 立刻回滚："
  warn "  bash deploy/production/rollback-production.sh --release $BEFORE"
  exit 1
fi
curl -fsS --max-time 8 http://127.0.0.1:8789/health && echo

log "5. 验收"
bash "$(dirname "${BASH_SOURCE[0]}")/03-verify-new-host.sh" --local

cat <<NEXT

  回滚（一条命令，把软链切回上一版再重启）：
    ln -sfn $BEFORE $PROD/current && systemctl restart learning-platform-production
  ⚠️ 若这次发布带了**数据库结构迁移**（schema.js 里的重建表迁移会在服务启动时自动跑），
     回滚 release **不能**把库一起退回去 —— 那种情况要用切换到 release 之前的那份备份
     （$PROD/backups/<stamp>/platform.db）。
NEXT
