#!/usr/bin/env bash
# 收掉一个学生的创作环境（同机独立用户版）——课堂结束、被移出名单、或兜底回收时调。
#
# 四件事一起做，缺一个都会留下垃圾或**把学生的作品弄丢**：
#   ① 留存产物（工作区里的网页/PPT 先复制到工作区之外 —— 交没交过都留一份）；
#   ② 停进程（systemd 单元）；③ 删 nginx 那条入口并热加载；④ 删用户与他的家目录。
# 家目录删掉 = 工作区、会话、票据一起没（与容器版「容器没了就什么都没了」等价）。
# ⚠️ ①是 2026-09-16 补的：在此之前「下课」等于**学生的作品直接消失** —— 没点过提交的那些就真没了。
set -Eeuo pipefail

NGINX_DIR="${NGINX_DIR:-/etc/nginx/dsh-students}"
SESSION=""; STUDENT=""; USER_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session) SESSION="${2:-}"; shift 2 ;;
    --student) STUDENT="${2:-}"; shift 2 ;;
    --name) USER_NAME="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "[stop] 不认识的参数：$1" >&2; exit 2 ;;
  esac
done
[ -n "${USER_NAME}" ] || [ -n "${SESSION}" ] || { echo "[stop] 要给 --session/--student 或 --name" >&2; exit 2; }

# 按「与 run 同一套推导」算出用户名：课堂+学生的哈希
if [ -z "${USER_NAME}" ]; then
  USER_NAME="dshs-$(printf '%s|%s' "${SESSION}" "${STUDENT}" | sha256sum | cut -c1-10)"
fi
# 兜底：只允许动我们自己的学生用户，别把系统的 dshs- 前缀以外的东西删了
case "${USER_NAME}" in
  dshs-*) ;;
  *) echo "[stop] 拒绝操作非学生用户名：${USER_NAME}" >&2; exit 2 ;;
esac

UNIT="dsh-student-${USER_NAME}"
stopped=0

# ① 留存产物：家目录一删就没了，所以**先留一份**再收。留存失败不拦住收环境
#    （否则一个坏脚本会让课堂永远收不掉），但要在 stderr 上吵一句。
COLLECT_SCRIPT="${COLLECT_SCRIPT:-/opt/dsh-host-user/collect-student-user.sh}"
if [ -x "${COLLECT_SCRIPT}" ] && [ -d "/home/${USER_NAME}/workspace" ]; then
  if "${COLLECT_SCRIPT}" --name "${USER_NAME}" --preserve >/dev/null; then
    echo "[stop] 已留存产物 ${USER_NAME} → ${PRESERVE_ROOT:-/srv/dsh-runtime/deliverables}"
  else
    echo "[stop] ⚠️ 留存产物失败（继续收环境，这份作品可能丢）" >&2
  fi
fi

if systemctl is-active --quiet "${UNIT}" 2>/dev/null; then
  systemctl stop "${UNIT}" >/dev/null 2>&1 || true
  systemctl reset-failed "${UNIT}" >/dev/null 2>&1 || true
  echo "[stop] 已停进程 ${USER_NAME}"
  stopped=1
fi

if [ -f "${NGINX_DIR}/${USER_NAME}.conf" ]; then
  rm -f "${NGINX_DIR}/${USER_NAME}.conf"
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    echo "[stop] 已撤入口 ${USER_NAME}"
  else
    echo "[stop] ⚠️ nginx 配置校验失败，已删掉入口文件但**没有**热加载 —— 请人工看一眼" >&2
  fi
  stopped=1
fi

if id "${USER_NAME}" >/dev/null 2>&1; then
  # 家目录一起删：工作区、会话、票据都在这下面
  pkill -u "${USER_NAME}" 2>/dev/null || true
  sleep 1
  userdel -r "${USER_NAME}" >/dev/null 2>&1 || userdel "${USER_NAME}" >/dev/null 2>&1 || true
  [ -d "/home/${USER_NAME}" ] && rm -rf "/home/${USER_NAME}"
  echo "[stop] 已删用户与家目录 ${USER_NAME}"
  stopped=1
fi

[ "${stopped}" = "1" ] || echo "[stop] ${USER_NAME} 本来就不在跑"
