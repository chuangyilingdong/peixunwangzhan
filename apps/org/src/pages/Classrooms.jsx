// 课堂的四个页面（2026-09-17 按线框图从「一个大组件 + 一堆弹窗」拆成四个独立路由）。
//
// 本文件只做路由分派与导航：真正的界面在 ./classroom/ 下面。
//   /classrooms                       → 005-01 我的课堂列表
//   /classrooms/new                   → 005-02 创建课堂
//   /classrooms/:sessionId            → 005-03 课堂详情
//   /classrooms/:sessionId/students/new → 005-04 添加学生
//
// ⚠️ 深链契约（scripts/p81-classroom-interaction-guard.mjs 钉着）：课堂详情的地址形状
// 必须是 /classrooms/:sessionId，且下面三处导航调用要留在本文件里 —— 拆页面时别把它们搬走。
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ClassroomList } from './classroom/ClassroomList.jsx';
import { CreateClassroom } from './classroom/CreateClassroom.jsx';
import { ClassroomDetail } from './classroom/ClassroomDetail.jsx';
import { AddClassroomStudents } from './classroom/AddClassroomStudents.jsx';
import './Classrooms.css';

export function Classrooms({ api, user }) {
  const isAdmin = user?.role === 'ORG_ADMIN';
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId = '' } = useParams();
  const pathname = location.pathname || '';
  const isCreate = /\/classrooms\/new\/?$/.test(pathname);
  const isAddStudents = /\/classrooms\/[^/]+\/students\/new\/?$/.test(pathname);

  function openSession(id) {
    navigate('/classrooms/' + encodeURIComponent(id), { state: { fromClassroomList: true } });
  }
  // 从详情回列表：列表是当前会话里来的就原路返回（保留滚动与筛选），
  // 直接贴链接进来的就 replace 到列表 —— 否则「返回」会退到站外或登录前的页面。
  function closeSession() {
    if (window.history.state?.usr?.fromClassroomList) navigate(-1);
    else navigate('/classrooms', { replace: true });
  }

  if (isCreate) {
    return <CreateClassroom api={api} isAdmin={isAdmin} parentLabel="我的课堂列表"
      onCancel={closeSession} onCreated={openSession} />;
  }
  if (isAddStudents) {
    return <AddClassroomStudents api={api} openId={sessionId}
      onBack={() => navigate('/classrooms/' + encodeURIComponent(sessionId), { replace: true })} />;
  }
  if (sessionId) {
    return <ClassroomDetail api={api} openId={sessionId} onBack={closeSession}
      onAddStudents={() => navigate('/classrooms/' + encodeURIComponent(sessionId) + '/students/new')} />;
  }
  return <ClassroomList api={api} isAdmin={isAdmin} onOpen={openSession}
    onCreate={() => navigate('/classrooms/new')} />;
}
