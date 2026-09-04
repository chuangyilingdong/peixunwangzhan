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

const root = path.resolve(arg('--root', process.env.PRODUCTION_ROOT || '/srv/ai-kids-platform/production'));
const dbPath = path.resolve(arg('--db', process.env.PLATFORM_DB_PATH || path.join(root, 'data', 'platform.db')));
const outputRoot = path.resolve(arg('--output', process.env.PRODUCTION_BACKUP_ROOT || path.join(root, 'backups')));
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
if (currentTarget) {
  const releaseBackup = path.join(backupDir, 'release');
  fs.rmSync(releaseBackup, { recursive: true, force: true });
  copyIfExists(currentTarget, releaseBackup);
  if (!fs.existsSync(path.join(releaseBackup, 'BUILD-METADATA.txt')) ||
      !fs.existsSync(path.join(releaseBackup, 'apps/server/src/index.js'))) {
    throw new Error(`Release backup incomplete for ${currentTarget}`);
  }
}
copyIfExists(path.join(root, 'config'), path.join(backupDir, 'config'));
// Only copy a bounded monitoring log snapshot. Copying the whole logs directory would recursively
// include backup logs when a custom output root is placed under logs, and historical logs are rotated.
const logBackup = path.join(backupDir, 'logs');
fs.mkdirSync(logBackup, { recursive: true });
for (const name of ['monitoring-health.log', 'monitoring-alerts.log']) {
  const source = path.join(root, 'logs', name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(logBackup, name));
}
const manifest = {
  createdAt: new Date().toISOString(),
  environment: 'production',
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
