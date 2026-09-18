import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorState, Loading, Notice, Empty, Panel, PageHeader } from './ui.jsx';
import { RuntimeActions, useRuntimeStatus } from './runtimeWorkspace.jsx';

export function useData(load, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const refresh = async () => {
    const request = ++requestRef.current;
    if (mountedRef.current) setState((old) => ({ ...old, loading: true, error: null }));
    try {
      const data = await load();
      if (mountedRef.current && request === requestRef.current) setState({ loading: false, error: null, data });
    } catch (error) {
      if (mountedRef.current && request === requestRef.current) setState({ loading: false, error, data: null });
    }
  };
  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, refresh };
}

/** 上课形式的名字只有一处定义，页面上的徽标、提示与按钮文案都取这里。 */
const DELIVERY_MODE_LABEL = { CANVAS: '画布课堂', VIBECODING: 'VibeCoding 课堂' };

/**
 * 学生视角的课时状态（2026-09-13 批次 C：班级退场，课堂成为主对象）。
 * 服务端 `lessonAvailability` 已经把「四种情形」算成 canStart / participationStatus / blockReason，
 * 这里只负责把它翻成一枚徽标 + 一句人话 —— 判断逻辑**不要**在前端再写一份。
 */
function lessonStateBadge(lesson) {
  if (lesson.hasGrant === false) return { tone: 'warning', text: '未授权' };
  const state = lesson.participationStatus;
  if (state === 'ACTIVE') return lesson.canStart ? { tone: 'success', text: '上课中' } : { tone: 'warning', text: '上课中' };
  if (state === 'PENDING') return { tone: 'warning', text: '待上课' };
  if (state === 'COMPLETED') return { tone: 'success', text: '已完课' };
  if (state === 'INCOMPLETE') return { tone: 'warning', text: '未完课' };
  if (state === 'REMOVED') return { tone: 'warning', text: '已被移出课堂' };
  // 没有任何课堂名单记录 —— 第四种情形：等老师把我加进课堂
  return { tone: 'warning', text: '未加入课堂' };
}

