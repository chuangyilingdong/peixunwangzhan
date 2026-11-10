-- 55 · 普通课 = S1+S2+S3 共 48 节一个池子（2026-11-10 用户口径 1A / 2B / 3A）。
--
-- ⚠️ 这是**破坏性**迁移（用户明确选择 B：测试机构/测试数据重置为 100 次、学生次数清零）：
--    · 普通课池子重置为 100 次 / 已用 0；
--    · 所有普通课的学生许可全部标记撤销（历史保留，机构可重新授权）；
--    · 体验课数据**完全不动**。
--    执行前务必确认 production backups 里有一份切换前的库备份。
--
-- 结构部分：
--   · 许可三账 / 库存流水加 scope_type / scope_key（普通课=NORMAL/NORMAL，体验课=SERIES/series_id）；
--   · 不新增表、不改 student_course_grants 的唯一键。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/55-normal-curriculum-pool-mysql.sql

-- ── 1. 加范围字段（一次性；重复执行会报 duplicate column，属正常） ──────────────
ALTER TABLE license_purchase_batches ADD COLUMN scope_type VARCHAR(32) NOT NULL DEFAULT 'SERIES';
ALTER TABLE license_purchase_batches ADD COLUMN scope_key VARCHAR(255) NULL;
ALTER TABLE license_revenue_events ADD COLUMN scope_type VARCHAR(32) NOT NULL DEFAULT 'SERIES';
ALTER TABLE license_revenue_events ADD COLUMN scope_key VARCHAR(255) NULL;
ALTER TABLE course_quota_changes ADD COLUMN scope_type VARCHAR(32) NOT NULL DEFAULT 'SERIES';
ALTER TABLE course_quota_changes ADD COLUMN scope_key VARCHAR(255) NULL;

-- ── 2. 回填范围（按系列类型）────────────────────────────────────────────────
UPDATE license_purchase_batches b
  JOIN course_series s ON s.id=b.series_id
   SET b.scope_type = IF(s.series_type='NORMAL','NORMAL','SERIES'),
       b.scope_key  = IF(s.series_type='NORMAL','NORMAL',b.series_id)
 WHERE b.scope_key IS NULL;

UPDATE license_revenue_events e
  JOIN course_series s ON s.id=e.series_id
   SET e.scope_type = IF(s.series_type='NORMAL','NORMAL','SERIES'),
       e.scope_key  = IF(s.series_type='NORMAL','NORMAL',e.series_id)
 WHERE e.scope_key IS NULL;

UPDATE course_quota_changes c
  JOIN course_series s ON s.id=c.series_id
   SET c.scope_type = IF(s.series_type='NORMAL','NORMAL','SERIES'),
       c.scope_key  = IF(s.series_type='NORMAL','NORMAL',c.series_id)
 WHERE c.scope_key IS NULL;

-- ── 3. 普通课池子 = 最早的普通课系列（生产里是 S1）──────────────────────────
SET @pool_id := (
  SELECT id FROM course_series
   WHERE owner_type='PLATFORM' AND series_type='NORMAL'
   ORDER BY created_at, id LIMIT 1
);

-- 3.1 有普通课授权的机构：没有池子授权单的先建一张（100 次 / 已用 0）
INSERT INTO course_assignments(id,series_id,org_id,status,assigned_by,assigned_at,expires_at,quota_total,quota_used)
SELECT CONCAT('assign_normalpool_', o.id), @pool_id, o.id, 'ACTIVE', NULL, NOW(), o.contract_expires_at, 100, 0
  FROM organizations o
 WHERE EXISTS (
   SELECT 1 FROM course_assignments a JOIN course_series s ON s.id=a.series_id
    WHERE a.org_id=o.id AND s.series_type='NORMAL'
 )
   AND NOT EXISTS (
   SELECT 1 FROM course_assignments a WHERE a.org_id=o.id AND a.series_id=@pool_id
 );

-- 3.2 池子授权单统一 100 次 / 已用 0（B：重置）
UPDATE course_assignments
   SET quota_total=100, quota_used=0, status='ACTIVE'
 WHERE series_id=@pool_id;

-- 3.3 其它普通课系列：0 次数（只保留"可上课/可查阅"的访问权）
UPDATE course_assignments a
  JOIN course_series s ON s.id=a.series_id
   SET a.quota_total=0, a.quota_used=0
 WHERE s.series_type='NORMAL' AND a.series_id<>@pool_id;

-- 3.4 每个有池子授权的机构 × 每个普通课系列，都补齐 0 次数的访问授权
INSERT INTO course_assignments(id,series_id,org_id,status,assigned_by,assigned_at,expires_at,quota_total,quota_used)
SELECT CONCAT('na_', LEFT(MD5(CONCAT(o.id,'|',s.id)), 32)), s.id, o.id, 'ACTIVE', NULL, NOW(), o.contract_expires_at, 0, 0
  FROM organizations o
  JOIN course_series s ON s.owner_type='PLATFORM' AND s.series_type='NORMAL'
 WHERE EXISTS (SELECT 1 FROM course_assignments p WHERE p.org_id=o.id AND p.series_id=@pool_id)
   AND NOT EXISTS (SELECT 1 FROM course_assignments a WHERE a.org_id=o.id AND a.series_id=s.id);

-- ── 4. 学生普通课次数清零（B）：全部标记撤销，历史保留可审计 ──────────────────
UPDATE student_course_grants g
  JOIN course_series s ON s.id=g.series_id
   SET g.revoked_at=NOW(), g.revoke_reason='普通课池子重置（2026-11-10）'
 WHERE s.series_type='NORMAL' AND g.revoked_at IS NULL;

-- ── 5. 自检 ─────────────────────────────────────────────────────────────────
SELECT '普通课池子' AS item, @pool_id AS value;
SELECT '普通课池子授权单' AS item, COUNT(*) AS n FROM course_assignments WHERE series_id=@pool_id;
SELECT '普通课访问授权（0 次数）' AS item, COUNT(*) AS n
  FROM course_assignments a JOIN course_series s ON s.id=a.series_id
 WHERE s.series_type='NORMAL' AND a.series_id<>@pool_id AND a.quota_total=0;
SELECT '仍有效的普通课学生许可（应为 0）' AS item, COUNT(*) AS n
  FROM student_course_grants g JOIN course_series s ON s.id=g.series_id
 WHERE s.series_type='NORMAL' AND g.revoked_at IS NULL;
