-- 38 · 内容工作台十期：素材分析队列（2026-10-25，机构级）。
--
-- 对齐原版 XiaoLingDang 的素材分析队列（作者本人授权复刻）：
-- 图片素材走视觉分析（画面描述/标签/可复用判定），队列在服务进程内跑，关页继续。
-- 音频的分析沿用四期转写档案（whisper 带时间码），不重复建表。
--
-- 口径与 29-37 一致：SQLite 由 schema.js 自动建；生产 RDS 手工执行，纯新增表，可以先跑。
-- ⚠️ TEXT/MEDIUMTEXT 列不给默认值：应用层 INSERT 显式给全所有列。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/38-junshi-workbench-asset-analyses-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_asset_analyses;

CREATE TABLE IF NOT EXISTS junshi_workbench_asset_analyses (
  id          VARCHAR(64) NOT NULL,
  owner_key   VARCHAR(64) NOT NULL,
  org_id      VARCHAR(64) NULL,
  account_id  VARCHAR(64) NOT NULL DEFAULT 'default',
  asset_id    VARCHAR(64) NOT NULL,
  kind        VARCHAR(16) NOT NULL DEFAULT 'visual',
  status      VARCHAR(16) NOT NULL DEFAULT 'queued',
  result      MEDIUMTEXT NOT NULL,
  error       VARCHAR(1000) NOT NULL DEFAULT '',
  created_at  VARCHAR(64) NOT NULL,
  updated_at  VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_asa_owner (owner_key, created_at),
  KEY idx_junshi_wb_asa_asset (asset_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：SHOW TABLES LIKE 'junshi_workbench_asset_analyses';
