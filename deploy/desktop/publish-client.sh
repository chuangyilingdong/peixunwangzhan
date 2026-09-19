#!/usr/bin/env bash
# 把新打出来的客户端安装包发布出去（2026-09-19 下半场）。
#
# 为什么要有它：出包之后要做四件事，顺序不能乱，而且每一步都要看得见结果 ——
#   ① 算本地校验值（发布后能核对下载到的东西与打出来的是同一份）
#   ② 传到**发布目录之外的** /srv/ai-kids-platform/downloads/（每次换代都不会被冲掉）
#   ③ 把 manifest.json 里的 win-x64 置回（上一轮为「客户端跑不通」故意摘成 null）
#   ④ 核验公网真的能下（HEAD 一下 /downloads/<文件名>，看 content-length 对不对）
#
# 用法：bash .tmp/publish-client.sh <安装包路径> [--dry-run]
set -euo pipefail

KEY="$HOME/.ssh/ai_kids_platform_ecs_temp_ed25519"
HOST="root@39.106.183.200"
REMOTE_DIR="/srv/ai-kids-platform/downloads"
EXE="${1:-}"
DRY="${2:-}"

if [ -z "$EXE" ] || [ ! -f "$EXE" ]; then echo "用法：bash $0 <安装包路径> [--dry-run]"; exit 2; fi
NAME=$(basename "$EXE")
SIZE=$(stat -c %s "$EXE")
SHA=$(sha256sum "$EXE" | cut -d' ' -f1)
VERSION=$(echo "$NAME" | sed -E 's/^lingdong-client-(.*)-win-x64\.exe$/\1/')
echo "安装包：$NAME"
echo "  版本：$VERSION"
echo "  字节：$SIZE"
echo "  sha256：$SHA"
if [ "$DRY" = "--dry-run" ]; then echo "（--dry-run：到此为止，什么都没传）"; exit 0; fi

echo "=== ① 传到 $REMOTE_DIR（发布目录之外，换代不冲） ==="
scp -i "$KEY" -o StrictHostKeyChecking=no "$EXE" "$HOST:$REMOTE_DIR/$NAME"

echo "=== ② 服务器上核对字节数 ==="
REMOTE_SIZE=$(ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "stat -c %s '$REMOTE_DIR/$NAME'")
echo "  远端：$REMOTE_SIZE"
[ "$REMOTE_SIZE" = "$SIZE" ] || { echo "!! 远端字节数与本地不一致，停止"; exit 1; }

echo "=== ③ 置回 manifest（先备份） ==="
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "cd '$REMOTE_DIR' && cp manifest.json manifest.json.bak-$STAMP && cat > manifest.json <<JSON
{
  \"version\": \"$VERSION\",
  \"channel\": \"internal-beta\",
  \"updatedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
  \"note\": \"客户端内测：登录门、课堂门禁与网关调用已在本机验证台跑通（消息成功、用量进平台账）。\",
  \"files\": { \"win-x64\": { \"name\": \"$NAME\", \"size\": $SIZE, \"sha256\": \"$SHA\" }, \"mac-arm64\": null }
}
JSON
cat manifest.json"

echo "=== ④ 核验公网真能下 ==="
curl -sI -m 20 "https://iicili.cyou/downloads/$NAME" | head -5
printf "manifest 公网："; curl -s -m 20 "https://iicili.cyou/downloads/manifest.json" | head -c 200; echo
echo "PUBLISH_CLIENT_DONE $NAME"
