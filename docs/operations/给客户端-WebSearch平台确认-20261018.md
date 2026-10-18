# 给客户端：WebSearch 接入的平台侧确认（2026-10-18）

> 对应 `给平台-客户端WebSearch接入-20261018.md` 的 8 项。**结论：8 项全部确认，其中 7 项平台已就绪，
> 1 项（可选的能力开关）平台也顺手加了。** 下面分「平台已确认」与「客户端需要做的」两块。

## 一、平台已确认（8 项逐条）

| # | 你们的确认项 | 平台结论 |
| --- | --- | --- |
| 1 | `/api/gateway/v1/search/messages` 对课堂运行时 key 开放 | ✅ 开放（只接 POST；验签 `verifyRuntimeKey` + 门禁 `assertRuntimeClassroomActive`） |
| 2 | `x-api-key` 与 `Authorization: Bearer` 都接受 | ✅ 都接受（`x-api-key` 优先；两样同值时无影响） |
| 3 | 课堂门禁 + 允许学生内容外发 | ✅ 门禁沿用；且"学生内容外发"是一道**显式开关** `allowStudentExternalContent`（**生产当前为 true**）。关掉时返回 `403 permission_error` + `code: STUDENT_EXTERNAL_AI_BLOCKED` |
| 4 | 搜索渠道/模型支持 web_search | ✅ 生产 TEXT 渠道 = DeepSeek（`deepseek-flash`），`searchChannelSelection(policy,'')` 就是它；**实测该模型能返回真实搜索结果**（10 条） |
| 5 | `web_search_20260209` 是否可用 | ✅ 可用（平台原样透传，不认死版本）；`web_search_20250305` 同样可用 |
| 6 | 响应保留 `web_search_tool_result.content[].url/title/page_age` 与 `usage.server_tool_use.web_search_requests` | ✅ 原样透传（不套 `{success,data}`）。⚠️ **`page_age` 字段在、但 DeepSeek 恒给 `null`**；`content` 里会多一个 `encrypted_content`（忽略即可） |
| 7 | 错误保持 Anthropic `{type:"error", error:{...}}` | ✅ **已全是 Anthropic 形**（原来上游错误是原样回吐的，而 DeepSeek 的 anthropic 口报错返回 OpenAI 形 —— 这轮已归一，见下） |
| 8 | 可选：`client-context` 加 `gateway.searchUrl` / `features.webSearch` | ✅ **已加**（向后兼容；课堂内 `features.webSearch=true`，备课/无课堂为 `false`） |

## 二、本轮平台改了什么（你们会看到的差异）

1. **错误体新增 `error.code`**（稳定机器码）——不用再靠中文文案匹配。当前会出现的码：

   | code | 含义 | 建议客户端动作 |
   | --- | --- | --- |
   | `RUNTIME_KEY_EXPIRED` / `RUNTIME_KEY_INVALID` | 运行时密钥过期/无效（HTTP 401） | **刷新 key 后重试一次**（你们已实现） |
   | `RUNTIME_CLASSROOM_INACTIVE` / `RUNTIME_CLASSROOM_UNAVAILABLE` / `RUNTIME_STUDENT_NOT_ACTIVE` | 课堂结束/学生不在名单（HTTP 403） | 提示用户，不要重试 |
   | `STUDENT_EXTERNAL_AI_BLOCKED` | 机构禁用了"学生内容外发"（HTTP 403） | 提示"搜索不可用"，不要重试 |
   | `RUNTIME_SEARCH_TOOL_REQUIRED` / `RUNTIME_SEARCH_STREAM_UNSUPPORTED` / `VALIDATION_REQUIRED` | 请求形状不对（HTTP 400） | 修客户端请求 |
   | `RUNTIME_SEARCH_TIMEOUT` | 我们等上游超时（HTTP 504） | 提示"搜索暂不可用"，可退避重试 |
   | `RUNTIME_SEARCH_UPSTREAM_UNREACHABLE` | 连不上搜索上游（HTTP 502） | 提示"搜索暂不可用" |
   | `UPSTREAM_AUTH` | 平台的渠道密钥无效（HTTP 401/403） | **平台侧配置问题**，别重试，提示"搜索暂不可用" |
   | `UPSTREAM_RATE_LIMITED` | 上游限流（HTTP 429） | 退避重试 |
   | `UPSTREAM_INVALID_REQUEST` / `UPSTREAM_NOT_FOUND` | 上游认为参数/模型不对 | 别重试，报给我们 |
   | `UPSTREAM_UNAVAILABLE` | 上游 5xx | 退避重试 |

