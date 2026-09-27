#!/usr/bin/env bash
# 恢复演练：把一份**真备份**恢复起来 → 起一个临时服务核对 → 清理。
#
# ⭐ 2026-09-27 这一版补上了 mysql 分支。起因是两条实测：
#   · 生产 2026-09-25 切到 RDS(MySQL) 之后，这个脚本仍**深度绑定 SQLite**
#     （要 platform.db + PRAGMA integrity_check + 把服务指到那个数据目录）——
#     也就是切库之后**演练等于断了**：找不到 platform.db 直接退 2，等于没有演练。
#   · 而「备份能不能恢复」必须**定期真跑**才算数：§44.2 那份转储就是
#     「mysqldump 退出码 0 / gzip 完好 / sha256 对得上」却**两张表建不起来、根本恢复不了**
#     （函数索引返回裸 MEDIUMTEXT 列 → ERROR 3757）。只看"备份文件在不在"永远看不见这一类雷。
#
# 用法：
#   restore-drill.sh                                     # 演最新一份备份
#   restore-drill.sh --backup /srv/ai-kids-platform/production/backups/<stamp>
#   restore-drill.sh --target-database aild_restore_drill --clean
#   restore-drill.sh --keep                              # 演完不清理（留现场排查）
#
# 退出码（分诊用，别都当"失败"）：
#   0 演练通过
#   2 演练失败（灌不进去 / 服务起不来 / 表数对不上）→ **备份本身有问题**，要处理
#   3 环境缺口，**没跑**（缺 mysql 客户端 / 演练库不存在且当前账号没权限建）→ 不是备份的问题
#   4 拒绝执行（目标库名 = 生产库名 之类的危险配置）→ 必须人工纠正
#
# mysql 分支的三条硬规矩：
#   ① **绝不动生产库**：目标库名不得等于生产库名（两个来源都比对），且目标库必须是**空的**
#      （非空要显式 --clean，而 --clean 只清这一个库里的表）。
#   ② 灌库**不看 mysqldump 的退出码**，看「恢复出来的表数 == 转储里的表数」—— 44.2 那种
#      「退出码 0 但两张表没建起来」只能这么抓；对不上时把**差哪几张表**直接列出来。
#   ③ 客户端凭据优先 --defaults-file（默认 /root/.my.cnf，不进 argv / 不进 ps），
#      退回 MYSQL_*/RDS_* 时口令走 MYSQL_PWD（同样是环境，不是 argv）—— 与 backup-production.mjs 同一套。
#
# 开发机上也能演（本机没有 mysql 客户端，Docker 里有）：
#   PRODUCTION_RESTORE_DRILL_MYSQL_DOCKER=aicyld-mysql-test \
#   PRODUCTION_RESTORE_DRILL_CLIENT_HOST=127.0.0.1 PRODUCTION_RESTORE_DRILL_CLIENT_PORT=3306 \
#   MYSQL_HOST=127.0.0.1 MYSQL_PORT=13306 MYSQL_USER=root MYSQL_PASSWORD=… MYSQL_DATABASE=aild_admin \
#   PRODUCTION_RESTORE_DRILL_ROOT=.tmp/restore-drills PRODUCTION_ROOT=.tmp/drill-root \
#   bash deploy/production/restore-drill.sh --backup <备份目录> --release <仓库根>
#   ↑ 客户端连容器内的 3306；临时服务（app）连宿主映射的 13306 —— 两套地址分开给。
set -Eeuo pipefail

