/**
 * 生产「真实教学场景」演示数据（2026-09-13，用户要求「真实教学场景补一套演示的」）。
 *
 * 设计目标：让机构端/学生端**一眼就是活的**，并且留出一个自然的演示动线。
 *   ① 两个课包（一个画布、一个 VibeCoding），各含多节课时；
 *   ② 平台授权给机构 → 机构分给两个学员（走真实链路，不动数据库）；
 *   ③ 课堂摆成三种状态：上课中（有名单）/ 待上课（有名单）/ 已结束（有结算结果）；
 *   ④ 一件已提交的学生作品（作品管理不空）。
 *
 * ⚠️ 刻意**不发起任何付费的上游调用**：演示数据不替你花钱。
 *    算力池的消耗、以及「已完课」的结算，留给演示时真做一次生成 ——
 *    那条动线（学生进课堂 → 生成一次 → 老师结束课堂）本来就是要给人看的。
 *    「已结束」那个课堂因此结算成「未完课」（没消耗过算力），这是**如实**的结果。
 *
 * 幂等：按课包标题判断，已存在就跳过，不会重复堆数据。
 * 用法（在服务器上）：PLATFORM_URL=http://127.0.0.1:8789 node demo-teaching-data.mjs
 */
const BASE = process.env.PLATFORM_URL || 'http://127.0.0.1:8789';
const ROOT = { login: 'root', password: process.env.ROOT_PASSWORD || 'liuyuchi123' };
const ORG = { login: 'org-admin', password: process.env.ORG_PASSWORD || 'OrgTest@2026!' };
const STUDENT = { login: 'student-1', password: process.env.STUDENT_PASSWORD || 'StudentTest@2026!' };

let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };
const log = (msg) => console.log(`  · ${msg}`);

async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(BASE + pathname, {
    method,
    headers: { 'content-type': 'application/json', host: 'iicili.cyou', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
const login = async (who) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { login: who.login, password: who.password } });
  if (!r.data?.token) throw new Error(`登录失败 ${who.login}: ${JSON.stringify(r).slice(0, 200)}`);
  return r.data;
};

// ── 演示内容 ────────────────────────────────────────────────────────────────
const CANVAS_SERIES = {
  title: 'AI 创意动画营（演示）',
  description: '6 课时项目式创作：从诗词意境到分镜、画面、动画与成片展示。',
  perStudentBudgetFen: 5000,   // 50 元/学生 —— 让「算力池」在界面上有东西可看
  stockTotal: 20000,
  lessons: [
    { title: '第1课 认识主题与灵感采集', summary: '选定一个想讲的故事主题，收集灵感素材。' },
    { title: '第2课 设计主角与场景', summary: '设计人物或精灵主角，规划故事发生的场景。' },
    { title: '第3课 画面与分镜', summary: '把文字变成画面，排出故事分镜。' },
    { title: '第4课 动画与声音', summary: '给画面安排动作、镜头与声音。' },
    { title: '第5课 完善作品', summary: '打磨细节，讲述你的设计思路。' },
    { title: '第6课 作品展示', summary: '把作品讲给同学听。' },
  ],
};
const VIBE_SERIES = {
  title: 'VibeCoding 小工具营（演示）',
  description: '4 课时：用中文对话写出能跑的小工具，边聊边改。',
  perStudentBudgetFen: 3000,
  stockTotal: 20000,
  lessons: [
    { title: '第1课 让程序说句话', summary: '第一次让电脑按你的话做事。' },
    { title: '第2课 做一个小计算器', summary: '输入数字，算出结果。' },
    { title: '第3课 加一点界面', summary: '给工具加上按钮和输入框。' },
    { title: '第4课 发布你的小工具', summary: '把做好的工具分享出去。' },
  ],
};
const GRANT_QUOTA = 20;

// ── 主流程 ──────────────────────────────────────────────────────────────────
const root = await login(ROOT);
const org = await login(ORG);
check('平台账号与机构账号都能登录', Boolean(root.token && org.token));

const existing = await api('/api/admin/course-series?limit=200', { token: root.token });
const existingTitles = new Set((existing.data?.items || []).map((item) => item.title));

async function ensureSeries(spec, deliveryMode) {
  if (existingTitles.has(spec.title)) { log(`课包「${spec.title}」已存在，跳过`); return null; }
  const created = await api('/api/admin/course-series', {
    method: 'POST', token: root.token,
    body: {
      title: spec.title, description: spec.description, visibility: 'ALL_ORGS',
      stockTotal: spec.stockTotal, perStudentBudgetFen: spec.perStudentBudgetFen,
      lessons: spec.lessons.map((lesson, index) => ({
        title: lesson.title, summary: lesson.summary, status: 'PUBLISHED',
        sort: index + 1, durationMinutes: 45,
        deliveryModes: [deliveryMode], capabilities: ['text', 'image'],
        lessonContent: lesson.summary,
      })),
    },
  });
  if (created.status !== 200) throw new Error(`建课包失败「${spec.title}」: ${JSON.stringify(created.data).slice(0, 300)}`);
  await api(`/api/admin/course-series/${created.data.id}/status`, { method: 'POST', token: root.token, body: { action: 'publish' } });
  await api(`/api/admin/course-series/${created.data.id}/assignments`, {
    method: 'POST', token: root.token,
    body: { orgIds: [org.organization.id], validityDays: 365, quotaTotal: GRANT_QUOTA },
  });
  log(`课包「${spec.title}」已建、已发布、已授权给机构（可授权 ${GRANT_QUOTA} 次）`);
  return created.data;
}

