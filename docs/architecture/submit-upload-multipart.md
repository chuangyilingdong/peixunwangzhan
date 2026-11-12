# submit-upload multipart 入口（2026-11-12）

> 平台侧协议说明。客户端仓实现时请同步更新 `docs/平台接口契约.md`（客户端仓库）并在末尾记一行变更。

## 为什么

老入口是 base64 JSON：客户端把每个文件 `toString('base64')`、`JSON.stringify`，平台再 `JSON.parse` → base64 解码。100MB 作品在两侧都有 3–5 倍内存峰值和一次 base64 编解码。

新入口用 `multipart/form-data`，去掉 base64 与 JSON 整包解析；**老 JSON 入口保留**，客户端升级前继续可用。

## 请求

```http
POST /api/student/runtime/submit-upload
Authorization: Bearer <session token>
Content-Type: multipart/form-data; boundary=...
```

### 普通字段 `meta`（JSON 字符串，必填）

```json
{
  "name": "index.html",
  "title": "我的作品",
  "taskId": "可选：客户端任务标识",
  "sessionId": "自动补交时必填",
  "autoSubmit": false,
  "copyrightConfirmed": true,
  "files": [
    { "name": "index.html", "binary": false },
    { "name": "assets/big.png", "binary": true }
  ],
  "cover": true
}
```

- `binary` 与 JSON 入口完全同义：`true` 存私有资产，`false` 进文本快照并改写本地引用。
- `files[i]` 与文件 part 的字段名 `file:<i>` 一一对应（顺序即下标）。
- `cover: true` 且带 `cover` part 时上传封面；封面失败不阻断提交（与老入口一致）。

### 文件 part

| 字段名 | filename | Content-Type |
|---|---|---|
| `file:0` | 与 `meta.files[0].name` 相同 | 文件真实 MIME |
| `file:1` | … | … |
| `cover` | `cover.png` | `image/png` |

## 校验与错误码

与 JSON 入口同一套：

| 情况 | code |
|---|---|
| 缺 `meta` | `RUNTIME_UPLOAD_META_REQUIRED` |
| `meta` 非法 JSON / 非对象 | `RUNTIME_UPLOAD_META_INVALID` |
| 缺 `name` / 名字不合法 | `RUNTIME_UPLOAD_NAME_REQUIRED` / `RUNTIME_UPLOAD_BAD_NAME` |
| 没有文件 / 超过 60 个 | `RUNTIME_UPLOAD_EMPTY` / `RUNTIME_UPLOAD_TOO_MANY_FILES` |
| `files[i]` 找不到对应 part | `RUNTIME_UPLOAD_PART_MISSING` |
| 同名文件 | `RUNTIME_UPLOAD_DUPLICATE_NAME` |
| 主产物不在清单 | `RUNTIME_UPLOAD_ENTRY_MISSING` |
| 总字节超过 `RUNTIME_UPLOAD_MAX_BYTES` | `RUNTIME_UPLOAD_TOO_LARGE` |
| multipart 本身格式错误 | `INVALID_MULTIPART` / `TOO_MANY_UPLOAD_PARTS` |

## 平台侧限额

- 请求体上限：`RUNTIME_UPLOAD_MAX_BYTES + 8MB`（生产 100MB 业务档 → ~108MB）。
- 内存闸：与 base64 JSON 共用大请求闸（默认 1 份 / 200MB），避免多条 100MB 同时进内存。
- nginx：`client_max_body_size 300m` + `proxy_request_buffering off`。
- 当前实现仍是整包读入后解析（不去 base64 但仍有 body 内存）；真正的流式落盘是下一步。

## 客户端改造清单（客户端仓）

1. `packages/desktop/src/main/lingdongPlatformGate.ts`
   - `prepareSubmitFiles`：不再 `toString('base64')`，返回文件路径/字节。
   - `submitWorkFromDesktop`：组装 `FormData`（`meta` + `file:<i>` + `cover`），替换 `JSON.stringify(body)`。
   - `apiRequest`：允许这条请求不强制 `content-type: application/json`（或新增 raw-body 变体）。
2. 客户端仓库 `docs/平台接口契约.md` 增加本协议（日期 / 变更 / 两侧提交）。
3. 单测：multipart 提交成功、缺 meta 400、老 JSON 路径回归。
4. 发版：按客户端仓的构建/发布脚本出包并更新 `manifest.json`；老客户端继续走 JSON。
