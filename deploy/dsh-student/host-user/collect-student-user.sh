#!/usr/bin/env bash
# 从一个学生的创作环境里**取回产物**（同机独立用户版）—— 切学生入口前必需的那一段。
#
# 为什么要有它：dsh 的产物（网页、PPT 的 .pptx 成品）都落在**学生自己的工作区**里，
# 平台库里一份都没有。学生点「提交作品」时，平台要靠这个脚本把文件取回去。
#
# 三个子命令：
#   --list                 列出现在工作区里能当作品交的东西（JSON 到 stdout）
#   --export <相对路径>     取回一份产物：它自己 + 它引用的本地素材（JSON 到 stdout）
#   --preserve             把当前所有产物**原样留一份**到工作区之外（收环境前用）
#
# 用法：
#   collect-student-user.sh --session <课堂id> --student <学生id> --list
#   collect-student-user.sh --session <课堂id> --student <学生id> --export mygame/index.html
#   collect-student-user.sh --session <课堂id> --student <学生id> --preserve
#
# 输出约定（与 run/stop 同一套风格）：
#   · **stdout 只放一行 JSON**，平台直接 JSON.parse；
#   · 脚本自己的进度/告警走 stderr；
#   · 出错的退出码非 0，并且 stderr 上带一个 COLLECT_* 错误码（失败要吵）。
#
# 真机核实（2026-09-16）：dsh 的 PPT 插件做完演示文稿会把成果发布到**工作区**里
# （以标题命名的目录，含 PPTD 工程与成品 .pptx），所以「枚举工作区」对网页与 PPT 都成立。
# 走查与导出（含越界/符号链接/体积这些安全判定）在旁边的 collect-student.mjs 里。
set -Eeuo pipefail

RUNTIME_ROOT="${RUNTIME_ROOT:-/opt/dsh-runtime}"
DSH_NODE="$RUNTIME_ROOT/opt/node/bin/node"
COLLECT_JS="$(dirname "$(readlink -f "$0")")/collect-student.mjs"
PRESERVE_ROOT="${PRESERVE_ROOT:-/srv/dsh-runtime/deliverables}"
LOG_DIR="${LOG_DIR:-/srv/dsh-runtime/logs}"

SESSION=""; STUDENT=""; USER_NAME=""; COMMAND=""; TARGET=""
parse() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --session) SESSION="${2:-}"; shift 2 ;;
      --student) STUDENT="${2:-}"; shift 2 ;;
      --name) USER_NAME="${2:-}"; shift 2 ;;
      --list) COMMAND="list"; shift ;;
      --export) COMMAND="export"; TARGET="${2:-}"; shift 2 ;;
      --preserve) COMMAND="preserve"; shift ;;
      -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
      *) echo "[collect] 不认识的参数：$1" >&2; exit 2 ;;
    esac
  done
}
parse "$@"

[ -n "${COMMAND}" ] || { echo "[collect] 要给 --list / --export <路径> / --preserve 之一" >&2; exit 2; }
[ -n "${USER_NAME}" ] || [ -n "${SESSION}" ] || { echo "[collect] 要给 --session/--student 或 --name" >&2; exit 2; }
[ -x "$DSH_NODE" ] || { echo "[collect] 运行时不在：$DSH_NODE" >&2; exit 4; }
[ -f "$COLLECT_JS" ] || { echo "[collect] 找不到 $COLLECT_JS" >&2; exit 4; }

# 用户名：与 run/stop 同一套推导（课堂+学生的哈希），两处不一致就会取到别人的东西
if [ -z "${USER_NAME}" ]; then
  USER_NAME="dshs-$(printf '%s|%s' "${SESSION}" "${STUDENT}" | sha256sum | cut -c1-10)"
fi
# 兜底：只允许碰我们自己的学生用户（这条链路是 root 在跑，收敛到 dshs- 前缀）
case "${USER_NAME}" in
  dshs-*) ;;
  *) echo "[collect] 拒绝操作非学生用户名：${USER_NAME}" >&2; exit 2 ;;
esac

WORKSPACE="/home/${USER_NAME}/workspace"
if ! id "${USER_NAME}" >/dev/null 2>&1; then
  echo "[collect] COLLECT_NO_USER: 这个学生的环境不在（${USER_NAME}）—— 可能已经收掉了" >&2
  exit 3
fi
if [ ! -d "${WORKSPACE}" ]; then
  echo "[collect] COLLECT_NO_WORKSPACE: 工作区不在（${WORKSPACE}）" >&2
  exit 3
fi

export COLLECT_WORKSPACE="${WORKSPACE}"
export COLLECT_PRESERVE_ROOT="${PRESERVE_ROOT}"

case "${COMMAND}" in
  list)
    # 走查要在学生自己的权限下做一次更真实的判定？不必 —— 这里以 root 读，
    # 但**工作区本来就只有他自己和 root 能进**（家目录 0700），不存在读到同学的东西。
    "$DSH_NODE" "$COLLECT_JS" list
    ;;
  export)
    "$DSH_NODE" "$COLLECT_JS" export "${TARGET}"
    ;;
  preserve)
    mkdir -p "${PRESERVE_ROOT}"
    OUT="$("$DSH_NODE" "$COLLECT_JS" preserve)"
    echo "[collect] 已留存产物：${USER_NAME}" >&2
    echo "${OUT}"
    ;;
esac
