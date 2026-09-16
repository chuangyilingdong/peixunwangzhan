#!/usr/bin/env bash
# 给一个学生开「创作环境」——**同机独立用户版**（不用容器，2026-09-16 起）
#
# 为什么不用容器：用户口径「成本要紧」（容器与独立用户的内存开销实测相近，但独立用户
# 省掉了 docker 守护进程与镜像分发，且复用同一份只读运行时）。隔离靠三样：
#   ① 一个学生一个 Linux 用户 + 家目录 0700 → 同学之间**读不到**彼此的工作区；
#   ② dsh 自带的 Landlock 沙箱（只锁写，读靠 ① 兜）；
#   ③ systemd 的资源限额（内存/CPU/进程数）→ 一个学生死循环不拖垮全班。
#
# 用法：
#   run-student-user.sh --session <课堂id> --student <学生id> \
#     --key <平台签发的运行时密钥> --gateway <我们的网关地址> \
#     [--ticket <短时票据>] [--vision-model <读图模型名>] [--public-port <对外端口>]
#
# 只往 stdout 打 KEY=VALUE（RUNTIME_NAME / HOST_PORT / EDGE_URL），与容器版**同一套输出**，
# 这样平台侧不用改。
set -Eeuo pipefail

RUNTIME_ROOT="${RUNTIME_ROOT:-/opt/dsh-runtime}"
DSH_NODE="$RUNTIME_ROOT/opt/node/bin/node"
DSH_BIN="$RUNTIME_ROOT/opt/node/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
TEMPLATE_HOME="$RUNTIME_ROOT/home/student/.dsh"
PATCH_FILE="$RUNTIME_ROOT/etc/dsh/student-runtime.cordis.yml"
SKILLS_DIR="$RUNTIME_ROOT/etc/dsh/skills"
NGINX_DIR="${NGINX_DIR:-/etc/nginx/dsh-students}"
PUBLIC_IP="${PUBLIC_IP:-iicili.cyou}"
LOG_DIR="${LOG_DIR:-/srv/dsh-runtime/logs}"
# 对外端口池：nginx 听这一段，转发到「对外端口 + 1000」的内部端口（dsh 只绑回环）。
# ⚠️ 这一段**必须与云安全组放行的范围一致** —— 否则学生会被分到一个从公网打不开的端口
# （2026-09-16 定的口径：安全组放行 18201-18220，所以池子就是 20 个）。
PORT_BASE="${PORT_BASE:-18201}"
PORT_RANGE="${PORT_RANGE:-20}"
INNER_OFFSET=1000
# 一个学生的资源上限（systemd 硬限）：一个学生写死循环也只烂在他自己那一格
MEMORY_MAX="${MEMORY_MAX:-768M}"
CPU_QUOTA="${CPU_QUOTA:-150%}"
TASKS_MAX="${TASKS_MAX:-256}"

SESSION=""; STUDENT=""; KEY=""; GATEWAY=""; TICKET=""; VISION_MODEL="${PLATFORM_VISION_MODEL:-platform-vision}"; PUBLIC_PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session) SESSION="${2:-}"; shift 2 ;;
    --student) STUDENT="${2:-}"; shift 2 ;;
    --key) KEY="${2:-}"; shift 2 ;;
    --gateway) GATEWAY="${2:-}"; shift 2 ;;
    --ticket) TICKET="${2:-}"; shift 2 ;;
    --vision-model) VISION_MODEL="${2:-}"; shift 2 ;;
    --public-port) PUBLIC_PORT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "[run] 不认识的参数：$1" >&2; exit 2 ;;
  esac
done
[ -n "${SESSION}" ] && [ -n "${STUDENT}" ] || { echo "[run] 必须给 --session 与 --student" >&2; exit 2; }
[ -n "${KEY}" ] || { echo "[run] 必须给 --key（平台签发的运行时密钥）" >&2; exit 2; }
[ -n "${GATEWAY}" ] || { echo "[run] 必须给 --gateway（我们的网关地址）" >&2; exit 2; }
[ -x "$DSH_NODE" ] || { echo "[run] 运行时不在：$DSH_NODE（先跑 provision-user-runtime.sh）" >&2; exit 4; }

# 用户名：只留小写字母数字与连字符，且**由课堂+学生确定性推导**（停的时候要能算回来）
USER_NAME="dshs-$(printf '%s|%s' "${SESSION}" "${STUDENT}" | sha256sum | cut -c1-10)"
WORKSPACE="/home/${USER_NAME}/workspace"
DSH_HOME="/home/${USER_NAME}/.dsh"
LOG_FILE="${LOG_DIR}/${USER_NAME}.log"
UNIT="dsh-student-${USER_NAME}"

# 端口：优先用平台指定的；没指定就在池子里挑一个没被占的
port_in_use() {
  [ -f "${NGINX_DIR}/$1.conf" ] && return 0
  ss -tln 2>/dev/null | grep -q ":$1 " && return 0
  return 1
}
if [ -n "${PUBLIC_PORT}" ]; then
  port_in_use "${PUBLIC_PORT}" && { echo "[run] 端口 ${PUBLIC_PORT} 已被占用" >&2; exit 3; }
