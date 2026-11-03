# 运行网关推理控制透传

## 背景

ZCode 客户端会在 OpenAI Chat Completions 请求体中携带思考控制字段：

- `reasoning_effort`
- `reasoning`
- `thinking`
- `output_config`

生产现场已确认：刘学生一次普通交互中，客户端请求体为 `reasoning_effort=high`、`thinking={type:enabled}`，首个模型请求输出 60,320 tokens，首 token 等待 218 秒。当前网关只透传消息、模型和工具，思考控制字段在这一跳被丢弃，上游实际使用渠道模板或供应商默认值。

本次只修复推理控制透传与观测，不修改输出预算、上下文裁剪、历史轮次或自动续写策略。

## 所有权

- `apps/server/src/routes/runtimeGateway.js` 是请求字段白名单和最终转发值的唯一所有者。
- `apps/server/src/services/openaiCompatibleProvider.js` 只负责把网关已经放行的字段写入上游请求体。
- 平台账号、课堂门禁、发送次数和用量记账的所有权不变。

## 产品规则

1. 客户端存在 `reasoning_effort` 时，只接受非空字符串。
2. `reasoning`、`thinking`、`output_config` 存在时，只接受 JSON 对象；不接受数组、字符串或任意其他类型。
3. 网关只透传上述四个字段，不透传客户端请求体的其他未知字段。
4. 客户端提供的思考字段覆盖渠道模板中的同名字段；渠道没有配置时也不补默认值。
5. 本次不新增渠道档位白名单、降级策略、输出预算或上下文限制。
6. 非流式与流式请求使用完全相同的透传规则。
7. 字段类型校验必须在发送次数台账和上游调用之前完成；非法请求不得消耗发送次数。

## 事件顺序

```text
客户端请求
  → runtimeGateway 校验运行密钥/课堂门禁
  → 提取并校验四个思考控制字段
  → provider.generate / generateStream
  → openAiCompatibleProvider 在模板渲染后写入同名字段
  → 上游模型
  → runtimeGateway 记录 requested/forwarded 与 usage
```

## 失败语义

- 字段类型非法时返回 `400 RUNTIME_REASONING_INVALID`，不调用上游、不记账。
- 字段缺失时保持现有行为，不注入供应商默认字段。
- 上游拒绝思考字段时沿用现有 provider 错误归一，不吞错、不改写成成功。

## 可观测性

`logGatewayRound` 增加：

- `reasoning_requested`
- `reasoning_forwarded`
- `input_tokens`
- `output_tokens`
- `reasoning_tokens`

日志只记录档位值和 token 数，不记录消息正文。`reasoning_tokens` 同时兼容顶层 `reasoning_tokens` 与 `completion_tokens_details.reasoning_tokens` / `output_tokens_details.reasoning_tokens`；未上报时记为 `-`。

## 验收

- 请求包含 `reasoning_effort=low`、`thinking={type:enabled}` 时，上游实际请求体包含同名字段。
- 请求包含 `reasoning`、`output_config` 时同样透传。
- 未知字段不会出现在上游请求体。
- 非法类型返回 400，且不调用上游。
- 流式与非流式结果一致。
- 网关成功和失败日志都能看到 requested/forwarded 档位。
- 现有工具调用、图片、发送次数、用量记账和历史截断测试不回归。