#!/usr/bin/env bash
# 容器内入口：
#  1) 起 dsh web（只绑 127.0.0.1，端口固定 3080，这是它默认且唯一被官方支持的姿态）
#  2) 从它的启动输出里取一次性访问票据（?token=...）
#  3) 渲染并启动 nginx：对外只开 EDGE_PORT，校验我们平台的短时票据后转发到 127.0.0.1:3080
#
# 一个学生一节课 = 一个这个容器；容器没了，会话日志、工作区、票据一起没。
set -Eeuo pipefail

DSH_INNER_HOST=127.0.0.1
DSH_INNER_PORT=3080
EDGE_PORT="${EDGE_PORT:-8080}"
LOG=/tmp/dsh-web.log

# 平台网关凭据：由平台注入环境变量（名字由 GATEWAY_KEY_ENV 指定），dsh 通过 apiKeyEnv 引用
export PLATFORM_GATEWAY_KEY="${PLATFORM_GATEWAY_KEY:-}"
export PLATFORM_GATEWAY_BASE_URL="${GATEWAY_BASE_URL:-}"

# 0) 视觉桥（modlens）的凭据：**必须指向我们的网关**。
# 先说清主路径：学生贴的图**不走它** —— 我们的模型自己就能看图（补丁层里声明了
# `input: [text, image]`，图当内容块走同一条 TEXT 渠道）。modlens 是「给纯文本模型配的视觉桥」，
# 我们这条路上用不到；这里接上只是为了万一将来把学生指到纯文本模型（或有人点了它）时，
# 它不要去花别家的钱 —— 它自带 OpenAI / Gemini / Antigravity CLI 等渠道，容器里既没有那些凭据，
# 就算有，读图花的钱也不进我们的账本。所以按本次容器注入的运行时密钥写死一条路由。
# 用 node 生成而不是 heredoc：密钥或 URL 里出现引号也不会把 JSON 写坏。
#   · structuredOutput 必须是 false：我们的网关只转 messages 与 stream，**不转 response_format**，
#     打开它等于要求上游按 JSON Schema 回，实际拿不到 → modlens 以「契约不完整」失败。
#   · reuse 全 false：明确拒绝复用容器里其他工具的登录态（容器里本来也没有）。
MODLENS_CONFIG_PATH="${HOME:-/root}/.modlens/config.json"
export MODLENS_CONFIG_PATH
if [ -n "${PLATFORM_GATEWAY_KEY}" ] && [ -n "${PLATFORM_GATEWAY_BASE_URL}" ]; then
  PLATFORM_VISION_MODEL="${PLATFORM_VISION_MODEL:-platform-vision}" \
  node -e 'const fs=require("fs"),path=require("path");const file=process.env.MODLENS_CONFIG_PATH;
fs.mkdirSync(path.dirname(file),{recursive:true});
fs.writeFileSync(file,JSON.stringify({
  provider:"openai",
  cooldown:"off",
  providers:{openai:{baseUrl:process.env.PLATFORM_GATEWAY_BASE_URL,apiKey:process.env.PLATFORM_GATEWAY_KEY,model:process.env.PLATFORM_VISION_MODEL,structuredOutput:false}},
  reuse:{claude:false,codex:false,opencode:false,pi:false,grok:false}
},null,2),{mode:0o600});'
  echo "[entrypoint] 读图已指向我们的网关（模型 ${PLATFORM_VISION_MODEL:-platform-vision}）"
else
  echo "[entrypoint] 警告：没有注入网关凭据，读图不会被接通（模型调用本身也没法工作）" >&2
fi

# 1) 起 dsh（后台），日志同时在容器 stdout 留一份
dsh --profile web --patch "${DSH_PATCH}" --no-open --host "${DSH_INNER_HOST}" --port "${DSH_INNER_PORT}" 2>&1 | tee "${LOG}" &

# 2) 等票据（dsh 启动会打印 http://127.0.0.1:3080/?token=...）
TOKEN=""
for _ in $(seq 1 60); do
  TOKEN="$(sed -n 's/.*[?&]token=\([A-Za-z0-9._-]*\).*/\1/p' "${LOG}" | head -1)"
  [ -n "${TOKEN}" ] && break
  sleep 1
done
if [ -z "${TOKEN}" ]; then
  echo "[entrypoint] 没能从 dsh 启动输出里取到访问票据，拒绝启动对外入口" >&2
  tail -20 "${LOG}" >&2 || true
  exit 1
fi
echo "[entrypoint] dsh 已就绪，会话票据长度 ${#TOKEN}"
# 入口标记：按**这次启动**的唯一值（dsh token 的哈希），用来判断这台容器是否已经补过 token。
# 不能用固定值，也不能用平台票据本身 —— 同一个学生拿同一张票据重开容器时会误判（实测出现过 401）。
EDGE_MARKER="$(printf '%s' "${TOKEN}" | sha256sum | cut -c1-16)"
echo "[entrypoint] 入口标记 ${EDGE_MARKER}"

# 3) 渲染 nginx 配置并启动
EDGE_TICKET="${EDGE_TICKET:-}"
mkdir -p /run/nginx
sed -e "s#__INNER_HOST__#${DSH_INNER_HOST}#g" \
    -e "s#__INNER_PORT__#${DSH_INNER_PORT}#g" \
    -e "s#__EDGE_PORT__#${EDGE_PORT}#g" \
    -e "s#__DSH_TOKEN__#${TOKEN}#g" \
    -e "s#__EDGE_TICKET__#${EDGE_TICKET}#g" \
    -e "s#__EDGE_MARKER__#${EDGE_MARKER}#g" \
    /etc/dsh/nginx.conf.template > /etc/nginx/conf.d/dsh-student.conf

echo "[entrypoint] 对外入口 http://0.0.0.0:${EDGE_PORT}/（平台票据校验：$([ -n "${EDGE_TICKET}" ] && echo 开 || echo 关)）"
exec nginx -g 'daemon off;'
