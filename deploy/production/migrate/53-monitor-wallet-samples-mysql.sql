-- 53 · 监控台供应商钱包采样（2026-11-04）
--
-- 用途：监控页「余额趋势」要有 24h / 7d 的数据；原先只有页面打开后的内存曲线，刷新即丢。
-- 每 5 分钟由服务端采样一次（walletHistory.js），失败也记一行（ok=0），趋势里能看出来。
-- 只读展示用，不参与计费/对账；8 天后自动清理。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/53-monitor-wallet-samples-mysql.sql
--
-- 回滚：
--   DROP TABLE monitor_wallet_samples;

CREATE TABLE IF NOT EXISTS monitor_wallet_samples (
  id         VARCHAR(64) NOT NULL PRIMARY KEY,
  source_id  VARCHAR(32) NOT NULL,
  amount     DOUBLE NULL,
  currency   VARCHAR(16) NULL,
  cny        DOUBLE NULL,
  ok         TINYINT NOT NULL DEFAULT 0,
  fetched_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_wallet_samples_created (created_at),
  KEY idx_wallet_samples_source_created (source_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
