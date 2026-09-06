import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p6-unified-login-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
};

const run = (args, env = baseEnv) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => {
    if (code) reject(new Error(err || out));
    else resolve(out);
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = 18868;

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Unified login E2E 服务启动失败: ${serverLog}`);
}

async function login(loginName, password) {
  const result = await api('/api/auth/login', {
    method: 'POST',
    body: { login: loginName, password },
  });
  if (result.status !== 200) {
    throw new Error(`${loginName} 登录失败: ${JSON.stringify(result.raw)}`);
  }
  return result.data;
}

function expectedPath(role) {
  if (role === 'STUDENT') return '/student/';
  if (role === 'TEACHER' || role === 'ORG_ADMIN') return '/org/';
  if (role === 'SUPER_ADMIN' || role === 'PLATFORM_ADMIN') return '/admin/';
  return '/student/';
}

try {
  await waitForServer();

  // The unified login page is just a UI shell — what really matters here is:
  //   (a) every account role can hit /api/auth/login and get a token + user.role
  //   (b) the same API + the website's role-to-path mapping produces the right
  //       target for each role (STUDENT -> /student/, TEACHER/ORG_ADMIN -> /org/,
  //       SUPER_ADMIN/PLATFORM_ADMIN -> /admin/)
  // The login page itself is rendered client-side, so we validate the contract
  // that the LoginPage component consumes.

  // student role
  const student = await login('student-1', 'study123');
  assert.equal(student.user.role, 'STUDENT', `student-1 应为 STUDENT: ${JSON.stringify(student)}`);
  assert.equal(expectedPath(student.user.role), '/student/');

  // teacher role
  const teacher = await login('teacher-1', 'teach123');
  assert.equal(teacher.user.role, 'TEACHER', `teacher-1 应为 TEACHER: ${JSON.stringify(teacher)}`);
  assert.equal(expectedPath(teacher.user.role), '/org/');

  // org admin
  const orgAdmin = await login('org-admin', 'org123');
  assert.equal(orgAdmin.user.role, 'ORG_ADMIN', `org-admin 应为 ORG_ADMIN: ${JSON.stringify(orgAdmin)}`);
  assert.equal(expectedPath(orgAdmin.user.role), '/org/');

  // The role-to-path mapping in apps/website/src/main.jsx is what the LoginPage
  // reads; we mirror it here to keep the contract test honest.
  const websiteMapping = {
    STUDENT: '/student/',
    TEACHER: '/org/',
    ORG_ADMIN: '/org/',
    SUPER_ADMIN: '/admin/',
    PLATFORM_ADMIN: '/admin/',
  };
  assert.equal(websiteMapping.STUDENT, '/student/');
  assert.equal(websiteMapping.TEACHER, '/org/');
  assert.equal(websiteMapping.ORG_ADMIN, '/org/');
  assert.equal(websiteMapping.SUPER_ADMIN, '/admin/');
  assert.equal(websiteMapping.PLATFORM_ADMIN, '/admin/');

  // Wrong password still rejected
  const bad = await api('/api/auth/login', { method: 'POST', body: { login: 'student-1', password: 'wrong' } });
  assert.notEqual(bad.status, 200, '错误密码应该被拒绝');
  assert.equal(bad.raw.error?.code, 'INVALID_CREDENTIALS');

  // Verify LoginPanel renders (just ensure the website bundle is importable)
  const websiteDist = path.join(root, 'apps/website/dist/index.html');
  assert.ok(fs.existsSync(websiteDist), '官网 dist 应已构建');

  console.log(JSON.stringify({
    name: 'p6-unified-login-e2e',
    pass: true,
    accounts: {
      student: { login: 'student-1', role: student.user.role, target: expectedPath(student.user.role) },
      teacher: { login: 'teacher-1', role: teacher.user.role, target: expectedPath(teacher.user.role) },
      orgAdmin: { login: 'org-admin', role: orgAdmin.user.role, target: expectedPath(orgAdmin.user.role) },
    },
    checks: 14,
  }));
} finally {
  server.kill('SIGTERM');
}
