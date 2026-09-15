import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

const labels = { PENDING: '待上课', ACTIVE: '上课中', COMPLETED: '已完成' };
export function CourseDetailPage({ api }) {
  const { courseId } = useParams();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  useEffect(() => { let live = true; api.get(`student/courses/${encodeURIComponent(courseId)}`).then((data) => live && setState({ loading: false, error: null, data })).catch((error) => live && setState({ loading: false, error: error.message, data: null })); return () => { live = false; }; }, [api, courseId]);
  if (state.loading) return <div className="student-page-state">正在加载课包详情…</div>;
  if (state.error) return <div className="student-page-state is-error">⚠ {state.error}</div>;
  const course = state.data || {};
  return <div className="student-page">
    <nav aria-label="面包屑" className="breadcrumb row-actions"><Link to="/my-courses">我的课包</Link><span className="muted" aria-hidden="true">/</span><span>{course.title || '课包详情'}</span></nav>
    <header className="student-page-head"><h1>{course.title || '课包详情'}</h1><p>{course.description || '查看课包课程目录、课堂状态与学习成果。'}</p></header>
    <div className="student-course-detail-list">{(course.lessons || []).map((lesson, index) => { const status = lesson.status || lesson.progressStatus || 'NOT_STARTED'; const label = labels[status] || '未开课'; const action = status === 'ACTIVE' ? '进入课堂' : status === 'COMPLETED' ? '课程回顾' : null; return <article className="student-course-detail-row" key={lesson.id || index}><span className="student-course-lesson__index">{String(index + 1).padStart(2, '0')}</span><div><h3>{lesson.title}</h3><p>{lesson.summary || lesson.description || '课程内容与操作环境'}</p></div><span className={`student-badge ${status === 'ACTIVE' ? 'is-live' : status === 'PENDING' ? 'is-pending' : status === 'COMPLETED' ? 'is-ok' : ''}`}>{label}</span>{action ? <Link className="student-course-lesson__action" to="/learn">{action}</Link> : <span className="muted">—</span>}</article>; })}</div>
  </div>;
}
