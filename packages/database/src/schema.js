import { randomBytes, scryptSync, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = process.env.PLATFORM_DATA_DIR || path.resolve(__dirname, '../../data');
export const databasePath = process.env.PLATFORM_DB_PATH || path.join(dataDir, 'platform.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS platform_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  platform_name TEXT NOT NULL DEFAULT 'AI魔法学院兼容平台',
  modalities TEXT NOT NULL DEFAULT '{}',
  billing_settings TEXT NOT NULL DEFAULT '{}',
  ai_provider_policy TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS website_contents (
  content_key TEXT PRIMARY KEY,
  draft_content TEXT NOT NULL DEFAULT '{}',
  published_content TEXT,
  draft_version INTEGER NOT NULL DEFAULT 1,
  published_version INTEGER,
  updated_by TEXT,
  published_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS website_content_revisions (
  id TEXT PRIMARY KEY,
  content_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('PUBLISH','ROLLBACK')),
  changed_by TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(content_key, version),
  FOREIGN KEY (content_key) REFERENCES website_contents(content_key) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_website_content_revisions_key_created
  ON website_content_revisions(content_key, created_at DESC);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'TRIAL' CHECK (status IN ('TRIAL','ACTIVE','FROZEN','DISABLED','EXPIRED')),
  contract_start_at TEXT NOT NULL,
  contract_expires_at TEXT NOT NULL,
  is_trial INTEGER NOT NULL DEFAULT 1,
  base_teacher_seats INTEGER NOT NULL DEFAULT 3,
  purchased_teacher_seats INTEGER NOT NULL DEFAULT 0,
  contact TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_name ON organizations(name);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','ORG_ADMIN','TEACHER','STUDENT')),
  permissions TEXT NOT NULL DEFAULT '[]',
  password_hash TEXT NOT NULL,
  phone TEXT,
  phone_verified_at TEXT,
  must_bind_phone INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  expires_at TEXT,
  student_usage_scope TEXT CHECK (student_usage_scope IN ('FOLLOW_CLASS','HOME_PRACTICE')),
  billing_package_id TEXT,
  monthly_credit_allowance INTEGER NOT NULL DEFAULT 0,
  monthly_bonus_credits INTEGER NOT NULL DEFAULT 0,
  month_period_boost_credits INTEGER NOT NULL DEFAULT 0,
  used_credits_this_period INTEGER NOT NULL DEFAULT 0,
  period_start_at TEXT,
  period_reset_at TEXT,
  magic_stones INTEGER NOT NULL DEFAULT 0,
  avatar_key TEXT CHECK (avatar_key IS NULL OR avatar_key IN ('star','rocket','cat','fox','robot','panda','owl','whale')),
  guardian_name TEXT,
  guardian_phone TEXT,
  guardian_relationship TEXT CHECK (guardian_relationship IS NULL OR guardian_relationship IN ('PARENT','GRANDPARENT','OTHER_GUARDIAN')),
  guardian_consented_at TEXT,
  privacy_showcase_anonymous INTEGER NOT NULL DEFAULT 1,
  privacy_allow_feature INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT
);


CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  org_id TEXT,
  client_type TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  superseded_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS org_billing_accounts (
  org_id TEXT PRIMARY KEY,
  credit_balance INTEGER NOT NULL DEFAULT 0,
  frozen_credits INTEGER NOT NULL DEFAULT 0,
  total_credits_in INTEGER NOT NULL DEFAULT 0,
  total_credits_spent INTEGER NOT NULL DEFAULT 0,
  currency_paid_total_fen INTEGER NOT NULL DEFAULT 0,
  hackathon_reward_credits INTEGER NOT NULL DEFAULT 0,
  updated_version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS credit_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  type TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  balance_after INTEGER NOT NULL,
  modality TEXT,
  model TEXT,
  upstream_cost_fen INTEGER,
  pricing_snapshot TEXT,
  user_id TEXT,
  class_session_id TEXT,
  project_id TEXT,
  work_id TEXT,
  related_order_id TEXT,
  related_submission_id TEXT,
  status TEXT NOT NULL DEFAULT 'EFFECTIVE' CHECK (status IN ('EFFECTIVE','VOIDED')),
  reversal_of TEXT,
  reason TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_credit_entries_org_created ON credit_entries(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_entries_session ON credit_entries(class_session_id);

CREATE TABLE IF NOT EXISTS billing_packages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_fen INTEGER NOT NULL DEFAULT 0,
  monthly_credits INTEGER NOT NULL DEFAULT 0,
  bonus_credits INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 30,
  allow_image INTEGER NOT NULL DEFAULT 1,
  allow_music INTEGER NOT NULL DEFAULT 1,
  allow_video INTEGER NOT NULL DEFAULT 0,
  allow_podcast INTEGER NOT NULL DEFAULT 0,
  allow_dubbing INTEGER NOT NULL DEFAULT 0,
  student_seats INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_packages_org_name ON billing_packages(org_id, name);

-- 学员套餐开通单仅记录机构线下履约，不承诺或模拟在线支付、自动续费。
CREATE TABLE IF NOT EXISTS student_enrollments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','VOIDED','EXPIRED')),
  payment_status TEXT NOT NULL DEFAULT 'UNRECORDED' CHECK (payment_status IN ('UNRECORDED','RECORDED','WAIVED')),
  price_fen INTEGER NOT NULL DEFAULT 0,
  package_snapshot TEXT NOT NULL DEFAULT '{}',
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  activated_at TEXT,
  suspended_at TEXT,
  voided_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (package_id) REFERENCES billing_packages(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_student_enrollments_org_status_expires ON student_enrollments(org_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_student_enrollments_student_created ON student_enrollments(student_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_enrollments_active_student ON student_enrollments(student_id) WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS student_enrollment_events (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  before_status TEXT,
  after_status TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  actor_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (enrollment_id) REFERENCES student_enrollments(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_student_enrollment_events_enrollment_created ON student_enrollment_events(enrollment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS course_series (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_image_url TEXT,
  price_fen INTEGER NOT NULL DEFAULT 0,
  validity_days INTEGER NOT NULL DEFAULT 365,
  estimated_credits_per_person INTEGER NOT NULL DEFAULT 0,
  grade_range TEXT NOT NULL DEFAULT '',
  owner_type TEXT NOT NULL DEFAULT 'PLATFORM' CHECK (owner_type IN ('PLATFORM','ORG')),
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'ALL_ORGS' CHECK (visibility IN ('ALL_ORGS','ASSIGNED_ORGS','PRIVATE')),
  version TEXT NOT NULL DEFAULT '1.0',
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  marketplace_status TEXT NOT NULL DEFAULT 'NONE',
  marketplace_reward_credits INTEGER NOT NULL DEFAULT 0,
  difficulty_level INTEGER CHECK (difficulty_level BETWEEN 1 AND 5),
  age_range_min INTEGER,
  age_range_max INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  delivery_mode TEXT NOT NULL DEFAULT 'CANVAS' CHECK (delivery_mode IN ('CANVAS','VIBECODING')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_course_series_platform_title ON course_series(title) WHERE owner_type = 'PLATFORM';


CREATE TABLE IF NOT EXISTS course_lessons (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  duration_minutes INTEGER NOT NULL DEFAULT 45,
  prompt_pack_asset_id TEXT,
  outcome_pack_asset_id TEXT,
  lesson_content TEXT NOT NULL DEFAULT '',
  delivery_mode TEXT NOT NULL DEFAULT 'CANVAS' CHECK (delivery_mode IN ('CANVAS','VIBECODING')),
  classroom_config TEXT NOT NULL DEFAULT '{}',
  canvas_template_snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (series_id) REFERENCES course_series(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_course_lessons_series_sort ON course_lessons(series_id, sort);

CREATE TABLE IF NOT EXISTS course_lesson_material_groups (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  title TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lesson_material_groups_lesson ON course_lesson_material_groups(lesson_id, sort);

CREATE TABLE IF NOT EXISTS course_lesson_materials (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  material_type TEXT NOT NULL DEFAULT 'NOTE',
  asset_url TEXT,
  snapshot TEXT NOT NULL DEFAULT '{}',
  sort INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES course_lesson_material_groups(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lesson_materials_group ON course_lesson_materials(group_id, sort);

CREATE TABLE IF NOT EXISTS course_lesson_capabilities (
  lesson_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (lesson_id, capability),
  FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE CASCADE
);

-- 教学素材（教师备课资料，不进入学生画布）
CREATE TABLE IF NOT EXISTS course_lesson_teaching_groups (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  title TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lesson_teaching_groups_lesson ON course_lesson_teaching_groups(lesson_id, sort);

CREATE TABLE IF NOT EXISTS course_lesson_teaching_assets (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  asset_type TEXT NOT NULL DEFAULT 'FILE',
  asset_url TEXT,
  file_asset_id TEXT,
  sort INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES course_lesson_teaching_groups(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lesson_teaching_assets_group ON course_lesson_teaching_assets(group_id, sort);

CREATE TABLE IF NOT EXISTS course_assignments (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  assigned_by TEXT,
  assigned_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (series_id) REFERENCES course_series(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_course_assignments_unique ON course_assignments(series_id, org_id);


CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  teacher_id TEXT,
  usage_mode TEXT NOT NULL DEFAULT 'CLASS_ONLY' CHECK (usage_mode IN ('CLASS_ONLY','ALWAYS_AVAILABLE')),
  default_series_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  current_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_org_active_name ON classes(org_id, name) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS class_members (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'STUDENT' CHECK (role IN ('STUDENT','TEACHER','ORG_ADMIN')),
  joined_at TEXT NOT NULL,
  removed_at TEXT,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_members_unique ON class_members(class_id, user_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS class_curriculum_items (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  sort INTEGER NOT NULL,
  source_series_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_curriculum_class_lesson ON class_curriculum_items(class_id, lesson_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_curriculum_class_sort ON class_curriculum_items(class_id, sort);

-- 2026-09-13（课堂成为主对象）：class_sessions 就是「课堂」，自带课包/课时/负责老师，班级退场后它独立存在。
-- 四态：PENDING（待上课，已创建未开始）/ ACTIVE（上课中）/ ENDED（已结束）/ DISSOLVED（已解散）。
CREATE TABLE IF NOT EXISTS class_sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  org_id TEXT,
  class_id TEXT,
  series_id TEXT,
  lesson_id TEXT,
  teacher_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','ENDED','DISSOLVED')),
  delivery_mode TEXT NOT NULL DEFAULT 'CANVAS',
  session_credit_cap INTEGER,
  consumed_credits_total INTEGER NOT NULL DEFAULT 0,
  ai_paused INTEGER NOT NULL DEFAULT 0,
  student_call_cap INTEGER,
  allow_text INTEGER NOT NULL DEFAULT 1,
  allow_image INTEGER NOT NULL DEFAULT 1,
  allow_music INTEGER NOT NULL DEFAULT 1,
  allow_video INTEGER NOT NULL DEFAULT 0,
  allow_podcast INTEGER NOT NULL DEFAULT 0,
  allow_dubbing INTEGER NOT NULL DEFAULT 0,
  started_by TEXT,
  started_at TEXT,
  ended_by TEXT,
  ended_at TEXT,
  ended_reason TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE SET NULL,
  FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS student_projects (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  org_id TEXT,
  class_id TEXT,
  course_lesson_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','GRADED','ARCHIVED')),
  canvas_snapshot TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}',
  latest_version INTEGER NOT NULL DEFAULT 1,
  last_saved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_projects_student_updated ON student_projects(student_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_student_status_updated ON student_projects(student_id, org_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_projects_org_updated ON student_projects(org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_work_data_scope ON student_projects(org_id, class_id, course_lesson_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS learning_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  lesson_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT','PUBLISHED','CLOSED')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_learning_tasks_class_due ON learning_tasks(class_id, status, due_at);
  CREATE TABLE IF NOT EXISTS learning_task_progress (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED','IN_PROGRESS','SUBMITTED','COMPLETED','OVERDUE')),
    started_at TEXT,
    submitted_at TEXT,
    completed_at TEXT,
    teacher_feedback TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(task_id, student_id),
    FOREIGN KEY (task_id) REFERENCES learning_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_learning_task_progress_student ON learning_task_progress(student_id, org_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_learning_task_progress_task ON learning_task_progress(task_id, status);
  CREATE TABLE IF NOT EXISTS learning_task_submissions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    project_id TEXT,
    project_snapshot TEXT,
    student_note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
    score INTEGER CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
    feedback TEXT NOT NULL DEFAULT '',
    viewed_at TEXT,
    viewed_by TEXT,
    reviewed_at TEXT,
    reviewed_by TEXT,
    submitted_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES learning_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES student_projects(id) ON DELETE SET NULL,
    UNIQUE(task_id, student_id, round)
  );
  CREATE INDEX IF NOT EXISTS idx_learning_task_submissions_task_status ON learning_task_submissions(task_id, status, submitted_at DESC);
  CREATE INDEX IF NOT EXISTS idx_learning_task_submissions_student ON learning_task_submissions(student_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS student_lesson_progress (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED')),
  started_at TEXT,
  completed_at TEXT,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_lesson_progress_unique ON student_lesson_progress(student_id, lesson_id);
CREATE INDEX IF NOT EXISTS idx_student_lesson_progress_student ON student_lesson_progress(student_id, org_id, updated_at DESC);


CREATE TABLE IF NOT EXISTS project_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  label TEXT,
  canvas_snapshot TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES student_projects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_snapshot_version ON project_snapshots(project_id, version);

CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  org_id TEXT,
  class_id TEXT,
  course_lesson_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  canvas_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','PUBLISHED')),
  teacher_comment TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  copyright_confirmed_at TEXT,
  copyright_confirmed_by TEXT,
  featured_at TEXT,
  featured_by TEXT,
  featured_reason TEXT,
  submitted_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES student_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_works_org_submitted ON works(org_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_works_work_data_scope ON works(org_id, class_id, course_lesson_id, submitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_works_project_unique ON works(project_id);

CREATE TABLE IF NOT EXISTS work_reports (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('INAPPROPRIATE','COPYRIGHT','PRIVACY','OTHER')),
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESOLVED','DISMISSED')),
  handled_by TEXT,
  handled_at TEXT,
  resolution TEXT,
  action_taken TEXT NOT NULL DEFAULT 'NONE' CHECK (action_taken IN ('NONE','UNPUBLISH')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (handled_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_work_reports_org_status_created ON work_reports(org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_reports_work_created ON work_reports(work_id, created_at DESC);

CREATE TABLE IF NOT EXISTS work_annotations (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  node_id TEXT,
  content TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_work_annotations_work_created ON work_annotations(work_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_annotations_org_created ON work_annotations(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS work_submissions (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  org_id TEXT,
  round INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  canvas_snapshot TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  review_status TEXT,
  review_comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES student_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_work_submissions_work_round ON work_submissions(work_id, round DESC);
CREATE INDEX IF NOT EXISTS idx_work_submissions_student_created ON work_submissions(student_id, created_at DESC);

CREATE TABLE IF NOT EXISTS work_feedback_reads (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  annotation_id TEXT,
  submission_round INTEGER NOT NULL DEFAULT 0,
  read_at TEXT NOT NULL,
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (annotation_id) REFERENCES work_annotations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_feedback_reads_annotation ON work_feedback_reads(annotation_id) WHERE annotation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_feedback_reads_work ON work_feedback_reads(work_id, student_id, read_at DESC);

CREATE TABLE IF NOT EXISTS work_publish_requests (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  org_id TEXT,
  round INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  reason TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES student_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_work_publish_requests_work ON work_publish_requests(work_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_publish_requests_open ON work_publish_requests(work_id) WHERE status='PENDING';

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  class_session_id TEXT,
  project_id TEXT,
  generation_job_id TEXT,
  work_id TEXT,
  modality TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'local-p0',
  credits_charged INTEGER NOT NULL CHECK (credits_charged >= 0),
  -- input/output_tokens 未采集：上游图片/视频接口不返回 token 用量，报表已不再读取这两个字段
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS','FAILED','BLOCKED')),
  fail_code TEXT,
  pricing_snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_usage_org_created ON usage_records(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_work_data_project_created ON usage_records(org_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_records(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  modality TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  credits_charged INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  retry_of_job_id TEXT,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES student_projects(id) ON DELETE CASCADE
  FOREIGN KEY (retry_of_job_id) REFERENCES generation_jobs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_project_created ON generation_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_org_created ON generation_jobs(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  modality TEXT NOT NULL,
  label TEXT NOT NULL,
  mime_type TEXT,
  asset_url TEXT NOT NULL,
  preview_url TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES student_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_media_assets_project_created ON media_assets(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('PLATFORM','ORG')),
  org_id TEXT,
  sender_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'NOTICE' CHECK (kind IN ('NOTICE','ANNOUNCEMENT','REMINDER')),
  target_url TEXT,
  audience TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','RECALLED')),
  publish_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_notifications_scope_status ON notifications(scope_type, org_id, status, publish_at, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'NOTICE' CHECK (kind IN ('NOTICE','ANNOUNCEMENT','REMINDER')),
  target_url TEXT,
  audience TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_notification_templates_status_updated ON notification_templates(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS notification_recipients (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_key TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'DELIVERED' CHECK (delivery_status IN ('PENDING','DELIVERED','FAILED')),
  delivered_at TEXT,
  read_at TEXT,
  failure_code TEXT,
  failure_reason TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  ignored INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_recipient_unique ON notification_recipients(notification_id, user_id);
CREATE INDEX IF NOT EXISTS idx_notification_recipient_user_read ON notification_recipients(user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_recipient_event_key ON notification_recipients(event_key, user_id);
CREATE INDEX IF NOT EXISTS idx_notification_recipient_failed ON notification_recipients(user_id, delivery_status, ignored) WHERE delivery_status='FAILED';

CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  org_id TEXT,
  audience TEXT NOT NULL DEFAULT '{}',
  target_url TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','SUPPRESSED','FAILED')),
  suppressed_at TEXT,
  suppress_reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_key ON notification_events(event_key);
CREATE INDEX IF NOT EXISTS idx_notification_events_status ON notification_events(status, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_dispatch_jobs (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_key TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_PROGRESS','FAILED','DEAD_LETTER','SUCCEEDED')),
  next_run_at TEXT NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  locked_by TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (recipient_id) REFERENCES notification_recipients(id) ON DELETE CASCADE,
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ndj_status_next_run ON notification_dispatch_jobs(status, next_run_at ASC);
CREATE INDEX IF NOT EXISTS idx_ndj_recipient ON notification_dispatch_jobs(recipient_id);
CREATE INDEX IF NOT EXISTS idx_ndj_notification ON notification_dispatch_jobs(notification_id);
CREATE INDEX IF NOT EXISTS idx_ndj_user ON notification_dispatch_jobs(user_id);

CREATE TABLE IF NOT EXISTS promo_materials (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'GENERAL',
  mime_type TEXT,
  resource_url TEXT,
  cover_url TEXT,
  visibility TEXT NOT NULL DEFAULT 'ALL_ORGS' CHECK (visibility IN ('ALL_ORGS','ASSIGNED_ORGS')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_promo_materials_status_created ON promo_materials(status, created_at DESC);

CREATE TABLE IF NOT EXISTS promo_material_assignments (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (material_id) REFERENCES promo_materials(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_material_assignment_unique ON promo_material_assignments(material_id, org_id);

CREATE TABLE IF NOT EXISTS promo_material_events (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('VIEW','USE','DOWNLOAD')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (material_id) REFERENCES promo_materials(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_promo_material_events_material_created ON promo_material_events(material_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recharge_orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  package_id TEXT,
  amount_fen INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  bonus_credits INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','CANCELLED','REFUNDED','INVOICED')),
  paid_at TEXT,
  invoice_status TEXT NOT NULL DEFAULT 'NONE',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recharge_orders_org_created ON recharge_orders(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  request_method TEXT,
  request_path TEXT,
  before_data TEXT,
  after_data TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_logs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_created ON audit_logs(actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS account_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('DELETION','DATA_EXPORT')),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT,
  export_payload TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_account_requests_user_status ON account_requests(user_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_requests_org_status ON account_requests(org_id, status, requested_at DESC);

CREATE TABLE IF NOT EXISTS legal_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT,
  consent_type TEXT NOT NULL CHECK (consent_type IN ('TERMS','PRIVACY','MINORS')),
  version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'STUDENT_ACCOUNT',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  UNIQUE (user_id, consent_type, version)
);
CREATE INDEX IF NOT EXISTS idx_legal_consents_user_type ON legal_consents(user_id, consent_type, consented_at DESC);

-- P5-W11：仅保存获得选择同意后的、最小化的匿名官网事件；不保存 IP、User-Agent、姓名、电话或原始 URL 查询参数。
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  anonymous_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '/',
  metadata TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name_created ON analytics_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_anon_created ON analytics_events(anonymous_id, created_at DESC);

CREATE TABLE IF NOT EXISTS help_feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT,
  category TEXT NOT NULL CHECK (category IN ('ACCOUNT','CANVAS','AI','COURSE','CLIENT','DATA','OTHER')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','IN_PROGRESS','RESOLVED','CLOSED')),
  submitted_at TEXT NOT NULL,
  handled_by TEXT,
  handled_at TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (handled_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_help_feedback_org_status ON help_feedback(org_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_help_feedback_user ON help_feedback(user_id, submitted_at DESC);

-- 统一文件元数据与访问授权（P4-C04）
CREATE TABLE IF NOT EXISTS file_assets (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('PLATFORM','ORG','USER','SYSTEM')),
  owner_org_id TEXT,
  owner_user_id TEXT,
  storage_kind TEXT NOT NULL DEFAULT 'EXTERNAL_URL' CHECK (storage_kind IN ('EXTERNAL_URL','INTERNAL_PROXY','PENDING')),
  storage_url TEXT,
  storage_key TEXT,
  proxy_route TEXT,
  public_path TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size INTEGER,
  checksum TEXT,
  category TEXT NOT NULL DEFAULT 'GENERAL' CHECK (category IN ('PROMO_MATERIAL','PROMO_COVER','CLIENT_INSTALLER','MEDIA_ASSET','GENERAL')),
  visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','ORG','ASSIGNED_ORGS','PUBLIC_PLATFORM','PUBLIC_RELEASE')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','DISABLED','REMOVED')),
  review_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (review_status IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED')),
  expires_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_file_assets_owner ON file_assets(owner_type, owner_org_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_file_assets_category_status ON file_assets(category, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_assets_visibility ON file_assets(visibility, status);
CREATE INDEX IF NOT EXISTS idx_file_assets_storage_url ON file_assets(storage_url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_assets_storage_key ON file_assets(storage_key) WHERE storage_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS file_access_grants (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  grant_type TEXT NOT NULL CHECK (grant_type IN ('ORG','ROLE','USER','PUBLIC')),
  org_id TEXT,
  user_id TEXT,
  role TEXT,
  permission TEXT NOT NULL DEFAULT 'READ' CHECK (permission IN ('READ','DOWNLOAD')),
  granted_by TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES file_assets(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_file_access_grants_file ON file_access_grants(file_id, grant_type);
CREATE INDEX IF NOT EXISTS idx_file_access_grants_org ON file_access_grants(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_file_access_grants_user ON file_access_grants(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_file_access_grants_role ON file_access_grants(role) WHERE role IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_modality_settings (
  id          TEXT    NOT NULL PRIMARY KEY,
  modality    TEXT    NOT NULL UNIQUE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  unit_cost   INTEGER NOT NULL DEFAULT 1,
  display_name TEXT   NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_credit_quotas (
  id          TEXT    NOT NULL PRIMARY KEY,
  scope       TEXT    NOT NULL UNIQUE,
  period      TEXT    NOT NULL DEFAULT 'MONTH',
  daily_limit INTEGER NOT NULL,
  monthly_limit INTEGER NOT NULL,
  note        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_alert_thresholds (
  id           TEXT    NOT NULL PRIMARY KEY,
  alert_type   TEXT    NOT NULL UNIQUE,
  threshold    INTEGER NOT NULL,
  notify_email TEXT    NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  note         TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS org_ai_budgets (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL,
  per_call_budget INTEGER NOT NULL DEFAULT 0,
  daily_budget INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_ai_budgets_org
  ON org_ai_budgets(org_id);

CREATE TABLE IF NOT EXISTS org_capability_overrides (
  id          TEXT    NOT NULL PRIMARY KEY,
  org_id      TEXT    NOT NULL,
  modality    TEXT    NOT NULL,
  enabled     INTEGER NOT NULL,
  reason      TEXT    NOT NULL DEFAULT '',
  created_by  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_cap_overrides_org_mod
  ON org_capability_overrides(org_id, modality);

CREATE TABLE IF NOT EXISTS platform_config_change_logs (
  id           TEXT    NOT NULL PRIMARY KEY,
  config_type  TEXT    NOT NULL,
  record_id    TEXT    NOT NULL,
  field_name   TEXT    NOT NULL,
  old_value    TEXT    NOT NULL DEFAULT '',
  new_value    TEXT    NOT NULL,
  changed_by   TEXT    NOT NULL,
  reason       TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL
);
`;

db.exec(SCHEMA);

// ── 课包/课时的重做字段（2026-09-11，平台侧梳理 P1）────────────────────────────
// 课时可同时支持多种上课类型（画布 + VibeCoding），学生端两个入口并列。
// delivery_mode 保留为「第一种」，兼容既有读取方（学生端门禁、公开接口、老数据）。
try { db.exec('ALTER TABLE course_lessons ADD COLUMN delivery_modes TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
// 这节课「每个学生」的算力上限（单位：分，50 元 = 5000）。
// 实际拦截在算力网关（令牌额度）；这里的数字用于「课时合计 = 单价 × 参与学生数」与超支告警。
try { db.exec('ALTER TABLE course_lessons ADD COLUMN per_student_budget_fen INTEGER'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
// 平台课包库存（可授权出去的次数池）；授权给机构时从机构授权单上记账（见 course_assignments.quota_*）。
try { db.exec('ALTER TABLE course_series ADD COLUMN stock_total INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }

// ── 算力池：一个学生在一个课包上就一个池子，四种模态共用（2026-09-12 用户拍板）────────
// 用户口径：「按学生 × 课包」，并且「视频 / 音乐 / 对话 / 图像 都要算进这个上限里」。
// 因为视频与音乐走不了网关（异步任务要写 new-api 任务插件，见梳理文档 7.2.3），
// **只有应用侧能同时看见四种模态** → 池子的权威账本在应用侧（usage_records.cost_fen），
// 网关的令牌额度退化成宽松兜底。
try {
  db.exec('ALTER TABLE course_series ADD COLUMN per_student_budget_fen INTEGER');
  // 只在「这一次刚加上这一列」时回填一次：把该课包下所有课时的每学生预算**求和**抬到课包上。
  // 求和而不是取其一，是因为原先的填法（每节课 50 元）本意就是「一个课包 5 节课 = 250 元」。
  // ⚠️ 回填故意放在 try 里面：它只在建列那一次跑，之后管理员把课包预算清空不会被它又填回来。
  db.exec(`UPDATE course_series SET per_student_budget_fen = (
    SELECT SUM(lesson.per_student_budget_fen) FROM course_lessons lesson WHERE lesson.series_id = course_series.id
  ) WHERE EXISTS (SELECT 1 FROM course_lessons lesson
                   WHERE lesson.series_id = course_series.id AND lesson.per_student_budget_fen > 0)`);
} catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
// 账本：每次调用折算出的金额（分）与它属于哪个课包。池子已用 = SUM(cost_fen) WHERE user_id + series_id。
// 失败的调用记 0（不算钱）。cost_fen 是按平台「每次调用预估单价」折算的，不是上游账单 ——
// 精确账单在网关的用量日志里，两者口径差异写在梳理文档 7.4。
try { db.exec('ALTER TABLE usage_records ADD COLUMN cost_fen INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE usage_records ADD COLUMN series_id TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
db.exec('CREATE INDEX IF NOT EXISTS idx_usage_pool ON usage_records(user_id, series_id, created_at DESC)');

// ── 课包版本与发布记录（2026-09-12，平台侧重做梳理 P1 第三刀）──────────────────
// 版本号由人填写（不再「改一次自动 +0.1」）：每次「更新发布」写一条，记录版本号 / 变更说明 / 谁 / 何时。
// 读模型仍是「当前内容」，所以发布后已授权机构与官网自然一起更新；
// 「有没有未发布的改动」用「最近一次版本记录时间 vs 课包与课时的最后修改时间」比较得出，不额外存标记。
db.exec(`CREATE TABLE IF NOT EXISTS course_series_versions (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  version TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','ARCHIVED')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  FOREIGN KEY (series_id) REFERENCES course_series(id) ON DELETE CASCADE
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_course_series_versions ON course_series_versions(series_id, created_at DESC)');

// 已发布内容快照（草稿隔离）：平台端编辑的是实时数据，「更新发布」时把内容定格进这两列；
// 机构端 / 学生端 / 官网读快照 —— 不点「更新发布」它们看不到改动。老数据为空 → 回退实时数据。
try { db.exec('ALTER TABLE course_lessons ADD COLUMN published_content TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE course_lessons ADD COLUMN published_title TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE course_series ADD COLUMN published_content TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }

// 课包授权给机构的「次数」（板块二）：授权时填 quota_total，机构分给学生时累加 quota_used
try { db.exec('ALTER TABLE course_assignments ADD COLUMN quota_total INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE course_assignments ADD COLUMN quota_used INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
// 机构把课包分给学生的许可（唯一约束：同机构同学生同课包只有一条；撤销只清 revoked_at，留痕）
db.exec(`CREATE TABLE IF NOT EXISTS student_course_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  source_assignment_id TEXT,
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT,
  FOREIGN KEY (series_id) REFERENCES course_series(id) ON DELETE CASCADE
)`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_student_course_grants_unique ON student_course_grants(org_id, student_id, series_id)');
// 排课名单：这一节课谁来上（现状没有这层 —— 学生进班就自动算能上课）
db.exec(`CREATE TABLE IF NOT EXISTS class_lesson_students (
  class_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  added_by TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (class_id, lesson_id, student_id)
)`);


// P6-A01 AI provider policy and org budget migrations; safe for existing databases.
try { db.exec("ALTER TABLE platform_settings ADD COLUMN ai_provider_policy TEXT NOT NULL DEFAULT '{}'"); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
// 算力网关（new-api）：地址与管理员账号；管理员密码走加密密钥文件（providerSecret.js），不落库。
try { db.exec("ALTER TABLE platform_settings ADD COLUMN compute_gateway TEXT NOT NULL DEFAULT '{}'"); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
// 算力单价（分）：{ perCall: {TEXT,IMAGE,VIDEO,MUSIC}, models: {<模型名>: 分} }。
// 这是「每次调用预估单价」，用于折算池子的消耗（不是上游账单）；模型级优先于模态级。
try { db.exec("ALTER TABLE platform_settings ADD COLUMN compute_pricing TEXT NOT NULL DEFAULT '{}'"); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
db.exec(`CREATE TABLE IF NOT EXISTS org_ai_budgets (
  id TEXT NOT NULL PRIMARY KEY,
  org_id TEXT NOT NULL,
  per_call_budget INTEGER NOT NULL DEFAULT 0,
  daily_budget INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
)`);
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_org_ai_budgets_org ON org_ai_budgets(org_id)'); } catch (_) {}

// AI generation queue hardening fields; safe for existing production databases.
for (const statement of [
  "ALTER TABLE generation_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE generation_jobs ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 2",
  "ALTER TABLE generation_jobs ADD COLUMN next_attempt_at TEXT",
  "ALTER TABLE generation_jobs ADD COLUMN last_error_at TEXT",
  "ALTER TABLE generation_jobs ADD COLUMN cancelled_at TEXT",
  "ALTER TABLE generation_jobs ADD COLUMN worker_id TEXT",
  // 图生视频的首帧来源（本项目图片素材的 asset_url），重试与异步 worker 复用。
  "ALTER TABLE generation_jobs ADD COLUMN source_asset_url TEXT",
  // 该次生成属于课时里的哪个生成框体（generationBoxes[].id）：每框体只能生成一次，重试沿用。
  "ALTER TABLE generation_jobs ADD COLUMN box_id TEXT",
  // 首尾帧生成时的尾帧来源（本项目图片素材的 asset_url），重试与异步 worker 复用。
  "ALTER TABLE generation_jobs ADD COLUMN last_frame_asset_url TEXT",
  // 全能参考（多素材参考）用到的图片素材地址，JSON 数组，重试与异步 worker 复用。
  "ALTER TABLE generation_jobs ADD COLUMN reference_asset_urls TEXT",
  // 平台没指定、由学生在画布课堂里自选的生成参数（比例/清晰度/时长/含音频），JSON。
  // 异步 worker 会按框体重新解析一次参数，所以必须落库，否则学生的选择会被重算掉。
  "ALTER TABLE generation_jobs ADD COLUMN request_options TEXT",
]) { try { db.exec(statement); } catch (_) {} }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_generation_jobs_queue ON generation_jobs(status, next_attempt_at, created_at)'); } catch (_) {}

// P5-W01 website CMS tables (safe for existing local databases)
try { db.exec(`CREATE TABLE IF NOT EXISTS website_contents (
  content_key TEXT PRIMARY KEY, draft_content TEXT NOT NULL DEFAULT '{}', published_content TEXT,
  draft_version INTEGER NOT NULL DEFAULT 1, published_version INTEGER, updated_by TEXT, published_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL, FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL
)`); } catch (_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS website_content_revisions (
  id TEXT PRIMARY KEY, content_key TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('PUBLISH','ROLLBACK')), changed_by TEXT, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  UNIQUE(content_key, version), FOREIGN KEY (content_key) REFERENCES website_contents(content_key) ON DELETE CASCADE, FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
)`); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_website_content_revisions_key_created ON website_content_revisions(content_key, created_at DESC)'); } catch (_) {}

// 播客 / 配音已下线（用户决定不做）：清掉历史开关行，代码里也不再认这两种模态。
try { db.exec("DELETE FROM platform_modality_settings WHERE modality IN ('PODCAST','DUBBING')"); } catch (_) {}

// Seed default platform modality settings if empty
{
  const now = new Date().toISOString();
  const exists = row("SELECT COUNT(*) n FROM platform_modality_settings")?.n || 0;
  if (!exists) {
    const defaults = [
      ['pmod_text',    'TEXT',    1, 1, '文本生成', '', 1, now, now],
      ['pmod_image',   'IMAGE',   1, 1, '图像创作', '', 2, now, now],
      ['pmod_music',   'MUSIC',   1, 1, '音乐创作', '', 3, now, now],
      ['pmod_video',   'VIDEO',   1, 2, '视频生成', '', 4, now, now],
      ['pmod_canvas',  'CANVAS',  1, 0, '画布编辑', '', 5, now, now],
    ];
    for (const d of defaults) {
      q(
        'INSERT INTO platform_modality_settings(id,modality,enabled,unit_cost,display_name,description,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        d,
      );
    }
  }
  const qExists = row("SELECT COUNT(*) n FROM platform_credit_quotas")?.n || 0;
  if (!qExists) {
    const qdef = [
      ['pcq_global',  'GLOBAL',  'MONTH', 50000, 500000, '平台全量默认', now, now],
      ['pcq_student', 'STUDENT', 'MONTH', 200,   3000,   '学生月配额',   now, now],
      ['pcq_teacher', 'TEACHER', 'MONTH', 500,   8000,   '教师月配额',   now, now],
    ];
    for (const d of qdef) {
      q(
        'INSERT INTO platform_credit_quotas(id,scope,period,daily_limit,monthly_limit,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        d,
      );
    }
  }
  const aExists = row("SELECT COUNT(*) n FROM platform_alert_thresholds")?.n || 0;
  if (!aExists) {
    const adef = [
      ['palert_balance',     'BALANCE_LOW',       100, 'finance@example.com', 1, '机构余额低于此值触发预警', now, now],
      ['palert_consumption', 'CONSUMPTION_SPIKE', 200, 'ops@example.com',     1, '单日消耗超过此值触发预警', now, now],
      ['palert_quota',       'QUOTA_EXCEEDED',    90,  'ops@example.com',     1, '使用率超过此百分比触发预警', now, now],
    ];
    for (const d of adef) {
      q(
        'INSERT INTO platform_alert_thresholds(id,alert_type,threshold,notify_email,enabled,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        d,
      );
    }
  }
}

// Lightweight forward-compatible migration for classroom AI controls.
try { db.exec("ALTER TABLE class_sessions ADD COLUMN allow_text INTEGER NOT NULL DEFAULT 1"); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec("ALTER TABLE usage_records ADD COLUMN generation_job_id TEXT"); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec("ALTER TABLE class_sessions ADD COLUMN ai_paused INTEGER NOT NULL DEFAULT 0"); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec("ALTER TABLE class_sessions ADD COLUMN student_call_cap INTEGER"); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
for (const statement of [
  "ALTER TABLE works ADD COLUMN copyright_confirmed_at TEXT",
  "ALTER TABLE works ADD COLUMN copyright_confirmed_by TEXT",
  "ALTER TABLE works ADD COLUMN featured_at TEXT",
  "ALTER TABLE works ADD COLUMN featured_by TEXT",
  "ALTER TABLE works ADD COLUMN featured_reason TEXT",
]) {
  try { db.exec(statement); }
  catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_works_org_featured ON works(org_id, featured_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_usage_session_user_created ON usage_records(class_session_id, user_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_usage_generation_job ON usage_records(generation_job_id)');
// usage_records.work_id 此前从未写入过（works.project_id 唯一，一个项目对应一个作品）。
// 这里一次性回填历史用量，之后由学生提交作品的流程实时维护（见 student.js 的 /projects/:id/submit）。
db.exec(`UPDATE usage_records
         SET work_id=(SELECT works.id FROM works WHERE works.project_id=usage_records.project_id)
         WHERE work_id IS NULL AND project_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM works WHERE works.project_id=usage_records.project_id)`);
// Lightweight forward-compatible migration for AI generation retries.
try { db.exec('ALTER TABLE generation_jobs ADD COLUMN retry_of_job_id TEXT'); }
catch (error) { if (String(error?.message || '').includes('duplicate column name')) { /* column already exists */ } else throw error; }
db.exec('CREATE INDEX IF NOT EXISTS idx_generation_jobs_retry_of ON generation_jobs(retry_of_job_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_generation_jobs_user_created ON generation_jobs(user_id, org_id, created_at DESC)');

// Lightweight forward-compatible migration for the class scheduling domain. Existing
// local databases may have been created before makeup sessions were introduced.
try {
  db.exec("ALTER TABLE class_sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'REGULAR'");
} catch (error) {
  if (!String(error?.message || '').includes('duplicate column name')) throw error;
}
try {
  db.exec("ALTER TABLE class_sessions ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'CANVAS'");
} catch (error) {
  if (!String(error?.message || '').includes('duplicate column name')) throw error;
}
try { db.exec('ALTER TABLE billing_packages ADD COLUMN student_seats INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
// Lightweight forward-compatible migration for credit accounting.
try { db.exec('ALTER TABLE org_billing_accounts ADD COLUMN frozen_credits INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE credit_entries ADD COLUMN reversal_of TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_entries_reversal_of ON credit_entries(reversal_of) WHERE reversal_of IS NOT NULL');
// Lightweight forward-compatible migration for student project management.
try { db.exec('ALTER TABLE student_projects ADD COLUMN archived_at TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE student_projects ADD COLUMN deleted_at TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
db.exec('CREATE INDEX IF NOT EXISTS idx_projects_student_status_updated ON student_projects(student_id, org_id, status, updated_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_projects_student_deleted ON student_projects(student_id, deleted_at)');
// Lightweight forward-compatible migration for student account privacy and requests.
for (const statement of [
  'ALTER TABLE users ADD COLUMN avatar_key TEXT',
  'ALTER TABLE users ADD COLUMN guardian_name TEXT',
  'ALTER TABLE users ADD COLUMN guardian_phone TEXT',
  'ALTER TABLE users ADD COLUMN guardian_relationship TEXT',
  'ALTER TABLE users ADD COLUMN guardian_consented_at TEXT',
  'ALTER TABLE users ADD COLUMN privacy_showcase_anonymous INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE users ADD COLUMN privacy_allow_feature INTEGER NOT NULL DEFAULT 1',
]) {
  try { db.exec(statement); }
  catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
}
// Lightweight forward-compatible migration for student account privacy and requests.
for (const statement of [
  'ALTER TABLE users ADD COLUMN avatar_key TEXT',
  'ALTER TABLE users ADD COLUMN guardian_name TEXT',
  'ALTER TABLE users ADD COLUMN guardian_phone TEXT',
  'ALTER TABLE users ADD COLUMN guardian_relationship TEXT',
  'ALTER TABLE users ADD COLUMN guardian_consented_at TEXT',
  'ALTER TABLE users ADD COLUMN privacy_showcase_anonymous INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE users ADD COLUMN privacy_allow_feature INTEGER NOT NULL DEFAULT 1',
]) {
  try { db.exec(statement); }
  catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
}
db.exec(`INSERT OR IGNORE INTO platform_settings(id, created_at, updated_at) VALUES (1, '${new Date().toISOString()}', '${new Date().toISOString()}')`);

// Lightweight forward-compatible migration for user credit adjustment tracking.
db.exec(`CREATE TABLE IF NOT EXISTS user_credit_adjustments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  credits_before INTEGER NOT NULL,
  credits_after INTEGER NOT NULL,
  credits_change INTEGER NOT NULL,
  reason TEXT,
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('ALLOCATION','ADJUSTMENT','RECLAIM')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_user_credit_adjustments_user ON user_credit_adjustments(user_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_user_credit_adjustments_org ON user_credit_adjustments(org_id, created_at DESC)');

export function q(sql, params = []) { return db.prepare(sql).run(...params); }
export function rows(sql, params = []) { return db.prepare(sql).all(...params); }
export function row(sql, params = []) { return db.prepare(sql).get(...params); }
export function count(sql, params = []) { return Number(row(sql, params).n || 0); }
export function one(sql, params = []) { return db.prepare(sql).get(...params); }
export function json(value) { return JSON.stringify(value ?? null); }
export function parseJson(value, fallback = null) { if (value == null) return fallback; try { return JSON.parse(value); } catch { return fallback; } }
export function transaction(fn) {
  db.exec('BEGIN');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

// P4-C03 migration: notification event deduplication, failure retry, ignore/archive
try { db.exec("ALTER TABLE notification_recipients ADD COLUMN event_key TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE notification_recipients ADD COLUMN failure_reason TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE notification_recipients ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE notification_recipients ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3"); } catch (_) {}
try { db.exec("ALTER TABLE notification_recipients ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_notification_recipient_event_key ON notification_recipients(event_key, user_id)"); } catch (_) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_notification_recipient_failed ON notification_recipients(user_id, delivery_status, ignored) WHERE delivery_status='FAILED'"); } catch (_) {}

const _eventsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_events'").get();
if (!_eventsTable) {
  db.exec(`CREATE TABLE IF NOT EXISTS notification_events (
    id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    org_id TEXT,
    audience TEXT NOT NULL DEFAULT '{}',
    target_url TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','SUPPRESSED','FAILED')),
    suppressed_at TEXT,
    suppress_reason TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_key ON notification_events(event_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_notification_events_status ON notification_events(status, created_at DESC)");
}

export function initDatabase() { return db; }

const PEPPER = process.env.AUTH_PEPPER || 'p0-local-pepper';
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(`${PEPPER}:${password}`, salt, 64).toString('hex')}`;
}





// P5-W02 leads 表（演示预约）
db.exec(`CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  org_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW','CONTACTED','DEMO_SCHEDULED','CONVERTED','CLOSED')),
  admin_notes TEXT NOT NULL DEFAULT '',
  assigned_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  legal_consent_version TEXT,
  legal_consented_at TEXT
)`);
try { db.exec('ALTER TABLE leads ADD COLUMN legal_consent_version TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE leads ADD COLUMN legal_consented_at TEXT'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_leads_status_created ON leads(status, created_at DESC)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(contact_phone)'); } catch (_) {}

// P5-W04 works 公开分享字段
try { db.exec('ALTER TABLE works ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE works ADD COLUMN share_token TEXT'); } catch (_) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_works_share_token ON works(share_token) WHERE share_token IS NOT NULL'); } catch (_) {}

// ── 作品「存储层」状态机统一（C2，2026-09-13）─────────────────────────────────
// 之前画布作品的「下架」**复用了 REJECTED**（和「审核不通过」同一个值），下架原因也只能塞进
// teacher_comment（那是审核意见的列）→ 库里分不清「被驳回」与「被下架」，账面上也就分不出来。
// 现在给下架单独的列 + 单独的 status（UNPUBLISHED，见 services/domainState.js）：
//   teacher_comment  只放「审核意见」（驳回时）
//   unpublish_reason 只放「下架原因」（学生能看到的那句）
// ⚠️ 历史行不做「猜着迁移」：老数据里 REJECTED + teacher_comment 无法可靠区分是驳回还是下架
//    （没有 published_at 这类痕迹可比对），所以保持原样；normalizeWork 读取时用 teacher_comment 兜底，
//    这些行的界面话术仍然正确。生产库当前 works 为 0 行，等于没有历史包袱。
try { db.exec('ALTER TABLE works ADD COLUMN unpublish_reason TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE works ADD COLUMN unpublished_at TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }

// works.status 的 CHECK 里要能容纳 UNPUBLISHED（C2）。SQLite 不能直接改 CHECK，
// 按官方推荐重建一次表（与上面 file_assets 那次同一套做法）。
// 幂等：只在旧约束里没有 UNPUBLISHED 时执行；PRAGMA foreign_keys 必须在事务外切换，
// 否则 DROP TABLE 会按外键 ON DELETE CASCADE 连带清空 work_reports / work_submissions / 批注等子表。
// ⚠️ 新表的列必须**把 ALTER 加过的列都写全**（is_public / share_token / unpublish_reason / unpublished_at），
//    索引也要重建 —— 漏一个就是静默丢数据/丢约束。
const worksDdl = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='works'").get()?.sql || '');
if (worksDdl && !worksDdl.includes("'UNPUBLISHED'")) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE works_migrated (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      org_id TEXT,
      class_id TEXT,
      course_lesson_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      canvas_snapshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','PUBLISHED','UNPUBLISHED')),
      teacher_comment TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      copyright_confirmed_at TEXT,
      copyright_confirmed_by TEXT,
      featured_at TEXT,
      featured_by TEXT,
      featured_reason TEXT,
      submitted_at TEXT NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 0,
      share_token TEXT,
      unpublish_reason TEXT,
      unpublished_at TEXT,
      FOREIGN KEY (project_id) REFERENCES student_projects(id) ON DELETE CASCADE
    )`);
    db.exec(`INSERT INTO works_migrated (
      id, project_id, student_id, org_id, class_id, course_lesson_id, title, description, canvas_snapshot,
      status, teacher_comment, reviewed_by, reviewed_at, copyright_confirmed_at, copyright_confirmed_by,
      featured_at, featured_by, featured_reason, submitted_at, is_public, share_token, unpublish_reason, unpublished_at
    ) SELECT
      id, project_id, student_id, org_id, class_id, course_lesson_id, title, description, canvas_snapshot,
      status, teacher_comment, reviewed_by, reviewed_at, copyright_confirmed_at, copyright_confirmed_by,
      featured_at, featured_by, featured_reason, submitted_at,
      COALESCE(is_public, 0), share_token, unpublish_reason, unpublished_at
    FROM works`);
    db.exec('DROP TABLE works');
    db.exec('ALTER TABLE works_migrated RENAME TO works');
    db.exec('CREATE INDEX IF NOT EXISTS idx_works_org_submitted ON works(org_id, submitted_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_works_work_data_scope ON works(org_id, class_id, course_lesson_id, submitted_at DESC)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_works_project_unique ON works(project_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_works_org_featured ON works(org_id, featured_at DESC)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_works_share_token ON works(share_token) WHERE share_token IS NOT NULL');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// ── 课堂成为主对象（2026-09-13 用户拍板：班级彻底退场，只剩课堂）──────────────────────────
// class_sessions 的 CHECK 要容纳 PENDING / DISSOLVED，class_id 要可空、started_* 要可空
// （待上课时还没开始）、并新增 title / series_id / teacher_id / created_at。
// SQLite 改不了 CHECK 与 NOT NULL，按官方推荐重建表（与 file_assets / works 同一套做法）。
// 幂等：只在旧约束（没有 PENDING）时执行；PRAGMA foreign_keys 必须在事务外切换。
// ⚠️ 老行没有 title/series_id/teacher_id：从课时推课包、从 started_by 或班级的负责老师推 teacher_id，
//    并把 created_at 回填成 started_at（老课堂本来就是"创建即开始"）。
const sessionDdl = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='class_sessions'").get()?.sql || '');
if (sessionDdl && !sessionDdl.includes("'PENDING'")) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE class_sessions_migrated (
      id TEXT PRIMARY KEY,
      title TEXT,
      org_id TEXT,
      class_id TEXT,
      series_id TEXT,
      lesson_id TEXT,
      teacher_id TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','ENDED','DISSOLVED')),
      delivery_mode TEXT NOT NULL DEFAULT 'CANVAS',
      session_credit_cap INTEGER,
      consumed_credits_total INTEGER NOT NULL DEFAULT 0,
      ai_paused INTEGER NOT NULL DEFAULT 0,
      student_call_cap INTEGER,
      allow_text INTEGER NOT NULL DEFAULT 1,
      allow_image INTEGER NOT NULL DEFAULT 1,
      allow_music INTEGER NOT NULL DEFAULT 1,
      allow_video INTEGER NOT NULL DEFAULT 0,
      allow_podcast INTEGER NOT NULL DEFAULT 0,
      allow_dubbing INTEGER NOT NULL DEFAULT 0,
      started_by TEXT,
      started_at TEXT,
      ended_by TEXT,
      ended_at TEXT,
      ended_reason TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE SET NULL,
      FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE SET NULL
    )`);
    db.exec(`INSERT INTO class_sessions_migrated (
      id, title, org_id, class_id, series_id, lesson_id, teacher_id, status, delivery_mode,
      session_credit_cap, consumed_credits_total, ai_paused, student_call_cap,
      allow_text, allow_image, allow_music, allow_video, allow_podcast, allow_dubbing,
      started_by, started_at, ended_by, ended_at, ended_reason, created_at, updated_at
    ) SELECT
      session.id,
      COALESCE((SELECT lesson.title FROM course_lessons lesson WHERE lesson.id = session.lesson_id), '课堂'),
      (SELECT owner.org_id FROM users owner WHERE owner.id = COALESCE(session.started_by, (SELECT klass.teacher_id FROM classes klass WHERE klass.id = session.class_id))),
      session.class_id,
      (SELECT lesson.series_id FROM course_lessons lesson WHERE lesson.id = session.lesson_id),
      session.lesson_id,
      COALESCE(session.started_by, (SELECT klass.teacher_id FROM classes klass WHERE klass.id = session.class_id)),
      session.status, session.delivery_mode,
      session.session_credit_cap, session.consumed_credits_total, session.ai_paused, session.student_call_cap,
      session.allow_text, session.allow_image, session.allow_music, session.allow_video, session.allow_podcast, session.allow_dubbing,
      session.started_by, session.started_at, session.ended_by, session.ended_at, session.ended_reason,
      session.started_at, COALESCE(session.ended_at, session.started_at)
    FROM class_sessions session`);
    db.exec('DROP TABLE class_sessions');
    db.exec('ALTER TABLE class_sessions_migrated RENAME TO class_sessions');
    db.exec('CREATE INDEX IF NOT EXISTS idx_class_sessions_status ON class_sessions(status, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_class_sessions_teacher ON class_sessions(teacher_id, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_class_sessions_lesson ON class_sessions(lesson_id, status)');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
// org_id：课堂属于机构（列表与权限过滤都用它）。老库（先前重建过、还没有这列）在这里补上并回填。
try { db.exec('ALTER TABLE class_sessions ADD COLUMN org_id TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('UPDATE class_sessions SET org_id=(SELECT owner.org_id FROM users owner WHERE owner.id = class_sessions.teacher_id) WHERE org_id IS NULL'); } catch (_) {}

// 课堂表的索引统一在这里建：旧库要先重建出 created_at/teacher_id 才能建（写在基础 DDL 里会让老库初始化当场报错）
db.exec('CREATE INDEX IF NOT EXISTS idx_class_sessions_status ON class_sessions(status, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_class_sessions_teacher ON class_sessions(teacher_id, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_class_sessions_lesson ON class_sessions(lesson_id, status)');

// 旧的部分唯一索引（一班一活跃课堂）在新模型里没有意义：同一节课允许多位老师各开一个课堂，
// 「同一个学生在同一节课不能同时在两个课堂」由 session_students 与服务端事务保证。
try { db.exec('DROP INDEX IF EXISTS idx_class_sessions_active'); } catch (_) {}

db.exec(`CREATE TABLE IF NOT EXISTS session_students (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  lesson_id TEXT,
  series_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','COMPLETED','INCOMPLETE','REMOVED')),
  added_by TEXT,
  added_at TEXT NOT NULL,
  removed_by TEXT,
  removed_at TEXT,
  removed_reason TEXT,
  completed_at TEXT,
  completed_cost_fen INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  FOREIGN KEY (session_id) REFERENCES class_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_students_unique ON session_students(session_id, student_id) WHERE status <> 'REMOVED';
CREATE INDEX IF NOT EXISTS idx_session_students_student ON session_students(student_id, lesson_id, status);
CREATE INDEX IF NOT EXISTS idx_session_students_session ON session_students(session_id, status);`);

// 历史课堂的学员回填 —— 只认**证据**：确实在这节课消耗过算力的人判为「已完课」。
// 不按「今天的班级名单」回填：班级成员是可变的，用今天的名单去还原当时谁在这节课上，等于编数据。
// 幂等：`NOT EXISTS (同课堂已有学员行)` 保证只回填「新模型之前的老课堂」，跑第二遍什么都不做。
db.exec(`INSERT OR IGNORE INTO session_students(
    id, session_id, student_id, org_id, lesson_id, series_id, status, added_at, completed_at, completed_cost_fen, updated_at
  )
  SELECT 'ssmig_' || record.class_session_id || '_' || record.user_id,
         record.class_session_id, record.user_id, record.org_id,
         session.lesson_id, session.series_id, 'COMPLETED',
         COALESCE(session.ended_at, session.started_at, record.created_at),
         session.ended_at, SUM(record.cost_fen), COALESCE(session.ended_at, record.created_at)
  FROM usage_records record
  JOIN class_sessions session ON session.id = record.class_session_id
  WHERE record.status='SUCCESS' AND record.cost_fen > 0
    AND session.status IN ('ENDED','DISSOLVED')
    AND NOT EXISTS (SELECT 1 FROM session_students existing WHERE existing.session_id = record.class_session_id)
  GROUP BY record.class_session_id, record.user_id`);

// 作品/项目归属到课堂（教师数据范围的新落点：教师只看得到自己课堂里的作品）
try { db.exec('ALTER TABLE works ADD COLUMN class_session_id TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE student_projects ADD COLUMN class_session_id TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }

// P5-W05 course_series 新字段（仅旧库迁移；新库已在 CREATE TABLE 中定义）
try { db.exec('ALTER TABLE course_series ADD COLUMN difficulty_level INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE course_series ADD COLUMN age_range_min INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE course_series ADD COLUMN age_range_max INTEGER'); } catch (_) {}
try { db.exec("ALTER TABLE course_series ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'"); } catch (_) {}
try { db.exec('ALTER TABLE course_series ADD CONSTRAINT chk_difficulty CHECK (difficulty_level IS NULL OR difficulty_level BETWEEN 1 AND 5)'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_course_series_difficulty ON course_series(difficulty_level)'); } catch (_) {}
try { db.exec('ALTER TABLE course_series ADD COLUMN price_fen INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE course_series ADD COLUMN validity_days INTEGER NOT NULL DEFAULT 365'); } catch (_) {}
try { db.exec('ALTER TABLE course_series ADD COLUMN estimated_credits_per_person INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec("ALTER TABLE course_series ADD COLUMN grade_range TEXT NOT NULL DEFAULT ''"); } catch (_) {}
try { db.exec("ALTER TABLE course_series ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'CANVAS'"); } catch (_) {}

// P5-W05 course_lessons 新字段（仅旧库迁移；新库已在 CREATE TABLE 中定义）
try { db.exec("ALTER TABLE course_lessons ADD COLUMN lesson_content TEXT NOT NULL DEFAULT ''"); } catch (_) {}
try { db.exec("ALTER TABLE course_lessons ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'CANVAS'"); } catch (_) {}
try { db.exec("ALTER TABLE course_lessons ADD COLUMN classroom_config TEXT NOT NULL DEFAULT '{}'"); } catch (_) {}
try { db.exec("ALTER TABLE course_lessons ADD COLUMN canvas_template_snapshot TEXT NOT NULL DEFAULT '{}'"); } catch (_) {}

// 课包授权有效期：有效期挂在「课包 → 机构」的授权上，平台课包本身不设有效期。
// NULL 表示永久有效；到期后该机构不再看到此课包。
try { db.exec('ALTER TABLE course_assignments ADD COLUMN expires_at TEXT'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_course_assignments_org_expires ON course_assignments(org_id, expires_at)'); } catch (_) {}

export function id(prefix) { return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`; }
export function nowIso() { return new Date().toISOString(); }


// P6-A01 member AI credit caps; NULL means unlimited subject to organization balance.
try { db.exec('ALTER TABLE users ADD COLUMN ai_credit_limit INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN ai_credits_used INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
// P6-A02 personal credit balance（供 VibeCoding 等个人创作使用）；magic_stones 作为余额字段。
// 自由画布 / 自由对话 已按产品决定删除，本表保留给未开始的 VibeCoding。
try { db.exec('ALTER TABLE users ADD COLUMN personal_credits INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN magic_stones INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

// P9-R03 course_series cover_asset_id: link course cover to file_assets for PUBLIC_PLATFORM access
try { db.exec('ALTER TABLE course_series ADD COLUMN cover_asset_id TEXT'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_course_series_cover_asset ON course_series(cover_asset_id) WHERE cover_asset_id IS NOT NULL'); } catch (_) {}

// Personal credit ledger (tracks personal credit changes separately from org ledger)
db.exec(`CREATE TABLE IF NOT EXISTS personal_credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  type TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  balance_after INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'FREE_CANVAS',
  project_id TEXT,
  work_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_pcl_user ON personal_credit_ledger(user_id, created_at DESC)'); } catch (_) {}

// 教学素材分类（TEACHING_ASSET）此前只加进了服务端白名单，没进 file_assets 的 CHECK 约束，
// 导致上传备课资料时触发 CHECK 失败。SQLite 不能直接改 CHECK，按官方推荐重建一次表。
// 幂等：只在旧约束里缺少该分类时执行；PRAGMA foreign_keys 必须在事务外切换，
// 否则 DROP TABLE 会按 ON DELETE CASCADE 连带清空 file_access_grants。
const fileAssetsDdl = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='file_assets'").get()?.sql || '');
if (fileAssetsDdl && !fileAssetsDdl.includes("'TEACHING_ASSET'")) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE file_assets_migrated (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('PLATFORM','ORG','USER','SYSTEM')),
      owner_org_id TEXT,
      owner_user_id TEXT,
      storage_kind TEXT NOT NULL DEFAULT 'EXTERNAL_URL' CHECK (storage_kind IN ('EXTERNAL_URL','INTERNAL_PROXY','PENDING')),
      storage_url TEXT,
      storage_key TEXT,
      proxy_route TEXT,
      public_path TEXT,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      file_size INTEGER,
      checksum TEXT,
      category TEXT NOT NULL DEFAULT 'GENERAL' CHECK (category IN ('PROMO_MATERIAL','PROMO_COVER','CLIENT_INSTALLER','MEDIA_ASSET','TEACHING_ASSET','GENERAL')),
      visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','ORG','ASSIGNED_ORGS','PUBLIC_PLATFORM','PUBLIC_RELEASE')),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','DISABLED','REMOVED')),
      review_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (review_status IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED')),
      expires_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_org_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )`);
    db.exec('INSERT INTO file_assets_migrated SELECT id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at FROM file_assets');
    db.exec('DROP TABLE file_assets');
    db.exec('ALTER TABLE file_assets_migrated RENAME TO file_assets');
    db.exec('CREATE INDEX IF NOT EXISTS idx_file_assets_owner ON file_assets(owner_type, owner_org_id, owner_user_id, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_file_assets_category_status ON file_assets(category, status, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_file_assets_visibility ON file_assets(visibility, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_file_assets_storage_url ON file_assets(storage_url)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_file_assets_storage_key ON file_assets(storage_key) WHERE storage_key IS NOT NULL');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// ── VibeCoding 课堂运行时（对话式代码创作 + 受限运行 + 提交点评）────────────────
db.exec(`CREATE TABLE IF NOT EXISTS vibecoding_conversations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  class_id TEXT,
  lesson_id TEXT,
  class_session_id TEXT,
  title TEXT NOT NULL DEFAULT '新的创作对话',
  model TEXT,
  files TEXT NOT NULL DEFAULT '{}',
  entry_file TEXT NOT NULL DEFAULT 'index.html',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','ARCHIVED')),
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_vibe_conv_student ON vibecoding_conversations(student_id, last_message_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_vibe_conv_scope ON vibecoding_conversations(org_id, lesson_id, class_session_id)');

db.exec(`CREATE TABLE IF NOT EXISTS vibecoding_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL DEFAULT '',
  model TEXT,
  status TEXT NOT NULL DEFAULT 'SUCCEEDED' CHECK (status IN ('SUCCEEDED','FAILED','BLOCKED')),
  error_code TEXT,
  credits_charged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES vibecoding_conversations(id) ON DELETE CASCADE
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_vibe_msg_conversation ON vibecoding_messages(conversation_id, created_at)');

// 产物（artifact）：AI 产出的每一个文件。改成「产物优先」的模型——产物有身份、类型、
// 大小、修订号，聊天里才能画产物卡片、工作台才能按类型切视图；旧的 files JSON 只有一个
// 裸的内容映射，拿不到这些信息。
db.exec(`CREATE TABLE IF NOT EXISTS vibecoding_artifacts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES vibecoding_conversations(id) ON DELETE CASCADE
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_vibe_artifact_conversation ON vibecoding_artifacts(conversation_id, updated_at DESC)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_vibe_artifact_name ON vibecoding_artifacts(conversation_id, name)');
// ── 文档产物的生成插画（PPT 每页配图，2026-09-11）────────────────────────────
// 存 [{slideIndex,prompt,fileId,url}]（失败项带 error）。放在这一列而不是重写 content：
// content 是模型写的规格原文（学生能在「源码」里看懂），不该被平台改写。
try { db.exec('ALTER TABLE vibecoding_artifacts ADD COLUMN generated_images TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }

// 启动迁移：把旧的 conversations.files JSON 展开成产物行。
// 幂等——已经有产物的会话跳过；旧列保留不读，出问题可以回滚。
// 只迁移真正有内容的会话（空对象说明是新建后从未产出文件）。
{
  const KIND_BY_EXTENSION = { html: 'html', htm: 'html', css: 'css', js: 'js', mjs: 'js', json: 'json', md: 'md', markdown: 'md', svg: 'svg', csv: 'csv', txt: 'text' };
  const pending = db.prepare(
    `SELECT conversation.id AS id, conversation.files AS files, conversation.created_at AS created_at, conversation.updated_at AS updated_at
     FROM vibecoding_conversations conversation
     WHERE conversation.files IS NOT NULL AND conversation.files != '' AND conversation.files != '{}'
       AND NOT EXISTS (SELECT 1 FROM vibecoding_artifacts artifact WHERE artifact.conversation_id = conversation.id)`,
  ).all();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO vibecoding_artifacts(id,conversation_id,message_id,name,kind,content,bytes,revision,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  let migrated = 0;
  for (const item of pending) {
    let files;
    try { files = JSON.parse(item.files); } catch { continue; }
    if (!files || typeof files !== 'object') continue;
    for (const [name, content] of Object.entries(files)) {
      const text = String(content ?? '');
      const extension = String(name).split('.').pop()?.toLowerCase();
      insert.run(
        id('vibeart'), item.id, null, String(name), KIND_BY_EXTENSION[extension] || 'text',
        text, Buffer.byteLength(text), 1, item.created_at || nowIso(), item.updated_at || nowIso(),
      );
      migrated += 1;
    }
  }
  if (migrated) console.log(`[schema] vibecoding: 已把旧工程文件迁移成 ${migrated} 个产物`);
}

db.exec(`CREATE TABLE IF NOT EXISTS vibecoding_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'javascript' CHECK (language IN ('javascript','html')),
  entry_file TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','TIMEOUT')),
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES vibecoding_conversations(id) ON DELETE CASCADE
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_vibe_run_conversation ON vibecoding_runs(conversation_id, created_at DESC)');

// 提交与点评：works 是画布/作品广场专用的（project_id NOT NULL + UNIQUE 且 FK 到 student_projects），
// VibeCoding 会话没有画布项目，所以单独建表，避免把画布链路改出兼容性问题。
db.exec(`CREATE TABLE IF NOT EXISTS vibecoding_submissions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  student_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  class_id TEXT,
  lesson_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '{}',
  transcript TEXT NOT NULL DEFAULT '[]',
  round INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  teacher_comment TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  submitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES vibecoding_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_vibe_submission_org ON vibecoding_submissions(org_id, status, submitted_at DESC)');
// VibeCoding 提交的「下架原因」：画布链路有 works.teacher_comment（老师点评功能删除后，它只被
// 下架/驳回写入），而 VibeCoding 这条链路**原本一个字都不记** → 学生不知道作品为什么被撤下来。
// 用户口径（梳理文档第 5 节）：下架原因要**学生可见**。
try { db.exec('ALTER TABLE vibecoding_submissions ADD COLUMN unpublish_reason TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }

db.exec('CREATE INDEX IF NOT EXISTS idx_vibe_submission_student ON vibecoding_submissions(student_id, submitted_at DESC)');
try { db.exec("ALTER TABLE vibecoding_submissions ADD COLUMN entry_file TEXT NOT NULL DEFAULT 'index.html'"); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
// 提交那一刻的产物清单（[{name,kind,bytes,revision,updatedAt,generatedImages,attachmentImages}]）。
// 作品广场要回答两个问题：「学生交上来的到底是哪一份产物」（种子 index.html 一直躺在里面，
// 按文件名优先挑就会把作品显示成起始页）和「那份文档的配图在哪」。正文仍走 files 快照，
// 这里只存元信息与图片引用（fileId），所以这一列很小。
try { db.exec("ALTER TABLE vibecoding_submissions ADD COLUMN artifacts TEXT NOT NULL DEFAULT '[]'"); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }


// ── 平台管理员二次验证（TOTP + 恢复码）────────────────────────────────────────
// secret 为 base32 明文（与平台现有密钥存储口径一致，不放数据库加密）；恢复码只存 sha256 哈希。
db.exec(`CREATE TABLE IF NOT EXISTS user_mfa_credentials (
  user_id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ENABLED')),
  recovery_codes TEXT NOT NULL DEFAULT '[]',
  last_totp_counter INTEGER,
  enabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_user_mfa_status ON user_mfa_credentials(status)');

// ── VibeCoding 作品发布到作品广场 ─────────────────────────────────────────────
// 学生提交时确认版权与展示授权；平台在「平台作品库」决定是否发布到作品广场（share_token 前缀 vbt_）。
try { db.exec('ALTER TABLE vibecoding_submissions ADD COLUMN copyright_confirmed_at TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE vibecoding_submissions ADD COLUMN copyright_confirmed_by TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE vibecoding_submissions ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE vibecoding_submissions ADD COLUMN share_token TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE vibecoding_submissions ADD COLUMN published_at TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE vibecoding_submissions ADD COLUMN published_by TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE vibecoding_submissions ADD COLUMN featured_at TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_vibe_submission_share_token ON vibecoding_submissions(share_token) WHERE share_token IS NOT NULL'); }
catch (error) { if (!String(error?.message || '').includes('already exists')) throw error; }

// ── VibeCoding 聊天附件（学生上传的图片，让模型「看图」）──────────────────────
// 存 [{id,name,url}]：url 是公开下载地址（外联），模型与生成出来的页面都能取到。
try { db.exec('ALTER TABLE vibecoding_messages ADD COLUMN attachments TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }

// ── VibeCoding 会话置顶（侧栏排序用）─────────────────────────────────────────
try { db.exec('ALTER TABLE vibecoding_conversations ADD COLUMN pinned_at TEXT'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
