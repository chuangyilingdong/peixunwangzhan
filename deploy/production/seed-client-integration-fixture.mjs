#!/usr/bin/env node
/**
 * 客户端（ZCode）**真实联调环境**播种脚本 —— 2026-09-29 客户端契约第二版 待办 6。
 *
 * 客户端要的东西（原话）：「测试账号 + 一节 VibeCoding 课 + 一节画布课 + 一节"两种形式同时声明"的课时；
 * 最好带一个缓存命中应当 >0 的真实样本，我好对 P0-1 的账。」
 *
 * 这个脚本用**平台自己的 HTTP 接口**（不直连库、不写 SQL）建出这套环境，幂等、可重复跑：
 *   ① 一个测试学生账号（默认登录名 `zcode-it`；密码由 `FIXTURE_STUDENT_PASSWORD` 给，没给就随机生成并打印一次）；
 *   ② 一个课包 + **三节课时**，形式分别是 `VIBECODING` / `CANVAS` / 两者同时声明；
 *      VibeCoding 那节顺带配好「发送次数上限 20 + 两条预设提示词」（客户端可以拿它测 429 与预设）；
 *   ③ 三场课堂（一节一个），但**只把学生放进 VibeCoding 那一场**（并开始上课 → ACTIVE）——
 *      ⚠️ 这不是偷懒：产品口径是「**一个学生全局最多属于一个未终态课堂**」（docs/README.md），
 *      写路径会拦（`IN_OTHER_SESSION`），把学生同时塞进三场就是**脏数据**（平台会打警告、并有清理脚本）。
 *      要测另外两节：先在机构端把当前那场结束，再把学生加进对应课堂（界面上两步）。
 *
 * ⚠️ 缓存命中 >0 的真实样本**不在这个脚本里**：它需要真上游（支持 prompt caching 的渠道）连着调两次
 *    同一个长前缀。取样本的配方见文件末尾「缓存样本怎么取」，一条命令即可。
 *
 * 用法（服务器上；也可以在本机对临时实例跑）：
 *   cd /srv/ai-kids-platform/source
 *   export PATH=/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin:$PATH
 *   PLATFORM_URL=http://127.0.0.1:8789 ROOT_PASSWORD=... ORG_PASSWORD=... \
 *     FIXTURE_STUDENT_PASSWORD='<自己定一个>' node deploy/production/seed-client-integration-fixture.mjs
 *
 * 幂等：课包按标题、账号按登录名判断，已存在就复用（账号密码会给**重置**成你给的那个）。
 */
const BASE = String(process.env.PLATFORM_URL || 'http://127.0.0.1:8789').replace(/\/+$/, '');
const ROOT = { login: process.env.ROOT_LOGIN || 'root', password: process.env.ROOT_PASSWORD || 'admin123' };
const ORG = { login: process.env.ORG_LOGIN || 'org-admin', password: process.env.ORG_PASSWORD || 'OrgTest@2026!' };

const SERIES_TITLE = process.env.FIXTURE_SERIES_TITLE || '客户端联调环境（ZCode）';
const STUDENT_LOGIN = String(process.env.FIXTURE_STUDENT_LOGIN || 'zcode-it').trim();
const STUDENT_NAME = process.env.FIXTURE_STUDENT_NAME || '客户端联调学生';
const STUDENT_PASSWORD = String(process.env.FIXTURE_STUDENT_PASSWORD || '').trim()
  || `Zc${Math.random().toString(36).slice(2, 10)}!${Math.floor(Math.random() * 90 + 10)}`;
const SEND_LIMIT = Number(process.env.FIXTURE_SEND_LIMIT || 20);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const log = (msg) => console.log(`  · ${msg}`);

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(BASE + pathname, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null };
}
const login = async (who) => {
  const result = await api('/api/auth/login', { method: 'POST', body: { login: who.login, password: who.password } });
  if (!result.data?.token) throw new Error(`登录失败 ${who.login}：${JSON.stringify(result).slice(0, 200)}`);
  return result.data;
};

