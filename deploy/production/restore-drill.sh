#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${PRODUCTION_ROOT:-/srv/ai-kids-platform/production}"
BACKUP_ROOT="${PRODUCTION_BACKUP_ROOT:-${ROOT}/backups}"
NODE_BIN="${PRODUCTION_NODE_BIN:-/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin/node}"
DRILL_ROOT="${PRODUCTION_RESTORE_DRILL_ROOT:-${ROOT}/restore-drills}"
PORT="${PRODUCTION_RESTORE_DRILL_PORT:-18789}"
SERVICE_TIMEOUT="${PRODUCTION_RESTORE_DRILL_TIMEOUT:-30}"

usage() { echo "Usage: $0 [--backup <backup-dir>]" >&2; exit 2; }
BACKUP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP="$2"; shift 2;;
    *) usage;;
  esac
done
if [[ -z "$BACKUP" ]]; then
  BACKUP="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' | sort | tail -1)"
fi
BACKUP="$(realpath -m "$BACKUP")"
case "$BACKUP" in "$BACKUP_ROOT"/*) ;; *) echo "Backup must stay under $BACKUP_ROOT" >&2; exit 2;; esac
[[ -f "${BACKUP}/platform.db" && -f "${BACKUP}/MANIFEST.json" ]] || { echo "Backup incomplete" >&2; exit 2; }

export PATH="${NODE_BIN%/*}:${PATH}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
drill_dir="${DRILL_ROOT}/${stamp}"
data_dir="${drill_dir}/data"
log_dir="${drill_dir}/logs"
mkdir -p "$data_dir" "$log_dir" "${drill_dir}/release"
cp "${BACKUP}/platform.db" "${data_dir}/platform.db"
cp -a "${BACKUP}/release/." "${drill_dir}/release/"
chmod 0750 "$drill_dir" "$data_dir" "$log_dir"
chmod 0640 "${data_dir}/platform.db"
cp "${BACKUP}/MANIFEST.json" "${drill_dir}/MANIFEST.json"

expected="$(node -e "const m=require(process.argv[1]);process.stdout.write(m.databaseSha256)" "${BACKUP}/MANIFEST.json")"
actual="$(sha256sum "${data_dir}/platform.db" | awk '{print $1}')"
[[ "$expected" == "$actual" ]] || { echo "Restored database SHA256 mismatch" >&2; exit 2; }
integrity="$(node --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('pragma integrity_check').get().integrity_check);d.close()" "${data_dir}/platform.db")"
[[ "$integrity" == "ok" ]] || { echo "Restored database integrity failed: $integrity" >&2; exit 2; }

release_target="$(node -e "const m=require(process.argv[1]);process.stdout.write(m.currentTarget||'')" "${BACKUP}/MANIFEST.json")"
[[ -d "${drill_dir}/release/apps/server/src" ]] || { echo "Backup release missing server source" >&2; exit 2; }

pid=""
cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  # Belt-and-braces: stop any listener left on the isolated drill port.
  local residual
  residual="$(ss -ltnp "sport = :${PORT}" 2>/dev/null | grep -o 'pid=[0-9]\+' | cut -d= -f2 | sort -u || true)"
  if [[ -n "$residual" ]]; then
    echo "Stopping residual restore-drill process(es): ${residual}" >&2
    kill $residual 2>/dev/null || true
    sleep 1
    kill -9 $residual 2>/dev/null || true
  fi
}
trap cleanup EXIT
(
  cd "${drill_dir}/release"
  exec env -u DEPLOYMENT_MODE NODE_ENV=production PORT="$PORT" API_HOST=127.0.0.1 \
    PLATFORM_DATA_DIR="$data_dir" PLATFORM_DB_PATH="${data_dir}/platform.db" \
    AI_PROVIDER=local-mock AUTH_PEPPER="${AUTH_PEPPER:-}" \
    "$NODE_BIN" apps/server/src/index.js >"${log_dir}/server.stdout.log" 2>"${log_dir}/server.stderr.log"
) &
pid=$!
deadline=$((SECONDS+SERVICE_TIMEOUT))
health_json=""
while (( SECONDS < deadline )); do
  if health_json="$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null)"; then break; fi
  sleep 1
done
[[ -n "$health_json" ]] || { echo "Restored service health check failed" >&2; cat "${log_dir}/server.stderr.log" >&2; exit 2; }
user_count="$(node --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('select count(*) n from users where deleted_at is null').get().n);d.close()" "${data_dir}/platform.db")"
result="passed"
kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; pid=""
printf '%s\n' "restore_drill=${result} backup=${BACKUP} restored_at=${stamp} health=${health_json} active_users=${user_count} release=${release_target}" | tee "${drill_dir}/RESULT.txt"
find "$DRILL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' -mtime +6 -exec rm -rf -- {} +