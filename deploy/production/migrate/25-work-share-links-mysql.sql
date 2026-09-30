-- 25 · 新建 `work_share_links`：**学生主页侧**的作品分享码（2026-09-30 用户口径）。
--
-- 口径（与 `24-usage-cache-columns-mysql.sql` 同一套写法：SQLite 侧由 schema.js 自动建，MySQL 侧手工执行）：
--   ⭐ **只服务学生主页，与作品广场完全解耦** —— 广场的 `works.share_token` 只在"公开到广场"时才发；
--      这里的码"想分享就分享"，**扫它不改变任何公开状态**（不动 is_public、不动 share_token、不进审核）。
--   ⭐ 粒度 = **一件产出物**（一节课出 1 张图 + 1 段视频 → 两枚码）。
--   ⚠️ 码不透明（`shs_` + 随机），**不带学生主页 token**。
--   `piece_key` = 那一件的稳定标识（画布 `media:<fileId|url>`、VibeCoding `artifact:<文件名>`）；
--   打开时按它去**最新那一版**找 → 旧码自动指向最新内容（用户口径：提交了就是最新的）。
--
-- 执行（在服务器上，RDS 只给同 VPC 内网）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/25-work-share-links-mysql.sql
-- 回滚：`DROP TABLE work_share_links;`（只存分享码，删了学生重新点分享就回来）
--
-- 类型照本库的既有风格（id 类 varchar(64)；时间戳存 ISO 文本；不加外键以免与既有表风格不一致 —— 既有表都在
-- SQLite 侧声明外键、MySQL 侧由 DDL 生成器省略外键约束）。

CREATE TABLE IF NOT EXISTS work_share_links (
  code VARCHAR(64) NOT NULL,
  student_id VARCHAR(64) NOT NULL,
  org_id VARCHAR(64) NOT NULL,
  source VARCHAR(16) NOT NULL,
  work_id VARCHAR(64) NOT NULL,
  piece_key VARCHAR(255) NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  PRIMARY KEY (code),
  UNIQUE KEY idx_work_share_links_unique (student_id, source, work_id, piece_key),
  KEY idx_work_share_links_student (student_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：
--   SHOW COLUMNS FROM work_share_links;
