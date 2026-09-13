/**
 * P9-R04 AI 课时能力 / 生成框体结算拦截测试。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：
 *  1. 课时只开放 image 能力时，TEXT 生成被 LESSON_CAPABILITY_DISABLED 拦截（且不扣费）
 *  2. 生图框体素材已生成过 1 张时，再次用同一个框体生成被 GENERATION_BOX_USED 拦截
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(path.join(tmpdir(), 'p9-r04-ai-lesson-guards-'));
process.env.PLATFORM_DATA_DIR = dir;
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');
process.env.DEPLOYMENT_MODE = 'public';

const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
const now = new Date().toISOString();

async function expectError(fn, code, label) {
  try { await fn(); failures.push(`${label}: expected ${code}`); }
  catch (error) { check(error?.code === code, `${label}: got ${error?.code || error?.message}`); }
}

try {
  const { q, row, normalizeUser } = await import('../apps/server/src/lib.js');
  const { handleAi } = await import('../apps/server/src/routes/ai.js');

  q("INSERT INTO organizations(id,name,contract_start_at,contract_expires_at,created_at,updated_at) VALUES ('org1','测试机构',?,?,?,?)", [now, now, now, now]);
  q("INSERT INTO users(id,org_id,login,display_name,role,password_hash,status,student_usage_scope,billing_package_id,ai_credit_limit,magic_stones,monthly_credit_allowance,created_at,updated_at) VALUES ('stu1','org1','stu1','学生1','STUDENT','x','ACTIVE','HOME_PRACTICE','pkg1',100,100,100,?,?)", [now, now]);
  q("INSERT INTO course_series(id,title,owner_type,org_id,visibility,version,sort,status,created_at,updated_at) VALUES ('series1','测试课包','PLATFORM',NULL,'ALL_ORGS','1.0',1,'PUBLISHED',?,?)", [now, now]);
  // 平台课包「发布」不等于「授权给机构」：机构要看到/使用必须先有一条生效授权（见交接说明第四节）。
  q("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_by,assigned_at,expires_at) VALUES ('assign1','series1','org1','ACTIVE',NULL,?,NULL)", [now]);
  // 2026-09-13 起这条链还有下一环：**机构把课包分给学员**（学生进课要求有效学员许可，叠加口径）。
  // 少了它，学生就被 COURSE_GRANT_REQUIRED 拦住 —— 这正是「机构必须有可用次数才能把课包给学生」的落点。
  q("INSERT INTO student_course_grants(id,org_id,student_id,series_id,source_assignment_id,granted_at) VALUES ('grant1','org1','stu1','series1','assign1',?)", [now]);
  q("INSERT INTO course_lessons(id,series_id,title,sort,status,delivery_mode,classroom_config,canvas_template_snapshot,created_at,updated_at) VALUES ('lesson1','series1','测试课时',1,'PUBLISHED','CANVAS',?,?,?,?)", [JSON.stringify({ version: 3 }), '{}', now, now]);
  q("INSERT INTO course_lesson_capabilities(lesson_id,capability,created_at) VALUES ('lesson1','image',?)", [now]);
  // 生成框体就是素材表里 type=GENERATION_BOX 的素材（id 直接当 boxId 用）
  q("INSERT INTO course_lesson_material_groups(id,lesson_id,title,sort,created_at,updated_at) VALUES ('mg1','lesson1','生成框体',1,?,?)", [now, now]);
  q("INSERT INTO course_lesson_materials(id,group_id,title,description,material_type,asset_url,snapshot,sort,created_at,updated_at) VALUES ('box-image-1','mg1','素材1','','GENERATION_BOX',NULL,?,1,?,?)", [JSON.stringify({ box: { modality: 'IMAGE', model: '', aspectRatio: '16:9', resolution: '1k' }, content: '' }), now, now]);
  q("INSERT INTO classes(id,org_id,name,status,current_session_id,created_at,updated_at) VALUES ('class1','org1','测试班级','ACTIVE',NULL,?,?)", [now, now]);
  q("INSERT INTO class_members(id,class_id,user_id,role,joined_at) VALUES ('m1','class1','stu1','STUDENT',?)", [now]);
  q("INSERT INTO class_curriculum_items(id,class_id,lesson_id,sort,source_series_id,added_at) VALUES ('ci1','class1','lesson1',1,'series1',?)", [now]);
  q("INSERT INTO student_projects(id,student_id,org_id,class_id,course_lesson_id,title,status,last_saved_at,created_at,updated_at) VALUES ('proj1','stu1','org1','class1','lesson1','项目','DRAFT',?,?,?)", [now, now, now]);
  q("INSERT INTO billing_packages(id,org_id,name,allow_image,status,created_at,updated_at) VALUES ('pkg1','org1','套餐',1,'ACTIVE',?,?)", [now, now]);
  q("INSERT INTO generation_jobs(id,org_id,user_id,project_id,modality,provider,model,prompt,status,credits_charged,created_at,box_id) VALUES ('job1','org1','stu1','proj1','IMAGE','local-mock','canvas-mock-v1','测试','SUCCEEDED',1,?,'box-image-1')", [now]);
  q("INSERT INTO media_assets(id,job_id,org_id,user_id,project_id,modality,label,asset_url,created_at) VALUES ('asset1','job1','org1','stu1','proj1','IMAGE','素材','mock://asset',?)", [now]);

  const dbUser = row("SELECT * FROM users WHERE id='stu1'");
  const auth = { user: normalizeUser(dbUser, { includeAuthMeta: true }), rawUser: dbUser, org: row("SELECT * FROM organizations WHERE id='org1'") };
  const aiCtx = (body) => ({ pathname: '/api/ai/usage', method: 'POST', auth, body, search: new URLSearchParams(), req: { socket: { remoteAddress: '127.0.0.1' } } });

  // 场景 1：课时只开放 image，TEXT 生成应被课时能力拦截
  await expectError(() => handleAi(aiCtx({ projectId: 'proj1', modality: 'TEXT', credits: 1 })), 'LESSON_CAPABILITY_DISABLED', 'lesson capability guard');

  // 场景 2：同一个生图框体已生成过 1 张，再次生成应被框体占用拦截
  await expectError(() => handleAi(aiCtx({ projectId: 'proj1', boxId: 'box-image-1', modality: 'IMAGE', credits: 1 })), 'GENERATION_BOX_USED', 'generation box used');
  // 没带框体 id 时同样拦截：本课配了框体就必须从框体发起
  await expectError(() => handleAi(aiCtx({ projectId: 'proj1', modality: 'IMAGE', credits: 1 })), 'GENERATION_BOX_REQUIRED', 'generation box required');

  // 拦截不产生任何扣费流水（能力/框体拦截均发生在 chargeCreditsInTransaction 之前）
  const spendEntries = row("SELECT COUNT(*) AS n FROM credit_entries WHERE direction='OUT'");
  check(Number(spendEntries?.n || 0) === 0, `拦截路径不应产生支出流水，实际 ${spendEntries?.n || 0} 条`);

  if (failures.length) throw new Error(failures.join('; '));
  console.log('P9-R04 AI lesson capability + generation-slot guards passed');
} finally {
  // 临时目录留给 OS 清理；不触碰任何项目/生产数据。
}