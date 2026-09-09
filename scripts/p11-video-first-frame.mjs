/**
 * P11 图生视频（i2v）首帧守卫测试。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：
 *  1. 课时视频模型是 i2v（模型名带 -i2v）时，未连接图片的生成请求被
 *     GENERATION_FIRST_FRAME_REQUIRED 拦截，且不产生扣费流水
 *  2. 传了不属于本项目的图片地址，同样被拦截
 *  3. 传本项目图片素材地址时通过守卫，任务被入队
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(path.join(tmpdir(), 'p11-video-first-frame-'));
process.env.PLATFORM_DATA_DIR = dir;
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';
process.env.AI_PROVIDER = 'local-mock';

const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
const now = new Date().toISOString();

async function expectError(fn, code, label) {
  try { await fn(); failures.push(`${label}: expected ${code}`); }
  catch (error) { check(error?.code === code, `${label}: got ${error?.code || error?.message}`); }
}

try {
  const { q, row, normalizeUser } = await import('../apps/server/src/lib.js');
  const { handleAiGeneration } = await import('../apps/server/src/routes/aiGeneration.js');

  q("INSERT INTO organizations(id,name,contract_start_at,contract_expires_at,created_at,updated_at) VALUES ('org1','测试机构',?,?,?,?)", [now, now, now, now]);
  q("INSERT INTO users(id,org_id,login,display_name,role,password_hash,status,student_usage_scope,billing_package_id,ai_credit_limit,magic_stones,monthly_credit_allowance,created_at,updated_at) VALUES ('stu1','org1','stu1','学生1','STUDENT','x','ACTIVE','HOME_PRACTICE','pkg1',100,100,100,?,?)", [now, now]);
  q("INSERT INTO course_series(id,title,owner_type,org_id,visibility,version,sort,status,created_at,updated_at) VALUES ('series1','测试课包','PLATFORM',NULL,'ALL_ORGS','1.0',1,'PUBLISHED',?,?)", [now, now]);
  q("INSERT INTO course_lessons(id,series_id,title,sort,status,delivery_mode,classroom_config,canvas_template_snapshot,created_at,updated_at) VALUES ('lesson1','series1','测试课时',1,'PUBLISHED','CANVAS',?,?,?,?)",
    [JSON.stringify({ version: 3 }), '{}', now, now]);
  q("INSERT INTO course_lesson_capabilities(lesson_id,capability,created_at) VALUES ('lesson1','video',?)", [now]);
  // 生成框体是素材表里 type=GENERATION_BOX 的素材（id 直接当 boxId 用）
  q("INSERT INTO course_lesson_material_groups(id,lesson_id,title,sort,created_at,updated_at) VALUES ('mg1','lesson1','生成框体',1,?,?)", [now, now]);
  q("INSERT INTO course_lesson_materials(id,group_id,title,description,material_type,asset_url,snapshot,sort,created_at,updated_at) VALUES ('box-video-1','mg1','素材1','','GENERATION_BOX',NULL,?,1,?,?)", [JSON.stringify({ box: { modality: 'VIDEO', model: 'hailuo-h3-i2v', aspectRatio: '16:9', resolution: '480p', durationSeconds: 5, audio: false }, content: '' }), now, now]);
  q("INSERT INTO classes(id,org_id,name,status,current_session_id,created_at,updated_at) VALUES ('class1','org1','测试班级','ACTIVE',NULL,?,?)", [now, now]);
  q("INSERT INTO class_members(id,class_id,user_id,role,joined_at) VALUES ('m1','class1','stu1','STUDENT',?)", [now]);
  q("INSERT INTO class_curriculum_items(id,class_id,lesson_id,sort,source_series_id,added_at) VALUES ('ci1','class1','lesson1',1,'series1',?)", [now]);
  q("INSERT INTO student_projects(id,student_id,org_id,class_id,course_lesson_id,title,status,last_saved_at,created_at,updated_at) VALUES ('proj1','stu1','org1','class1','lesson1','项目','DRAFT',?,?,?)", [now, now, now]);
  q("INSERT INTO billing_packages(id,org_id,name,allow_video,status,created_at,updated_at) VALUES ('pkg1','org1','套餐',1,'ACTIVE',?,?)", [now, now]);
  q("INSERT INTO generation_jobs(id,org_id,user_id,project_id,modality,provider,model,prompt,status,credits_charged,created_at) VALUES ('job1','org1','stu1','proj1','IMAGE','local-mock','canvas-mock-v1','测试','SUCCEEDED',1,?)", [now]);
  q("INSERT INTO media_assets(id,job_id,org_id,user_id,project_id,modality,label,asset_url,created_at) VALUES ('asset1','job1','org1','stu1','proj1','IMAGE','素材','mock://asset1',?)", [now]);

  const dbUser = row("SELECT * FROM users WHERE id='stu1'");
  const auth = { user: normalizeUser(dbUser, { includeAuthMeta: true }), rawUser: dbUser, org: row("SELECT * FROM organizations WHERE id='org1'") };
  const aiCtx = (body) => ({ pathname: '/api/ai/generations/async', method: 'POST', auth, body, search: new URLSearchParams(), req: { socket: { remoteAddress: '127.0.0.1' } } });

  // 场景 1：i2v 模型缺首帧图，应在入队前被业务拦截
  await expectError(() => handleAiGeneration(aiCtx({ projectId: 'proj1', boxId: 'box-video-1', modality: 'VIDEO', prompt: '夜色江面' })), 'GENERATION_FIRST_FRAME_REQUIRED', 'missing first frame');

  // 场景 2：传外部地址不算首帧（只认本项目图片素材）
  await expectError(() => handleAiGeneration(aiCtx({ projectId: 'proj1', boxId: 'box-video-1', modality: 'VIDEO', prompt: '夜色江面', sourceAssetUrl: 'https://evil.example/x.png' })), 'GENERATION_FIRST_FRAME_REQUIRED', 'foreign first frame');

  // 拦截不产生任何扣费流水
  const spendEntries = row("SELECT COUNT(*) AS n FROM credit_entries WHERE direction='OUT'");
  check(Number(spendEntries?.n || 0) === 0, `拦截路径不应产生支出流水，实际 ${spendEntries?.n || 0} 条`);

  // 场景 3：本项目图片素材可以当首帧，任务正常入队
  const queued = await handleAiGeneration(aiCtx({ projectId: 'proj1', boxId: 'box-video-1', modality: 'VIDEO', prompt: '夜色江面', sourceAssetUrl: 'mock://asset1' }));
  check(queued?.queued === true, '合法首帧应返回 queued=true');
  check(Boolean(queued?.job?.id), '合法首帧应创建任务');
  const persisted = row("SELECT source_asset_url FROM generation_jobs WHERE id=?", [queued?.job?.id || '']);
  check(persisted?.source_asset_url === 'mock://asset1', `首帧来源应落库，实际 ${persisted?.source_asset_url}`);

  // 默认 i2v 模板把首帧放在顶层 image 字段（上游实测接受的键名，尽管其报错文案写的是 firstFrameUrl），且保留 metadata。
  const { requestTemplateFor, renderRequestTemplate } = await import('../apps/server/src/services/modelCapabilities.js');
  const template = requestTemplateFor({ requestTemplates: {} }, 'VIDEO', { requiresFirstFrame: true });
  const body = renderRequestTemplate(template, { model: 'hailuo-h3-i2v', prompt: '夜色江面', durationSeconds: 5, resolution: '768P', aspectRatio: '16:9', audio: false, firstFrameUrl: 'mock://asset1' });
  check(body.image === 'mock://asset1', 'i2v 默认模板应把首帧写进顶层 image');
  check(body.metadata?.aspect_ratio === '16:9', 'i2v 默认模板应保留 metadata 里的比例');
  const t2v = renderRequestTemplate(requestTemplateFor({ requestTemplates: {} }, 'VIDEO'), { model: 'seedance-2.0-global-mini-t2v', prompt: '夜色', durationSeconds: 5, resolution: '480p', aspectRatio: '16:9', audio: false });
  check(!('image' in t2v), '文生视频默认模板不应带上首帧字段');

  // 场景 4：平台模态开关关闭时，生成必须在入队前被拦（机构覆盖优先于平台开关）
  q("UPDATE platform_modality_settings SET enabled=0 WHERE modality='VIDEO'");
  await expectError(() => handleAiGeneration(aiCtx({ projectId: 'proj1', boxId: 'box-video-1', modality: 'VIDEO', prompt: '夜色江面', sourceAssetUrl: 'mock://asset1' })), 'MODALITY_DISABLED', 'platform modality off');
  q("UPDATE platform_modality_settings SET enabled=1 WHERE modality='VIDEO'");
  q("INSERT INTO org_capability_overrides(id,org_id,modality,enabled,reason,created_by,created_at,updated_at) VALUES ('ovr1','org1','VIDEO',0,'测试覆盖','stu1',?,?)", [now, now]);
  await expectError(() => handleAiGeneration(aiCtx({ projectId: 'proj1', boxId: 'box-video-1', modality: 'VIDEO', prompt: '夜色江面', sourceAssetUrl: 'mock://asset1' })), 'MODALITY_DISABLED', 'org override off');

  if (failures.length) throw new Error(failures.join('; '));
  console.log('P11 video first-frame guard passed');
} finally {
  // 临时目录留给 OS 清理；不触碰任何项目/生产数据。
}
