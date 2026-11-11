// 联调测试环境初始化（**只允许 SQLite 测试库**）。
//
// 做三件事：
//   1. 把种子课包的第 1 节课改成 VibeCoding 课（sendLimit=100），保留 seed 自带的 org/学生/许可；
//   2. 把 AI provider policy 指向本机假上游（test-stream-* 模型），只在这个测试库里生效；
//   3. 调 classroomFixture 给测试学生造一节 ACTIVE 的 VibeCoding 课堂。
//
// 运行：
//   set -a; . /etc/ai-kids-platform/test.env; set +a
//   node scripts/test-stream-env-setup.mjs
//
// 注意：它会改测试库里的 policy / 课时 / 课堂，**不要**在 MySQL 生产库上跑。
import { aq, arow } from '../packages/database/src/store.js';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const dbPath = String(process.env.PLATFORM_DB_PATH || '');
if (String(process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql') {
  throw new Error('拒绝在 MySQL 上初始化联调环境（这是测试库专用脚本）');
}
if (!dbPath.includes('test-runtime')) {
  throw new Error(`PLATFORM_DB_PATH 必须指向 test-runtime 测试库，当前：${dbPath || '(空)'}`);
}

const SSE_ENDPOINT = String(process.env.TEST_SSE_ENDPOINT || 'http://127.0.0.1:18999').replace(/\/+$/, '');
const MODELS = ['test-stream-11m', 'test-stream-11m-nodone', 'test-stream-never', 'test-stream-quick'];
const CHANNEL_ID = 'channel-test-sse';

const course = await arow("SELECT id, title FROM course_series WHERE title='AI古诗词创意营' LIMIT 1");
if (!course) throw new Error('测试库里找不到种子课包「AI古诗词创意营」，先跑 seed.js');

const lessons = await arow('SELECT id, title, sort FROM course_lessons WHERE series_id=? ORDER BY sort LIMIT 1', [course.id]);
if (!lessons) throw new Error('种子课包里没有课时');

await aq(
  `UPDATE course_lessons SET delivery_mode='VIBECODING', delivery_modes='["VIBECODING"]',
     classroom_config=?, updated_at=? WHERE id=?`,
  [JSON.stringify({ version: 3, vibeCoding: { sendLimit: 100 } }), new Date().toISOString(), lessons.id],
);

// 学生二号默认 HOME_PRACTICE；联调课堂走 FOLLOW_CLASS，显式改一下（只影响测试库）。
await aq("UPDATE users SET student_usage_scope='FOLLOW_CLASS' WHERE login='student-2'");

const policy = {
  provider: 'custom',
  model: MODELS[0],
  endpoint: SSE_ENDPOINT,
  displayName: '联调测试供应商',
  note: '联调专用假上游，不接真实模型',
  modelMappings: [],
  channels: [{
    id: CHANNEL_ID,
    name: '联调测试通道（假上游）',
    provider: 'custom',
    model: MODELS[0],
    endpoint: SSE_ENDPOINT,
    models: MODELS,
    modelCapabilities: {},
  }],
  modalityChannels: { TEXT: CHANNEL_ID },
  modalityBackupChannels: {},
  imageModeChannels: {},
  imageModeBackupChannels: {},
  modelRoutes: MODELS.map((model) => ({ modality: 'TEXT', model, channelId: CHANNEL_ID })),
  allowStudentExternalContent: true,
};
await aq('UPDATE platform_settings SET ai_provider_policy=?, updated_at=? WHERE id=1', [JSON.stringify(policy), new Date().toISOString()]);
await aq("UPDATE platform_settings SET platform_name='AI 学院联调测试环境' WHERE id=1");

// 造 ACTIVE 课堂 + 把 seed 学生放进名单（幂等）
const created = await ensureClassroom(dbPath);
const session = await arow(
  `SELECT s.id, s.title, s.lesson_id, s.teacher_id, s.status
     FROM class_sessions s
     JOIN session_students p ON p.session_id=s.id AND p.status='ACTIVE'
    WHERE s.status='ACTIVE' AND s.delivery_mode='VIBECODING'
    ORDER BY s.created_at DESC LIMIT 1`,
);

const student = await arow("SELECT id, login, display_name, org_id FROM users WHERE login='student-2'");
const org = await arow('SELECT id, name FROM organizations WHERE id=?', [student.org_id]);
console.log(JSON.stringify({
  ok: true,
  dbPath,
  testUrl: String(process.env.PUBLIC_SITE_URL || ''),
  student: { login: student.login, password: 'study123', id: student.id, displayName: student.display_name },
  organization: { id: org.id, name: org.name },
  course: { id: course.id, title: course.title },
  lesson: { id: lessons.id, title: lessons.title },
  classroom: session,
  channel: { id: CHANNEL_ID, endpoint: SSE_ENDPOINT, models: MODELS },
  createdClassrooms: created,
}, null, 2));