ROOT="${PRODUCTION_ROOT:-/srv/ai-kids-platform/production}"
BACKUP_ROOT="${PRODUCTION_BACKUP_ROOT:-${ROOT}/backups}"
NODE_BIN="${PRODUCTION_NODE_BIN:-/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin/node}"
DRILL_ROOT="${PRODUCTION_RESTORE_DRILL_ROOT:-${ROOT}/restore-drills}"
PORT="${PRODUCTION_RESTORE_DRILL_PORT:-18789}"
SERVICE_TIMEOUT="${PRODUCTION_RESTORE_DRILL_TIMEOUT:-30}"
PRODUCTION_ENV_FILE="${PRODUCTION_ENV_FILE:-/etc/ai-kids-platform/production.env}"
TARGET_DB="${PRODUCTION_RESTORE_DRILL_DATABASE:-aild_restore_drill}"
DOCKER_CONTAINER="${PRODUCTION_RESTORE_DRILL_MYSQL_DOCKER:-}"
DEFAULTS_FILE="${MYSQL_DEFAULTS_FILE:-}"
TARGET_DB_SAFE_RE='^[A-Za-z0-9_]+$'
KEEP=0
CLEAN=0
BACKUP=""
RELEASE_OVERRIDE=""
# 这三个在 trap 之前就要有值（cleanup 会读，set -u 下没值会炸）
pid=""
created_target_db=0
drill_db_touched=0   # 只有"真的动过演练库"（建库/清空/灌数据）才在退出时清理
driver=""
stamp=""
drill_dir=""
health=""
user_count=""
live_users=""
restored_tables=""
prod_db_from_manifest=""
PROD_DB=""

usage() { sed -nE '2,42p' "$0" | sed -E 's/^# ?//' >&2; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP="${2:-}"; shift 2;;
    --release) RELEASE_OVERRIDE="${2:-}"; shift 2;;
    --target-database) TARGET_DB="${2:-}"; shift 2;;
    --defaults-file) DEFAULTS_FILE="${2:-}"; shift 2;;
    --keep) KEEP=1; shift;;
    --clean) CLEAN=1; shift;;
    -h|--help) usage;;
    *) echo "未知参数：$1" >&2; usage;;
  esac
done

fail() { # <原因> [补充行…] — 演练失败（备份的问题）
  local reason="$1"; shift
  echo "✗ 演练失败：${reason}" >&2
  for line in "$@"; do [[ -n "$line" ]] && printf '%s\n' "$line" >&2; done
  write_result "failed" "$reason"
  exit 2
}
not_run() { # <原因> [补充行…] — 环境缺口，没跑（不是备份的问题）
  local reason="$1"; shift
  echo "⚠ 演练没跑（环境缺口，不是备份的问题）：${reason}" >&2
  for line in "$@"; do [[ -n "$line" ]] && printf '%s\n' "$line" >&2; done
  write_result "not_run" "$reason"
  exit 3
}
refuse() { # <原因> [补充行…] — 危险配置，必须人工纠正
  local reason="$1"; shift
  echo "✗ 拒绝执行（危险配置）：${reason}" >&2
  for line in "$@"; do [[ -n "$line" ]] && printf '%s\n' "$line" >&2; done
  exit 4
}
write_result() { # <verdict> <reason> — 尽早留下一行结论（好过"什么都没写"）
  [[ -n "$drill_dir" && -d "$drill_dir" ]] || return 0
  printf 'restore_drill=%s backup=%s restored_at=%s driver=%s target_database=%s reason=%s\n' \
    "$1" "$BACKUP" "$stamp" "${driver:-?}" "$([[ "$driver" == mysql ]] && printf '%s' "$TARGET_DB" || printf 'n/a')" "$2" \
    > "${drill_dir}/RESULT.txt" 2>/dev/null || true
}
# env 文件取值（systemd EnvironmentFile 风格；本机那份实测 82 行、无引号无空格）
env_file_value() {
  local file="$1" key="$2" value
  [[ -r "$file" ]] || return 0
  value="$(grep -m1 -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null || true)"
  value="${value#*=}"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
  printf '%s' "$value"
}
# 读 MANIFEST 的字段（嵌套用 tableCount.inDump 这种点号路径）
manifest_get() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    let v = m;
    for (const part of String(process.argv[2]).split(".")) { v = v == null ? undefined : v[part]; }
    process.stdout.write(v == null ? "" : String(v));
  ' "$1" "$2" 2>/dev/null || true
}

command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "找不到 node：$NODE_BIN" >&2; exit 3; }

# ── 1. 挑备份 ────────────────────────────────────────────────────────────────
BACKUP_EXPLICIT=0
if [[ -n "$BACKUP" ]]; then
  BACKUP_EXPLICIT=1
else
  BACKUP="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' 2>/dev/null | sort | tail -1)"
  [[ -n "$BACKUP" ]] || { echo "在 $BACKUP_ROOT 下找不到任何备份目录" >&2; exit 3; }
