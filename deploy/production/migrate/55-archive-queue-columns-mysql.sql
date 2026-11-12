-- 55 · 生成产物归档队列的索引列（2026-11-11）。
--
-- 背景：generatedAssetArchiveQueue 原来每 2 秒对 file_assets.metadata 做两次
--   `metadata LIKE '%"priority":true%'` / `'%"state":"PENDING"%'`
-- 的扫描；metadata 是 TEXT，前面带 % 的 LIKE 用不了索引，行数一多就是 DB 热点。
--
-- 本迁移给 file_assets 加四列 + 一个取件索引，队列改成：
--   WHERE archive_state='PENDING' ORDER BY archive_priority DESC, created_at ASC
-- metadata.archive 仍保留（读面/审计/排障用），列只是**索引副本**。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/55-archive-queue-columns-mysql.sql
-- 回滚：
--   ALTER TABLE file_assets DROP INDEX idx_file_assets_archive_pick;
--   ALTER TABLE file_assets DROP COLUMN archive_state, DROP COLUMN archive_priority,
--     DROP COLUMN archive_attempts, DROP COLUMN archive_next_attempt_at;

ALTER TABLE file_assets ADD COLUMN archive_state VARCHAR(16) NULL;
ALTER TABLE file_assets ADD COLUMN archive_priority INT NOT NULL DEFAULT 0;
ALTER TABLE file_assets ADD COLUMN archive_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE file_assets ADD COLUMN archive_next_attempt_at VARCHAR(64) NULL;
CREATE INDEX idx_file_assets_archive_pick ON file_assets (archive_state, archive_priority, created_at);

-- 老数据回填：只回填“还没归档”的占位行（storage_key 为空）。
UPDATE file_assets
SET archive_state = UPPER(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.archive.state'))),
    archive_priority = IF(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.archive.priority')) = 'true', 1, 0),
    archive_attempts = COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.archive.attempts')) AS UNSIGNED), 0)
WHERE storage_kind = 'INTERNAL_PROXY'
  AND storage_key IS NULL
  AND status = 'ACTIVE'
  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.archive.state')) IN ('PENDING', 'ARCHIVING', 'FAILED');
