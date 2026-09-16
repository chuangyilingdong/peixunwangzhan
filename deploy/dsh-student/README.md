# 学生运行时容器（dsh = DeepSeek Harness）

一个学生一节课 = 一个这个容器的实例。容器没了，会话日志、工作区、票据一起没。

配套方案与全部踩坑记录：`docs/operations/VibeCoding改用dsh-方案-20260916.md`。

## 里面有什么

- **dsh** `@deepseek-ai/dsh@0.1.5-rc.1`（**固定版本**：官方自称会有破坏性变更，不要用 latest）
- **我们的补丁层** `student-runtime.cordis.yml`：
  - 模型路由只用**我们自己的网关**（`llm-pi-ai` 的 hand-declared gateway，凭据走 `apiKeyEnv`，密钥不进配置文件）
  - 课程技能目录（`skills/`，一个课程一个 `SKILL.md`）
  - 沙箱 `workspace-write` + 审批 `never`（**语义是「直接拒绝」**，不是自动放行），并把 `defaultPreset` 显式指到同名预设
  - 关掉给学生的成人入口：`cordis-host-runner` / `cordis-client-runner` / `ui-cordis`
    （模型能自造插件挂进宿主，官方注释说在 Web 面上沙箱与审批都会被绕过）、`plugin-inventory`（插件管理）、
    `directory-picker`、`open-in-app`
- **容器内 nginx**：dsh 只绑 `127.0.0.1` 且**拒绝** `--host 0.0.0.0`（官方理由：会把 RCE 暴露到网络），
  所以对外入口必须由容器内的这层 nginx 提供 —— 它校验我们平台的短时票据，再把请求转给 `127.0.0.1:3080`。

## 构建与运行

```bash
docker build -t dsh-student:local deploy/dsh-student

docker run --rm -p 18080:8080 \
  -e EDGE_TICKET=<平台签发的短时票据> \
  -e GATEWAY_BASE_URL=http://<我们网关>/api/gateway/v1 \
  -e PLATFORM_GATEWAY_KEY=<网关凭据> \
  dsh-student:local
# 学生从 http://<入口>/?t=<票据> 进入
```

## 入口闸门（已实测）

| 场景 | 结果 |
|---|---|
| 全新浏览器 + 票据 `?t=<票据>` | 200，真 dsh 界面（`<title>DeepSeek Harness</title>`） |
| 带着别的容器留下的旧 cookie + 票据 | 200（第一次命中就把 cookie 换成本容器的） |
| 只有旧 cookie、没有票据 | 403 |
| 既没票据也没 cookie | 403 |

## 已知待改进

1. dsh 的会话票据（`?token=`）目前是**内部 302** 补上的，浏览器地址栏会闪现一次；
   生产做法应由平台后端完成这一次交换，再把 cookie 交给浏览器（容器内 nginx 不再需要这段逻辑）。
2. `dsh_edge` cookie 的值就是平台票据；生产应换成平台签发的**按会话**cookie（并在会话结束时失效）。
3. 还没接：我们自己的 PPT/文档产物工具（dsh 没有这类工具）、以及把 `deliverables/presented`
   事件接回我们的作品提交接口。
