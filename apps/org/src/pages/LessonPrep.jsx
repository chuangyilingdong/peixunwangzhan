// 机构端「画布备课」（2026-09-30 用户口径）。
//
// 用户原话：「老师端可以自由无限制进入对应的课时课堂，画布/VibeCoding，他们可以走流程，
//   但是无法生成。VibeCoding的发送按钮隐藏，画布课堂生成按钮隐藏。」
//
// 这一页做**画布**那一半：
//   · 摆出学生进来时那张画布（课时模板）+ 这节课配的生成框体清单（点一下加到画布上）；
//   · 老师可以随便拖、连线、写提示词、调参数 —— 与学生在画布课堂里**同一套组件**；
//   · ⚠️ **生成按钮不会出现**：这里**不传 `onGenerateNode`**，画布的 `canGenerate` 就是 false，
//     它自己就不渲染那个按钮（见 packages/canvas/src/index.jsx 的 canGenerate 一行）。
//   · ⚠️ **什么都不落库**：没有项目、没有作品、没有 generation_jobs —— 草稿只写本机 localStorage，
//     换台电脑/清了缓存就没了（备课本来就是临时的，也不该在学生名下留东西）。
//
// VibeCoding 那一半在**客户端**里（学生的创作环境在客户端）——按钮走 `lingdong://open?prep=1&lesson=…`，
// 客户端拿 `client-context?prep=1&lessonId=…` 里的 `prep:true` 去隐藏发送按钮；平台侧**不发网关密钥**兜底。
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { boxParamsLabel, buildBoxNode, Empty, ErrorState, Loading, materialVisual, Notice, PageHeader, useData } from '@platform/shared';

const EMPTY_SNAPSHOT = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };

/** 备课草稿的存档键：按课时存，互不干扰。 */
export const prepDraftKey = (lessonId) => `lesson-prep-canvas:${lessonId}`;

export function LessonPrep({ api }) {
  const { lessonId } = useParams();
  const navigate = useNavigate();
  const detail = useData(() => api.get(`org/lessons/${encodeURIComponent(lessonId)}/prep?mode=CANVAS`), [api, lessonId]);
  const boxes = useMemo(() => (Array.isArray(detail.data?.generationBoxes) ? detail.data.generationBoxes : []), [detail.data]);
  const [snapshot, setSnapshot] = useState(null);
  const [message, setMessage] = useState('');

  // 第一次拿到数据时决定起点：**本机草稿优先**（老师上次摆的还在），否则课时模板，再否则空画布。
  useEffect(() => {
    if (!detail.data || snapshot) return;
    let saved = null;
    try { saved = JSON.parse(window.localStorage.getItem(prepDraftKey(lessonId)) || 'null'); } catch { saved = null; }
    const template = detail.data.canvasSnapshot;
    const start = saved?.nodes?.length ? saved
      : (template && Array.isArray(template.nodes) && template.nodes.length ? template : EMPTY_SNAPSHOT);
    setSnapshot(start);
  }, [detail.data, lessonId, snapshot]);

  const persist = (next) => {
    setSnapshot(next);
    try { window.localStorage.setItem(prepDraftKey(lessonId), JSON.stringify(next)); } catch { /* 存不下就只活在内存里 */ }
  };

  const boxOnCanvas = (boxId) => Boolean((snapshot?.nodes || []).some((node) => node.data?.boxId === boxId));
  const boxModalities = useMemo(() => [...new Set(boxes.map((box) => String(box.modality || '').toUpperCase()).filter(Boolean))], [boxes]);

  function addBox(box) {
    const current = snapshot || EMPTY_SNAPSHOT;
    if (boxOnCanvas(box.id)) { setMessage(`「${box.title}」已经在画布上了。`); return; }
    persist({ ...current, nodes: [...(current.nodes || []), buildBoxNode(box, current)] });
    setMessage(`已把「${box.title}」加到画布上。`);
  }

  function resetDraft() {
    const template = detail.data?.canvasSnapshot;
    persist(template && Array.isArray(template.nodes) && template.nodes.length ? template : EMPTY_SNAPSHOT);
    setMessage('已清空，回到这节课的初始画布。');
  }

  if (detail.loading) return <Loading label="正在打开备课画布…" />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.refresh} />;
  const lesson = detail.data?.lesson;
  if (!lesson) return <Empty title="这节课没有画布课堂入口" body="课时的入口类型里没有「画布」，所以没有备课画布。" />;

  return <>
    <PageHeader
      eyebrow={`课程备课 · 画布备课${lesson.seriesTitle ? ' · ' + lesson.seriesTitle : ''}`}
      title={lesson.title}
      description="与学生画布**同一套**界面：框体、连线、提示词、参数都能试；生成按钮在备课模式下不出现。"
      actions={<>
        <button className="secondary-button" onClick={resetDraft}>清空重来</button>
        <button className="secondary-button" onClick={() => navigate('/courses')}>返回课程备课</button>
      </>}
    />
    <Notice tone="info">
      备课模式：随便拖、随便连、随便写 —— **不会真的生成，也不会存进任何学生的作品里**（只在你本机留一份草稿）。
      想让学生看到的，就是右边这块画布加这节课配的框体。
    </Notice>
    {message ? <Notice>{message}</Notice> : null}
    <div className="prep-layout">
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
        }) : <p className="muted">这节课还没有配生成框体（老师可以在「课程备课」里配，或直接在这块画布上试）。</p>}
      </aside>
      <div className="prep-canvas">
        {snapshot ? <CanvasEditor
          // key 跟着课时走：换课时要整块重挂，否则画布内部 state 还停在上一个课时
          key={lessonId}
          initialSnapshot={snapshot}
          onChange={persist}
          showStarter={false}
          allowNodeCreation={false}
          boxModalities={boxModalities}
          capabilities={lesson.capabilities || ['text']}
        /> : <Loading label="正在准备画布…" />}
      </div>
    </div>
  </>;
}
