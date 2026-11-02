-- 48 · 桌面客户端问题反馈（2026-11-02）。
--
-- 背景：客户端“问题上报”后续只进入平台后台，不再写机构 help_feedback。
-- 本迁移与 packages/database/src/schema.js 的新增表保持一致。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/48-client-feedback-mysql.sql
-- 回滚（仅在确认没有线上数据时）：
--   DROP TABLE client_feedback_messages;
--   DROP TABLE client_feedback_attachments;
--   DROP TABLE client_feedback;

CREATE TABLE IF NOT EXISTS client_feedback (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  org_id VARCHAR(255) NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description MEDIUMTEXT NOT NULL,
  type VARCHAR(32) NOT NULL,
  severity VARCHAR(32) NULL,
  module VARCHAR(255) NULL,
  contact VARCHAR(255) NULL,
  environment MEDIUMTEXT NOT NULL,
  device_mid VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'SUBMITTED',
  resolution MEDIUMTEXT NULL,
  handled_by VARCHAR(255) NULL,
  handled_at VARCHAR(64) NULL,
  created_at VARCHAR(64) NOT NULL,
  updated_at VARCHAR(64) NOT NULL,
  KEY idx_client_feedback_status_time (status, created_at),
  KEY idx_client_feedback_user_time (user_id, created_at),
  KEY idx_client_feedback_org_time (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS client_feedback_attachments (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  feedback_id VARCHAR(64) NOT NULL,
  file_id VARCHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  filename VARCHAR(500) NOT NULL,
  mime_type VARCHAR(255) NULL,
  file_size BIGINT NULL,
  created_at VARCHAR(64) NOT NULL,
  KEY idx_client_feedback_attachments_feedback (feedback_id, created_at),
  KEY idx_client_feedback_attachments_file (file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS client_feedback_messages (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  feedback_id VARCHAR(64) NOT NULL,
  sender_type VARCHAR(32) NOT NULL,
  sender_user_id VARCHAR(255) NULL,
  body MEDIUMTEXT NOT NULL,
  created_at VARCHAR(64) NOT NULL,
  KEY idx_client_feedback_messages_feedback (feedback_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
