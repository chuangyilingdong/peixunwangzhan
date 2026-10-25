-- 36 · 移除七期的「自动日更」视频任务（2026-10-25，产品决定砍掉该模式）。
--
-- 生成/复刻两种模式与渲染队列不受影响；junshi_workbench_video_works 里的
-- auto_task_id 列同步删掉（索引一起删）。执行前确认旧表是空的：
--   SELECT COUNT(*) FROM junshi_workbench_video_auto_tasks;   -- 生产实测 0
--
-- 执行（在服务器上，**切完新 release 之后**跑；旧代码写 works 时带 auto_task_id 列）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/36-drop-video-auto-tasks-mysql.sql
-- 回滚：没有（功能已砍，表是空的，无需保留）

ALTER TABLE junshi_workbench_video_works DROP INDEX idx_junshi_wb_vwork_auto, DROP COLUMN auto_task_id;
DROP TABLE IF EXISTS junshi_workbench_video_auto_tasks;

-- 复查：SHOW COLUMNS FROM junshi_workbench_video_works LIKE 'auto_task_id';（应为空）
--       SHOW TABLES LIKE 'junshi_workbench_video_auto_tasks';（应为空）
