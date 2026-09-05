# AI 少儿编程平台（P3 基础闭环完成）

这是一个以功能闭环优先的 pnpm Monorepo：包括平台超管端、机构教务端、学生端、统一 API 与 SQLite 数据层。P1 已完成三端基础界面、共享认证/API 客户端及核心教务、项目和作品链路联调。P2 阶段已按当前范围完成：学生端可编辑提示词、画面、角色、场景、故事与便签节点，可保存、命名、预览、恢复和比较版本，并在草稿项目中导入或导出标准 JSON 画布快照；机构端可只读预览学生作品画布。P3 已完成模板与自动排版、教师画布批注/学生反馈、机构内作品墙，以及可配置的 AI/素材生成 mock 服务边界。

## 工程结构

```text
apps/
├─ admin/      平台超管端（机构、课包授权、用量概览）
├─ org/        机构教务端（班级、课堂、成员、作品）
├─ student/    学生端（学习概览、项目、AI 用量、作品）
└─ server/     统一后端 API
packages/
├─ database/   SQLite 数据层与种子数据
├─ shared/     三端共享认证、API 客户端与 UI 基础组件
└─ canvas/     可复用的 React Flow 画布组件（P2 + P3 模板/自动排版）
```

## 运行环境

- Node.js **20.19.0 或更高版本**（Vite 7 要求 Node 20.19+ 或 22.12+）
- pnpm 11

先确认实际使用的 Node 版本：

```powershell
node --version
pnpm --version
```

> 当前 Windows 终端若仍解析到 Node `16.13.1`，请先切换到 Node 20.19+ 再运行 Vite 或构建。Codex 本机可使用如下 bundled Node 临时切换：
>
> ```powershell
> $node = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
> $env:PATH = "$(Split-Path $node);$env:PATH"
> ```

## 首次初始化

```powershell
pnpm install --ignore-scripts
pnpm run db:init
pnpm run db:seed
```

默认 SQLite 数据库位于 `packages/data/platform.db`。

## 本地开发

先启动 API 服务：

```powershell
pnpm run server
```

然后在另一个终端分别启动需要使用的前端：

```powershell
pnpm run dev:admin
pnpm run dev:student
pnpm run dev:org
```

| 应用 | 本地地址 | API 代理 |
|---|---|---|
| 平台超管端 | `http://localhost:5173` | `http://localhost:8787/api` |
| 学生端 | `http://localhost:5174` | `http://localhost:8787/api` |
| 机构教务端 | `http://localhost:5175` | `http://localhost:8787/api` |
| 公开官网 | `http://localhost:5176` | 不依赖 API |

三端通过 Vite 的 `/api` 代理访问后端；无需在前端另行配置 API 地址。

## 生产构建

```powershell
pnpm run build
```

构建产物分别输出到：

```text
apps/admin/dist
apps/student/dist
apps/org/dist
```

## 演示账号

| 角色 | 登录名 | 密码 |
|---|---|---|
| 平台超管 | `root` | `admin123` |
| 机构管理员 | `org-admin` | `org123` |
| 授课教师 | `teacher-1` | `teach123` |
| 授课教师 | `teacher-2` | `teach123` |
| 学生 | `student-1` | `study123` |
| 学生 | `student-2` | `study123` |

> 同一账号再次登录会使旧会话失效，这是当前后端的预期会话策略。

## 当前功能覆盖

- **平台超管端**：登录鉴权、机构列表与创建、课包列表与机构授权、积分/能力用量概览。
- **机构教务端**：机构概览、班级创建、按班级课单选择课时开课与结束课堂、成员列表、作品审核、发布和只读画布预览。
- **学生端**：学习概览、课程与课堂状态、创建项目、提示词/画面/角色/场景/故事/便签画布编辑、画布版本保存、命名、预览、恢复、逐项差异详情与 JSON 导入/导出、AI 文本用量、提交作品、查看点评状态。
- **共享基础层**：Bearer Token 注入、Cookie 携带、统一 `{ success, data }` API envelope 解包、401 会话清理、共享响应式 UI 样式。

