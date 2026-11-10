-- 54 · 授权/回收请求幂等表（2026-11-10，普通课包改成"按课时次数"）。
--
-- 背景：普通课包的 1 次授权从"1 个学生名额"变成"1 个课时次数"，次数可累加。
-- 同一个提交重试两次 = 真扣两次次数，所以机构端每次提交带 idempotencyKey，
-- 由本表保证「同一机构 + 同一 kind + 同一 key 只处理一次」。
--
-- 与 packages/database/src/schema.js 的新增表保持一致。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/54-course-grant-requests-mysql.sql
-- 回滚（仅在确认没有线上数据时）：
--   DROP TABLE course_grant_requests;

CREATE TABLE IF NOT EXISTS course_grant_requests (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  org_id VARCHAR(255) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  result MEDIUMTEXT NULL,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  UNIQUE KEY idx_course_grant_requests_unique (org_id, kind, idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