// ── 三节课时的形状（形式是这三条的关键差别）────────────────────────────────────
const LESSONS = [
  {
    title: '联调 · VibeCoding 课',
    summary: '客户端主用这一节：有运行时网关密钥、有发送次数上限与预设提示词。',
    deliveryModes: ['VIBECODING'],
    classroomConfig: {
      vibeCoding: {
        sendLimit: SEND_LIMIT,
        presetPrompts: [
          { title: '我要做一个打招呼的网页', text: '帮我做一个网页：打开后显示"你好，我是××"，并有一个按钮能让文字变色。' },
          { title: '帮我看看哪里错了', text: '我刚才那一步没成功，帮我看看现在的代码哪里有问题，改好并告诉我改了什么。' },
        ],
      },
    },
  },
  { title: '联调 · 画布课', summary: '只声明画布：客户端在这一节应当**进不去**（client-context 回 classroom:null + 原因）。', deliveryModes: ['CANVAS'] },
  { title: '联调 · 双形式课', summary: '同时声明画布与 VibeCoding：两种入口都该亮，客户端按运行时能力进。', deliveryModes: ['CANVAS', 'VIBECODING'] },
];

const root = await login(ROOT);
const org = await login(ORG);
check('平台账号与机构账号都能登录', Boolean(root.token && org.token));

// ── ① 测试学生（幂等：已存在就复用 + 重置密码成你给的那个）────────────────────
const students = (await api('/api/org/users?role=STUDENT', { token: org.token })).data?.items || [];
let student = students.find((item) => item.login === STUDENT_LOGIN) || null;
if (student) {
  log(`学生 ${STUDENT_LOGIN} 已存在（${student.displayName}），把密码重置成约定值`);
  const reset = await api(`/api/org/users/${student.id}/password`, { method: 'PUT', token: org.token, body: { password: STUDENT_PASSWORD } });
  check('已存在的联调学生密码已重置', reset.status === 200, JSON.stringify(reset.data || reset.error).slice(0, 160));
} else {
  const created = await api('/api/org/users', {
    method: 'POST', token: org.token,
    body: { role: 'STUDENT', login: STUDENT_LOGIN, displayName: STUDENT_NAME, password: STUDENT_PASSWORD },
  });
  check(`测试学生 ${STUDENT_LOGIN} 已创建`, created.status === 200, JSON.stringify(created.data || created.error).slice(0, 200));
  student = created.data;
}
if (student?.status === 'DISABLED') {
  await api(`/api/org/users/${student.id}`, { method: 'PUT', token: org.token, body: { status: 'ACTIVE' } });
  log('学生原本是停用状态，已启用');
}

// ── ② 课包 + 三节课时（幂等：按标题；**封面/发布/授权缺哪补哪**）────────────────
/**
 * 封面：发布课包的硬前置（`COURSE_COVER_REQUIRED`，见 admin/helpers.js）。
 * 自己上传一张 1×1 PNG（内联字节、不依赖任何外部资源），拿 `file_` 资源 id 当封面。
 * ⚠️ 为什么不直接写 `https://…` 的封面地址：那会依赖外部图床；上传是平台自己的资源，最稳。
 */
async function ensureCover(seriesId) {
  const current = await api(`/api/admin/course-series/${seriesId}`, { token: root.token });
  if (current.data?.coverAssetId || current.data?.coverImageUrl) return null;
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex')], { type: 'image/png' }), 'fixture-cover.png');
  form.append('category', 'PROMO_COVER');
  form.append('visibility', 'PUBLIC_PLATFORM');
  const uploaded = await fetch(`${BASE}/api/admin/file-assets/upload`, { method: 'POST', headers: { authorization: `Bearer ${root.token}` }, body: form });
  const asset = (await uploaded.json().catch(() => ({})))?.data;
  if (!asset?.id) return `上传封面失败：HTTP ${uploaded.status}`;
  const patched = await api(`/api/admin/course-series/${seriesId}`, {
    method: 'PUT', token: root.token,
    body: { coverAssetId: asset.id, coverImageUrl: `/api/public/file-assets/${asset.id}/download` },
  });
  if (patched.status !== 200) return `设封面失败：${JSON.stringify(patched.data || patched.error).slice(0, 200)}`;
  return null;
}

