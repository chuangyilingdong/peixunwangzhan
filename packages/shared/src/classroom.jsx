import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorState, Loading, Notice, Empty, Panel, PageHeader } from './ui.jsx';

export function useData(load, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const refresh = async () => {
    setState((old) => ({ ...old, loading: true, error: null }));
    try { setState({ loading: false, error: null, data: await load() }); }
    catch (error) { setState({ loading: false, error, data: null }); }
  };
  useEffect(() => { refresh(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, refresh };
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
      if (lesson.continueProject) target(lesson.continueProject.id);
      else {
        const project = await api.post('student/projects', {
          title: `${lesson.title || '今日课堂'} · 我的创作`,
          courseLessonId: lesson.id,
          classId: lesson.classId,
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
          return <article className={`lesson-detail-card ${buttonDisabled ? 'is-locked' : 'is-open'}`} key={lesson.id}>
            <div className="lesson-number">{String(lesson.sort).padStart(2, '0')}</div>
            <div className="lesson-detail-main">
              <div className="lesson-detail-title-row">
                <div><span className="lesson-kicker">第 {lesson.sort} 节</span><h3>{lesson.title}</h3></div>
                {lesson.hasGrant === false ? <span className="status warning">未授权</span> : lesson.canStart ? <span className="status success">已开课</span> : <span className="status warning">未开课</span>}
              </div>
              <p>{lesson.summary || '本节课的创作任务与课堂说明将在这里展示。'}</p>
              <div className="lesson-meta">{lesson.className || '未配置班级'} · {lesson.teacherName || '待分配老师'}{lesson.projectCount ? ` · 已有 ${lesson.projectCount} 个项目` : ''}{lesson.workCount ? ` · 已提交 ${lesson.workCount} 次` : ''}</div>
            </div>
            <div className="lesson-detail-action">
              <span className="lesson-block-reason">{lesson.blockReason || (lesson.canStart ? '画布课堂已开始，现在可以进入创作。' : '等待老师开始上课。')}</span>
              <button className={lesson.canStart ? 'primary-button' : 'secondary-button'} disabled={buttonDisabled} onClick={() => enter(lesson)}>
                {busy === lesson.id ? '正在进入…' : lesson.canStart ? '进入课堂' : '等待开课'}
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
    {courses.length ? <section className="course-package-grid" aria-label="课程包列表">
      {courses.map((course, index) => {
        const openCount = course.lessons.filter((lesson) => lesson.canStart).length;
        return <article className="course-package-card" key={course.id}>
          <div className={`course-package-cover cover-tone-${index % 4}`}>
            {course.coverImageUrl ? <img src={course.coverImageUrl} alt="" /> : <><span className="course-cover-orbit" /><span className="course-cover-symbol">✦</span></>}
            <span className="course-cover-label">AI 创作课程</span>
          </div>
          <div className="course-package-body">
            <div className="course-package-heading"><h2>{course.title}</h2><span>{course.lessons.length} 节课</span></div>
            <p>{course.description || '围绕真实作品展开的项目式创作课程。'}</p>
            <div className="course-package-footer"><span>{course.hasGrant === false ? '未授权 · 请联系老师分配课包' : openCount ? `${openCount} 节课已开课` : '等待老师开课'}</span><button className="primary-button" onClick={() => setSelectedCourseId(course.id)}>查看课程</button></div>
          </div>
        </article>;
      })}
    </section> : <Empty title="暂无课程包" body="平台发布课程包后，这里会显示全部课程。" />}
  </main>;
}

// 学习入口选择（画布上课 / VibeCoding 上课）
export function LearnEntry({ onSelectCanvas, onSelectVibeCoding, role = 'STUDENT' }) {
  return <>
    <PageHeader eyebrow="学习上课" title="选择今天的上课方式" description={`${role === 'TEACHER' ? '老师也通过这里进入课堂。' : '点击下方入口进入今天的创作。'} 只有老师开启课堂后，对应的课程包才会点亮。`} />
    <div className="card-list learn-entry-grid">
      <article className="item-card learn-entry-canvas">
        <div className="row-actions"><h3>🎨 画布上课</h3><span className="status success">已上线</span></div>
        <p>在画布里把创意变成可发布的小作品。</p>
        <ul className="muted">
          <li>课程包卡片 + 课时卡片</li>
          <li>老师开启哪一节，哪一节亮</li>
          <li>自动创建项目，作品可保存版本</li>
        </ul>
        <button className="primary-button" onClick={onSelectCanvas}>进入画布上课</button>
      </article>
      <article className="item-card learn-entry-vibecoding">
        <div className="row-actions"><h3>💻 VibeCoding 上课</h3><span className="status success">已上线</span></div>
        <p>用中文对话写代码、跑程序、做应用。</p>
        <ul className="muted">
          <li>和 AI 多轮对话，边聊边写代码</li>
          <li>右侧代码面板与实时预览</li>
          <li>老师开启课堂后，对应课时才亮</li>
        </ul>
        <button className="primary-button" onClick={onSelectVibeCoding}>进入 VibeCoding 上课</button>
      </article>
    </div>
  </>;
}
