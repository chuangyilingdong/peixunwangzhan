-- 20 个「部分索引」的 MySQL 等价写法
--
-- 背景：SQLite 支持 `CREATE INDEX … WHERE <条件>`（只索引满足条件的行），MySQL 没有这个概念。
-- 这批索引**大多不是性能索引，而是业务约束** —— 直接丢掉等于把规则丢了
-- （例如「同一个学生在未移除的前提下只能有一条」「同一节课里同一学生只能有一条有效记录」）。
-- 所以逐条给等价写法，**一条都不丢**。
--
-- 三种情况，三种写法（下面按类型分组）：
--   A. 本来就**不是** UNIQUE 的：条件只是为了让索引小一点 → 换成普通索引即可（多索引几行 NULL 无害）
--   B. UNIQUE 但条件只有 `… IS NOT NULL`：**普通 UNIQUE 就等价** ——
--      SQL 的唯一索引把多个 NULL 当作互不相同的值，所以「只对非 NULL 唯一」正是它的默认行为
--   C. UNIQUE 且条件里有别的业务判断（status=… / removed_at IS NULL / org_code<>'' …）：
--      用 MySQL 8.0.13+ 的**函数索引**（`UNIQUE KEY ((表达式))`）表达同一个条件，
--      表达式在"不满足条件"时返回 NULL —— 于是语义与 SQLite 的部分唯一索引**完全一致**。
--      （它实现为隐藏虚拟列，不改表结构、不影响 `SELECT *`。）
--
-- ⚠️ 执行顺序：等 12 号脚本生成的建表语句灌完**之后**再跑这个（表得先存在）。
-- ⚠️ 拼接必须包一层 MD5：CONCAT() 返回 TEXT，MySQL **不允许**在返回 TEXT/BLOB 的表达式上建索引
--   （实测 ERROR 3757），而 MD5 返回 32 字符的字符串 —— 既躲开类型限制，也躲开 3072 字节的键长上限。
-- ⚠️ 分隔符用 `:`：所有 id 都是 `前缀_随机串` 形状，不含 `:`，所以拼起来不会撞。

-- ─────────────────────────── A. 普通索引（原来就不是唯一） ───────────────────────────
CREATE INDEX `idx_course_series_cover_asset` ON `course_series` (`cover_asset_id`);           -- 原型: … WHERE cover_asset_id IS NOT NULL
CREATE INDEX `idx_file_access_grants_org` ON `file_access_grants` (`org_id`);                 -- 原型: … WHERE org_id IS NOT NULL
CREATE INDEX `idx_file_access_grants_user` ON `file_access_grants` (`user_id`);               -- 原型: … WHERE user_id IS NOT NULL
CREATE INDEX `idx_file_access_grants_role` ON `file_access_grants` (`role`);                  -- 原型: … WHERE role IS NOT NULL
CREATE INDEX `idx_notification_recipient_failed` ON `notification_recipients` (`user_id`, `delivery_status`, `ignored`);  -- 原型: … WHERE delivery_status='FAILED'

-- ────────────────── B. UNIQUE + 只有 IS NOT NULL → 普通 UNIQUE 等价 ──────────────────
CREATE UNIQUE INDEX `idx_credit_entries_reversal_of` ON `credit_entries` (`reversal_of`);     -- 原型: … WHERE reversal_of IS NOT NULL
CREATE UNIQUE INDEX `idx_file_assets_storage_key` ON `file_assets` (`storage_key`);           -- 原型: … WHERE storage_key IS NOT NULL
CREATE UNIQUE INDEX `idx_license_revenue_one_reversal` ON `license_revenue_events` (`reversal_of_event_id`);  -- 原型: … WHERE reversal_of_event_id IS NOT NULL
CREATE UNIQUE INDEX `idx_vibe_submission_share_token` ON `vibecoding_submissions` (`share_token`);  -- 原型: … WHERE share_token IS NOT NULL
CREATE UNIQUE INDEX `idx_work_feedback_reads_annotation` ON `work_feedback_reads` (`annotation_id`);  -- 原型: … WHERE annotation_id IS NOT NULL
CREATE UNIQUE INDEX `idx_works_share_token` ON `works` (`share_token`);                       -- 原型: … WHERE share_token IS NOT NULL

