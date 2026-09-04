# 内测监控、告警与值班基线

> 适用环境：`learning-platform-internal-test`。这是监控合同与值班 SOP，不表示已经接入真实第三方告警平台；通知通道需由运维在服务器侧配置。

## 监控信号与告警矩阵

| 信号 | 采集方式 | 触发阈值 | 级别 | 责任人 | 通知与处置 |
|---|---|---:|---|---|---|
| API 健康 | `curl http://127.0.0.1:8788/health` / systemd timer | 连续 2 次失败（1 分钟） | P0 | 发布负责人 | 飞书值班群 + 电话升级；查看 journald，重启服务，失败则回滚 |
| HTTP 5xx | Nginx access log + journald | 5 分钟错误率 > 2% 或连续 5 个 5xx | P0 | 发布负责人 | 飞书值班群；保留 request path / release，先止损再回滚 |
| API 慢请求 | access log 聚合 | 5 分钟 p95 > 500ms | P1 | 技术负责人 | 飞书值班群；检查 CPU / 内存 / SQLite 锁 / 上游服务 |
| 磁盘空间 | `df -P`、release / backup 目录 | >80% 预警，>90% P0 | P0 | 运维负责人 | 飞书值班群 + 电话升级；清理合规日志或扩容，禁止直接删数据库 |
| SQLite 完整性 / 备份 | `PRAGMA integrity_check` + 备份脚本退出码 | 任意失败 | P0 | 运维负责人 | 飞书值班群；停止写入，保留现场并按备份恢复 |
| AI 任务队列 | `generation_jobs` 状态与创建时间 | PENDING 超过 5 分钟（真实 provider 接入后） | P1 | AI 服务负责人 | 飞书值班群；当前 `local-mock` 不计作真实 provider |
| AI 成本 / provider 错误 | 业务用量与 provider 日志 | 供应商规则确认后配置 | P1 | 业务负责人 | 仅在真实账号 / 规则确认后启用，不伪造费用告警 |
| HTTPS 证书 | `openssl s_client` / 到期检查 | 到期前 14 天 | P1 | 运维负责人 | 飞书值班群；续期后执行 HTTPS / health 验证 |

## 脱敏与证据

- 日志中不得出现密码、认证 Cookie、Bearer token、AUTH_PEPPER、儿童真实姓名 / 联系方式、真实作品内容或真实数据库路径。
- 每次告警记录：UTC + Asia/Shanghai 时间、release commit、接口 / 页面、状态码、复现步骤、处置人、是否回滚。
- 采集命令只读；备份、恢复、回滚必须使用 `deploy/internal-test/` 脚本并先确认目标位于隔离内测根目录。

## 值班处置顺序

1. 确认影响范围，暂停扩大访问，不把内部测试错误宣传为正式服务。
2. 保存 `journalctl`、Nginx 日志和健康检查结果，不复制 token 或真实数据。
3. 判断是代码、配置、数据库、外部 provider 还是机器资源问题。
4. P0 优先止损；必要时按 `RUNBOOK.md` 执行恢复 / 回滚。
5. 恢复后完成健康、核心 API、权限边界和 noindex 检查，并写入事故复盘。

## 当前部署说明

当前线上 `https://iicili.cyou/` 仍为内部测试站，保留 HTTPS、noindex、内测标识、独立测试 SQLite 和回滚能力；Basic Auth 已按用户授权解除。监控基线完成后，仍需在 ECS 上配置 systemd timer / 日志轮转 / 真实通知渠道，正式公开前必须恢复访问控制。
