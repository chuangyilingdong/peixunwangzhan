-- 34 · 内容工作台六期：文案大脑 / 同行研究简报（2026-10-25，机构级）。
--
-- 蒸馏自带时间码的转写档案：copy_brain=文案大脑（创作流「选写作大脑」时调用），
-- peer_report=同行研究简报（同行观察页）。交互链路对齐原版 XiaoLingDang 的
-- copy_brain_reports / peer_account_reports（作者本人授权复刻）。
--
-- 口径与 29-33 一致：SQLite 由 schema.js 自动建；生产 RDS 手工执行，纯新增表，可以先跑。
-- ⚠️ TEXT/MEDIUMTEXT 列不给默认值（32/33 两期的教训）：应用层 INSERT 显式给全所有列。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/34-junshi-workbench-brains-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_brains;

CREATE TABLE IF NOT EXISTS junshi_workbench_brains (
  id          VARCHAR(64) NOT NULL,
  owner_key   VARCHAR(64) NOT NULL,
  org_id      VARCHAR(64) NULL,
  account_id  VARCHAR(64) NOT NULL DEFAULT 'default',
  kind        VARCHAR(16) NOT NULL DEFAULT 'copy_brain',
  name        VARCHAR(200) NOT NULL DEFAULT '',
  status      VARCHAR(16) NOT NULL DEFAULT 'running',
  error       VARCHAR(1000) NOT NULL DEFAULT '',
  profile     MEDIUMTEXT NOT NULL,
  sections    MEDIUMTEXT NOT NULL,
  source_note VARCHAR(1000) NOT NULL DEFAULT '',
  created_at  VARCHAR(64) NOT NULL,
  updated_at  VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_brain_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：SHOW TABLES LIKE 'junshi_workbench_brains';