-- ─────────── C. UNIQUE + 带业务条件 → 函数索引（不满足条件时表达式为 NULL） ───────────
-- 「同一个学生在未移除的前提下只能有一条」
CREATE UNIQUE INDEX `idx_class_members_unique` ON `class_members`
  ((IF(`removed_at` IS NULL, MD5(CONCAT(`class_id`, ':', `user_id`)), NULL)));

-- 「同一机构下，启用中的班级名不能重复」
CREATE UNIQUE INDEX `idx_classes_org_active_name` ON `classes`
  ((IF(`status` = 'ACTIVE', MD5(CONCAT(`org_id`, ':', `name`)), NULL)));

-- 「平台自营的课程系列标题不能重复」
CREATE UNIQUE INDEX `idx_course_series_platform_title` ON `course_series`
  ((IF(`owner_type` = 'PLATFORM', `title`, NULL)));

-- 「机构码必须唯一，且空串不算」（注意：不能只写 UNIQUE(org_code)，否则多个空串会互相冲突）
CREATE UNIQUE INDEX `idx_organizations_org_code` ON `organizations`
  ((IF(`org_code` IS NULL OR `org_code` = '', NULL, `org_code`)));

-- 「同一供应商账号 + 同一账期 + 同一响应内容，只能有一条已抓取的成功快照」（幂等键）
CREATE UNIQUE INDEX `idx_provider_bill_snapshot_idempotency` ON `provider_bill_snapshots`
  ((IF(`status` = 'FETCHED', MD5(CONCAT(`supplier_account_id`, ':', `period_start`, ':', `period_end`, ':', `response_hash`)), NULL)));

-- 「同一节课里同一学生只能有一条有效记录」
CREATE UNIQUE INDEX `idx_session_students_unique` ON `session_students`
  ((IF(`status` <> 'REMOVED', MD5(CONCAT(`session_id`, ':', `student_id`)), NULL)));

-- 「一个学生同时只能有一条 ACTIVE 的报名」
CREATE UNIQUE INDEX `idx_student_enrollments_active_student` ON `student_enrollments`
  ((IF(`status` = 'ACTIVE', `student_id`, NULL)));

-- 「同一行账单 + 同一目标，只能有一条未取消的匹配」
CREATE UNIQUE INDEX `idx_supplier_matches_active_target` ON `supplier_billing_matches`
  ((IF(`cancelled_at` IS NULL, MD5(CONCAT(`line_id`, ':', `target_type`, ':', `target_id`)), NULL)));

-- 「同一作品同时只能有一条 PENDING 的发布申请」
CREATE UNIQUE INDEX `idx_work_publish_requests_open` ON `work_publish_requests`
  ((IF(`status` = 'PENDING', `work_id`, NULL)));

-- ─────────────────────────────── 验收：三类各自怎么验 ───────────────────────────────
-- ① 索引都在（应为 20）：
--   SELECT COUNT(*) FROM information_schema.statistics
--    WHERE table_schema = DATABASE()
--      AND index_name IN ('idx_class_members_unique','idx_classes_org_active_name','idx_course_series_platform_title',
--        'idx_course_series_cover_asset','idx_credit_entries_reversal_of','idx_file_access_grants_org',
--        'idx_file_access_grants_user','idx_file_access_grants_role','idx_file_assets_storage_key',
--        'idx_license_revenue_one_reversal','idx_notification_recipient_failed','idx_organizations_org_code',
--        'idx_provider_bill_snapshot_idempotency','idx_session_students_unique','idx_student_enrollments_active_student',
--        'idx_supplier_matches_active_target','idx_vibe_submission_share_token','idx_work_feedback_reads_annotation',
--        'idx_work_publish_requests_open','idx_works_share_token');
-- ② 业务约束真的还在（拿一条最容易验的）：往 student_enrollments 插两条 ACTIVE 同学生，第二条必须被拒
-- ③ 条件不成立时不受约束：再插一条 status='CANCELLED' 的同学生记录，必须成功
