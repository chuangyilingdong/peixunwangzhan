-- 30 · 内容工作台二期：多创作账号 + 素材文件夹 + 视频渲染表（2026-10-24，机构级）。
--
-- 口径与 29 一致：
--   · SQLite 侧由 packages/database/src/schema.js 自动建表/补列（含旧档案回填默认账号）；
--   · 生产 RDS(MySQL) 必须手工执行本文件。漏跑的症状：/api/junshi/workbench/accounts、
--     /video/render、素材的 account_id/folder 过滤直接 500（列/表不存在）。
--   · 旧代码不读这些新表/新列，可以先跑（在切 release 之前执行也一样安全）。
--
-- 变更清单：
--   ① 新表 junshi_workbench_accounts / junshi_workbench_account_profiles / junshi_workbench_video_renders；
--   ② 旧表补列：copy_drafts.account_id、video_projects.account_id、
--      assets.account_id、assets.folder（MySQL 8 带默认值的 NOT NULL 补列是 INSTANT，不重写表）；
--   ③ 旧 junshi_workbench_profiles 的档案回填到「默认账号」（account_id='default'）一次。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/30-junshi-workbench-accounts-mysql.sql
-- 回滚：
--   DROP TABLE junshi_workbench_video_renders, junshi_workbench_account_profiles, junshi_workbench_accounts;
--   ALTER TABLE junshi_workbench_assets DROP COLUMN account_id, DROP COLUMN folder;
--   ALTER TABLE junshi_workbench_copy_drafts DROP COLUMN account_id;
--   ALTER TABLE junshi_workbench_video_projects DROP COLUMN account_id;
--   （账号维度数据会丢，回滚前先备份）

CREATE TABLE IF NOT EXISTS junshi_workbench_accounts (
  id         VARCHAR(64) NOT NULL,
  owner_key  VARCHAR(64) NOT NULL,
  org_id     VARCHAR(64) NULL,
  name       VARCHAR(120) NOT NULL,
  platform   VARCHAR(32) NOT NULL DEFAULT '抖音',
  note       VARCHAR(500) NOT NULL DEFAULT '',
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_junshi_wb_acc_owner_name (owner_key, name),
  KEY idx_junshi_wb_acc_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_account_profiles (
  owner_key   VARCHAR(64) NOT NULL,
  account_id  VARCHAR(64) NOT NULL DEFAULT 'default',
  org_id      VARCHAR(64) NULL,
  content     MEDIUMTEXT NOT NULL,
  created_at  VARCHAR(64) NOT NULL,
  updated_at  VARCHAR(64) NOT NULL,
  PRIMARY KEY (owner_key, account_id),
  KEY idx_junshi_wb_acc_profile_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_workbench_video_renders (
  id               VARCHAR(64) NOT NULL,
  owner_key        VARCHAR(64) NOT NULL,
  org_id           VARCHAR(64) NULL,
  project_id       VARCHAR(64) NULL,
  account_id       VARCHAR(64) NOT NULL DEFAULT 'default',
  job_id           VARCHAR(64) NOT NULL DEFAULT '',
  title            VARCHAR(200) NOT NULL DEFAULT '',
  prompt           MEDIUMTEXT NOT NULL,
  duration_seconds INT NOT NULL DEFAULT 0,
  aspect_ratio     VARCHAR(16) NOT NULL DEFAULT '',
  status           VARCHAR(16) NOT NULL DEFAULT 'running',
  asset_id         VARCHAR(64) NULL,
  error            VARCHAR(1000) NOT NULL DEFAULT '',
  created_at       VARCHAR(64) NOT NULL,
  updated_at       VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_render_owner (owner_key, created_at),
  KEY idx_junshi_wb_render_project (project_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE junshi_workbench_copy_drafts
  ADD COLUMN account_id VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE junshi_workbench_video_projects
  ADD COLUMN account_id VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE junshi_workbench_assets
  ADD COLUMN account_id VARCHAR(64) NOT NULL DEFAULT 'default',
  ADD COLUMN folder VARCHAR(120) NOT NULL DEFAULT '';

-- 旧档案回填默认账号（幂等：主键冲突即忽略）。
INSERT IGNORE INTO junshi_workbench_account_profiles (owner_key, account_id, org_id, content, created_at, updated_at)
  SELECT owner_key, 'default', org_id, content, created_at, updated_at FROM junshi_workbench_profiles;

-- 复查（应看到三张新表、四个新列，account_profiles 里每个机构一行 default 档案）：
--   SHOW TABLES LIKE 'junshi_workbench%';
--   SHOW COLUMNS FROM junshi_workbench_assets LIKE 'account_id';
--   SHOW COLUMNS FROM junshi_workbench_assets LIKE 'folder';
