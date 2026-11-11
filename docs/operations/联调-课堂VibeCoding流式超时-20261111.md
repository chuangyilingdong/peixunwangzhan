# 联调 · 课堂 VibeCoding 流式超时（2026-11-11）

> 独立测试环境，**不接生产库、不使用生产课堂**。生产只多了一条 `/test-api/` 反向代理；
> 测试实例跑在 8792，独立 SQLite（`/srv/ai-kids-platform/test-runtime/data/platform.db`）。

## 地址与账号

| 项 | 值 |
|---|---|
| 测试环境地址 | `https://aicyld.com/test-api` |
| 测试学生 | `student-2` / `study123`（小红） |
| 测试机构 | 示例创新学校 |
| 测试课堂 | `第1课：认识古诗与创作主题 · 守卫夹具课堂`（ACTIVE，老师：王老师） |
| 测试课包/课时 | `AI古诗词创意营` / `第1课：认识古诗与创作主题`（VIBECODING，sendLimit=100） |
| 测试通道 | `channel-test-sse` → `http://127.0.0.1:19099`（仅本机回环） |

客户端如果要求填服务器地址，填 `https://aicyld.com/test-api`；登录后用模型下拉选择测试模型。

## 测试模型（假上游）

| 模型 | 行为 |
|---|---|
| `test-stream-11m` | 立即 200 + SSE；每 15 秒 `: ping`；**第 11 分钟**发第一段真实内容，然后 `[DONE]` |
| `test-stream-11m-nodone` | 同上，但**不发 `[DONE]`**，内容后直接结束响应 |
| `test-stream-never` | 只发 `: ping`，永远不发内容、不发 `[DONE]`（用于 20 分钟超时/客户端关闭） |
| `test-stream-quick` | 2 秒后发内容 + `[DONE]`（通路冒烟） |

假上游日志（一行一个 JSON，含 `startedAt / firstPingAt / firstContentAt / endedAt / endReason / pings`）：

```bash
ssh ai-kids-prod "tail -f /srv/ai-kids-platform/test-runtime/fake-sse.jsonl"
```

`endReason=client_closed` 表示平台/客户端主动断开了上游。

## 平台配置（测试实例实际加载）

```json
{"stream":1200000,"global":300000,"maxWait":1800000}
```

测试环境 env：`/etc/ai-kids-platform/test.env`（`AI_PROVIDER_STREAM_TIMEOUT_MS=1200000`、`AI_PROVIDER_TIMEOUT_MS=300000`）。

## 日志查询

### 平台 compute_attempts + 假上游日志

```bash
ssh ai-kids-prod "su -s /bin/bash ai-kids-prod -c 'cd /srv/ai-kids-platform/source && set -a && . /etc/ai-kids-platform/test.env && set +a && export PATH=/srv/ai-kids-platform/runtime/node/bin:\$PATH && node scripts/test-stream-logs.mjs 20'"
```

输出字段：`id`（compute_attempts.id）、`client_request_id`（请求 id）、`status`、`error_code`、
`error_message`、`output_started`、`created_at`、`completed_at`、`channel_id`、`model`，
并附假上游最近 N 行（含 `endReason`）。

### 测试服务日志

```bash
ssh ai-kids-prod "journalctl -u learning-platform-test --since '30 min ago' --no-pager | tail -100"
ssh ai-kids-prod "journalctl -u fake-sse-upstream --since '30 min ago' --no-pager | tail -50"
```

### 单条时间线核对

- 平台 `created_at` / `completed_at`：请求开始/结束
- 平台 `error_code`：`GENERATION_PROVIDER_TIMEOUT` / `GENERATION_PROVIDER_ABORTED`
- 假上游 `startedAt` / `endedAt` / `endReason`：上游连接是否及时关闭
- 两边按 `client_request_id` 对得上

## 联调场景操作

1. **客户端默认 idle timeout（约 10 分钟）**
   - 模型选 `test-stream-11m`，发一条消息；
   - 假上游只发 ping，第 11 分钟才出内容；
   - 观察客户端是否在约 10 分钟先触发 idle timeout。
2. **客户端 idle timeout 调到 20 分钟**
   - 同样选 `test-stream-11m`；
   - 预期第 11 分钟收到内容并正常完成（假上游发 `[DONE]`）。
3. **平台 20 分钟超时**
   - 模型选 `test-stream-never`，客户端保持连接 >20 分钟；
   - 预期平台在 20 分钟返回 `GENERATION_PROVIDER_TIMEOUT` +「AI 服务响应超时」，
     不透 `This operation was aborted`；
   - 假上游 `endReason=client_closed`，`endedAt` 与平台 `completed_at` 接近。
4. **客户端第 1 分钟关闭**
   - 模型选 `test-stream-never`，请求开始后关闭客户端；
   - 预期平台记录 `GENERATION_PROVIDER_ABORTED` /「已停止生成」；
   - 假上游在几秒内 `client_closed`，不继续空跑。

## 已验证

- `test-stream-quick` 从公网测试地址走完整链路：登录 → client-context → gateway → 假上游 → 内容 + `[DONE]`
- 平台 5 秒临时超时（验证后已恢复 20 分钟）：`test-stream-never` 返回
  `GENERATION_PROVIDER_TIMEOUT` +「AI 服务响应超时」，假上游 `client_closed`
- 客户端断开：3 秒断开测试 → `GENERATION_PROVIDER_ABORTED` /「已停止生成」，假上游 `client_closed`
- 测试实例配置已恢复：`stream=1200000, global=300000`

## 备注

- 生产 `/test-api/` 反向代理备份：`/etc/nginx/sites-available/aicyld.com.bak-20261111T065452Z`
- 测试服务：`learning-platform-test.service`（8792）、`fake-sse-upstream.service`（19099）
- 测试库：`/srv/ai-kids-platform/test-runtime/data/platform.db`（SQLite，独立）
- 生产库、生产课堂、生产账号均未参与。
