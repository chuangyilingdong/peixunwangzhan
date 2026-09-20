// 005-04 添加学生（2026-09-17 按线框图从「详情页往下滚的一段」改成独立页）。
//
// 页面上「当前课包授权 / 当前课程状态 / 当前课堂占用 / 加入后课程状态」四列不是四份独立数据：
// 服务端的候选规则本来就决定了 —— 只有「账号正常 + 有本课包许可 + 没有被别的课堂占用 +
// 这节课没完课」的学生才会进「可添加」名单，所以进了这张表的人，后三列必然是
// 未开课 / 无 / 待上课。这里照实算出来，规则哪天变了这几列会跟着变，不写死文案。
import { useMemo, useState } from 'react';
import { Empty, ErrorState, Loading, Notice, PageHeader, Panel, useData } from '@platform/shared';
import { ParentLine } from './ui.jsx';
import { SESSION_STATE, StateBadge } from './states.jsx';

// 线框图的 A / B / C 三类「不可添加」原因，映射到服务端真实的原因码。
// 顺序有意义：原因优先级 A > B（服务端按这个顺序短路，一条学生只会落在第一个命中的原因上）。
const BLOCK_GROUPS = [
  { key: 'A', title: '已完成当前课堂对应课程', reasons: ['COMPLETED'], hint: '优先命中：同一节课上过一次就不再进候选池，可以上这个课包的其他课时。' },
  { key: 'B', title: '当前处于任意课堂的待上课 / 上课中', reasons: ['IN_OTHER_SESSION'], hint: '会被其他课堂占用，必须先结束或移除那一边。' },
  { key: 'C', title: '不进入候选池', reasons: ['STUDENT_DISABLED', 'STUDENT_EXPIRED', 'NO_GRANT'], hint: '账号停用 / 到期，或没有这个课包的有效许可。' },
];
const groupOf = (reason) => BLOCK_GROUPS.find((group) => group.reasons.includes(reason)) || BLOCK_GROUPS[2];

