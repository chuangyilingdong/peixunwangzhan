-- 54 · 生成产物归档队列的取件索引（2026-11-11）。
--
-- 背景：generatedAssetArchiveQueue.pickCandidates 每 2 秒取一批“还没归档”的占位行。
-- 原来的条件是 `(storage_key IS NULL OR storage_key='')` + `metadata LIKE '%...%'`；
-- 前面的 OR 让 MySQL 很难用索引，行数一多就变成对 file_assets 的全表扫描。
--
-- 这里只做两件低风险的事：
--   ① 把历史空串归一化成 NULL（新代码只写 NULL）；
--   ② 补 (storage_key, created_at) 索引，让 `WHERE storage_key IS NULL ORDER BY created_at`
--      能只扫 NULL 的那几行。
--
-- 更彻底的方案是独立队列表（generated_archive_queue）—— 那个会碰创建/认领/归档/重试多处，
-- 放到下一批单独做；本索引是先把 DB 热点压下去的过渡措施。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/54-archive-pending-index-mysql.sql
-- 回滚：
--   DROP INDEX idx_file_assets_pending_created ON file_assets;

UPDATE file_assets SET storage_key = NULL WHERE storage_key = '';
CREATE INDEX idx_file_assets_pending_created ON file_assets (storage_key, created_at);
