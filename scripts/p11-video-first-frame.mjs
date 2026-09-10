/**
 * P11 视频「输入画面」守卫测试：按模型声明的支持方式放行（文生 / 图生-首帧 / 首尾帧，可多选）。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：
 *  1. 模型只支持图生（i2v 类）时，未连接图片的生成请求被 GENERATION_FIRST_FRAME_REQUIRED 拦截，
 *     且不产生扣费流水；传了不属于本项目的图片地址同样被拦
 *  2. 传本项目图片素材地址时通过守卫，任务被入队，首帧来源落库
 *  3. 模型同时支持文生/图生/首尾帧时：不给图能生成、给图能生成、只给尾帧被拦、
 *     首帧+尾帧能生成且尾帧落库
 *  4. 模型只支持文生时，给图会被 GENERATION_FIRST_FRAME_UNSUPPORTED 拦下
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

  // 场景 5：模型声明「文生 + 图生 + 首尾帧」时，给什么用什么，不再二选一强制
  const policy = {
    provider: 'local-mock', model: 'canvas-mock-v1',
    channels: [{
      id: 'ch-video', name: '生视频', provider: 'local-mock', model: 'canvas-mock-v1', models: ['omni-video', 't2v-only', 'reference-only'],
      endpoint: 'https://api.example.com/v1', protocol: 'CHAT', requestTemplates: {}, modelMappings: [],
      modelCapabilities: {
        'omni-video': { inputModes: ['TEXT', 'FIRST_FRAME', 'FIRST_LAST_FRAME', 'OMNI_REFERENCE'] },
        'reference-only': { inputModes: ['OMNI_REFERENCE'] },
        't2v-only': { inputModes: ['TEXT'] },
      },
    }],
    modalityChannels: { VIDEO: 'ch-video' },
  };
  q("UPDATE platform_settings SET ai_provider_policy=? WHERE id=1", [JSON.stringify(policy)]);
  // 每个框体只能成功生成一次，所以给每种输入方式各配一个框体
  for (const [index, boxId] of ['box-omni-text', 'box-omni-first', 'box-omni-last', 'box-omni-frames'].entries()) {
    q("INSERT INTO course_lesson_materials(id,group_id,title,description,material_type,asset_url,snapshot,sort,created_at,updated_at) VALUES (?, 'mg1', ?, '', 'GENERATION_BOX', NULL, ?, ?, ?, ?)", [boxId, `全能模型${index + 1}`, JSON.stringify({ box: { modality: 'VIDEO', model: 'omni-video', aspectRatio: '16:9', resolution: '480p', durationSeconds: 5, audio: false }, content: '' }), index + 2, now, now]);
  }
  q("INSERT INTO course_lesson_materials(id,group_id,title,description,material_type,asset_url,snapshot,sort,created_at,updated_at) VALUES ('box-t2v','mg1','只文生','','GENERATION_BOX',NULL,?,3,?,?)", [JSON.stringify({ box: { modality: 'VIDEO', model: 't2v-only', aspectRatio: '16:9', resolution: '480p', durationSeconds: 5, audio: false }, content: '' }), now, now]);
  q("INSERT INTO media_assets(id,job_id,org_id,user_id,project_id,modality,label,asset_url,created_at) VALUES ('asset2','job1','org1','stu1','proj1','IMAGE','尾帧素材','mock://asset2',?)", [now]);

  const omniCtx = (boxId, extra) => aiCtx({ projectId: 'proj1', boxId, modality: 'VIDEO', prompt: '夜色江面缓缓推移', ...extra });

  // 5.1 全能模型不给图：走文生，不再被强制要首帧
  const omniText = await handleAiGeneration(omniCtx('box-omni-text', {}));
  check(omniText?.queued === true, '支持文生的模型不给图也应能生成');
  check(!row("SELECT source_asset_url FROM generation_jobs WHERE id=?", [omniText?.job?.id || ''])?.source_asset_url, '文生任务不应带首帧来源');

  // 5.2 全能模型给首帧：走图生模板
  const omniFirst = await handleAiGeneration(omniCtx('box-omni-first', { sourceAssetUrl: 'mock://asset1' }));
  check(omniFirst?.queued === true, '全能模型给首帧应能生成');
  check(row("SELECT source_asset_url FROM generation_jobs WHERE id=?", [omniFirst?.job?.id || ''])?.source_asset_url === 'mock://asset1', '图生任务应记下首帧来源');

  // 5.3 只给尾帧：尾帧必须配合首帧
  await expectError(() => handleAiGeneration(omniCtx('box-omni-last', { lastFrameAssetUrl: 'mock://asset2' })), 'GENERATION_LAST_FRAME_WITHOUT_FIRST', 'last frame without first');

  // 5.4 首帧 + 尾帧：任务入队，两份来源都落库
  const omniFrames = await handleAiGeneration(omniCtx('box-omni-frames', { sourceAssetUrl: 'mock://asset1', lastFrameAssetUrl: 'mock://asset2' }));
  check(omniFrames?.queued === true, '首尾帧应能生成');
  const framesJob = row("SELECT source_asset_url,last_frame_asset_url FROM generation_jobs WHERE id=?", [omniFrames?.job?.id || '']);
  check(framesJob?.source_asset_url === 'mock://asset1' && framesJob?.last_frame_asset_url === 'mock://asset2', `首尾帧来源都应落库，实际 ${JSON.stringify(framesJob)}`);

  // 5.5 只支持文生的模型：给图要被拦
  await expectError(() => handleAiGeneration(aiCtx({ projectId: 'proj1', boxId: 'box-t2v', modality: 'VIDEO', prompt: '夜色江面', sourceAssetUrl: 'mock://asset1' })), 'GENERATION_FIRST_FRAME_UNSUPPORTED', 'text-only model with frame');

  // 5.6 首尾帧模板：首帧放 image、尾帧放 last_frame
  const framesTemplate = requestTemplateFor({ requestTemplates: {} }, 'VIDEO', { requiresFirstFrame: true, withLastFrame: true });
  const framesBody2 = renderRequestTemplate(framesTemplate, { model: 'omni-video', prompt: '夜色', durationSeconds: 5, resolution: '480p', aspectRatio: '16:9', audio: false, firstFrameUrl: 'mock://asset1', lastFrameUrl: 'mock://asset2' });
  check(framesBody2.image === 'mock://asset1' && framesBody2.last_frame === 'mock://asset2', `首尾帧模板应同时带两张图，实际 ${JSON.stringify(framesBody2).slice(0, 160)}`);

  // 5.7 只声明「全能参考」的模型：给首帧也算受支持（不该报 FIRST_FRAME_UNSUPPORTED）
  q("INSERT INTO course_lesson_materials(id,group_id,title,description,material_type,asset_url,snapshot,sort,created_at,updated_at) VALUES ('box-ref','mg1','只全能参考','','GENERATION_BOX',NULL,?,4,?,?)", [JSON.stringify({ box: { modality: 'VIDEO', model: 'reference-only', aspectRatio: '16:9', resolution: '480p', durationSeconds: 5, audio: false }, content: '' }), now, now]);
  const refOnly = await handleAiGeneration(aiCtx({ projectId: 'proj1', boxId: 'box-ref', modality: 'VIDEO', prompt: '夜色江面缓缓推移', sourceAssetUrl: 'mock://asset1' }));
  check(refOnly?.queued === true, '只声明全能参考的模型给首帧也应能生成');

  // 5.8 全能参考：多张参考图能生成并落库；与首/尾帧不能混用
  q("INSERT INTO course_lesson_materials(id,group_id,title,description,material_type,asset_url,snapshot,sort,created_at,updated_at) VALUES ('box-omni-ref','mg1','全能参考','','GENERATION_BOX',NULL,?,5,?,?)", [JSON.stringify({ box: { modality: 'VIDEO', model: 'omni-video', aspectRatio: '16:9', resolution: '480p', durationSeconds: 5, audio: false }, content: '' }), now, now]);
  await expectError(() => handleAiGeneration(aiCtx({ projectId: 'proj1', boxId: 'box-omni-ref', modality: 'VIDEO', prompt: '夜色江面缓缓推移', sourceAssetUrl: 'mock://asset1', referenceAssetUrls: ['mock://asset2'] })), 'GENERATION_MIXED_INPUT_MODES', 'frames + references');
  const omniRefs = await handleAiGeneration(aiCtx({ projectId: 'proj1', boxId: 'box-omni-ref', modality: 'VIDEO', prompt: '夜色江面缓缓推移', referenceAssetUrls: ['mock://asset1', 'mock://asset2'] }));
  check(omniRefs?.queued === true, '全能参考给多张参考图应能生成');
  const refsJob = row("SELECT reference_asset_urls FROM generation_jobs WHERE id=?", [omniRefs?.job?.id || '']);
  check(String(refsJob?.reference_asset_urls || '').includes('mock://asset1') && String(refsJob?.reference_asset_urls || '').includes('mock://asset2'), `参考素材应落库，实际 ${refsJob?.reference_asset_urls}`);

  // 5.9 全能参考的请求体：content 里按角色展开参考图
  const refTemplate = { model: '{{model}}', content: [{ type: 'text', text: '{{prompt}}' }, '{{referenceItems}}'], duration: '{{durationSecondsNumber}}' };
  const refBody = renderRequestTemplate(refTemplate, { model: 'MiniMax-H3', prompt: '夜色', durationSeconds: 5, referenceUrls: ['mock://asset1'] });
  check(refBody.content?.[1]?.role === 'reference_image' && refBody.content[1].image_url.url === 'mock://asset1', `全能参考应展开成 reference_image 项，实际 ${JSON.stringify(refBody).slice(0, 160)}`);
  const frameTemplate = { model: '{{model}}', content: [{ type: 'text', text: '{{prompt}}' }, '{{frameItems}}'], duration: '{{durationSecondsNumber}}' };
  const frameBody = renderRequestTemplate(frameTemplate, { model: 'MiniMax-H3', prompt: '夜色', durationSeconds: 5, firstFrameUrl: 'u1' });
  check(frameBody.content?.length === 2 && frameBody.content[1].role === 'first_frame', `只有首帧时应只加首帧项，实际 ${JSON.stringify(frameBody)}`);
  check(typeof frameBody.duration === 'number', 'duration 应是数字（durationSecondsNumber）');

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