fi
BACKUP="$(realpath -m "$BACKUP")"
# 自动挑的必须落在备份根里（手写 --backup 时不拦：开发机演练就是指向别处）
if (( BACKUP_EXPLICIT == 0 )); then
  case "$BACKUP" in "$BACKUP_ROOT"/*) ;; *) echo "备份必须位于 $BACKUP_ROOT 之下：$BACKUP" >&2; exit 2;; esac
fi
[[ -f "${BACKUP}/MANIFEST.json" ]] || { echo "备份不完整（没有 MANIFEST.json）：${BACKUP}" >&2; exit 2; }

driver="$(manifest_get "${BACKUP}/MANIFEST.json" driver)"
db_file="$(manifest_get "${BACKUP}/MANIFEST.json" databaseFile)"
expected_sha="$(manifest_get "${BACKUP}/MANIFEST.json" databaseSha256)"
release_target="$(manifest_get "${BACKUP}/MANIFEST.json" currentTarget)"
[[ -n "$db_file" ]] || db_file="platform.db"
[[ -n "$driver" ]] || driver="sqlite"   # 老备份（切驱动之前）没有 driver 字段，那时只有 sqlite
[[ -f "${BACKUP}/${db_file}" ]] || { echo "备份不完整（缺 ${db_file}）：${BACKUP}" >&2; exit 2; }

# ── 2. 驱动一致性：备的必须是"线上正在用的那个库" ─────────────────────────────
# 这一条就是 §44.1 那场事故的回归网：当时每晚都写 state:"ok"，但备的是切库那刻冻结的 SQLite。
declared_driver="${DB_DRIVER:-$(env_file_value "$PRODUCTION_ENV_FILE" DB_DRIVER)}"
if [[ -n "$declared_driver" && "$driver" != "$declared_driver" ]]; then
  echo "✗ 备份的驱动（${driver}）与线上配置的驱动（${declared_driver}）不一致。" >&2
  echo "  这正是 §44.1 那次「绿灯骗人的备份」的形状：备的不是线上在用的那个库。" >&2
  exit 2
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
drill_dir="${DRILL_ROOT}/${stamp}"
data_dir="${drill_dir}/data"
log_dir="${drill_dir}/logs"
release_dir="${RELEASE_OVERRIDE:-${BACKUP}/release}"
mkdir -p "$data_dir" "$log_dir"
chmod 0750 "$drill_dir" "$data_dir" "$log_dir" 2>/dev/null || true
cp "${BACKUP}/MANIFEST.json" "${drill_dir}/MANIFEST.json"
echo "▸ 备份：$BACKUP（driver=${driver} 文件=${db_file}）"
echo "▸ 演练目录：$drill_dir"

# 备份文件本身的字节完整性（bit rot / 半份文件都会在这里现形）
# ⚠️ MANIFEST 里那个 databaseSha256 就是**这个转储文件**的 sha256（daily-backup.sh 每晚也在核同一个值）
if [[ -n "$expected_sha" ]]; then
  dump_sha="$(sha256sum "${BACKUP}/${db_file}" | awk '{print $1}')"
  [[ "$dump_sha" == "$expected_sha" ]] || fail "备份文件 SHA256 与 MANIFEST 对不上（文件被改过或坏了）" \
    "MANIFEST: ${expected_sha}" "实际    : ${dump_sha}"
fi

# ── 3. 解出 release（临时服务从它启） ────────────────────────────────────────
if [[ -n "$RELEASE_OVERRIDE" ]]; then
  [[ -d "${release_dir}/apps/server/src" ]] || not_run "release 目录不像一棵源码树：${release_dir}"
else
  mkdir -p "${drill_dir}/release"
  cp -a "${release_dir}/." "${drill_dir}/release/" 2>/dev/null || true
  release_dir="${drill_dir}/release"
  [[ -d "${release_dir}/apps/server/src" ]] || not_run "备份里的 release 缺服务端源码（备份可能不完整）"
fi

# ── 4. mysql 分支要的零件（在 trap 之前定义好） ──────────────────────────────
CLIENT_HOST=""
CLIENT_PORT=""
CLIENT_USER=""
CLIENT_PASSWORD=""
mysql_client() { # 参数原样透传给 mysql 客户端（含 -e / 库名），stdin 也可
  if [[ -n "$DOCKER_CONTAINER" ]]; then
    docker exec -i -e "MYSQL_PWD=${CLIENT_PASSWORD}" "$DOCKER_CONTAINER" \
      mysql -h "$CLIENT_HOST" -P "$CLIENT_PORT" -u "$CLIENT_USER" "$@"
  elif [[ -n "$DEFAULTS_FILE" ]]; then
    env -u MYSQL_PWD mysql --defaults-file="$DEFAULTS_FILE" "$@"
  else
    MYSQL_PWD="${CLIENT_PASSWORD}" mysql -h "$CLIENT_HOST" -P "$CLIENT_PORT" -u "$CLIENT_USER" "$@"
  fi
}
drop_all_tables_in_target() { # 只清目标库里的表（外键顺序无所谓）
  local list
  list="$(mysql_client -N -B -e "select table_name from information_schema.tables where table_schema='${TARGET_DB}'" 2>/dev/null || true)"
  [[ -n "$list" ]] || return 0
  { echo "SET FOREIGN_KEY_CHECKS=0;"
    while IFS= read -r t; do [[ -n "$t" ]] && printf 'DROP TABLE IF EXISTS `%s`.`%s`;\n' "$TARGET_DB" "$t"; done <<< "$list"
    echo "SET FOREIGN_KEY_CHECKS=1;"
  } | mysql_client >/dev/null 2>&1 || true
}
cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  # 兜底：停掉任何仍占着演练端口的监听者
  if command -v ss >/dev/null 2>&1; then
    local residual
    residual="$(ss -ltnp "sport = :${PORT}" 2>/dev/null | grep -o 'pid=[0-9]\+' | cut -d= -f2 | sort -u || true)"
    if [[ -n "$residual" ]]; then
      echo "Stopping residual restore-drill process(es): ${residual}" >&2
      kill $residual 2>/dev/null || true
      sleep 1
      kill -9 $residual 2>/dev/null || true
    fi
  fi
  # 清理演练库（**只动目标库**；生产库名在上面已经硬拦掉了）
  if (( drill_db_touched == 1 )); then
    if (( KEEP == 1 )); then
      echo "▸ --keep：演练库 ${TARGET_DB} 原样留着（清法：drop 掉里面的表$(( created_target_db == 1 )) && printf '，或整库 drop %s' "$TARGET_DB"）" >&2
    else
      drop_all_tables_in_target
      if (( created_target_db == 1 )); then
        mysql_client -e "DROP DATABASE IF EXISTS \`${TARGET_DB}\`" >/dev/null 2>&1 || true
      fi
      echo "▸ 已清理演练库 ${TARGET_DB}"
    fi
  fi
  return 0
}
trap cleanup EXIT

# ── 5. 临时服务（两个驱动共用） ─────────────────────────────────────────────
start_drill_service() { # <driver> —— 起在 $PORT 上，pid 写全局
  (
    cd "$release_dir"
    if [[ "$1" == "mysql" && -r "$PRODUCTION_ENV_FILE" && -z "${PRODUCTION_RESTORE_DRILL_NO_ENV_FILE:-}" ]]; then
      # 应用自己不读 env 文件（仓里没有 dotenv），只能整份读进来喂给它
      set -a; . "$PRODUCTION_ENV_FILE"; set +a
    fi
    # ⚠️ 生产 env 里 PLATFORM_DB_PATH 指着那份 SQLite —— 必须去掉，否则临时服务会去开它
    unset PLATFORM_DB_PATH DEPLOYMENT_MODE
    export NODE_ENV=production "PORT=$PORT" API_HOST=127.0.0.1 "PLATFORM_DATA_DIR=$data_dir"
    export AI_PROVIDER=local-mock
    if [[ "$1" == "mysql" ]]; then
      # 库指针改到演练库；驱动钉死。连库地址沿用 RDS_*/MYSQL_*（本机演练时是 docker 映射过来的）
      export DB_DRIVER=mysql "MYSQL_DATABASE=$TARGET_DB" "RDS_DATABASE=$TARGET_DB"
    else
      export "PLATFORM_DB_PATH=${data_dir}/${db_file}" "AUTH_PEPPER=${AUTH_PEPPER:-}"
    fi
    exec "$NODE_BIN" apps/server/src/index.js
  ) >"${log_dir}/server.stdout.log" 2>"${log_dir}/server.stderr.log" &
  pid=$!
}
wait_for_health() {
  local deadline=$((SECONDS+SERVICE_TIMEOUT)) health_json=""
  while (( SECONDS < deadline )); do
    if health_json="$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null)"; then break; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  [[ -n "$health_json" ]] || fail "临时的恢复服务没起来（健康检查没过）" "$(tail -20 "${log_dir}/server.stderr.log" 2>/dev/null)"
  health="$health_json"
}

