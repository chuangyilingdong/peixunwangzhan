-- 24 · 给 `usage_records` 加**缓存拆分**两列（2026-09-29，客户端对账口径，用户口径「要做」）。
--
-- 为什么要有它：客户端（ZCode）要与平台账本对账"上游 prompt caching 到底命中了多少"。
-- 在这之前，缓存命中/未命中**只在**网关响应 usage 与日志行里，账本里没有 —— 对不上账时无从下手。
--
-- ⚠️ 三条口径（写在库里也要写在文件里）：
--   ① 这两列是 `input_tokens` 的**拆分**（hit + miss ≈ input）—— 对账时**别把 hit 再加到 input 上**；
--   ② 客户端契约里第三套命名 `prompt_tokens_details.cached_tokens` 与 `prompt_cache_hit_tokens`
--      是**同一个数**（平台从同一个上游字段映射出去），所以**只存这一列**、不重复存第三列；
--      `total_tokens` 是派生的（input+output），也不存。
--   ③ 上游没返回（多数图片/视频接口，或渠道不支持缓存）时保持 0 —— 0 表示"未上报/没命中"，
--      与"命中 0 个 token"在本口径下不做区分（要区分就得再存一个"是否上报"的标记，暂不需要）。
--
-- 为什么是手动 ALTER：生产是 RDS（MySQL），schema.js 的自动补列只对 SQLite 生效 ——
-- 这就是固定动作第 4 条「改库结构要手动 ALTER 生产 RDS」。SQLite 侧由 schema.js 的
-- `addColumnIfMissing('usage_records','cache_hit_tokens', …)` 自动补（老库已验证）。
--
-- 执行（在服务器上，RDS 只给同 VPC 内网）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/24-usage-cache-columns-mysql.sql
-- 回滚：`ALTER TABLE usage_records DROP COLUMN cache_hit_tokens, DROP COLUMN cache_miss_tokens;`
--      （列是可再生的观测数据，但删了就没了；要回滚建议先备份）
--
-- MySQL 8 加带默认值的 NOT NULL 列是 INSTANT 操作（不重写表），3611 行实测秒级完成。

ALTER TABLE usage_records
  ADD COLUMN cache_hit_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN cache_miss_tokens BIGINT NOT NULL DEFAULT 0;

-- 复查（应看到两列都在、默认 0）：
--   SHOW COLUMNS FROM usage_records LIKE 'cache%';
