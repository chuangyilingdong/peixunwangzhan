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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_users_org_role ON users(org_id, role, deleted_at, status);

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
  owner_type TEXT NOT NULL DEFAULT 'PLATFORM' CHECK (owner_type IN ('PLATFORM','ORG')),
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'ALL_ORGS' CHECK (visibility IN ('ALL_ORGS','ASSIGNED_ORGS','PRIVATE')),
  version TEXT NOT NULL DEFAULT '1.0',
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  marketplace_status TEXT NOT NULL DEFAULT 'NONE',
  marketplace_reward_credits INTEGER NOT NULL DEFAULT 0,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (series_id) REFERENCES course_series(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_course_lessons_series_sort ON course_lessons(series_id, sort);

CREATE TABLE IF NOT EXISTS course_assignments (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  assigned_by TEXT,
  assigned_at TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS class_sessions (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  lesson_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED')),
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
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_by TEXT,
  ended_at TEXT,
  ended_reason TEXT,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_sessions_active ON class_sessions(class_id) WHERE status = 'ACTIVE';

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
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_projects_student_updated ON student_projects(student_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_org_updated ON student_projects(org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_work_data_scope ON student_projects(org_id, class_id, course_lesson_id, updated_at DESC);

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
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES student_projects(id) ON DELETE CASCADE
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
  delivery_status TEXT NOT NULL DEFAULT 'DELIVERED' CHECK (delivery_status IN ('PENDING','DELIVERED','FAILED')),
  delivered_at TEXT,
  read_at TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_recipient_unique ON notification_recipients(notification_id, user_id);
CREATE INDEX IF NOT EXISTS idx_notification_recipient_user_read ON notification_recipients(user_id, read_at, created_at DESC);

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
`;

db.exec(SCHEMA);
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

// Lightweight forward-compatible migration for the class scheduling domain. Existing
// local databases may have been created before makeup sessions were introduced.
try { db.exec("ALTER TABLE class_sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'REGULAR'"); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
try { db.exec('ALTER TABLE billing_packages ADD COLUMN student_seats INTEGER NOT NULL DEFAULT 0'); }
catch (error) { if (!String(error?.message || '').includes('duplicate column name')) throw error; }
db.exec(`INSERT OR IGNORE INTO platform_settings(id, created_at, updated_at) VALUES (1, '${new Date().toISOString()}', '${new Date().toISOString()}')`);

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
export function initDatabase() { return db; }

const PEPPER = process.env.AUTH_PEPPER || 'p0-local-pepper';
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(`${PEPPER}:${password}`, salt, 64).toString('hex')}`;
}





export function id(prefix) { return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`; }
export function nowIso() { return new Date().toISOString(); }

