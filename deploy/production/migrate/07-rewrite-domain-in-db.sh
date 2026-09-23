#!/usr/bin/env bash
# 07 · 换域名时订正**数据库里的旧域名字符串**
#
# 为什么需要这一步：换域名不只是改 env 和 nginx —— 数据库里也存着**绝对地址**。
# 2026-09-23 迁到 aicyld.com 时实扫发现：
#   works.canvas_snapshot          485 行  ← 作品快照 JSON 里的 coverUrl（广场封面）
#   generation_jobs.source_asset_url   7 行
#   generation_jobs.reference_asset_urls 3 行
# 不订正的后果很具体：广场接口返回的封面地址还是 https://旧域名/media/... ，
# 浏览器去取那个**已被备案拦掉的域名** → **广场封面全裂**（而后端一切正常、日志无错）。
#
# 用法（在**新机**上以 root 执行；先停 30 秒站点也行、不停也行，SQLite 的 WAL 能扛住并发写）：
#   bash 07-rewrite-domain-in-db.sh <旧域名> <新域名>
# 例：bash 07-rewrite-domain-in-db.sh iicili.cyou aicyld.com
set -Eeuo pipefail

OLD_DOMAIN="${1:-}"
NEW_DOMAIN="${2:-}"
[[ -n "$OLD_DOMAIN" && -n "$NEW_DOMAIN" ]] || { echo "用法：bash 07-rewrite-domain-in-db.sh <旧域名> <新域名>" >&2; exit 2; }

DB="${PLATFORM_DB_PATH:-/srv/ai-kids-platform/production/data/platform.db}"
[[ -r "$DB" ]] || { echo "找不到数据库：$DB" >&2; exit 2; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

log "1. 备份（订正前）"
BK="/srv/ai-kids-platform/production/backups/platform.db.before-domain-rewrite-$STAMP"
cp -a "$DB" "$BK"
echo "  已备份：$BK"

log "2. 扫描：哪些表/列含 $OLD_DOMAIN"
FOUND=0
SQL=""   # ⚠️ 必须初始化：脚本开头是 set -u，不初始化的话第一次拼 SQL 就 "unbound variable" 直接退出
for t in $(sqlite3 -readonly "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"); do
  for c in $(sqlite3 -readonly "$DB" "SELECT name FROM pragma_table_info('$t');"); do
    n=$(sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM \"$t\" WHERE CAST(\"$c\" AS TEXT) LIKE '%$OLD_DOMAIN%';" 2>/dev/null || echo 0)
    if [[ "${n:-0}" != "0" ]]; then
      echo "  $t.$c : $n 行"
      FOUND=$((FOUND + 1))
      SQL="$SQL
UPDATE \"$t\" SET \"$c\" = REPLACE(CAST(\"$c\" AS TEXT), '$OLD_DOMAIN', '$NEW_DOMAIN') WHERE CAST(\"$c\" AS TEXT) LIKE '%$OLD_DOMAIN%';"
    fi
  done
done
if [[ "$FOUND" == "0" ]]; then
  echo "  没有任何引用 —— 不需要订正。"
  exit 0
fi

log "3. 订正（一个事务里做完）"
printf 'BEGIN;%s\nCOMMIT;\n' "$SQL" | sqlite3 "$DB"
echo "  已执行"

log "4. 复核"
LEFT=0
for t in $(sqlite3 -readonly "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"); do
  for c in $(sqlite3 -readonly "$DB" "SELECT name FROM pragma_table_info('$t');"); do
    n=$(sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM \"$t\" WHERE CAST(\"$c\" AS TEXT) LIKE '%$OLD_DOMAIN%';" 2>/dev/null || echo 0)
    [[ "${n:-0}" != "0" ]] && { echo "  !! 仍有 $t.$c : $n 行"; LEFT=$((LEFT + 1)); }
  done
done
[[ "$LEFT" == "0" ]] && echo "  旧域名已清干净"
echo "  库完整性：$(sqlite3 -readonly "$DB" 'PRAGMA quick_check;' | head -1)"

log "5. 重启服务让可能的缓存失效"
systemctl restart learning-platform-production
sleep 3
echo "  is-active: $(systemctl is-active learning-platform-production)"

cat <<NEXT

  回滚：把备份覆盖回去再重启
    cp -a $BK $DB && systemctl restart learning-platform-production
  ⚠️ 覆盖数据库要**先停服务**（避免服务正持有旧的文件句柄）：
    systemctl stop learning-platform-production && cp -a $BK $DB && systemctl start learning-platform-production
NEXT
