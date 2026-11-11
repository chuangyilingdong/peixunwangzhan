# 课堂 VibeCoding 文本流式超时（2026-11-11）

## 现象

- 客户端报 `GENERATION_PROVIDER_TIMEOUT`，详情 `This operation was aborted`
- 模型 `deepseek/deepseek-v4.1-flash`，providers `lingdong-platform-gateway`
- 一次请求 12:01:03 → 12:06:03，正好 300 秒
- 数据库 `error_code=20`、`error_message=This operation was aborted`

## 根因

1. `apps/server/src/config.js` 的 `AI_PROVIDER_TIMEOUT_MS` 上限硬编码 300000；
2. `services/openaiCompatibleProvider.js` 的 `generateStream` 复用了同一个 5 分钟 timeout；
3. 流建立后 `reader.read()` 被 `AbortController` 中止时，底层 `AbortError: This operation was aborted`
   没有归一化，直接冒泡；
4. `routes/runtimeGateway.js` 的 SSE 错误又直接写 `error.message`，所以学生看到原始文案。

## 修复

- 新增 `AI_PROVIDER_STREAM_TIMEOUT_MS`（默认沿用全局，封顶 1200000）：
  **只给 `generateStream` 用**；图片/视频/上传/轮询仍走 `AI_PROVIDER_TIMEOUT_MS`（300000）。
- `openaiCompatibleProvider` 新增 `streamTimeoutMs` 参数；`generateStream` 改用 `streamTimeout`。
- 流式读取阶段 abort 统一归一化：
  - 调用方主动停止/断线 → `GENERATION_PROVIDER_ABORTED`「已停止生成」；
  - 20 分钟到点 → `GENERATION_PROVIDER_TIMEOUT`「AI 服务响应超时」。
- `runtimeGateway`：
  - SSE 错误改用 `normalized.message`，不再透原始 `This operation was aborted`；
  - 新增 `res.on('close')` → `AbortController.abort()`，客户端断线不再让上游空跑最多 20 分钟。

## 生产配置

`/etc/ai-kids-platform/production.env`（已备份 `production.env.bak-20261111T061834Z`）：

```text
AI_PROVIDER_TIMEOUT_MS=300000
AI_PROVIDER_STREAM_TIMEOUT_MS=1200000
```

实际加载值（Node 读取 config）：

```json
{"stream":1200000,"global":300000,"maxWait":1800000}
```

## 画布评估

- **画布「生文」**：非流式 `provider.generate`，仍是 5 分钟单次请求上限；AbortError 已归一化为
  `GENERATION_PROVIDER_TIMEOUT` /「AI 服务响应超时」，**不会**出现原始 `This operation was aborted`。
  如果长文生成需要超过 5 分钟，要另加非流式文本超时配置（本次未改）。
- **画布「生图/生视频/生音乐」**：提交 5 分钟；轮询总等待默认 30 分钟（`AI_PROVIDER_MAX_WAIT_MS=1800000`），
  单次轮询 30 秒。长视频不会被 5 分钟截断。
- **画布里的 VibeCoding/Agent**：走 runtime gateway 流式，本次已放宽到 20 分钟。

## 发布

- release：`20261111T061900Z`
- commit：`9d1959c2`
- 回滚点：`20261111T050430Z`（commit `cb652aea`）
- 无数据库迁移；不需要重发 Windows/macOS 客户端
- 发布验收 39/0；service active、`NRestarts=0`、health 200、无 error 日志

## 验证

- `p6` 新增流式读取超时用例：31/31（超时归一化 + 主动停止仍是 ABORTED）
- `p202 / p42 / p75 / p87` 通过
- `acceptance-suite --fast` 28/28

## 注意

- nginx `/api/gateway/` 是 600s **空闲**超时，`/api/` 是 300s **空闲**超时；服务端每 15s 发 `: ping`，
  不是 5 分钟硬切。若前面还有 SLB/CDN 的总时长限制，需要单独确认。
- 客户端自身若还有 5 分钟请求超时，服务端放宽不会生效；本次未改客户端。
