#!/usr/bin/env bash
# 宿主自检：这台机器现在能不能接学生。
#
# 检查四件事，任何一件不过都说明「现在拉学生进来会出问题」：
#   ① 运行时与镜像在位；
#   ② 容器起得来、入口闸门在位（无票据 403、带票据放行）；
#   ③ 容器里能打通我们的网关（带图的那条路）—— 打不通就是「学生写的东西发不出去」；
#   ④ 容器里读图的凭据指向我们的网关，不是它自带的那些渠道。
#
# 用法：
#   GATEWAY_URL=http://<平台>/api/gateway/v1 RUNTIME_KEY=<rt1...> bash smoke-test.sh
#   （RUNTIME_KEY 可由平台「发一把测试密钥」得到；没有就跳过 ③④ 并明说）
set -Eeuo pipefail

IMAGE_TAG="${IMAGE_TAG:-dsh-student:local}"
GATEWAY_URL="${GATEWAY_URL:-}"
RUNTIME_KEY="${RUNTIME_KEY:-}"
VISIBILITY_TIMEOUT="${VISIBILITY_TIMEOUT:-120}"
NAME="dsh-smoke-$$"
TICKET="smoke-ticket-$$"
# ⚠️ 变量名必须带前缀：`PORT` 这种大众名字会被宿主上的其他环境（比如平台自己的
# `/etc/ai-kids-platform/production.env` 里就有 PORT=8789）污染，实测直接去抢平台的端口、
# 报 "failed to bind host port 127.0.0.1:8789: address already in use"。
# 0 = 让 docker 随机挑一个。
SMOKE_HOST_PORT="${SMOKE_HOST_PORT:-0}"

pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
no() { echo "  ✗ $*"; fail=$((fail + 1)); }
cleanup() { docker rm -f "${NAME}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "[smoke] ① 运行时与镜像"
command -v docker >/dev/null 2>&1 && ok "docker 在位：$(docker --version)" || { no "没有 docker"; exit 1; }
docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1 && ok "镜像 ${IMAGE_TAG} 在位" || { no "镜像 ${IMAGE_TAG} 不存在"; exit 1; }

echo "[smoke] ② 起一个容器，看入口闸门"
docker rm -f "${NAME}" >/dev/null 2>&1 || true
docker run -d --name "${NAME}" --label dsh.runtime=smoke \
  --memory 2g --cpus 2 --pids-limit 512 --tmpfs /tmp:rw,size=256m,exec \
  --add-host host.docker.internal:host-gateway \
  --publish "127.0.0.1:${SMOKE_HOST_PORT}:8080" \
  -e "EDGE_TICKET=${TICKET}" \
  -e "GATEWAY_BASE_URL=${GATEWAY_URL:-http://127.0.0.1:1/api/gateway/v1}" \
  -e "PLATFORM_GATEWAY_KEY=${RUNTIME_KEY:-smoke-placeholder}" \
  "${IMAGE_TAG}" >/dev/null
HOST_PORT="$(docker port "${NAME}" 8080 | head -1 | sed 's/.*://')"

booted=0
for _ in $(seq 1 "${VISIBILITY_TIMEOUT}"); do
  docker logs "${NAME}" 2>&1 | grep -q '对外入口' && { booted=1; break; }
  sleep 1
done
[ "${booted}" = "1" ] && ok "容器起来了（宿主端口 ${HOST_PORT}）" || { no "容器 ${VISIBILITY_TIMEOUT}s 内没起来"; docker logs "${NAME}" 2>&1 | tail -20; exit 1; }

code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:${HOST_PORT}/" || true)"
[ "${code}" = "403" ] && ok "无票据 → 403（闸门在位）" || no "无票据应该是 403，实际 ${code}"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:${HOST_PORT}/?t=${TICKET}" || true)"
case "${code}" in
  200|302) ok "带票据 → ${code}（能进）" ;;
  *) no "带票据应该是 200/302，实际 ${code}" ;;
esac

echo "[smoke] ③ 容器 → 我们的网关"
if [ -z "${RUNTIME_KEY}" ] || [ -z "${GATEWAY_URL}" ]; then
  echo "  ⏭ 没给 GATEWAY_URL / RUNTIME_KEY，跳过（生产上别跳过：这一步是「学生发得出去吗」的唯一证据）"
else
  body='{"model":"platform-vision","messages":[{"role":"user","content":[{"type":"text","text":"连通性自检"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="}}]}]}'
  out="$(docker exec -i "${NAME}" sh -lc "cat > /tmp/smoke.json && curl -s -m 60 -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H \"authorization: Bearer \${PLATFORM_GATEWAY_KEY}\" --data @/tmp/smoke.json \"\${GATEWAY_BASE_URL}/chat/completions\"" <<< "${body}" || true)"
  code="$(printf '%s' "${out}" | tail -1)"
  [ "${code}" = "200" ] && ok "网关从容器里可达（200，带图那条路）" || no "网关调用失败（${code}）：$(printf '%s' "${out}" | head -c 300)"
fi

echo "[smoke] ④ 读图凭据的落点"
cfg="$(docker exec "${NAME}" sh -lc 'cat "${HOME:-/root}/.modlens/config.json" 2>/dev/null' || true)"
if [ -z "${cfg}" ]; then
  no "容器里没有 ~/.modlens/config.json（读图没被接到我们网关上）"
else
  printf '%s' "${cfg}" | grep -q '"provider": *"openai"' && ok "读图走的是 openai 兼容那条路（我们网关）" || no "读图的 provider 不是 openai：$(printf '%s' "${cfg}" | head -c 200)"
  [ -n "${GATEWAY_URL}" ] && { printf '%s' "${cfg}" | grep -q "$(printf '%s' "${GATEWAY_URL}" | sed 's#^http[s]*://##')" && ok "读图的 baseUrl 指向我们的网关" || no "读图的 baseUrl 不是我们的网关"; }
fi

echo
if [ "${fail}" = "0" ]; then
  echo "[smoke] 全部通过（${pass} 项）"
else
  echo "[smoke] ${fail} 项不过、${pass} 项通过 —— 先修再拉学生"
fi
exit $(( fail > 0 ))
