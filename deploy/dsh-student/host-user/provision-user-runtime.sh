#!/usr/bin/env bash
# 宿主机装配（同机独立用户版）：把「学生创作环境」需要的东西一次装齐。
#
# 输入：学生运行时镜像里的那份运行时（node + dsh + 烤好的插件 profile）。
#   · 若机器上已有镜像：直接从镜像里提取（无需重装依赖，插件的符号链接也能保住）；
#   · 若给了 tar 包：docker load 后再提取。
#
# 装完的布局（与容器里**同一套绝对路径**，少一处不一致就少一个坑）：
#   /opt/dsh-runtime/opt/node            运行时（node + dsh 全局包）
#   /opt/dsh-runtime/opt/brand-plugin    品牌包（profile 里有指向它的绝对符号链接）
#   /opt/dsh-runtime/home/student/.dsh   烤好的 profile（含全部插件）—— 共享只读模板
#   /opt/dsh-runtime/etc/dsh             补丁层与课程技能
#   /opt/brand-plugin -> /opt/dsh-runtime/opt/brand-plugin   （补上镜像里的绝对路径）
#   /etc/nginx/dsh-students/            每个学生一条 server 块（开课时生成、停课时删）
#   /etc/nginx/dsh-proxy-headers.conf   dsh 的转发头（含 WebSocket 升级与 SSE）
#   /srv/dsh-runtime/logs/              每个学生一份启动日志
#
# 用法（root）：bash provision-user-runtime.sh [镜像标签或 tar 包路径]
set -Eeuo pipefail

IMAGE_OR_TAR="${1:-dsh-student:local}"
RUNTIME_ROOT="/opt/dsh-runtime"
log() { echo "[provision-user] $*"; }
die() { echo "[provision-user] $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "要用 root 跑"

# ① 拿到镜像：给了 tar 就导入，给了标签就检查在不在
case "${IMAGE_OR_TAR}" in
  *.tar|*.tgz|*.tar.gz)
    [ -f "${IMAGE_OR_TAR}" ] || die "找不到镜像包：${IMAGE_OR_TAR}"
    log "导入镜像 ${IMAGE_OR_TAR}"
    docker load -i "${IMAGE_OR_TAR}"
    IMAGE_OR_TAR="dsh-student:local"
    ;;
esac
command -v docker >/dev/null 2>&1 || die "这台机器上没有 docker（提取运行时需要它；装完运行时本身不再依赖 docker）"
docker image inspect "${IMAGE_OR_TAR}" >/dev/null 2>&1 || die "镜像 ${IMAGE_OR_TAR} 不在本机"

# ② 从镜像里提取运行时（用 tar 流：docker cp 遇到指向 /opt/brand-plugin 的绝对符号链接会拒收）
log "从镜像提取运行时到 ${RUNTIME_ROOT}"
mkdir -p "${RUNTIME_ROOT}"
docker run --rm --entrypoint tar "${IMAGE_OR_TAR}" \
  -C / -cf - opt/node opt/brand-plugin home/student/.dsh etc/dsh \
  | tar -C "${RUNTIME_ROOT}" -xf -
# 补上镜像里的绝对路径（profile 里 @lingdong/dsh-brand 指向它）
ln -sfn "${RUNTIME_ROOT}/opt/brand-plugin" /opt/brand-plugin
# 镜像里没装 bubblewrap，所以 dsh 只能跑到较弱那档 Landlock；这里补装，
# 让内核沙箱尽量往强的那档走（外层靠用户隔离，内层再加一层写保护）。
if ! command -v bwrap >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y --no-install-recommends bubblewrap >/dev/null 2>&1 || log "⚠️ bubblewrap 没装上（不影响主流程）"
fi

# ③ 共享模板对所有学生可读（可执行位也要），学生只读不写
chmod -R a+rX "${RUNTIME_ROOT}"

# ④ 目录与 nginx 片段
mkdir -p /etc/nginx/dsh-students /srv/dsh-runtime/logs
# ⚠️ 占位文件不能省：nginx 的 include 通配符**匹配不到任何文件会直接报错**
# （`open() "/etc/nginx/dsh-students/*.conf" failed`），一个学生都没开时机器就起不来了。
# 放一个只有注释的 .conf 占位，让学生入口目录永远非空。
cat > /etc/nginx/dsh-students/README.conf <<'EOF'
# 这个目录里是**每个学生一条** server 块（开课时由 run-student-user.sh 生成，停课时删）。
# 本文件只是占位：nginx 的 include 通配符匹配不到文件会直接报错，所以这里必须留一个 .conf。
EOF
cat > /etc/nginx/dsh-proxy-headers.conf <<'EOF'
# dsh 转发的公共头：WebSocket 升级（界面靠它）+ 流式不缓冲 + 长连接
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
EOF

# ⑤ nginx 主配置里 include 学生入口目录（只加一次）
MAIN_CONF=/etc/nginx/nginx.conf
if ! grep -q "dsh-students" "${MAIN_CONF}"; then
  cp "${MAIN_CONF}" "/root/nginx.conf.bak-dsh-$(date +%s)"
  sed -i "s#^\s*include /etc/nginx/conf.d/\*\.conf;#&\n\tinclude /etc/nginx/dsh-students/*.conf;#" "${MAIN_CONF}"
  grep -q "dsh-students" "${MAIN_CONF}" || die "没能在 nginx.conf 里加上 include，请人工加一行：include /etc/nginx/dsh-students/*.conf;"
  log "已在 ${MAIN_CONF} 加上学生入口的 include"
fi
nginx -t || die "nginx 配置校验失败"
systemctl reload nginx

log "装完了。校验："
log "  运行时：$([ -x ${RUNTIME_ROOT}/opt/node/bin/node ] && echo OK || echo 缺失)"
log "  模板：$([ -d ${RUNTIME_ROOT}/home/student/.dsh/profiles/web ] && echo OK || echo 缺失)"
log "  补丁层：$([ -f ${RUNTIME_ROOT}/etc/dsh/student-runtime.cordis.yml ] && echo OK || echo 缺失)"
log "  学生入口目录：/etc/nginx/dsh-students（nginx 已 include）"
log ""
log "下一步：把 host-user/ 下的 run/stop 脚本放到 /opt/dsh-host-user/，"
log "  并给平台账号一条**窄的 sudoers 规则**（只允许跑这两个脚本），"
log "  或者把 platform 进程加入 docker 组 —— 二选一，见 README。"
