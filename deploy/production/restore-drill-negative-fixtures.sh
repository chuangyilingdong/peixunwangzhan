#!/usr/bin/env bash
# 恢复演练的**负向夹具**：造四份"坏备份"，证明 `restore-drill.sh` 真的会红（而不是只报喜）。
#
# 为什么要有它：演练脚本最容易退化成"永远绿" —— 灌库那一步`mysqldump` 退出码是 0、
# gzip 完好、sha256 也对得上，**但转储其实恢复不了**（§44.2 实测：两张表建不起来）。
# 一个只会说"通过"的演练比没有演练更糟。改完 `restore-drill.sh` 之后拿这个跑一遍，
# 四条都必须按预期红、且**理由要对**（不是"随便红了就算"）。
#
# 用法（需要：一份真备份 + 一个能建库的 MySQL）：
#   bash deploy/production/restore-drill-negative-fixtures.sh --backup <备份目录> [--out .tmp/drill-fixtures]
#   # 它会打印四条该跑的命令；夹具的 MANIFEST sha 已经对齐，所以 sha 检查不会先拦下来
#   #（这点很要紧：要测的是"表数对不上"，不能让 sha 检查替它挡枪）
#
# 四份夹具与预期：
#   bad-sql        转储末尾追加一句语法错的 SQL（gz 合法）→ 灌不进去 → exit 2
#   extra-table    末尾追加一张 zz_ghost 的建表语句（灌得干净）→ 表数 90 vs 91 → exit 2
#   missing-table  整段删掉一张表（转储自己就少一张）→ 说法是「备份文件本身不完整」→ exit 2
#   silent-drop    转储声明它、末尾又 DROP 掉 → **灌得干净、退出码 0** → 必须**指名**
#                  「没建起来的表：<表名>」→ exit 2（这就是 §44.2 的形状）
set -Eeuo pipefail

NODE_BIN="${NODE_BIN:-$(command -v node)}"
SRC=""
OUT=".tmp/drill-fixtures"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) SRC="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    *) echo "用法：$0 --backup <备份目录> [--out <输出目录>]" >&2; exit 2;;
  esac
done
[[ -n "$SRC" && -f "${SRC}/database.sql.gz" && -f "${SRC}/MANIFEST.json" ]] \
  || { echo "--backup 要给一个有 database.sql.gz + MANIFEST.json 的备份目录" >&2; exit 2; }
command -v gzip >/dev/null || { echo "需要 gzip" >&2; exit 3; }

mkdir -p "$OUT"
PLAIN="${OUT}/plain.sql"
gzip -dc "${SRC}/database.sql.gz" > "$PLAIN"
echo "▸ 原始转储：$(grep -cE '^CREATE TABLE' "$PLAIN") 张表 / $(wc -l < "$PLAIN") 行"

# 把 MANIFEST 的 sha 改成与夹具一致 —— 否则 sha 检查会先红，测不到我们要测的那一步
patch_manifest() { # <夹具目录> <sha>
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    m.databaseSha256 = process.argv[3];
    fs.writeFileSync(process.argv[2], JSON.stringify(m, null, 2) + "\n");
  ' "${SRC}/MANIFEST.json" "$1/MANIFEST.json" "$2"
}
seal() { # <夹具目录> —— 压缩 + 对齐 sha
  gzip -c "$PLAIN" > "$1/database.sql.gz"
  patch_manifest "$1" "$(sha256sum "$1/database.sql.gz" | awk '{print $1}')"
}
reset_plain() { gzip -dc "${SRC}/database.sql.gz" > "$PLAIN"; }

rm -rf "${OUT}/bad-sql" && mkdir -p "${OUT}/bad-sql"
printf '\nTHIS IS NOT VALID SQL;\n' >> "$PLAIN"; seal "${OUT}/bad-sql"; reset_plain

rm -rf "${OUT}/extra-table" && mkdir -p "${OUT}/extra-table"
printf '\nCREATE TABLE `zz_ghost` (\n  `id` int NOT NULL PRIMARY KEY\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n' >> "$PLAIN"
seal "${OUT}/extra-table"; reset_plain

# 挑一张"没有任何表用外键引用它"的表，整段删掉（否则删了会连累引用它的那张表建不起来）
REFERENCED="$(grep -oE 'REFERENCES `[^`]+`' "$PLAIN" | sed -E 's/REFERENCES `//; s/`//' | sort -u)"
VICTIM="$(grep -oE '^CREATE TABLE `[^`]+`' "$PLAIN" | sed -E 's/^CREATE TABLE `//; s/`//' \
          | while read -r t; do grep -qxF "$t" <<< "$REFERENCED" || { echo "$t"; break; }; done)"
echo "▸ missing-table / silent-drop 用这张表：${VICTIM}"
rm -rf "${OUT}/missing-table" && mkdir -p "${OUT}/missing-table"
awk -v hdr="-- Table structure for table \`${VICTIM}\`" '
  $0 == hdr { skip = 1 }
  skip { if ($0 == "UNLOCK TABLES;") { skip = 0 } ; next }
  { print }
' "$PLAIN" > "${OUT}/plain-missing.sql"
mv "${OUT}/plain-missing.sql" "$PLAIN"; seal "${OUT}/missing-table"; reset_plain

# silent-drop：声明了、也灌得干净（退出码 0），但表最后不在 —— 只能靠表数对账抓出来
rm -rf "${OUT}/silent-drop" && mkdir -p "${OUT}/silent-drop"
printf '\nDROP TABLE `%s`;\n' "$VICTIM" >> "$PLAIN"; seal "${OUT}/silent-drop"; reset_plain

cat <<EOF

四份夹具就绪（在 ${OUT}/）。逐条跑，预期都是 **exit 2**，且理由分别对得上：

  # 1) bad-sql       → "转储灌不进演练库" + 日志里 ERROR 1064
  # 2) extra-table   → "转储里 90 张，恢复出来 91 张"
  # 3) missing-table → "备份文件本身不完整"（转储自己少了一张）
  # 4) silent-drop   → "没建起来的表：${VICTIM}"

  for f in bad-sql extra-table missing-table silent-drop; do
    bash deploy/production/restore-drill.sh --backup ${OUT}/\$f --keep
    echo "\$f → exit=\$?（期望 2）"
  done

（--keep 是为了留下现场；确认完把那些演练库里的表清掉即可。跑完别忘了用真备份再跑一次“应当通过”，
 否则你只证明了它会红、没证明它会绿。）
EOF
