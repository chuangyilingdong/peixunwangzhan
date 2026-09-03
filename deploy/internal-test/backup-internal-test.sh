#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${INTERNAL_TEST_ROOT:-/srv/ai-kids-platform/internal-test}"
DB_PATH="${PLATFORM_DB_PATH:-${ROOT}/data/platform.db}"
BACKUP_ROOT="${INTERNAL_TEST_BACKUP_ROOT:-${ROOT}/backups}"
SERVICE="${INTERNAL_TEST_SERVICE:-learning-platform-internal-test}"

if [[ "${DB_PATH,,}" == *"/packages/data/platform.db"* ]]; then
  echo "Refusing to use repository default database: ${DB_PATH}" >&2
  exit 2
fi
mkdir -p "${BACKUP_ROOT}"
exec node "$(dirname "$0")/backup-internal-test.mjs" --root "$ROOT" --db "$DB_PATH" --output "$BACKUP_ROOT"
