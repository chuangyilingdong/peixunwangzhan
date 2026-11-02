-- 50 · client_feedback 三张表排序规则对齐（2026-11-02）
--
-- 48 建表时写成了 `utf8mb4_general_ci`，而 users / organizations / file_assets 是
-- `utf8mb4_unicode_ci`。后台列表的
--   JOIN users submitter ON submitter.id = feedback.user_id
-- 在 MySQL 上直接报：
--   ER_CANT_AGGREGATE_2COLLATIONS
--   Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT)
-- → 平台后台「客户端问题反馈」列表 500「服务器内部错误」。
--
-- 本迁移把三张表转成与全库一致的 `utf8mb4_unicode_ci`（只改字符集/排序规则，不动数据）；
-- 48 的建表语句也已同步修正，新库不会再出现这个问题。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/50-client-feedback-collation-mysql.sql
--
-- 复查：
--   SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME IN ('client_feedback','client_feedback_attachments','client_feedback_messages');
--   SELECT COUNT(*) FROM client_feedback feedback JOIN users submitter ON submitter.id = feedback.user_id;

ALTER TABLE client_feedback CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE client_feedback_attachments CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE client_feedback_messages CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
