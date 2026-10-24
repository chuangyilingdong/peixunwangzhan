-- 31 · 内容工作台三期：引导式创作工作流 + 长期记忆（2026-10-24，机构级）。
--
-- 工作流 = 今日选题 / 爆款复刻 / 热点结合 三个引导式状态机（链路参考原版 XiaoLingDang
-- 的 creative-sessions / viral-recreations / hotspot-combinations：分阶段出候选 → 选择 → 下一阶段）。
-- 记忆 = 机构确认的长期事实与灵感收藏，注入小铃铛对话上下文。
--
-- 口径与 29/30 一致：SQLite 由 schema.js 自动建；生产 RDS 手工执行，纯新增表，旧代码不读，可以先跑。
-- 漏跑的症状：/api/junshi/workbench/workflows、/memories 直接 500（表不存在）。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/31-junshi-workbench-workflows-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_workflows, junshi_workbench_memories;（数据会丢，回滚前先备份）

CREATE TABLE IF NOT EXISTS junshi_workbench_workflows (
  id         VARCHAR(64) NOT NULL,
  owner_key  VARCHAR(64) NOT NULL,
  org_id     VARCHAR(64) NULL,
  account_id VARCHAR(64) NOT NULL DEFAULT 'default',
  kind       VARCHAR(16) NOT NULL,
  stage      VARCHAR(24) NOT NULL,
  input      MEDIUMTEXT NOT NULL,
  state      MEDIUMTEXT NOT NULL,
  status     VARCHAR(16) NOT NULL DEFAULT 'active',
  error      VARCHAR(1000) NOT NULL DEFAULT '',
  draft_id   VARCHAR(64) NULL,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_wf_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_memories (
  id         VARCHAR(64) NOT NULL,
  owner_key  VARCHAR(64) NOT NULL,
  org_id     VARCHAR(64) NULL,
  account_id VARCHAR(64) NOT NULL DEFAULT 'default',
  kind       VARCHAR(16) NOT NULL DEFAULT 'memory',
  content    MEDIUMTEXT NOT NULL,
  source     VARCHAR(200) NOT NULL DEFAULT '',
  created_at VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_mem_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：
--   SHOW TABLES LIKE 'junshi_workbench%';  -- 应比 30 再多 workflows / memories 两张
