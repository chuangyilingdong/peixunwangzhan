-- 46 · 内容工作台二十期：口播成片简易模式（2026-10-26）。
--
-- 背景：用户要在视频四步里直接“写口播稿 → 选音色/形象 → 合成 → 包装发布”，
-- 不再经过编导稿分镜。复用既有数字人链路（junshi_workbench_avatar_runs）。
--
-- 本迁移只给 junshi_workbench_video_works 补三列：
--   production_mode  storyboard=编导稿分镜；talking_head=数字人口播
--   talking_head     口播配置快照 JSON（text/voiceId/imageAssetId/speed/展示名）
--   avatar_run_id    关联的数字人合成任务（一个视频任务对应最近一次合成）
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/46-junshi-workbench-talking-head-mysql.sql
-- 回滚（按需）：
--   ALTER TABLE junshi_workbench_video_works
--     DROP COLUMN production_mode, DROP COLUMN talking_head, DROP COLUMN avatar_run_id;
-- 复查：
--   SHOW COLUMNS FROM junshi_workbench_video_works LIKE 'production_mode';
--   SHOW COLUMNS FROM junshi_workbench_video_works LIKE 'talking_head';
--   SHOW COLUMNS FROM junshi_workbench_video_works LIKE 'avatar_run_id';

ALTER TABLE junshi_workbench_video_works
  ADD COLUMN production_mode VARCHAR(24) NOT NULL DEFAULT 'storyboard',
  ADD COLUMN talking_head TEXT NULL,
  ADD COLUMN avatar_run_id VARCHAR(64) NULL;

ALTER TABLE junshi_workbench_video_works
  ADD KEY idx_junshi_wb_vwork_avatar (owner_key, avatar_run_id);
