// 官网 - 学习统计
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

const LESSON_STATUS_LABELS = { NOT_STARTED: '未开始', IN_PROGRESS: '进行中', COMPLETED: '已完成' };

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MyStatsPage({ api }) {
  const [state, setState] = useState({ loading: true, error: null, overview: null, courses: null });

  useEffect(() => {
    let live = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    Promise.all([api.get('student/learning/overview'), api.get('student/courses')])
      .then(([overview, courses]) => { if (live) setState({ loading: false, error: null, overview, courses }); })
      .catch((error) => { if (live) setState({ loading: false, error: error.message, overview: null, courses: null }); });
    return () => { live = false; };
  }, [api]);

  const summary = state.overview?.summary || {};
  const courseSummary = state.courses?.summary || {};
  const lessons = state.overview?.items || [];
  const recentProjects = state.overview?.recentProjects || [];
  const completedPercent = summary.total ? Math.round(((summary.completed || 0) / summary.total) * 100) : 0;

  return <div className="student-page">
    <header className="student-page-head">
      <h1>学习统计</h1>
      <p>你的课时完成情况与最近的创作记录。</p>
    </header>

    {state.loading ? <div className="student-page-state">正在统计…</div> : null}
    {state.error ? <div className="student-page-state is-error">⚠ {state.error}</div> : null}

    {!state.loading && !state.error ? <>
      <div className="student-summary">
        <div className="student-summary-card"><span>课时总数</span><strong>{summary.total || 0}</strong></div>
        <div className="student-summary-card"><span>已完成</span><strong>{summary.completed || 0}</strong></div>
        <div className="student-summary-card"><span>进行中</span><strong>{summary.inProgress || 0}</strong></div>
        <div className="student-summary-card"><span>完成率</span><strong>{completedPercent}%</strong></div>
      </div>

      <section className="student-panel">
        <h2>课时完成情况</h2>
        <div className="student-progress-bar"><i style={{ width: `${completedPercent}%` }} /></div>
        <p className="student-card__meta">共 {summary.total || 0} 节，已完成 {summary.completed || 0} 节，进行中 {summary.inProgress || 0} 节。</p>
      </section>

      <section className="student-panel">
        <h2>课程进度</h2>
        {courseSummary.courseCount ? <>
          <p className="student-card__meta">可学课程 {courseSummary.courseCount} 门 · 课时 {courseSummary.assignedLessonCount || 0} 节 · 已开始 {courseSummary.startedLessonCount || 0} 节 · 已提交作品 {courseSummary.submittedLessonCount || 0} 节</p>
          <div className="student-card-grid">{(state.courses?.items || []).map((course) => <article className="student-card" key={course.id}>
            <div className="student-card__head"><h3>{course.title}</h3><span className="student-badge">{course.progress?.submittedPercent || 0}%</span></div>
            <p className="student-card__meta">共 {course.progress?.lessonCount || 0} 节 · 已提交 {course.progress?.submittedLessonCount || 0} 节</p>
            <div className="student-progress-bar"><i style={{ width: `${course.progress?.submittedPercent || 0}%` }} /></div>
          </article>)}</div>
        </> : <p className="student-card__meta">还没有可统计的课程。</p>}
      </section>

      <section className="student-panel">
        <h2>最近创作</h2>
        {recentProjects.length ? <table className="student-table"><thead><tr><th>作品项目</th><th>状态</th><th>最近更新</th></tr></thead><tbody>
          {recentProjects.map((project) => <tr key={project.id}><td>{project.title}</td><td>{LESSON_STATUS_LABELS[project.status] || project.status}</td><td>{formatDate(project.updatedAt)}</td></tr>)}
        </tbody></table> : <p className="student-card__meta">还没有创作记录，去画布课堂试试吧。</p>}
      </section>

      <section className="student-panel">
        <h2>课时明细</h2>
        {lessons.length ? <table className="student-table"><thead><tr><th>课时</th><th>课程</th><th>状态</th><th>最近学习</th></tr></thead><tbody>
          {lessons.slice(0, 30).map((lesson) => <tr key={lesson.id}><td>{lesson.title}</td><td>{lesson.courseTitle}</td><td>{LESSON_STATUS_LABELS[lesson.status] || lesson.status}</td><td>{formatDate(lesson.lastAccessedAt)}</td></tr>)}
        </tbody></table> : <p className="student-card__meta">暂无课时数据。</p>}
      </section>

      <div className="student-page-actions"><Link className="button" to="/learn">继续学习 <b>↗</b></Link></div>
    </> : null}
  </div>;
}
