#!/usr/bin/env bash
# 清 production/backups：把「每次发布前整库备份」的老份数收掉（2026-10-01 立的口径）。
#
# 为什么需要它：单份备份 **约 200MB**（库转储只有 ~3.6MB，大头是里面那份 release 树拷贝，
# 见 deploy/production/backup-production.mjs）—— 发布密集的日子（09-30 一天 19 份）一周就能堆到
# 6GB+。`daily-backup.sh` 只在**每晚 03:00** 那次跑的时候按 `-mtime` 清 7 天前的，
# 白天发的版它一份都不清，于是磁盘会一路涨到监控阈值（2026-10-01 实测 22G/40G，58%）。
#
# 保留口径（三条，任一命中就留）：
#   ① **最新 6 份**（`20*T*Z`）—— 回滚当前 release 要用的就是"切换前那一份"，恢复演练也在这儿取；
#   ② **每日备份**（`*T19*Z`，即 03:00 CST 那份）且未超过 KEEP_DAYS 天（默认 7，与 daily-backup.sh 同一口径）；
#   ③ 名字不以 `20` 开头的目录**一律不碰**（`platform.db.before-domain-rewrite-*` 这类迁移快照是独一无二的）。
#
# 用法：bash prune-backups.sh                 —— 只列，不删（干跑）
#       bash prune-backups.sh --apply         —— 真删 + 留档 logs/backups-archive-<stamp>.tsv
#       KEEP_DAYS=3 bash prune-backups.sh     —— 临时收紧每日份的保留天数
set -Eeuo pipefail

PROD="${PRODUCTION_ROOT:-/srv/ai-kids-platform/production}"
BACKUP_ROOT="${PRODUCTION_BACKUP_ROOT:-${PROD}/backups}"
KEEP_NEWEST="${KEEP_NEWEST:-6}"
KEEP_DAYS="${KEEP_DAYS:-${PRODUCTION_BACKUP_RETENTION_DAYS:-7}}"
APPLY="${1:-}"

[[ -d "$BACKUP_ROOT" ]] || { echo "没有这个目录：$BACKUP_ROOT"; exit 1; }
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] && (( KEEP_DAYS >= 1 )) || { echo "KEEP_DAYS 要是 ≥1 的整数（现在 '${KEEP_DAYS}'）"; exit 2; }

mapfile -t ALL < <(ls -1 "$BACKUP_ROOT" | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r)
mapfile -t OTHER < <(ls -1 "$BACKUP_ROOT" | grep -Ev '^[0-9]{8}T[0-9]{6}Z$' || true)
mapfile -t DAILY < <(printf '%s\n' "${ALL[@]}" | grep -E '^[0-9]{8}T19[0-9]{4}Z$' || true)

CUTOFF="$(date -u -d "${KEEP_DAYS} days ago" +%s 2>/dev/null || echo 0)"

KEEP=(); DELETE=()
for i in "${!ALL[@]}"; do
  name="${ALL[$i]}"; stamp="${name:0:8}"; dir="$BACKUP_ROOT/$name"
  reason=""
  (( i < KEEP_NEWEST )) && reason="最新 $KEEP_NEWEST 份之一"
  if [[ -z "$reason" ]] && printf '%s\n' "${DAILY[@]}" | grep -qx "$name"; then
    mtime="$(date -u -r "$dir" +%s 2>/dev/null || echo 0)"
    (( mtime >= CUTOFF )) && reason="每日备份（${KEEP_DAYS} 天内，${stamp}）"
  fi
  [[ -n "$reason" ]] && KEEP+=("$name（$reason）") || DELETE+=("$name")
done

echo "备份目录：$BACKUP_ROOT"
echo "时间戳目录 $((${#ALL[@]})) 份（另有 $((${#OTHER[@]})) 个非时间戳条目，一律不碰）；保留口径：最新 $KEEP_NEWEST 份 + ${KEEP_DAYS} 天内的每日份"
echo
echo "保留（$((${#KEEP[@]})) 份）："; printf '   %s\n' "${KEEP[@]:-（无）}"
echo "待删（$((${#DELETE[@]})) 份）："; printf '   %s\n' "${DELETE[@]:-（无）}"
if [ "${#DELETE[@]}" = 0 ]; then echo; echo "没有可清的，收工。"; exit 0; fi

# 安全闸（照 prune-releases.sh 的思路）：
#   ① 删完必须**至少还剩 KEEP_NEWEST 份**；② current 指向的 release 必须还在；③ 最新那份备份必须还在。
CUR="$(readlink -f "$PROD/current" 2>/dev/null || true)"
NEWEST="${ALL[0]}"
[[ -d "$NEWEST" || -d "$BACKUP_ROOT/$NEWEST" ]] || { echo "!! 最新那份备份不在：$NEWEST —— 拒绝执行"; exit 1; }
[[ -n "$CUR" && -d "$CUR" ]] || { echo "!! current 指向的 release 不在（$CUR）—— 拒绝执行"; exit 1; }

if [ "$APPLY" != "--apply" ]; then echo; echo "（干跑。确认无误后加 --apply）"; exit 0; fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$PROD/logs/backups-archive-$STAMP.tsv"
mkdir -p "$PROD/logs"
{
  printf 'backup\tcreatedAt\tdeleted_at\tkept_dirs\n'
  for name in "${DELETE[@]}"; do
    created="$(sed -n 's/.*"createdAt": "\([^"]*\)".*/\1/p' "$BACKUP_ROOT/$name/MANIFEST.json" 2>/dev/null | head -1 || true)"
    printf '%s\t%s\t%s\t%s\n' "$name" "${created:-?}" "$STAMP" "$((${#KEEP[@]}))"
  done
} > "$ARCHIVE"
echo "留档 → $ARCHIVE"   # best-effort：它失败不该拦住删除

freed_before="$(du -sm "$BACKUP_ROOT" | awk '{print $1}')"
for name in "${DELETE[@]}"; do
  case "$name" in
    [0-9]*T[0-9]*Z) : ;;
    *) echo "!! 名字不像备份戳，跳过：$name"; continue ;;
  esac
  rm -rf "$BACKUP_ROOT/$name"
  echo "已删 $name"
done
freed_after="$(du -sm "$BACKUP_ROOT" | awk '{print $1}')"

echo
echo "剩余 $(ls -1 "$BACKUP_ROOT" | grep -cE '^[0-9]{8}T[0-9]{6}Z$') 份时间戳备份；备份目录 ${freed_before}M → ${freed_after}M"
echo "最新那份仍在：$(ls -1 "$BACKUP_ROOT" | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r | head -1)"
printf 'current = '; readlink -f "$PROD/current"
printf 'service: '; systemctl is-active learning-platform-production || true
df -h / | tail -1
# 健康口用**当前域名**（这条以前写着早已下线的 iicili.cyou，打印出来的 000 会误导人）
printf 'health: '; curl -s -o /dev/null -m 12 -w '%{http_code}\n' https://aicyld.com/api/health || true
