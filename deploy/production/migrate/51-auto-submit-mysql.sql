-- 51 · 课堂结束自动提交（2026-11-03）
--
-- 两个来源各加一列「是否系统自动提交」：
--   · works.auto_submitted                 画布：老师结束课堂时用服务器最后一次自动保存的快照提交
--   · vibecoding_submissions.auto_submitted 客户端：课堂结束后的 10 分钟宽限期内自动补交
--
-- 只标记来源，不改判重键、不改审核/发布规则：
--   · 自动提交的画布作品 copyright_confirmed_at 为空 → 老师能看到，但不能进作品广场；
--   · 手动提交过的 VibeCoding 作品不会被自动提交覆盖（服务端拦）。
--
-- 执行（在服务器上）：
--   ⚠️ 先跑本迁移，再发新版应用（新版 INSERT 会写这一列；老版不写，靠默认值 0，兼容）。
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/51-auto-submit-mysql.sql
--
-- 回滚（按需）：
--   ALTER TABLE works DROP COLUMN auto_submitted;
--   ALTER TABLE vibecoding_submissions DROP COLUMN auto_submitted;
--
-- 复查：
--   SHOW COLUMNS FROM works LIKE 'auto_submitted';
--   SHOW COLUMNS FROM vibecoding_submissions LIKE 'auto_submitted';

-- works
SET @has_works := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'works' AND column_name = 'auto_submitted'
);
SET @ddl := IF(@has_works = 0,
  'ALTER TABLE `works` ADD COLUMN `auto_submitted` TINYINT NOT NULL DEFAULT 0 AFTER `canvas_snapshot`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- vibecoding_submissions
SET @has_submission := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'vibecoding_submissions' AND column_name = 'auto_submitted'
);
SET @ddl := IF(@has_submission = 0,
  'ALTER TABLE `vibecoding_submissions` ADD COLUMN `auto_submitted` TINYINT NOT NULL DEFAULT 0 AFTER `client_task_id`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
