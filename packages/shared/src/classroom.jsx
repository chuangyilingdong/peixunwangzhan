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
  if (classroom.loading) return <Loading label="正在读取今日课堂…" />;
  if (classroom.error) return <ErrorState error={classroom.error} onRetry={classroom.refresh} />;
  const courses = classroom.data?.classroomCourses || [];
  async function enter(lesson) {
    if (lesson.deliveryMode === 'VIBECODING') { setMessage('VibeCoding 课堂尚未接入，暂不能进入。'); return; }
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
  return <>
    <PageHeader eyebrow="画布上课" title="今日课堂" description="所有课程包和课时都在这里，老师开启哪一节，就进入哪一节画布。" actions={<button className="secondary-button" onClick={classroom.refresh}>刷新课堂</button>} />
    {message && <Notice tone="danger">{message}</Notice>}
    <Panel title="课程包">
      {courses.length ? (
        <div className="card-list">
          {courses.map((course) => (
            <article className="item-card" key={course.id}>
              <div className="row-actions">
                <h3>{course.title}</h3>
                <span className={course.canStart ? 'status success' : 'status warning'}>{course.canStart ? '已开课' : '等待老师配置'}</span>
              </div>
              <p className="muted">{course.description || '课程包内的课时会在老师开启后进入画布课堂。'}</p>
              <div className="card-list">
                {course.lessons.map((lesson) => {
                  const isVibeCoding = lesson.deliveryMode === 'VIBECODING';
                  const buttonDisabled = !lesson.canStart || isVibeCoding || busy === lesson.id;
                  return (
                    <article className="item-card" key={lesson.id}>
                      <div className="row-actions">
                        <h3>第 {lesson.sort} 节 · {lesson.title}</h3>
                        {isVibeCoding ? <span className="status warning">尚未接入</span>
                          : lesson.canStart ? <span className="status success">已开课</span>
                          : <span className="status warning">等待老师开课</span>}
                      </div>
                      <p>{lesson.className || '未配置班级'} · {lesson.teacherName || '待分配老师'}</p>
                      <p className="muted">
                        {lesson.blockReason || (lesson.canStart ? '画布课堂已开始，现在可以进入创作。' : '等待老师开始上课。')}
                        {lesson.projectCount ? ` · 已有 ${lesson.projectCount} 个项目` : ''}
                        {lesson.workCount ? ` · 已提交 ${lesson.workCount} 次` : ''}
                      </p>
                      <button
                        className={lesson.canStart && !isVibeCoding ? 'primary-button' : 'secondary-button'}
                        disabled={buttonDisabled}
                        onClick={() => enter(lesson)}>
                        {busy === lesson.id ? '正在进入…'
                          : isVibeCoding ? 'VibeCoding 尚未接入'
                          : lesson.canStart ? '进入画布课堂'
                          : '等待老师开课'}
                      </button>
                    </article>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty title="暂无可用课程包" body="平台发布课程包后，这里会显示全部课程和课时。" />
      )}
    </Panel>
  </>;
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
        <div className="row-actions"><h3>💻 VibeCoding 上课</h3><span className="status warning">即将上线</span></div>
        <p>用中文对话写代码、跑程序、做应用。</p>
        <ul className="muted">
          <li>同样按课程包 + 课时结构组织</li>
          <li>老师开启课堂后，对应课时才亮</li>
          <li>运行时正在准备中，敬请期待</li>
        </ul>
        <button className="secondary-button" disabled title="VibeCoding 课堂尚未接入">即将开放</button>
      </article>
    </div>
  </>;
}
