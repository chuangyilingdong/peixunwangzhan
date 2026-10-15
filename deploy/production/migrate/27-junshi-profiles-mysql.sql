-- 27 · 新建 `junshi_profiles`：招生军师（/junshi/）的机构画像（2026-10-15）。
--
-- 口径（与 `24`/`25` 同一套写法：**SQLite 侧由 schema.js 自动建，MySQL 侧手工执行**）：
--   ⭐ 一行 = 一份画像。`owner_key` = `org:<机构id>`（同机构的人共享一份）或 `user:<用户id>`
--      （平台侧没有机构的账号，便于自己试）。
--   ⚠️ 主键**不能用 org_id**：平台侧账号可能没有机构，那种行 org_id 为 NULL，主键放它上面存不进去。
--   ⚠️ 内容按分组整体存 JSON（画像字段以后大概率还会加），不做逐字段列 —— 它没有需要按列检索的查询。
--
-- 为什么会有这个文件：schema.js 里那段 SCHEMA 是 **SQLite 语法**，只在 sqlite 驱动下执行；
--   生产是 RDS(MySQL)，建表必须走这里。**漏了这一步的现象是**：页面能打开、参考数据接口全 200，
--   只有「保存机构画像」会 500（Table 'aild_admin.junshi_profiles' doesn't exist）——
--   2026-10-15 首次发布就是这么过去的，所以补了这个文件。
--
-- 执行（在服务器上，RDS 只给同 VPC 内网）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/27-junshi-profiles-mysql.sql
-- 回滚：`DROP TABLE junshi_profiles;`（只存画像，删了重新填一遍就回来）
--
-- 类型照本库既有风格（id 类 varchar(64)；时间戳存 ISO 文本；不加外键 —— 既有表都在 SQLite 侧
-- 声明外键、MySQL 侧由 DDL 生成器省略外键约束）。

CREATE TABLE IF NOT EXISTS junshi_profiles (
  owner_key  VARCHAR(64)  NOT NULL,
  org_id     VARCHAR(64)  NULL,
  content    MEDIUMTEXT   NOT NULL,
  created_at VARCHAR(64)  NOT NULL,
  updated_at VARCHAR(64)  NOT NULL,
  PRIMARY KEY (owner_key),
  KEY idx_junshi_profiles_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：
--   SHOW COLUMNS FROM junshi_profiles;
