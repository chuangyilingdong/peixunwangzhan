-- 37 · 内容工作台八期：内容计划/周期日历（2026-10-25，机构级）。
--
-- 对齐原版 XiaoLingDang 的 content-cycles（作者本人授权复刻）：
-- 一份周期计划 = period + distribution（内容类型分布）+ slots[]（逐天选题卡）。
-- slots 整体存 JSON：槽位小、改动都以整份计划为版本单位（version 乐观锁）。
-- 状态：generating（生成中）→ proposed（待确认）→ confirmed（已确认，作为「当前计划」）。
--
-- 口径与 29-36 一致：SQLite 由 schema.js 自动建；生产 RDS 手工执行，纯新增表，可以先跑。
-- ⚠️ TEXT/MEDIUMTEXT 列不给默认值：应用层 INSERT 显式给全所有列。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/37-junshi-workbench-content-cycles-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_content_cycles;

CREATE TABLE IF NOT EXISTS junshi_workbench_content_cycles (
  id            VARCHAR(64) NOT NULL,
  owner_key     VARCHAR(64) NOT NULL,
  org_id        VARCHAR(64) NULL,
  account_id    VARCHAR(64) NOT NULL DEFAULT 'default',
  period        VARCHAR(120) NOT NULL DEFAULT '',
  status        VARCHAR(16) NOT NULL DEFAULT 'generating',
  version       INTEGER NOT NULL DEFAULT 1,
  content_count INTEGER NOT NULL DEFAULT 0,
  brief         VARCHAR(500) NOT NULL DEFAULT '',
  distribution  MEDIUMTEXT NOT NULL,
  notice        VARCHAR(1000) NOT NULL DEFAULT '',
  slots         MEDIUMTEXT NOT NULL,
  error         VARCHAR(1000) NOT NULL DEFAULT '',
  created_at    VARCHAR(64) NOT NULL,
  updated_at    VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_cycle_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：SHOW TABLES LIKE 'junshi_workbench_content_cycles';
