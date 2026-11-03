-- 52 · 作品调用模型（2026-11-03）
--
-- 背景：学生作品要在运行时调大模型（作品里的「接口设置」不再要求填 Key）。
-- 这套配置**独立于 ai_provider_policy**：Agent 的渠道/路由/模型下拉一概不动，
-- 作品只认 platform_settings.works_llm 这一份；Key 走 providerSecret('works-llm')。
--
-- 内容：
--   ① platform_settings.works_llm  JSON 配置（enabled/endpoint/model/配额…）
--   ② work_llm_usage              按 (day, scope, subject) 的日计数（配额用，不做账单）
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/52-work-llm-mysql.sql
--
-- 回滚（按需；先停用后台「作品调用模型」开关再回滚）：
--   DROP TABLE work_llm_usage;
--   ALTER TABLE platform_settings DROP COLUMN works_llm;
--
-- 复查：
--   SHOW COLUMNS FROM platform_settings LIKE 'works_llm';
--   SHOW CREATE TABLE work_llm_usage;

SET @has_column := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'platform_settings'
     AND column_name = 'works_llm'
);
SET @ddl := IF(@has_column = 0,
  'ALTER TABLE `platform_settings` ADD COLUMN `works_llm` MEDIUMTEXT COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (''{}'')',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS work_llm_usage (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  day VARCHAR(10) NOT NULL,
  scope VARCHAR(16) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  calls INT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  UNIQUE KEY idx_work_llm_usage_subject (day, scope, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
