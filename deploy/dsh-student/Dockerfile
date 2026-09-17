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
# 品牌图与品牌包（真正的字符串替换在最后一步，等所有插件都装完）
COPY assets/lingdong-ai-logo-480.png /opt/brand-plugin/logo.png
COPY brand-plugin/ /opt/brand-plugin/
# 学生端「功能」开关（输入框那一排的三个按钮：对话 / 写代码 / 做网页）。
# ⚠️ 只把目录放进镜像**不够**：它必须像品牌包那样用 `dsh plugin add` 装进 profile ——
# 否则 profile 里既没有 `node_modules/@lingdong/dsh-feature`，也没有
# `dsh.profile.bundles` 里那一条，插件根本不会被加载（装法见下面紧跟着的那一步）。
COPY feature-plugin/ /opt/feature-plugin/
COPY rebrand.mjs /opt/rebrand.mjs
COPY plugin-shims.mjs /opt/plugin-shims.mjs
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

# 品牌包安装（**必须在 PPT 那一步之前**：`dsh plugin add` 会按已装包重算
# `dsh.profile.bundles`，而 PPT 那一步最后要把 `dsh-ppt` 从 bundles 里摘掉；顺序反了就会把
# dsh-ppt 又加回去 → 与 composer 抢注册 `dsh-ppt-bundled` → 整棵插件树起不来，实测踩到）。
# 另一个连带坑：`dsh plugin add` 交给 pnpm 干，容器里没装 pnpm 时它在这里是 **exit 127**
# （和「打印提示却退出 0」那次表现不同，但一样是没装成）——所以这一步必须排在装 pnpm 之后。
RUN node /opt/brand-plugin/build.mjs /opt/brand-plugin/logo.png \
 && dsh plugin --profile web add /opt/brand-plugin \
 && node -e "const j=require(process.env.DSH_HOME+'/profiles/web/package.json');if(!j.dsh.profile.bundles.includes('@lingdong/dsh-brand'))throw new Error('品牌包没进 bundles');console.log('品牌包已进 bundles');"

# 功能开关包安装（同样**必须在 PPT 那一步之前**，理由同上：`dsh plugin add` 会重算 bundles，
# 排在 PPT 之后会把 dsh-ppt 又加回 bundles 里）。
# ⚠️ 这里是**两个都要**才生效：`dsh plugin add` 同时做两件事 ——
#   · profile 的 `dependencies` 加一条 `link:/opt/feature-plugin` → pnpm 建出
#     `node_modules/@lingdong/dsh-feature`（少了它，加载器解析这一行会失败，**整个环境起不来**）；
#   · `dsh.profile.bundles` 加一条 `@lingdong/dsh-feature`（少了它，加载器根本没有这一行）。
# 只做其中一个都是坏的，所以下面照品牌包那样断言 bundles，pnpm 侧由这行命令自己保证。
RUN dsh plugin --profile web add /opt/feature-plugin \
 && node -e "const j=require(process.env.DSH_HOME+'/profiles/web/package.json');if(!j.dsh.profile.bundles.includes('@lingdong/dsh-feature'))throw new Error('功能开关包没进 bundles');if(!j.dependencies['@lingdong/dsh-feature'])throw new Error('功能开关包没进 dependencies');console.log('功能开关包已进 bundles 与 dependencies');"

# PPT 预设：dsh-desktop 以本地 tarball 分发（npm 上没有），按 commit 固定再装。
# 走 jsDelivr 而不是 raw.githubusercontent —— 这台机器上 raw 域名实测连不上（curl 000），jsDelivr 正常。
ARG DSH_DESKTOP_SHA=aca970834bce88d2ec14ec278b368f6f0d168d0a
ARG PPT_BUNDLE=dsh-ppt-0.1.1-rc.2-desktop-20260906.tgz
ARG PPT_COMPOSER_BUNDLE=dsh-ppt-composer-0.1.1-rc.2-desktop-20260906.tgz
RUN mkdir -p /opt/ppt-bundles && cd /opt/ppt-bundles  && for f in "${PPT_BUNDLE}" "${PPT_COMPOSER_BUNDLE}"; do       for attempt in 1 2 3; do         curl -fsSL --retry 3 --retry-delay 2           "https://cdn.jsdelivr.net/gh/dataelement/dsh-desktop@${DSH_DESKTOP_SHA}/packages/ppt-bundles/${f}" -o "${f}" && break;         [ "${attempt}" = "3" ] && { echo "拉取 ${f} 失败" >&2; exit 1; };         sleep 3;       done;     done  && ln -sf "${PPT_BUNDLE}" dsh-ppt.tgz  && dsh plugin --profile web add "/opt/ppt-bundles/${PPT_BUNDLE}"  && node -e "const fs=require('fs');const p=process.env.DSH_HOME+'/profiles/web/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.pnpm={...(j.pnpm||{}),overrides:{...((j.pnpm&&j.pnpm.overrides)||{}),'dsh-ppt':'file:/opt/ppt-bundles/dsh-ppt.tgz'}};fs.writeFileSync(p,JSON.stringify(j,null,2));"  && dsh plugin --profile web add "/opt/ppt-bundles/${PPT_COMPOSER_BUNDLE}"  && node -e "const fs=require('fs');const p=process.env.DSH_HOME+'/profiles/web/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.dsh.profile.bundles=j.dsh.profile.bundles.filter((b)=>b!=='dsh-ppt');fs.writeFileSync(p,JSON.stringify(j,null,2));"  && node -e "const j=require(process.env.DSH_HOME+'/profiles/web/package.json');const b=j.dsh.profile.bundles;if(!b.includes('dsh-ppt-composer'))throw new Error('composer 没进 bundles');if(b.includes('dsh-ppt'))throw new Error('dsh-ppt 必须只当依赖、不能当 bundle（会与 composer 抢注册 dsh-ppt-bundled）');if(!(j.dependencies||{})['dsh-ppt'])throw new Error('dsh-ppt 依赖丢了');console.log('PPT bundles OK:',b.filter((x)=>x.includes('ppt')).join(','));"

