// 官网 - 我的课程（学生登录后的落地页）
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
// 2026-09-18 晚：学生端那个「学习上课」列表页（原来的 /learn）已按用户口径删掉，
// 它的两个入口挪到本页 —— 所以这里要用共享的「进入创作环境 / 提交作品」组件。
import { Notice, RuntimeActions, useRuntimeStatus } from '@platform/shared';

// 课时状态只认服务端给的课堂状态（participationStatus / canStart）：
// 以前这里拿作品状态（workStatus / lesson.status）顶替，结果正在上课的课时也显示「未开课」。
// 规则与「学习上课」页的 lessonStateBadge 完全一致 —— 四处口径必须一样。
const LESSON_STATE = {
  ACTIVE: { label: '上课中', tone: 'is-live' },
  PENDING: { label: '待上课', tone: 'is-pending' },
  COMPLETED: { label: '已完课', tone: 'is-ok' },
  INCOMPLETE: { label: '未完课', tone: 'is-pending' },
  REMOVED: { label: '已被移出', tone: 'is-warn' },
};
const MODE_LABEL = { CANVAS: '画布课堂', VIBECODING: 'VibeCoding 课堂' };
const BLANK_CANVAS = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };

export function MyCoursesPage({ api }) {
  const [state, setState] = useState({ loading: true, error: null, items: [], summary: null });
  // ⚠️ hook 必须都在最上面（p34 会扫「提前 return 之后还有 hook」）。
  // runtime 决定 VibeCoding 课能不能给「进入创作环境」入口（与原来那个列表页同一套判断）。
  const runtime = useRuntimeStatus(api);
  const [busyLesson, setBusyLesson] = useState(null);
  const [enterError, setEnterError] = useState('');

  useEffect(() => {
    let live = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    api.get('student/courses')
      .then((payload) => { if (live) setState({ loading: false, error: null, items: payload?.items || [], summary: payload?.summary || null }); })
      .catch((error) => { if (live) setState({ loading: false, error: error.message, items: [], summary: null }); });
    return () => { live = false; };
  }, [api]);

  /**
   * 直接进课堂（2026-09-18 晚用户口径）。
   *
   * 以前这一列是个 `<Link to="/learn">` —— 点下去会跳到学生端那个**也叫「我的课程」**的列表页，
   * 用户报的就是「我点击进入课堂，又跳转到我的课程页面」。现在在这一页直接进：
   * 服务端建一个项目（带课堂会话 + 课时）→ 整页跳到画布。
   * ⚠️ 这段与原来那个列表页里的 enter() 是**同一个接口、同一组字段**，别自己改字段名。
   */
  async function enterClassroom(lesson) {
    if (!lesson.canStart || busyLesson) return;
    setBusyLesson(lesson.id); setEnterError('');
    try {
      const project = await api.post('student/projects', {
        sessionId: lesson.classroomSessionId,
        title: `${lesson.title || '今日课堂'} · 我的创作`,
        courseLessonId: lesson.id,
        canvasSnapshot: BLANK_CANVAS,
      });
      window.location.assign('/learn/canvas/' + project.id);
    } catch (error) {
      setEnterError(error.message || '进入课堂失败');
    } finally { setBusyLesson(null); }
  }

  const { items, summary } = state;
  const lessonStatus = (lesson, granted) => {
    if (!granted) return { label: '未授权', tone: 'is-warn' };
    const mapped = LESSON_STATE[lesson.participationStatus];
    if (mapped) return mapped;
    return { label: '未加入课堂', tone: '' };
  };

  return <div className="student-page">
    <header className="student-page-head">
      <div className="student-page-head__top">
        <h1>我的课程</h1>
        {/* 用户口径：这一页要有个回首页的返回入口（它现在也是学生登录后的落地页） */}
        <Link className="secondary-button student-page-back" to="/">← 返回首页</Link>
      </div>
      <p>你在本机构可以学习的课程与课时进度。</p>
      {/* 批次 C（班级退场）：门禁是「机构授权 + 老师分课包 + 老师把你加进课堂」三层叠加，
          学生得知道「进不去该找谁」——所以这里把三步都写出来 */}
      <p className="student-page-hint">
        进操作环境要三步：① 课包标着<strong>「未授权」</strong>＝老师还没把课包分给你，找老师说一句就能开通；
        ② 已经分给你的课包，还要<strong>等老师把你加进这一节课的课堂</strong>；
        ③ 老师点「开始上课」后这节课才能进。课上完标记<strong>已完课</strong>，没消耗过算力的算<strong>未完课</strong>，可以重新排进课堂再上。
      </p>
    </header>

    {enterError ? <Notice tone="danger">{enterError}</Notice> : null}

    {summary ? <div className="student-summary">
      <div className="student-summary-card"><span>课程</span><strong>{summary.courseCount || 0}</strong></div>
      <div className="student-summary-card"><span>课时</span><strong>{summary.assignedLessonCount || 0}</strong></div>
      <div className="student-summary-card"><span>上课中</span><strong>{summary.activeLessonCount || 0}</strong></div>
      <div className="student-summary-card"><span>已提交作品</span><strong>{summary.submittedLessonCount || 0}</strong></div>
    </div> : null}

    {state.loading ? <div className="student-page-state">正在加载课程…</div> : null}
    {state.error ? <div className="student-page-state is-error">⚠ {state.error}</div> : null}

    {!state.loading && !state.error && items.length === 0 ? <div className="student-page-state">
      ✦ 还没有可学习的课程。<br />请联系老师为你的机构开通课包，并把课包分给你。
    </div> : null}

    {items.length ? <div className="student-card-grid">{items.map((course) => <article className="student-card" key={course.id}>
      <div className="student-card__head">
        <h3><Link to={`/my-courses/${encodeURIComponent(course.id)}`}>{course.title}</Link></h3>
        {course.hasGrant === false
          ? <span className="student-badge is-warn">未授权</span>
          : <span className="student-badge">{course.progress?.submittedPercent || 0}%</span>}
      </div>
      {course.hasGrant === false ? <p className="student-card__meta">这个课包还没有分配给你，请联系老师开通后再进入。</p> : null}
      {course.description ? <p className="student-card__desc">{course.description}</p> : null}
      <p className="student-card__meta">共 {course.progress?.lessonCount || 0} 节 · 上课中 {course.progress?.activeLessonCount || 0} 节 · 待上课 {course.progress?.pendingLessonCount || 0} 节 · 已完课 {course.progress?.completedLessonCount || 0} 节</p>
      <div className="student-progress-bar"><i style={{ width: `${course.progress?.submittedPercent || 0}%` }} /></div>
      {course.hasGrant !== false && course.lessons?.length ? <div className="student-course-lessons" aria-label="课包课程列表">{course.lessons.map((lesson, index) => {
        const status = lessonStatus(lesson, course.hasGrant !== false);
        const mode = MODE_LABEL[lesson.classroomMode] || '画布课堂';
        const canEnterCanvas = status.label === '上课中' && Boolean(lesson.canStart);
        const canEnterVibe = status.label === '上课中' && Boolean(lesson.canStartVibeCoding);
        return <div className="student-course-lesson" key={lesson.id || index}>
          <span className="student-course-lesson__index">{String(index + 1).padStart(2, '0')}</span>
          <span className="student-course-lesson__title" title={lesson.title}>{lesson.title}<span className="muted"> · {mode}</span></span>
          <span className={`student-badge ${status.tone}`}>{status.label}</span>
          {/* 操作列：画布课是「进入课堂」，VibeCoding 课是共享的「进入创作环境 / 提交作品」。
              两种都开时**并列**（与原来那个列表页同一口径，不替学生挑一个）。 */}
          <span className="student-course-lesson__actions">
            {canEnterVibe && runtime.ready ? <RuntimeActions api={api} lesson={lesson} canEnter/> : null}
            {canEnterVibe && !runtime.ready ? <span className="muted" title="这台机器现在开不了创作环境">创作环境暂不可用</span> : null}
            {canEnterCanvas ? <button type="button" className="student-course-lesson__action" disabled={busyLesson === lesson.id} onClick={() => enterClassroom(lesson)}>{busyLesson === lesson.id ? '正在进入…' : '进入课堂'}</button> : null}
            {!canEnterCanvas && !canEnterVibe
              ? (status.label === '已完课'
                ? <Link className="student-course-lesson__action" to="/my-works">回顾作品</Link>
                : <span className="muted" title={lesson.classroomBlockReason || ''}>—</span>)
              : null}
          </span>
        </div>;
      })}</div> : null}
    </article>)}</div> : null}
  </div>;
}
