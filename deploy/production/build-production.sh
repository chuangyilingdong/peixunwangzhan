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
# Fail before creating a release if any server module contains syntax/import errors.
mapfile -t SERVER_JS < <(find apps/server/src packages/database/src -type f -name '*.js' -print | sort)
for file in "${SERVER_JS[@]}"; do
  node --check "$file" >/dev/null
done
node --input-type=module - <<'NODE'
await import('./apps/server/src/routes/adminOrg.js');
await import('./apps/server/src/routes/fileAssets.js');
await import('./apps/server/src/routes/auth.js');
NODE
export VITE_DEPLOYMENT_MODE="$BUILD_MODE"
export VITE_API_BASE="${VITE_API_BASE:-/api}"
export VITE_PUBLIC_SITE_URL="${VITE_PUBLIC_SITE_URL:-https://iicili.cyou}"
export VITE_ORG_APP_URL="${VITE_ORG_APP_URL:-https://iicili.cyou/org}"
# 前端依赖可能有新增（如 marked / highlight.js）：按 lockfile 同步一次，避免构建时找不到模块
"$PNPM_COMMAND" install --frozen-lockfile --reporter=silent
node_modules/.bin/vite build apps/admin --config apps/admin/vite.config.mjs
node_modules/.bin/vite build apps/org --config apps/org/vite.config.mjs
node_modules/.bin/vite build apps/website --config apps/website/vite.config.mjs

for app in admin org website; do
  test -f "apps/${app}/dist/index.html"
  mkdir -p "$RELEASE_DIR/apps/${app}"
  cp -a "apps/${app}/dist/." "$RELEASE_DIR/apps/${app}/"
done
mkdir -p "$RELEASE_DIR/apps/server/src" "$RELEASE_DIR/packages/database/src" "$RELEASE_DIR/packages/shared/src"
cp -a apps/server/src/. "$RELEASE_DIR/apps/server/src/"
cp -a packages/database/src/. "$RELEASE_DIR/packages/database/src/"
cp -a packages/shared/src/. "$RELEASE_DIR/packages/shared/src/"
mkdir -p "$RELEASE_DIR/node_modules/@platform/database/src"
cp packages/database/package.json "$RELEASE_DIR/node_modules/@platform/database/package.json"
cp -a packages/database/src/. "$RELEASE_DIR/node_modules/@platform/database/src/"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$RELEASE_DIR/"
if [ -f "apps/server/package.json" ]; then
  cp apps/server/package.json "$RELEASE_DIR/apps/server/"
fi
cp packages/database/package.json "$RELEASE_DIR/packages/database/"

# ── 运行时依赖：生产唯一需要的第三方包是 **mysql2**（RDS 驱动；sqlite 走 node 内置的 node:sqlite）。
# 为什么必须在这一步装：release 是**自包含**的（只抄 src + 前端产物），而 pnpm 把 mysql2 装在
# `packages/database/node_modules/` 下 —— 那个路径不在 release 里，于是 `DB_DRIVER=mysql` 时
# store.js 的 `await import('./mysql.js')` → `import mysql from 'mysql2/promise'` 会在
# 启动或首个查询时炸。服务端是按**相对路径**引数据层的
# （`apps/server/src/lib.js` → `../../../packages/database/src/store.js`），所以 node 会在
# `$RELEASE_DIR/packages/database/node_modules/` 找它 —— 装在这里正好。
# 只装 @platform/database 这一支（--filter），别把前端那堆（react/pdfjs/ogl…）也拖进 release：
# 前端产物是构建期打包好的，运行时不需要它们。
# ⚠️ 这步失败必须让**构建失败**：静默少装 = 发出去的 release 连不上库，那是上线时才炸。
if [[ "${SKIP_RUNTIME_DEPS:-0}" != "1" ]]; then
  echo "  install runtime deps into release (mysql2)"
  (
    cd "$RELEASE_DIR"
    COREPACK_NPM_REGISTRY="${COREPACK_NPM_REGISTRY:-https://registry.npmmirror.com}" \
    npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}" \
    "$PNPM_COMMAND" install --prod --frozen-lockfile --filter @platform/database --reporter=silent
  )
  if [[ ! -d "$RELEASE_DIR/packages/database/node_modules/mysql2" ]]; then
    echo "Release 装完还是找不到 mysql2：$RELEASE_DIR/packages/database/node_modules/mysql2" >&2
    exit 2
  fi
fi

cat > "$RELEASE_DIR/BUILD-METADATA.txt" <<EOF
release=${STAMP}
commit=$(git rev-parse HEAD)
node=$(node --version)
pnpm=$($PNPM_COMMAND --version)
mode=${BUILD_MODE}
EOF
printf 'Production release created: %s\n' "$RELEASE_DIR"
