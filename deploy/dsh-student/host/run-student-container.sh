#!/usr/bin/env bash
# 起一个学生容器（一个学生一节课一个）。
#
# 这个脚本是**平台与宿主之间唯一的接口**：平台准备好「运行时密钥 + 网关地址 + 平台票据」，
# 调它一次，拿到容器名与宿主端口，然后把学生浏览器指到那个端口上。
#
# 用法：
#   run-student-container.sh --session <课堂id> --student <学生id> \
#     --key <平台签发的运行时密钥> --gateway <我们的网关地址> \
#     [--ticket <短时票据>] [--vision-model <读图模型名>] [--port <宿主端口>] [--name <容器名>]
#
# 只往 stdout 打 KEY=VALUE（CONTAINER_NAME / HOST_PORT / EDGE_URL），方便平台直接解析；
# 其余信息都走 stderr。
set -Eeuo pipefail

IMAGE_TAG="${IMAGE_TAG:-dsh-student:local}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"
PORT_BASE="${PORT_BASE:-18100}"
PORT_RANGE="${PORT_RANGE:-64}"
# 一个学生一节课的资源上限：按「10 人同时上课 ≈ 10-20 vCPU / 15-20GB」这档定的；
# 机器小了就在这里下调，但别把上限去掉 —— 没有上限，一个学生的死循环能把整台机器拖死。
#
# ⚠️ `--tmpfs /tmp:...,exec` 里的 exec **不能省**：docker 的 --tmpfs 默认带 noexec
# （实测 rw,nosuid,nodev,noexec），而 dsh 启动时要在 /tmp 里落一个原生模块回退加载器，
# noexec 会让它加载不上 → 整个插件树报「Cannot find package '@linxin666/dsh-web-all'」、
# 界面根本起不来（2026-09-16 踩到，二分定位）。
CONTAINER_MEMORY="${CONTAINER_MEMORY:-2g}"
CONTAINER_CPUS="${CONTAINER_CPUS:-2}"
CONTAINER_PIDS="${CONTAINER_PIDS:-512}"

SESSION=""; STUDENT=""; KEY=""; GATEWAY=""; TICKET=""; VISION_MODEL="${PLATFORM_VISION_MODEL:-platform-vision}"; PORT=""; NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session) SESSION="${2:-}"; shift 2 ;;
    --student) STUDENT="${2:-}"; shift 2 ;;
    --key) KEY="${2:-}"; shift 2 ;;
    --gateway) GATEWAY="${2:-}"; shift 2 ;;
    --ticket) TICKET="${2:-}"; shift 2 ;;
    --vision-model) VISION_MODEL="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "[run] 不认识的参数：$1" >&2; exit 2 ;;
  esac
done

[ -n "${SESSION}" ] && [ -n "${STUDENT}" ] || { echo "[run] 必须给 --session 与 --student" >&2; exit 2; }
[ -n "${KEY}" ] || { echo "[run] 必须给 --key（平台签发的运行时密钥）——没有它，容器里的模型调用没有身份" >&2; exit 2; }
[ -n "${GATEWAY}" ] || { echo "[run] 必须给 --gateway（我们的网关地址）" >&2; exit 2; }

# 容器名只留安全字符：课堂/学生 id 由平台生成，但拼进 docker 名字前先净化
sane() { printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-48; }
NAME="${NAME:-dsh-s-$(sane "${SESSION}")-$(sane "${STUDENT}")}"

# 端口：优先用平台指定的；没指定就在池子里挑一个没被占的
port_in_use() { docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":$1->"; }
if [ -n "${PORT}" ]; then
  port_in_use "${PORT}" && { echo "[run] 端口 ${PORT} 已被别的容器占用" >&2; exit 3; }
else
  for candidate in $(seq "${PORT_BASE}" $((PORT_BASE + PORT_RANGE - 1))); do
    port_in_use "${candidate}" || { PORT="${candidate}"; break; }
  done
  [ -n "${PORT}" ] || { echo "[run] 端口池 ${PORT_BASE} 起 ${PORT_RANGE} 个都占满了 —— 该回收空闲容器，或者把池子开大" >&2; exit 3; }
fi

docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1 || { echo "[run] 镜像 ${IMAGE_TAG} 不存在" >&2; exit 4; }

# 同名容器先清掉：同一个学生重进一节课时，旧容器要么已经死了、要么就是上一个残骸
docker rm -f "${NAME}" >/dev/null 2>&1 || true

# `--add-host host.docker.internal:host-gateway`：Linux 上没有 host.docker.internal 这个名字
# （那是 Docker Desktop 给的），显式加一条别名，平台就可以把网关地址写成
# http://host.docker.internal:8789/... 而不必关心宿主上跑的是什么。
#
# DEEPSEEK_SEARCH_BASE_URL / DEEPSEEK_API_KEY 是 dsh 网页搜索插件要的两个变量（它调的是 Anthropic
# 协议的 /messages，不是搜索接口）。两者都指向我们自己的网关、给的都必须是**本次的运行时密钥** ——
# 渠道真密钥绝不进容器（学生读得到进程环境，导出去既能泄漏又能绕过账本）。与用户版脚本同一套。
docker run -d --name "${NAME}" \
  --label dsh.runtime=student \
  --label "dsh.session=${SESSION}" \
  --label "dsh.student=${STUDENT}" \
  --memory "${CONTAINER_MEMORY}" --cpus "${CONTAINER_CPUS}" --pids-limit "${CONTAINER_PIDS}" \
  --tmpfs /tmp:rw,size=256m,exec \
  --add-host host.docker.internal:host-gateway \
  --publish "${BIND_HOST}:${PORT}:8080" \
  -e "EDGE_TICKET=${TICKET}" \
  -e "GATEWAY_BASE_URL=${GATEWAY}" \
  -e "PLATFORM_GATEWAY_KEY=${KEY}" \
  -e "PLATFORM_VISION_MODEL=${VISION_MODEL}" \
  -e "DEEPSEEK_SEARCH_BASE_URL=${GATEWAY%/}/search" \
  -e "DEEPSEEK_API_KEY=${KEY}" \
  "${IMAGE_TAG}" >/dev/null

echo "CONTAINER_NAME=${NAME}" >&2
echo "HOST_PORT=${PORT}" >&2
# 平台用这三行说话
echo "CONTAINER_NAME=${NAME}"
echo "HOST_PORT=${PORT}"
echo "EDGE_URL=http://${BIND_HOST}:${PORT}/?t=${TICKET}"