const existing = await api('/api/admin/course-series?limit=200', { token: root.token });
const found = (existing.data?.items || []).find((item) => item.title === SERIES_TITLE);
let series = found || null;
if (series) {
  log(`课包「${SERIES_TITLE}」已存在（${series.id}），复用`);
} else {
  const created = await api('/api/admin/course-series', {
    method: 'POST', token: root.token,
    body: {
      title: SERIES_TITLE,
      description: '给 ZCode 客户端做真实联调用：三种课时形式 + 一节带发送上限与预设。',
      visibility: 'ALL_ORGS',
      stockTotal: 20000,
      perStudentBudgetFen: 5000,
      lessons: LESSONS.map((lesson, index) => ({
        title: lesson.title, summary: lesson.summary, status: 'PUBLISHED', sort: index + 1, durationMinutes: 45,
        deliveryModes: lesson.deliveryModes, capabilities: ['text', 'image'], lessonContent: lesson.summary,
        ...(lesson.classroomConfig ? { classroomConfig: lesson.classroomConfig } : {}),
      })),
    },
  });
  if (created.status !== 200) throw new Error(`建课包失败：${JSON.stringify(created.data || created.error).slice(0, 300)}`);
  series = created.data;
  log(`课包已建：${series.id}`);
}
{
  // 封面 / 发布 / 授权：三样都**按当前状态补**（半成品重跑也能救回来 —— 第一次跑就是在"发布缺封面"
  // 那一步停下的，这条修复路径就是它逼出来的）
  const coverError = await ensureCover(series.id);
  check('课包封面就绪（发布的前置）', !coverError, coverError || '');
  const detail0 = await api(`/api/admin/course-series/${series.id}/detail`, { token: root.token });
  // ⚠️ 形状是 `{ series, assignedOrgs, usage, … }`（不是把 series 摊平）—— 第一版按摊平写，
  //    于是状态读成 undefined → 又去发布一次 → 报 "PUBLISHED 不允许 publish"。
  if (detail0.data?.series?.status !== 'PUBLISHED') {
    const published = await api(`/api/admin/course-series/${series.id}/status`, { method: 'POST', token: root.token, body: { action: 'publish' } });
    check('课包已发布', published.status === 200, JSON.stringify(published.data || published.error).slice(0, 200));
  } else {
    log('课包已是发布状态，跳过发布');
  }
  // ⚠️ 授权这一步平台会**写一条许可购买记录**（`license_purchase_batches`：成交额/币种/收款状态/订单号/
  //    合同号/幂等键，且必须 PAID）。这里是联调环境，所以：**成交额填 0**、订单号与合同号都带 `FIXTURE-`
  //    前缀、幂等键固定 —— 重跑不会重复写；台账上也能一眼认出这是测试单（要清理就删这几条）。
  //    已经授权给本机构时**整步跳过**（不产生任何购买记录）。
  const assignedNow = (detail0.data?.assignedOrgs || []).some((item) => item.orgId === org.organization.id && !item.expired);
  if (assignedNow) {
    log('课包已授权给本机构，跳过（不会写任何许可购买记录）');
  } else {
    const assigned = await api(`/api/admin/course-series/${series.id}/assignments`, {
      method: 'POST', token: root.token,
      body: {
        orgIds: [org.organization.id], quotaTotal: 20,
        amountMinor: 0, currency: 'CNY', paymentStatus: 'PAID',
        orderNo: `FIXTURE-ZCODE-IT-${series.id}`, contractNo: 'FIXTURE-ZCODE-IT',
        idempotencyKey: `fixture-zcode-it-${series.id}`,
      },
    });
    check('课包已授权给本机构（留一条 0 元 FIXTURE 测试购买记录）', assigned.status === 200, JSON.stringify(assigned.data || assigned.error).slice(0, 200));
  }
}
const detail = await api(`/api/admin/course-series/${series.id}/detail`, { token: root.token });
const lessons = detail.data?.series?.lessons || series.lessons || [];
check('课包里有三节课时（VibeCoding / 画布 / 双声明）', lessons.length >= 3, `实际 ${lessons.length}`);

// ── ③ 机构把课包分给这个学生（学生才「看得到课」）─────────────────────────────
const granted = await api('/api/org/course-grants', {
  method: 'POST', token: org.token, body: { seriesId: series.id, studentIds: [student.id] },
});
check('课包已分给联调学生', granted.status === 200, JSON.stringify(granted.data || granted.error).slice(0, 200));

// ── ④ 三场课堂：一节一个；**只把学生放进 VibeCoding 那场**并开始上课 ──────────
const sessions = (await api(`/api/org/sessions?days=365&seriesId=${encodeURIComponent(series.id)}`, { token: org.token })).data?.items || [];
async function ensureSession(lesson, { addStudent, start }) {
  const title = `联调课堂 · ${String(lesson.title).replace(/^联调\s*·\s*/, '')}`.slice(0, 60);
  const existingSession = sessions.find((item) => item.title === title);
  if (existingSession) { log(`课堂「${title}」已存在（${existingSession.status}）`); return existingSession; }
  const mode = lesson.deliveryModes?.includes('VIBECODING') ? 'VIBECODING' : 'CANVAS';
  const created = await api('/api/org/sessions', { method: 'POST', token: org.token, body: { lessonId: lesson.id, title, deliveryMode: mode } });
  if (created.status !== 200) { check(`课堂「${title}」建成`, false, JSON.stringify(created.data || created.error).slice(0, 200)); return null; }
  const sessionId = created.data.id;
  if (addStudent) {
    const added = await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: org.token, body: { studentIds: [student.id] } });
    const blocked = (added.data?.skipped || [])[0]?.reason;
    check(`联调学生已加入「${title}」${blocked ? `（被拦：${blocked}）` : ''}`, !blocked, JSON.stringify(added.data).slice(0, 200));
  }
  if (start) {
    const started = await api(`/api/org/sessions/${sessionId}/start`, { method: 'POST', token: org.token });
    check(`「${title}」已开始上课（ACTIVE）`, started.status === 200, JSON.stringify(started.data || started.error).slice(0, 200));
  } else {
    log(`课堂「${title}」留作待上课（要测这一节：先结束当前那场，再把学生加进它）`);
  }
  return { id: sessionId, title, status: start ? 'ACTIVE' : 'PENDING' };
}

