#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${PRODUCTION_ROOT:-/srv/ai-kids-platform/production}"
BACKUP_ROOT="${PRODUCTION_BACKUP_ROOT:-${ROOT}/backups}"
KEEP_DAYS="${PRODUCTION_BACKUP_RETENTION_DAYS:-14}"
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
  if [[ -z "$backup_dir" || ! -f "${backup_dir}/platform.db" || ! -f "${backup_dir}/MANIFEST.json" ]]; then
    echo "Backup output is incomplete" >&2
    printf '%s\n' "$output" >&2
    exit 2
  fi
  expected="$(node -e "const m=require(process.argv[1]);process.stdout.write(m.databaseSha256)" "${backup_dir}/MANIFEST.json")"
  actual="$(sha256sum "${backup_dir}/platform.db" | awk '{print $1}')"
  [[ "$expected" == "$actual" ]] || { echo "Backup SHA256 mismatch" >&2; exit 2; }
  integrity="$(node --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('pragma integrity_check').get().integrity_check);d.close()" "${backup_dir}/platform.db")"
  [[ "$integrity" == "ok" ]] || { echo "Backup integrity failed: ${integrity}" >&2; exit 2; }
  end_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node - "$STATE_FILE" "$start_at" "$end_at" "$backup_dir" "$actual" "$KEEP_DAYS" <<'NODE'
const fs = require('node:fs');
const [file,start,end,dir,sha,keep] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({state:'ok',startAt:start,endAt:end,backupDir:dir,databaseSha256:sha,retentionDays:Number(keep)}, null, 2)+'\n', {mode:0o640});
NODE
  # Retention only removes timestamped backup directories; manifest directories are always timestamped.
  find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' -mtime +$((KEEP_DAYS-1)) -exec rm -rf -- {} +
  printf 'Backup completed: %s\n' "${backup_dir}"
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