-- 57 · 生成/算力汇总的冷读索引（2026-11-12）。
--
-- 背景：画布列表轮询的 succeeded/failed/costFen 已加 30 秒缓存（services/generationPollCache.js），
--   但缓存冷启动（每个学生每 30 秒至少一次）仍要按 user_id + org_id + status 聚合：
--     · generation_jobs 原来只有 (user_id, org_id, created_at) —— status 过滤要扫完该用户全部任务；
--     · compute_attempts 原来只有 (org_id, created_at) —— user_id + status 只能回表过滤。
--
-- 本迁移只加两个索引，不改数据。执行（服务器上，低峰期）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/57-cold-read-indexes-mysql.sql
-- 执行前先确认没有同义索引：
--   SHOW INDEX FROM generation_jobs;
--   SHOW INDEX FROM compute_attempts;
-- 回滚：
--   DROP INDEX idx_generation_jobs_user_status ON generation_jobs;
--   DROP INDEX idx_compute_attempts_user_status ON compute_attempts;

CREATE INDEX idx_generation_jobs_user_status
  ON generation_jobs (user_id, org_id, status);

-- ⚠️ compute_attempts.user_id / status 在老库里是 MEDIUMTEXT，MySQL 不允许直接进索引键，
--    所以用前缀：user_id(64)（我们自己的 id 都在 64 字符内）、status(16)（SUCCESS/FAILED/…）。
--    不做成覆盖索引也没关系 —— 这个索引的用途是先把 user+org 的行收窄，SUM 再回表。
CREATE INDEX idx_compute_attempts_user_status
  ON compute_attempts (org_id, user_id(64), status(16), sale_price_fen);
