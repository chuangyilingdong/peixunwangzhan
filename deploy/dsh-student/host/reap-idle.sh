#!/usr/bin/env bash
# 回收学生容器。
#
# 两类回收：
#   ① 到年龄的：学生没关页面、老师也没结束课堂，容器一直挂在那儿 —— 按 MAX_AGE_MINUTES 兜底；
#   ② 已经死透的：dsh 崩了、入口没了，容器还在（--rm 没加，留着是为了能看日志），一起清掉。
#
# 建议加 cron（每 5 分钟）：
#   */5 * * * * root MAX_AGE_MINUTES=180 bash /srv/dsh-runtime/reap-idle.sh >> /srv/dsh-runtime/logs/reap.log 2>&1
#
# 注意：**课堂结束时的即时回收在平台那侧**（平台知道课堂什么时候结束），
# 这个脚本是兜底，不是主路径 —— 只靠它就等于「学生下课 3 小时后容器才没」。
set -Eeuo pipefail

MAX_AGE_MINUTES="${MAX_AGE_MINUTES:-180}"
DRY_RUN="${DRY_RUN:-0}"
NOW="$(date +%s)"

mapfile -t ids < <(docker ps -aq --filter label=dsh.runtime=student)
if [ "${#ids[@]}" = "0" ]; then
  echo "[reap] $(date -Is) 没有学生容器"
  exit 0
fi

for id in "${ids[@]}"; do
  name="$(docker inspect -f '{{.Name}}' "${id}" | sed 's#^/##')"
  state="$(docker inspect -f '{{.State.Status}}' "${id}")"
  # docker 报的是 UTC（...Z），**别把 Z 截掉**：截掉之后 date 会当成当地时间，
  # 东八区下每个容器都"已经跑了 8 小时"，第一个 cron 周期就把学生全踢了（实测踩到）。
  started="$(docker inspect -f '{{.State.StartedAt}}' "${id}" | sed -E 's/\.[0-9]+//')"
  started_epoch="$(date -d "${started}" +%s 2>/dev/null || echo "${NOW}")"
  age_minutes=$(( (NOW - started_epoch) / 60 ))
  session="$(docker inspect -f '{{index .Config.Labels "dsh.session"}}' "${id}")"

  if [ "${state}" != "running" ]; then
    echo "[reap] ${name}（课堂 ${session}）状态 ${state} → 删"
    [ "${DRY_RUN}" = "1" ] || docker rm -f "${id}" >/dev/null
    continue
  fi
  if [ "${age_minutes}" -ge "${MAX_AGE_MINUTES}" ]; then
    echo "[reap] ${name}（课堂 ${session}）已跑 ${age_minutes} 分钟 ≥ ${MAX_AGE_MINUTES} → 删"
    [ "${DRY_RUN}" = "1" ] || docker rm -f "${id}" >/dev/null
    continue
  fi
  echo "[reap] ${name}（课堂 ${session}）跑了 ${age_minutes} 分钟，留着"
done
