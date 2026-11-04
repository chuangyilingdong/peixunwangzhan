# RunningHub 接入（2026-11-04）

> RunningHub 是「提交任务 → 拿 taskId → POST /query → results[].url」的异步协议，
> 不是 OpenAI 兼容接口。平台新增了 `runninghub` 供应商适配器，图片/视频/音乐三模态都走它。
>
> 关联守卫：`scripts/p207-runninghub.mjs`。

## 一、接口形态

| 动作 | 请求 |
|---|---|
| 提交 | `POST https://www.runninghub.ai/openapi/v2/{endpoint}`，`Authorization: Bearer <key>` |
| 查询 | `POST https://www.runninghub.ai/openapi/v2/query`，body `{ taskId }` |
| 状态 | `CREATE / QUEUED / RUNNING` → 继续等；`SUCCESS` → 取结果；`FAILED / CANCEL` → 失败 |
| 结果 | `results: [{ url, outputType }]` |

注意：

- Model API 的 Key 必须是 **Enterprise-Shared** 类型；普通消费 Key 会 401/403。
- 轮询间隔 5 秒；超时默认 30 分钟（`AI_PROVIDER_MAX_WAIT_MS`）。
- 参考图/视频/音频用公网 URL（`imageUrls` / `videoUrls` / `audioUrls`）。

## 二、渠道 family 与路径

渠道卡里的「模型」填 family key，适配器据此选提交路径：

| family | 用途 | 提交路径 |
|---|---|---|
| `rhart-image-g-2.5` | 图片·主 | 文生图 `/rhart-image-g-2.5/sunburst/text-to-image`；图生图 `/rhart-image-g-2.5/flare/image-to-image` |
| `rhart-image-g-2-official` | 图片·备 | 文生图 `/rhart-image-g-2-official/text-to-image`；图生图 `/rhart-image-g-2-official/image-to-image` |
| `bytedance/seedance-2.0-global-fast` | 视频·主 | `/bytedance/seedance-2.0-global-fast/multimodal-video` |
| `minimax/hailuo-h3` | 视频·备 | `/minimax/hailuo-h3/multimodal-to-video` |
| `minimax/music-2.6` | 音乐 | `/minimax/music-2.6` |

图片的「文生图 / 图生图」由**有没有参考图**自动选：课时框体锁了模式时，平台在更早一层已经拦过
（文生图不许连线、图生图必须连线），到适配器这里只看 `options.referenceAssets` 有没有图。

## 三、后台怎么配

### 1. 建 5 条渠道

「AI 能力与价格 → 渠道与价格 → 新增渠道」：

| 渠道名 | provider | 调用地址 | 模型（family） |
|---|---|---|---|
| RunningHub 图片主 | `runninghub` | `https://www.runninghub.ai/openapi/v2` | `rhart-image-g-2.5` |
| RunningHub 图片备 | `runninghub` | 同上 | `rhart-image-g-2-official` |
| RunningHub 视频主 | `runninghub` | 同上 | `bytedance/seedance-2.0-global-fast` |
| RunningHub 视频备 | `runninghub` | 同上 | `minimax/hailuo-h3` |
| RunningHub 音乐 | `runninghub` | 同上 | `minimax/music-2.6` |

每条都要：

- API Key：RunningHub 的 **Enterprise-Shared** Key；
- 「可用模型」/「默认模型」：填上面的 family（「读取模型」按钮对 RunningHub 可能不适用，用「手动添加模型 ID」）；
- 高级配置里的请求模板**不用填**：RunningHub 的请求体由适配器按接口参数拼，不吃 OpenAI 模板。

### 2. 配路由与备用

「渠道与价格 → 路由与开关」：

- 图片渠道 → `RunningHub 图片主`；图片备用 → `RunningHub 图片备`；
- 视频渠道 → `RunningHub 视频主`；视频备用 → `RunningHub 视频备`；
- 音乐渠道 → `RunningHub 音乐`。

### 3. 价目表

RunningHub 按次收费；在「价目表」里按 `渠道 × family` 填成本价/对外价。
成本价用于折算上游成本；不填就是 UNKNOWN，不会按 0 计。

### 4. 课时里的模型

- 适配器以**渠道 family** 为准；课时框体里的旧模型 ID（如 `zhenzhen-image-g-v2.5-lowprice`）
  不会把请求带偏，所以老课时不用改也能跑。
- 但为了界面清楚，建议把课时框体的「模型」改成对应的 family，或在「模型显示名」里给 family 配一个
  学生看得懂的名字。
- 模型能力（比例/清晰度/时长/音频）按 RunningHub 的接口取值配置，否则课时里可选的档位可能不对。

## 四、适配器行为

1. 提交 `POST {base}{path}`，body：
   - 图片文生：`prompt / aspectRatio / resolution`
   - 图片图生：`prompt / imageUrls / aspectRatio / resolution`
   - 视频：`prompt / resolution / duration / ratio / imageUrls? / videoUrls? / audioUrls?`；
     主渠道（seedance）带 `generateAudio`，备用（hailuo）不带
   - 音乐：`prompt / lyrics / format`（歌词模式：学生输入当歌词，`prompt` 用模型默认曲风）
2. 拿 `taskId`（驼峰/下划线都认），调用 `onSubmitted` 落 `compute_attempts.task_id`。
3. 每 5 秒 `POST /query {taskId}`：
   - `SUCCESS` → `results[].url` + `outputType` 转 MIME；
   - `FAILED/CANCEL` → 失败；
   - 429/5xx → 退避，最多等到 30 分钟。
4. 提交阶段 401/429 标记 `safeToRetry`，平台会自动切**备用渠道**；
   已经提交、只是查询失败的任务**不会**切备用（避免重复建任务），会等超时。

## 五、已知边界

- **参考素材必须是公网 URL**：`data:` 会明确拒绝；学生私有素材如果只是 `/api/student/...` 且需要登录，
  RunningHub 可能抓不到。要支持这类素材，需要再加一步「上传到 RunningHub 的 media/upload/binary」。
- **不支持 TEXT**：RunningHub 的 LLM 是另一套接口，不在这个适配器里。
- **不支持流式**：异步任务没有 SSE。
- **主/备按模态**：图片/视频各一条主、一条备；音乐只有主。
- **旧模型 ID**：课时里保持旧 ID 也能跑（适配器用渠道 family），但价格/日志按 family 记。

## 六、验收

```bash
node scripts/p207-runninghub.mjs   # 12/12
```

覆盖：文生/图生路径、主/备视频、音乐、taskId、results/MIME、401/429/FAILED/超时、渠道 family、data: 拒绝。
