const base = process.env.P3_API_BASE || 'http://localhost:8879/api';
async function call(method, path, body, token) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
function must(name, condition, value) {
  if (!condition) {
    console.error('FAIL', name, JSON.stringify(value, null, 2));
    process.exitCode = 1;
    throw new Error(name);
  }
  console.log('PASS', name);
  return value;
}
function success(name, result) { return must(name, result.status >= 200 && result.status < 300 && result.data?.success, result); }

const teacherLogin = success('teacher login', await call('POST', '/auth/login', { login: 'teacher-1', password: 'teach123' }));
const teacherToken = teacherLogin.data.data.token;
const teacherMe = success('teacher identity', await call('GET', '/me', undefined, teacherToken));
const classes = success('teacher classes', await call('GET', '/org/classes', undefined, teacherToken));
must('seeded class available', classes.data.data.items.length >= 1, classes);
const classId = classes.data.data.items[0].id;
const courses = success('teacher course series', await call('GET', '/org/course-series', undefined, teacherToken));
const lesson = courses.data.data.items[0].lessons[0];
must('seeded lesson available', Boolean(lesson?.lessonId || lesson?.id), courses);
const lessonId = lesson.lessonId || lesson.id;
const started = success('start integration class session', await call('POST', `/org/classes/${classId}/sessions/start`, {
  lessonId,
  sessionCreditCap: 20,
  capabilities: { allowImage: true, allowMusic: true, allowVideo: true },
}, teacherToken));
const sessionId = started.data.data.id;

const studentLogin = success('student login', await call('POST', '/auth/login', { login: 'student-1', password: 'study123' }));
const studentToken = studentLogin.data.data.token;
const dashboard = success('student active dashboard', await call('GET', '/student/dashboard', undefined, studentToken));
must('student can use in active session', dashboard.data.data.canUseNow === true, dashboard);
const providers = success('generation provider info', await call('GET', '/ai/providers', undefined, studentToken));
must('local mock provider configured', providers.data.data.mode === 'mock' && providers.data.data.provider === 'local-mock', providers);