// 画布上课入口（课程包卡片 + 课时卡片，亮的课才能进入）
export function CanvasClassroom({ api, onEnterProject }) {
  const navigate = useNavigate();
  const classroom = useData(() => api.get('student/dashboard'), [api]);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState(null);
  if (classroom.loading) return <Loading label="正在读取课程中心…" />;
  if (classroom.error) return <ErrorState error={classroom.error} onRetry={classroom.refresh} />;
  const courses = (classroom.data?.classroomCourses || [])
    .map((course) => ({ ...course, lessons: (course.lessons || []).filter((lesson) => lesson.deliveryMode !== 'VIBECODING') }))
    .filter((course) => course.lessons.length);
  const selectedCourse = courses.find((course) => course.id === selectedCourseId) || null;

  async function enter(lesson) {
    if (!lesson.canStart) return;
    setBusy(lesson.id); setMessage('');
    try {
      const target = onEnterProject || ((projectId) => navigate(`/learn/canvas/${projectId}`));
      // 每次进入由服务端校验当前课堂并幂等取得该课堂的创作。
      {
        const project = await api.post('student/projects', {
          sessionId: lesson.session?.id,
          title: `${lesson.title || '今日课堂'} · 我的创作`,
          courseLessonId: lesson.id,
          canvasSnapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        });
        target(project.id);
      }
    } catch (error) { setMessage(error.message || '进入课堂失败'); }
    finally { setBusy(null); }
  }

  if (selectedCourse) {
    return <main className="classroom-center classroom-course-detail">
      <PageHeader
        eyebrow="课程中心"
        title={selectedCourse.title}
        description={selectedCourse.description || '选择一节课，进入今天的创作课堂。'}
        actions={<button className="secondary-button" onClick={() => { setSelectedCourseId(null); setMessage(''); }}>← 返回课程中心</button>}
      />
      {message && <Notice tone="danger">{message}</Notice>}
      <section className="lesson-detail-list" aria-label={`${selectedCourse.title}课时列表`}>
        <div className="lesson-list-heading">
          <div><span className="eyebrow">课程内容</span><h2>选择一节课</h2></div>
          <span className="muted">共 {selectedCourse.lessons.length} 节课</span>
        </div>
        {selectedCourse.lessons.length ? selectedCourse.lessons.map((lesson) => {
          const buttonDisabled = !lesson.canStart || busy === lesson.id;
          const badge = lessonStateBadge(lesson);
          return <article className={`lesson-detail-card ${buttonDisabled ? 'is-locked' : 'is-open'}`} key={lesson.id}>
            <div className="lesson-number">{String(lesson.sort).padStart(2, '0')}</div>
            <div className="lesson-detail-main">
              <div className="lesson-detail-title-row">
                <div><span className="lesson-kicker">第 {lesson.sort} 节 · 画布课堂</span><h3>{lesson.title}</h3></div>
              </div>
              <p>{lesson.summary || '本节课的创作任务与课堂说明将在这里展示。'}</p>
              <div className="lesson-meta">
                {lesson.teacherName ? `授课老师：${lesson.teacherName}` : '授课老师：待分配'}
                {lesson.sessionTitle ? ` · 课堂：${lesson.sessionTitle}` : ''}
                {lesson.projectCount ? ` · 已有 ${lesson.projectCount} 个项目` : ''}
                {lesson.workCount ? ` · 已提交 ${lesson.workCount} 次` : ''}
                {lesson.participationStatus === 'COMPLETED' ? ` · 这节课已完课` : ''}
              </div>
              <p className="lesson-detail-hint">{lesson.canStart ? '画布课堂已开始，现在可以进入创作。' : (lesson.blockReason || '等待老师开始上课。')}</p>
            </div>
            <div className="lesson-detail-state">
              <span className={'status ' + (badge.tone === 'muted' ? '' : badge.tone)}>{badge.text}</span>
            </div>
            <div className="lesson-detail-action">
              <button className={lesson.canStart ? 'primary-button' : 'secondary-button'} disabled={buttonDisabled} onClick={() => enter(lesson)}>
                {busy === lesson.id ? '正在进入…'
                  : lesson.canStart ? (lesson.continueProject ? '继续创作' : '进入课堂')
                    : lesson.participationStatus === 'COMPLETED' ? '已完课'
                      : '等待开课'}
              </button>
            </div>
          </article>;
        }) : <Empty title="暂无课时" body="该课程包暂时没有已发布的画布课时。" />}
      </section>
    </main>;
  }

  return <main className="classroom-center classroom-course-center">
    <PageHeader eyebrow="画布上课" title="课程中心" description="选择一个课程包进入，查看每一节课的内容与上课状态。" actions={<button className="secondary-button" onClick={classroom.refresh}>刷新课程</button>} />
    {message && <Notice tone="danger">{message}</Notice>}
    <Notice tone="info">
      进操作环境要两步：<strong>老师把课包分给你</strong>（「未授权」= 还没分），然后<strong>把你加进某节课的课堂</strong>，
      老师点「开始上课」后这节课才能进。课上完标记为<strong>已完课</strong>；没消耗过算力的算<strong>未完课</strong>，可以重新排进课堂再上。
    </Notice>
    {courses.length ? <section className="course-package-grid" aria-label="课程包列表">
      {courses.map((course, index) => {
        const openCount = course.lessons.filter((lesson) => lesson.canStart).length;
        const completedCount = course.lessons.filter((lesson) => lesson.participationStatus === 'COMPLETED').length;
        return <article className="course-package-card" key={course.id}>
          <div className={`course-package-cover cover-tone-${index % 4}`}>
            {course.coverImageUrl ? <img src={course.coverImageUrl} alt="" /> : <><span className="course-cover-orbit" /><span className="course-cover-symbol">✦</span></>}
            <span className="course-cover-label">AI 创作课程</span>
          </div>
          <div className="course-package-body">
            <div className="course-package-heading"><h2>{course.title}</h2><span>{course.lessons.length} 节课</span></div>
            <p>{course.description || '围绕真实作品展开的项目式创作课程。'}</p>
            <div className="course-package-footer">
              <span>{course.hasGrant === false
                ? '未授权 · 请找老师把这个课包分给你'
                : openCount ? `${openCount} 节课正在上课`
                  : completedCount ? `已完课 ${completedCount} 节 · 等老师安排下一节`
                    : '已分给你 · 等老师把你加进课堂'}</span>
              <button className="primary-button" onClick={() => setSelectedCourseId(course.id)}>查看课程</button>
            </div>
          </div>
        </article>;
      })}
    </section> : <Empty title="暂无课程包" body="平台发布课程包后，这里会显示全部课程。" />}
  </main>;
}

