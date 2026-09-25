/**
 * P97 运行时网关（学生端 VibeCoding 改用 dsh 之后，模型调用从这里走）。
 *
 * 为什么必须钉住这条链路：dsh 容器里只有一把我们签发的运行时密钥，密钥里带着
 * 机构 / 学生 / 课时 / 课堂；每次调用都要**重新过门禁**（课堂仍在进行 + 学生仍在名单里），
 * 并且每次调用都要落进我们的算力账（usage_records）。这三条任意一条漏了，后果分别是
 * 「别人用我们的算力」、「课堂结束后还在烧钱」、「成本从账本里消失」。
 *
 * 用例：
 *   ① 没有密钥 → 401；伪造/篡改的密钥 → 401；过期密钥 → 401
 *   ② 密钥有效但课堂已结束 → 403（不用等容器回收）
 *   ③ 密钥有效但学生被移出名单 → 403
 *   ④ 正常调用 → 200，返回 OpenAI 形状的回复，且**落了 usage_records**
 *   ⑤ 调用方改不动归属：即使请求里塞别的机构/学生字段，账也记在密钥里的那个学生/课堂上
 *   ⑥ 模型名映射：容器报的名字只当「意向」，认不出就用渠道自己的 model（绝不原样发上游）
 *   ⑦ 读图：**默认跟着模型走**（同一条 TEXT 渠道）；另配了读图渠道才改走那条，两侧都要记账
 *   ⑧ 多模态内容不被压扁：图片原样透传，容器内路径（file://）不发出去
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { issueRuntimeKey, normalizeRuntimeMessages, resolveRuntimeSelection } from '../apps/server/src/routes/runtimeGateway.js';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p97-runtime-gateway-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH ||= dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

const SECRET = 'p97-runtime-secret';
// 签发密钥这一步跑在本进程里，所以本进程也要有同一把密钥（baseEnv 只传给被拉起的服务）
process.env.RUNTIME_GATEWAY_SECRET = SECRET;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp, PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock', RUNTIME_GATEWAY_SECRET: SECRET,
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(code)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

 
const teacher = await arow("SELECT * FROM users WHERE login='teacher-1'");
const student = await arow("SELECT * FROM users WHERE login='student-1'");
const lesson = await arow("SELECT * FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1");
const now = new Date().toISOString();
await aq('INSERT OR IGNORE INTO student_course_grants(id,org_id,student_id,series_id,granted_at) VALUES (?,?,?,?,?)', ['p97_grant', student.org_id, student.id, lesson.series_id, now]);
const sessionId = 'csession_p97';
await aq(`INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode,created_at,updated_at,started_at)
  VALUES (?,?,?,?,?,?,'ACTIVE','VIBECODING',?,?,?)`, [sessionId, 'P97 运行时网关', student.org_id, lesson.series_id, lesson.id, teacher.id, now, now, now]);
await aq(`INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at)
  VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)`, ['p97_part', sessionId, student.id, student.org_id, lesson.id, lesson.series_id, teacher.id, now, now]);


const port = 19397;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', (x) => { logs += x; });
server.stderr.on('data', (x) => { logs += x; });

const call = async (token, body) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/gateway/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null; try { payload = JSON.parse(text); } catch { payload = null; }
  return { status: response.status, payload, text };
};
const messages = [{ role: 'user', content: '用一句话做个自我介绍' }];

try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert.ok(ready, logs);

  const key = issueRuntimeKey({ orgId: student.org_id, userId: student.id, sessionId, lessonId: lesson.id });

  const noKey = await call('', { messages });
  check('① 没有密钥 → 401', noKey.status === 401, `实际 ${noKey.status} ${noKey.text.slice(0, 120)}`);
  const tampered = await call(key.replace(/.$/, key.endsWith('A') ? 'B' : 'A'), { messages });
  check('① 篡改过的密钥 → 401', tampered.status === 401, `实际 ${tampered.status}`);
  const expired = issueRuntimeKey({ orgId: student.org_id, userId: student.id, sessionId, lessonId: lesson.id, ttlMs: -1000 });
  const expiredCall = await call(expired, { messages });
  check('① 过期密钥 → 401', expiredCall.status === 401, `实际 ${expiredCall.status} ${expiredCall.text.slice(0, 120)}`);

  const ok = await call(key, { messages });
  check('④ 正常调用 → 200，OpenAI 形状回复', ok.status === 200 && typeof ok.payload?.choices?.[0]?.message?.content === 'string', `实际 ${ok.status} ${ok.text.slice(0, 200)}`);
  check('④ 回复带 model 与 usage 字段', Boolean(ok.payload?.model) && typeof ok.payload?.usage?.total_tokens === 'number', JSON.stringify(ok.payload?.usage));

  {
     
    const usage = await arows("SELECT * FROM usage_records WHERE class_session_id=? AND user_id=? AND modality='TEXT'", [sessionId, student.id]);
    check('④ 这次调用落了 usage_records（成本进我们的账）', usage.length >= 1, JSON.stringify(usage.slice(0, 1)));
    await aq("UPDATE session_students SET status='ACTIVE' WHERE id='p97_part'");
    
  }

  {
    // ⑤ 归属只看密钥：请求里塞别的机构/学生也不影响记账对象
    const spoof = await call(key, { messages, orgId: 'org_hacker', userId: 'user_hacker', studentId: 'user_hacker' });
    check('⑤ 请求里塞别的归属不影响结果', spoof.status === 200, `实际 ${spoof.status}`);
     
    const rows = await arows("SELECT DISTINCT user_id,org_id FROM usage_records WHERE class_session_id=?", [sessionId]);
    check('⑤ 账只记在密钥里的学生与机构上', rows.every((r) => r.user_id === student.id && r.org_id === student.org_id), JSON.stringify(rows));
    
  }

  {
     
    await aq("UPDATE class_sessions SET status='ENDED', ended_at=? WHERE id=?", [now, sessionId]);
    
    const ended = await call(key, { messages });
    check('② 课堂已结束 → 403（不用等容器回收）', ended.status === 403, `实际 ${ended.status} ${ended.text.slice(0, 120)}`);
  }

  {
     
    await aq("UPDATE class_sessions SET status='ACTIVE' WHERE id=?", [sessionId]);
    await aq("UPDATE session_students SET status='REMOVED', removed_reason='P97' WHERE id='p97_part'");
    
    const removed = await call(key, { messages });
    check('③ 学生被移出名单 → 403', removed.status === 403, `实际 ${removed.status} ${removed.text.slice(0, 120)}`);
  }

  // ⑥ 模型名映射：容器报的名字只当「意向」，解析不到就绝不原样发上游
  {
    const policy = {
      provider: 'local-mock', model: '', endpoint: '', channels: [
        { id: 'ch-text', provider: 'local-mock', model: 'local-mock-text', models: ['local-mock-text', 'local-mock-pro'], endpoint: '' },
        { id: 'ch-vision', provider: 'local-mock', model: 'local-mock-vision', models: ['local-mock-vision'], endpoint: '' },
      ],
      modalityChannels: { TEXT: 'ch-text' }, modalityBackupChannels: {}, modelRoutes: [], visionChannelId: '',
    };
    const unknown = resolveRuntimeSelection(policy, 'deepseek-pro', false);
    check('⑥ 认不出的名字 → 用渠道自己的 model（不原样发上游）', unknown.channelId === 'ch-text' && unknown.model === 'local-mock-text', JSON.stringify({ channelId: unknown.channelId, model: unknown.model }));
    const known = resolveRuntimeSelection(policy, 'platform-gateway/local-mock-pro', false);
    check('⑥ 认得出的名字（带 provider/ 前缀）→ 就用它', known.model === 'local-mock-pro', known.model);
    const routed = resolveRuntimeSelection({ ...policy, modelRoutes: [{ modality: 'TEXT', model: 'deepseek-flash', channelId: 'ch-vision' }] }, 'deepseek-flash', false);
    check('⑥ 管理员配了模型路由 → 按路由走那条渠道', routed.channelId === 'ch-vision' && routed.model === 'deepseek-flash', JSON.stringify({ channelId: routed.channelId, model: routed.model }));
    const vision = resolveRuntimeSelection({ ...policy, visionChannelId: 'ch-vision' }, 'deepseek-pro', true);
    check('⑥ 配了读图渠道 → 带图的请求走那条渠道，且不带备份渠道', vision.channelId === 'ch-vision' && vision.model === 'local-mock-vision' && !vision.backup, JSON.stringify({ channelId: vision.channelId, model: vision.model, backup: Boolean(vision.backup) }));
    const followModel = resolveRuntimeSelection(policy, 'deepseek-pro', true);
    check('⑥ 没配读图渠道 → 带图的请求**跟着模型走**（同一条 TEXT 渠道）',
      followModel.channelId === 'ch-text' && followModel.model === 'local-mock-text',
      JSON.stringify({ channelId: followModel.channelId, model: followModel.model }));
  }

  // ⑧ 多模态内容不被压扁：以前这一层只做 String(content)，图片在这里就没了
  {
    const parts = normalizeRuntimeMessages({ messages: [{ role: 'user', content: [
      { type: 'text', text: '这张图里是什么？' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'file:///home/student/workspace/a.png' } },
      { type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } },
    ] }] })[0].content;
    check('⑧ 图片原样透传（data:image 保留）', Array.isArray(parts) && parts.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png')), JSON.stringify(parts));
    check('⑧ 容器内路径（file://）不发上游', Array.isArray(parts) && !parts.some((p) => String(p.image_url?.url || '').startsWith('file://')), JSON.stringify(parts));
    check('⑧ 认不出的模态（video_url）丢掉，不塞给上游', Array.isArray(parts) && !parts.some((p) => p.type === 'video_url'), JSON.stringify(parts));
    const textOnly = normalizeRuntimeMessages({ messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] });
    check('⑧ 纯文本仍然压回字符串（老形状不变）', textOnly[0].content === '你好', JSON.stringify(textOnly[0].content));
  }

  // ⑦ 读图：默认跟着模型走；另配了读图渠道才改走那条。两侧都要记账。
  {
    const base = {
      provider: 'local-mock', model: '', endpoint: '', channels: [
        { id: 'ch-text', provider: 'local-mock', model: 'local-mock-text', models: ['local-mock-text'], endpoint: '' },
        { id: 'ch-vision', provider: 'local-mock', model: 'local-mock-vision', models: ['local-mock-vision'], endpoint: '' },
      ],
      modalityChannels: { TEXT: 'ch-text' }, modalityBackupChannels: {}, modelRoutes: [], visionChannelId: '',
      allowStudentExternalContent: true,
    };
     
    // ③ 把学生移出名单后没有放回去，这里先恢复：否则下面几通调用会被 RUNTIME_STUDENT_NOT_ACTIVE 挡掉
    await aq("UPDATE session_students SET status='ACTIVE', removed_reason=NULL WHERE id='p97_part'");
    await aq('UPDATE platform_settings SET ai_provider_policy=? WHERE id=1', [JSON.stringify(base)]);
    
    const imageMessages = [{ role: 'user', content: [{ type: 'text', text: '这张图里是什么' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];

    const followModel = await call(key, { messages: imageMessages, model: 'deepseek-flash' });
    check('⑦ 没配读图渠道 → 200，图跟着模型走（落在 TEXT 渠道的模型上）',
      followModel.status === 200 && followModel.payload?.model === 'local-mock-text',
      `实际 ${followModel.status} ${followModel.text.slice(0, 160)}`);
    {
       
      const row = await arow('SELECT model,pricing_snapshot FROM usage_records WHERE class_session_id=? ORDER BY created_at DESC, id DESC LIMIT 1', [sessionId]);
      check('⑦ 这一通读图照样进我们的账（记在 TEXT 渠道的模型上）', row?.model === 'local-mock-text', String(row?.model));
      check('⑦ 记账里留了「带图」与「报的名字 → 实际渠道/模型」', /"withImages":true/.test(String(row?.pricing_snapshot || '')) && /modelResolution/.test(String(row?.pricing_snapshot || '')), String(row?.pricing_snapshot).slice(0, 260));
      
    }

     
    await aq('UPDATE platform_settings SET ai_provider_policy=? WHERE id=1', [JSON.stringify({ ...base, visionChannelId: 'ch-vision' })]);
    

    const visionCall = await call(key, { messages: imageMessages, stream: true });
    check('⑦ 配了读图渠道 → 200，改走那条渠道', visionCall.status === 200, `实际 ${visionCall.status} ${visionCall.text.slice(0, 160)}`);
    {
       
      const row = await arow('SELECT model FROM usage_records WHERE class_session_id=? ORDER BY created_at DESC, id DESC LIMIT 1', [sessionId]);
      check('⑦ 这一通读图记在**读图渠道的模型**上', row?.model === 'local-mock-vision', String(row?.model));
      
    }

    const textCall = await call(key, { messages, model: 'deepseek-pro' });
    check('⑥ 未知模型名走 HTTP → 200，且回复里的 model 是渠道自己的 model', textCall.status === 200 && textCall.payload?.model === 'local-mock-text', `实际 ${textCall.status} ${textCall.text.slice(0, 160)}`);
  }

  // ⑨ 历史图片按字节封顶（2026-09-17）：agent 会不停读自己的截图，dsh 每轮把整段历史重发 ——
  //    图片按字节很大、按 token 很小（实测那一轮 8 张截图只算 25k tokens，但请求体过了 2MB），
  //    没有这个安全阀，修完 2MB 的墙，下一堵墙只是更远一点。
  {
    const big = (n) => `data:image/png;base64,${'A'.repeat(n)}`;
    const withImage = (label) => ({ role: 'user', content: [{ type: 'text', text: label }, { type: 'image_url', image_url: { url: big(3_000_000) } }] });
    const many = normalizeRuntimeMessages({ messages: [withImage('第1张'), withImage('第2张'), withImage('第3张'), withImage('第4张'), withImage('第5张'), withImage('第6张')] });
    const chars = many.reduce((total, m) => total + (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').reduce((s, p) => s + p.image_url.url.length, 0) : 0), 0);
    check('⑨ 图片总量被压到预算以内（6×3M 字符 > 12M 预算）', chars <= 12_000_000, `实际 ${chars}`);
    check('⑨ 消息条数不变（省略图片不能让 tool 配对散掉）', many.length === 6, String(many.length));
    check('⑨ 从**最新**往回留：最后一条的图还在', many.at(-1).content.some((p) => p.type === 'image_url'));
    check('⑨ 更早的图换成了「需要时请重新读文件」的说明（不是静默丢掉）',
      !many[0].content.some((p) => p.type === 'image_url') && many[0].content.some((p) => p.type === 'text' && /已省略/.test(p.text)),
      JSON.stringify(many[0].content));
    const small = normalizeRuntimeMessages({ messages: [{ role: 'user', content: [{ type: 'text', text: '看一下' }, { type: 'image_url', image_url: { url: big(2000) } }] }] });
    check('⑨ 常规会话（一张小图）完全不受影响 —— 这是安全阀，不是常态',
      small[0].content.every((p) => !(p.type === 'text' && /已省略/.test(p.text))), JSON.stringify(small[0].content));
  }

  // ⑩ 请求体上限：网关那条必须**远大于**普通 JSON 接口（实测踩到的那一堵墙）
  {
    const bigBody = { messages: [{ role: 'user', content: [{ type: 'text', text: '这是这张图' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(3_000_000)}` } }] }] };
    const large = await call(key, bigBody);
    check('⑩ 超过 2MB 的网关请求被接受（agent 带几张截图就会超过它）', large.status === 200, `实际 ${large.status} ${large.text.slice(0, 160)}`);
    const other = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'x', password: 'y', pad: 'A'.repeat(3_000_000) }),
    });
    const otherText = await other.text();
    check('⑩ 普通接口仍然守 2MB（不是把全局都放开了）', other.status === 400 && /PAYLOAD_TOO_LARGE/.test(otherText), `${other.status} ${otherText.slice(0, 140)}`);
  }

  console.log(JSON.stringify({ name: 'runtime-gateway', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(logs.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
  await sleep(200);
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
