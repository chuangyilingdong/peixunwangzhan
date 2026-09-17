#!/usr/bin/env bash
# 回收**闲置**的学生环境（同机独立用户版，2026-09-16）
#
# 为什么需要它：平台那侧已经接了「课堂结束 / 解散 / 把学生移出名单」三条收尾（orgAdmin.js
# 的 releaseSessionRuntimes），但有个空档 —— **课堂还在上、学生却早就不用了**
# （关掉页面、去干别的、或者只是进来瞅一眼）：这时没有任何触发点，那个 486MB 的常驻进程
# 会一直挂到课堂结束。用户口径是「要支持很多人」，所以占用必须跟「这一刻真在干活的人」有关。
#
# 两类回收：
#   ① 闲置：单元还在跑，但最近这段时间几乎没消耗 CPU（拿 cgroup 的 CPUUsageNSec 做差分）；
#   ② 兜底：跑了超过 MAX_AGE_MINUTES（学生没关页面、老师也没结束课堂）。
# 另外顺手清掉「进程没了、入口配置还留着」的残留。
#
# ⚠️ 判据为什么用 CPU 而不是 mtime：学生**开着页面不用**时，dsh 的日志与工作区都不会变，
#    看 mtime 会把「挂着没用的」当成「刚用过」；而 CPU 是单调计数器，差分最诚实。
#    也不能只看「有没有连接」——WebSocket 会一直连着，人不在也连着。
#
# 用法：
#   DRY_RUN=1 bash reap-idle-user.sh        # 只看会收谁，不动手
#   bash reap-idle-user.sh
# 建议交给 systemd timer（每 5 分钟）：见同目录 dsh-host-reap.service / .timer
set -Eeuo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-0}"         # 0 = **不做闲置回收**（默认，见下面的口径说明）
MAX_AGE_MINUTES="${MAX_AGE_MINUTES:-720}" # 纯兜底：跑满 12 小时才收，防平台侧漏收造成的泄漏
CPU_IDLE_PERCENT="${CPU_IDLE_PERCENT:-1}" # 这段 CPU 占比低于这个数就算闲置（仅在 IDLE_MINUTES>0 时生效）
STATE_DIR="${STATE_DIR:-/srv/dsh-runtime/.reap}"
STOP_SCRIPT="${STOP_SCRIPT:-/opt/dsh-host-user/stop-student-user.sh}"
DRY_RUN="${DRY_RUN:-0}"
NOW="$(date +%s)"

mkdir -p "${STATE_DIR}"
mapfile -t units < <(systemctl list-units --all --plain --no-legend 'dsh-student-*' 2>/dev/null | awk '{print $1}')

if [ "${#units[@]}" = "0" ]; then
  echo "[reap] $(date -Is) 没有学生环境"
  exit 0
fi

reaped=0
for unit in "${units[@]}"; do
  # ⚠️ list-units 给的是**带 .service 后缀**的单元名，而用户名（也等于入口配置名）没有后缀。
  #    这里必须剥掉，否则 conf 路径与 stop 调用的 --name 全错 —— 症状是「一声不响什么都没收」
  #    （2026-09-16 实测踩到的：脚本跑完只打一行汇总，一个都没收）。
  user="${unit#dsh-student-}"
  user="${user%.service}"
  case "${user}" in dshs-*) ;; *) continue ;; esac

  active="$(systemctl is-active "${unit}" 2>/dev/null || true)"
  conf="/etc/nginx/dsh-students/${user}.conf"

  # 进程没在跑：把残留的入口配置清掉（否则下次复用会读到一个过期的端口）
  if [ "${active}" != "active" ]; then
    if [ -f "${conf}" ]; then
      if [ "${DRY_RUN}" = "1" ]; then
        echo "[reap] ${user} 进程不在但入口还在 → 应清配置（dry-run，没清）"
      else
        echo "[reap] ${user} 进程不在但入口还在 → 清配置"
        rm -f "${conf}"
        systemctl reload nginx
      fi
    fi
    rm -f "${STATE_DIR}/${user}.cpu"
    continue
  fi

  started="$(systemctl show "${unit}" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo 0)"
  if [ "${started:-0}" -le 0 ] 2>/dev/null; then continue; fi
  now_us="$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)"
  age_minutes=$(( (now_us - started) / 1000000 / 60 ))

  cpu_ns="$(systemctl show "${unit}" -p CPUUsageNSec --value 2>/dev/null || echo 0)"
  [ "${cpu_ns:-0}" -gt 0 ] 2>/dev/null || cpu_ns=0
  state="${STATE_DIR}/${user}.cpu"
  prev_line="$(cat "${state}" 2>/dev/null || true)"
  printf '%s %s\n' "${cpu_ns}" "${NOW}" > "${state}"

  if [ "${age_minutes}" -ge "${MAX_AGE_MINUTES}" ]; then
    echo "[reap] ${user} 跑了 ${age_minutes} 分钟 ≥ ${MAX_AGE_MINUTES} → 收（兜底）"
  elif [ "${IDLE_MINUTES}" -le 0 ]; then
    # 闲置回收被关掉了 —— **这是默认**。理由（2026-09-17 用户口径「点一下就是秒进」）：
    # 秒进的唯一充要条件是「点下去那一刻环境已经在跑」（在跑 → 复用 0.07 秒；没在跑 → 冷启动 17.9 秒）。
    # 而闲置回收恰好破坏这一点：学生上课中途停用 20 分钟，回来就要重新等。
    # 所以：课堂进行中的环境**一直留着**（秒进），回收交给平台那侧「课堂结束/解散/移出学生」，
    # 这里只做防泄漏的兜底。要省内存就把 IDLE_MINUTES 设成正数（代价是偶尔要等冷启动）。
    continue
  else
    [ -n "${prev_line}" ] || continue          # 第一次见到它，先记一笔，下轮再判
    prev_cpu="${prev_line%% *}"; prev_at="${prev_line##* }"
    elapsed=$(( NOW - prev_at ))
    [ "${elapsed}" -ge 60 ] || continue        # 两次间隔太短不足以判断
    [ "${age_minutes}" -ge "${IDLE_MINUTES}" ] || continue
    delta_ns=$(( cpu_ns - prev_cpu ))
    [ "${delta_ns}" -lt 0 ] && delta_ns=0
    # CPU 占比（%）= 这段 CPU 时间 / 这段墙钟时间；整数运算，先乘后除避免截断成 0。
    # 例：elapsed=300s、CPU_IDLE_PERCENT=1 → 阈值 3 秒 CPU —— 5 分钟里连 3 秒都没用到，就是没人用。
    used_percent=$(( delta_ns * 100 / (elapsed * 1000000000) ))
    if [ "${used_percent}" -lt "${CPU_IDLE_PERCENT}" ]; then
      echo "[reap] ${user} 跑了 ${age_minutes} 分钟，近 ${elapsed}s 内 CPU ${used_percent}% < ${CPU_IDLE_PERCENT}% → 收（闲置）"
    else
      continue
    fi
  fi

  if [ "${DRY_RUN}" = "1" ]; then
    echo "[reap] （dry-run，没收）"
  else
    if bash "${STOP_SCRIPT}" --name "${user}" >/dev/null 2>&1; then
      echo "[reap] 已收 ${user}"
      reaped=$(( reaped + 1 ))
    else
      echo "[reap] ⚠️ 收 ${user} 失败（下一轮再试）" >&2
    fi
  fi
done

echo "[reap] $(date -Is) 本轮收了 ${reaped} 个（候选单元 ${#units[@]} 个，DRY_RUN=${DRY_RUN}）"
