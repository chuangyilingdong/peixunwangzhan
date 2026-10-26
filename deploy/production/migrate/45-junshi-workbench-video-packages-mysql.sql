-- 45 · 内容工作台十九期：视频包装与发布包（2026-10-26）。
--
-- 背景：视频任务渲染完成后，用户还需要字幕/BGM/封面/标题/发布包才能直接发布。
-- 本迁移只新增一张包装记录表；原成片、渲染记录、素材表都不变。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/45-junshi-workbench-video-packages-mysql.sql
-- 回滚（按需）：
--   DROP TABLE junshi_workbench_video_packages;
-- 复查：
--   SHOW TABLES LIKE 'junshi_workbench_video_packages';

CREATE TABLE IF NOT EXISTS junshi_workbench_video_packages (
  id               VARCHAR(64) NOT NULL,
  owner_key        VARCHAR(64) NOT NULL,
  org_id           VARCHAR(64) NULL,
  account_id       VARCHAR(64) NOT NULL DEFAULT 'default',
  work_id          VARCHAR(64) NOT NULL,
  render_id        VARCHAR(64) NOT NULL DEFAULT '',
  job_id           VARCHAR(64) NOT NULL DEFAULT '',
  status           VARCHAR(24) NOT NULL DEFAULT 'running',
  title            VARCHAR(200) NOT NULL DEFAULT '',
  description      TEXT NULL,
  tags             TEXT NULL,
  options          TEXT NULL,
  video_asset_id   VARCHAR(64) NULL,
  cover_asset_id   VARCHAR(64) NULL,
  srt_asset_id     VARCHAR(64) NULL,
  zip_asset_id     VARCHAR(64) NULL,
  error            TEXT NULL,
  created_at       VARCHAR(64) NOT NULL,
  updated_at       VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_pkg_owner (owner_key, created_at),
  KEY idx_junshi_wb_pkg_work (work_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
