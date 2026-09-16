# 学生运行时容器：dsh（DeepSeek Harness）+ 我们的补丁层 + 容器内反向代理
#
# 为什么要有容器内反代：dsh 的 web 服务**只绑 127.0.0.1，并且故意拒绝 --host 0.0.0.0**
# （官方理由：那会把远程代码执行暴露到网络上）。实测：只绑回环时，Docker 的端口发布
# 从宿主根本连不上（HTTP 000）。所以「外部怎么进来」必须我们自己在容器里解决 ——
# 这层 nginx 就是入口：校验我们平台发的短时票据，再把请求转给 127.0.0.1:3080。
#
# 构建（Node 二进制在建镜像时从 nodejs.org 取，不把 30MB 压缩包放进仓库）：
#   docker build -t dsh-student:local deploy/dsh-student
FROM debian:bookworm-slim

ARG NODE_VERSION=v24.9.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils git nginx \
 && curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /opt \
 && mv "/opt/node-${NODE_VERSION}-linux-x64" /opt/node \
 && rm -f /tmp/node.tar.xz \
 && ln -s /opt/node/bin/node /usr/local/bin/node \
 && ln -s /opt/node/bin/npm /usr/local/bin/npm \
 && ln -s /opt/node/bin/npx /usr/local/bin/npx \
 && rm -rf /var/lib/apt/lists/*
ENV PATH=/opt/node/bin:$PATH
# 固定版本：dsh 自称会有破坏性变更，绝不用 latest
RUN npm config set registry https://registry.npmmirror.com \
 && npm install -g @deepseek-ai/dsh@0.1.5-rc.1

COPY student-runtime.cordis.yml /etc/dsh/student-runtime.cordis.yml
COPY skills/ /etc/dsh/skills/
COPY proxy/nginx.conf.template /etc/dsh/nginx.conf.template
COPY proxy/proxy-headers.conf /etc/dsh/proxy-headers.conf
COPY entrypoint.sh /usr/local/bin/dsh-student-entrypoint
# 入口脚本必须是 LF：带 CRLF 时容器会 exec format error（踩过一次，见方案文档第九节）。
# 仓库里用 .gitattributes 保住 LF，这里再兜一次。
RUN sed -i 's/\r$//' /usr/local/bin/dsh-student-entrypoint \
 && chmod +x /usr/local/bin/dsh-student-entrypoint

ENV DSH_HOME=/home/student/.dsh \
    DSH_WORKSPACE=/home/student/workspace \
    DSH_COURSE_SKILLS=/etc/dsh/skills \
    DSH_PERMISSION_MODE=workspace-write \
    DSH_PATCH=/etc/dsh/student-runtime.cordis.yml \
    GATEWAY_BASE_URL=http://host.docker.internal:8789/api/gateway/v1 \
    EDGE_PORT=8080
# dsh 只认 127.0.0.1；对外暴露的是容器内 nginx 的 EDGE_PORT
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/dsh-student-entrypoint"]
