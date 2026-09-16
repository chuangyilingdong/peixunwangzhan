#!/usr/bin/env bash
# 停掉一个学生容器。课堂结束、学生被移出名单、或者回收空闲容器时都走这里。
#
# 用法：
#   stop-student-container.sh --name dsh-s-xxx-yyy
#   stop-student-container.sh --session <课堂id>        # 这一个课堂的全部容器
#   stop-student-container.sh --student <学生id>
#   stop-student-container.sh --all
#
# 为什么不直接 docker rm：容器名字与标签是平台记账的一部分，
# 走这里能保证「只停学生容器」，不会误伤宿主上别的东西。
set -Eeuo pipefail

NAME=""; SESSION=""; STUDENT=""; ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:-}"; shift 2 ;;
    --session) SESSION="${2:-}"; shift 2 ;;
    --student) STUDENT="${2:-}"; shift 2 ;;
    --all) ALL=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "[stop] 不认识的参数：$1" >&2; exit 2 ;;
  esac
done

targets=()
if [ "${ALL}" = "1" ]; then
  while IFS= read -r line; do [ -n "${line}" ] && targets+=("${line}"); done < <(docker ps -aq --filter label=dsh.runtime=student)
fi
[ -n "${NAME}" ] && targets+=("${NAME}")
if [ -n "${SESSION}" ]; then
  while IFS= read -r line; do [ -n "${line}" ] && targets+=("${line}"); done < <(docker ps -aq --filter "label=dsh.runtime=student" --filter "label=dsh.session=${SESSION}")
fi
if [ -n "${STUDENT}" ]; then
  while IFS= read -r line; do [ -n "${line}" ] && targets+=("${line}"); done < <(docker ps -aq --filter "label=dsh.runtime=student" --filter "label=dsh.student=${STUDENT}")
fi

if [ "${#targets[@]}" = "0" ]; then
  echo "[stop] 没有匹配的学生容器"
  exit 0
fi

for id in "${targets[@]}"; do
  # 只允许删带这个标签的：别的容器（宿主自己的东西）一概不动
  labels="$(docker inspect -f '{{index .Config.Labels "dsh.runtime"}}' "${id}" 2>/dev/null || true)"
  if [ "${labels}" != "student" ]; then
    echo "[stop] 跳过 ${id}：不是学生容器" >&2
    continue
  fi
  name="$(docker inspect -f '{{.Name}}' "${id}" | sed 's#^/##')"
  docker rm -f "${id}" >/dev/null
  echo "[stop] 已停 ${name}"
done
