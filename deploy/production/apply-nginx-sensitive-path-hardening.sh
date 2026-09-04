#!/usr/bin/env bash
set -Eeuo pipefail

# Apply only the repository's reviewed sensitive-path deny block to the live
# production vhost. This script never touches the application release or DB.
CONFIG_PATH="${NGINX_PRODUCTION_CONFIG:-/etc/nginx/sites-enabled/iicili.cyou}"
BACKUP_DIR="${NGINX_BACKUP_DIR:-/etc/nginx/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="${BACKUP_DIR}/iicili.cyou.before-sensitive-path-hardening.${STAMP}"
MARKER_BEGIN="# BEGIN AI-KIDS-SENSITIVE-PATH-HARDENING"
MARKER_END="# END AI-KIDS-SENSITIVE-PATH-HARDENING"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: run as root (sudo)." >&2
  exit 2
fi
if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "ERROR: production Nginx config not found: $CONFIG_PATH" >&2
  exit 2
fi
mkdir -p "$BACKUP_DIR"
cp -a -- "$CONFIG_PATH" "$BACKUP_PATH"

python3 - "$CONFIG_PATH" "$MARKER_BEGIN" "$MARKER_END" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
begin, end = sys.argv[2], sys.argv[3]
text = path.read_text()
if begin in text or end in text:
    if begin not in text or end not in text:
        raise SystemExit("ERROR: incomplete hardening markers; refusing to edit")
    print("Sensitive-path block already present; no edit needed.")
    raise SystemExit(0)

rules = [
    "location = /server.js {", "location = /package.json {",
    "location = /pnpm-lock.yaml {", "location = /pnpm-workspace.yaml {",
    "location ^~ /apps/ {", "location ^~ /packages/ {",
    "location ^~ /node_modules/ {", "location ^~ /scripts/ {",
    "location ^~ /deploy/ {",
]
if any(rule in text for rule in rules):
    raise SystemExit("ERROR: an unmarked sensitive-path rule already exists; refusing to create duplicates")

block = f'''    {begin}
    # Do not let repository/runtime paths fall through to SPA index.html.
    location = /server.js {{ return 404; }}
    location = /package.json {{ return 404; }}
    location = /pnpm-lock.yaml {{ return 404; }}
    location = /pnpm-workspace.yaml {{ return 404; }}
    location ^~ /apps/ {{ return 404; }}
    location ^~ /packages/ {{ return 404; }}
    location ^~ /node_modules/ {{ return 404; }}
    location ^~ /scripts/ {{ return 404; }}
    location ^~ /deploy/ {{ return 404; }}
    {end}
'''
needle = '    location = /api { return 301 /api/; }'
count = text.count(needle)
if count != 1:
    raise SystemExit(f"ERROR: expected exactly one API location anchor, found {count}")
text = text.replace(needle, block + needle, 1)
path.write_text(text)
print(f"Inserted sensitive-path block into {path}")
PY

rollback() {
  cp -a -- "$BACKUP_PATH" "$CONFIG_PATH"
  if nginx -t; then
    systemctl reload nginx || true
  fi
}

if ! nginx -t; then
  rollback
  echo "ERROR: nginx -t failed; restored $CONFIG_PATH from $BACKUP_PATH" >&2
  exit 1
fi
systemctl reload nginx

for path in /server.js /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /apps/ /packages/ /node_modules/ /scripts/ /deploy/; do
  code="$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://iicili.cyou${path}")" || {
    rollback
    echo "ERROR: smoke request failed for ${path}; restored $CONFIG_PATH from $BACKUP_PATH" >&2
    exit 1
  }
  if [[ "$code" != "404" ]]; then
    rollback
    echo "ERROR: ${path} returned HTTP ${code}; expected 404; restored $CONFIG_PATH from $BACKUP_PATH" >&2
    exit 1
  fi
done

echo "NGINX_SENSITIVE_PATH_HARDENING_OK backup=${BACKUP_PATH}"
