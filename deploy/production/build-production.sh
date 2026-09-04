#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE_ROOT="${RELEASE_ROOT:-/srv/ai-kids-platform/production/releases}"
PNPM_COMMAND="${PNPM_COMMAND:-pnpm}"
BUILD_MODE="${VITE_DEPLOYMENT_MODE:-public}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="${RELEASE_ROOT}/${STAMP}"

if [[ "$BUILD_MODE" != "public" ]]; then
  echo "Production build mode must be public; found ${BUILD_MODE}" >&2
  exit 2
fi
if [[ ! -w "$RELEASE_ROOT" ]] && [[ "${RELEASE_ROOT}" != "${REPO_ROOT}/deploy/releases" ]]; then
  echo "Release root is not writable: ${RELEASE_ROOT}" >&2
  exit 2
fi
mkdir -p "$RELEASE_DIR"
cd "$REPO_ROOT"
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_MINOR%%.*}"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 5) )); then
  echo "Node.js 22.5+ is required because the database uses node:sqlite; found ${NODE_VERSION}" >&2
  exit 2
fi
export VITE_DEPLOYMENT_MODE="$BUILD_MODE"
export VITE_API_BASE="${VITE_API_BASE:-/api}"
export VITE_PUBLIC_SITE_URL="${VITE_PUBLIC_SITE_URL:-https://iicili.cyou}"
export VITE_ORG_APP_URL="${VITE_ORG_APP_URL:-https://iicili.cyou/org}"
node_modules/.bin/vite build apps/admin --config apps/admin/vite.config.mjs
node_modules/.bin/vite build apps/org --config apps/org/vite.config.mjs
node_modules/.bin/vite build apps/student --config apps/student/vite.config.mjs
node_modules/.bin/vite build apps/website --config apps/website/vite.config.mjs

for app in admin org student website; do
  test -f "apps/${app}/dist/index.html"
  mkdir -p "$RELEASE_DIR/apps/${app}"
  cp -a "apps/${app}/dist/." "$RELEASE_DIR/apps/${app}/"
done
mkdir -p "$RELEASE_DIR/apps/server/src" "$RELEASE_DIR/packages/database/src"
cp -a apps/server/src/. "$RELEASE_DIR/apps/server/src/"
cp -a packages/database/src/. "$RELEASE_DIR/packages/database/src/"
mkdir -p "$RELEASE_DIR/node_modules/@platform/database/src"
cp packages/database/package.json "$RELEASE_DIR/node_modules/@platform/database/package.json"
cp -a packages/database/src/. "$RELEASE_DIR/node_modules/@platform/database/src/"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$RELEASE_DIR/"
if [ -f "apps/server/package.json" ]; then
  cp apps/server/package.json "$RELEASE_DIR/apps/server/"
fi
cp packages/database/package.json "$RELEASE_DIR/packages/database/"
cat > "$RELEASE_DIR/BUILD-METADATA.txt" <<EOF
release=${STAMP}
commit=$(git rev-parse HEAD)
node=$(node --version)
pnpm=$($PNPM_COMMAND --version)
mode=${BUILD_MODE}
EOF
printf 'Production release created: %s\n' "$RELEASE_DIR"
