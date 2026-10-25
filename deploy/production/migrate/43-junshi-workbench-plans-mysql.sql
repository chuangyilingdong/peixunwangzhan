-- 43 · 内容工作台十六期：内容方案卡（2026-10-25，机构级）。
--
-- 对齐原版 XiaoLingDang 的 renderPlans：聊天创作流产出方案卡 → 查看/改/确认制作/导出。
-- 一份方案 = 一条内容的制作说明书（标题/目标/前三秒/完整口播/视频提示词/参数/参考素材/待补项）。
-- 方案可以手动创建，也可以从聊天消息提炼；同一份方案用 version 做乐观锁。
--
-- 与视频任务的关系：确认制作只创建 video_works 并生成编导稿；
-- 成片渲染仍在视频工作台二次确认，不在「确认制作」这一步直接扣费。
--
-- 执行（在服务器上）：
--   mysql --defaults-file=/root/.my.cnf -D aild_admin < deploy/production/migrate/43-junshi-workbench-plans-mysql.sql
-- 回滚：DROP TABLE junshi_workbench_plans;
--       ALTER TABLE junshi_workbench_messages DROP COLUMN plan_id;
--       ALTER TABLE junshi_workbench_video_works DROP COLUMN plan_id;
-- 复查：SHOW TABLES LIKE 'junshi_workbench_plans';
--       SHOW COLUMNS FROM junshi_workbench_messages LIKE 'plan_id';
--       SHOW COLUMNS FROM junshi_workbench_video_works LIKE 'plan_id';

CREATE TABLE IF NOT EXISTS junshi_workbench_plans (
  id               VARCHAR(64) NOT NULL,
  owner_key        VARCHAR(64) NOT NULL,
  org_id           VARCHAR(64) NULL,
  account_id       VARCHAR(64) NOT NULL DEFAULT 'default',
  title            VARCHAR(200) NOT NULL DEFAULT '',
  objective        VARCHAR(500) NOT NULL DEFAULT '',
  hook             TEXT NULL,
  script           MEDIUMTEXT NULL,
  prompt           TEXT NULL,
  model            VARCHAR(64) NOT NULL DEFAULT '',
  duration_seconds INT NOT NULL DEFAULT 15,
  resolution       VARCHAR(16) NOT NULL DEFAULT '768P',
  ratio            VARCHAR(16) NOT NULL DEFAULT '9:16',
  generate_audio   TINYINT NOT NULL DEFAULT 1,
  asset_ids        TEXT NULL,
  missing          TEXT NULL,
  rationale        TEXT NULL,
  publish_date     VARCHAR(32) NOT NULL DEFAULT '',
  version          INT NOT NULL DEFAULT 1,
  status           VARCHAR(16) NOT NULL DEFAULT 'draft',
  source           VARCHAR(16) NOT NULL DEFAULT 'manual',
  chat_message_id  VARCHAR(64) NOT NULL DEFAULT '',
  video_work_id    VARCHAR(64) NOT NULL DEFAULT '',
  render_id        VARCHAR(64) NOT NULL DEFAULT '',
  created_at       VARCHAR(64) NOT NULL,
  updated_at       VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_junshi_wb_plan_owner (owner_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 消息挂方案：聊天回答生成方案后，前端在消息流里出现「查看制作方案 →」。
ALTER TABLE junshi_workbench_messages ADD COLUMN plan_id VARCHAR(64) NOT NULL DEFAULT '';

-- 视频任务挂方案：从方案确认制作出来的任务保留方案标题，方便双向追溯。
ALTER TABLE junshi_workbench_video_works ADD COLUMN plan_id VARCHAR(64) NOT NULL DEFAULT '';
