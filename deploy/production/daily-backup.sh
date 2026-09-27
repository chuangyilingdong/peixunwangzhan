#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${PRODUCTION_ROOT:-/srv/ai-kids-platform/production}"
BACKUP_ROOT="${PRODUCTION_BACKUP_ROOT:-${ROOT}/backups}"
# 留存天数（用户口径 2026-09-21：**留近 7 天**；此前是 14 天）。
# 为什么值得收：每次发布都会整库备份，发布多的时候一天 ~30 份。
# ⚠️ 2026-09-27 修正这行的算术：单份**不是 ~21MB 而是 ~217MB** —— 每份除库之外还拷了一整棵
#    release 树（约 195MB，含 node_modules）。也就是说占盘的大头是 release 树、不是库：
#    SQLite 那份库 22MB，换成 MySQL 转储后只有 ~2.6MB，**对总盘占用几乎没影响**。
#    14 天就是 7.3G（磁盘一共 40G），7 天约 3-4G —— 这个结论不变。
# ⚠️ 留着它就得留着「一周内任意一次发布的库」：更早的 release 若回滚，配套的库备份可能已经删了。
KEEP_DAYS="${PRODUCTION_BACKUP_RETENTION_DAYS:-7}"
SOURCE_DIR="${PRODUCTION_SOURCE_DIR:-/srv/ai-kids-platform/internal-test/source}"
STATE_DIR="${ROOT}/state"
STATE_FILE="${STATE_DIR}/last-backup-state.json"
NODE_BIN="${PRODUCTION_NODE_BIN:-/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin/node}"

mkdir -p "${BACKUP_ROOT}" "${STATE_DIR}"
export PATH="${NODE_BIN%/*}:${PATH}"

if [[ "${KEEP_DAYS}" =~ ^[0-9]+$ ]] && (( KEEP_DAYS < 1 )); then
  echo "PRODUCTION_BACKUP_RETENTION_DAYS must be >= 1" >&2
  exit 2
fi

start_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if output="$(bash "${SOURCE_DIR}/deploy/production/backup-production.sh" 2>&1)"; then
  backup_dir="$(printf '%s\n' "$output" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);process.stdout.write(x.backupDir||'')})")"
  if [[ -z "$backup_dir" || ! -f "${backup_dir}/MANIFEST.json" ]]; then
    echo "Backup output is incomplete" >&2
    printf '%s\n' "$output" >&2
    exit 2
  fi
  # 驱动与库文件名都从 MANIFEST 读 —— 单一出处，由 backup-production.mjs 决定。
  # ⚠️ ⭐ 原来这里硬写 `platform.db` + PRAGMA integrity_check，切库到 RDS 之后就成了
  #    「每晚认证一份冻结的旧 SQLite」：所以必须先问是哪个驱动，再选校验方式。
  driver="$(node -e "const m=require(process.argv[1]);process.stdout.write(m.driver||'')" "${backup_dir}/MANIFEST.json")"
  db_file="$(node -e "const m=require(process.argv[1]);process.stdout.write(m.databaseFile||'')" "${backup_dir}/MANIFEST.json")"
  expected="$(node -e "const m=require(process.argv[1]);process.stdout.write(m.databaseSha256||'')" "${backup_dir}/MANIFEST.json")"
  if [[ -z "$driver" || -z "$db_file" || -z "$expected" || ! -f "${backup_dir}/${db_file}" ]]; then
    echo "Backup manifest incomplete (driver='${driver}' file='${db_file}')" >&2
    printf '%s\n' "$output" >&2
    exit 2
  fi
  actual="$(sha256sum "${backup_dir}/${db_file}" | awk '{print $1}')"
  [[ "$expected" == "$actual" ]] || { echo "Backup SHA256 mismatch" >&2; exit 2; }
  case "$driver" in
    sqlite)
      integrity="$(node --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('pragma integrity_check').get().integrity_check);d.close()" "${backup_dir}/${db_file}")"
      [[ "$integrity" == "ok" ]] || { echo "Backup integrity failed: ${integrity}" >&2; exit 2; }
      ;;
    mysql)
      # 只做 gzip 完整性（坏档必抛）。更深的"转储表数 = 线上表数"那步已经由
      # backup-production.mjs 做过了：对不上它会直接抛，根本走不到这里 —— 所以不重复。
      gzip -t "${backup_dir}/${db_file}" || { echo "MySQL 转储 gzip 校验失败" >&2; exit 2; }
      ;;
    *)
      echo "Unknown driver in manifest: ${driver}" >&2
      exit 2
      ;;
  esac
  end_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node - "$STATE_FILE" "$start_at" "$end_at" "$backup_dir" "$actual" "$KEEP_DAYS" "$driver" "$db_file" <<'NODE'
const fs = require('node:fs');
const [file,start,end,dir,sha,keep,driver,dbFile] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({state:'ok',startAt:start,endAt:end,backupDir:dir,driver,databaseFile:dbFile,databaseSha256:sha,retentionDays:Number(keep)}, null, 2)+'\n', {mode:0o640});
NODE
  # Retention only removes timestamped backup directories; manifest directories are always timestamped.
  # ⚠️ 手工留的目录（名字不以 20 开头，如 rds-manual-*）**不会**被这条清掉 —— 故意的。
  find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' -mtime +$((KEEP_DAYS-1)) -exec rm -rf -- {} +
  printf 'Backup completed: %s (driver=%s, database=%s)\n' "${backup_dir}" "${driver}" "${db_file}"
else
  status=$?
  node - "$STATE_FILE" "$start_at" "$output" <<'NODE' 2>/dev/null || true
const fs = require('node:fs');
const [file,start,message] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({state:'failed',startAt:start,endAt:new Date().toISOString(),message}, null, 2)+'\n', {mode:0o640});
NODE
  printf '%s\n' "$output" >&2
  exit "${status}"
fi