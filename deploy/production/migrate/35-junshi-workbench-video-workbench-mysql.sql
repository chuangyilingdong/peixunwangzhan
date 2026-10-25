-- 35 · 内容工作台七期：视频完整工作台（2026-10-25，机构级）。
--
-- 对齐原版 XiaoLingDang 的 video_workspace / voice_library / video-auto-tasks（作者本人授权复刻）：
--   video_works      视频任务行（生成/复刻/自动日更三模式统一，编导稿分镜 JSON 存 director_script）
--   voice_samples    音色库（2–15 秒参考音频，与五期数字人克隆音色 junshi_workbench_voices 区分）
--   video_auto_tasks 自动日更任务（调度需要平台开 JUNSHI_VIDEO_AUTO_ENABLED=1）
-- 并给 junshi_workbench_video_renders 加 work_id/shot_index/kind：一条任务行的「整片渲染」
-- 和「单镜渲染」都复用既有渲染管道。
--
-- 口径与 29-34 一致：SQLite 由 schema.js 自动建；生产 RDS 手工执行，纯新增表+加列，可以先跑。
-- ⚠️ TEXT/MEDIUMTEXT 列不给默认值（32/33 两期的教训）：应用层 INSERT 显式给全所有列。
-- ⚠️ 加列用 TEXT NULL / 默认值列，别动已有列定义。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/35-junshi-workbench-video-workbench-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_video_works; DROP TABLE junshi_workbench_voice_samples;
--       DROP TABLE junshi_workbench_video_auto_tasks;（renders 加的列旧代码不读，不用回滚）

CREATE TABLE IF NOT EXISTS junshi_workbench_video_works (
  id              VARCHAR(64) NOT NULL,
  owner_key       VARCHAR(64) NOT NULL,
  org_id          VARCHAR(64) NULL,
  account_id      VARCHAR(64) NOT NULL DEFAULT 'default',
  mode            VARCHAR(16) NOT NULL DEFAULT 'generate',
  title           VARCHAR(200) NOT NULL DEFAULT '',
  type            VARCHAR(32) NOT NULL DEFAULT 'ecommerce',
  subtype         VARCHAR(64) NOT NULL DEFAULT '',
  hook_strategy   VARCHAR(32) NOT NULL DEFAULT 'auto',
  model           VARCHAR(64) NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 15,
  resolution      VARCHAR(16) NOT NULL DEFAULT '',
  ratio           VARCHAR(16) NOT NULL DEFAULT '9:16',
  brief           MEDIUMTEXT NOT NULL,
  asset_refs      MEDIUMTEXT NOT NULL,
  status          VARCHAR(24) NOT NULL DEFAULT 'planning',
  message         VARCHAR(1000) NOT NULL DEFAULT '',
  director_script MEDIUMTEXT NOT NULL,
  script_revision INTEGER NOT NULL DEFAULT 0,
  script_edited   INTEGER NOT NULL DEFAULT 0,
  auto_task_id    VARCHAR(64) NULL,
  output_asset_id VARCHAR(64) NULL,
  error           VARCHAR(1000) NOT NULL DEFAULT '',
  created_at      VARCHAR(64) NOT NULL,
  updated_at      VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_vwork_owner (owner_key, created_at),
  KEY idx_junshi_wb_vwork_auto (auto_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_voice_samples (
  id               VARCHAR(64) NOT NULL,
  owner_key        VARCHAR(64) NOT NULL,
  org_id           VARCHAR(64) NULL,
  account_id       VARCHAR(64) NOT NULL DEFAULT 'default',
  name             VARCHAR(200) NOT NULL DEFAULT '',
  asset_id         VARCHAR(64) NOT NULL,
  duration_seconds REAL NOT NULL DEFAULT 0,
  use_count        INTEGER NOT NULL DEFAULT 0,
  created_at       VARCHAR(64) NOT NULL,
  updated_at       VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_vsample_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_video_auto_tasks (
  id               VARCHAR(64) NOT NULL,
  owner_key        VARCHAR(64) NOT NULL,
  org_id           VARCHAR(64) NULL,
  account_id       VARCHAR(64) NOT NULL DEFAULT 'default',
  client_id        VARCHAR(64) NULL,
  task_name        VARCHAR(100) NOT NULL DEFAULT '',
  schedule_type    VARCHAR(16) NOT NULL DEFAULT 'daily',
  interval_days    INTEGER NOT NULL DEFAULT 2,
  run_time         VARCHAR(8) NOT NULL DEFAULT '09:00',
  count            INTEGER NOT NULL DEFAULT 1,
  authorized_folder VARCHAR(200) NOT NULL DEFAULT '',
  type             VARCHAR(32) NOT NULL DEFAULT 'ecommerce',
  subtype          VARCHAR(64) NOT NULL DEFAULT '',
  hook_strategy    VARCHAR(32) NOT NULL DEFAULT 'auto',
  model            VARCHAR(64) NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 15,
  resolution       VARCHAR(16) NOT NULL DEFAULT '',
  ratio            VARCHAR(16) NOT NULL DEFAULT '9:16',
  enabled          INTEGER NOT NULL DEFAULT 1,
  next_run_at      VARCHAR(64) NULL,
  last_run_at      VARCHAR(64) NULL,
  last_run_status  VARCHAR(24) NULL,
  last_message     VARCHAR(1000) NULL,
  created_at       VARCHAR(64) NOT NULL,
  updated_at       VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_vauto_owner (owner_key, next_run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE junshi_workbench_video_renders
  ADD COLUMN work_id VARCHAR(64) NULL,
  ADD COLUMN shot_index INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'single';

-- 复查：SHOW TABLES LIKE 'junshi_workbench_video_%'; SHOW COLUMNS FROM junshi_workbench_video_renders LIKE 'work_id';