// 学习入口选择（画布上课 / VibeCoding 上课）
// 学习入口（2026-09-16 改：**以课程为先**）
//
// 为什么不再让学生先选「画布 / VibeCoding」：上课形式是**每节课**在课包里定下来的
// （`course_lessons.delivery_mode`，老师开课堂时也按这一节选），学生一进来就选方式，
// 等于让他去猜老师开的是哪种课堂。所以入口改成：先看课包 → 再选这一节课 →
// 服务端给出的 `deliveryMode` 决定进哪个创作环境，学生不需要知道也不需要选。
export function StudentCourseCenter({ api, onEnterCanvas, homeHref }) {
  const navigate = useNavigate();
  const classroom = useData(() => api.get('student/dashboard'), [api]);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState(null);
  // 学生创作环境（dsh）能不能用：能用就把 VibeCoding 课的入口换成它（见 runtimeWorkspace.jsx）。
  // ⚠️ 这个 hook 必须在下面那些提前 return **之前**调用，否则偶尔会「少一个 hook」直接崩。
  const runtime = useRuntimeStatus(api);
  if (classroom.loading) return <Loading label="正在读取课程中心…" />;
  if (classroom.error) return <ErrorState error={classroom.error} onRetry={classroom.refresh} />;
  const courses = (classroom.data?.classroomCourses || []).filter((course) => (course.lessons || []).length);
  const selectedCourse = courses.find((course) => course.id === selectedCourseId) || null;
  const modeOf = (lesson) => (lesson.deliveryMode === 'VIBECODING' ? 'VIBECODING' : 'CANVAS');
  // 一个课时可以**同时**开画布 + VibeCoding（平台在课包课时里设定的，可多选）。
  // 这时两个入口要**并列**给学生，不能替他挑一个 —— 2026-09-16 用户口径。
  // 服务端的 canStart / canStartVibeCoding 也已按课时的全部类型放行。
  const modesOf = (lesson) => (lesson?.deliveryModes?.length ? lesson.deliveryModes : [lesson?.deliveryMode || 'CANVAS'])
    .filter((mode) => Object.hasOwn(DELIVERY_MODE_LABEL, mode));

  // 只负责画布入口。VibeCoding 的入口是「进入创作环境」（RuntimeActions，走宿主脚本拉起 dsh），
  // 与画布不是同一条流程，所以**不在这里按课时类型分支** —— 那个分支写法 2026-09-17 修过一次
  //（一个课时两种都开时，按课时单值推会把 VibeCoding 按钮送进画布）。
  async function enter(lesson) {
    if (!lesson.canStart) return;
    setBusy(lesson.id); setMessage('');
    try {
      const project = await api.post('student/projects', {
        sessionId: lesson.session?.id,
        title: `${lesson.title || '今日课堂'} · 我的创作`,
        courseLessonId: lesson.id,
        canvasSnapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      });
      (onEnterCanvas || ((id) => navigate(`/learn/canvas/${id}`)))(project.id);
    } catch (error) { setMessage(error.message || '进入课堂失败'); }
    finally { setBusy(null); }
  }

  if (selectedCourse) {
    return <main className="classroom-center classroom-course-detail">
      <PageHeader
        eyebrow="学习上课"
        title={selectedCourse.title}
        description={selectedCourse.description || '选一节课进入今天的课堂；每节课的上课形式由课包设定。'}
        actions={<button className="secondary-button" onClick={() => { setSelectedCourseId(null); setMessage(''); }}>← 返回我的课程</button>}
      />
      {message && <Notice tone="danger">{message}</Notice>}
      <section className="lesson-detail-list" aria-label={`${selectedCourse.title}课时列表`}>
        <div className="lesson-list-heading">
          <div><span className="eyebrow">课程内容</span><h2>选择一节课</h2></div>
          <span className="muted">共 {selectedCourse.lessons.length} 节课</span>
        </div>
        {selectedCourse.lessons.map((lesson) => {
          const mode = modeOf(lesson);
          const modes = modesOf(lesson);
          const offersCanvas = modes.includes('CANVAS');
          const offersVibe = modes.includes('VIBECODING');
          const canEnterVibe = offersVibe && Boolean(lesson.canStartVibeCoding);
          const canEnterCanvas = offersCanvas && Boolean(lesson.canStart);
          const canEnter = canEnterCanvas || canEnterVibe;
          const disabled = !canEnter || busy === lesson.id;
          const badge = lessonStateBadge(lesson);
          // 说明必须按这一节自己的入口类型取：拿错会给出「老师开启的是画布课堂，本课时不走 VibeCoding」这种怪话。
          const reason = mode === 'VIBECODING' ? lesson.vibeCodingBlockReason : lesson.blockReason;
          return <article className={`lesson-detail-card ${disabled ? 'is-locked' : 'is-open'}`} key={lesson.id}>
            <div className="lesson-number">{String(lesson.sort).padStart(2, '0')}</div>
            <div className="lesson-detail-main">
              <div className="lesson-detail-title-row">
                <div><span className="lesson-kicker">第 {lesson.sort} 节 · {modes.map((item) => DELIVERY_MODE_LABEL[item]).join(' / ')}</span><h3>{lesson.title}</h3></div>
              </div>
              <p>{lesson.summary || '本节课的创作任务与课堂说明将在这里展示。'}</p>
              <div className="lesson-meta">
                {lesson.teacherName ? `授课老师：${lesson.teacherName}` : '授课老师：待分配'}
                {lesson.sessionTitle ? ` · 课堂：${lesson.sessionTitle}` : ''}
                {lesson.projectCount ? ` · 已有 ${lesson.projectCount} 个项目` : ''}
                {lesson.workCount ? ` · 已提交 ${lesson.workCount} 次` : ''}
                {lesson.participationStatus === 'COMPLETED' ? ' · 这节课已完课' : ''}
              </div>
              {/* 能不能进、为什么不能进，都写在课名这一栏里，不再和按钮抢右栏那点宽度 */}
              <p className="lesson-detail-hint">{canEnter ? `老师已开始${modes.length > 1 ? '' : ' ' + DELIVERY_MODE_LABEL[mode]}，现在可以进入创作。` : (reason || '等待老师开始上课。')}</p>
            </div>
            <div className="lesson-detail-state">
              <span className={'status ' + (badge.tone === 'muted' ? '' : badge.tone)}>{badge.text}</span>
            </div>
            <div className="lesson-detail-action">
              {/* VibeCoding 课（2026-09-17 口径变更）：**学生干活的地方就是创作环境（dsh）**。
                  平台自己那套老工作台已删（用户口径：「我需要的是 dsh 那个页面来完成这些工作，
                  抛弃掉以前的老 vibecoding」），所以这里不放任何指向平台内对话页的按钮 ——
                  入口就是「进入创作环境」+「提交作品」。
                  两种都开时**两个入口并列**（画布按钮 + VibeCoding 那两个），学生自己挑。 */}
              {runtime.ready && offersVibe ? <RuntimeActions api={api} lesson={lesson} canEnter={canEnterVibe} /> : null}
              {offersCanvas ? <button className={canEnterCanvas ? 'primary-button' : 'secondary-button'} disabled={!canEnterCanvas || busy === lesson.id} onClick={() => enter(lesson)}>
                {busy === lesson.id ? '正在进入…'
                  : canEnterCanvas ? (lesson.continueProject ? '继续创作' : '进入课堂')
                    : lesson.participationStatus === 'COMPLETED' ? '已完课'
                      : lesson.hasGrant === false ? '未授权'
                        : '等待开课'}
              </button> : null}
              {/* 只开 VibeCoding、而这台机器现在开不了创作环境时的兜底：按钮点不动，但**把原因说在按钮上**
                  （别让卡片空着，也别让学生以为是自己点错了）。 */}
              {offersVibe && !runtime.ready ? <button className="secondary-button" disabled>
                {busy === lesson.id ? '正在进入…'
                  : lesson.participationStatus === 'COMPLETED' ? '已完课'
                    : lesson.hasGrant === false ? '未授权'
                      : canEnterVibe ? '创作环境暂不可用' : '等待开课'}
              </button> : null}
            </div>
          </article>;
        })}
      </section>
    </main>;
  }

  return <main className="classroom-center classroom-course-center">
    <PageHeader eyebrow="学习上课" title="我的课程" description="先选课包，再选这一节课；上课形式（画布 / VibeCoding）由课包设定，不需要你自己选。" actions={<>
      {/* 用户口径 2026-09-18 晚：这一页是学生登录后的落地页，要有个回官网首页的出口。
          做成可选属性 —— 别的端引这个组件时不会凭空多出一个指向 '/' 的链接。 */}
      {homeHref ? <a className="secondary-button" href={homeHref}>← 返回首页</a> : null}
      <button className="secondary-button" onClick={classroom.refresh}>刷新课程</button>
    </>} />
    {message && <Notice tone="danger">{message}</Notice>}
    {/* ⚠️ 这里原来有一条 tone="info" 的「进操作环境要两步…」横幅，按用户口径 2026-09-18 晚**删掉了**
        （原话：「图1 灵动学习页面这里的提示要删除」）。别再加回来 —— 两步的说明在课包卡片自己那句状态里
        （「已分给你 · 等老师把你加进课堂」）已经有了。
        ⚠️ 上面 CanvasClassroom（画布上课页）里还有一条**一模一样**的横幅，用户这次没点它，先留着。 */}
    {courses.length ? <section className="course-package-grid" aria-label="课程包列表">
      {courses.map((course, index) => {
        const lessons = course.lessons || [];
        // ⚠️ 2026-09-18 晚用户口径：卡片上原来那两行（「已分给你 · 等老师把你加进课堂」这行状态、
        //    以及「上课形式：画布课堂 N 节」）**都删掉了** —— 所以这里不再算 openCount/completedCount/
        //    modeSummary（算了也没地方用）。
        return <article className="course-package-card" key={course.id}>
          <div className={`course-package-cover cover-tone-${index % 4}`}>
            {course.coverImageUrl ? <img src={course.coverImageUrl} alt="" /> : <><span className="course-cover-orbit" /><span className="course-cover-symbol">✦</span></>}
            {/* 封面上的那行字改成**课包标题**（原来写死「AI 创作课程」，看不出是哪个课包） */}
            <span className="course-cover-label">{course.title}</span>
          </div>
          <div className="course-package-body">
            <div className="course-package-heading"><h2>{course.title}</h2><span>{lessons.length} 节课</span></div>
            {/* 「查看课程」不再单独占一行，挪到简介右边 */}
            <div className="course-package-desc">
              <p>{course.description || '围绕真实作品展开的项目式创作课程。'}</p>
              <button type="button" className="course-package-cta" onClick={() => setSelectedCourseId(course.id)}>查看课程</button>
            </div>
          </div>
        </article>;
      })}
    </section> : <Empty title="暂无课程包" body="老师把课包分给你之后，这里会显示你的课程。" />}
  </main>;
}
