-- 32 · 内容工作台四期：视频转写档案表（2026-10-24，机构级）。
--
-- 用途：抖音采集/手动上传的视频 → seedance.nz whisper-1 带时间码转写 → 落档案，
-- 供爆款复刻（视频来源）与同行拆解使用。链路复刻原版 XiaoLingDang（作者授权）。
--
-- 口径与 29/30/31 一致：SQLite 由 schema.js 自动建；生产 RDS 手工执行，纯新增表，可以先跑。
-- 漏跑的症状：/api/junshi/workbench/transcripts、/douyin/* 采集接口 500。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/32-junshi-workbench-transcripts-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_transcripts;（档案数据会丢，回滚前先备份）

CREATE TABLE IF NOT EXISTS junshi_workbench_transcripts (
  id               VARCHAR(64) NOT NULL,
  owner_key        VARCHAR(64) NOT NULL,
  org_id           VARCHAR(64) NULL,
  account_id       VARCHAR(64) NOT NULL DEFAULT 'default',
  asset_id         VARCHAR(64) NULL,
  source           VARCHAR(16) NOT NULL DEFAULT 'upload',
  title            VARCHAR(300) NOT NULL DEFAULT '',
  video_url        VARCHAR(1000) NOT NULL DEFAULT '',
  source_url       VARCHAR(1000) NOT NULL DEFAULT '',
  nickname         VARCHAR(200) NOT NULL DEFAULT '',
  duration_seconds DOUBLE NOT NULL DEFAULT 0,
  status           VARCHAR(16) NOT NULL DEFAULT 'running',
  error            VARCHAR(1000) NOT NULL DEFAULT '',
  text             MEDIUMTEXT NOT NULL,
  segments         MEDIUMTEXT NOT NULL,
  created_at       VARCHAR(64) NOT NULL,
  updated_at       VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_ts_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：SHOW TABLES LIKE 'junshi_workbench_transcripts';
