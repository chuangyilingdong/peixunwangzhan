# submit-upload 直传 OSS（预签名 PUT）· 平台协议（2026-11-12）

> 长期方案：客户端把作品二进制**直接 PUT 到 OSS**，平台只收文本与引用。
> 服务端不再把 20–100MB body 读进内存，因此不受上传闸 1 份并发的限制。
> 老 JSON / multipart 入口保留；客户端未升级前行为不变。

## 1. `POST /api/student/runtime/submit-upload/prepare`

普通 JSON（体很小）：

```json
{
  "name": "index.html",
  "taskId": "可选",
  "files": [
    { "name": "index.html", "binary": false, "size": 2882 },
    { "name": "assets/big.png", "binary": true, "size": 20971520,
      "mimeType": "image/png", "md5": "32位hex" }
  ]
}
```

返回：

```json
{
  "uploadToken": "…",
  "expiresAt": "…",
  "maxBytes": 104857600,
  "files": [
    { "name": "assets/big.png", "binary": true, "method": "PUT",
      "url": "https://bucket.oss-…?OSSAccessKeyId=…&Expires=…&Signature=…",
      "headers": { "content-type": "image/png" } },
    { "name": "index.html", "binary": false }
  ]
}
```

- 二进制文件必须给 `size`、`mimeType`、`md5`；文本文件只声明 `size`。
- `md5` 用于 finalize 时与 OSS ETag 比对；`size` 用于 HEAD 复核。
- 上传票据 HMAC-SHA256 签名，绑定 userId/orgId/每个文件的 key/size/md5，30 分钟过期。
- OSS 未配置（本地/测试）→ **501 `DIRECT_UPLOAD_UNAVAILABLE`**，客户端应回退 multipart。
- 预签名 URL 15 分钟有效；PUT 时必须原样带 `headers['content-type']`（它参与签名）。

## 2. 客户端直传

对每个 `binary: true` 的文件：

```http
PUT <url>
content-type: <headers.content-type>
<文件字节>
```

服务端不参与，不占 Node 内存/上传闸。

## 3. `POST /api/student/runtime/submit-upload/direct`

```json
{
  "uploadToken": "…",
  "name": "index.html",
  "title": "我的作品",
  "taskId": "可选", "sessionId": "自动补交必填",
  "autoSubmit": false, "copyrightConfirmed": true,
  "files": [
    { "name": "index.html", "binary": false, "content": "<html>…" },
    { "name": "assets/big.png", "binary": true }
  ],
  "cover": true
}
```

服务端：

1. 验票（签名/过期/user/org）；
2. 每个二进制 `HEAD` OSS（内网）：存在、size 一致、ETag 与 md5 一致；
3. 取前 64 字节跑 `validateMimeAndExtension`（magic/扩展名）；
4. 登记 `file_assets`（`storage_kind=INTERNAL_PROXY`、`storage_key=OSS key`、`storageBackend=oss`）；
5. 与 JSON/multipart 共用 `recordSubmissionFromArtifacts`：二进制用 `fileAssetId`，文本走 `content`。

任何一份校验失败 → 400，并尽力删除这批 OSS 对象；不会登记半套资产。

## 4. 错误码

| 情况 | code |
|---|---|
| OSS 未配置 | `DIRECT_UPLOAD_UNAVAILABLE`（501） |
| 票据无效/篡改 | `UPLOAD_TICKET_INVALID` |
| 票据过期 | `UPLOAD_TICKET_EXPIRED` |
| 票据不属于当前账号 | `UPLOAD_TICKET_FORBIDDEN` |
| 对象不存在 / 大小不符 / md5 不符 | `RUNTIME_UPLOAD_OBJECT_MISSING` / `_SIZE_MISMATCH` / `_CHECKSUM_MISMATCH` |
| 清单与票据不一致 | `RUNTIME_UPLOAD_TICKET_MISMATCH` |
| 文件类型/大小/封面超限 | 沿用 `RUNTIME_UPLOAD_*` |

## 5. 客户端改造清单（客户端仓库）

1. `submitWorkFromDesktop`：先 `prepare`；二进制按返回 URL/headers 直传（并发 3–4、失败重试一次）；再 `direct` 提交文本与引用。
2. 计算每个二进制文件的 `md5` + `size`；封面作为 `cover.png` 一起 prepare/上传，finalize 带 `cover:true`。
3. `prepare` 返回 501 / PUT 失败 → 回退现有 multipart 流程。
4. 同步客户端仓 `docs/平台接口契约.md`，跑单测/E2E 后发版。

## 6. 运维注意

- 未完成的上传会在 OSS 留下 `direct-upload/` 前缀的孤儿对象；后续加清理任务（按 uploadId/时间）或生命周期。
- 直传绕过服务端病毒扫描（生产扫描器本就关闭），用 Range magic 校验兜底。
- 票据密钥 `UPLOAD_TICKET_SECRET` 缺省回退 `RUNTIME_GATEWAY_SECRET`；换密钥只影响 30 分钟内未完成的票据。
- 旧客户端继续走 JSON/multipart，不需要强制升级。
