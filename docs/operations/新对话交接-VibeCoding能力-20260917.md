# 新对话交接 · 继续修 bug 与 VibeCoding 能力（2026-09-17）

> 时点交接，不是口径源。领域口径以 `docs/README.md` 为准。
> 上一份交接：`docs/operations/新对话交接-继续修bug-20260916.md`（第六、七轮的界面实检与 7 条口径）。
> 本轮（第七轮之后，2026-09-16 晚 → 09-17）集中攻的是 **VibeCoding 课堂的 AI 链路**。

## 一、现状基线

```text
分支：feature/vibecoding-ppt-quality-20260915
本地/生产 HEAD：9e8121d（已推送；87fd3ed 是最后一个需要发版的提交）
生产 release：20260917T025334Z（commit 87fd3ed；服务 active / NRestarts=0 / health OK）
宿主：/opt/dsh-host-user（5 个脚本 + broker + reap-idle-user.sh）
       学生环境：跑着 1 个（dshs-4841e652e5，端口 18201）
回滚：上一版 release 20260917T025126Z / 再上一版 20260917T025334Z 之前各有整库备份
nginx：/etc/nginx/sites-enabled/iicili.cyou 已打两条补丁（网关 600s、launch 180s），
       备份都在 /etc/nginx/backups/（**别放回 sites-enabled**，会被当配置加载）
全量守卫：114 个，当前 114/114
```

## 二、下一轮的第一件事（用户已说「开始」，我没开写）

**把 dsh 的网页搜索接到我们的网关上。** 我查清了做法，也发现原设想是错的，结论如下：

- 报错：`DeepSeek search has no API key for "DEEPSEEK_API_KEY"`。
- 插件在 `@deepseek-ai/dsh-web-search-deepseek/lib/index.js`，它调的**不是搜索接口**，而是
  **Anthropic 协议的 Messages 接口**：`const endpoint = \`${options.baseURL}/messages\``。
  搜索是「模型一跳里的服务端 web_search 工具」。DeepSeek 官方 base 是
  `https://api.deepseek.com/anthropic/v1`。
- 所以要做的是**给网关加一条 Anthropic 协议透传**（不是加搜索端点）：
  1. 宿主 `run-student-user.sh` 注入 `DEEPSEEK_SEARCH_BASE_URL=<我们的网关>/search`
     与 `DEEPSEEK_API_KEY=<本次运行时密钥>`（插件认这两个环境变量，源码里写死的）；
  2. 网关加 `POST /api/gateway/search/messages`：**不翻译协议**（Anthropic 进、Anthropic 出），
     只做三件事 —— 验运行时密钥（复用现有 `verifyRuntimeKey`；注意插件发的是
     `x-api-key` 和/或 `authorization: Bearer`，两种都要读）、过门禁
     （`assertRuntimeClassroomActive`）、**换成真密钥转发**到 `api.deepseek.com/anthropic/v1/messages`，
     然后把 SSE 原样回吐；
  3. 真密钥从平台已有的渠道配置取（聊天那条路已有一套「渠道 → 真密钥」解析，复用同一处）；
  4. 记账：Anthropic 响应带 `usage.input_tokens/output_tokens`，照聊天那条路记。
- **为什么必须走网关**：密钥一旦导出到学生环境，学生能从自己的进程里读出来，
  既泄漏又能绕过账本花钱。走网关则学生只拿短时运行时密钥。
- ⚠️ 备选方案「在启动环境里导出 DEEPSEEK_API_KEY」**不要做**，除非用户愿意单独申请一个限额的搜索专用 key。

## 三、「秒进」这件事：用户说**不是他要的结果**，得重做

用户诉求原话：「学生点击这个按钮就是秒进」「有没有可能彻底解决，而不是提醒」。

我的做法（**已被用户否掉**，别再重复）：
- 开始上课时预热环境 → 点击走复用（0.07 秒）；
- **把闲置回收关掉了**（`IDLE_MINUTES=0`，课堂进行中的环境一直留着）；
- 前端加了计时与超时提示。