## 画布迁移进度（P2）

学生端已接入第一版可用画布，代码位于 `packages/canvas/src`：

- 可拖拽、可编辑、可连线的提示词、画面、故事角色、故事场景、故事短片与创作便签节点；
- 节点内容编辑、节点之间连线、缩放、缩略图与视图整理；
- 新项目首次打开时提供创作模板；
- 通过 `PUT /api/student/projects/:id` 保存快照，每次保存生成一个后端项目版本；
- `GET /api/student/projects/:id/snapshots` 可读取学生自己的版本历史，选择历史版本会另存为新版本，不会覆盖原记录；
- 学生可为新保存版本命名，也可通过 `PUT /api/student/projects/:id/snapshots/:version` 重命名草稿项目的已有版本；
- 历史版本支持只读预览；任选两个版本可查看卡片、连线的新增、删除和修改统计及逐项变更详情；
- 任一历史版本均可导出为 `ai-kids-canvas-snapshot` 格式的 JSON 文件，包含格式版本、导出时间、项目版本元数据与完整画布快照；
- 草稿项目可导入同格式、最大 1MB 的 JSON 快照；导入校验允许上述六类节点，导入只替换未保存的当前草稿，确认后点击“保存画布”才会创建当前项目的新版本，已提交项目不可导入。
- 机构端通过 `GET /api/org/works?includeSnapshot=true` 读取作品快照，并使用同一画布组件进行只读预览；
- 提交作品时，后端使用最新保存的画布快照。

实际的多模态供应商、对象存储和真实文件上传尚未接入。P3 已提供任务/素材数据模型、本地 mock provider、环境变量配置点与学生端素材工坊；在未配置供应商密钥、预算和存储策略前，系统不会伪称为真实线上生成。

## P3 已完成能力（2026-09-02）

- **画布效率**：新增“角色冒险”“科学小实验”模板；可一键套用模板，并依照节点连线自动分层排版。
- **教师反馈闭环**：机构端可保存整体点评，也可关联某个画布节点发送批注、标记跟进完成；学生在“我的作品”中可查看只读画布与全部反馈。
- **机构作品墙**：机构端将作品设为 `PUBLISHED` 后，学生端“作品墙”只展示本机构已发布作品及其只读画布。
- **AI / 素材服务边界**：新增 `generation_jobs`、`media_assets` 表，`POST /api/ai/generations`、`GET /api/ai/generations` 和 `GET /api/ai/providers`。默认 `AI_PROVIDER=local-mock`，生成可追踪的模拟素材和 SVG 预览，并以 1 积分走既有额度/机构积分扣减链路。
- **供应商配置**：可通过 `AI_PROVIDER`、`AI_PROVIDER_MODEL`、`AI_PROVIDER_ENDPOINT` 和服务器受限的 `AI_PROVIDER_API_KEY` 声明后续适配目标；P6-A01 已提供配置校验和统一错误映射，非 mock provider 在未接入具体适配器前明确失败，不会假装调用成功，生产仍保持 `local-mock`。

## 非画布网站建设（2026-09-02）

- 新增公开官网 `apps/website`：首页、课程体系、机构方案、学员作品、产品手册、选型对比、客户端下载和预约演示。
- 平台端、机构端、学生端统一为 AI魔法学院品牌壳层、登录页、侧边导航、卡片/表格/状态/空态视觉。
- 按基准扩展三端非画布信息架构入口；尚未有后端契约的页面明确展示为待接入状态，不会伪造真实运营、计费或审批数据。
- `packages/canvas` 未改动；画布将在用户后续明确要求时再统一处理。

## 当前边界与后续事项

- 课程网站资料提取、16 门课程核验、以及生产部署均尚未开始。
- 真实 AI provider adapter、对象存储、文件上传、异步任务队列、内容安全审核与生产级素材访问鉴权仍需在明确供应商、密钥、预算及合规策略后接入。
- 当前画布仍可继续迁移更多原有节点、协作与课堂互动工具能力。
