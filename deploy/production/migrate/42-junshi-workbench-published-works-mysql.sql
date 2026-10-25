-- 42 · 内容工作台十四期：采集助手采集「自己已发布作品」（2026-10-25，机构级）。
--
-- 背景：数据复盘原来的数据来源只有「上传作者端截图 → 多模态识别」。
-- 采集助手已经能在用户浏览器里读到抖音作品列表，自己主页的作品也走同一个接口；
-- 因此把「自己作品 + 播放/赞评转藏」直接入库，复盘页不再要求逐条截图。
--
-- 与文案草稿 stats 分表：
--   · 自己作品是持续同步的公开数据，重复上报只更新；不能挤占文案草稿列表；
--   · 删草稿不应该把复盘数据一起删掉。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/42-junshi-workbench-published-works-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_published_works;
-- 复查：SHOW TABLES LIKE 'junshi_workbench_published_works'; SHOW INDEX FROM junshi_workbench_published_works;

CREATE TABLE IF NOT EXISTS junshi_workbench_published_works (
  id           VARCHAR(64) NOT NULL,
  owner_key    VARCHAR(64) NOT NULL,
  org_id       VARCHAR(64) NULL,
  account_id   VARCHAR(64) NOT NULL DEFAULT 'default',
  aweme_id     VARCHAR(32) NOT NULL,
  title        TEXT NULL,
  cover_url    TEXT NULL,
  share_url    TEXT NULL,
  play_url     TEXT NULL,
  duration_ms  BIGINT NOT NULL DEFAULT 0,
  plays        BIGINT NOT NULL DEFAULT 0,
  likes        BIGINT NOT NULL DEFAULT 0,
  comments     BIGINT NOT NULL DEFAULT 0,
  shares       BIGINT NOT NULL DEFAULT 0,
  saves        BIGINT NOT NULL DEFAULT 0,
  published_at VARCHAR(64) NOT NULL DEFAULT '',
  collected_at VARCHAR(64) NOT NULL,
  created_at   VARCHAR(64) NOT NULL,
  updated_at   VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_junshi_wb_pub_aweme (owner_key, aweme_id),
  KEY idx_junshi_wb_pub_owner (owner_key, account_id, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
