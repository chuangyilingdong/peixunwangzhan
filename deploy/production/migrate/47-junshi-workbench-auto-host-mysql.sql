-- 47 · 内容工作台二十一期：视频一键托管（2026-10-26）。
--
-- 背景：用户只填写一个主题，系统自动写口播稿/编导稿、校验音色形象、算分段和费用，
-- 停在确认页；确认后才提交渲染或数字人合成（计费）；成功后自动生成默认发布包。
--
-- 本迁移只给 junshi_workbench_video_works 补一列：
--   auto_host  托管状态 JSON（enabled/autoPackage/stage/topic/confirmedAt/packagedAt）
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/47-junshi-workbench-auto-host-mysql.sql
-- 回滚（按需）：
--   ALTER TABLE junshi_workbench_video_works DROP COLUMN auto_host;
-- 复查：
--   SHOW COLUMNS FROM junshi_workbench_video_works LIKE 'auto_host';

ALTER TABLE junshi_workbench_video_works
  ADD COLUMN auto_host TEXT NULL;
