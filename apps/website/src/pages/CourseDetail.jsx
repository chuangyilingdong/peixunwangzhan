import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

// 课时状态只认服务端给的课堂状态（participationStatus / canStart），与「我的课程」「学习上课」同一套口径；
// 以前这里读 lesson.status（那是**课时的发布状态**，不是学生自己的上课状态），所以永远显示「未开课」。
const LESSON_STATE = {
  ACTIVE: { label: '上课中', tone: 'is-live' },
  PENDING: { label: '待上课', tone: 'is-pending' },
  COMPLETED: { label: '已完课', tone: 'is-ok' },
  INCOMPLETE: { label: '未完课', tone: 'is-pending' },
  REMOVED: { label: '已被移出', tone: 'is-warn' },
};
const MODE_LABEL = { CANVAS: '画布课堂', VIBECODING: 'VibeCoding 课堂' };

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
    <div className="student-course-detail-list">{(course.lessons || []).map((lesson, index) => {
      const status = LESSON_STATE[lesson.participationStatus] || { label: '未加入课堂', tone: '' };
      const mode = MODE_LABEL[lesson.classroomMode] || '画布课堂';
      return <article className="student-course-detail-row" key={lesson.id || index}>
        <span className="student-course-lesson__index">{String(index + 1).padStart(2, '0')}</span>
        <div>
          <h3>{lesson.title}</h3>
          <p>{lesson.summary || lesson.description || '课程内容与操作环境'} · {mode}</p>
          {lesson.classroomBlockReason ? <p className="muted">{lesson.classroomBlockReason}</p> : null}
        </div>
        <span className={`student-badge ${status.tone}`}>{status.label}</span>
        {status.label === '上课中' && (lesson.canStart || lesson.canStartVibeCoding)
          ? <Link className="student-course-lesson__action" to="/learn">进入课堂</Link>
          : status.label === '已完课'
            ? <Link className="student-course-lesson__action" to="/my-works">回顾作品</Link>
            : <span className="muted">—</span>}
      </article>;
    })}</div>
  </div>;
}
