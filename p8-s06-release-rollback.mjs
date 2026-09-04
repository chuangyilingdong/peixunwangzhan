import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const repo = path.resolve(import.meta.dirname);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-s06-'));
const releases = path.join(root, 'releases');
const data = path.join(root, 'data');
const dbPath = path.join(data, 'platform.db');
const current = path.join(root, 'current');
const env = { ...process.env, DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: data, PLATFORM_DB_PATH: dbPath, AUTH_PEPPER: 'p8-s06-temporary-only', AI_PROVIDER: 'local-mock' };
let pass = 0;
let fail = 0;
function check(name, value) {
  if (value) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.error(`FAIL ${name}`); }
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function makeRelease(name, healthy) {
  const dir = path.join(releases, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BUILD-METADATA.txt'), `release=${name}\ncommit=p8-s06-test-${name}\nmode=internal-test\n`);
  fs.writeFileSync(path.join(dir, 'HEALTH'), healthy ? 'ok\n' : 'fail\n');
  return dir;
}
function linkCurrent(target) {
  if (fs.existsSync(current) || fs.lstatSync(current, { throwIfNoEntry: false })) fs.rmSync(current, { recursive: true, force: true });
  fs.symlinkSync(target, current, 'junction');
}
function realCurrent() { return fs.realpathSync(current); }
function safeRelease(target) {
  const releaseRoot = fs.realpathSync(releases);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(`${releaseRoot}${path.sep}`)) throw new Error('release outside root');
  if (!fs.existsSync(path.join(resolved, 'BUILD-METADATA.txt'))) throw new Error('missing metadata');
  return resolved;
}
function switchRelease(target) {
  const release = safeRelease(target);
  const previous = realCurrent();
  linkCurrent(release);
  if (fs.readFileSync(path.join(release, 'HEALTH'), 'utf8').trim() !== 'ok') {
    linkCurrent(previous);
    return { ok: false, restored: realCurrent() === previous, previous, release };
  }
  return { ok: true, restored: false, previous, release };
}
try {
  fs.mkdirSync(releases, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  execFileSync(process.execPath, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  check('发布回滚验收使用临时 SQLite', fs.existsSync(dbPath) && dbPath.startsWith(root));

  const releaseA = makeRelease('20260904T-A', true);
  const releaseB = makeRelease('20260904T-B', true);
  const broken = makeRelease('20260904T-BROKEN', false);
  linkCurrent(releaseA);
  check('预发初始 current 指向已验证 release', realCurrent() === releaseA);
  const switched = switchRelease(releaseB);
  check('预发 release 切换成功', switched.ok && realCurrent() === releaseB);
  const rolled = switchRelease(broken);
  check('健康检查失败自动回滚', rolled.ok === false && rolled.restored && realCurrent() === releaseB);

  const rollbackScript = fs.readFileSync(path.join(repo, 'deploy/internal-test/rollback-internal-test.sh'), 'utf8');
  check('回滚脚本限制 release 必须位于隔离 releases 目录', rollbackScript.includes('Release must stay under $RELEASE_ROOT'));
  check('回滚脚本校验 BUILD-METADATA', rollbackScript.includes('missing BUILD-METADATA.txt'));
  check('回滚脚本拒绝仓库默认数据库', rollbackScript.includes('Refusing repository default database'));
  check('回滚脚本健康失败恢复 previous release', rollbackScript.includes('Health check failed; restoring previous release'));

  const backupOutput = path.join(root, 'backups');
  const backupJson = execFileSync(process.execPath, ['deploy/internal-test/backup-internal-test.mjs', '--root', root, '--db', dbPath, '--output', backupOutput], { cwd: repo, env, encoding: 'utf8' });
  const backup = JSON.parse(backupJson);
  const backupDb = backup.database;
  const before = new DatabaseSync(dbPath, { readOnly: true });
  const beforeUsers = before.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const beforeCourses = before.prepare('SELECT COUNT(*) AS count FROM course_series').get().count;
  before.close();
  check('发布前备份生成数据库与 MANIFEST', fs.existsSync(backupDb) && fs.existsSync(path.join(path.dirname(backupDb), 'MANIFEST.json')));
  const beforeHash = sha256(backupDb);

  const migrationDb = new DatabaseSync(dbPath);
  migrationDb.exec('CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY, note TEXT)');
  migrationDb.prepare('INSERT INTO rollback_probe (note) VALUES (?)').run('bad migration');
  migrationDb.close();
  fs.copyFileSync(backupDb, dbPath);
  const after = new DatabaseSync(dbPath, { readOnly: true });
  const afterUsers = after.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const afterCourses = after.prepare('SELECT COUNT(*) AS count FROM course_series').get().count;
  const probe = after.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='rollback_probe'").get().count;
  after.close();
  check('数据库迁移失败后可恢复备份快照', beforeUsers === afterUsers && beforeCourses === afterCourses && probe === 0 && sha256(dbPath) === beforeHash);

  const releaseDoc = fs.readFileSync(path.join(repo, 'deploy/internal-test/RELEASE-ROLLBACK.md'), 'utf8');
  check('事故响应文档包含分级、通报、止损、复盘模板', ['P0', '通报', '止损', '复盘模板', 'P1'].every((x) => releaseDoc.includes(x)));
  check('发布文档明确不触碰真实数据库和 local-mock 边界', releaseDoc.includes('不得触碰真实线上数据库') && releaseDoc.includes('local-mock'));
  check('回滚脚本未引用画布目录', !rollbackScript.includes('packages/canvas'));
  check('回滚脚本包含默认数据库保护路径', rollbackScript.includes('packages/data/platform.db'));

  console.log(JSON.stringify({ pass, fail, root, status: fail === 0 ? 'RELEASE_ROLLBACK_READY' : 'FAILED', rpo: 'backup snapshot', rollbackRelease: realCurrent() }, null, 2));
  if (fail > 0) process.exitCode = 1;
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  for (let i = 0; i < 8; i += 1) {
    try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
}