else
  for candidate in $(seq "${PORT_BASE}" $((PORT_BASE + PORT_RANGE - 1))); do
    port_in_use "${candidate}" || { PUBLIC_PORT="${candidate}"; break; }
  done
  [ -n "${PUBLIC_PORT}" ] || { echo "[run] 端口池 ${PORT_BASE} 起 ${PORT_RANGE} 个都占满了" >&2; exit 3; }
fi
INNER_PORT=$((PUBLIC_PORT + INNER_OFFSET))

# 同名容器式的幂等：这个学生已经在跑就先收掉（同一节课重进）
if systemctl is-active --quiet "${UNIT}" 2>/dev/null; then
  systemctl stop "${UNIT}" >/dev/null 2>&1 || true
fi

# ① 用户：一个学生一个 Linux 用户，家目录 0700（同学读不到）
if ! id "${USER_NAME}" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "${USER_NAME}"
fi
chmod 700 "/home/${USER_NAME}"
mkdir -p "${WORKSPACE}" "${DSH_HOME}" "${LOG_DIR}"

# ② DSH_HOME：共享运行时用**硬链接**（同一份数据两个名字，不额外占盘），
#    只把 dsh 启动时要重写的那个文件断开，让它长成学生自己的。
if [ ! -d "${DSH_HOME}/profiles" ]; then
  cp -al "${TEMPLATE_HOME}/profiles" "${DSH_HOME}/profiles"
fi
rm -f "${DSH_HOME}/profiles/web/cordis.yml"
cp -f "${TEMPLATE_HOME}/settings.yaml" "${DSH_HOME}/settings.yaml"

# ③ 读图（modlens）的凭据：按本次注入的运行时密钥，写死一条指向我们网关的路由。
#    与容器版同一套理由与字段 —— 它自带 OpenAI/Gemini 等渠道，不接上就可能不花我们的账。
mkdir -p "/home/${USER_NAME}/.modlens"
MODLENS_CONFIG="/home/${USER_NAME}/.modlens/config.json"
export MODLENS_CONFIG PLATFORM_GATEWAY_KEY="${KEY}" PLATFORM_GATEWAY_BASE_URL="${GATEWAY}" PLATFORM_VISION_MODEL="${VISION_MODEL}"
"${DSH_NODE}" -e 'const fs=require("fs");const f=process.env.MODLENS_CONFIG;fs.writeFileSync(f,JSON.stringify({provider:"openai",cooldown:"off",providers:{openai:{baseUrl:process.env.PLATFORM_GATEWAY_BASE_URL,apiKey:process.env.PLATFORM_GATEWAY_KEY,model:process.env.PLATFORM_VISION_MODEL,structuredOutput:false}},reuse:{claude:false,codex:false,opencode:false,pi:false,grok:false}},null,2),{mode:0o600});'
chmod 600 "${MODLENS_CONFIG}"
# ⚠️ 属主要改成学生自己：这个文件是用 root 身份写的（脚本以 root 跑），
# 而读它的是**学生的 dsh 进程**（普通用户）—— 不改属主的话它读不到自己的配置（实测踩到）。
chown -R "${USER_NAME}:${USER_NAME}" "/home/${USER_NAME}/.modlens"

# ④ 属主：**只改目录，不改文件** —— 文件是硬链接，改属主会连带改到共享模板（踩过）。
#    目录必须是学生自己的，否则 dsh 写不进 cordis.yml；文件保持共享（读得到就够了）。
find "/home/${USER_NAME}" -type d -exec chown "${USER_NAME}:${USER_NAME}" {} + 2>/dev/null || true
chown "${USER_NAME}:${USER_NAME}" "${DSH_HOME}/settings.yaml" 2>/dev/null || true

# ⑤ 起进程：systemd 管资源上限，日志落到文件（启动票据从里面取）
#
# ⚠️ `--trusted-host` 不能省：dsh 的 `/api` 有一道「浏览器信任栅栏」，它只认
# **绑定的网卡地址 + --trusted-host 给的额外值**。我们绑的是回环（127.0.0.1），
# 栅栏里就只有回环地址 —— 学生从「域名:端口」进来时所有 /api 请求都会被 403 挡掉，
# 界面表现为「自动重连中…」（WebSocket 也升不上去）。实测踩到过。
# 两种写法都给：`域名` 与 `域名:端口`（栅栏按 Host 头比对，端口要一起给）。
: > "${LOG_FILE}"
systemd-run --unit="${UNIT}" --collect \
  --uid="${USER_NAME}" --gid="${USER_NAME}" \
  --working-directory="${WORKSPACE}" \
  -p "MemoryMax=${MEMORY_MAX}" -p "CPUQuota=${CPU_QUOTA}" -p "TasksMax=${TASKS_MAX}" \
  -p "StandardOutput=append:${LOG_FILE}" -p "StandardError=append:${LOG_FILE}" \
  --setenv=HOME="/home/${USER_NAME}" \
  --setenv=PATH=/usr/local/bin:/usr/bin:/bin \
  --setenv=DSH_HOME="${DSH_HOME}" \
  --setenv=DSH_WORKSPACE="${WORKSPACE}" \
  --setenv=DSH_COURSE_SKILLS="${SKILLS_DIR}" \
  --setenv=PLATFORM_GATEWAY_KEY="${KEY}" \
  --setenv=GATEWAY_BASE_URL="${GATEWAY}" \
  --setenv=PLATFORM_GATEWAY_BASE_URL="${GATEWAY}" \
  --setenv=PLATFORM_VISION_MODEL="${VISION_MODEL}" \
  "${DSH_NODE}" "${DSH_BIN}" --profile web --patch "${PATCH_FILE}" \
  --trusted-host "${PUBLIC_IP}" --trusted-host "${PUBLIC_IP}:${PUBLIC_PORT}" \
  --no-open --host 127.0.0.1 --port "${INNER_PORT}" >/dev/null

