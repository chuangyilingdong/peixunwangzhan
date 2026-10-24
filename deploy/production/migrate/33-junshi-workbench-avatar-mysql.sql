-- 33 · 内容工作台五期：数字人口播 + 文案发布数据回填（2026-10-24，机构级）。
--
-- 数字人链路（同一把 seedance.nz 渠道 Key，零新增凭据）：
--   音色克隆 doubao-voice-clone → 合成 doubao-seed-icl-2.0 → 对口型 kling-lip-sync 三件套。
-- 回填：发布数据截图 → deepseek-flash 图像理解 → stats JSON 存进文案草稿。
--
-- 口径与 29-32 一致：SQLite 由 schema.js 自动建；生产 RDS 手工执行，纯新增表+补列，可以先跑。
-- ⚠️ copy_drafts 的 stats 是 MySQL TEXT 列：应用层 INSERT 已显式给值（32 期踩过严格模式的坑）。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/33-junshi-workbench-avatar-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_avatar_runs, junshi_workbench_voices;
--      ALTER TABLE junshi_workbench_copy_drafts DROP COLUMN stats;

CREATE TABLE IF NOT EXISTS junshi_workbench_voices (
  id          VARCHAR(64) NOT NULL,
  owner_key   VARCHAR(64) NOT NULL,
  org_id      VARCHAR(64) NULL,
  account_id  VARCHAR(64) NOT NULL DEFAULT 'default',
  name        VARCHAR(120) NOT NULL DEFAULT '',
  speaker_id  VARCHAR(200) NOT NULL DEFAULT '',
  status      VARCHAR(16) NOT NULL DEFAULT 'training',
  error       VARCHAR(1000) NOT NULL DEFAULT '',
  sample_asset_id VARCHAR(64) NULL,
  created_at  VARCHAR(64) NOT NULL,
  updated_at  VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_voice_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_avatar_runs (
  id             VARCHAR(64) NOT NULL,
  owner_key      VARCHAR(64) NOT NULL,
  org_id         VARCHAR(64) NULL,
  account_id     VARCHAR(64) NOT NULL DEFAULT 'default',
  voice_id       VARCHAR(64) NULL,
  speaker_id     VARCHAR(200) NOT NULL DEFAULT '',
  image_asset_id VARCHAR(64) NULL,
  text           MEDIUMTEXT NOT NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'running',
  error          VARCHAR(1000) NOT NULL DEFAULT '',
  steps          MEDIUMTEXT NOT NULL,
  video_asset_id VARCHAR(64) NULL,
  created_at     VARCHAR(64) NOT NULL,
  updated_at     VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_avatar_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE junshi_workbench_copy_drafts
  ADD COLUMN stats TEXT NOT NULL DEFAULT '';

-- 复查：SHOW TABLES LIKE 'junshi_workbench_avatar_runs'; SHOW COLUMNS FROM junshi_workbench_copy_drafts LIKE 'stats';
