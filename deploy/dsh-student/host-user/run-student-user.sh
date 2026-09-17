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
# ⚠️ 这一段**必须与云安全组放行的范围一致** —— 否则学生会被分到一个从公网打不开的端口。
# ⚠️ 2026-09-16：原来是写死的 20 个，于是「第 21 个学生根本进不来」—— 那是**我写死的上限，
#    不是协议限制**：TCP 端口有 6 万多个，端口模型本身能撑几千人，只要安全组放行这一段。
#    所以池子放到 400 个（18201-18600）。要再放大只需改 PORT_RANGE + 安全组，
#    不需要动代码、也不需要配 DNS。
PORT_BASE="${PORT_BASE:-18201}"
PORT_RANGE="${PORT_RANGE:-400}"
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
# ⚠️ 票据**必须非空**：下面那条 nginx 闸门是 `if ($ticket = "${TICKET}") { set $ok 1; }`，
# 空票据会让闸门恒等成立 —— 等于这个学生的入口对**任何知道端口的人**开放（实测过：
# 配置被写坏成空票据时就是这个后果）。平台侧一定给票据（24 字节随机），
# 所以这里只在「调用方漏传」时兜底，宁可直接失败也不要写出一个没锁的入口。
[ -n "${TICKET}" ] || { echo "[run] 必须给 --ticket（入口闸门的票据，空票据等于不锁门）" >&2; exit 2; }
[ -x "$DSH_NODE" ] || { echo "[run] 运行时不在：$DSH_NODE（先跑 provision-user-runtime.sh）" >&2; exit 4; }

# 网页搜索那条路：dsh 的搜索插件（@deepseek-ai/dsh-web-search-deepseek）调的是 **Anthropic 协议的
# /messages**（搜索是模型一跳里的服务端工具），它认两个环境变量（源码里写死的）：
#   DEEPSEEK_SEARCH_BASE_URL —— 端点基地址，插件自己会拼 "/messages"；
#   DEEPSEEK_API_KEY        —— 密钥。
# ⚠️ 两个都必须指向**我们自己的网关**、给的必须是**本次的运行时密钥**（就是下面 PLATFORM_GATEWAY_KEY
#    那把，短时、绑课堂）。**绝不**把渠道真密钥导出到学生环境 —— 学生能从自己的进程里读出来，
#    既泄漏又能绕过账本花钱。网关那一跳会把它换成真密钥（见 runtimeSearchGateway.js）。
SEARCH_GATEWAY="${GATEWAY%/}/search"

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

# ---------------------------------------------------------------------------
# 复用优先（2026-09-16 晚加入）
#
# 学生点「进入创作环境」→ 平台 → 这个脚本。以前这里是无条件「停掉 + 冷启动」，
# 而 dsh 冷启动要十几秒：学生刷新一下、老师再点一次、或者学生掉线重进，
# 都要白等一遍（用户口径：「应该秒进才对」）。
#
# 环境其实**还活着**的时候，只要换一张票据就行 —— dsh 的 token 还在日志里，
# 票据只是 nginx 那一段配置，重写 + reload 是秒级的。
#
# 复用条件（任一不满足就老实冷启动）：
#   ① 单元还在跑；
#   ② 起得不太久 —— 运行时密钥 6 小时有效，这里留一半余量（4 小时）；
#   ③ 日志里还能捞到 dsh 的 token；
#   ④ 上次写的那条入口配置还在（端口从它里面读回来，端口池就这么点，别漏了它）。
# ---------------------------------------------------------------------------
REUSE_MAX_AGE_S="${REUSE_MAX_AGE_S:-14400}"

# 已在跑的那个 dsh 进程，环境里带的是哪把网关密钥？
# （dsh 只在启动时读一次环境变量，所以复用**改不了**它手里的密钥 —— 这一点决定了下面那条判据。）
# 读任意一个环境变量都用它：`reuse` 的判据要看的不止密钥一个。
running_env_value() {
  local pid
  pid="$(systemctl show "${UNIT}" -p MainPID --value 2>/dev/null || true)"
  [ "${pid:-0}" -gt 0 ] 2>/dev/null || return 1
  [ -r "/proc/${pid}/environ" ] || return 1
  tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null | sed -n "s/^$1=//p" | head -1
}

running_env_key() {
  running_env_value PLATFORM_GATEWAY_KEY
}

