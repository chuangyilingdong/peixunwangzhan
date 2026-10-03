import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p77-org-'));
process.env.PLATFORM_DATA_DIR = dir;
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';
const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
const { handleOrg } = await import('../apps/server/src/routes/orgAdmin.js');
const { q, row, aq, arow } = await import('../apps/server/src/lib.js');
const now = new Date().toISOString();
const ctx = (pathname, method='GET', body=null, orgId=null, role=orgId ? 'ORG_ADMIN' : 'SUPER_ADMIN') => ({ pathname, method, body, search:new URLSearchParams(), req:{socket:{remoteAddress:'127.0.0.1'}}, auth:{user:{id:'root',login:'root',role,orgId,permissions:[]},rawUser:{permissions:'[]'}} });
const admin = (p,m,b) => handleAdmin(ctx('/api/admin'+p,m,b));
const org = (id,p,m,b,role) => handleOrg(ctx('/api/org'+p,m,b,id,role));
const rejects = async (fn, code) => assert.rejects(fn, e => e.code === code, code);
await rejects(() => admin('/organizations','POST',{name:'missing'}), 'VALIDATION_ERROR');
const a = await admin('/organizations','POST',{name:'A',adminLogin:'a',adminPassword:'secret123',studentSeats:2});
const b = await admin('/organizations','POST',{name:'B',adminLogin:'b',adminPassword:'secret123'});
await rejects(() => admin('/organizations','POST',{name:'C',adminLogin:'c'}), 'ORG_ADMIN_INPUT_REQUIRED');
const students=[];
for(let i=0;i<2;i++) students.push(await org(a.id,'/users','POST',{role:'STUDENT',login:'s'+i,displayName:'Student '+i,password:'secret123'}));
await rejects(() => org(a.id,'/users','POST',{role:'STUDENT',login:'overflow',displayName:'Overflow',password:'secret123'}), 'STUDENT_SEAT_LIMIT');
await rejects(() => admin('/organizations/'+a.id,'PUT',{studentSeats:1}), 'STUDENT_SEAT_LIMIT');
await rejects(() => org(a.id,'/users','GET',null,'TEACHER'), 'ORG_ADMIN_REQUIRED');
await rejects(() => org(a.id,'/course-grants','GET',null,'TEACHER'), 'ORG_ADMIN_REQUIRED');
await aq("INSERT INTO course_series(id,title,status,owner_type,visibility,stock_total,created_at,updated_at) VALUES ('p77','Inventory','PUBLISHED','PLATFORM','PUBLIC',3,?,?)",[now,now]);
const purchase=(key, quantity, paymentStatus='PAID')=>({amountMinor:quantity*10000,currency:'CNY',paymentStatus,orderNo:'P77-O-'+key,contractNo:'P77-C-1',idempotencyKey:'p77-'+key});
const assign=(body)=>admin('/course-series/p77/assignments','POST',body);
await rejects(()=>assign({orgIds:[a.id,b.id],quotaTotal:2,...purchase('multi',2)}), 'INVALID_ORG_IDS');
assert.equal((await arow("SELECT COUNT(*) n FROM course_assignments WHERE series_id='p77'")).n,0);
await assign({orgIds:[a.id],quotaTotal:2,...purchase('initial',2)});
await assign({orgIds:[a.id],validityDays:730});
assert.equal((await arow("SELECT quota_total FROM course_assignments WHERE series_id='p77'")).quota_total,2);
const grants = await Promise.all([org(a.id,'/course-grants','POST',{seriesId:'p77',studentIds:[students[0].id]}),org(a.id,'/course-grants','POST',{seriesId:'p77',studentIds:[students[0].id]})]);
assert.equal(grants.reduce((n,g)=>n+g.granted,0),1);
await org(a.id,'/course-grants','POST',{seriesId:'p77',studentIds:[students[1].id]});
await rejects(()=>assign({orgIds:[a.id],quotaTotal:1}), 'COURSE_QUOTA_BELOW_USED');
await rejects(()=>admin('/course-series/p77/stock','PUT',{stockTotal:1}), 'COURSE_STOCK_BELOW_RESERVED');
await aq("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_at,quota_total,quota_used) VALUES ('zero','p77',?,'ACTIVE',?,0,0)",[b.id,now]);
await aq("UPDATE users SET org_id=? WHERE id=?",[b.id,students[0].id]);
await rejects(()=>org(b.id,'/course-grants','POST',{seriesId:'p77',studentIds:[students[0].id]}), 'COURSE_QUOTA_EXHAUSTED');
console.log('P77 passed: explicit credentials, organization capacity, teacher denial, atomic batch stock, renewal preservation, idempotency, used/stock floors, zero balance denial');

