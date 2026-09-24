import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import {spawn} from 'node:child_process'; import {randomUUID} from 'node:crypto';
// 成功使用仍记录一笔 usage_records；平台承担成本，学生售价和积分均为零。
// 恢复时失效课堂必须失败收尾，且不得阻断后续合法任务。
import { ensureClassroom } from './lib/classroomFixture.mjs';
const root=path.resolve(process.cwd()); const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ai-kids-queue-')); const dbPath=path.join(temp,'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath; const baseEnv={...process.env,PLATFORM_DATA_DIR:temp,PLATFORM_DB_PATH:dbPath,DEPLOYMENT_MODE:'local-mock',AI_PROVIDER:'local-mock'}; const run=(args,env=baseEnv)=>new Promise((res,rej)=>{const c=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let o='',e='';c.stdout.on('data',x=>o+=x);c.stderr.on('data',x=>e+=x);c.on('close',n=>n?rej(Error(e||o)):res(o))});
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
const invalidProjectId = projectId + '_invalid';
const invalidJobId = jobId + '_invalid';
await aq("INSERT INTO student_projects(id,student_id,org_id,class_id,course_lesson_id,title,status,created_at,updated_at,last_saved_at,class_session_id) VALUES (?,?,?,?,?,?,'DRAFT',?,?,?,?)", [invalidProjectId, user.id, user.org_id, cls.id, lesson, '失效课堂恢复任务', now, now, now, 'missing-session-fixture']);
await aq("INSERT INTO generation_jobs(id,org_id,user_id,project_id,modality,provider,model,prompt,status,created_at) VALUES (?,?,?,?,'IMAGE','local-mock','mock-model','失效课堂恢复测试','QUEUED',?)", [invalidJobId, user.org_id, user.id, invalidProjectId, '2000-01-01T00:00:00.000Z']);
await ensureClassroom(dbPath);
// ── 孤儿任务（2026-09-21 那起"发布重启打断生成"）：别的 worker 认领的 RUNNING，**才开始 10 秒** ──
// 关键在"才 10 秒"：旧写法只回收"租约过期（>5.5 分钟）"的，这种年轻孤儿会被跳过、再也没人管 ——
// 学生看到的是"结果不出来"，而且这个框体因为存在在途任务被判「已经生成过了」，**再也点不动**。
// （必须在 spawn **之前**插进去：回收发生在服务启动那一刻。）
const orphanJobId = 'generation_orphan_' + randomUUID().replaceAll('-','').slice(0,16);
const orphanBoxId = 'material_orphan_box_fixture';
{  
  const orphanAt = new Date(Date.now() - 10000).toISOString();
  await aq("INSERT INTO generation_jobs(id,org_id,user_id,project_id,modality,provider,model,prompt,status,started_at,worker_id,box_id,created_at) VALUES (?,?,?,?,'VIDEO','local-mock','mock-model','孤儿任务','RUNNING',?,?,?,?)", [orphanJobId, user.org_id, user.id, projectId, orphanAt, 'ai-worker-99999-deadbeef', orphanBoxId, orphanAt]);
   }
const port=18841; const server=spawn(process.execPath,['apps/server/src/index.js'],{cwd:root,env:{...baseEnv,PORT:String(port)},stdio:['ignore','pipe','pipe']}); let log='';server.stderr.on('data',x=>log+=x); const sleep=ms=>new Promise(r=>setTimeout(r,ms)); for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break}catch{} await sleep(100)}; await sleep(1000);   const result=await arow('select status,credits_charged,retry_count,worker_id,error_code,error_message from generation_jobs where id=?', [jobId]); const usage=await arow('select count(*) n, coalesce(sum(cost_fen),0) costFen from usage_records where generation_job_id=?', [jobId]); const invalid=await arow('select status,error_code from generation_jobs where id=?', [invalidJobId]); const invalidUsage=await arow('select count(*) n,coalesce(sum(cost_fen),0) cost from usage_records where generation_job_id=?', [invalidJobId]); const healthOk=(await fetch(`http://127.0.0.1:${port}/health`)).ok; console.log(JSON.stringify({name:'ai-generation-queue-recovery',pass:result.status==='SUCCEEDED'&&result.credits_charged===0&&usage.n===1&&usage.costFen===0&&result.worker_id===null&&invalid.status==='FAILED'&&invalid.error_code==='NOT_IN_CLASSROOM'&&invalidUsage.n===1&&healthOk,result,invalid,usage,invalidUsage,healthOk,log}));  server.kill('SIGTERM'); if(!(result.status==='SUCCEEDED'&&result.credits_charged===0&&usage.n===1&&usage.costFen===0&&result.worker_id===null&&invalid.status==='FAILED'&&invalid.error_code==='NOT_IN_CLASSROOM'&&invalidUsage.n===1&&healthOk)) { console.error(log); process.exit(1) }
// ── 附加断言：孤儿 RUNNING 必须在**启动时**被收掉（不然框体永久占用、学生点不动）──────────────
{  
  const orphan = await arow('select status,error_code,worker_id from generation_jobs where id=?', [orphanJobId]);
  const inflight = (await arow("select count(*) n from generation_jobs where project_id=? and box_id=? and status in ('QUEUED','RUNNING')", [projectId, orphanBoxId])).n;
  
  const ok = orphan.status==='FAILED' && orphan.error_code==='GENERATION_INTERRUPTED' && orphan.worker_id===null && inflight===0;
  console.log(JSON.stringify({name:'orphan-running-reclaimed-on-startup',pass:ok,orphan,inflight}));
  if(!ok){ console.error('孤儿任务没被回收（框体会被判成"已经生成过了"）:',JSON.stringify(orphan),'该框体在途=',inflight); process.exit(1); }
}