# 环境里那把密钥**还能不能用来上这节课**？
#
# 2026-09-16 踩到的坑：dsh 只在启动时读一次 PLATFORM_GATEWAY_KEY，复用刷新不了它 ——
# 所以复用之前必须确认它手里那把**仍然是给这个课堂、这个学生的、且没过期**。
# 判据只看密钥 payload 里的 s/u 与 exp（不验签：签名是不是我们发的，由平台每次调用时验；
# 这里只回答「复用它之后 AI 能不能用」）。不满足就老老实实冷启动 ——
# 否则学生进得去、但一发消息就报「API 密钥无效」或「课堂已经结束」。
# 典型要冷启动的两种情况：① 老师结束课堂 A、用同一个学生又开了课堂 B（s 变了）；
# ② 上一次冷启动是我手工测试留下的假密钥（根本解不出 payload）。
environment_key_usable() {
  local key verdict
  VERBOSE_REASON="no-key"
  key="$(running_env_key)" || return 1
  [ -n "${key}" ] || return 1
  # 网页搜索那两个变量也必须已经在环境里。它们在**这次改动之前**起的环境里是不存在的 ——
  # 那时复用得到的是一个「AI 能用、一搜索就报 no API key」的半坏环境，而且学生没有任何提示。
  # 宁可冷启动一次（十几秒，一次性）把它补齐。判据与密钥同一套理由：进程活着 ≠ 它手里那套是齐的。
  local search_base
  search_base="$(running_env_value DEEPSEEK_SEARCH_BASE_URL)"
  if [ "${search_base}" != "${SEARCH_GATEWAY}" ]; then VERBOSE_REASON="环境里的搜索网关不是这次的（${search_base:-空}）"; return 1; fi
  verdict="$("${DSH_NODE}" -e '
    const raw = process.argv[1] || "";
    const parts = raw.split(".");
    if (parts.length !== 3 || parts[0] !== "rt1") { console.log("bad-shape"); process.exit(0); }
    let p = null;
    try { p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { console.log("bad-payload"); process.exit(0); }
    if (p.s !== process.argv[2]) { console.log("other-session"); process.exit(0); }
    if (p.u !== process.argv[3]) { console.log("other-student"); process.exit(0); }
    if (!Number.isFinite(p.exp) || p.exp <= Date.now() + 5 * 60 * 1000) { console.log("expiring"); process.exit(0); }
    console.log("ok");
  ' "${key}" "${SESSION}" "${STUDENT}" 2>/dev/null || true)"
  VERBOSE_REASON="${verdict:-no-key}"
  [ "${verdict}" = "ok" ]
}

reuse_running_environment() {
  systemctl is-active --quiet "${UNIT}" 2>/dev/null || return 1
  # 环境里那把密钥必须对这节课仍然可用（见上面的注释）—— 这一条比「单元在跑」更关键：
  # 单元在跑只说明进程活着，不代表它还能调得动模型。
  environment_key_usable || return 1
  local started now_us age port token
  started="$(systemctl show "${UNIT}" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || true)"
  started="${started:-0}"
  [ "${started}" -gt 0 ] 2>/dev/null || return 1
  now_us="$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)"
  age=$(( (now_us - started) / 1000000 ))
  if [ "${age}" -lt 0 ] || [ "${age}" -gt "${REUSE_MAX_AGE_S}" ]; then VERBOSE_REASON="环境起太久了（${age}s > ${REUSE_MAX_AGE_S}s）"; return 1; fi
  port="$(sed -n 's/^ *listen \([0-9]\{1,\}\) ssl;.*/\1/p' "${NGINX_DIR}/${USER_NAME}.conf" 2>/dev/null | head -1)"
  # 兜底：入口配置丢了（被回收脚本清掉、或上一次写失败了），但单元还在跑 ——
  # 端口可以从单元自己的启动参数推回来（内部端口 = 对外端口 + 1000）。
  # 2026-09-17 实测踩到：环境活着、入口没了，复用因此判定失败 → 又去冷启动 → 撞上并发保护，
  # 前端一直卡在「正在开环境…」。有这条兜底就能直接复用、把入口补回来。
  if [ -z "${port}" ]; then
    inner_port="$(systemctl show "${UNIT}" -p ExecStart --value 2>/dev/null | sed -n 's/.*--port \([0-9]\{1,\}\).*/\1/p' | head -1)"
    [ -n "${inner_port}" ] && port=$(( inner_port - INNER_OFFSET ))
  fi
  [ -n "${port}" ] || { VERBOSE_REASON="上次的入口配置里读不到端口"; return 1; }
  token="$(sed -n 's/.*[?&]token=\([A-Za-z0-9._-]*\).*/\1/p' "${LOG_FILE}" 2>/dev/null | head -1)"
  [ -n "${token}" ] || { VERBOSE_REASON="日志里捞不到 dsh token"; return 1; }
  PUBLIC_PORT="${port}"
  INNER_PORT=$((PUBLIC_PORT + INNER_OFFSET))
  TOKEN="${token}"
  return 0
}

# ★ 并发保护（2026-09-17 实测踩到）：
# 前端那个按钮点下去是「一个请求一直挂着」，学生看它卡着就会**再点几次** ——
# 于是同一个学生的两三个开环境脚本同时抢同一个 systemd 单元：后来者直接撞上
#   `Failed to start transient service unit: Unit ... was already loaded`
# 结果比「慢」更糟：环境起来了、入口配置却没写成，前端永远卡在「正在开环境…」。
# 用 flock 把同一个学生的开环境请求**串行化**：后来者等前一个跑完，然后**重新走复用判定** ——
# 那时环境已经热了，走的是 0.07 秒那条路，对学生的体验反而更好。
LAUNCH_LOCK="${LAUNCH_LOCK:-/run/dsh-launch-${USER_NAME}.lock}"
exec 9>"${LAUNCH_LOCK}"
if ! flock -w 90 9; then
  echo "[run] 另一个开环境请求还在跑（等了 90 秒），本次放弃" >&2
  exit 10
fi

REUSED=0
if reuse_running_environment; then  REUSED=1
  echo "[run] 复用已在跑的环境 ${USER_NAME}（端口 ${PUBLIC_PORT}），只换票据" >&2
else
  echo "[run] 走冷启动（复用不成立：${VERBOSE_REASON:-环境没在跑}）" >&2
fi

# 下面这一段只在**冷启动**时跑：分配端口、停旧的、建用户与工作区、起 dsh、等 token。
# 复用路径直接跳到下面的「写入口 + reload」，所以拿 ${REUSED} 把整段包起来。
if [ "${REUSED}" = 0 ]; then

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

# ⑨ 容量闸门（2026-09-16）：**装不下就别开**。
# 一个学生环境稳态约 470-490MB（峰值 643MB），这台 1.6GB 的机器只放得下 2 个；
# 第 3 个硬塞进来会把**所有人**拖进 swap（文档实测：同样操作 9.7s → 59s）。
# 所以宁可让这一次开盒子明确失败（平台会报「机器满了」），也不要让全班一起变慢。
# ⚠️ 这个检查必须放在**停掉旧环境之后**：重启同一个学生时，旧进程刚释放的内存要算进可用量，
#    否则「明明只是重进一下」也会被自己的旧环境挡住。
#    可通过 REQUIRED_MB 调整（默认 600 = 稳态 490 + 余量）；设 0 可关掉这个闸门。
REQUIRED_MB="${REQUIRED_MB:-600}"
if [ "${REQUIRED_MB}" -gt 0 ] && command -v free >/dev/null 2>&1; then
  AVAIL_MB="$(free -m | awk '/^Mem:/{print $7}')"
  if [ -n "${AVAIL_MB}" ] && [ "${AVAIL_MB}" -lt "${REQUIRED_MB}" ]; then
    echo "[run] 这台机器可用内存 ${AVAIL_MB}MB，装不下一个新环境（需要约 ${REQUIRED_MB}MB）：拒绝开盒子" >&2
    exit 7
  fi
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
# 起之前先把这个单元的历史状态清掉：只 `systemctl stop` 不够 ——
# 单元处于 failed/inactive 但**仍然 loaded** 时，systemd-run --unit= 会直接报
# 「Unit ... was already loaded or has a fragment file」（2026-09-17 实测）。
systemctl reset-failed "${UNIT}" >/dev/null 2>&1 || true
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
  --setenv=DEEPSEEK_SEARCH_BASE_URL="${SEARCH_GATEWAY}" \
  --setenv=DEEPSEEK_API_KEY="${KEY}" \
  "${DSH_NODE}" "${DSH_BIN}" --profile web --patch "${PATCH_FILE}" \
  --trusted-host "${PUBLIC_IP}" --trusted-host "${PUBLIC_IP}:${PUBLIC_PORT}" \
  --no-open --host 127.0.0.1 --port "${INNER_PORT}" >/dev/null

TOKEN=""
# 等 dsh 打印出它的 token（这是冷启动里我们唯一能等的信号）。
# 2026-09-16：粒度从 1 秒改成 0.2 秒（总上限仍是 60 秒）——
# 学生对这个等待很敏感（「进个网页等十几秒体验很差」），能少等一秒是一秒。
for _ in $(seq 1 300); do
  TOKEN="$(sed -n 's/.*[?&]token=\([A-Za-z0-9._-]*\).*/\1/p' "${LOG_FILE}" 2>/dev/null | head -1)"
  [ -n "${TOKEN}" ] && break
  sleep 0.2
done
if [ -z "${TOKEN}" ]; then
  echo "[run] 学生环境没起来，日志尾巴：" >&2
  tail -20 "${LOG_FILE}" >&2 || true
  systemctl stop "${UNIT}" >/dev/null 2>&1 || true
  exit 1
fi
fi   # ← 冷启动段到此为止（复用路径直接跳到这里）

# 入口标记：按**这次启动**的唯一值（dsh token 的哈希）。与容器版同一套理由：
# 固定值或票据值都会在「同一个学生拿同一张票据重开」时误判（实测出现过 401）。
# 复用路径下 TOKEN 是从日志里读回来的同一个 token，所以 MARKER 不变 —— 学生手里的
# dsh_edge cookie 仍然有效，不会多一次 302。
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
    # （踩过：脚本每次启动都刷一行 unbound variable）。
    # ⚠️ 这段注释里也**不能出现反引号**：未加引号的 heredoc 会把反引号当命令替换真的去执行。
    # ⚠️ 这条注释本身也要小心：heredoc 会展开里面的变量引用（写位置参数的符号就会报 unbound），
    #   所以这里只说「位置参数的符号」，不写出那个符号本身（2026-09-16 因为写了它又踩了一次）。
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

# ⑧ 等到入口**真的放行**再返回（2026-09-16 实测踩到）：
# `systemctl reload` 只是给 master 发信号，**老 worker 要把手里的连接排空才退出** ——
# 这中间有一小段窗口，新连接可能被老 worker 按**旧票据**处理，学生看到的就是 403
# （实测：launch 返回后 100ms 请求 → 403；同一张票据过几秒再请求 → 302）。
# 平台拿到的 URL 是直接给浏览器打开的，所以这里必须**用请求本身当探针**，
# 确认放行了才把 EDGE_URL 交出去。
entry_is_live() {
  local code
  code="$(curl -sk -o /dev/null -m 3 -w '%{http_code}' -H "Host: ${PUBLIC_IP}" \
    "https://127.0.0.1:${PUBLIC_PORT}/?t=${TICKET}" 2>/dev/null || true)"
  [ "${code}" = "302" ] || [ "${code}" = "200" ]
}
if command -v curl >/dev/null 2>&1; then
  ENTRY_OK=0
  for _ in $(seq 1 25); do
    entry_is_live && { ENTRY_OK=1; break; }
    sleep 0.2
  done
  if [ "${ENTRY_OK}" != 1 ]; then
    echo "[run] 入口写好了但探针 5 秒内一直没放行（最后一跳 HTTP：$(curl -sk -o /dev/null -m 3 -w '%{http_code}' -H "Host: ${PUBLIC_IP}" "https://127.0.0.1:${PUBLIC_PORT}/?t=${TICKET}" 2>/dev/null)）—— 不把这个地址交出去" >&2
    exit 6
  fi
else
  echo "[run] 没有 curl，跳过入口探针（不保证浏览器打开时已经放行）" >&2
fi

echo "RUNTIME_NAME=${USER_NAME}" >&2
echo "HOST_PORT=${PUBLIC_PORT}" >&2
echo "RUNTIME_NAME=${USER_NAME}"
echo "HOST_PORT=${PUBLIC_PORT}"
echo "EDGE_URL=https://${PUBLIC_IP}:${PUBLIC_PORT}/?t=${TICKET}"
