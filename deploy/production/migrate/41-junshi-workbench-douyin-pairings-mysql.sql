-- 41 · 内容工作台十三期：抖音采集助手配对（2026-10-25，机构级）。
--
-- 背景：抖音按出口 IP 风控 —— 生产数据中心 IP 既出不了登录二维码，连游客读作品列表都返回验证页。
-- 但实测「视频 CDN 不拦服务器 IP」（HTTP 200 可下载），所以闭环可以是：
--   用户浏览器（正常 IP + 已登录态）负责「读作品列表」→ 我们的服务器负责「下载 + 转写 + 入库」。
--
-- 采集助手 = 一个一次性安装的浏览器扩展；配对码 = 扩展与机构绑定的一次性凭证。
-- code 只存哈希前的随机串？—— 配对码本身是短的一次性令牌，10 分钟有效、用完即废，
-- 存明文哈希无意义（要能反查比对），因此存 SHA-256。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/41-junshi-workbench-douyin-pairings-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_douyin_pairings;

CREATE TABLE IF NOT EXISTS junshi_workbench_douyin_pairings (
  code_hash  VARCHAR(64) NOT NULL,
  owner_key  VARCHAR(64) NOT NULL,
  org_id     VARCHAR(64) NULL,
  account_id VARCHAR(64) NOT NULL DEFAULT 'default',
  token_hash VARCHAR(64) NOT NULL,
  status     VARCHAR(16) NOT NULL DEFAULT 'pending',
  device     VARCHAR(200) NOT NULL DEFAULT '',
  created_at VARCHAR(64) NOT NULL,
  expires_at VARCHAR(64) NOT NULL,
  used_at    VARCHAR(64) NULL,
  PRIMARY KEY (code_hash),
  KEY idx_junshi_wb_pair_token (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 复查：SHOW TABLES LIKE 'junshi_workbench_douyin_pairings';