用户回的是「这些都不是我想要的结果，后面再说吧」。所以**下一轮要重新想**，我的理解与待确认点：
- 秒进的充要条件是「点下去那一刻环境已经在跑」（在跑→复用 0.07s；没在跑→冷启动 17.9s，
  这是 dsh 进程自身启动时间，代码改不了）。所以「不提醒、不等待」的秒进，要么
  **环境常驻**（每学生约 490MB），要么**换掉/per-student 进程这个形态**。
- 用户此前明确说过两条，可作为重新设计的约束：
  ① 「肯定是根据他输入的提示词发送之后，才决定要不要调用更大的能力」（按需）；
  ② 「不配 DNS」——但**端口池已放宽到 400（18201-18600）**，不需要 DNS；
     要注意的只是安全组要放行这一段（用户侧操作）。
- 用户也明确**不要**「替 dsh 决定用什么能力」的干涉；能力决策全归 dsh。

## 四、本轮已经修好并上线的（都在生产）

按时间顺序，全部已推送、已发版（除标注）：

| commit | 内容 |
|---|---|
| `9741266` | **课堂结束/解散/移出学生时收掉学生环境**（以前 `/runtime/stop` 前端从没调用过，环境永驻） |
| `9e6830b` | **闲置回收**（宿主 reap-idle + systemd timer；⚠️ 现已被 87fd3ed 改成默认关闭） |
| `be42ddc` | 开始上课**预热**环境 + 端口池 20→400 + 冷启动等 token 粒度 1s→0.2s |
| `812991b` | **打通网关的 tools / tool_calls**（详见下节，这是本轮最大的一件事） |
| `949479e` | 消息截断不再切开「工具调用↔工具结果」+ nginx 给 `^/api/gateway/` 放宽到 600s |
| `6d234d9` | 修「卡在正在开环境」：并发加锁串行化 + `reset-failed` + 入口丢失可自愈 |
| `3b1e0c1` | 前端：忙状态跨刷新（sessionStorage）+ launch 超时 + 计时显示 |
| `87fd3ed` | 闲置回收默认关闭（`IDLE_MINUTES=0`，只留 12h 防泄漏）+ 预热改 3 个一批并发 |
| `9e8121d` | 守卫 p105 跟着改成钉「有上限的并发」 |

## 五、网关 tools 打通（**本轮最重要的修复，别回退**）

**症状**：AI 回「我来查一下资料」然后**停下**；更早还表现为正文里出现 DSML 标记。
**根因**（dsh 迁移那轮带进来的，不是这轮弄坏的）：我们的 OpenAI 兼容网关只实现了协议的**文本那半**：
1. 请求侧 `normalizeMessages` 只留 `{role, content}` → `tools` / `tool_calls` / `tool_call_id` 全丢，
   且过滤条件要求 content 非空 → **「只有工具调用」的 assistant 消息被整条筛掉**；
2. 渠道模板没有 tools 占位符 → tools 进不了上游请求体；
3. 响应侧只读 `delta.content`，而带 tool_calls 的分片通常没有 content → `if (!delta) continue` 丢掉；
4. 「没有正文」被判「响应格式无效」。

**改法**（`routes/runtimeGateway.js` + `services/openaiCompatibleProvider.js`）：
保留工具字段、放过工具消息、`requestBody` 在**模板渲染后**挂 tools/toolChoice、
`generateStream` 新增 `onToolCalls`（**单独取** `delta.tool_calls`）、`finish_reason` 给 `tool_calls`。
**验证方式**：`/tmp/verify-tools.mjs`（我写在服务器上，从平台进程读环境 + 用 `issueRuntimeKey` 签真密钥
+ 发一条必须用工具的请求）→ 返回 11 个 tool_calls 分片。**这是唯一能证明它活着的方法**。

**产物**：`services/dsmlFilter.js`（上一轮加的兜底，把模型写进正文的 DSML 标记摘掉；保留）。