/* ─── 平台端「机构」页的三条 UI 口径（2026-10-03 用户口径，静态钉住）────────────────────────
   用户原话：
   ① 「既然创建机构这里图1是必填项，就不应该是展开形式」——那七格（签约信息/人数上限/管理员账号）
      原来是 `<details>` 折叠区，默认收着；必填项藏在折叠里 = 用户点开才知道要填。
   ② 「机构管理员登录名和初始密码应该挨在一起」——原来中间夹着「机构管理员姓名」。
   ③ 「创建完机构，在图2位置多个按钮，授权课包。跳转到图3页面」——列表行加「授权课包」直达
      `/organizations/<id>/quota`（机构课包与授权次数，原来要先点进详情再找入口）。 */
{
  const page = fs.readFileSync(new URL('../apps/admin/src/pages/Organizations.jsx', import.meta.url), 'utf8');
  const problems = [];
  // ⚠️ 别用"<details> 后面 400 字内出现标题"这种负向断言 —— 文件里的**注释**正好写着这段历史，
  //    会把注释当违规（本文件第一次跑就是这么红的，与 p173 那条同款坑）。只看真实标记。
  if (/<summary>\s*签约信息/.test(page)) problems.push('创建机构的必填段又回到 <details> 折叠里了（用户口径：必填项不该是展开形式）');
  if (!/<p className="org-field-label">签约信息、人数上限与机构管理员账号/.test(page)) problems.push('必填段的常驻标题不见了（应当是一句话 + 三列网格，不再折叠）');
  const REQUIRED = ['contractStartAt', 'contractExpiresAt', 'teacherSeats', 'studentSeats', 'adminLogin', 'adminPassword', 'adminDisplayName'];
  for (const key of REQUIRED) if (!new RegExp(`value=\{form\.${key}\}`).test(page)) problems.push(`创建机构弹窗缺了必填字段 ${key}`);
  // ② 相邻：登录名那一格之后**紧跟**密码那一格（姓名不许插在中间）
  const loginAt = page.indexOf('value={form.adminLogin}');
  const passwordAt = page.indexOf('value={form.adminPassword}');
  const displayAt = page.indexOf('value={form.adminDisplayName}');
  if (!(loginAt >= 0 && passwordAt >= 0 && displayAt >= 0)) problems.push('找不到管理员三格（登录名/密码/姓名）');
  else if (!(loginAt < passwordAt && passwordAt < displayAt)) problems.push('「机构管理员登录名」与「管理员初始密码」没有挨在一起（2026-10-03 用户口径：这两格要相邻）');
  // ③ 列表行的「授权课包」按钮直达本机构的课包与授权次数页
  if (!/授权课包/.test(page)) problems.push('机构列表行没有「授权课包」按钮（用户 2026-10-03 口径）');
  if (!/organizations\/\$\{encodeURIComponent\(item\.id\)\}\/quota/.test(page)) problems.push('「授权课包」按钮没有跳到 /organizations/<id>/quota（机构课包与授权次数）');
  // ⭐ 2026-10-03 用户口径：「图1的菜单栏名字改成：创建机构与授权」——
  //    按本文件的老口径（2026-09-18「一个页面一个名字」），菜单 / 页面标题一起改。
  const nav = fs.readFileSync(new URL('../apps/admin/src/shared.jsx', import.meta.url), 'utf8');
  if (!/\{ to: '\/organizations'[^}]*label: '创建机构与授权'/.test(nav)) problems.push('侧边菜单里 /organizations 这项应当叫「创建机构与授权」（2026-10-03 用户口径）');
  if (!/<PageHeader[^>]*title="创建机构与授权"/.test(page)) problems.push('机构列表页的标题应当与菜单同名（老口径：一个页面一个名字）');
  assert.equal(problems.length, 0, problems.join('；'));
  console.log('P77 UI 口径通过：必填段常驻、登录名与密码相邻、列表行「授权课包」直达课包与授权次数页');
}
