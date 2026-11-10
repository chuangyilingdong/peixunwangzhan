-- 56 · 普通课池子只算 S1/S2/S3（2026-11-10 用户口径：48 节，成人和商家的不要算）
--
-- 背景：55 号迁移把**所有** series_type='NORMAL' 的平台课程都并进了普通课池子，生产实际是 61 节
--       （S1 16 + S2 16 + S3 16 + 实体商家AI全域增长实战班 7 + 成人AIGC短剧实战营 6）。
-- 用户确认：普通课只算 S1/S2/S3 的 48 节；成人/商家两门课不计入节数、也不进池子。
--
-- 本迁移（非破坏性）：
--   1. course_series 增加 include_in_normal_pool（默认 1）；
--   2. 把两门成人/商家课标记为 0；
--   3. 删掉这两门课在机构上的 **0 次数访问授权**（55 号迁移补的）——
--      它们不再作为普通课开放；有次数、有采购批次、有变更流水的授权单一律保留（交人工处理）；
--   4. 把这两门课的历史财务/次数流水的 scope 从 NORMAL 改回 SERIES/<series_id>，避免和 48 节池子混账。
--
-- 学生许可 / 课堂 / 作品 / 体验课数据一律不动。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/56-normal-pool-include-flag-mysql.sql

-- ── 1. 结构：是否计入普通课池子（重复执行会报 duplicate column，属正常）──────────
ALTER TABLE course_series ADD COLUMN include_in_normal_pool TINYINT NOT NULL DEFAULT 1;

-- ── 2. 标记：成人/商家两门独立课程不计入；体验课恒不计入 ─────────────────────
UPDATE course_series
   SET include_in_normal_pool = 0
 WHERE owner_type='PLATFORM'
   AND series_type='NORMAL'
   AND title IN ('实体商家AI全域增长实战班', '成人AIGC短剧实战营');

UPDATE course_series SET include_in_normal_pool=0 WHERE series_type='EXPERIENCE';

-- ── 3. 独立课程不再作为普通课开放：删掉 0 次数访问授权 ──────────────────────
-- 只删「没次数、没用过、没有采购批次、没有变更流水、没有有效学生许可」的授权单；
-- 其它情况保留（宁可留着让能看见，也不误删有账的数据）。
DELETE a FROM course_assignments a
  JOIN course_series s ON s.id = a.series_id
 WHERE s.owner_type='PLATFORM'
   AND s.series_type='NORMAL'
   AND s.include_in_normal_pool=0
   AND a.quota_total=0
   AND a.quota_used=0
   AND NOT EXISTS (SELECT 1 FROM student_course_grants g WHERE g.source_assignment_id=a.id AND g.revoked_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM license_purchase_batches b WHERE b.assignment_id=a.id)
   AND NOT EXISTS (SELECT 1 FROM course_quota_changes c WHERE c.assignment_id=a.id);

-- ── 4. 财务/次数流水范围：独立课程从 NORMAL 改回 SERIES/自身 ─────────────────
UPDATE license_purchase_batches b
  JOIN course_series s ON s.id=b.series_id
   SET b.scope_type='SERIES', b.scope_key=b.series_id
 WHERE s.series_type='NORMAL' AND s.include_in_normal_pool=0 AND b.scope_type='NORMAL';

UPDATE license_revenue_events e
  JOIN course_series s ON s.id=e.series_id
   SET e.scope_type='SERIES', e.scope_key=e.series_id
 WHERE s.series_type='NORMAL' AND s.include_in_normal_pool=0 AND e.scope_type='NORMAL';

UPDATE course_quota_changes c
  JOIN course_series s ON s.id=c.series_id
   SET c.scope_type='SERIES', c.scope_key=c.series_id
 WHERE s.series_type='NORMAL' AND s.include_in_normal_pool=0 AND c.scope_type='NORMAL';

-- ── 5. 自检 ─────────────────────────────────────────────────────────────────
SELECT '普通课节数（应为 48）' AS item, COUNT(*) AS n
  FROM course_lessons l
  JOIN course_series s ON s.id=l.series_id
 WHERE s.owner_type='PLATFORM' AND s.series_type='NORMAL' AND s.include_in_normal_pool<>0
   AND s.status='PUBLISHED' AND l.status='PUBLISHED';

SELECT '普通课池子系列' AS item, id, title
  FROM course_series
 WHERE owner_type='PLATFORM' AND series_type='NORMAL' AND include_in_normal_pool<>0
 ORDER BY created_at, sort, id;

SELECT '未计入普通课的系列' AS item, id, title
  FROM course_series
 WHERE owner_type='PLATFORM' AND include_in_normal_pool=0
 ORDER BY title;

SELECT '独立课程残留的 0 次数访问授权（应为 0）' AS item, COUNT(*) AS n
  FROM course_assignments a
  JOIN course_series s ON s.id=a.series_id
 WHERE s.series_type='NORMAL' AND s.include_in_normal_pool=0 AND a.quota_total=0 AND a.quota_used=0;

SELECT '有效普通课学生许可（迁移前已重置，应仍为 0）' AS item, COUNT(*) AS n
  FROM student_course_grants g
  JOIN course_series s ON s.id=g.series_id
 WHERE s.series_type='NORMAL' AND s.include_in_normal_pool<>0 AND g.revoked_at IS NULL;

SELECT '体验课有效学生许可（应保持 72）' AS item, COUNT(*) AS n
  FROM student_course_grants g
  JOIN course_series s ON s.id=g.series_id
 WHERE s.series_type='EXPERIENCE' AND g.revoked_at IS NULL;
