-- 49 · VibeCoding 作品提交按「客户端任务」隔离（2026-11-02）
--
-- 背景：桌面客户端的一个工作区可以并行 N 个任务（ZCode session），每个任务各自产出一件作品。
-- 平台原来只按 (conversation_id, entry_file) 判重：
--   · 两个任务都产出 index.html → 后交的覆盖前一个；
--   · 学生想「任务 A 交一件、任务 B 再交一件」做不到。
--
-- 本次把判重键升级为 (conversation_id, client_task_id, entry_file)：
--   · 同一个任务重复提交 = 覆盖（round+1），符合「覆盖没问题」；
--   · 不同任务即使入口同名 = 各自成条，学生主页/广场/审核都能分别看到；
--   · 老客户端不传 taskId → 空串 → 判重键退化成 (conversation_id, entry_file)，**行为与改动前完全一致**。
--
-- 兼容性：
--   · 只加一列 + 换唯一索引，不改任何现有数据；
--   · 老记录的 client_task_id 全部是空串，原两列唯一性仍然成立（旧索引保证过）。
--
-- 执行（在服务器上）：
--   ⚠️ 顺序：**先跑本迁移，再发新版应用**（新版 INSERT 会显式写 client_task_id；老版应用不写，
--      靠列默认值空串，仍然兼容）。先发版后迁移会让新版的 INSERT 报 Unknown column。
--   建议先备份：mysqldump --defaults-file=/root/.my.cnf -D aild_admin vibecoding_submissions > vibecoding_submissions.bak.sql
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/49-vibecoding-task-submit-mysql.sql
--
-- 回滚（按需，顺序不能反）：
--   ALTER TABLE vibecoding_submissions DROP INDEX idx_vibe_submission_conversation_task_entry;
--   CREATE UNIQUE INDEX idx_vibe_submission_conversation_entry ON vibecoding_submissions (conversation_id, entry_file);
--   ALTER TABLE vibecoding_submissions DROP COLUMN client_task_id;
--
-- 复查：
--   SHOW COLUMNS FROM vibecoding_submissions LIKE 'client_task_id';
--   SHOW INDEX FROM vibecoding_submissions
--     WHERE Key_name IN ('idx_vibe_submission_conversation_entry','idx_vibe_submission_conversation_task_entry');
--   -- 如果下面还看到**别的**唯一索引恰好只覆盖 (conversation_id, entry_file)，也要手工 DROP：
--   SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols
--     FROM information_schema.statistics
--    WHERE table_schema = DATABASE() AND table_name = 'vibecoding_submissions' AND NON_UNIQUE = 0
--    GROUP BY INDEX_NAME;
--
-- 说明：三段都写成幂等的（先查 information_schema 再决定执行哪条），重复跑不会报错。

-- ① 加列
SET @has_column := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'vibecoding_submissions'
     AND column_name = 'client_task_id'
);
SET @ddl := IF(@has_column = 0,
  'ALTER TABLE `vibecoding_submissions` ADD COLUMN `client_task_id` VARCHAR(200) NOT NULL DEFAULT '''''' AFTER `conversation_id`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ② 旧的两列唯一索引让位（它会把「不同任务、同名入口」挡住）
SET @has_old_index := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'vibecoding_submissions'
     AND index_name = 'idx_vibe_submission_conversation_entry'
);
SET @ddl := IF(@has_old_index > 0,
  'DROP INDEX `idx_vibe_submission_conversation_entry` ON `vibecoding_submissions`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ②b 更老的单列 UNIQUE(conversation_id) 也要让位（SQLite 侧当年是重建表去掉的；
--     MySQL 侧如果还留着，会让「一个对话只能有一条提交」，第二件作品直接撞唯一键）。
SET @legacy_single_name := (
  SELECT INDEX_NAME FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'vibecoding_submissions'
     AND NON_UNIQUE = 0
   GROUP BY INDEX_NAME
  HAVING COUNT(*) = 1 AND MAX(COLUMN_NAME) = 'conversation_id'
   LIMIT 1
);
SET @ddl := IF(@legacy_single_name IS NULL,
  'SELECT 1',
  CONCAT('DROP INDEX `', @legacy_single_name, '` ON `vibecoding_submissions`'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ③ 新的三列唯一索引
SET @has_new_index := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'vibecoding_submissions'
     AND index_name = 'idx_vibe_submission_conversation_task_entry'
);
SET @ddl := IF(@has_new_index = 0,
  'CREATE UNIQUE INDEX `idx_vibe_submission_conversation_task_entry` ON `vibecoding_submissions` (`conversation_id`, `client_task_id`, `entry_file`)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
