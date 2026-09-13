// 官网 - 我的课程
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

export function MyCoursesPage({ api }) {
  const [state, setState] = useState({ loading: true, error: null, items: [], summary: null });

  useEffect(() => {
    let live = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    api.get('student/courses')
      .then((payload) => { if (live) setState({ loading: false, error: null, items: payload?.items || [], summary: payload?.summary || null }); })
      .catch((error) => { if (live) setState({ loading: false, error: error.message, items: [], summary: null }); });
    return () => { live = false; };
  }, [api]);

  const { items, summary } = state;

  return <div className="student-page">
    <header className="student-page-head">
      <h1>我的课程</h1>
      <p>你在本机构可以学习的课程与课时进度。</p>
      {/* 批次 C（班级退场）：门禁是「机构授权 + 老师分课包 + 老师把你加进课堂」三层叠加，
          学生得知道「进不去该找谁」——所以这里把三步都写出来 */}
      <p className="student-page-hint">
        进操作环境要三步：① 课包标着<strong>「未授权」</strong>＝老师还没把课包分给你，找老师说一句就能开通；
        ② 已经分给你的课包，还要<strong>等老师把你加进这一节课的课堂</strong>；
        ③ 老师点「开始上课」后这节课才能进。课上完标记<strong>已完课</strong>，没消耗过算力的算<strong>未完课</strong>，可以重新排进课堂再上。
      </p>
    </header>

    {summary ? <div className="student-summary">
      <div className="student-summary-card"><span>课程</span><strong>{summary.courseCount || 0}</strong></div>
      <div className="student-summary-card"><span>课时</span><strong>{summary.assignedLessonCount || 0}</strong></div>
      <div className="student-summary-card"><span>已开始</span><strong>{summary.startedLessonCount || 0}</strong></div>
      <div className="student-summary-card"><span>已提交作品</span><strong>{summary.submittedLessonCount || 0}</strong></div>
    </div> : null}

    {state.loading ? <div className="student-page-state">正在加载课程…</div> : null}
    {state.error ? <div className="student-page-state is-error">⚠ {state.error}</div> : null}

    {!state.loading && !state.error && items.length === 0 ? <div className="student-page-state">
      ✦ 还没有可学习的课程。<br />请联系老师为你的机构开通课包，并把课包分给你。
    </div> : null}

    {items.length ? <div className="student-card-grid">{items.map((course) => <article className="student-card" key={course.id}>
      <div className="student-card__head">
        <h3>{course.title}</h3>
        {course.hasGrant === false
          ? <span className="student-badge is-warn">未授权</span>
          : <span className="student-badge">{course.progress?.submittedPercent || 0}%</span>}
      </div>
      {course.hasGrant === false ? <p className="student-card__meta">这个课包还没有分配给你，请联系老师开通后再进入。</p> : null}
      {course.description ? <p className="student-card__desc">{course.description}</p> : null}
      <p className="student-card__meta">共 {course.progress?.lessonCount || 0} 节 · 已开始 {course.progress?.startedLessonCount || 0} 节 · 已提交 {course.progress?.submittedLessonCount || 0} 节</p>
      <div className="student-progress-bar"><i style={{ width: `${course.progress?.submittedPercent || 0}%` }} /></div>
    </article>)}</div> : null}

    {items.length ? <div className="student-page-actions"><Link className="button" to="/learn">进入学习 <b>↗</b></Link></div> : null}
  </div>;
}
