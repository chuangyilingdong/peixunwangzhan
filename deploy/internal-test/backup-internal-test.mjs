#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] || fallback) : fallback;
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function copyIfExists(source, destination) {
  if (!fs.existsSync(source)) return false;
  fs.cpSync(source, destination, { recursive: true, dereference: true });
  return true;
}

const root = path.resolve(arg('--root', process.env.INTERNAL_TEST_ROOT || '/srv/ai-kids-platform/internal-test'));
const dbPath = path.resolve(arg('--db', process.env.PLATFORM_DB_PATH || path.join(root, 'data', 'platform.db')));
const outputRoot = path.resolve(arg('--output', process.env.INTERNAL_TEST_BACKUP_ROOT || path.join(root, 'backups')));
if (dbPath.toLowerCase().includes(`${path.sep}packages${path.sep}data${path.sep}`)) {
  throw new Error(`Refusing to back up the repository default database: ${dbPath}`);
}
if (!fs.existsSync(dbPath)) throw new Error(`Database does not exist: ${dbPath}`);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const backupDir = path.join(outputRoot, stamp);
const backupDb = path.join(backupDir, 'platform.db');
fs.mkdirSync(backupDir, { recursive: true });

const db = new DatabaseSync(dbPath, { readOnly: true });
const escaped = backupDb.replaceAll("'", "''");
db.exec(`VACUUM INTO '${escaped}'`);
db.close();

const current = path.join(root, 'current');
const currentTarget = fs.existsSync(current) ? fs.realpathSync(current) : null;
if (currentTarget) copyIfExists(currentTarget, path.join(backupDir, 'release'));
copyIfExists(path.join(root, 'config'), path.join(backupDir, 'config'));
copyIfExists(path.join(root, 'logs'), path.join(backupDir, 'logs'));
const manifest = {
  createdAt: new Date().toISOString(),
  root,
  database: dbPath,
  databaseSha256: sha256(backupDb),
  currentTarget,
  releaseMetadata: currentTarget && fs.existsSync(path.join(currentTarget, 'BUILD-METADATA.txt'))
    ? fs.readFileSync(path.join(currentTarget, 'BUILD-METADATA.txt'), 'utf8')
    : null,
};
fs.writeFileSync(path.join(backupDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ backupDir, database: backupDb, currentTarget }, null, 2));