export function AddClassroomStudents({ api, openId, onBack }) {
  const detail = useData(() => openId ? api.get('org/sessions/' + encodeURIComponent(openId)) : Promise.resolve(null), [api, openId]);
  const current = !detail.loading && !detail.error && detail.data?.id === openId ? detail.data : null;
  const permissions = current?.permissions || {};
  const canAdd = permissions.canAddStudents === true && ['PENDING', 'ACTIVE'].includes(current?.status);

  const candidates = useData(() => canAdd ? api.get(`org/sessions/${encodeURIComponent(openId)}/candidates`) : Promise.resolve(null), [api, openId, canAdd, current?.lessonId]);
  const ready = canAdd && !candidates.loading && !candidates.error && candidates.data?.sessionId === openId && candidates.data?.lessonId === current?.lessonId;
  const selectable = ready ? candidates.data.selectable || [] : [];
  const blocked = ready ? candidates.data.blocked || [] : [];

  const [draftKeyword, setDraftKeyword] = useState('');
  const [keyword, setKeyword] = useState('');
  const [tab, setTab] = useState('selectable');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const matches = (item) => `${item.name || ''} ${item.login || ''}`.toLowerCase().includes(keyword.trim().toLowerCase());
  // 「不可添加」默认**不铺开**：一个机构可能有上百个不可加学生，全列出来既没用又没法查
  // （2026-09-16 用户口径）。只有搜索命中的才连原因一起显示 —— 搜一个人，看他为什么进不来。
  const visibleSelectable = keyword ? selectable.filter(matches) : selectable;
  const visibleBlocked = keyword ? blocked.filter(matches) : [];
  const blockedGroups = useMemo(() => BLOCK_GROUPS.map((group) => ({
    ...group, count: blocked.filter((item) => groupOf(item.reason).key === group.key).length,
  })), [blocked]);

  function submitSearch(event) {
    event.preventDefault();
    setKeyword(draftKeyword);
    if (tab === 'selectable' && draftKeyword) setTab('selectable');
  }
  function toggle(id) {
    setPicked((old) => old.includes(id) ? old.filter((value) => value !== id) : [...old, id]);
  }

  async function addStudents() {
    if (!picked.length) return;
    if (picked.some((id) => !selectable.some((item) => item.id === id))) { setError('候选名单已变化，请刷新并重新勾选学生。'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.post(`org/sessions/${encodeURIComponent(openId)}/students`, { studentIds: picked });
      const skipped = result?.skipped?.length || 0;
      setMessage(`已加入 ${result?.added?.length || 0} 名学生。${skipped ? `跳过 ${skipped} 人，候选状态已变化。` : ''}`);
      setPicked([]);
      setKeyword('');
      setDraftKeyword('');
      await detail.refresh();
      await candidates.refresh();
    } catch (err) {
      setError(err.message || '添加失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return <div className="classrooms-page">
    <PageHeader eyebrow="开课与上课" title="添加学生"
      actions={<button className="secondary-button" disabled={busy} onClick={onBack}>← 返回课堂详情</button>} />
    <ParentLine items={['课堂详情']} />

    {detail.loading ? <Loading label="正在读取课堂…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : current ? <>
      <div className="classroom-add-head">
        <div className="classroom-add-head-main">
          <strong>{current.title || '未命名课堂'}</strong>
          <StateBadge value={current.status} />
          <span className="muted">课包：{current.seriesTitle || '—'}</span>
          <span className="muted">课程：{current.lessonTitle || '—'}</span>
          <span className="muted">当前学生 {current.studentSummary?.total ?? 0} 人</span>
        </div>
      </div>

      {!canAdd ? <Notice tone="warning">
        当前课堂状态为「{SESSION_STATE[current.status]?.label || current.status}」，不能再添加学生。
        <div className="muted">只有待上课与上课中的课堂可以添加学生；已结束或已解散的课堂名单固定。</div>
      </Notice> : <>
        {message ? <div role="status"><Notice tone="success">{message}</Notice></div> : null}
        {error ? <div role="alert"><Notice tone="danger">{error}</Notice></div> : null}

        <Panel title="筛选学生">
          <form className="classroom-add-filter" onSubmit={submitSearch}>
            <input value={draftKeyword} placeholder="学生姓名 / 登录账号" aria-label="搜索学生姓名或登录账号"
              onChange={(event) => setDraftKeyword(event.target.value)} />
            <button className="primary-button" disabled={busy}>查询</button>
            <nav className="tabs classroom-add-tabs" aria-label="候选名单分组">
              <button type="button" className={'tab' + (tab === 'selectable' ? ' is-active' : '')} onClick={() => setTab('selectable')}>
                可添加学生 {selectable.length}
              </button>
              <button type="button" className={'tab' + (tab === 'blocked' ? ' is-active' : '')} onClick={() => setTab('blocked')}>
                不可添加学生 {blocked.length}
              </button>
            </nav>
          </form>
        </Panel>

        {candidates.loading ? <Loading label="正在读取候选学生…" /> : candidates.error ? <ErrorState error={candidates.error} onRetry={candidates.refresh} /> : tab === 'selectable' ? (
          <Panel title="可添加学生" actions={<>
            <span className="muted">已选择 {picked.length} 人</span>
            <button className="primary-button" disabled={busy || !ready || !picked.length} onClick={addStudents}>
              {busy ? '添加中…' : '添加到课堂'}
            </button>
          </>}>
            <p className="muted">仅显示当前可加入本课堂的学生。</p>
            {visibleSelectable.length ? <>
              <div className="table-wrap"><table>
                <thead><tr>
                  <th className="classroom-check-col">
                    <input type="checkbox" aria-label="全选当前结果" disabled={busy}
                      checked={visibleSelectable.length > 0 && visibleSelectable.every((item) => picked.includes(item.id))}
                      onChange={(event) => setPicked(event.target.checked
                        ? [...new Set([...picked, ...visibleSelectable.map((item) => item.id)])]
                        : picked.filter((id) => !visibleSelectable.some((item) => item.id === id)))} />
                  </th>
                  <th>学生</th><th>登录账号</th><th>当前课包授权</th><th>当前课程状态</th>
                  <th>当前课堂占用</th><th>加入后课程状态</th><th>备注</th>
                </tr></thead>
                <tbody>{visibleSelectable.map((student) => <tr key={student.id}>
                  <td><input type="checkbox" aria-label={`选择 ${student.name || student.login}`} disabled={busy}
                    checked={picked.includes(student.id)} onChange={() => toggle(student.id)} /></td>
                  <td><strong>{student.name || student.login}</strong></td>
                  <td className="muted">{student.login}</td>
                  <td><span className="status success">已许可</span></td>
                  <td>未开课</td>
                  <td>无</td>
                  <td><span className="status warning">待上课</span></td>
                  <td className="muted">可添加</td>
                </tr>)}</tbody>
              </table></div>
              <div className="top-gap"><Notice tone="success">
                <strong>添加成功后的结果：</strong>所选学生加入后，当前课程状态由「未开课」变为「待上课」；课堂学生数同步增加。
                <div className="muted">不会重复消耗课包人次，不改变原有课包授权状态，不会创建学习结果或算力消耗。</div>
              </Notice></div>
            </> : <Empty title={keyword ? '没有匹配的可添加学生' : '暂无可添加学生'}
              body={keyword ? '换一个姓名或登录账号再查。' : '请检查这些学生的账号状态、课包许可与课堂占用。'} />}
          </Panel>
        ) : (
          <Panel title="不可添加学生">
            {keyword ? (visibleBlocked.length ? <div className="table-wrap"><table>
              <thead><tr>
                <th>学生</th><th>登录账号</th><th>判定</th><th>原因</th><th>占用课堂</th>
              </tr></thead>
              <tbody>{visibleBlocked.map((student) => <tr key={student.id}>
                <td><strong>{student.name || student.login}</strong></td>
                <td className="muted">{student.login}</td>
                <td><span className="status warning">{groupOf(student.reason).key}</span></td>
                <td>{student.reasonText || '不可加入'}</td>
                <td>{student.session?.title
                  ? <>{student.session.title}<div className="muted">{SESSION_STATE[student.session.status]?.label || student.session.status} · {student.session.teacherName || '未知老师'}</div></>
                  : <span className="muted">—</span>}</td>
              </tr>)}</tbody>
            </table></div> : <Empty title="搜到的学生不在不可添加名单里" body="他要么可以添加，要么本来就没进候选池。" />)
              : <Notice tone="warning">
                <strong>本机构共有 {blocked.length} 人暂时不可添加。</strong>
                <div className="muted">人数较多时整列铺开既没用又没法查，所以这里不列出姓名。在上面搜姓名或登录账号，就会显示具体是谁、因为什么进不来。</div>
              </Notice>}
          </Panel>
        )}

        {ready ? <Panel title="不可添加判定说明">
          <div className="classroom-block-groups">
            {blockedGroups.map((group) => <article className="item-card" key={group.key}>
              <div className="row-actions">
                <span className="status warning">{group.key}</span>
                <strong>{group.title}</strong>
                <span className="muted">{group.count} 人</span>
              </div>
              <p className="muted">{group.hint}</p>
            </article>)}
          </div>
        </Panel> : null}
      </>}
    </> : null}
  </div>;
}
