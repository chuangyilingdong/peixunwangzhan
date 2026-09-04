#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

section() { printf '\n[%s]\n' "$1"; }

section "META"
printf 'generated_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'hostname=%s\n' "$(hostname)"
printf 'uptime_seconds=%s\n' "$(cut -d. -f1 /proc/uptime)"
uname -a

section "OS"
cat /etc/os-release | grep -E '^(NAME|VERSION_ID|PRETTY_NAME)=' || true

section "DISK"
df -h / /srv /opt 2>/dev/null || true

section "SERVICES"
for svc in learning-platform learning-platform-internal-test nginx; do
  printf '%s.active=' "$svc"
  systemctl is-active "$svc" 2>/dev/null || printf 'unknown\n'
  printf '%s.enabled=' "$svc"
  systemctl is-enabled "$svc" 2>/dev/null || printf 'unknown\n'
  systemctl show "$svc" -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState -p FragmentPath -p DropInPaths -p ExecStart -p User -p Group -p WorkingDirectory -p EnvironmentFiles 2>/dev/null || true
done

section "TIMERS"
systemctl list-timers --all --no-pager | grep -E 'ai-kids|learning-platform|NEXT' || true
systemctl list-units --type=timer --all --no-pager | grep -E 'ai-kids|learning-platform' || true

section "LISTEN_PORTS"
ss -ltnp | grep -E ':(80|443|8787|8788)[[:space:]]' || true
ss -lxnp | grep -E 'nginx|node|learning' | head -30 || true

section "PROCESSES"
ps -eo pid,ppid,user,etimes,cmd --sort=pid | grep -E 'nginx|learning-platform|node' | grep -v grep || true

section "UNIT_FILES"
for f in /etc/systemd/system/learning-platform.service /etc/systemd/system/learning-platform-internal-test.service; do
  if [[ -f "$f" ]]; then
    printf '\n--- %s ---\n' "$f"
    cat "$f"
  fi
done

section "ENVIRONMENT_FILES"
find /etc/learning-platform /srv/ai-kids-platform /opt/learning-platform -maxdepth 4 \( -type f -o -type l \) \( -name '*.env' -o -name '.env*' -o -name '*environment*' \) -printf '%p\n' 2>/dev/null | sort || true

section "NGINX_CONFIG_FILES"
find /etc/nginx -maxdepth 3 -type f -printf '%p\n' 2>/dev/null | sort

section "NGINX_TEST"
nginx -t 2>&1 || true

section "NGINX_EFFECTIVE_CONFIG"
nginx -T 2>&1 | sed -E 's/(password|secret|token|key|credential)([[:space:]]*[:=][[:space:]]*)[^;[:space:]]+/\1\2[REDACTED]/Ig'

section "LEGENCY_PATHS"
for p in /opt/learning-platform /srv/learning-platform /srv/ai-kids-platform; do
  if [[ -e "$p" ]]; then
    printf '\n--- %s ---\n' "$p"
    stat -c 'type=%F mode=%a owner=%U group=%G size=%s modified=%y path=%n' "$p"
    find "$p" -maxdepth 3 -printf '%y mode=%m owner=%U group=%G size=%s modified=%TY-%Tm-%TdT%TH:%TM:%TS path=%p\n' 2>/dev/null | sort
  fi
done

section "INTERNAL_TEST_METADATA"
find /srv/ai-kids-platform/internal-test/releases -maxdepth 2 -type f -name 'BUILD-METADATA.txt' -printf '%p\n' 2>/dev/null | sort | while read -r f; do
  printf '\n--- %s ---\n' "$f"
  cat "$f"
done

section "BACKUPS_INDEX"
for p in /opt/learning-platform /srv/ai-kids-platform/internal-test/backups /etc/nginx/backups; do
  if [[ -d "$p" ]]; then
    printf '\n--- %s ---\n' "$p"
    find "$p" -maxdepth 3 -printf '%y mode=%m owner=%U group=%G size=%s modified=%TY-%Tm-%TdT%TH:%TM:%TS path=%p\n' 2>/dev/null | sort
  fi
done

section "DATABASE_FILES_METADATA_ONLY"
find /opt/learning-platform /srv/ai-kids-platform -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -printf 'size=%s modified=%TY-%Tm-%TdT%TH:%TM:%TS path=%p\n' 2>/dev/null | sort

section "HEALTH"
printf 'legacy_8787='; curl -sS --max-time 5 http://127.0.0.1:8787/health || true; printf '\n'
printf 'internal_8788='; curl -sS --max-time 5 http://127.0.0.1:8788/health || true; printf '\n'

section "PUBLIC_ROBOTS"
printf 'robots='; curl -ksS --max-time 8 https://127.0.0.1/robots.txt -H 'Host: iicili.cyou' || true; printf '\n'

section "END"
printf 'readonly_inventory_complete=1\n'