const canvas = await ensureSeries(CANVAS_SERIES, 'CANVAS');
const vibe = await ensureSeries(VIBE_SERIES, 'VIBECODING');

// 学员：机构把课包分给他们（这一步学生才「看得到课」）
const students = (await api('/api/org/users?role=STUDENT', { token: org.token })).data?.items || [];
check('机构下有两个学员可用于演示', students.length >= 2, `实际 ${students.length}`);
const studentIds = students.map((item) => item.id);

for (const series of [canvas, vibe]) {
  if (!series) continue;
  const granted = await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId: series.id, studentIds } });
  check(`课包「${series.title}」已分给 ${studentIds.length} 名学员`, granted.status === 200, JSON.stringify(granted.data).slice(0, 200));
}

// 课堂：三种状态各摆一个（上课中 / 待上课 / 已结束）
async function ensureSession(series, lesson, { status, title }) {
  if (!series) return null;
  const list = await api(`/api/org/sessions?days=365&seriesId=${encodeURIComponent(series.id)}`, { token: org.token });
  const found = (list.data?.items || []).find((item) => item.title === title);
  if (found) { log(`课堂「${title}」已存在，跳过`); return found.id; }
  const created = await api('/api/org/sessions', {
    method: 'POST', token: org.token,
    body: { lessonId: lesson.id, title, deliveryMode: series === vibe ? 'VIBECODING' : 'CANVAS' },
  });
  if (created.status !== 200) throw new Error(`建课堂失败「${title}」: ${JSON.stringify(created.data).slice(0, 200)}`);
  const sessionId = created.data.id;
  const added = await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: org.token, body: { studentIds } });
  log(`课堂「${title}」已建，加入 ${(added.data?.added || []).length} 名学员`);
  if (status === 'ACTIVE' || status === 'ENDED') {
    const started = await api(`/api/org/sessions/${sessionId}/start`, { method: 'POST', token: org.token });
    if (started.status !== 200) throw new Error(`开始上课失败「${title}」: ${JSON.stringify(started.data).slice(0, 200)}`);
  }
  if (status === 'ENDED') {
    const ended = await api(`/api/org/sessions/${sessionId}/end`, { method: 'POST', token: org.token, body: { reason: '演示数据' } });
    // 没消耗过算力 → 会结算成「未完课」，这是如实的
    log(`课堂「${title}」已结束（学员结算：${JSON.stringify(ended.data?.studentSummary || ended.data || {}).slice(0, 80)}）`);
  }
  return sessionId;
}

if (canvas) {
  const lessons = canvas.lessons || [];
  await ensureSession(canvas, lessons[0], { status: 'ENDED', title: '演示 · 第一课（已结束）' });
  await ensureSession(canvas, lessons[1], { status: 'ACTIVE', title: '演示 · 第二课（上课中）' });
  await ensureSession(canvas, lessons[2], { status: 'PENDING', title: '演示 · 第三课（待上课）' });
}
if (vibe) {
  const lessons = vibe.lessons || [];
  await ensureSession(vibe, lessons[0], { status: 'PENDING', title: '演示 · VibeCoding 第一课（待上课）' });
}

// 一件学生作品（走真实提交链路，不花算力）
const demoStudent = students.find((item) => item.login === STUDENT.login) || students[0];
let studentToken = null;
try { studentToken = (await login({ ...STUDENT, login: demoStudent.login })).token; } catch { /* 密码不是文档里的那个就跳过 */ }
if (studentToken && canvas) {
  const lessons = canvas.lessons || [];
  const target = lessons[1];
  const mine = await api('/api/student/projects', { token: studentToken });
  const items = mine.data?.items || mine.data || [];
  const already = (Array.isArray(items) ? items : []).some((item) => String(item.title || '').includes('演示作品'));
  if (already) log('演示作品已存在，跳过');
  else {
    const project = await api('/api/student/projects', {
      method: 'POST', token: studentToken,
      body: {
        courseLessonId: target.id, title: '演示作品 · 我的动画分镜',
        canvasSnapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      },
    });
    if (project.status === 200) {
      const submitted = await api(`/api/student/projects/${project.data.id}/submit`, {
        method: 'POST', token: studentToken, body: { copyrightConfirmed: true, description: '把诗句变成画面的第一次尝试。' },
      });
      check('学生作品已提交（作品管理里能看到）', submitted.status === 200, JSON.stringify(submitted.data).slice(0, 160));
    } else {
      log(`学生项目未建成（可能不在进行中的课堂里）：${project.status} ${JSON.stringify(project.error || {}).slice(0, 120)}`);
    }
  }
} else if (!studentToken) {
  log('学生账号密码不是文档里的那个，跳过「学生作品」这一步（其余数据已建好）');
}

// ── 收尾核对 ────────────────────────────────────────────────────────────────
const overview = await api('/api/org/overview', { token: org.token });
const seriesBox = await api('/api/org/series-overview?days=30', { token: org.token });
const sessions = await api('/api/org/sessions?days=365', { token: org.token });
const byStatus = (sessions.data?.items || []).reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {});
console.log('\n现在生产上的样子：');
console.log('  机构总览：学员', overview.data?.students, '· 作品', overview.data?.works, '· 待上课', overview.data?.pendingSessions, '· 上课中', overview.data?.activeSessions);
console.log('  课包概览：', (seriesBox.data?.items || []).map((item) => `${item.title}（已分配 ${item.quotaUsed}/${item.quotaTotal}）`).join('、') || '(无)');
console.log('  课堂四态：', JSON.stringify(byStatus));

console.log(JSON.stringify({ pass: failures === 0, failures }, null, 2));
process.exit(failures ? 1 : 0);
