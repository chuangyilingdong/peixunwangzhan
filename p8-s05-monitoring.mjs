import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-s05-'));
const data = path.join(root, 'data');
const db = path.join(data, 'platform.db');
const port = '18885';
const env = { ...process.env, DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: data, PLATFORM_DB_PATH: db, PORT: port, AUTH_PEPPER: 'p8-s05-temporary-only', AI_PROVIDER: 'local-mock' };
let server; let pass = 0; let fail = 0;
function check(name, value) { if (value) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.error(`FAIL ${name}`); } }
async function request(pathname) { try { const r = await fetch(`http://127.0.0.1:${port}${pathname}`); return { status: r.status, headers: r.headers, text: await r.text() }; } catch { return { status: 0, headers: new Headers(), text: '' }; } }
async function waitHealth() { for (let i = 0; i < 60; i += 1) { const r = await request('/health'); if (r.status === 200) return r; await delay(100); } return null; }
try {
  fs.mkdirSync(data, { recursive: true });
  execFileSync(process.execPath, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  check('监控验收使用临时 SQLite', fs.existsSync(db) && db.startsWith(root));
  server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: repo, env, stdio: 'ignore' });
  const health = await waitHealth();
  check('健康探针可检测 API 正常', health?.status === 200);
  check('健康响应包含内测 noindex 标识', health?.headers.get('x-robots-tag')?.includes('noindex') === true && health?.headers.get('x-internal-test') === 'true');
  const error = await request('/api/route-not-found-for-monitoring');
  check('错误响应可由监控识别为 404 且不泄露堆栈', error.status === 404 && !error.text.includes('node:internal') && !error.text.includes('stack'));
  const deployDir = path.join(repo, 'deploy/internal-test');
  const runbook = fs.readFileSync(path.join(deployDir, 'RUNBOOK.md'), 'utf8');
  const monitoring = fs.readFileSync(path.join(deployDir, 'MONITORING.md'), 'utf8');
  const healthcheck = fs.readFileSync(path.join(deployDir, 'monitoring-healthcheck.sh'), 'utf8');
  const service = fs.readFileSync(path.join(deployDir, 'ai-kids-platform-healthcheck.service.example'), 'utf8');
  const timer = fs.readFileSync(path.join(deployDir, 'ai-kids-platform-healthcheck.timer.example'), 'utf8');
  const logrotate = fs.readFileSync(path.join(deployDir, 'ai-kids-platform-internal-test.logrotate.example'), 'utf8');
  check('健康检查脚本存在且检查 API、磁盘和当前 release', healthcheck.startsWith('#!/usr/bin/env bash') && healthcheck.includes('curl -fsS --max-time 5 http://127.0.0.1:8788/health') && healthcheck.includes('df -P "$ROOT"') && healthcheck.includes('readlink -f "$ROOT/current"'));
  check('systemd service 指向隔离内测健康检查脚本', service.includes('Type=oneshot') && service.includes('ExecStart=/srv/ai-kids-platform/internal-test/bin/monitoring-healthcheck.sh'));
  check('systemd timer 配置为每分钟执行并开机启用', timer.includes('OnUnitActiveSec=1min') && timer.includes('OnBootSec=1min') && timer.includes('WantedBy=timers.target'));
  check('logrotate 配置存在并保留 14 天', logrotate.includes('/srv/ai-kids-platform/internal-test/logs/monitoring-health.log') && logrotate.includes('rotate 14') && logrotate.includes('copytruncate'));
  check('监控模板不伪造真实通知渠道', ![healthcheck, service, timer, logrotate].some((text) => /飞书|电话|短信|邮件|webhook|pagerduty|钉钉/i.test(text)));
  check('监控矩阵覆盖健康、5xx、慢请求、磁盘、备份、队列和证书', ['API 健康', 'HTTP 5xx', 'API 慢请求', '磁盘空间', 'SQLite 完整性 / 备份', 'AI 任务队列', 'HTTPS 证书'].every((x) => monitoring.includes(x)));
  check('告警矩阵包含阈值、责任人、通知和处置', monitoring.includes('责任人') && monitoring.includes('通知与处置') && monitoring.includes('飞书值班群') && monitoring.includes('回滚'));
  check('运行手册包含日志采集和错误上报规则', runbook.includes('journalctl') && runbook.includes('不得在日志或工单中粘贴密码'));
  check('监控方案明确未伪造真实 provider / 通知', monitoring.includes('不表示已经接入真实第三方告警平台') && monitoring.includes('local-mock'));
  console.log(JSON.stringify({ pass, fail, database: db, status: 'BASELINE_READY', external: 'Real notification channels still require external ops accounts and rules' }, null, 2));
  if (fail > 0) process.exitCode = 1;
} catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
finally { if (server && !server.killed) { server.kill('SIGTERM'); await delay(200); if (!server.killed) server.kill('SIGKILL'); } for (let i = 0; i < 8; i += 1) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await delay(100); } } }