2. **搜索超时从 240 秒收到 80 秒**：我们会在 **80 秒**返回 `504` + `code: RUNTIME_SEARCH_TIMEOUT`。
   你们的 HTTP 超时是 85 秒 → 留 5 秒余量，**不会再出现"你们先断、我们还在跑"**。
3. **`max_tokens` 有下限 1024**：实测 `max_tokens: 64` 会把 `web_search` 的工具参数截断（上游回
   `web_search_tool_result_error: invalid_tool_input`）。你们保持 4096 即可，但不要传小于 1024 的值。
4. **`max_uses` 上限仍为 10**（超出会被夹到 10）；你们传 8 原样生效。

## 三、客户端需要做的（按优先级）

### 1）用平台下发的 `searchUrl` 与能力开关
- `client-context.gateway.searchUrl`：现在会下发完整地址（`…/api/gateway/v1/search/messages`）。
  用它；取不到时再退回 `baseUrl + '/search/messages'`（两条路等价）。
- `client-context.features.webSearch`：
  - `true` → 课堂内，正常露出 WebSearch；
  - `false` → **隐藏 WebSearch**（老师备课模式、未开课、画布课堂都会是 false —— 这些场景平台不发
    `gateway.key`，搜索一定失败，别让用户点了没反应）。

### 2）错误分流按 `error.code`（不要只看状态码）
建议：
- `401` + `RUNTIME_KEY_EXPIRED`/`RUNTIME_KEY_INVALID` → 重新取 `client-context` 换 key，重试 **1 次**；
- `429` / `UPSTREAM_RATE_LIMITED` → 退避（建议 1–2 秒起、最多 2 次）；
- `504` / `RUNTIME_SEARCH_TIMEOUT`、`502` / `RUNTIME_SEARCH_UPSTREAM_UNREACHABLE`、`UPSTREAM_UNAVAILABLE`
  → 提示"搜索暂不可用"，不要连着重试（会把上游打得更死）；
- `403`（课堂结束/学生移出/外发被禁）→ 直接提示，不重试。

### 3）结果渲染
- 结果条目读 `content[].type === 'web_search_result'` 的 `url` / `title`；
  **`page_age` 可能为 `null`**（DeepSeek 目前不给），不要用它判断"是否最新"；
- 请求体里可能多出 `encrypted_content`，忽略即可。

### 4）不需要改的
- 不需要新接口、不需要传 `model`（平台按渠道选）；
- 鉴权不变（`x-api-key` 或 `Bearer`，值都是 `gateway.key`）；
- 响应不要套信封（平台已经是原生 Anthropic 正文）。

### 5）一个体验建议
课堂里一次搜索的典型耗时（实测）：**2.4–9 秒**（4 次检索那种是 9 秒）。工具超时 90 秒足够；
UI 上建议在 3 秒后给"正在搜索…"的进度提示，别让用户以为卡住了。

## 四、平台的验证记录（供你们对照）

- 用**生产渠道密钥**直打 `https://api.deepseek.com/anthropic/v1/messages`，请求体 = 你们文档里的
  原样体（`max_tokens:4096` / `web_search_20260209` / `max_uses:8`）：
  → **HTTP 200、10 条结果、`usage.server_tool_use.web_search_requests=4`、8.97 秒**；
  正文给出了结论与来源链接。
- 同一请求换 `web_search_20250305` / `deepseek-chat`：同样 200 + 10 条（**版本与模型都不挑**）。
- `max_tokens: 64`：上游回 `web_search_tool_result_error: invalid_tool_input`（**这就是加下限的原因**）。
- 上游 401 的真实响应体是 **OpenAI 形**（`{"error":{"message":…}}`）—— 平台已在本轮归一成 Anthropic 形。
- 平台守卫 `p106`（搜索网关）与 `p168`（客户端契约）已补相应断言并全绿。

## 五、发布信息

- 平台版本：`20261018` 这一版（release 戳以交接文档为准）；
- 生效范围：`/api/gateway/v1/search/messages` 与 `client-context` 的新字段，**对现有客户端向后兼容**
  （老客户端不读新字段也不受影响）；
- 如果联调时遇到与本文不一致的行为，把**响应体原文 + `code` + 时间点**发给我们，我们在平台日志里按
  `[runtimeSearchGateway]` 对齐。
