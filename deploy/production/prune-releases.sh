#!/usr/bin/env bash
# 清 production/releases，只留最新 10 份（口径 2026-09-20 起；手工跑，没有定时任务）。
# 用法：bash prune-releases.sh          —— 只列，不删（干跑）
#       bash prune-releases.sh --apply  —— 真删，并在 logs/releases-archive-<stamp>.tsv 留档 release→commit
#
# 安全约束（都在下面断言）：① 保留集必须包含 current 指向的那一份；② 至少保留 10 份；
# ③ 只删 releases 下、名字形如 <stamp> 的目录，别的一律不碰。
set -euo pipefail

PROD=/srv/ai-kids-platform/production
KEEP=10
APPLY="${1:-}"

CUR=$(readlink -f "$PROD/current")
CUR_NAME=$(basename "$CUR")
mapfile -t ALL < <(ls -1 "$PROD/releases" | sort -r)
echo "现有 $((${#ALL[@]})) 份，current = $CUR_NAME"

KEEP_SET=("${ALL[@]:0:$KEEP}")
DELETE_SET=("${ALL[@]:$KEEP}")

if [ "${#ALL[@]}" -le "$KEEP" ]; then echo "不超过 $KEEP 份，不用清"; exit 0; fi
KEPT_CURRENT=0; for r in "${KEEP_SET[@]}"; do [ "$r" = "$CUR_NAME" ] && KEPT_CURRENT=1; done
if [ "$KEPT_CURRENT" != 1 ]; then echo "!! current（$CUR_NAME）不在保留集里 —— 拒绝执行"; exit 1; fi

echo "保留（$((${#KEEP_SET[@]})) 份）："; printf '   %s\n' "${KEEP_SET[@]}"
echo "待删（$((${#DELETE_SET[@]})) 份）："; printf '   %s\n' "${DELETE_SET[@]}"
if [ "$APPLY" != "--apply" ]; then echo; echo "（干跑。确认无误后加 --apply）"; exit 0; fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$PROD/logs/releases-archive-$STAMP.tsv"
{
  printf 'release\tcommit\tdeleted_at\tkept_releases\n'
  for r in "${DELETE_SET[@]}"; do
    # ⚠️ `|| true` 不能省：pipefail 下 sed 被 head 提前关管道（SIGPIPE）会判成失败 →
    #    set -e 直接把脚本带走，表现是列了要删的、一条都没删（2026-09-21 实测踩到）。
    commit=$(sed -n 's/^commit=//p' "$PROD/releases/$r/BUILD-METADATA.txt" 2>/dev/null | head -1 || true)
    printf '%s\t%s\t%s\t%s\n' "$r" "${commit:-?}" "$STAMP" "$KEEP"
  done
} > "$ARCHIVE"
echo "留档 → $ARCHIVE"  # 留档是 best-effort：它失败也不该拦住后面的删除

for r in "${DELETE_SET[@]}"; do
  case "$r" in
    [0-9]*T[0-9]*Z) : ;;
    *) echo "!! 名字不像 release 戳，跳过：$r"; continue ;;
  esac
  [ "$r" = "$CUR_NAME" ] && { echo "!! 跳过 current：$r"; continue; }
  rm -rf "${PROD:?}/releases/$r"
  echo "已删 $r"
done

echo
echo "剩余 $(ls -1 "$PROD/releases" | wc -l) 份；current = $(readlink -f "$PROD/current")"
printf 'service: '; systemctl is-active learning-platform-production
df -h / | tail -1
for u in / /admin/ /org/ /student/ /api/health; do printf '%s ' "$u"; curl -s -o /dev/null -m 12 -w '%{http_code}\n' "https://iicili.cyou$u"; done