# ── 6. sqlite 分支（老路，原样保留） ────────────────────────────────────────
run_sqlite_drill() {
  cp "${BACKUP}/${db_file}" "${data_dir}/${db_file}"
  chmod 0640 "${data_dir}/${db_file}" 2>/dev/null || true
  local actual integrity
  actual="$(sha256sum "${data_dir}/${db_file}" | awk '{print $1}')"
  [[ -z "$expected_sha" || "$expected_sha" == "$actual" ]] || fail "恢复出来的库 SHA256 与 MANIFEST 不一致"
  integrity="$("$NODE_BIN" --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('pragma integrity_check').get().integrity_check);d.close()" "${data_dir}/${db_file}")"
  [[ "$integrity" == "ok" ]] || fail "恢复出来的库 integrity_check 失败：${integrity}"
  start_drill_service sqlite
  wait_for_health
  user_count="$("$NODE_BIN" --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('select count(*) n from users where deleted_at is null').get().n);d.close()" "${data_dir}/${db_file}")"
  live_users="n/a"
  restored_tables="n/a"
}

# ── 7. mysql 分支（新路） ───────────────────────────────────────────────────
prepare_mysql_client() {
  if [[ -n "$DOCKER_CONTAINER" ]]; then
    [[ -n "$DEFAULTS_FILE" ]] && echo "▸ docker 模式忽略 --defaults-file（容器里没有这个文件）" >&2
    CLIENT_HOST="${PRODUCTION_RESTORE_DRILL_CLIENT_HOST:-127.0.0.1}"
    CLIENT_PORT="${PRODUCTION_RESTORE_DRILL_CLIENT_PORT:-3306}"
  else
    if [[ -z "$DEFAULTS_FILE" && -f /root/.my.cnf ]]; then DEFAULTS_FILE=/root/.my.cnf; fi
    [[ -n "$DEFAULTS_FILE" && -f "$DEFAULTS_FILE" ]] || DEFAULTS_FILE=""
    CLIENT_HOST="${MYSQL_HOST:-${RDS_HOST:-$(env_file_value "$PRODUCTION_ENV_FILE" RDS_HOST)}}"
    CLIENT_PORT="${MYSQL_PORT:-${RDS_PORT:-3306}}"
  fi
  CLIENT_USER="${MYSQL_USER:-${RDS_USER:-$(env_file_value "$PRODUCTION_ENV_FILE" RDS_USER)}}"
  CLIENT_PASSWORD="${MYSQL_PASSWORD:-${RDS_PASSWORD:-$(env_file_value "$PRODUCTION_ENV_FILE" RDS_PASSWORD)}}"
  if [[ -z "$DEFAULTS_FILE" && -z "$CLIENT_USER" ]]; then
    not_run "mysql 分支需要凭据：给 --defaults-file，或 MYSQL_USER/MYSQL_PASSWORD（RDS_* 也认）"
  fi
  if [[ -n "$DOCKER_CONTAINER" ]]; then
    command -v docker >/dev/null 2>&1 || not_run "指定了 PRODUCTION_RESTORE_DRILL_MYSQL_DOCKER=${DOCKER_CONTAINER}，但找不到 docker"
  else
    command -v mysql >/dev/null 2>&1 || not_run "这台机器上没有 mysql 客户端（开发机可给 PRODUCTION_RESTORE_DRILL_MYSQL_DOCKER 走 docker）"
  fi
  # 生产库名：两个来源都要比对（跑脚本的环境 / 备份自己的 MANIFEST）
  PROD_DB="${MYSQL_DATABASE:-${RDS_DATABASE:-$(env_file_value "$PRODUCTION_ENV_FILE" MYSQL_DATABASE)}}"
  PROD_DB="${PROD_DB:-$(env_file_value "$PRODUCTION_ENV_FILE" RDS_DATABASE)}"
  local url
  url="$(manifest_get "${BACKUP}/MANIFEST.json" database)"
  if [[ "$url" == */* ]]; then prod_db_from_manifest="${url##*/}"; fi
}
run_mysql_drill() {
  [[ "$TARGET_DB" =~ $TARGET_DB_SAFE_RE ]] || refuse "演练库名只能是字母数字下划线：${TARGET_DB}"
  [[ -z "$PROD_DB" || "$TARGET_DB" != "$PROD_DB" ]] \
    || refuse "演练库名（${TARGET_DB}）就是生产库名，绝不能拿它演练"
  [[ -z "$prod_db_from_manifest" || "$TARGET_DB" != "$prod_db_from_manifest" ]] \
    || refuse "演练库名（${TARGET_DB}）等于备份 MANIFEST 里记的生产库名（${prod_db_from_manifest}）"
  [[ "$TARGET_DB" != "aild_admin" ]] || refuse "aild_admin 是生产库名"

  mysql_client -e "select 1" >/dev/null 2>"${log_dir}/connect.err" \
    || not_run "连不上 MySQL（$(head -1 "${log_dir}/connect.err" 2>/dev/null)）"

  # 演练库：没有就建；建不了 = 环境缺口（不是备份的问题）
  local exists tables_now
  exists="$(mysql_client -N -B -e "select count(*) from information_schema.schemata where schema_name='${TARGET_DB}'")"
  if [[ "$exists" == "0" ]]; then
    if mysql_client -e "CREATE DATABASE \`${TARGET_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci" 2>"${log_dir}/create-db.err"; then
      created_target_db=1
      drill_db_touched=1
      echo "▸ 建了演练库 ${TARGET_DB}"
    else
      not_run "演练库 ${TARGET_DB} 不存在，当前账号也建不了（$(head -1 "${log_dir}/create-db.err" 2>/dev/null)）" \
        "一次性准备（在阿里云 RDS 控制台「数据库管理」建库 + 「账号管理」授权，或用一个有权限的会话）：" \
        "    CREATE DATABASE \`${TARGET_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;" \
        "    GRANT ALL PRIVILEGES ON \`${TARGET_DB}\`.* TO '${CLIENT_USER:-<账号>}'@'%';" \
        "    FLUSH PRIVILEGES;" \
        "⚠️ 只授权给这个演练库，别动生产库。" \
        "⚠️ RDS 普通账号的「读写」权限只有 DML：演练要建表，得给到 DDL（或换高权限账号）。"
    fi
  fi
  tables_now="$(mysql_client -N -B -e "select count(*) from information_schema.tables where table_schema='${TARGET_DB}'")"
  if (( tables_now > 0 )); then
    # ⚠️ 不是空的、又没给 --clean：**绝不能动**（那可能是别人的库）—— 只是没跑
    (( CLEAN == 1 )) || not_run "演练库 ${TARGET_DB} 不是空的（${tables_now} 张表）" \
      "加 --clean 让演练先把它清空（只会清这一个库）。"
    drill_db_touched=1
    echo "▸ --clean：先清空演练库 ${TARGET_DB}（${tables_now} 张表）"
    drop_all_tables_in_target
  fi
  drill_db_touched=1   # 下一步就灌数据了

  # 灌库：不看退出码，看表数
  echo "▸ 把 ${db_file} 灌进 ${TARGET_DB}…"
  if ! gzip -dc "${BACKUP}/${db_file}" | mysql_client "$TARGET_DB" >"${log_dir}/restore.stdout.log" 2>"${log_dir}/restore.stderr.log"; then
    # 先分诊：权限不够是**环境缺口**，不是备份坏了（否则会让人去追一个不存在的问题）
    if grep -qE 'ERROR (1044|1045|1142|1227)|command denied|Access denied' "${log_dir}/restore.stderr.log"; then
      not_run "演练库 ${TARGET_DB} 的权限不够，灌不进去（不是备份的问题）" \
        "$(grep -m1 -E 'ERROR (1044|1045|1142|1227)' "${log_dir}/restore.stderr.log")" \
        "演练要在那个库里建表 —— 账号得有 DDL 权限。只给这个演练库授权，别动生产库。"
    fi
    fail "转储灌不进演练库（这就是演练的意义：这种备份不能用来恢复）" "$(tail -20 "${log_dir}/restore.stderr.log")"
  fi
  [[ ! -s "${log_dir}/restore.stderr.log" ]] || echo "▸ 灌库告警（前 5 行）：$(head -5 "${log_dir}/restore.stderr.log" | tr '\n' ' ')" >&2

  restored_tables="$(mysql_client -N -B -e "select count(*) from information_schema.tables where table_schema='${TARGET_DB}' and table_type='BASE TABLE'")"
  local in_dump missing dump_declared
  in_dump="$(manifest_get "${BACKUP}/MANIFEST.json" tableCount.inDump)"
  if [[ -n "$in_dump" && "$restored_tables" != "$in_dump" ]]; then
    # 把"差哪几张表"直接列出来 —— 44.2 那次就是两张表没建起来（ERROR 3757）
    gzip -dc "${BACKUP}/${db_file}" | grep -oE '^CREATE TABLE (`[^`]+`)' | sed -E 's/^CREATE TABLE `//; s/`$//' | sort -u > "${log_dir}/dump-tables.txt"
    mysql_client -N -B -e "select table_name from information_schema.tables where table_schema='${TARGET_DB}' and table_type='BASE TABLE'" | sort -u > "${log_dir}/restored-tables.txt"
    dump_declared="$(grep -c . "${log_dir}/dump-tables.txt" || true)"
    if [[ "$dump_declared" != "$in_dump" ]]; then
      # 转储自己就少/多建表语句（不是"建失败"，是文件本身不对）
      missing="⚠ 转储文件里有 ${dump_declared} 条 CREATE TABLE，MANIFEST 记的是 ${in_dump} 张 —— 两者就对不上，说明这份备份文件本身不完整/被改过（灌得进去不代表灌全了），缺哪几张表无从比对"
    else
      missing="没建起来的表：$(comm -23 "${log_dir}/dump-tables.txt" "${log_dir}/restored-tables.txt" | tr '\n' ' ')"
    fi
    fail "表数对不上：转储里 ${in_dump} 张，恢复出来 ${restored_tables} 张" \
      "$missing" \
      "（§44.2 就是这么发现那份转储根本恢复不了的：mysqldump 退出码是 0）" \
      "$(grep -m5 -iE '^ERROR' "${log_dir}/restore.stderr.log" 2>/dev/null || true)"
  fi

  start_drill_service mysql
  wait_for_health
  user_count="$(mysql_client -N -B -e "select count(*) from \`${TARGET_DB}\`.users where deleted_at is null")"
  if [[ -n "$PROD_DB" ]]; then
    live_users="$(mysql_client -N -B -e "select count(*) from \`${PROD_DB}\`.users where deleted_at is null" 2>/dev/null || echo '?')"
  else
    live_users="?"
  fi
}

# ── 8. 跑 ───────────────────────────────────────────────────────────────────
case "$driver" in
  sqlite) run_sqlite_drill;;
  mysql)  prepare_mysql_client; run_mysql_drill;;
  *)      fail "MANIFEST 里的驱动不认识：${driver}";;
esac

kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; pid=""
target_display="n/a"; [[ "$driver" == "mysql" ]] && target_display="$TARGET_DB"
printf '%s\n' \
  "restore_drill=passed backup=${BACKUP} restored_at=${stamp} driver=${driver} target_database=${target_display} health=${health} active_users=${user_count} live_users=${live_users} tables=${restored_tables} release=${release_target}" \
  | tee "${drill_dir}/RESULT.txt"
find "$DRILL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' -mtime +6 -exec rm -rf -- {} +
