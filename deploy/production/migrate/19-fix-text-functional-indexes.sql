-- 19 号：把两条「返回裸 TEXT 列」的函数索引改成 MD5 形式（**生产 RDS 要手工执行**）
--
-- 为什么需要这个（2026-09-27 实测发现，不是推测）：
--   09-25 那次「444 列拉齐 MEDIUMTEXT」（见交接文档 ⭐3）把 `course_series.title` 与
--   `organizations.org_code` 变成了 MEDIUMTEXT。MySQL **不允许**在返回 TEXT/BLOB 的表达式上建索引
--   （ERROR 3757），于是这两条索引（在 13-partial-indexes-mysql.sql 的 C 组里）成了：
--     · 线上**现在没事** —— 索引当初是按 VARCHAR 建的，MySQL 不会回头重新校验；
--     · **一旦按转储重建就炸** —— 也就是 **mysqldump 出来的备份根本恢复不了**。
--   实测：把生产转储灌进 MySQL 8.0.46，`course_series` 与 `organizations` 两张表建不起来
--   （ERROR 3757），各自还带 4 条 ERROR 1146（表不存在 → 它的 INSERT 全失败）。
--   ⚠️ 只检查"备份文件生成了没有/退出码是不是 0"**完全看不见**这个问题。
--   改完这两条，转储就能干净恢复（本机已往返验证：users 114 / works 503 / course_assignments 16 /
--   course_series 5 / organizations 17，90 张表，与 RDS 逐项一致）。
--
-- 语义没有变化：唯一性原来就是按整个值判的，MD5 只是把它变成定长字符串，
-- 顺带躲开 3072 字节的键长上限。约束强度不变（本机用真数据验过：插入重复仍被拒，ERROR 1062）。
--
-- 执行（在服务器上，凭据走 /root/.my.cnf，不进命令行）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < 19-fix-text-functional-indexes.sql
-- 先看前置检查（两个计数都必须是 **0**，否则重建唯一索引会失败）：
--   本机已用同版本数据验过：都是 0。

-- ───────────────────────── 前置检查：有没有重复值会挡住重建 ─────────────────────────
-- ① 平台自营课程系列里，标题重复的组数（应为 0）
SELECT 'platform_title 重复组数' AS what, COUNT(*) AS groups_found FROM (
  SELECT MD5(`title`) AS k FROM `course_series` WHERE `owner_type` = 'PLATFORM'
   GROUP BY k HAVING COUNT(*) > 1
) x;
-- ② 非空机构码里，重复的组数（应为 0）
SELECT 'org_code 重复组数' AS what, COUNT(*) AS groups_found FROM (
  SELECT MD5(`org_code`) AS k FROM `organizations`
   WHERE `org_code` IS NOT NULL AND `org_code` <> ''
   GROUP BY k HAVING COUNT(*) > 1
) y;

-- ───────────────────────────────── 重建这两条索引 ─────────────────────────────────
-- ⚠️ DROP 和 ADD 放在同一条 ALTER 里：MySQL 会一次做完，中间不会出现"约束暂时不在"的窗口。
ALTER TABLE `course_series`
  DROP INDEX `idx_course_series_platform_title`,
  ADD UNIQUE INDEX `idx_course_series_platform_title` ((IF(`owner_type` = 'PLATFORM', MD5(`title`), NULL)));

ALTER TABLE `organizations`
  DROP INDEX `idx_organizations_org_code`,
  ADD UNIQUE INDEX `idx_organizations_org_code` ((IF(`org_code` IS NULL OR `org_code` = '', NULL, MD5(`org_code`))));

-- ───────────────────────────── 验后检查：两条都该是 MD5 形式 ─────────────────────────────
SELECT TABLE_NAME, INDEX_NAME, EXPRESSION FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND EXPRESSION IS NOT NULL
   AND INDEX_NAME IN ('idx_course_series_platform_title', 'idx_organizations_org_code');
-- ⚠️ 期望两行，且 EXPRESSION 里都含 `md5(`。
-- 终检（拿真数据试一次，必须被拒）：
--   UPDATE organizations SET org_code = (
--     SELECT org_code FROM (SELECT org_code FROM organizations
--        WHERE org_code IS NOT NULL AND org_code <> '' LIMIT 1) t)
--    WHERE id = (SELECT id FROM (SELECT id FROM organizations
--        WHERE org_code IS NOT NULL AND org_code <> '' LIMIT 1 OFFSET 1) t2);
--   → 期望 ERROR 1062 Duplicate entry
