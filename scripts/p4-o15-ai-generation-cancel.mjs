import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const root=path.resolve(process.cwd()); const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-kids-p4-o15-')); const dbPath=path.join(dir,'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath; const env={...process.env,PLATFORM_DATA_DIR:dir,PLATFORM_DB_PATH:dbPath};
const run=(args)=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',x=>out+=x);c.stderr.on('data',x=>err+=x);c.once('close',code=>code?reject(new Error(err||out)):resolve(out));});
await run(['packages/database/src/db.js','--init']); await run(['packages/database/src/seed.js']);
const { DatabaseSync }=await import('node:sqlite');
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');
   const u=await arow("select * from users where login='student-1'"); const cls=await arow("select * from classes where org_id=? limit 1", [u.org_id]); const lesson=(await arow('select lesson_id from class_curriculum_items where class_id=? limit 1', [cls.id])).lesson_id; const now=new Date().toISOString(); const sid='session_'+randomUUID().replaceAll('-','').slice(0,20); const pid='project_'+randomUUID().replaceAll('-','').slice(0,20); const jid='generation_'+randomUUID().replaceAll('-','').slice(0,20); await aq('insert into class_sessions(id,class_id,lesson_id,status,started_by,started_at) values(?,?,?,?,?,?)', [sid, cls.id, lesson, 'ACTIVE', cls.teacher_id, now]); await aq('update classes set current_session_id=? where id=?', [sid, cls.id]); await aq('insert into student_projects(id,student_id,org_id,class_id,course_lesson_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?)', [pid, u.id, u.org_id, cls.id, lesson, '取消测试', 'DRAFT', '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}', 1, now, now, now]); await aq('insert into generation_jobs(id,org_id,user_id,project_id,modality,provider,model,prompt,status,created_at,next_attempt_at) values(?,?,?,?,?,?,?,?,?,?,?)', [jid, u.org_id, u.id, pid, 'IMAGE', 'local-mock', 'mock-model', '取消测试', 'QUEUED', now, '2099-01-01T00:00:00.000Z']); 
const port=18815; const server=spawn(process.execPath,['apps/server/src/index.js'],{cwd:root,env:{...env,PORT:String(port)},stdio:'ignore'}); const base=`http://127.0.0.1:${port}/api`; async function wait(){for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return}catch{}await new Promise(r=>setTimeout(r,100))}throw Error('server unavailable')}; async function login(){const r=await fetch(`${base}/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'student-1',password:'study123'})});return {status:r.status,cookie:r.headers.get('set-cookie')}}; async function req(cookie,p,method='GET'){const r=await fetch(base+p,{method,headers:{cookie}});return {status:r.status,body:await r.json()}};
try{await wait(); const session=await login(); if(session.status!==200)throw Error('login failed'); const cancelled=await req(session.cookie,`/ai/generations/history/${jid}/cancel`,'POST'); if(cancelled.status!==200||cancelled.body.data?.status!=='FAILED'||cancelled.body.data?.errorCode!=='GENERATION_CANCELLED')throw Error(JSON.stringify(cancelled));   const job=await arow('select status,worker_id,credits_charged,error_code from generation_jobs where id=?', [jid]); const usage=await arow('select count(*) n from usage_records where generation_job_id=?', [jid]);  const result={status:job.status,worker_id:job.worker_id,credits_charged:job.credits_charged,error_code:job.error_code,usage_records:usage.n}; if(result.status!=='FAILED'||result.worker_id!==null||result.credits_charged!==0||result.error_code!=='GENERATION_CANCELLED'||result.usage_records!==0)throw Error(JSON.stringify(result)); console.log(JSON.stringify({name:'ai-generation-cancel',pass:true,result},null,2));}finally{server.kill()}
