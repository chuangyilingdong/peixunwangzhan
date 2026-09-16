#!/usr/bin/env bash
# 把一台**新的空机器**装成「学生运行时容器宿主」。
#
# 为什么单独一台：平台生产机只有 2 vCPU / 1.6GB 且没有容器运行时（实测），
# 一个带 Chromium 的 agent 会话就跑不动，更别说一学生一容器。
# 这台宿主只干一件事：按平台指令跑 dsh 学生容器。
#
# 用法（在宿主上以 root 跑）：
#   bash provision.sh                          # 只装运行时，镜像稍后 load
#   bash provision.sh /root/dsh-student.tar    # 顺便导入离线镜像
#   IMAGE_TAG=dsh-student:20260916 bash provision.sh /root/dsh-student.tar
#
# 做不到的事（明确写出来，别指望）：
#   · 不对外开放任何学生容器端口 —— 只绑 --bind-host（默认仅回环），由平台那侧转发；
#   · 不装平台代码 —— 平台仍在生产机；这里是「算力与隔离」那一层。
set -Eeuo pipefail

IMAGE_TAG="${IMAGE_TAG:-dsh-student:local}"
IMAGE_TAR="${1:-}"
STATE_DIR="${STATE_DIR:-/srv/dsh-runtime}"
# 学生容器的宿主端口池：一段连续端口，方便防火墙只放这一段
PORT_BASE="${PORT_BASE:-18100}"
PORT_RANGE="${PORT_RANGE:-64}"

log() { echo "[provision] $*"; }
die() { echo "[provision] $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "要用 root 跑（装运行时、建目录都要权限）"

log "1/6 装容器运行时"
if command -v docker >/dev/null 2>&1; then
  log "    已经有 docker：$(docker --version)"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  # 用发行版自带的 docker.io：不额外依赖 download.docker.com 可达（生产机实测过外网不稳）
  apt-get install -y --no-install-recommends docker.io ca-certificates curl
  systemctl enable --now docker
  log "    装好了：$(docker --version)"
fi

log "2/6 目录"
mkdir -p "${STATE_DIR}"/{images,logs}
chmod 750 "${STATE_DIR}"

log "3/6 docker 守护进程调优"
# log-driver 限大小：学生容器每天几十个，日志不轮转会把这台机器写满。
# live-restore：docker 自己重启时不要把学生容器全带走。
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
JSON
  systemctl restart docker
  log "    写了 /etc/docker/daemon.json 并重启 docker"
else
  log "    /etc/docker/daemon.json 已存在，没动它（请自己确认 log-opts 有轮转）"
fi
# 内存超卖会让学生容器互相拖死：关掉内核的 overcommit 赌注
if ! grep -q '^vm.overcommit_memory' /etc/sysctl.conf 2>/dev/null; then
  echo 'vm.overcommit_memory = 1' >> /etc/sysctl.conf
fi
sysctl -p >/dev/null 2>&1 || true

log "4/6 镜像"
if [ -n "${IMAGE_TAR}" ]; then
  [ -f "${IMAGE_TAR}" ] || die "镜像包不存在：${IMAGE_TAR}"
  docker load -i "${IMAGE_TAR}"
  log "    已从 ${IMAGE_TAR} 导入"
elif docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
  log "    本地已有 ${IMAGE_TAG}"
else
  log "    没有镜像也没给 tar 包 —— 稍后自己 docker load（构建见 deploy/dsh-student/README.md）"
fi

log "5/6 端口池"
log "    学生容器只用 ${PORT_BASE}-$((PORT_BASE + PORT_RANGE - 1)) 这段（默认只绑回环，见 run-student-container.sh）"

log "6/6 自检"
if docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
  bash "$(dirname "$0")/smoke-test.sh" || die "自检没过，别急着接平台"
else
  log "    还没镜像，跳过自检"
fi

cat <<EOF

装完了。接下来：
  1) 把平台要用的凭据/地址定下来：平台会带着「运行时密钥 + 网关地址」来拉起容器；
  2) 每个学生开一节课：bash $(dirname "$0")/run-student-container.sh --help
  3) 回收空闲容器（建议加 cron，每 5 分钟）：
       */5 * * * * root MAX_AGE_MINUTES=180 bash $(dirname "$0")/reap-idle.sh >> ${STATE_DIR}/logs/reap.log 2>&1
  4) 平台那侧怎么接：见 deploy/dsh-student/README.md「机器（容器宿主）」一节
EOF
