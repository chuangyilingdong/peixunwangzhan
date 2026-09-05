import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root=path.resolve(process.cwd()); const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-kids-p4-o14-')); const env={...process.env,PLATFORM_DATA_DIR:dir,PLATFORM_DB_PATH:path.join(dir,'platform.db')};
const run=(args)=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let o='',e='';c.stdout.on('data',x=>o+=x);c.stderr.on('data',x=>e+=x);c.once('close',code=>code?reject(new Error(e||o)):resolve(o));});
await run(['packages/database/src/db.js','--init']); await run(['packages/database/src/seed.js']); const port=18814; const server=spawn(process.execPath,['apps/server/src/index.js'],{cwd:root,env:{...env,PORT:String(port)},stdio:'ignore'}); const base=`http://127.0.0.1:${port}/api`;
async function wait(){for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return}catch{} await new Promise(r=>setTimeout(r,100));}throw Error('server unavailable')}
async function login(login,password){const r=await fetch(`${base}/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login,password})});return {status:r.status,cookie:r.headers.get('set-cookie'),body:await r.json()}}
async function req(cookie,p,method='GET',body){const r=await fetch(base+p,{method,headers:{'content-type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()}}
const checks=[]; const check=(name,ok)=>{checks.push({name,pass:!!ok});if(!ok)throw Error(name)};
try{await wait(); const admin=(await login('org-admin','org123')).cookie; const teacher=(await login('teacher-1','teach123')).cookie;
 let r=await req(admin,'/org/users','POST',{role:'STUDENT',login:'p4-o14-student',displayName:'账号闭环测试学生',password:'oldpass1'}); check('管理员创建学生',r.status===200); const id=r.body.data.id;
 r=await req(teacher,'/org/users','POST',{role:'STUDENT',login:'p4-o14-forbidden',displayName:'越权学生',password:'oldpass1'}); check('教师不能创建账号',r.status===403);
 r=await req(admin,`/org/users/${id}`,'PUT',{status:'DISABLED'}); check('管理员停用账号',r.status===200&&r.body.data.status==='DISABLED');
 const old=await login('p4-o14-student','oldpass1'); check('停用后旧密码不能登录',old.status===401);
 r=await req(admin,`/org/users/${id}/password`,'PUT',{password:'newpass1'}); check('管理员重置密码',r.status===200);
 r=await req(admin,`/org/users/${id}`,'PUT',{status:'ACTIVE'}); check('管理员重新启用账号',r.status===200&&r.body.data.status==='ACTIVE'); const fresh=await login('p4-o14-student','newpass1'); check('重置后新密码可登录',fresh.status===200);
 r=await req(admin,'/org/classes'); const classId=r.body.data.items[0]?.id; r=await req(admin,`/org/users/${id}/classes`,'PUT',{classIds:classId?[classId]:[]}); check('管理员维护成员班级归属',r.status===200);
 r=await req(admin,'/org/users/import/preview','POST',{items:[{login:'p4-o14-import',displayName:'导入测试学生',role:'STUDENT',password:'import1'}]}); check('批量导入预览',r.status===200&&r.body.data?.items?.length===1);
 r=await req(admin,'/org/users/import/commit','POST',{items:[{login:'p4-o14-import',displayName:'导入测试学生',role:'STUDENT',password:'import1'}]}); check('批量导入提交',r.status===200&&r.body.data?.total===1);
 console.log(JSON.stringify({total:checks.length,passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length,checks},null,2));}finally{server.kill()}
