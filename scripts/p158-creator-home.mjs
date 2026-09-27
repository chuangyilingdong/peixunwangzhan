/**
 * P158 学生个人主页（2026-09-27 用户口径）。
 *
 * 用户原话：「学生创建了账号应该就有个主页的专属链接。现在需要把『我的作品』改成主页的概念。
 *          对外公开并且可以分享。头像修改要加上。」
 *
 * 钉住四件事：
 *   ① **建号就有链接**：全仓唯一的建学生入口是机构端 `POST /api/org/users` → `createMember()`，
 *      那里就得生成 `home_token`；存量学生靠 `ensureHomeToken`（见到就补）+ 20 号回填脚本。
 *   ② ⭐ **只列已公开的作品**，且判据与作品广场那两条列表**逐字同一套** —— 个人主页不该把学生的
 *      对外可见面变大。这条是**对着源码逐字比**的（下面 ③），不是"大概看看"。
 *   ③ 名字沿用广场那套脱敏（匿名 →「小创作者」；非匿名 → 首字 + 同学）；**默认匿名**（沿用既有
 *      隐私默认值 `privacy_showcase_anonymous=1`，那是给未成年人设计的，别在这里改默认）。
 *   ④ 头像：8 个预设键（`users.avatar_key` 那一列本来就是这么设计的），**白名单在服务端校验**；
 *      前端只是选择器。公开主页上头像**只读展示**、没有任何写操作。
 *
 * ⭐ 为什么 `home_token` 的唯一索引**故意不带 WHERE**：`12-sqlite-to-mysql-ddl.mjs` 会把带 WHERE 的
 *    部分索引**整个跳过**，于是那一列会被判成 MEDIUMTEXT → 到 MySQL 上建索引直接失败
 *    （`BLOB/TEXT column used in key specification`，§四十四 挖的就是这个形状）。
 *    普通 UNIQUE 索引在两种引擎上都把多个 NULL 当作互不相同 → 与部分索引等价。下面第一条就钉这个。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p158-creator-home-'));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('① 数据层：home_token 的索引必须能被 MySQL 生成器看见');
{
  const schema = read('packages/database/src/schema.js');
  check('users 有 home_token 列（建表处）', /^\s+home_token TEXT,/m.test(schema));
  check('存量库有 ALTER 迁移', /ALTER TABLE users ADD COLUMN home_token TEXT/.test(schema));
  check('⭐ 唯一索引**不带 WHERE**（带 WHERE 会被 12 号生成器跳过 → 列判成 MEDIUMTEXT → MySQL 建不了索引）',
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_home_token ON users\(home_token\)/.test(schema)
    && !/idx_users_home_token[^\n]*WHERE/.test(schema));
  check('建表处留了"为什么不用部分索引"的注释（后来人别顺手改回去）',
    /故意写成普通 UNIQUE 索引，不写/.test(schema) && /MEDIUMTEXT/.test(schema));
}

console.log('② 头像：8 个预设键，一处定义、两边共用');
{
  const schema = read('packages/database/src/schema.js');
  const shared = read('packages/shared/src/avatars.js');
  const fromSchema = (/avatar_key IN \(([^)]*)\)/.exec(schema)?.[1] || '')
    .split(',').map((item) => item.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const avatars = await import('../packages/shared/src/avatars.js');
  const fromShared = [...avatars.AVATAR_KEYS];
  check('⭐ avatars.js 的键与 schema 里 CHECK 白名单**逐字一致**（别只改一处）',
    fromSchema.length === 8 && fromSchema.join(',') === fromShared.join(','), `${fromSchema} vs ${fromShared}`);
  check('每个键都有显示字符（emoji；前端塞进既有的圆形头像位，零图片资源）',
    fromShared.every((key) => Boolean(avatars.avatarGlyph(key))));
  check('未知键 / 空值不给字符（前端据此退回"首字圆形"）',
    avatars.avatarGlyph(null) === null && avatars.avatarGlyph('nope') === null && avatars.avatarGlyph(undefined) === null);
  check('shared 入口导出了它（前端从 @platform/shared 拿）', /export \* from '\.\/avatars\.js'/.test(read('packages/shared/src/index.js')));
}

console.log('③ 主页接口：列**全部**作品（用户口径 2026-09-27 第二次）');
{
  const publicJs = read('apps/server/src/routes/communication/public.js');
  // ⚠️ 2026-09-27 口径变更（**不是测试漂移**）：第一版是"只列已公开、判据与广场逐字一致"；
  //    用户明确改成「主页把全部作品都列出来……就是需要公开。」→ 筛选改成与学生自己那页同一套
  //    （student_id + org_id），**不看可见性/状态**。所以下面这些断言是**反过来**的。
  check('⭐ 主页列**全部**作品：筛选与「我的主页」那屏同一套（student_id + org_id），不看可见性',
    publicJs.includes('WHERE work.student_id=? AND work.org_id=?')
    && publicJs.includes('WHERE submission.student_id=? AND submission.org_id=?')
    && !publicJs.includes('WHERE work.student_id=? AND work.is_public=1'));
  check('⭐ 未公开的作品没有分享码 → 媒体改走 creator 作用域的代理（不再是"没分享码就没封面"）',
    publicJs.includes('const base = mediaBase ||') && publicJs.includes('mediaBase: canvasBase(row.id)'));
  check('creator 作用域的**详情**与**图片代理**都在（准入 = 主页 token + 这件作品属于该学生）',
    publicJs.includes('/^\\/api\\/public\\/creators\\/([\\w-]+)\\/works\\/(CANVAS|VIBECODING)\\/([\\w-]+)$/')
    && publicJs.includes('images\\/([\\w-]+)$/'));
  check('图片代理的准入与公开作品那条**同一套**（fileId 必须真出现在这件作品里 + 是图/音/视频 + 未过期）',
    publicJs.includes('PUBLIC_WORK_IMAGE_NOT_FOUND') && publicJs.includes('FILE_NOT_ACTIVE') && publicJs.includes('FILE_EXPIRED'));
  check('计数走真 COUNT（列表有条数上限，不能拿 items.length 冒充总数）',
    publicJs.includes('SELECT COUNT(*) n FROM works WHERE student_id=? AND org_id=?')
    && publicJs.includes('SELECT COUNT(*) n FROM vibecoding_submissions WHERE student_id=? AND org_id=?'));
  check('只认 STUDENT + 未注销（教师/管理员不该有对外主页）',
    publicJs.includes("role='STUDENT' AND deleted_at IS NULL"));
  check('找不到主页返回 404（不泄漏"这个 token 存不存在"以外的东西）',
    publicJs.includes('PUBLIC_CREATOR_NOT_FOUND'));
  // ⚠️ 2026-09-27 口径变更（**不是测试漂移**）：用户说「名字默认就是机构给他创建的账号名啊，
  //    不需要匿名。也不需要小创作者。」—— 主页那条链路**不再脱敏**（作品广场那条没动）。
  check('⭐ 主页的名字用 display_name 原文（按用户口径放开了，不再脱敏）',
    publicJs.includes('const name = String(creator.display_name'));
  check('只认 STUDENT + 未注销（教师/管理员不该有对外主页）',
    /role='STUDENT' AND deleted_at IS NULL/.test(publicJs));
  check('找不到主页返回 404（不泄漏"这个 token 存不存在"以外的东西）',
    /PUBLIC_CREATOR_NOT_FOUND/.test(publicJs));
  // ⚠️ 2026-09-27 口径变更（**不是测试漂移**）：用户说「名字默认就是机构给他创建的账号名啊，
  //    不需要匿名。也不需要小创作者。」—— 主页那条链路**不再脱敏**（作品广场那条没动，仍按
  //    privacy_showcase_anonymous 显示「小创作者」/「X同学」）。
  check('⭐ 主页的名字用 display_name 原文（按用户口径放开了，不再脱敏）',
    /const name = String\(creator\.display_name/.test(publicJs));
}

console.log('④ 学生侧的设置接口 + 前端页面');
{
  const helpers = read('apps/server/src/routes/admin/helpers.js');
  check('⭐ 建号（createMember）当场生成主页 token —— 全仓唯一的建学生入口',
    /const homeToken = value\.role === 'STUDENT' \? await generateHomeToken\(\) : null/.test(helpers)
    && /home_token\) VALUES/.test(helpers));
  check('教师不生成（只有学生有对外主页）', /value\.role === 'STUDENT' \? await generateHomeToken\(\) : null/.test(helpers));
  const lib = read('apps/server/src/lib.js');
  check('ensureHomeToken 幂等（已有就返回，没有才生成）', /export async function ensureHomeToken/.test(lib));
  check('normalizeUser 带上 homeToken', /homeToken: value\.home_token \|\| null/.test(lib));
  const student = read('apps/server/src/routes/student.js');
  check('学生侧 /home 有 GET 与 PUT', /part === '\/home' && method === 'GET'/.test(student) && /part === '\/home' && method === 'PUT'/.test(student));
  check('⭐ 头像白名单在**服务端**校验（不是只靠前端选择器）', /INVALID_AVATAR_KEY/.test(student) && /isAvatarKey/.test(student));
  check('PUT 只允许改两样，别的字段一律拒绝', /NOTHING_TO_UPDATE/.test(student));
  // ⭐ 2026-09-27 用户口径：「名字默认就是机构给他创建的账号名啊，不需要匿名。也不需要小创作者。」
  check('⭐ 主页不再有"匿名开关"（那条路已按用户口径删掉）',
    !/showcaseAnonymous/.test(student) && !/INVALID_SHOWCASE_ANONYMOUS/.test(student));
  check('⭐ 公开主页直接给 display_name，不再脱敏成「小创作者」/「X同学」',
    !/let name = '小创作者'/.test(read('apps/server/src/routes/communication/public.js')));
  // ⭐ 学生可以自己上传照片当头像（用户口径：「学生可以自行修改照片」）
  check('⭐ 上传的头像要查四条：存在 / 是自己的 / 是图片 / **公开可见性**',
    /AVATAR_ASSET_NOT_FOUND/.test(student) && /AVATAR_ASSET_NOT_OWNED/.test(student)
    && /AVATAR_ASSET_NOT_IMAGE/.test(student) && /AVATAR_ASSET_NOT_PUBLIC/.test(student));
  check('展示地址由服务端拼（avatarUrlOf），别让前端各写一份路由形状',
    /export function avatarUrlOf/.test(read('apps/server/src/lib.js')) && /avatarUrl: avatarUrlOf\(/.test(student));

  const main = read('apps/website/src/main.jsx');
  check('公开路由 /u/:token 用 publicApi（不需要登录）',
    /<Route path='\/u\/:token' element=\{<CreatorHomePage api=\{publicApi\}\/>\}/.test(main));
  check('浏览器标签页标题按 /u/ 前缀回落', /startsWith\('\/u\/'\)/.test(main));
  const home = read('apps/website/src/pages/CreatorHome.jsx');
  check('公开主页的头像是**只读展示**（不是按钮）', /data-testid="home-avatar-readonly"/.test(home));
  check('⭐ 公开主页上没有任何写操作（改头像只在学生自己那页）',
    !/api\.put|student\/home/.test(home) && !/onClick=\{save/.test(home));
  const myWorks = read('apps/website/src/pages/MyWorks.jsx');
  check('「我的作品」有主页入口 + 分享主页', /data-testid="open-home"/.test(myWorks) && /data-testid="share-home"/.test(myWorks));
  check('头像选择器 = 8 个预设 + 一个"用首字"', /data-testid="avatar-none"/.test(myWorks) && /AVATAR_KEYS\.map/.test(myWorks));
  check('⭐ 设置面板里能**上传自己的照片**（用户口径「学生可以自行修改照片」）',
    /data-testid="avatar-upload"/.test(myWorks) && /accept="image\/\*"/.test(myWorks));
  check('⭐ 上传用 PUBLIC_PLATFORM 可见性（用 PRIVATE 的话公开主页上是一张 403 破图）',
    /visibility: 'PUBLIC_PLATFORM'/.test(myWorks));
  check('头像三级优先：照片 > 预设 > 首字', /creator\.avatarUrl \? <img/.test(home) && /avatarPhoto \? <img/.test(myWorks));
  check('设置面板里有主页链接', /data-testid="home-url"/.test(myWorks));
  check('我的作品与公开主页共用同一套封面/类型判定（不许各写一份）',
    /from '\.\.\/components\/workCard\.jsx'/.test(myWorks) && /from '\.\.\/components\/workCard\.jsx'/.test(home));
  const sitemapBlock = /PUBLIC_ROUTES = \[([\s\S]*?)\]/.exec(read('apps/server/src/index.js'));
  check('⭐ /u/ 不进 sitemap（学生个人页不该被搜索引擎收录）',
    Boolean(sitemapBlock) && !/'\/u\//.test(sitemapBlock[1]), String(sitemapBlock?.[1]).slice(0, 120));
}

console.log('⑤ 真请求：建号就有链接 → 主页只列已公开 → 头像与匿名可改');
{
  const baseEnv = {
    ...process.env,
    PLATFORM_DATA_DIR: temp,
    PLATFORM_DB_PATH: path.join(temp, 'platform.db'),
    DEPLOYMENT_MODE: 'local-mock',
  };
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (x) => { err += x; });
    child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
  });
  const port = 19158;
  // ⚠️ 顺序要紧：**先把库建好、种子灌完，再起服务**。
  //    反过来（先 spawn 服务再 init）是个真实的竞态：两个进程同时初始化同一个临时库，
  //    后到的那个插 `platform_modality_settings` 的默认行就会撞 UNIQUE（实测踩到）。
  //    ⚠️ 2026-09-27 记一笔：p156 / p13 用的正是"先起服务、再 init"那个顺序 ——
  //       它俩偶发的「几百毫秒就红、tail 里只有一行 Node.js v24.x」很可能就是这个竞态（未证实，
  //       但形状吻合：失败得快、输出空、没有任何断言信息）。哪天真要收这两条飘，先看这里。
  let server = null;
  let log = '';
  try {
    await run(['packages/database/src/db.js', '--init']);
    await run(['packages/database/src/seed.js']);

    // ── 夹具：一个学生四件作品，只有两件算"已公开" ───────────────────────────────
    const db = new DatabaseSync(path.join(temp, 'platform.db'));
    db.exec('UPDATE organizations SET student_seats = 100');
    const student = db.prepare("SELECT id, org_id FROM users WHERE login='student-1'").get();
    assert.ok(student, '夹具：需要种子里的 student-1');
    const now = new Date().toISOString();
    const canvas = (nodes) => JSON.stringify({ nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
    // ⚠️ `works.project_id` 是**唯一**的（一个项目一件作品），所以每件作品配一个自己的项目。
    const ownWork = (projectId, workId, title, isPublic, status, token, copyright) => {
      db.exec(`INSERT INTO student_projects(id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) VALUES ('${projectId}', '${student.id}', '${student.org_id}', '${title}', 'SUBMITTED', '${canvas([{ id: 'n1', type: 'prompt', position: { x: 60, y: 60 }, data: { title: 'P158 产出', slotType: 'text', generatedText: '正文' } }])}', 1, '${now}', '${now}', '${now}')`);
      db.exec(`INSERT INTO works(id,project_id,student_id,org_id,title,description,canvas_snapshot,status,submitted_at,is_public,share_token,copyright_confirmed_at) VALUES ('${workId}','${projectId}','${student.id}','${student.org_id}','${title}','', '${canvas([])}','${status}','${now}',${isPublic},${token ? `'${token}'` : 'NULL'},${copyright ? `'${now}'` : 'NULL'})`);
    };
    ownWork('p158_proj_public', 'p158_public', 'P158 已公开', 1, 'PUBLISHED', 'p158pub', true);          // 应当出现
    ownWork('p158_proj_private', 'p158_private', 'P158 没公开', 0, 'PUBLISHED', null, true);             // 不该出现
    ownWork('p158_proj_nocopy', 'p158_nocopyright', 'P158 公开但没确认授权', 1, 'PUBLISHED', 'p158nocopy', false); // 不该出现（广场也要求这条）
    db.exec(`INSERT INTO vibecoding_conversations(id,org_id,student_id,title,model,files,entry_file,status,created_at,updated_at) VALUES ('p158_conv','${student.org_id}','${student.id}','P158 会话','local-mock','{"a.html":"<html></html>"}','a.html','DRAFT','${now}','${now}')`);
    db.exec(`INSERT INTO vibecoding_submissions(id,conversation_id,student_id,org_id,title,files,round,status,submitted_at,created_at,updated_at,entry_file,artifacts,is_public,share_token,copyright_confirmed_at) VALUES ('p158_vibe','p158_conv','${student.id}','${student.org_id}','P158 网页作品','{"a.html":"<html></html>"}',1,'PENDING','${now}','${now}','${now}','a.html','[]',1,'p158vibe','${now}')`);
    db.close();

    // 夹具摆好、库定稿之后才起服务（见上面那条顺序说明）。
    server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (x) => { log += x; });
    server.stderr.on('data', (x) => { log += x; });

    for (let i = 0; i < 100; i += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const api = async (pathname, { method = 'GET', token, body } = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      return { status: response.status, data: payload?.data ?? payload };
    };

    // ⭐ 上传工具挪到前面：下面「未公开作品」那几条也要用它（const 不提升，定义在后面会 ReferenceError）
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
    const upload = async (authToken, fields) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      form.append('file', new Blob([png], { type: 'image/png' }), 'avatar.png');
      const response = await fetch(`http://127.0.0.1:${port}/api/student/file-assets/upload`, {
        method: 'POST', headers: { authorization: `Bearer ${authToken}` }, body: form,
      });
      const payload = await response.json().catch(() => ({}));
      return { status: response.status, data: payload?.data ?? payload };
    };

    const admin = await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } });
    assert.equal(admin.status, 200, `机构管理员登录失败：${JSON.stringify(admin.data)}`);
    const created = await api('/api/org/users', { method: 'POST', token: admin.data.token, body: { role: 'STUDENT', login: 'p158-newbie', displayName: '新同学', password: 'study123' } });
    check('机构端能建学生（下面那条"建号就有主页"才测得下去）', created.status === 200, `HTTP ${created.status} ${JSON.stringify(created.data).slice(0, 160)}`);
    const newbie = await api('/api/auth/login', { method: 'POST', body: { login: 'p158-newbie', password: 'study123' } });
    const newbieHome = await api('/api/student/home', { token: newbie.data?.token });
    check('⭐ 新建的学生**当场就有主页 token**（「创建了账号应该就有个主页的专属链接」）',
      /^ust_[0-9a-f]{24}$/.test(String(newbieHome.data?.homeToken || '')), JSON.stringify(newbieHome.data));
    check('主页链接形状是 /u/<token>', newbieHome.data?.homeUrl === `/u/${newbieHome.data?.homeToken}`);
    check('默认没有头像（avatarUrl 与 avatarKey 都是 null，前端退回"首字圆形"）',
      newbieHome.data?.avatarKey === null && newbieHome.data?.avatarUrl === null);

    const login = await api('/api/auth/login', { method: 'POST', body: { login: 'student-1', password: 'study123' } });
    const token = login.data?.token;
    check('学生登录成功（下面几条都靠它）', Boolean(token), JSON.stringify(login.data).slice(0, 160));
    // 另找一位学生：下面要用他的文件验"不能拿别人的图当头像"
    const login2 = await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } });
    const student2Token = login2.data?.token;
    check('第二位学生也登录上了（验"别人的文件"用）', Boolean(student2Token), JSON.stringify(login2.data).slice(0, 120));
    const mine = await api('/api/student/home', { token });
    const homeToken = mine.data?.homeToken;
    check('存量学生也能拿到主页 token（ensureHomeToken 见到就补）', /^ust_/.test(String(homeToken || '')), JSON.stringify(mine.data));

    const creator = await api(`/api/public/creators/${homeToken}`);
    const titles = (creator.data?.items || []).map((item) => item.title);
    check('公开主页能打开（未登录可访问）', creator.status === 200, `HTTP ${creator.status} ${JSON.stringify(creator.data).slice(0, 160)}`);
    // ⚠️ 2026-09-27 口径变更（**不是测试漂移**）：用户要求「主页把全部作品都列出来……就是需要公开。」
    //    → 夹具里那三件（已公开 / 没公开 / 公开但没确认授权）+ VibeCoding 那件**全都要出现**。
    check('⭐ 全部作品都列出来（含没公开的、没确认授权的、VibeCoding 的）',
      ['P158 已公开', 'P158 没公开', 'P158 公开但没确认授权', 'P158 网页作品'].every((title) => titles.includes(title)),
      JSON.stringify(titles));
    check('作品数统计 = 该学生全部作品（走真 COUNT，不是列表长度）',
      Number(creator.data?.workCount) === 4 && Number(creator.data?.shownCount) === 4,
      `workCount=${creator.data?.workCount} shown=${creator.data?.shownCount}`);
    // ⭐ 未公开的那件：卡片要指向 creator 作用域的地址（它没有分享码）
    const privateItem = (creator.data?.items || []).find((item) => item.title === 'P158 没公开');
    check('⭐ 未公开作品的地址走 creator 作用域（没有分享码也打得开）',
      String(privateItem?.publicUrl || '').startsWith(`/u/${homeToken}/w/CANVAS/`), String(privateItem?.publicUrl));
    // ⭐ 点开它：creator 作用域的详情要能取到（未登录）
    const opened = await api(`/api/public/creators/${homeToken}/works/CANVAS/p158_private`);
    check('⭐ 未公开的作品在公开主页上**点得开**（详情接口未登录可读）',
      opened.status === 200 && Array.isArray(opened.data?.canvasSnapshot?.nodes), `HTTP ${opened.status}`);
    const strangerDetail = await api(`/api/public/creators/${await (async () => 'ust_000000000000000000000000')()}/works/CANVAS/p158_private`);
    check('换个不存在的主页 token 取同一件作品 → 404（不是凭作品 id 就能读）',
      strangerDetail.status === 404, `HTTP ${strangerDetail.status}`);
    // ⭐ 未公开作品里的图片：走 creator 作用域的代理，未登录也要取得到（否则主页上是一张破图）
    const privateImageFile = await upload(token, { category: 'GENERAL', visibility: 'PRIVATE' });
    const imageSnapshot = JSON.stringify({
      nodes: [{ id: 'n_img', type: 'image', position: { x: 40, y: 40 }, data: { title: 'P158 图', assetUrl: `/api/student/file-assets/${privateImageFile.data?.id}/download` } }],
      edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    });
    const probe = new DatabaseSync(path.join(temp, 'platform.db'));
    // 参数化写（不拼字符串 —— 省得跟引号打架）
    probe.prepare('UPDATE works SET canvas_snapshot=? WHERE id=?').run(imageSnapshot, 'p158_private');
    probe.close();
    const withImage = await api(`/api/public/creators/${homeToken}`);
    const privateWithImage = (withImage.data?.items || []).find((item) => item.title === 'P158 没公开');
    const mediaUrl = String(privateWithImage?.media?.[0]?.url || '');
    check('⭐ 未公开作品的图片地址走 creator 作用域代理',
      mediaUrl.startsWith(`/api/public/creators/${homeToken}/works/CANVAS/p158_private/images/`), mediaUrl);
    const imageResponse = await fetch(`http://127.0.0.1:${port}${mediaUrl}`);
    check('⭐ 那个图片地址**未登录真能取到**（否则主页上就是破图）', imageResponse.status === 200, `HTTP ${imageResponse.status}`);
    const forged = await fetch(`http://127.0.0.1:${port}/api/public/creators/${homeToken}/works/CANVAS/p158_public/images/file_not_mine`);
    check('代理只放行"真出现在这件作品里"的 fileId（拿别人的 id 换不出来）', forged.status === 404, `HTTP ${forged.status}`);
    // ⭐ 2026-09-27 用户口径：「名字默认就是机构给他创建的账号名啊，不需要匿名。也不需要小创作者。」
    check('⭐ 主页显示的就是机构建号时那个名字（学生-1 的 display_name 是「小明」）',
      creator.data?.name === '小明', String(creator.data?.name));

    const newbieCreator = await api(`/api/public/creators/${newbieHome.data?.homeToken}`);
    check('⭐ 机构刚建的学生，主页上就是机构填的那个名字（「新同学」）',
      newbieCreator.data?.name === '新同学', String(newbieCreator.data?.name));

    const bad = await api('/api/student/home', { method: 'PUT', token, body: { avatarKey: 'dragon' } });
    check('⭐ 预设头像白名单在服务端把关（不在预设里的键被拒）', bad.status === 400, `HTTP ${bad.status}`);
    const empty = await api('/api/student/home', { method: 'PUT', token, body: {} });
    check('什么都不改的请求被拒（不静默成功）', empty.status === 400, `HTTP ${empty.status}`);
    const stale = await api('/api/student/home', { method: 'PUT', token, body: { showcaseAnonymous: false } });
    check('⭐ 匿名开关那条路已经删掉（再传它一律拒，不是静默忽略）', stale.status === 400, `HTTP ${stale.status}`);
    const saved = await api('/api/student/home', { method: 'PUT', token, body: { avatarKey: 'fox' } });
    check('选预设头像存下来了', saved.data?.avatarKey === 'fox', JSON.stringify(saved.data));
    const creator2 = await api(`/api/public/creators/${homeToken}`);
    check('公开主页上预设头像跟着变了', creator2.data?.avatarKey === 'fox', String(creator2.data?.avatarKey));

    // ── 学生自己上传照片当头像（用户口径：「学生可以自行修改照片」）──────────────────
    // 1×1 的真 PNG，走**真上传口**（不手插 file_assets 行）——这样连可见性参数一起验到。
    const privateAsset = await upload(token, { category: 'GENERAL', visibility: 'PRIVATE' });
    check('夹具：以 PRIVATE 上传一张图（下面那条要证明它会被拦）', Boolean(privateAsset.data?.id), JSON.stringify(privateAsset.data).slice(0, 140));
    const privateAsAvatar = await api('/api/student/home', { method: 'PUT', token, body: { avatarAssetId: privateAsset.data?.id } });
    check('⭐ PRIVATE 的图不能当头像（公开主页上会是 403 破图，服务端直接拦）',
      privateAsAvatar.status === 400, `HTTP ${privateAsAvatar.status} ${JSON.stringify(privateAsAvatar.data).slice(0, 120)}`);
    const mineAsset = await upload(token, { category: 'GENERAL', visibility: 'PUBLIC_PLATFORM' });
    const othersAsset = await upload(student2Token, { category: 'GENERAL', visibility: 'PUBLIC_PLATFORM' });
    check('夹具：另外两位各传一张公开图', Boolean(mineAsset.data?.id) && Boolean(othersAsset.data?.id));
    const notImage = await upload(token, { category: 'GENERAL', visibility: 'PUBLIC_PLATFORM' });
    check('夹具：再传一张（下面用它验"不是图片"那条 —— mime 由服务端按内容定，这里只造得出图片，'
      + '所以「非图片」那条走静态断言，见 ④）', Boolean(notImage.data?.id));
    const steal = await api('/api/student/home', { method: 'PUT', token, body: { avatarAssetId: othersAsset.data?.id } });
    check('⭐ 不能拿别人的文件当自己的头像', steal.status === 403, `HTTP ${steal.status}`);
    const noSuch = await api('/api/student/home', { method: 'PUT', token, body: { avatarAssetId: 'file_not_exist' } });
    check('不存在的文件被拒', noSuch.status === 400, `HTTP ${noSuch.status}`);
    const withPhoto = await api('/api/student/home', { method: 'PUT', token, body: { avatarAssetId: mineAsset.data?.id } });
    check('⭐ 上传的照片当头像：存下来了', withPhoto.data?.avatarAssetId === mineAsset.data?.id, JSON.stringify(withPhoto.data).slice(0, 160));
    check('服务端给出了展示地址', withPhoto.data?.avatarUrl === `/api/public/file-assets/${mineAsset.data?.id}/download`, String(withPhoto.data?.avatarUrl));
    // 最要紧的一条：那个地址**未登录真能取到图**（否则公开主页上就是一张破图）
    const photoResponse = await fetch(`http://127.0.0.1:${port}${withPhoto.data?.avatarUrl}`);
    check('⭐ 那个展示地址**未登录真能取到图**（公开主页上不会是破图）', photoResponse.status === 200, `HTTP ${photoResponse.status}`);
    const creator3 = await api(`/api/public/creators/${homeToken}`);
    check('公开主页上带上了照片地址', creator3.data?.avatarUrl === withPhoto.data?.avatarUrl, String(creator3.data?.avatarUrl));
    const removed = await api('/api/student/home', { method: 'PUT', token, body: { avatarAssetId: null } });
    check('能移除照片（退回预设头像）', removed.data?.avatarAssetId === null && removed.data?.avatarUrl === null);

    const missing = await api('/api/public/creators/ust_000000000000000000000000');
    check('不存在的 token → 404（不是 500、也不是空白页）', missing.status === 404, `HTTP ${missing.status}`);
  } catch (error) {
    failures += 1;
    console.error(log.slice(-1500));
    console.error('真请求段异常：', error.message);
  } finally {
    // server 可能还没轮到 spawn 就失败了（比如 init 报错），所以要判空
    server?.kill('SIGKILL');
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 交给系统清理 */ }
  }
}

if (failures) {
  console.error(JSON.stringify({ name: 'p158-creator-home', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p158-creator-home', pass: true }, null, 1));
