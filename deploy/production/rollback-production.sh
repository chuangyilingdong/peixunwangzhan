#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${PRODUCTION_ROOT:-/srv/ai-kids-platform/production}"
RELEASE=""
DB_BACKUP=""
SERVICE="${PRODUCTION_SERVICE:-learning-platform-production}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2;;
    --release) RELEASE="$2"; shift 2;;
    --db-backup) DB_BACKUP="$2"; shift 2;;
    --service) SERVICE="$2"; shift 2;;
    *) echo "Unknown argument: $1" >&2; exit 2;;
  esac
done

if [[ -z "$RELEASE" ]]; then echo "Usage: $0 --release <release-dir> [--db-backup <backup-db>]" >&2; exit 2; fi
ROOT="$(realpath -m "$ROOT")"
RELEASE="$(realpath -m "$RELEASE")"
RELEASE_ROOT="$(realpath -m "$ROOT/releases")"
case "$RELEASE" in "$RELEASE_ROOT"/*) ;; *) echo "Release must stay under $RELEASE_ROOT" >&2; exit 2;; esac
[[ -f "$RELEASE/BUILD-METADATA.txt" ]] || { echo "Invalid release: missing BUILD-METADATA.txt" >&2; exit 2; }
CURRENT="$ROOT/current"
PREVIOUS=""
if [[ -e "$CURRENT" || -L "$CURRENT" ]]; then PREVIOUS="$(realpath "$CURRENT")"; fi
DATA_DIR="$ROOT/data"
DB_PATH="${PLATFORM_DB_PATH:-$DATA_DIR/platform.db}"
if [[ "${DB_PATH,,}" == *"/packages/data/platform.db"* ]]; then echo "Refusing repository default database" >&2; exit 2; fi

sudo systemctl stop "$SERVICE"
if [[ -n "$DB_BACKUP" ]]; then
  [[ -f "$DB_BACKUP" ]] || { echo "Database backup not found: $DB_BACKUP" >&2; exit 2; }
  mkdir -p "$DATA_DIR"
  install -o ai-kids-prod -g ai-kids-prod -m 0640 "$DB_BACKUP" "$DB_PATH.rollback.tmp"
  mv -f "$DB_PATH.rollback.tmp" "$DB_PATH"
fi
ln -sfn "$RELEASE" "$CURRENT"
sudo systemctl start "$SERVICE"
if ! curl -fsS --retry 10 --retry-delay 2 --retry-connrefused --max-time 10 http://127.0.0.1:8789/health >/dev/null; then
  echo "Health check failed; restoring previous release" >&2
  sudo systemctl stop "$SERVICE" || true
  if [[ -n "$PREVIOUS" ]]; then ln -sfn "$PREVIOUS" "$CURRENT"; fi
  sudo systemctl start "$SERVICE" || true
  exit 1
fi
printf 'Rollback/release switch complete: %s\n' "$RELEASE"
