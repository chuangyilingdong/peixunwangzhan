import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

// 课时状态只认服务端给的课堂状态（participationStatus / canStart），与「我的课程」「学习上课」同一套口径；
// 以前这里读 lesson.status（那是**课时的发布状态**，不是学生自己的上课状态），所以永远显示「未开课」。
const LESSON_STATE = {
  ACTIVE: { label: '上课中', tone: 'is-live' },
  PENDING: { label: '待上课', tone: 'is-pending' },
  COMPLETED: { label: '已完成', tone: 'is-ok' },
  INCOMPLETE: { label: '未完课', tone: 'is-pending' },
  REMOVED: { label: '已被移出', tone: 'is-warn' },
};
const MODE = {
  CANVAS: { label: '画布课堂', icon: '🎨' },
  VIBECODING: { label: 'VibeCoding 课堂', icon: '💻' },
};

/** 课时标题本身常常就带「第N课」，别再加一遍前缀。 */
function lessonLabel(lesson, index) {
  const title = String(lesson.title || '').trim() || `第${index + 1}课`;
  return /^第\s*\d+\s*课/.test(title) ? title : `第${index + 1}课｜${title}`;
}

export function CourseDetailPage({ api }) {
  const { courseId } = useParams();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  useEffect(() => { let live = true; api.get(`student/courses/${encodeURIComponent(courseId)}`).then((data) => live && setState({ loading: false, error: null, data })).catch((error) => live && setState({ loading: false, error: error.message, data: null })); return () => { live = false; }; }, [api, courseId]);
  if (state.loading) return <div className="student-page-state">正在加载课包详情…</div>;
  if (state.error) return <div className="student-page-state is-error">⚠ {state.error}</div>;
  const course = state.data || {};
  const lessons = course.lessons || [];
  const doneCount = lessons.filter((lesson) => lesson.participationStatus === 'COMPLETED').length;
  return <div className="student-page">
    <Link className="student-back" to="/my-courses">← 返回我的课包</Link>

    <header className="student-course-head">
      <div className="student-course-head__cover">
        {course.coverImageUrl ? <img src={course.coverImageUrl} alt="" /> : <><span className="student-course-head__orb" /><span className="student-course-head__symbol">✦</span></>}
      </div>
      <div className="student-course-head__text">
        <h1>{course.title || '课包详情'}</h1>
        <p>{course.description || '查看课包课程目录、课堂状态与学习成果。'}</p>
        <p className="student-course-head__meta">共 {lessons.length} 课 · 已完课 {doneCount} 课</p>
      </div>
      <aside className="student-course-head__note">
        <strong>课程状态</strong>
        <p>课程状态只显示四种：<em>未开课</em> / <em>待上课</em> / <em>上课中</em> / <em>已完成</em>。</p>
        <p>上课中 → 进入课堂；已完成 → 课程回顾。</p>
        <p className="muted">能不能进由老师决定：先分课包，再把你加进这一节课的课堂，并点「开始上课」。</p>
      </aside>
    </header>

    <h2 className="student-course-lessons-title">课包课程列表（共 {lessons.length} 课）</h2>

    {lessons.length ? <div className="student-lesson-table-wrap">
      <table className="student-lesson-table">
        <thead><tr><th>序号</th><th>课程信息</th><th>课程状态</th><th>操作</th></tr></thead>
        <tbody>{lessons.map((lesson, index) => {
          const status = LESSON_STATE[lesson.participationStatus] || { label: '未开课', tone: '' };
          const mode = MODE[lesson.classroomMode] || MODE.CANVAS;
          const canEnter = lesson.canStart || lesson.canStartVibeCoding;
          return <tr key={lesson.id || index}>
            <td className="student-lesson-table__no">{index + 1}</td>
            <td>
              <div className="student-lesson-table__info">
                <span className="student-lesson-table__thumb" aria-hidden="true">{mode.icon}</span>
                <div>
                  <h3>{lessonLabel(lesson, index)}</h3>
                  <p>{lesson.summary || lesson.description || '课程内容与操作环境'}</p>
                  <p className="muted">{mode.label} · {lesson.teacherName ? `授课老师：${lesson.teacherName}` : '授课老师：待分配'}{lesson.classroomBlockReason && !canEnter ? ` · ${lesson.classroomBlockReason}` : ''}</p>
                </div>
              </div>
            </td>
            <td><span className={`student-badge ${status.tone}`}>{status.label}</span></td>
            <td>{status.label === '上课中' && canEnter
              ? <Link className="student-course-lesson__action" to="/learn">进入课堂</Link>
              : status.label === '已完成'
                ? <Link className="student-course-lesson__action" to="/my-works">课程回顾</Link>
                : <span className="muted">—</span>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <div className="student-page-state">这个课包还没有已发布的课时。</div>}
  </div>;
}