# Univer 办公插件（2026-09-17）：让 dsh 里**能预览/编辑** pptx / xlsx / docx ——
# 学生用 dsh 做出了 PPT，但 dsh 自己没有 office 渲染器，界面只给一句「此文件类型不支持预览」。
# 版本：0.3.2；它声明支持 `^0.1.5-rc.1`，与我们钉的 dsh 0.1.5-rc.1 对得上；engines node>=22.19（镜像是 24.9）。
#
# ⚠️ 四条实测出来的事，别在下一轮再踩：
#   ① `dsh plugin add` 会**按已装包重算 bundles**，把 dsh-ppt 又加回 bundles —— 必须再摘一次
#      （dsh-ppt 只是依赖，进了 bundles 会与 composer 抢注册 `dsh-ppt-bundled`，整棵树起不来）。
#   ② 所以这一步必须排在**最后一条 `dsh plugin add`**（也就是上面 PPT 那一步之后）——
#      它是最后动的，bundles 的最终状态要由它自己的断言来收口（同时盯 univer 在不在、dsh-ppt 有没有回来）。
#   ③ 「PDF 打印 / 截图 / 幻灯片校验 / SVG 文字测量」**需要本机有 Chromium**。镜像里没有
#      （`/usr/bin/chromium-browser` 只是 snap 桩，`/snap/bin/chromium` 并不存在）——这几项不可用；
#      **预览与编辑本身是 Univer 在浏览器里渲染，不受影响**。
#   ④ 内存实测（宿主上真跑）：一个学生环境 RSS 从 ~258MB 涨到 ~550MB（**+~290MB**）。
#      这台 1.6GB 的机器本来就只塞得下 1-2 个学生环境，装完之后余量更紧 ——
#      要开更多学生就得先加内存，或者按需把它关掉。
RUN dsh plugin --profile web add dsh-univer-office \
 && node -e "const fs=require('fs');const p=process.env.DSH_HOME+'/profiles/web/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));if(!j.dependencies['dsh-univer-office'])throw new Error('univer 没进 dependencies');if(!j.dsh.profile.bundles.includes('dsh-univer-office'))throw new Error('univer 没进 bundles');j.dsh.profile.bundles=j.dsh.profile.bundles.filter((b)=>b!=='dsh-ppt');fs.writeFileSync(p,JSON.stringify(j,null,2));const k=JSON.parse(fs.readFileSync(p,'utf8'));if(k.dsh.profile.bundles.includes('dsh-ppt'))throw new Error('dsh-ppt 又回到 bundles 了');if(!k.dependencies['dsh-ppt'])throw new Error('dsh-ppt 依赖丢了');console.log('univer 已装；dsh-ppt 只在依赖里');"

ENV DSH_WORKSPACE=/home/student/workspace \
    DSH_COURSE_SKILLS=/etc/dsh/skills \
    DSH_PERMISSION_MODE=workspace-write \
    DSH_PATCH=/etc/dsh/student-runtime.cordis.yml \
    GATEWAY_BASE_URL=http://host.docker.internal:8789/api/gateway/v1 \
    EDGE_PORT=8080
# 品牌最后一步（**必须在所有插件装完之后**，否则第三方 bundle 里的品牌串会漏）：
# 换掉品牌串、标题、favicon、manifest；再给第三方插件打兼容性小补丁；品牌图用完就删。
RUN node /opt/rebrand.mjs /opt/brand-plugin/logo.png \
 && node /opt/plugin-shims.mjs \
 && rm -f /opt/brand-plugin/logo.png
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