## 六、踩过的坑（这轮特别多，写下来免得再踩）

1. **`pkill -f <路径>` 会杀掉自己**：ssh 那条命令的 cmdline 里也含那个字符串 → 用 `^bash /opt/...` 锚定。
2. **`systemd-run --unit=` 报 already loaded**：单元 failed/inactive 但**仍 loaded** 时也会报 →
   起之前补 `systemctl reset-failed`。
3. **`systemctl list-units` 给的单元名带 `.service`**：被我当用户名用 → conf 路径与 `--name` 全错，
   症状是「一声不响一个都没收」。
4. **timer 用 `OnUnitActiveSec` 对 oneshot 排不出下一次**（`NEXT` 为空）→ 用 `OnCalendar=*:0/5`。
5. **未加引号的 heredoc 里不能出现反引号**（会被当命令替换执行）；更坑的是我「解释这个坑」的注释
   又写了一遍那个符号，于是再踩一次。
6. **变量声明必须放在两个分支之前**：我把 `tools` 声明在流式分支里，非流式那条路踩 TDZ → 500，
   **被 p97 当场抓住**。
7. **nginx 默认 `proxy_read_timeout` 是 60s**：`location /api/` 没写就吃默认值。这条坑踩了两次
   （`/runtime/launch`、`/api/gateway/`），症状都是 504 且**请求没到应用**（账本里连失败记录都没有）。
8. **消息截断要保工具配对**：agent 干活时历史全是成对消息，`slice(-40)` 从中间切 → 上游直接拒。
9. **前端「一个请求一直挂着」+ 学生刷新** = 并发重开环境互撞：忙状态必须跨刷新（sessionStorage）。
10. **`database is locked` 是守卫套件的偶发抖动**（p14/p33/p51 撞过，单跑必过）；
    `.tmp/run-all-guards.cjs` 已改成自动重试并标 `✓↻`。

## 七、还欠着的（按优先级）

1. **Anthropic 透传**（第二节）——用户已说「开始」，下一轮第一件事。
2. **「秒进」重做**（第三节）——用户否掉了我的方案，要先问清他要的形态。
3. **多机放置**：平台仍只认**一个**宿主（一个 broker socket），加机器用不上第 2 台。
   设计已写在 `docs/architecture/多学生并发-扩容设计.md`（阶段 0/1 已部分落地：容量闸门、端口池 400）。
   DNS 那条用户明确不配 → 走端口方案（安全组要放行 18201-18600）。
4. **文件安全扫描口径**（老问题，未定）：生产 clamscan 每次加载 108MB 库、峰值 618MB，
   机器 1607MB，会把上传拖进 swap。建议「把扫描从提交挪到发布」。
5. **`/candidates` 的 N+1**（课堂「添加学员」）：一次返回本机构全部学员、每人 3-4 条 SQL、无分页无 search。
6. 学生看不到自己未发布的作品；dsh 的工作区预选没做；生产库里有 3 条我造的验收记录（标题带「可删」）。

## 八、口径对照（**别把这些当 bug 改回去**）

| 现象 | 为什么 |
|---|---|
| 两种都开的课时，画布 + VibeCoding 两个入口都亮 | 第七轮口径变更：入口按**课时已发布的类型**放行，课堂单值不再有门禁作用（守卫 p104 钉住，含反例） |
| 老师创建课堂时「课堂模式」是只读的 | 上课类型由平台在课时里定，老师不选 |
| 「课时正文 / 教学指引」没有了 | 只删 UI；字段仍被 VibeCoding 的「编程任务」入口与 AI 系统提示词用着 |
| 静默/报错都不出现的「卡住」 | 本项目最主要的 bug 类型：**不报错、只表现为卡住**。修的时候顺手补「失败要说清楚」 |
| 登录名只允许英文数字、同机构同角色不能重名、授权跟合同日期走 | 第五轮用户口径（详见 `产品口径调整-20260916.md`） |
