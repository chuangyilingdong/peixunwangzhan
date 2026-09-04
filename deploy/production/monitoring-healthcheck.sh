#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${PRODUCTION_ROOT:-/srv/ai-kids-platform/production}"
LOG_FILE="${ROOT}/logs/monitoring-alerts.log"
STATE_FILE="${ROOT}/state/last-alert-state.json"
HEALTH_URL="${PRODUCTION_HEALTH_URL:-http://127.0.0.1:8789/health}"
DISK_THRESHOLD="${PRODUCTION_DISK_ALERT_PERCENT:-80}"
CERT_PATH="${PRODUCTION_CERT_PATH:-/etc/letsencrypt/live/iicili.cyou/fullchain.pem}"
CERT_DAYS="${PRODUCTION_CERT_EXPIRY_DAYS:-14}"
BACKUP_MAX_AGE_HOURS="${PRODUCTION_BACKUP_MAX_AGE_HOURS:-26}"
NODE_BIN="${PRODUCTION_NODE_BIN:-/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin/node}"

export PATH="${NODE_BIN%/*}:${PATH}"
mkdir -p "${ROOT}/logs" "${ROOT}/state"
now_epoch="$(date -u +%s)"
now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
checks=()
status=ok

add() {
  local name="$1" state="$2" message="$3"
  checks+=("$(printf '%s\t%s\t%s' "$name" "$state" "$message")")
  [[ "$state" == "ok" ]] || status=failed
}

if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  add api ok "health endpoint returned success"
else
  add api failed "health endpoint failed"
fi

usage="$(df -P "$ROOT" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
if [[ -z "$usage" ]]; then
  add disk failed "disk usage unavailable"
elif (( usage >= DISK_THRESHOLD )); then
  add disk failed "disk usage ${usage}% >= ${DISK_THRESHOLD}%"
else
  add disk ok "disk usage ${usage}%"
fi

if [[ ! -r "$CERT_PATH" ]]; then
  add certificate failed "certificate unreadable: $CERT_PATH"
elif ! openssl x509 -in "$CERT_PATH" -noout -checkend "$((CERT_DAYS*86400))" >/dev/null 2>&1; then
  add certificate failed "certificate expires within ${CERT_DAYS} days"
else
  add certificate ok "certificate valid for at least ${CERT_DAYS} days"
fi

backup_state_file="${ROOT}/state/last-backup-state.json"
backup_summary="state unavailable"
if [[ -r "$backup_state_file" ]]; then
  backup_summary="$(node - "$backup_state_file" "$now_epoch" "$BACKUP_MAX_AGE_HOURS" <<'NODE'
const fs=require('node:fs'); const [file,now,maxAge]=process.argv.slice(2);
try { const x=JSON.parse(fs.readFileSync(file,'utf8')); if (x.state!=='ok') process.stdout.write('failed'); else { const age=(Number(now)-Date.parse(x.endAt))/3600000; process.stdout.write(age>Number(maxAge)?'stale':'ok'); } } catch { process.stdout.write('invalid'); }
NODE
)"
else
  backup_summary="missing"
fi
case "$backup_summary" in
  ok) add backup ok "latest backup within ${BACKUP_MAX_AGE_HOURS}h";;
  *) add backup failed "latest backup ${backup_summary}";;
esac

node - "$STATE_FILE" "$now_iso" "$status" "${checks[@]}" <<'NODE'
const fs=require('node:fs'); const [file,now,status,...checks]=process.argv.slice(2);
const result={checkedAt:now,status,checks:checks.map(x=>{const [name,state,message]=x.split('\t');return {name,state,message}})};
fs.writeFileSync(file, JSON.stringify(result,null,2)+'\n', {mode:0o640});
NODE
printf '%s status=%s api=%s disk=%s certificate=%s backup=%s\n' \
  "$now_iso" "$status" \
  "$(grep -m1 $'^api\t' <(printf '%s\n' "${checks[@]}") | cut -f2)" \
  "$(grep -m1 $'^disk\t' <(printf '%s\n' "${checks[@]}") | cut -f2)" \
  "$(grep -m1 $'^certificate\t' <(printf '%s\n' "${checks[@]}") | cut -f2)" \
  "$(grep -m1 $'^backup\t' <(printf '%s\n' "${checks[@]}") | cut -f2)" >> "$LOG_FILE"
[[ "$status" == "ok" ]] || exit 1