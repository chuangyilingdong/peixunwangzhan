-- 44 · 内容工作台十七期：对话附件 / 任务详情与重试 / 数字人语速与分段（2026-10-25）。
--
-- 背景（用户 2026-10-25 口径）：
--   1. 对话附件补齐视频/音频与 @图片N/@视频N/@音频N 引用（9 图 / 3 视频 / 3 音频）；
--   2. 历史任务要能看失败原因、按类型筛选、单任务重试；
--   3. 数据复盘恢复截图回填入口（文案草稿页已删，不能再依赖 copy_drafts）；
--   4. 数字人补语速四档、分段生成与失败分段重试。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/44-junshi-workbench-attachments-jobs-avatar-mysql.sql
-- 回滚（按需）：
--   DROP TABLE junshi_workbench_review_snapshots;
--   ALTER TABLE junshi_workbench_messages DROP COLUMN attachments;
--   ALTER TABLE junshi_workbench_jobs DROP COLUMN error, DROP COLUMN entity_type, DROP COLUMN entity_id,
--     DROP COLUMN attempts, DROP COLUMN payload, DROP COLUMN retry_of;
--   ALTER TABLE junshi_workbench_avatar_runs DROP COLUMN speed, DROP COLUMN segments,
--     DROP COLUMN meta, DROP COLUMN duration_seconds;
-- 复查：
--   SHOW COLUMNS FROM junshi_workbench_messages LIKE 'attachments';
--   SHOW COLUMNS FROM junshi_workbench_jobs LIKE 'entity_type';
--   SHOW COLUMNS FROM junshi_workbench_avatar_runs LIKE 'segments';
--   SHOW TABLES LIKE 'junshi_workbench_review_snapshots';

-- 对话消息上的附件元数据：JSON 数组（id/kind/index/label/fileName/mimeType）。
-- MySQL 的 TEXT 不能有字面量默认值，应用写空数组时显式给 '[]'。
ALTER TABLE junshi_workbench_messages ADD COLUMN attachments TEXT NULL;

-- 任务流水：失败原因与可重试对象。
-- detail 仍是给人看的一句话；error 单独存失败原因；entity_type/entity_id 指向可重跑的资源。
ALTER TABLE junshi_workbench_jobs ADD COLUMN error TEXT NULL;
ALTER TABLE junshi_workbench_jobs ADD COLUMN entity_type VARCHAR(40) NOT NULL DEFAULT '';
ALTER TABLE junshi_workbench_jobs ADD COLUMN entity_id VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE junshi_workbench_jobs ADD COLUMN attempts INT NOT NULL DEFAULT 0;
ALTER TABLE junshi_workbench_jobs ADD COLUMN payload TEXT NULL;
ALTER TABLE junshi_workbench_jobs ADD COLUMN retry_of VARCHAR(64) NOT NULL DEFAULT '';

-- 数字人：语速、分段状态、分段中间产物引用（baseUrl/sessionId/faceId 等）、成片总时长。
ALTER TABLE junshi_workbench_avatar_runs ADD COLUMN speed VARCHAR(32) NOT NULL DEFAULT 'natural';
ALTER TABLE junshi_workbench_avatar_runs ADD COLUMN segments TEXT NULL;
ALTER TABLE junshi_workbench_avatar_runs ADD COLUMN meta TEXT NULL;
ALTER TABLE junshi_workbench_avatar_runs ADD COLUMN duration_seconds DOUBLE NOT NULL DEFAULT 0;

-- 数据复盘截图回填独立留存：与 copy_drafts 解耦，草稿页删除后仍然能新增/更新。
-- stats 与五期同口径（plays/likes/comments/shares/saves/publishedAt/backfilledAt/note）。
CREATE TABLE IF NOT EXISTS junshi_workbench_review_snapshots (
  id          VARCHAR(64) NOT NULL,
  owner_key   VARCHAR(64) NOT NULL,
  org_id      VARCHAR(64) NULL,
  account_id  VARCHAR(64) NOT NULL DEFAULT 'default',
  topic       VARCHAR(200) NOT NULL DEFAULT '',
  asset_id    VARCHAR(64) NULL,
  stats       TEXT NULL,
  created_at  VARCHAR(64) NOT NULL,
  updated_at  VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_review_owner (owner_key, account_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 任务列表按 owner + created_at 已有索引；类型筛选再加一条覆盖索引。
ALTER TABLE junshi_workbench_jobs ADD KEY idx_junshi_wb_job_owner_kind (owner_key, kind, created_at);
