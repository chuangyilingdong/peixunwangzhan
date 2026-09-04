import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-s04-'));
const data = path.join(root, 'data');
const dbPath = path.join(data, 'platform.db');
const backupRoot = path.join(root, 'backups');
const currentRelease = fs.readdirSync(path.join(repo, 'deploy', 'releases')).filter((name) => fs.statSync(path.join(repo, 'deploy', 'releases', name)).isDirectory()).sort().at(-1);
const releaseSource = path.join(repo, 'deploy', 'releases', currentRelease);
const current = path.join(root, 'current');
const config = path.join(root, 'config');
const logs = path.join(root, 'logs');
const restoredDb = path.join(data, 'restored.db');
const port = '18884';
const env = { ...process.env, DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: data, PLATFORM_DB_PATH: dbPath, PORT: port, AUTH_PEPPER: 'p8-s04-temporary-only', AI_PROVIDER: 'local-mock' };
let server; let preserve = false; let pass = 0; let fail = 0;
function check(name, condition, details = '') { if (condition) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.error(`FAIL ${name}${details ? `: ${details}` : ''}`); } }
async function get(pathname) { try { const r = await fetch(`http://127.0.0.1:${port}${pathname}`); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = null; } return { status: r.status, body }; } catch (error) { return { status: 0, body: String(error) }; } }
async function health() { for (let i = 0; i < 60; i += 1) { const r = await get('/health'); if (r.status === 200 && r.body?.data?.status === 'ok') return true; await delay(100); } return false; }
try {
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(logs, { recursive: true });
  execFileSync(process.execPath, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  check('创建并 seed 临时恢复源数据库', fs.existsSync(dbPath) && dbPath.startsWith(root));
  fs.cpSync(releaseSource, current, { recursive: true });
  fs.writeFileSync(path.join(current, 'BUILD-METADATA.txt'), fs.readFileSync(path.join(releaseSource, 'BUILD-METADATA.txt')));
  fs.writeFileSync(path.join(config, 'internal-test.env'), 'DEPLOYMENT_MODE=internal-test\nPLATFORM_DB_PATH=/isolated/data/platform.db\n');
  fs.writeFileSync(path.join(logs, 'api.log'), 'isolated backup drill\n');
  const sourceDb = new DatabaseSync(dbPath, { readOnly: true });
  const sourceUsers = Number(sourceDb.prepare('SELECT COUNT(*) AS n FROM users').get().n);
  const sourceCourses = Number(sourceDb.prepare('SELECT COUNT(*) AS n FROM course_series').get().n);
  sourceDb.close();
  const backupStarted = performance.now();
  const output = execFileSync(process.execPath, [path.join(repo, 'deploy/internal-test/backup-internal-test.mjs'), '--root', root, '--db', dbPath, '--output', backupRoot], { cwd: repo, env, encoding: 'utf8' });
  const backupDuration = performance.now() - backupStarted;
  const result = JSON.parse(output);
  const backupDb = path.join(result.backupDir, 'platform.db');
  check('备份目录和数据库备份已生成', fs.existsSync(result.backupDir) && fs.existsSync(backupDb));
  check('备份包含 release / 配置 / 日志 / MANIFEST', fs.existsSync(path.join(result.backupDir, 'release', 'BUILD-METADATA.txt')) && fs.existsSync(path.join(result.backupDir, 'config', 'internal-test.env')) && fs.existsSync(path.join(result.backupDir, 'logs', 'api.log')) && fs.existsSync(path.join(result.backupDir, 'MANIFEST.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.backupDir, 'MANIFEST.json'), 'utf8'));
  check('MANIFEST 记录隔离数据库路径', manifest.database === dbPath && !manifest.database.includes(`${path.sep}packages${path.sep}data${path.sep}`));
  fs.copyFileSync(backupDb, restoredDb);
  const restored = new DatabaseSync(restoredDb, { readOnly: true });
  const restoredUsers = Number(restored.prepare('SELECT COUNT(*) AS n FROM users').get().n);
  const restoredCourses = Number(restored.prepare('SELECT COUNT(*) AS n FROM course_series').get().n);
  restored.close();
  check('恢复数据库保留用户和课程数据', restoredUsers === sourceUsers && restoredCourses === sourceCourses);
  const restoreStarted = performance.now();
  const restoreEnv = { ...env, PLATFORM_DB_PATH: restoredDb, PLATFORM_DATA_DIR: data };
  server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: repo, env: restoreEnv, stdio: 'ignore' });
  const ready = await health();
  const restoreDuration = performance.now() - restoreStarted;
  check('使用恢复数据库启动 API 并通过健康检查', ready);
  const legal = await get('/api/public/legal');
  check('恢复后的 API 可读取业务接口', legal.status === 200 && legal.body?.success === true);
  check('恢复数据库未被误认作仓库默认库', path.resolve(restoredDb) !== path.resolve(repo, 'packages/data/platform.db'));
  check('备份和恢复演练耗时已记录', backupDuration >= 0 && restoreDuration >= 0);
  console.log(JSON.stringify({ pass, fail, backupDurationMs: Number(backupDuration.toFixed(1)), restoreRtoMs: Number(restoreDuration.toFixed(1)), rpo: '备份时点', sourceUsers, restoredUsers, sourceCourses, restoredCourses, backupDir: result.backupDir }, null, 2));
  if (fail > 0) process.exitCode = 1;
} catch (error) { preserve = true; console.error(error?.stack || error); process.exitCode = 1; }
finally { if (server && !server.killed) { server.kill('SIGTERM'); await delay(200); if (!server.killed) server.kill('SIGKILL'); } if (!preserve && fail === 0) { for (let i = 0; i < 8; i += 1) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await delay(100); } } } else console.error(`备份恢复证据保留于 ${root}`); }
