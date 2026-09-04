#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${PRODUCTION_ROOT:-/srv/ai-kids-platform/production}"
DB_PATH="${PLATFORM_DB_PATH:-${ROOT}/data/platform.db}"
BACKUP_ROOT="${PRODUCTION_BACKUP_ROOT:-${ROOT}/backups}"
SERVICE="${PRODUCTION_SERVICE:-learning-platform-production}"

if [[ "${DB_PATH,,}" == *"/packages/data/platform.db"* ]]; then
  echo "Refusing to use the repository default database: ${DB_PATH}" >&2
  exit 2
fi
mkdir -p "${BACKUP_ROOT}"
exec node "$(dirname "$0")/backup-production.mjs" --root "$ROOT" --db "$DB_PATH" --output "$BACKUP_ROOT"
