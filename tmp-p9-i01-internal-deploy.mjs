import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

const repo = path.resolve(import.meta.dirname);
const releaseRoot = path.join(repo, 'deploy', 'releases');
const releases = fs.readdirSync(releaseRoot).filter((entry) => fs.statSync(path.join(releaseRoot, entry)).isDirectory()).sort();
assert.ok(releases.length > 0, 'release directory exists');
const release = path.join(releaseRoot, releases.at(-1));
const acceptanceRoot = path.join(repo, `.internal-test-acceptance-${Date.now()}`);
const dataDir = path.join(acceptanceRoot, 'data');
const dbPath = path.join(dataDir, 'platform.db');
fs.mkdirSync(dataDir, { recursive: true });
const env = {
  ...process.env,
  DEPLOYMENT_MODE: 'internal-test',
  PLATFORM_DATA_DIR: dataDir,
  PLATFORM_DB_PATH: dbPath,
  PORT: '18787',
  AI_PROVIDER: 'local-mock',
  AUTH_PEPPER: 'acceptance-only-pepper',
};
const runNode = (script) => execFileSync(process.execPath, [script], { cwd: release, env, stdio: 'pipe', encoding: 'utf8' });

const expectedFiles = [
  'apps/admin/index.html', 'apps/org/index.html', 'apps/student/index.html', 'apps/website/index.html',
  'apps/server/src/index.js', 'apps/server/src/routes/auth.js',
  'packages/database/src/schema.js', 'node_modules/@platform/database/package.json',
  'node_modules/@platform/database/src/schema.js', 'BUILD-METADATA.txt',
];
for (const relative of expectedFiles) assert.ok(fs.existsSync(path.join(release, relative)), `release file: ${relative}`);
const metadata = fs.readFileSync(path.join(release, 'BUILD-METADATA.txt'), 'utf8');
assert.match(metadata, /^mode=internal-test$/m, 'release mode metadata');

runNode('packages/database/src/db.js');
runNode('packages/database/src/seed.js');
assert.ok(fs.existsSync(dbPath), 'isolated SQLite database created');
const seededDb = new DatabaseSync(dbPath);
const tableCount = seededDb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
const userCount = seededDb.prepare('SELECT COUNT(*) AS n FROM users').get().n;
assert.ok(Number(tableCount) >= 20, `schema initialized (${tableCount} tables)`);
assert.ok(Number(userCount) >= 4, `seed created test accounts (${userCount} users)`);
seededDb.close();

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: release, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
server.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:18787/health');
      if (response.status === 200) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, `API became ready${stderr ? `: ${stderr}` : ''}`);

  const health = await fetch('http://127.0.0.1:18787/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).data.status, 'ok');
  assert.equal(health.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(health.headers.get('x-internal-test'), 'true');

  const robots = await fetch('http://127.0.0.1:18787/robots.txt');
  const robotsText = await robots.text();
  assert.equal(robots.status, 200);
  assert.match(robotsText, /Disallow:\s*\//);
  assert.doesNotMatch(robotsText, /Allow:\s*\//);
  assert.equal(robots.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');

  const sitemap = await fetch('http://127.0.0.1:18787/sitemap.xml');
  assert.equal(sitemap.status, 404);
  assert.equal(sitemap.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');

  const nginx = fs.readFileSync(path.join(repo, 'deploy', 'internal-test', 'nginx.conf.example'), 'utf8');
  assert.match(nginx, /auth_basic\s+"Internal test only"/);
  assert.match(nginx, /auth_basic_user_file/);
  assert.match(nginx, /X-Robots-Tag\s+"noindex, nofollow, noarchive"/);
  assert.match(nginx, /try_files \$uri \$uri\/ \/index\.html/);
  assert.match(nginx, /location = \/api\/health[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:8788\/health;/, 'external health endpoint maps to application /health');
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8788;/);
  assert.doesNotMatch(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8788\/(?!health;)/, 'API proxy preserves the /api prefix');

  const websiteHtml = fs.readFileSync(path.join(release, 'apps/website/index.html'), 'utf8');
  assert.match(websiteHtml, /noindex, nofollow, noarchive/);
  const websiteAssets = fs.readdirSync(path.join(release, 'apps/website/assets')).map((name) => fs.readFileSync(path.join(release, 'apps/website/assets', name), 'utf8')).join('\n');
  assert.match(websiteAssets, /内部测试环境/);
  assert.match(websiteAssets, /不代表正式服务/);

  console.log(JSON.stringify({ pass: 24, fail: 0, release, isolatedDb: dbPath }, null, 2));
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(3000)]);
  fs.rmSync(acceptanceRoot, { recursive: true, force: true });
}