const initialSnapshot = {
  nodes: [
    { id: 'n1', type: 'prompt', position: { x: 0, y: 0 }, data: { title: '提示词', text: '星光森林里的小狐狸' } },
    { id: 'n2', type: 'image', position: { x: 300, y: 0 }, data: { title: '画面', text: '等待素材' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  viewport: { x: 0, y: 0, zoom: 1 },
};
const projectCreated = success('create integration project', await call('POST', '/student/projects', {
  courseLessonId: lessonId,
  title: 'P3 接口联调作品',
  canvasSnapshot: initialSnapshot,
}, studentToken));
const projectId = projectCreated.data.data.id;
const generation = success('generate local mock image', await call('POST', '/ai/generations', {
  projectId,
  modality: 'IMAGE',
  title: '星光森林封面',
  prompt: '夜晚的星光森林里，小狐狸举着发光的种子。',
}, studentToken));
must('generation succeeded', generation.data.data.job.status === 'SUCCEEDED', generation);
must('mock preview returned', generation.data.data.assets.length === 1 && generation.data.data.assets[0].previewUrl.startsWith('data:image/svg+xml'), generation);
const generations = success('list generation jobs', await call('GET', `/ai/generations?projectId=${encodeURIComponent(projectId)}`, undefined, studentToken));
must('generation history contains job', generations.data.data.items.some((item) => item.id === generation.data.data.job.id), generations);

const savedSnapshot = {
  ...initialSnapshot,
  nodes: [...initialSnapshot.nodes, { id: 'n3', type: 'short-video', position: { x: 600, y: 0 }, data: { title: '短片', text: '小狐狸穿过森林' } }],
  edges: [...initialSnapshot.edges, { id: 'e2', source: 'n2', target: 'n3' }],
};
const saved = success('save project snapshot', await call('PUT', `/student/projects/${projectId}`, { canvasSnapshot: savedSnapshot, label: '联调版本' }, studentToken));
must('project version incremented', saved.data.data.latestVersion >= 2, saved);
const submitted = success('submit project', await call('POST', `/student/projects/${projectId}/submit`, { description: 'P3 接口联调提交', canvasSnapshot: savedSnapshot, copyrightConfirmed: true }, studentToken));
const workId = submitted.data.data.work.id;
must('work starts pending', submitted.data.data.work.status === 'PENDING', submitted);

const orgWorks = success('teacher list works with snapshots', await call('GET', '/org/works?includeSnapshot=true', undefined, teacherToken));
const listedWork = orgWorks.data.data.items.find((item) => item.id === workId);
must('submitted work visible to teacher', Boolean(listedWork) && listedWork.canvasSnapshot.nodes.length === 3, orgWorks);
const approved = success('approve submitted work', await call('PUT', `/org/works/${workId}/review`, { status: 'APPROVED', teacherComment: '结构清晰，可以继续完善画面细节。' }, teacherToken));
must('work approved', approved.data.data.status === 'APPROVED', approved);
const reviewed = success('publish approved work to organization showcase', await call('PUT', `/org/works/${workId}/review`, { status: 'PUBLISHED', teacherComment: '审核通过并发布至机构作品墙。' }, teacherToken));
must('work published', reviewed.data.data.status === 'PUBLISHED', reviewed);
const annotation = success('create node annotation', await call('POST', `/org/works/${workId}/annotations`, { nodeId: 'n2', content: '请补充画面主体的动作描述。' }, teacherToken));
must('annotation linked to real node', annotation.data.data.nodeId === 'n2', annotation);
const teacherAnnotations = success('teacher list annotations', await call('GET', `/org/works/${workId}/annotations`, undefined, teacherToken));
must('teacher sees annotation', teacherAnnotations.data.data.items.length === 1, teacherAnnotations);
const resolved = success('resolve annotation', await call('PUT', `/org/works/${workId}/annotations/${annotation.data.data.id}`, { resolved: true }, teacherToken));
must('annotation resolved', Boolean(resolved.data.data.resolvedAt), resolved);

const studentWork = success('student view own work feedback', await call('GET', `/student/works/${workId}`, undefined, studentToken));
must('student sees published work and snapshot', studentWork.data.data.status === 'PUBLISHED' && studentWork.data.data.canvasSnapshot.nodes.length === 3, studentWork);
const studentAnnotations = success('student view annotations', await call('GET', `/student/works/${workId}/annotations`, undefined, studentToken));
must('student sees resolved annotation', studentAnnotations.data.data.items[0].resolvedAt !== null, studentAnnotations);
const showcase = success('student list organization showcase', await call('GET', '/student/showcase', undefined, studentToken));
must('published work appears in showcase', showcase.data.data.items.some((item) => item.id === workId), showcase);
const showcaseDetail = success('student view showcase detail', await call('GET', `/student/showcase/${workId}`, undefined, studentToken));
must('showcase is read-only snapshot', showcaseDetail.data.data.status === 'PUBLISHED' && showcaseDetail.data.data.canvasSnapshot.nodes.length === 3, showcaseDetail);
const usage = success('organization usage reflects generation', await call('GET', '/org/billing/usage-overview?days=1', undefined, teacherToken));
must('generation charged one credit', usage.data.data.modalities.some((item) => item.modality === 'IMAGE' && Number(item.credits) >= 1), usage);

const ended = success('end integration class session', await call('POST', `/org/classes/${classId}/sessions/${sessionId}/end`, { reason: 'P3_INTEGRATION_COMPLETE' }, teacherToken));
must('session ended', ended.data.data.status === 'ENDED', ended);
const finalDashboard = success('student dashboard after session', await call('GET', '/student/dashboard', undefined, studentToken));
must('follow-class student blocked after session', finalDashboard.data.data.canUseNow === false, finalDashboard);
console.log('P3 API INTEGRATION COMPLETE');
