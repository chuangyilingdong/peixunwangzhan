-- 29 · 招生军师「内容工作台」的 7 张表（2026-10-24，机构级）。
--
-- 口径与 27/28 一致：
--   · SQLite 侧由 packages/database/src/schema.js 自动建表；
--   · 生产 RDS(MySQL) 必须手工执行本文件，漏了的话工作台页面能开、读接口报 500。
--   · owner_key 复用 org:<机构id> / user:<用户id>，同一机构共享；
--   · 时间戳继续存 ISO 文本，不加外键（与既有 junshi 表一致）。
--
-- 执行（服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/29-junshi-workbench-mysql.sql
-- 回滚（只存工作台数据，删了就没了）：
--   DROP TABLE junshi_workbench_jobs, junshi_workbench_refs, junshi_workbench_assets,
--     junshi_workbench_video_projects, junshi_workbench_copy_drafts,
--     junshi_workbench_messages, junshi_workbench_profiles;

CREATE TABLE IF NOT EXISTS junshi_workbench_profiles (
  owner_key   VARCHAR(64) NOT NULL,
  org_id      VARCHAR(64) NULL,
  content     MEDIUMTEXT  NOT NULL,
  created_at  VARCHAR(64) NOT NULL,
  updated_at  VARCHAR(64) NOT NULL,
  PRIMARY KEY (owner_key),
  KEY idx_junshi_wb_profile_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_messages (
  id          VARCHAR(64)  NOT NULL,
  owner_key   VARCHAR(64)  NOT NULL,
  org_id      VARCHAR(64)  NULL,
  role        VARCHAR(16)  NOT NULL,
  content     MEDIUMTEXT   NOT NULL,
  citations   MEDIUMTEXT   NULL,
  created_at  VARCHAR(64)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_msg_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_copy_drafts (
  id          VARCHAR(64)  NOT NULL,
  owner_key   VARCHAR(64)  NOT NULL,
  org_id      VARCHAR(64)  NULL,
  topic       VARCHAR(255) NOT NULL DEFAULT '',
  style       VARCHAR(64)  NOT NULL DEFAULT '',
  content     MEDIUMTEXT   NOT NULL,
  created_at  VARCHAR(64)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_copy_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_video_projects (
  id             VARCHAR(64)  NOT NULL,
  owner_key      VARCHAR(64)  NOT NULL,
  org_id         VARCHAR(64)  NULL,
  title          VARCHAR(255) NOT NULL DEFAULT '',
  brief          MEDIUMTEXT   NOT NULL,
  reference_text MEDIUMTEXT   NOT NULL,
  mode           VARCHAR(16)  NOT NULL DEFAULT '原创',
  script         MEDIUMTEXT   NOT NULL,
  status         VARCHAR(32)  NOT NULL DEFAULT 'draft',
  created_at     VARCHAR(64)  NOT NULL,
  updated_at     VARCHAR(64)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_video_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_assets (
  id              VARCHAR(64)  NOT NULL,
  owner_key       VARCHAR(64)  NOT NULL,
  org_id          VARCHAR(64)  NULL,
  file_name       VARCHAR(255) NOT NULL,
  storage_key     VARCHAR(500) NOT NULL,
  storage_backend VARCHAR(16)  NOT NULL DEFAULT 'local',
  mime_type       VARCHAR(128) NOT NULL DEFAULT '',
  kind            VARCHAR(16)  NOT NULL DEFAULT 'file',
  file_size       BIGINT       NOT NULL DEFAULT 0,
  created_at      VARCHAR(64)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_asset_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_refs (
  id          VARCHAR(64)   NOT NULL,
  owner_key   VARCHAR(64)   NOT NULL,
  org_id      VARCHAR(64)   NULL,
  name        VARCHAR(255)  NOT NULL DEFAULT '',
  url         VARCHAR(2000) NOT NULL DEFAULT '',
  notes       MEDIUMTEXT    NOT NULL,
  created_at  VARCHAR(64)   NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_ref_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_jobs (
  id          VARCHAR(64)  NOT NULL,
  owner_key   VARCHAR(64)  NOT NULL,
  org_id      VARCHAR(64)  NULL,
  kind        VARCHAR(64)  NOT NULL DEFAULT '',
  status      VARCHAR(16)  NOT NULL DEFAULT 'running',
  detail      MEDIUMTEXT   NOT NULL,
  created_at  VARCHAR(64)  NOT NULL,
  updated_at  VARCHAR(64)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_job_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：
--   SHOW TABLES LIKE 'junshi_workbench_%';
