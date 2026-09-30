// 老师端「画布备课」—— **就是学生的画布课堂那一套全屏界面**（2026-09-30 用户口径）。
//
// 用户原话：「老师端可以自由无限制进入对应的课时课堂，画布/VibeCoding，他们可以走流程，
//   但是无法生成。VibeCoding的发送按钮隐藏，画布课堂生成按钮隐藏。」
// 后来又明确一次：「为什么是在这里显示啊，**我是说可以直接进入到画布课堂啊**」——
// 所以这一页**不再长在机构后台里**：机构端「画布备课」按钮新标签打开 `/learn/prep/<课时 id>`，
// 落到的就是与 `/learn/canvas`（学生画布课堂）同一个全屏画布组件、同一套框体语言。
//
// 与学生的差别只有两处（正是口径要的）：
//   · **不生成**：不传 `onGenerateNode` —— 画布自己就不渲染生成按钮（canGenerate=false）；
//   · **不落库**：没有项目、没有作品、没有 generation_jobs，草稿只写本机 localStorage。
// 数据来自机构端那条只读接口 `GET /api/org/lessons/<id>/prep?mode=CANVAS`
// （课时模板画布 + 这节课配的生成框体；准入 = 课时已发布 + 课包仍授权给本机构）。
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { boxParamsLabel, buildBoxNode, BrandLogo, ErrorState, Loading, materialVisual, Notice } from '@platform/shared';

const EMPTY_SNAPSHOT = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };

/** 备课草稿的存档键：按课时存，互不干扰。 */
export const prepDraftKey = (lessonId) => `lesson-prep-canvas:${lessonId}`;

export function CanvasPrepPage({ api }) {
  const { lessonId } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, error: '', data: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: '', data: null });
    api.get(`org/lessons/${encodeURIComponent(lessonId)}/prep?mode=CANVAS`)
      .then((data) => { if (!cancelled) setState({ loading: false, error: '', data }); })
      .catch((error) => { if (!cancelled) setState({ loading: false, error: error?.message || '打不开这节课的备课画布', data: null }); });
    return () => { cancelled = true; };
  }, [api, lessonId]);

  const boxes = useMemo(() => (Array.isArray(state.data?.generationBoxes) ? state.data.generationBoxes : []), [state.data]);
  const [snapshot, setSnapshot] = useState(null);
  const [message, setMessage] = useState('');
  // ⚠️ 画布组件的 `initialSnapshot` **只在挂载时读一次**（内部 useNodesState 自己管节点）——
  //    从左侧面板加框体/清空时必须靠 key 递增整块重挂，否则"提示说加了、画布上什么都没有"。
  //    学生画布那边是同一套做法（canvasWorkspace.jsx 的 canvasRevision）。
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!state.data || snapshot) return;
    let saved = null;
    try { saved = JSON.parse(window.localStorage.getItem(prepDraftKey(lessonId)) || 'null'); } catch { saved = null; }
    const template = state.data.canvasSnapshot;
    setSnapshot(saved?.nodes?.length ? saved
      : (template && Array.isArray(template.nodes) && template.nodes.length ? template : EMPTY_SNAPSHOT));
  }, [state.data, lessonId, snapshot]);

  const persist = (next) => {
    setSnapshot(next);
    try { window.localStorage.setItem(prepDraftKey(lessonId), JSON.stringify(next)); } catch { /* 存不下就只活在内存里 */ }
  };
  const persistAndRemount = (next) => { persist(next); setRevision((value) => value + 1); };

  const boxOnCanvas = (boxId) => Boolean((snapshot?.nodes || []).some((node) => node.data?.boxId === boxId));
  const boxModalities = useMemo(() => [...new Set(boxes.map((box) => String(box.modality || '').toUpperCase()).filter(Boolean))], [boxes]);

  function addBox(box) {
    const current = snapshot || EMPTY_SNAPSHOT;
    if (boxOnCanvas(box.id)) { setMessage(`「${box.title}」已经在画布上了。`); return; }
    persistAndRemount({ ...current, nodes: [...(current.nodes || []), buildBoxNode(box, current)] });
    setMessage(`已把「${box.title}」加到画布上。`);
  }
  function resetDraft() {
    const template = state.data?.canvasSnapshot;
    persistAndRemount(template && Array.isArray(template.nodes) && template.nodes.length ? template : EMPTY_SNAPSHOT);
    setMessage('已清空，回到这节课的初始画布。');
  }

  if (state.loading) return <main className="prep-page"><div className="prep-state"><Loading label="正在打开备课画布…" /></div></main>;
  const lesson = state.data?.lesson;
  return <main className="prep-page">
    <header className="prep-top">
      <div className="prep-top__brand"><BrandLogo height={22} /></div>
      <div className="prep-top__who">
        <span className="prep-chip">备课模式 · 不生成</span>
        <strong>{lesson?.title || '画布备课'}</strong>
        {lesson?.seriesTitle ? <span className="muted">{lesson.seriesTitle}</span> : null}
      </div>
      <div className="prep-top__actions">
        <button type="button" className="secondary-button" onClick={resetDraft}>清空重来</button>
        <button type="button" className="secondary-button" onClick={() => navigate('/org/courses')}>返回课程备课</button>
      </div>
    </header>
    <div className="prep-body">
      <aside className="prep-boxes">
        <h3>这节课的生成框体（{boxes.length}）</h3>
        {boxes.length ? boxes.map((box) => {
          // 生成框体是一种素材类型，名字要看**模态**（生图框体 / 生视频框体…）—— 与老师端课包配置同一套映射
          const visual = materialVisual({ materialType: 'GENERATION_BOX', modality: box.modality });
          const on = boxOnCanvas(box.id);
          return <div className="prep-box-row" key={box.id}>
            <span className={`prep-box-visual is-${visual.tone}`} aria-hidden="true">{visual.label.slice(0, 1)}</span>
            <span className="prep-box-text">
              <strong>{box.title}</strong>
              <small>{visual.label} · {boxParamsLabel(box)}</small>
            </span>
            <button className="secondary-button" disabled={on} onClick={() => addBox(box)}>{on ? '已在画布' : '加到画布'}</button>
          </div>;
        }) : <p className="muted">这节课还没有配生成框体。</p>}
        {state.error ? <ErrorState error={state.error} onRetry={() => navigate('/org/courses')} /> : null}
      </aside>
      <div className="prep-canvas">
        {snapshot ? <CanvasEditor
          key={`${lessonId}-${revision}`}
          initialSnapshot={snapshot}
          onChange={persist}
          showStarter={false}
          allowNodeCreation={false}
          boxModalities={boxModalities}
          capabilities={lesson?.capabilities || ['text']}
        /> : null}
      </div>
    </div>
    <div className="prep-hint">
      <Notice tone="info">
        这是学生的画布课堂（同一套界面）：随便拖、随便连、随便写提示词 —— 但备课模式下不会真的生成，
        也不会存进任何学生的作品里（草稿只留在这台电脑上）。想让学生在课堂上看到的，就是这块画布加这节课配的框体。
      </Notice>
      {message ? <Notice>{message}</Notice> : null}
    </div>
  </main>;
}
