-- 28 · 新建招生军师的会话与消息两张表（2026-10-15，机构级）。
--
-- 口径（与 24/25/27 同一套写法：**SQLite 侧由 schema.js 自动建，MySQL 侧手工执行**）：
--   ⭐ 为什么要有：对话原来只活在前端内存/localStorage —— 换设备看不到、刷新还可能断在中间。
--      机构级产品必须服务端存：同机构同事能接上下文、历史可查、也才有用量统计的基础。
--   ⭐ `owner_key` 与 `junshi_profiles` 同一套口径：`org:<机构id>` / `user:<用户id>` /
--      `anon:<匿名会话id>` —— 匿名也能存，只是不跨设备（让没登录的人刷新也不丢）。
--   ⚠️ `citations` 存 JSON 文本：这一轮引用了哪几份资料。存下来刷新后引用面板才能复原。
--
-- 执行（在服务器上，RDS 只给同 VPC 内网）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/28-junshi-conversations-mysql.sql
-- 回滚：`DROP TABLE junshi_messages; DROP TABLE junshi_conversations;`（只存对话，删了就没了）
--
-- 类型照本库既有风格（id 类 varchar(64)；时间戳存 ISO 文本；不加外键）。

CREATE TABLE IF NOT EXISTS junshi_conversations (
  id            VARCHAR(64)  NOT NULL,
  owner_key     VARCHAR(64)  NOT NULL,
  org_id        VARCHAR(64)  NULL,
  expert_id     VARCHAR(32)  NOT NULL,
  title         VARCHAR(255) NOT NULL DEFAULT '',
  message_count INT          NOT NULL DEFAULT 0,
  created_at    VARCHAR(64)  NOT NULL,
  updated_at    VARCHAR(64)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_conv_owner (owner_key, expert_id, updated_at),
  KEY idx_junshi_conv_org (org_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS junshi_messages (
  id              VARCHAR(64) NOT NULL,
  conversation_id VARCHAR(64) NOT NULL,
  role            VARCHAR(16) NOT NULL,
  content         MEDIUMTEXT  NOT NULL,
  citations       MEDIUMTEXT  NULL,
  created_at      VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_msg_conv (conversation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：
--   SHOW COLUMNS FROM junshi_conversations;
--   SHOW COLUMNS FROM junshi_messages;