const vibeLesson = lessons.find((lesson) => (lesson.deliveryModes || [lesson.deliveryMode]).length === 1 && (lesson.deliveryModes || [lesson.deliveryMode])[0] === 'VIBECODING');
const canvasLesson = lessons.find((lesson) => (lesson.deliveryModes || [lesson.deliveryMode]).length === 1 && (lesson.deliveryModes || [lesson.deliveryMode])[0] === 'CANVAS');
const dualLesson = lessons.find((lesson) => (lesson.deliveryModes || []).length === 2);
const vibeSession = vibeLesson ? await ensureSession(vibeLesson, { addStudent: true, start: true }) : null;
if (canvasLesson) await ensureSession(canvasLesson, { addStudent: false, start: false });
if (dualLesson) await ensureSession(dualLesson, { addStudent: false, start: false });

// ── ⑤ 学生登进去核一遍：client-context 真的给了课堂 + 密钥 ────────────────────
const studentLogin = await login({ login: STUDENT_LOGIN, password: STUDENT_PASSWORD });
const context = (await api('/api/student/runtime/client-context', { token: studentLogin.token })).data || {};
check('学生登录后 client-context 给出了 VibeCoding 课堂', Boolean(context.classroom?.id), JSON.stringify(context).slice(0, 240));
check('client-context 给出了网关基址与运行时密钥', Boolean(context.gateway?.baseUrl && context.gateway?.key), JSON.stringify(context.gateway || {}).slice(0, 200));
check('sends 是配好的（limit=20）', Number(context.sends?.limit) === SEND_LIMIT, JSON.stringify(context.sends || {}));
check('presets 有两条（客户端可以点它插草稿）', (context.presets || []).length === 2, JSON.stringify(context.presets || []).slice(0, 200));

console.log('\n──────── 交给客户端的东西（照抄这一段）────────');
console.log(`  平台地址        ${BASE}`);
console.log(`  学生登录名      ${STUDENT_LOGIN}`);
console.log(`  学生密码        ${STUDENT_PASSWORD}`);
console.log(`  课包 id         ${series.id}（${SERIES_TITLE}）`);
for (const lesson of lessons) {
  const modes = (lesson.deliveryModes || [lesson.deliveryMode] || []).join('+');
  console.log(`  课时 ${modes.padEnd(18)} ${lesson.id}  ${lesson.title}`);
}
if (vibeSession) console.log(`  上课中的课堂    ${vibeSession.id}（${vibeSession.title}）—— client-context 会返回它 + 网关密钥`);
console.log('  另外两节怎么测  先在机构端结束当前那场 → 再把学生加进对应课堂（一个学生同时只能有一场未终态课堂，这是口径）');
console.log('');
console.log('缓存样本怎么取（P0-1 对账用，需要真上游）：');
console.log('  1) 用上面这个学生登录客户端进课堂，让模型跑一个**较长的**任务（同一段长前缀会重复发出去）；');
console.log('  2) 同一节课里**再发一次**（前缀相同）——第二次上游应命中缓存；');
console.log('  3) 平台每条用量行的 usage 里就有 prompt_cache_hit_tokens / prompt_cache_miss_tokens 与');
console.log('     prompt_tokens_details.cached_tokens（网关每轮还打一行 time_to_first_token_ms=…）；');
console.log('  4) 也可用 `node deploy/production/probe-cache-hit-sample.mjs` 自动连打两次并打印这几项。');

console.log('');
console.log(failures ? `✗ 有 ${failures} 项不符合预期（上面的 ✗）` : '✓ 联调环境就绪（幂等，可重复跑）');
process.exitCode = failures ? 1 : 0;