TOKEN=""
for _ in $(seq 1 60); do
  TOKEN="$(sed -n 's/.*[?&]token=\([A-Za-z0-9._-]*\).*/\1/p' "${LOG_FILE}" 2>/dev/null | head -1)"
  [ -n "${TOKEN}" ] && break
  sleep 1
done
if [ -z "${TOKEN}" ]; then
  echo "[run] 学生环境没起来，日志尾巴：" >&2
  tail -20 "${LOG_FILE}" >&2 || true
  systemctl stop "${UNIT}" >/dev/null 2>&1 || true
  exit 1
fi
# 入口标记：按**这次启动**的唯一值（dsh token 的哈希）。与容器版同一套理由：
# 固定值或票据值都会在「同一个学生拿同一张票据重开」时误判（实测出现过 401）。
MARKER="$(printf '%s' "${TOKEN}" | sha256sum | cut -c1-16)"

# ⑥ 入口：一条 nginx server 块，对外只开这个端口，先把平台票据过了再转发给学生的 dsh。
mkdir -p "${NGINX_DIR}"
cat > "${NGINX_DIR}/${USER_NAME}.conf" <<NGINX
# 学生 ${USER_NAME}（课堂 ${SESSION}）—— 由 run-student-user.sh 生成，停课时删掉。
# dsh 硬注入 <base href="/">，所以它**必须挂在根路径**，只能一个学生一个端口（实测过子路径不行）。
server {
    listen ${PUBLIC_PORT} ssl;
    listen [::]:${PUBLIC_PORT} ssl;
    server_name ${PUBLIC_IP};
    ssl_certificate /etc/letsencrypt/live/${PUBLIC_IP}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${PUBLIC_IP}/privkey.pem;

    # ⚠️ 必须关：不关的话 nginx 生成的 302 会写成**绝对地址**
    # （https://域名:端口/?token=...），浏览器就可能被带出这个入口（容器里踩过同一个坑）。
    absolute_redirect off;
    # dsh 自己的 303 也带绝对 Location（Location: /），一并改写成相对，留在这个入口里。
    # ⚠️ 这里的 \$1 必须转义：nginx 配置是**未加引号的 heredoc**，不转义会被 shell 当成位置参数展开
    # （踩过：脚本报 `$1: unbound variable`）。
    proxy_redirect ~^https?://[^/]+/(.*)\$ /\$1;
    proxy_redirect ~^/(.*)\$ /\$1;

    # 平台票据闸门：带 ?t= 或带本入口的 cookie 才放行，其余 403。
    set \$ticket \$arg_t;
    if (\$http_x_platform_ticket) { set \$ticket \$http_x_platform_ticket; }
    set \$ok 0;
    if (\$ticket = "${TICKET}") { set \$ok 1; }
    if (\$cookie_dsh_edge = "${MARKER}") { set \$ok 1; }
    if (\$ok = 0) { return 403; }

    client_max_body_size 32m;

    location = / {
        # 第一次进来补上 dsh 的会话票据，并打上「补过了」的标记
        if (\$cookie_dsh_edge != "${MARKER}") {
            add_header Set-Cookie "dsh_edge=${MARKER}; Path=/; HttpOnly; SameSite=Lax" always;
            return 302 /?token=${TOKEN};
        }
        proxy_pass http://127.0.0.1:${INNER_PORT};
        include /etc/nginx/dsh-proxy-headers.conf;
    }
    location / {
        proxy_pass http://127.0.0.1:${INNER_PORT};
        include /etc/nginx/dsh-proxy-headers.conf;
    }
}
NGINX

nginx -t >/dev/null 2>&1 || { echo "[run] nginx 配置校验失败，撤掉这条入口" >&2; rm -f "${NGINX_DIR}/${USER_NAME}.conf"; systemctl stop "${UNIT}" >/dev/null 2>&1 || true; exit 5; }
systemctl reload nginx

echo "RUNTIME_NAME=${USER_NAME}" >&2
echo "HOST_PORT=${PUBLIC_PORT}" >&2
echo "RUNTIME_NAME=${USER_NAME}"
echo "HOST_PORT=${PUBLIC_PORT}"
echo "EDGE_URL=https://${PUBLIC_IP}:${PUBLIC_PORT}/?t=${TICKET}"
