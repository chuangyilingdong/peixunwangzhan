#!/usr/bin/env bash
# 上游产物地址 TTL 探针 —— 回答「上游给的临时地址到底能活多久」。
#
# 为什么要它（2026-11-01 实测背景）：
#   归档策略取决于上游 URL 的有效期。如果只能活 1 小时，1000 条 H3 的 20GB 必须当场收完，
#   入向带宽就得 ≥45Mbps；如果能活 3 天，归档可以摊到课后几小时，带宽压力几乎消失。
#   这个数不能拍脑袋，也不能问上游（对方多半只回「临时地址」），只能自己测。
#
# ⚠️ 一次性统计只能给**下界**，给不了准确 TTL：
#   你只能看到「现在 X 小时的地址还活着」，看不到「它是什么时候死的」。
#   要给准确值，必须**反复跑**这个脚本，靠 first_seen_dead_at 记录第一次失效的时刻。
#   推荐每天由 cron 跑一次，跑够超过 TTL 的天数才有结论。
#
# ⚠️ 两个实测踩到的坑，别改掉：
#   ① `000`（curl 连不上）**不是失效**。2026-11-01 那次跑 328 条，有 2 条 000，
#      全是网络瞬断，重试就 200 —— 如果把它们算成失效，结论会完全错。
#      所以这里对 000 重试 3 次，仍失败记为 UNREACHABLE，单独统计。
#   ② `403` 与 `404` 含义不同：403 是「签名/防盗链过期」，404 是「对象被删」。
#      两者都算失效，但排障时要分开看。
#
# 用法（在**生产服务器**上跑，因为要读 env 里的 RDS 口令 + 走内网到 RDS）：
#   bash scripts/probe-upstream-artifact-ttl.sh                 # 看最近 7 天
#   bash scripts/probe-upstream-artifact-ttl.sh --days 30       # 看最近 30 天
#   bash scripts/probe-upstream-artifact-ttl.sh --csv /var/log/upstream-ttl.csv   # 追加记录
#
# cron（每天 04:17，错开整点）：
#   17 4 * * * bash /srv/ai-kids-platform/source/scripts/probe-upstream-artifact-ttl.sh --days 30 --csv /var/log/ai-kids-platform/upstream-ttl.csv >> /var/log/ai-kids-platform/upstream-ttl.log 2>&1
set -u

ENV_FILE="${ENV_FILE:-/etc/ai-kids-platform/production.env}"
DAYS=7
CSV=""
PARALLEL=6
TIMEOUT=8

while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    --csv)  CSV="$2"; shift 2 ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[ -r "$ENV_FILE" ] || { echo "读不到 $ENV_FILE（这个脚本要在生产服务器上跑）" >&2; exit 1; }
command -v mysql >/dev/null || { echo "缺 mysql 客户端" >&2; exit 1; }
command -v curl  >/dev/null || { echo "缺 curl" >&2; exit 1; }

# 口令走环境变量，不出现在 ps / 命令行里
envval() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
export MYSQL_PWD="$(envval RDS_PASSWORD)"
RDS_HOST="$(envval RDS_HOST)"; RDS_USER="$(envval RDS_USER)"; RDS_DB="$(envval RDS_DATABASE)"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# 取「生成时间 + 上游地址」。metadata.upstreamUrl 是归档时写进去的原始地址。
mysql -h "$RDS_HOST" -u "$RDS_USER" -D "$RDS_DB" -N -B -e "
SELECT created_at, JSON_UNQUOTE(JSON_EXTRACT(metadata,'\$.upstreamUrl'))
FROM file_assets
WHERE JSON_EXTRACT(metadata,'\$.upstreamUrl') IS NOT NULL
  AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL $DAYS DAY)
ORDER BY created_at;" > "$TMP/raw.tsv" 2>/dev/null

LINES=$(wc -l < "$TMP/raw.tsv")
if [ "$LINES" -eq 0 ]; then echo "最近 $DAYS 天没有带上游地址的产物"; exit 0; fi

NOW=$(date +%s)
# age_hours \t url
awk -F'\t' '{print $1"\t"$2}' "$TMP/raw.tsv" | while IFS=$'\t' read -r created url; do
  iso=$(echo "$created" | sed -E 's/\.[0-9]+Z$/Z/')
  ts=$(date -d "$iso" +%s 2>/dev/null) || continue
  [ -n "$url" ] || continue
  printf '%d\t%s\n' $(( (NOW - ts) / 3600 )) "$url"
done > "$TMP/ages.tsv"

