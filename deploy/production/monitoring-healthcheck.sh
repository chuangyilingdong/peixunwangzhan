#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/srv/ai-kids-platform/production
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/monitoring-health.log"
mkdir -p "$LOG_DIR"

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
status=0
message="healthcheck ok"
if ! curl -fsS --max-time 5 http://127.0.0.1:8789/health >/dev/null; then
  status=1
  message="API health probe failed"
fi

usage=$(df -P "$ROOT" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [[ -z "$usage" || "$usage" -ge 90 ]]; then
  status=1
  message="disk usage is ${usage:-unknown}%"
elif [[ "$usage" -ge 80 ]]; then
  message="disk usage warning: ${usage}%"
fi

printf '%s status=%s message=%s release=%s disk_percent=%s\n' \
  "$now" "$([[ "$status" -eq 0 ]] && echo ok || echo failed)" "$message" \
  "$(readlink -f "$ROOT/current" 2>/dev/null || echo unavailable)" "${usage:-unknown}" >> "$LOG_FILE"
exit "$status"
