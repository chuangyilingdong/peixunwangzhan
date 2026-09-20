// 005-02 创建课堂（2026-09-17 按线框图从「弹窗」改成独立页）。
//
// 线框图把这件事拆成两栏：左边只填三件必填事（名称 / 课包 / 课程），
// 右边同时给出「所选课程摘要」和「创建规则」，底部一条保存提示 + 保存后的业务链。
// 学生、上课时间、预约、评价这些都不在本页 —— 也就是线框图里那个「本页不包含」。
import { useState } from 'react';
import { Empty, ErrorState, Loading, Notice, PageHeader, Panel, SearchSelect, useData } from '@platform/shared';
import { DefinitionGrid, FlowSteps, ParentLine } from './ui.jsx';
import { deliveryModeLabels, publishedModes } from './states.jsx';

const emptyForm = { seriesId: '', lessonId: '', title: '', teacherId: '' };

export function CreateClassroom({ api, isAdmin, onCancel, onCreated, parentLabel }) {
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const series = useData(() => api.get('org/course-series?limit=200'), [api]);
  const teachers = useData(() => isAdmin ? api.get('org/users?role=TEACHER') : Promise.resolve({ items: [] }), [api, isAdmin]);
  // 能不能建课要看真实占用，不能写死文案：一个老师同时只能有一个未终态课堂
  // （服务端 assertTeacherSessionAvailable），不先查清楚就会出现「页面说可以、一保存报错」。
  const gate = useData(() => api.get('org/sessions?days=365&limit=1'), [api]);
  const blocking = isAdmin ? 0 : Number(gate.data?.statusCounts?.PENDING || 0) + Number(gate.data?.statusCounts?.ACTIVE || 0);
  const blocked = blocking > 0;
  const seriesItems = series.data?.items || [];
  const selectedSeries = seriesItems.find((item) => item.id === form.seriesId) || null;
  const lessonOptions = (selectedSeries?.lessons || []).filter((item) => item.status === 'PUBLISHED');
  const selectedLesson = lessonOptions.find((item) => item.id === form.lessonId) || null;
  const titleLength = form.title.trim().length;

  async function submit(event) {
    event.preventDefault();
    if (!selectedLesson) { setError('请选择有效的已发布课程。'); return; }
    setBusy(true); setError('');
    try {
      const created = await api.post('org/sessions', {
        lessonId: form.lessonId,
        title: form.title.trim() || undefined,
        deliveryMode: publishedModes(selectedLesson)[0] || selectedLesson.deliveryMode || 'CANVAS',
        ...(isAdmin && form.teacherId ? { teacherId: form.teacherId } : {}),
      });
      onCreated(created?.id || '');
    } catch (err) {
      setError(err.message || '创建课堂失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return <div className="classrooms-page">
    <PageHeader eyebrow="开课与上课" title="创建课堂"
      actions={<button className="secondary-button" disabled={busy} onClick={onCancel}>← 返回我的课堂</button>} />
    <ParentLine items={[parentLabel || '我的课堂列表']} />

    <Notice tone={blocked ? 'warning' : 'success'}>
      {blocked
        ? `当前账号已有 ${blocking} 个「待上课 / 上课中」课堂，因此不能创建新的课堂。`
        : '当前账号无「待上课 / 上课中」课堂，可以创建新的课堂。'}
      <div className="muted">{blocked
        ? '结束或解散当前课堂后，再回来创建。'
        : '保存成功后，新课堂状态为「待上课」，学生将在课堂创建后单独添加。'}</div>
    </Notice>
    {error ? <div role="alert"><Notice tone="danger">{error}</Notice></div> : null}

    <div className="classroom-create-grid">
      <div>
        <Panel title="课堂基础信息">
          <p className="muted">第一阶段只建立课堂，不在此页添加学生。</p>
          <form onSubmit={submit}>
            <label>课堂名称 *<input value={form.title} maxLength={50} placeholder="例如：未来城市设计"
              onChange={(event) => setForm({ ...form, title: event.target.value })} />
              <small className="muted">{titleLength}/50，可留空由系统按课程自动生成。</small></label>

            <label>课包 *<SearchSelect ariaLabel="搜索课包" value={form.seriesId} options={seriesItems} placeholder="请选择课包"
              getLabel={(item) => item.title}
              onChange={(seriesId) => setForm({ ...form, seriesId, lessonId: '' })} />
              <small className="muted">只能选择当前机构在「教学课程库」中可用于教学的课包。</small></label>

            <label>课程 *<SearchSelect ariaLabel="搜索课程" value={form.lessonId} options={lessonOptions} placeholder="请选择课程"
              getLabel={(item) => `第 ${item.sort} 节 · ${item.title}`} disabled={!form.seriesId}
              onChange={(lessonId) => setForm({ ...form, lessonId })} />
              <small className="muted">课程候选项由所选课包决定。切换课包时需重新选择课程。</small></label>

            {/* 上课类型由**平台**在课包课时里设定（可同时开画布 + VibeCoding），老师只读不改。 */}
            {selectedLesson && (publishedModes(selectedLesson).length || lessonOptions.length) ? <label>上课类型
              <span className="classroom-mode-readonly">{deliveryModeLabels(selectedLesson).join(' / ') || '—'}</span>
              <small className="muted">
                由平台在课包课时里设定，老师不改；两种都开时学生端两个入口并列。
                {publishedModes(selectedLesson).length > 1 ? ' 本节课已同时开放两种。' : ''}
              </small></label> : null}

            {isAdmin ? <label>负责老师<SearchSelect ariaLabel="搜索负责老师" value={form.teacherId} options={teachers.data?.items || []}
              placeholder="挂在我自己名下" getLabel={(item) => item.displayName || item.login}
              onChange={(teacherId) => setForm({ ...form, teacherId })} />
              <small className="muted">仅负责老师可以管理课堂；机构管理员查看其他老师课堂时为只读。</small></label> : null}

          </form>
        </Panel>
      </div>

      <div>
        <Panel title="所选课程摘要">
          <p className="muted">用于确认本次课堂绑定内容。</p>
          {series.loading ? <Loading label="正在读取课程…" /> : series.error ? <ErrorState error={series.error} onRetry={series.refresh} />
            : selectedLesson ? <>
              <div className="classroom-course-badge" aria-hidden="true">AI</div>
              <DefinitionGrid items={[
                { label: '课程', value: selectedLesson.title },
                { label: '所属课包', value: selectedSeries?.title || '—' },
                { label: '当前教学版本', value: selectedSeries?.version ? `v${selectedSeries.version}` : '—' },
                { label: '上课类型', value: deliveryModeLabels(selectedLesson).join(' / ') || '—' },
                { label: '课程节次', value: `第 ${selectedLesson.sort} 节` },
              ]} />
            </> : <Empty title="尚未选择课程" body="选择课包与课程后，这里会显示本次课堂绑定的内容摘要。" />}
        </Panel>
      </div>
    </div>

    <Panel title="保存">
      <p className="muted">保存后将创建一个「待上课」课堂，不会自动添加任何学生。</p>
      <div className="row-actions top-gap">
        <button className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
        <button className="primary-button" disabled={busy || blocked || !selectedLesson || series.loading || Boolean(series.error)} onClick={submit}>
          {busy ? '保存中…' : '保存课堂'}
        </button>
      </div>
    </Panel>

    <Panel title="保存后的业务链">
      <FlowSteps steps={[
        { title: '创建成功（状态：待上课）' },
        { title: '进入课堂详情' },
        { title: '添加学生' },
        { title: '满足条件后开始上课' },
      ]} />
    </Panel>
  </div>;
}