# 探活丢给 bash -c 执行（不能 export -f 给 sh：dash 不认 bash 函数）。
# $0 传超时值，$1/$2 是 xargs 给的 age 与 url；URL 里没有空格，默认按空白切分即可。
awk -F'\t' '{printf "%s %s\n", $1, $2}' "$TMP/ages.tsv" \
  | xargs -P "$PARALLEL" -n 2 bash -c '
probe_one() {
  age="$1"; url="$2"; code=""
  for try in 1 2 3; do
    code=$(curl -sI -o /dev/null -w "%{http_code}" --max-time "$0" "$url" 2>/dev/null)
    # 头请求若被上游拒绝（有的 CDN 不支持 HEAD），退化成只取 1 字节
    case "$code" in
      405|501) code=$(curl -s -o /dev/null -r 0-0 -w "%{http_code}" --max-time "$0" "$url" 2>/dev/null) ;;
    esac
    [ "$code" = "000" ] || break
    sleep $(( try * 2 ))
  done
  [ "$code" = "000" ] && code=UNREACHABLE
  host=$(printf "%s" "$url" | sed -E "s#^https?://([^/]+)/.*#\1#")
  printf "%s|%s|%s\n" "$age" "$host" "$code"
}
probe_one "$1" "$2"
' "$TIMEOUT" > "$TMP/probe.txt"

echo "════════ 上游产物地址存活情况（最近 $DAYS 天，共 $LINES 条）════════"
echo
printf '%-46s %6s %6s %8s %8s %10s\n' "域名" "样本" "可用" "403/404" "连不上" "年龄(h)"
awk -F'|' '{
  h=$2; a=$1+0; c=$3;
  n[h]++
  if(c=="200") ok[h]++
  else if(c=="403" || c=="404") dead[h]++
  else if(c=="UNREACHABLE") unreach[h]++
  if(!(h in mn) || a<mn[h]) mn[h]=a
  if(a>mx[h]) mx[h]=a
} END {
  for (h in n) printf "%-46s %6d %6d %8d %8d %5d-%-4d\n", h, n[h], ok[h]+0, dead[h]+0, unreach[h]+0, mn[h], mx[h]
}' "$TMP/probe.txt" | sort -k2 -nr

echo
echo "按年龄分桶（只算真正取到响应的；UNREACHABLE 不计入分母）"
awk -F'|' '{
  a=$1+0; c=$3;
  if(c=="UNREACHABLE") next;
  if(a<=6) b="0-6h"; else if(a<=24) b="6-24h"; else if(a<=48) b="1-2d"; else if(a<=72) b="2-3d";
  else if(a<=168) b="3-7d"; else if(a<=336) b="7-14d"; else b=">14d";
  n[b]++; if(c=="200") ok[b]++
} END {
  split("0-6h 6-24h 1-2d 2-3d 3-7d 7-14d >14d", order, " ");
  for (i=1;i<=7;i++) { b=order[i]; if(n[b]) printf "  %-7s %5d / %5d 可用  (%.1f%%)\n", b, ok[b]+0, n[b], 100*ok[b]/n[b] }
}' "$TMP/probe.txt"

if [ -n "$CSV" ]; then
  mkdir -p "$(dirname "$CSV")" 2>/dev/null || true
  [ -f "$CSV" ] || echo "probed_at,age_hours,host,http_code" > "$CSV"
  stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  awk -F'|' -v s="$stamp" '{printf "%s,%s,%s,%s\n", s, $1, $2, $3}' "$TMP/probe.txt" >> "$CSV"
  echo
  echo "已追加 $LINES 行到 $CSV（同一地址多天出现多次，靠 probed_at 区分）"
fi

cat <<'NOTE'

── 怎么从这些数得出「准确 TTL」 ─────────────────────────────
1. 一次运行只能证明"至少活到 X 小时"，给不出上界。
2. 让 cron 每天跑一次（--csv 指向同一个文件），跑够 2 周以上。
3. 对同一 host 取每个地址「第一次出现非 200 的时刻」减「生成时刻」，
   得到该地址的存活时长；再取 P50/P95 就是 TTL 的实测分布。
4. 判断标准：
   · 若 P95 ≥ 24h → 归档可以完全解耦到课后，教室不等字节，带宽压力消失；
   · 若 P95 在 1-6h → 需要 45Mbps 以上的入向带宽才能在一节课内收完；
   · 若出现大量 403 且年龄很集中 → 那是签名过期，不是对象删除（两者要分开定策略）。
NOTE
