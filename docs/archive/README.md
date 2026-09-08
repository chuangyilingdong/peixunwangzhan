# 归档文档说明

> 状态：历史归档
> 归档日期：2026-09-08
> 本目录内容为阶段性验收 / 总结 / 方案文档，**不代表当前生产架构**，仅作历史留痕。请以以下当前基线为准：

- 当前架构：`../architecture/代码结构与路由.md`
- 积分设计：`../architecture/积分系统设计.md`
- 验收清单：`../operations/验收清单.md`
- 部署手册：`../../deploy/production/RUNBOOK.md`

## 常见过时信息提醒

归档文档可能包含以下已被当前代码取代的内容：

- 独立 `apps/student` 学生端（已删除，学生功能并入官网 `/`）
- `http://localhost:3001`、`5174/5175/5176/5177/5178` 等旧端口
- Express / React 18 / Node 16 等旧技术基线（当前为原生 `node:http`、React 19、Node ≥ 22.13）
- 旧的“四端（含 /student/）”入口描述（当前为三端：`/`、`/admin/`、`/org/`）

如需恢复某份历史文档，`git mv docs/archive/<file> <原始路径>` 即可。
