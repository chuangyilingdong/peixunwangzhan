import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
const root=path.resolve(process.cwd()); const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ai-kids-task-loop-')); const env={...process.env,PLATFORM_DATA_DIR:temp,PLATFORM_DB_PATH:path.join(temp,'platform.db'),PORT:'0',DEPLOYMENT_MODE:'local-mock'};
const run=(args)=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let o='',e='';c.stdout.on('data',x=>o+=x);c.stderr.on('data',x=>e+=x);c.on('close',n=>n?reject(new Error(e||o)):resolve(o));});
await run(['packages/database/src/db.js','--init']); await run(['packages/database/src/seed.js']); const port=18812; const server=spawn(process.execPath,['apps/server/src/index.js'],{cwd:root,env:{...env,PORT:String(port)},stdio:['ignore','pipe','pipe']}); let log=''; server.stdout.on('data',x=>log+=x);server.stderr.on('data',x=>log+=x);
const base=`http://127.0.0.1:${port}/api`; const sleep=ms=>new Promise(r=>setTimeout(r,ms)); async function wait(){for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return}catch{} await sleep(100)} throw Error(log)}
async function req(cookie,p,opts={}){const r=await fetch(base+p,{...opts,headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...(opts.headers||{})}});const b=await r.json();return {status:r.status,data:b.data,raw:b}}
async function login(login,password){const r=await req('', '/auth/login',{method:'POST',body:JSON.stringify({login,password})}); if(r.status!==200)throw Error(JSON.stringify(r.raw)); return r.raw && r.raw.data ? r.raw.data : null}
async function auth(login,password){const r=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login,password})});return r.headers.get('set-cookie')}
function ok(x,m){if(!x)throw Error(m)}
try{await wait();const admin=await auth('org-admin','org123'), teacher=await auth('teacher-1','teach123'), student=await auth('student-1','study123');
let c=await req(teacher,'/org/classes'); ok(c.status===200&&c.data.items.length,'no classes'); const cls=c.data.items[0];
let cur=await req(teacher,`/org/classes/${cls.id}/curriculum`); const lesson=cur.data.items?.[0]||cur.data.curriculum?.[0];
let created=await req(teacher,'/org/teaching/tasks',{method:'POST',body:JSON.stringify({classId:cls.id,lessonId:lesson?.lessonId||lesson?.id,title:'集成测试任务',description:'完成说明',dueAt:new Date(Date.now()+86400000).toISOString()})}); ok(created.status===200,`create ${JSON.stringify(created.raw)}`);const task=created.data;
let list=await req(student,'/student/learning/tasks');ok(list.status===200&&list.data.items.some(x=>x.id===task.id),'student cannot see task');
let st=await req(student,`/student/learning/tasks/${task.id}/start`,{method:'POST',body:'{}'});ok(st.status===200,'start failed');
let sub=await req(student,`/student/learning/tasks/${task.id}/submit`,{method:'POST',body:JSON.stringify({note:'我已经完成任务'})});ok(sub.status===200,'submit failed');
let queue=await req(teacher,`/org/teaching/tasks/${task.id}/submissions`);ok(queue.status===200&&queue.data.summary.submitted===1,'teacher queue missing');const sid=queue.data.items.find(x=>x.progressStatus==='SUBMITTED').latestSubmission.id;
// 老师点评（通过/驳回/打分/标记已查看）已按用户要求整套删除：这三个动作必须都不再应答
let viewed=await req(teacher,`/org/teaching/tasks/${task.id}/viewed`,{method:'POST',body:JSON.stringify({submissionIds:[sid]})});ok(viewed.status===404,`标记已查看应当已删除，实际 ${viewed.status}`);
let review=await req(teacher,`/org/teaching/tasks/${task.id}/review`,{method:'POST',body:JSON.stringify({submissionIds:[sid],decision:'APPROVED',score:95,feedback:'完成得很好'})});ok(review.status===404,`点评应当已删除，实际 ${review.status}`);
// 学生端：任务仍是「已提交」，等平台处理；不再有老师给的分数与反馈
let after=await req(student,'/student/learning/tasks');const done=after.data.items.find(x=>x.id===task.id);ok(done.progressStatus==='SUBMITTED','student progress should stay SUBMITTED');
ok(done.latestSubmission && done.latestSubmission.score===undefined,'提交对象不该再有分数');
console.log(JSON.stringify({name:'task-loop',passed:11,taskId:task.id,status:done.progressStatus,reviewRemoved:true}));}finally{server.kill('SIGTERM')}
