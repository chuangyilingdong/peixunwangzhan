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

ENV DSH_HOME=/home/student/.dsh
# ---------------------------------------------------------------------------
# 社区插件 + dsh-desktop 的 PPT 预设（用户指定；**全部固定版本**，不用 latest）
#
# `dsh plugin` 是个 pnpm 转发器，所以容器里要先有 pnpm。
# 装进来的东西按用途分三类，注意它们与「给孩子用」的取舍见 README：
#   · 界面/易用：dsh-better-sidebar（侧边栏底座：文件/终端/侧边对话/Git/子代理页面）
#                dsh-at-file（@ 引用工作区文件）、dsh-context（上下文用量与压缩）
#                @linxin666/dsh-web-all（聚合：任务板/Git 图/远程 Web UI/皮肤/宠物…）
#   · 能力：@liustack/modlens（视觉桥：让纯文本模型读图，需视觉渠道凭据）
#            dsh-find-plugin（让模型自己去 GitHub 找插件）
#   · 产物：dsh-desktop 的 dsh-ppt + dsh-ppt-composer（可编辑 PPTD + 本地生成 PPTX）
# ---------------------------------------------------------------------------
# ⚠️ 关键：`dsh plugin` 是 pnpm 转发器，PATH 上没有 pnpm 时它会**打印一行提示然后照样退出 0**
# （实测踩到：插件一个没装，构建却"成功"）。所以这里显式装 pnpm，并且装完必须**断言**真的进了 profile。
RUN npm install -g pnpm@10.17.0  && command -v pnpm  && npm config set registry https://registry.npmmirror.com  && dsh plugin --profile web add       "dsh-better-sidebar@${SIDEBAR_VERSION}"       "dsh-find-plugin@${FIND_PLUGIN_VERSION}"       "@liustack/modlens@${MODLENS_VERSION}"       "dsh-at-file@${AT_FILE_VERSION}"       "dsh-context@${CONTEXT_VERSION}"       "@linxin666/dsh-web-all@${DSH_WEB_ALL_VERSION}"  && for pkg in dsh-better-sidebar dsh-find-plugin @liustack/modlens dsh-at-file dsh-context @linxin666/dsh-web-all; do       grep -q "\"$pkg\"" "$DSH_HOME/profiles/web/package.json" || { echo "插件 $pkg 没有装进 profile" >&2; exit 1; };     done

# PPT 预设：dsh-desktop 以本地 tarball 分发（npm 上没有），按 commit 固定再装。
# 走 jsDelivr 而不是 raw.githubusercontent —— 这台机器上 raw 域名实测连不上（curl 000），jsDelivr 正常。
ARG DSH_DESKTOP_SHA=aca970834bce88d2ec14ec278b368f6f0d168d0a
ARG PPT_BUNDLE=dsh-ppt-0.1.1-rc.2-desktop-20260906.tgz
ARG PPT_COMPOSER_BUNDLE=dsh-ppt-composer-0.1.1-rc.2-desktop-20260906.tgz
RUN mkdir -p /opt/ppt-bundles && cd /opt/ppt-bundles  && for f in "${PPT_BUNDLE}" "${PPT_COMPOSER_BUNDLE}"; do       for attempt in 1 2 3; do         curl -fsSL --retry 3 --retry-delay 2           "https://cdn.jsdelivr.net/gh/dataelement/dsh-desktop@${DSH_DESKTOP_SHA}/packages/ppt-bundles/${f}" -o "${f}" && break;         [ "${attempt}" = "3" ] && { echo "拉取 ${f} 失败" >&2; exit 1; };         sleep 3;       done;     done  && ln -sf "${PPT_BUNDLE}" dsh-ppt.tgz  && dsh plugin --profile web add "/opt/ppt-bundles/${PPT_BUNDLE}"  && node -e "const fs=require('fs');const p=process.env.DSH_HOME+'/profiles/web/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.pnpm={...(j.pnpm||{}),overrides:{...((j.pnpm&&j.pnpm.overrides)||{}),'dsh-ppt':'file:/opt/ppt-bundles/dsh-ppt.tgz'}};fs.writeFileSync(p,JSON.stringify(j,null,2));"  && dsh plugin --profile web add "/opt/ppt-bundles/${PPT_COMPOSER_BUNDLE}"  && node -e "const fs=require('fs');const p=process.env.DSH_HOME+'/profiles/web/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.dsh.profile.bundles=j.dsh.profile.bundles.filter((b)=>b!=='dsh-ppt');fs.writeFileSync(p,JSON.stringify(j,null,2));"  && node -e "const j=require(process.env.DSH_HOME+'/profiles/web/package.json');const b=j.dsh.profile.bundles;if(!b.includes('dsh-ppt-composer'))throw new Error('composer 没进 bundles');if(b.includes('dsh-ppt'))throw new Error('dsh-ppt 必须只当依赖、不能当 bundle（会与 composer 抢注册 dsh-ppt-bundled）');if(!(j.dependencies||{})['dsh-ppt'])throw new Error('dsh-ppt 依赖丢了');console.log('PPT bundles OK:',b.filter((x)=>x.includes('ppt')).join(','));"

ENV DSH_WORKSPACE=/home/student/workspace \
    DSH_COURSE_SKILLS=/etc/dsh/skills \
    DSH_PERMISSION_MODE=workspace-write \
    DSH_PATCH=/etc/dsh/student-runtime.cordis.yml \
    GATEWAY_BASE_URL=http://host.docker.internal:8789/api/gateway/v1 \
    EDGE_PORT=8080
# 工作目录 + 预置「开发者内测声明已读」
# 那个弹窗是 DSH 面向 Harness 开发者的公告（客户端读 ui-onboarding.welcomeNoticeVersion
# 与服务端公告版本比较，不相等就弹），孩子不该看到，而且它会挡住界面（实测不点「继续」就用不了）。
# 值取自 dsh 自己的常量 "2026-08-13.1"（在 dsh-client-ui-settings-models/lib/client.js 里）。
RUN mkdir -p /home/student/.dsh /home/student/workspace \
 && printf 'ui-onboarding:\n  welcomeNoticeVersion: "2026-08-13.1"\n' > /home/student/.dsh/settings.yaml \
 && cat /home/student/.dsh/settings.yaml
WORKDIR /home/student/workspace
# dsh 只认 127.0.0.1；对外暴露的是容器内 nginx 的 EDGE_PORT
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/dsh-student-entrypoint"]
