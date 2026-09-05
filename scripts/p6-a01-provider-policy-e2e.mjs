import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p6-e2e-'));
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
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => code ? reject(new Error(err || out)) : resolve(out));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 18865;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (x) => { serverLog += x; });
server.stdout.on('data', (x) => { serverLog += x; });

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
  return { status: response.status, data: payload?.data ?? payload };
}
const expect = (condition, message, details) => {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(details)}`);
};

try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {}
    await sleep(100);
  }

  const adminLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } });
  expect(adminLogin.status === 200 && adminLogin.data?.token, '管理员登录失败', adminLogin);
  const admin = adminLogin.data.token;

  const orgLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } });
  expect(orgLogin.status === 200 && orgLogin.data?.token, '机构管理员登录失败', orgLogin);
  const org = orgLogin.data.token;

  const studentLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } });
  expect(studentLogin.status === 200 && studentLogin.data?.token, '学生登录失败', studentLogin);
  const student = studentLogin.data.token;

  const before = await api('/api/admin/billing-config/ai-provider', { token: admin });
  expect(before.status === 200 && before.data.catalog.length === 6, '初始策略接口失败', before);

  const invalidBudget = await api('/api/admin/billing-config/ai-provider', {
    method: 'PUT',
    token: admin,
    body: {
      provider: 'openai-compatible',
      model: 'gpt-test',
      endpoint: 'https://provider.invalid/v1',
      platformPerCallBudget: 20,
      platformDailyBudget: 10,
      reason: '隔离测试：预算倒置应拒绝',
    },
  });
  expect(invalidBudget.status === 400 && invalidBudget.data?.error?.code === 'AI_BUDGET_RANGE_INVALID', '预算倒置未被拒绝', invalidBudget);

  const external = await api('/api/admin/billing-config/ai-provider', {
    method: 'PUT',
    token: admin,
    body: {
      provider: 'custom',
      displayName: '隔离自定义供应商',
      model: 'custom-test-model',
      endpoint: 'https://provider.invalid/v1',
      platformPerCallBudget: 5,
      platformDailyBudget: 100,
      reason: '隔离测试：验证通用与自定义供应商配置',
    },
  });
  expect(external.status === 200 && external.data.policy.provider === 'custom', '自定义供应商保存失败', external);

  const courses = await api('/api/student/courses', { token: student });
  const courseItems = courses.data?.items || courses.data?.courses || [];
  expect(courseItems.length > 0, '课程列表为空', courses);
  const lessonId = courseItems?.[0]?.currentLessonId || courseItems?.[0]?.lessons?.[0]?.id || courseItems?.[0]?.lesson?.id || courseItems?.[0]?.id;
  expect(Boolean(lessonId), '未获取到课时 ID', courses.data);

  const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lessonId, title: 'P6 外发拦截测试' } });
  expect(project.status === 200, '学生项目创建失败', { project, courses: courses.data });

  const blocked = await api('/api/ai/generations', { method: 'POST', token: student, body: { projectId: project.data.id, prompt: '隔离测试提示词', modality: 'TEXT' } });
  expect(blocked.status === 403 && blocked.data?.error?.code === 'STUDENT_EXTERNAL_AI_BLOCKED', '学生外发未拦截', blocked);

  const policy = await import('../apps/server/src/routes/billingConfig.js');
  assert.throws(
    () => policy.assertAiBudgets({ platformPerCallBudget: 0, platformDailyBudget: 1 }, 1, { dailyUsed: 1 }),
    (error) => error.code === 'AI_PLATFORM_DAILY_BUDGET_EXCEEDED',
  );
  assert.throws(
    () => policy.assertAiBudgets({ platformPerCallBudget: 1, platformDailyBudget: 0 }, 2, { dailyUsed: 0 }),
    (error) => error.code === 'AI_PLATFORM_PER_CALL_BUDGET_EXCEEDED',
  );
  assert.doesNotThrow(() => policy.assertAiBudgets({ platformPerCallBudget: 0, platformDailyBudget: 0 }, 1, { dailyUsed: 999 }));
  assert.throws(
    () => policy.assertOrgAiBudget({ perCallBudget: 0, dailyBudget: 1 }, 1, { dailyUsed: 1 }),
    (error) => error.code === 'AI_ORG_DAILY_BUDGET_EXCEEDED',
  );
  assert.throws(
    () => policy.assertOrgAiBudget({ perCallBudget: 1, dailyBudget: 10 }, 2, { dailyUsed: 0 }),
    (error) => error.code === 'AI_ORG_PER_CALL_BUDGET_EXCEEDED',
  );
  assert.doesNotThrow(() => policy.assertOrgAiBudget({ perCallBudget: 0, dailyBudget: 0 }, 1, { dailyUsed: 999 }));

  // 当前外发保护已在任何生成前置生效；此处验证策略仍为非 mock。
  const providerInfo = await api('/api/ai/providers', { token: student });
  expect(providerInfo.status === 200 && providerInfo.data.mode !== 'mock', '外部策略未生效', providerInfo);

  const jobCount = await run(['-e', `
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(${JSON.stringify(dbPath)});
    const row=db.prepare("select count(*) n from generation_jobs where project_id=?").get(${JSON.stringify(project.data.id)});
    const usage=db.prepare("select count(*) n from usage_records where project_id=?").get(${JSON.stringify(project.data.id)});
    console.log(row.n + ':' + usage.n);
    db.close();
  `]);
  const cleanJobCount = String(jobCount || '').trim();
  expect(cleanJobCount.includes('0:0'), '拦截后不应产生任务或用量', { cleanJobCount, type: typeof cleanJobCount, length: cleanJobCount.length });

  console.log(JSON.stringify({
    name: 'p6-a01-provider-policy-e2e',
    pass: true,
    catalog: before.data.catalog.length,
    provider: external.data.policy.provider,
    blockCode: blocked.data?.error?.code,
    checks: 18,
  }));
} finally {
  server.kill('SIGTERM');
}
