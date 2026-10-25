-- 40 · 内容工作台十二期：抖音账号连接（2026-10-25，机构级）。
--
-- 背景：抖音对未登录访问返回 403（作品列表/作品详情都拿不到），四期单条采集与十一期批量同步全部被阻断。
-- 对齐原版 XiaoLingDang 的做法（作者本人授权复刻）：用真实浏览器让用户完成扫码登录，
-- 保存登录态供「自己的账号、同行、文案大脑」共用 —— 原版是桌面端可见窗口，我们是 Web 服务，
-- 改为服务端有头浏览器（Xvfb）截登录二维码 → 前端展示 → 用户手机扫码 → 服务端取 cookie。
--
-- cookie 用与 provider-secrets 同一套 AES-256-GCM（AUTH_PEPPER 派生）加密后存本表。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/40-junshi-workbench-douyin-sessions-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_douyin_sessions;

CREATE TABLE IF NOT EXISTS junshi_workbench_douyin_sessions (
  owner_key    VARCHAR(64) NOT NULL,
  cookie_enc   MEDIUMTEXT NOT NULL,
  user_agent   VARCHAR(500) NOT NULL DEFAULT '',
  nickname     VARCHAR(200) NOT NULL DEFAULT '',
  status       VARCHAR(16) NOT NULL DEFAULT 'connected',
  error        VARCHAR(1000) NOT NULL DEFAULT '',
  connected_at VARCHAR(64) NOT NULL,
  last_used_at VARCHAR(64) NULL,
  updated_at   VARCHAR(64) NOT NULL,
  PRIMARY KEY (owner_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：SHOW TABLES LIKE 'junshi_workbench_douyin_sessions';
