import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import {spawn} from 'node:child_process'; import {randomUUID} from 'node:crypto';
import { ensureClassroom } from './lib/classroomFixture.mjs';
const root=path.resolve(process.cwd()); const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ai-kids-queue-')); const dbPath=path.join(temp,'platform.db');
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
process.env.PLATFORM_DB_PATH = dbPath; const baseEnv={...process.env,PLATFORM_DATA_DIR:temp,PLATFORM_DB_PATH:dbPath,DEPLOYMENT_MODE:'local-mock',AI_PROVIDER:'unavailable'}; const run=(args,env=baseEnv)=>new Promise((res,rej)=>{const c=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let o='',e='';c.stdout.on('data',x=>o+=x);c.stderr.on('data',x=>e+=x);c.on('close',n=>n?rej(Error(e||o)):res(o))});
await run(['packages/database/src/db.js','--init']); await run(['packages/database/src/seed.js']);
const {DatabaseSync}=await import('node:sqlite');
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');
   const user=await arow("select * from users where login='student-2'"); const cls=await arow("select * from classes where org_id=? limit 1", [user.org_id]); const lesson=(await arow("select lesson_id from class_curriculum_items where class_id=? limit 1", [cls.id])).lesson_id; await aq('delete from course_lesson_capabilities where lesson_id=?', [lesson]); for (const cap of ['text','image']) await aq('insert into course_lesson_capabilities(lesson_id,capability,created_at) values(?,?,?)', [lesson, cap, new Date().toISOString()]); const now=new Date().toISOString(); const sessionId='session_'+randomUUID().replaceAll('-','').slice(0,20); const projectId='project_'+randomUUID().replaceAll('-','').slice(0,20); const jobId='generation_'+randomUUID().replaceAll('-','').slice(0,20); await aq("insert into class_sessions(id,class_id,lesson_id,status,started_by,started_at) values(?,?,?,?,?,?)", [sessionId, cls.id, lesson, 'ACTIVE', cls.teacher_id, now]); await aq("update classes set current_session_id=? where id=?", [sessionId, cls.id]); await aq("insert into student_projects(id,student_id,org_id,class_id,course_lesson_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?)", [projectId, user.id, user.org_id, cls.id, lesson, '队列恢复测试', 'DRAFT', '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}', 1, now, now, now]); await aq("insert into generation_jobs(id,org_id,user_id,project_id,modality,provider,model,prompt,status,created_at) values(?,?,?,?,?,?,?,?,?,?)", [jobId, user.org_id, user.id, projectId, 'IMAGE', 'local-mock', 'mock-model', '恢复测试', 'QUEUED', now]); 
// 批次 B：门禁要求「许可 + 课堂名单」。这条守卫验的是**画布**链路的异步生成，所以课堂入口类型
// 保持 CANVAS（种子课时本来就是只画布的）。⚠️ 必须在 spawn 之前建好 —— worker 在服务启动时
// 立刻认领这个 QUEUED 任务，晚了就会在 drain 里抛 NOT_IN_CLASSROOM 把服务打挂。
 
const seriesId = (await arow('SELECT series_id FROM course_lessons WHERE id=?', [lesson])).series_id;
await aq("UPDATE class_sessions SET org_id=?,series_id=?,teacher_id=?,delivery_mode='CANVAS' WHERE id=?", [user.org_id, seriesId, cls.teacher_id, sessionId]);
await aq('UPDATE student_projects SET class_session_id=? WHERE id=?', [sessionId, projectId]);

await ensureClassroom(dbPath);
const port=18842; const server=spawn(process.execPath,['apps/server/src/index.js'],{cwd:root,env:{...baseEnv,PORT:String(port)},stdio:['ignore','pipe','pipe']}); let log='';server.stderr.on('data',x=>log+=x); const sleep=ms=>new Promise(r=>setTimeout(r,ms)); for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break}catch{} await sleep(100)}; await sleep(16000);   const result=await arow('select status,credits_charged,retry_count,worker_id,error_code,error_message from generation_jobs where id=?', [jobId]); const usage=await arow('select count(*) n from usage_records where generation_job_id=?', [jobId]); console.log(JSON.stringify({name:'ai-generation-queue-failure-retry',pass:result.status==='FAILED'&&result.credits_charged===0&&usage.n===1&&result.retry_count===0&&result.error_code==='GENERATION_PROVIDER_CONFIG_INVALID'&&result.worker_id===null,result,usage,log}));  server.kill('SIGTERM'); if(!(result.status==='FAILED'&&result.credits_charged===0&&usage.n===1&&result.retry_count===0&&result.error_code==='GENERATION_PROVIDER_CONFIG_INVALID'&&result.worker_id===null)) {console.error(log);process.exit(1)}
