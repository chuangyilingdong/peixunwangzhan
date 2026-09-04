import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname);
const nodeExe = process.execPath;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-q01-'));
const data = path.join(root, 'data');
const env = { ...process.env, DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: data, PLATFORM_DB_PATH: path.join(data, 'platform.db'), AUTH_PEPPER: 'p8-q01-temporary-only', AI_PROVIDER: 'local-mock' };
let pass = 0;
let fail = 0;
function check(name, value) { if (value) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.error(`FAIL ${name}`); } }
function files(globRoot, suffixes) {
  const result = [];
  for (const entry of fs.readdirSync(globRoot, { withFileTypes: true })) {
    if (entry.name === 'canvas') continue;
    const full = path.join(globRoot, entry.name);
    if (entry.isDirectory()) result.push(...files(full, suffixes));
    else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) result.push(full);
  }
  return result;
}
try {
  fs.mkdirSync(data, { recursive: true });
  execFileSync(nodeExe, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(nodeExe, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  check('质量验收使用临时 SQLite', fs.existsSync(env.PLATFORM_DB_PATH) && env.PLATFORM_DB_PATH.startsWith(root));

  const jsFiles = [...files(path.join(repo, 'apps'), ['.js', '.mjs']), ...files(path.join(repo, 'packages'), ['.js', '.mjs'])];
  let syntaxOk = true;
  for (const file of jsFiles) {
    try { execFileSync(nodeExe, ['--check', file], { cwd: repo, env, stdio: 'pipe' }); }
    catch { syntaxOk = false; console.error(`Syntax failure: ${path.relative(repo, file)}`); }
  }
  check(`非画布 JavaScript / MJS 语法检查 ${jsFiles.length} 个文件通过`, syntaxOk);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  check('packageManager 固定 pnpm 11', /^pnpm@11\./.test(packageJson.packageManager));
  check('四端 Vite 配置齐全', ['admin', 'org', 'student', 'website'].every((app) => fs.existsSync(path.join(repo, `apps/${app}/vite.config.mjs`))));
  check('构建脚本覆盖四端', packageJson.scripts?.build?.includes('apps/admin') && packageJson.scripts.build.includes('apps/website'));

  const sourceFiles = [...files(path.join(repo, 'apps'), ['.js', '.mjs', '.jsx']), ...files(path.join(repo, 'packages'), ['.js', '.mjs', '.jsx'])];
  const source = sourceFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  check('非画布源码无 debugger 语句', !/\bdebugger\b/.test(source));
  check('非画布源码无常见硬编码密钥模式', !/(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----)/.test(source));
  check('服务配置保留 local-mock 明确边界', source.includes('local-mock'));
  const deployGuard = fs.readFileSync(path.join(repo, 'deploy/internal-test/rollback-internal-test.sh'), 'utf8');
  check('默认数据库保护逻辑存在', deployGuard.includes('packages/data/platform.db'));
  try { execFileSync('git', ['diff', '--check'], { cwd: repo, env, stdio: 'pipe' }); check('git diff --check 通过', true); }
  catch { check('git diff --check 通过', false); }

  const pnpmCli = path.join(path.dirname(nodeExe), '..', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
  const buildEnv = { ...env, PATH: `${path.dirname(nodeExe)}${path.delimiter}${process.env.PATH || ''}`, npm_node_execpath: nodeExe, NODE: nodeExe };
  execFileSync(nodeExe, [pnpmCli, 'build'], { cwd: repo, env: buildEnv, stdio: 'pipe' });
  check('四端生产构建通过', true);

  console.log(JSON.stringify({ pass, fail, status: fail === 0 ? 'QUALITY_BASELINE_READY' : 'FAILED', syntaxFiles: jsFiles.length }, null, 2));
  if (fail > 0) process.exitCode = 1;
} catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
finally { for (let i = 0; i < 8; i += 1) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } } }
