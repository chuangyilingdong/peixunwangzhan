const base='http://localhost:8787/api';
let cookies={};
async function call(method,path,body,token){
  const res=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  const text=await res.text(); let data; try{data=JSON.parse(text)}catch{data=text}
  return {status:res.status,data};
}
function must(name,cond,value){ if(!cond){ console.error('FAIL',name,JSON.stringify(value,null,2)); process.exitCode=1; throw new Error(name)} console.log('PASS',name); return value; }
const root=await call('POST','/auth/login',{login:'root',password:'admin123'});
const rootToken=must('root login',root.data?.success,root).data.data.token;
const meRoot=await call('GET','/me',null,rootToken); must('root me',meRoot.data?.success,meRoot);
const org=await call('POST','/auth/login',{login:'teacher-1',password:'teach123'});
const teacherToken=must('teacher login',org.data?.success,org).data.data.token;
const teacherMe=await call('GET','/me',null,teacherToken);
must('teacher orgId',teacherMe.data?.data?.orgId,teacherMe);
const classes=await call('GET','/org/classes',null,teacherToken);
must('teacher classes',classes.data?.data?.items?.length===1,classes);
const classId=classes.data.data.items[0].id;
const lessons=await call('GET','/org/course-series',null,teacherToken);
must('teacher courses',lessons.data?.success,lessons);
const lessonId=lessons.data.data.items?.[0]?.lessons?.[0]?.lessonId || lessons.data.data.items?.[0]?.lessons?.[0]?.id;
const start=await call('POST','/org/classes/'+classId+'/sessions/start',{lessonId},teacherToken);
must('session start',start.data?.success,start);
const sessionId=start.data.data.id;
const stu=await call('POST','/auth/login',{login:'student-1',password:'study123'});
const stuToken=must('student login',stu.data?.success,stu).data.data.token;
const dash=await call('GET','/student/dashboard',null,stuToken); must('student dashboard active',dash.data?.data?.canUseNow===true,dash);
const proj=await call('POST','/student/projects',{courseLessonId:lessonId,title:'冒烟作品',canvasSnapshot:{nodes:[{id:'n1',type:'ai',text:'你好'}],edges:[]}},stuToken);
must('project create',proj.data?.success,proj);
const projectId=proj.data.data.id;
const usage=await call('POST','/ai/usage',{modality:'TEXT',credits:2,projectId},stuToken); must('ai usage',usage.data?.success,usage);
const save=await call('PUT','/student/projects/'+projectId,{canvasSnapshot:{nodes:[{id:'n1',type:'ai',text:'更新'}],edges:[]},title:'冒烟作品2'},stuToken); must('project save',save.data?.success,save);
const submit=await call('POST','/student/projects/'+projectId+'/submit',{description:'P0 smoke'},stuToken); must('project submit',submit.data?.success,submit);
const end=await call('POST','/org/classes/'+classId+'/sessions/'+sessionId+'/end',{reason:'SMOKE'},teacherToken); must('session end',end.data?.success,end);
const dash2=await call('GET','/student/dashboard',null,stuToken); must('student dashboard blocked',dash2.data?.data?.canUseNow===false,dash2);
const blocked=await call('POST','/student/projects',{title:'不应创建'},stuToken); must('project blocked after class',blocked.data?.success===false,blocked);
console.log('SMOKE COMPLETE');



