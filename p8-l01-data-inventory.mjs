import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-l01-'));
const tempDb = path.join(tempRoot, 'platform.db');
process.env.PLATFORM_DATA_DIR = tempRoot;
process.env.PLATFORM_DB_PATH = tempDb;
let pass = 0;
let database;
function check(name, condition, details = '') {
  assert.ok(condition, `${name}${details ? `: ${details}` : ''}`);
  pass += 1;
  console.log(`PASS ${name}`);
}
try {
  ({ db: database } = await import('./packages/database/src/schema.js'));
  const db = database;
  const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const tables = new Set(tableRows.map((row) => row.name));
  const expected = {
    users: ['login', 'display_name', 'role', 'org_id', 'password_hash', 'phone', 'guardian_name', 'guardian_phone', 'guardian_consented_at', 'deleted_at'],
    sessions: ['token_hash', 'user_id', 'expires_at', 'superseded_at'],
    organizations: ['name', 'contact'],
    student_projects: ['student_id', 'org_id', 'canvas_snapshot', 'deleted_at'],
    works: ['student_id', 'org_id', 'canvas_snapshot', 'is_public', 'share_token'],
    generation_jobs: ['user_id', 'project_id', 'prompt', 'provider', 'status'],
    file_assets: ['owner_user_id', 'owner_org_id', 'storage_url', 'storage_key', 'visibility'],
    leads: ['contact_name', 'contact_phone', 'legal_consent_version', 'legal_consented_at'],
    legal_consents: ['user_id', 'consent_type', 'version', 'consented_at'],
    account_requests: ['user_id', 'type', 'status', 'export_payload'],
    audit_logs: ['actor_id', 'request_path', 'before_data', 'after_data', 'ip'],
    analytics_events: ['anonymous_id', 'event_name', 'path', 'metadata', 'created_at'],
  };
  for (const [table, columns] of Object.entries(expected)) {
    check(`asset table ${table}`, tables.has(table));
    const actual = new Set(db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => row.name));
    for (const column of columns) check(`${table}.${column} registered`, actual.has(column));
  }
  check('schema created in temporary SQLite', tempDb.startsWith(tempRoot) && fs.existsSync(tempDb));
  check('default database was not selected', path.resolve(tempDb) !== path.resolve(root, 'packages/data/platform.db'));
  console.log(JSON.stringify({ pass, fail: 0, database: tempDb }, null, 2));
} finally {
  database?.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

