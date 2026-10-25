-- 39 · 内容工作台十一期：同行观察管线化（2026-10-25，机构级）。
--
-- 对齐原版 XiaoLingDang 的同行同步/筛选下载队列（作者本人授权复刻）：
--   refs 补 sec_user_id（主页 ID）与筛选条件；peer_syncs 记录每一次「同步最新作品」的进度；
--   peer_settings 存自动同步开关（默认关闭 —— 下载+转写按次计费，必须显式开）。
--
-- 口径与 29-38 一致：SQLite 由 schema.js 自动建；生产 RDS 手工执行，纯新增表+加列。
-- ⚠️ TEXT/MEDIUMTEXT 列不给默认值：应用层 INSERT 显式给全所有列。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/39-junshi-workbench-peer-syncs-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_peer_syncs; DROP TABLE junshi_workbench_peer_settings;
--       （refs 加的列旧代码不读，不用回滚）

ALTER TABLE junshi_workbench_refs
  ADD COLUMN sec_user_id VARCHAR(128) NULL,
  ADD COLUMN download_filter MEDIUMTEXT NULL,
  ADD COLUMN last_sync_at VARCHAR(64) NULL,
  ADD COLUMN last_sync_status VARCHAR(24) NULL,
  ADD COLUMN last_sync_message VARCHAR(1000) NULL;

CREATE TABLE IF NOT EXISTS junshi_workbench_peer_syncs (
  id          VARCHAR(64) NOT NULL,
  owner_key   VARCHAR(64) NOT NULL,
  org_id      VARCHAR(64) NULL,
  ref_id      VARCHAR(64) NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'queued',
  stage       VARCHAR(32) NOT NULL DEFAULT 'queued',
  target_count INTEGER NOT NULL DEFAULT 5,
  found_count  INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  done_count   INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  message     VARCHAR(1000) NOT NULL DEFAULT '',
  filter      MEDIUMTEXT NOT NULL,
  created_at  VARCHAR(64) NOT NULL,
  updated_at  VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_psync_owner (owner_key, created_at),
  KEY idx_junshi_wb_psync_ref (ref_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_peer_settings (
  owner_key      VARCHAR(64) NOT NULL,
  auto_enabled   INTEGER NOT NULL DEFAULT 0,
  interval_hours INTEGER NOT NULL DEFAULT 24,
  last_run_at    VARCHAR(64) NULL,
  next_run_at    VARCHAR(64) NULL,
  updated_at     VARCHAR(64) NOT NULL,
  PRIMARY KEY (owner_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：SHOW COLUMNS FROM junshi_workbench_refs LIKE 'sec_user_id'; SHOW TABLES LIKE 'junshi_workbench_peer_%';
