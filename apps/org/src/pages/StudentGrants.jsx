// 机构端 - 学员许可：把课包的「可用次数」分给学员。
// 规则（用户口径）：每分给一名学员用掉 1 次；同一学员同一课包只能授权一次；
// 机构侧不可撤销（次数已消耗不可逆），误授权要找平台兜底撤销。
//
// 2026-09-16（用户口径）：学员名单会很长（「万一有100个学生呢」），所以这里改成
// **搜索 + 分页**，并且**最新添加的学员排在最前**（服务端 created_at DESC）。
// 跨页选择必须看得见：勾了谁就在下面用名单列出来、还能一键清空 ——
// 否则翻到第二页时「授权给 N 名」里的 N 有一部分是看不见的，很容易授权错人。
import { useMemo, useState } from 'react';
import { Empty, ErrorState, ListResultSummary, Loading, Notice, PageHeader, Pagination, Panel, Status, formatDate, useData } from '@platform/shared';

const PAGE_SIZE = 20;

export function StudentGrants({ api }) {
  const courses = useData(() => api.get('org/course-series?limit=100'), [api]);
  const [studentPage, setStudentPage] = useState(1);
  const [studentSearch, setStudentSearch] = useState('');
  const students = useData(
    () => api.get(`org/users?role=STUDENT&limit=${PAGE_SIZE}&page=${studentPage}${studentSearch.trim() ? `&search=${encodeURIComponent(studentSearch.trim())}` : ''}`),
    [api, studentPage, studentSearch],
  );
  const [seriesId, setSeriesId] = useState('');
  // 选中的学员存**对象**（id + 姓名）：跨页之后要能把「我勾了谁」原样列出来
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const grants = useData(
    () => (seriesId ? api.get(`org/course-grants?seriesId=${encodeURIComponent(seriesId)}`) : Promise.resolve({ items: [] })),
    [api, seriesId],
  );
  const items = courses.data?.items || [];
  const studentItems = students.data?.items || [];
  const pickedIds = new Set(picked.map((item) => item.id));
  // 机构对所有课包的授权次数都从这里拿（列表接口已经带上 quotaTotal/quotaUsed）
  const quotaOf = useMemo(() => {
    const map = new Map();
    for (const series of items) {
      const assignment = (series.assignments || []).find((row) => Number(row.quotaTotal || 0) > 0);
      if (assignment) map.set(series.id, assignment);
    }
    return map;
  }, [items]);
  const quota = seriesId ? quotaOf.get(seriesId) : null;
  const activeStudentIds = new Set((grants.data?.items || []).filter((row) => !row.revokedAt).map((row) => row.studentId));

  function toggle(student, checked) {
    setPicked((current) => (checked
      ? [...current, { id: student.id, name: student.displayName || student.login }]
      : current.filter((item) => item.id !== student.id)));
  }
  // 「全选」只作用于**当前这一页**（与服务端分页一致）：在几百人的名册上做跨页全选是个陷阱
  function selectCurrentPage() {
    const addable = studentItems.filter((student) => !activeStudentIds.has(student.id) && !pickedIds.has(student.id));
    setPicked((current) => [...current, ...addable.map((student) => ({ id: student.id, name: student.displayName || student.login }))]);
  }

  async function submit() {
    if (!seriesId || !picked.length) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.post('org/course-grants', { seriesId, studentIds: picked.map((item) => item.id), source: 'GRANT_PAGE' });
      const left = result.quotaTotal > 0 ? `本课包已用 ${result.quotaUsed} / ${result.quotaTotal} 次` : '本课包不限次数';
      setMessage(`已授权 ${result.granted} 名学员${result.skipped ? `（跳过已授权 ${result.skipped} 名）` : ''}；${left}。`);
      setPicked([]); grants.refresh(); courses.refresh(); students.refresh();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  return <>
    <PageHeader
      eyebrow="学习成果"
      title="学员许可"
      description="把课包的可用次数分给学员：每分给一名学员用掉 1 次；同一学员同一课包只能授权一次。"
      actions={<button className="secondary-button" onClick={() => { courses.refresh(); grants.refresh(); students.refresh(); }}>刷新</button>}
    />
    {message && <Notice tone={message.includes('已授权') ? 'success' : 'danger'}>{message}</Notice>}
    {/* B3：把「账号 / 席位有效期 / 课包许可」三件事的边界写在页面上，省得老师找错地方 */}
    <p className="muted">学员账号在「教师与学生」创建，席位与有效期在「学员开通」，<strong>能不能学某个课包就看这里</strong>。</p>
    <Panel title="分发给学员">
      {courses.loading ? <Loading /> : <>
        <div className="form-grid">
          <label>课包
            <select value={seriesId} onChange={(event) => { setSeriesId(event.target.value); setPicked([]); }}>
              <option value="">选择课包</option>
              {items.map((series) => <option key={series.id} value={series.id}>{series.title}{quotaOf.get(series.id) ? `（剩 ${Math.max(0, Number(quotaOf.get(series.id).quotaTotal || 0) - Number(quotaOf.get(series.id).quotaUsed || 0))} 次）` : ''}</option>)}
            </select>
          </label>
          <label>可用次数
            <input readOnly value={!seriesId ? '先选课包' : quota ? `已用 ${quota.quotaUsed} / ${quota.quotaTotal} 次` : '不限次数'} />
          </label>
        </div>
        {!items.length ? <Notice tone="info">当前机构还没有被平台授权的课包，请先在「课程中心」查看，或联系平台授权。</Notice> : null}
        {seriesId ? <>
          <p className="muted top-gap">勾选要授权的学员（已授权的会标记出来，重复勾选不会重复扣次数）：</p>
          <div className="filters">
            <input value={studentSearch} placeholder="搜索姓名 / 登录名 / 手机号" onChange={(event) => { setStudentSearch(event.target.value); setStudentPage(1); }} />
            <button type="button" className="secondary-button" disabled={!studentItems.length} onClick={selectCurrentPage}>全选本页</button>
            <button type="button" className="secondary-button" disabled={!picked.length} onClick={() => setPicked([])}>清空选择</button>
            <span className="muted">已选 <strong>{picked.length}</strong> 名</span>
          </div>
          {students.loading ? <Loading label="正在读取学员…" />
            : students.error ? <ErrorState error={students.error} onRetry={students.refresh} />
              : <>
                <ListResultSummary total={students.data?.total} page={students.data?.page} totalPages={students.data?.totalPages} label="名学员" />
                <div className="card-list">
                  {studentItems.map((student) => {
                    const already = activeStudentIds.has(student.id);
                    return <label key={student.id} className="checkbox-option">
                      <input type="checkbox" disabled={already} checked={already || pickedIds.has(student.id)} onChange={(event) => toggle(student, event.target.checked)} />
                      {student.displayName || student.login}
                      <span className="muted">{student.displayName ? ` · ${student.login}` : ''}{student.phone ? ` · ${student.phone}` : ''}{already ? ' · 已授权' : ''}</span>
                    </label>;
                  })}
                </div>
                <Pagination page={students.data?.page} totalPages={students.data?.totalPages} onChange={setStudentPage} disabled={students.loading} />
                {!studentItems.length ? <Notice tone="info">{studentSearch.trim() ? `没有匹配「${studentSearch.trim()}」的学员。` : '当前机构还没有学员账号，请先在「成员管理」里创建。'}</Notice> : null}
              </>}
          {/* 跨页选择要看得见：把勾了谁原样列出来（翻页之后也不丢） */}
          {picked.length ? <div className="row-actions top-gap">
            <span className="muted">将要授权：</span>
            {picked.map((item) => <span className="tag" key={item.id}>{item.name}</span>)}
          </div> : null}
          <div className="row-actions top-gap">
            <button className="primary-button" disabled={busy || !picked.length} onClick={submit}>{busy ? '授权中…' : `授权给 ${picked.length} 名学员`}</button>
          </div>
          <p className="muted">用掉一次后不可撤销（机构侧没有撤销入口）；如果是误授权，请联系平台兜底撤销。</p>
        </> : null}
      </>}
    </Panel>
    <Panel title={`已授权记录（${grants.data?.items?.length || 0} 条）`}>
      {!seriesId ? <Empty title="先选一个课包" body="选择课包后可以看到这门课的授权记录。" />
        : grants.loading ? <Loading />
          : grants.error ? <ErrorState error={grants.error} onRetry={grants.refresh} />
            : (grants.data?.items || []).length ? <div className="table-wrap"><table>
              <thead><tr><th>学员</th><th>课包</th><th>授权时间</th><th>状态</th></tr></thead>
              <tbody>{grants.data.items.map((item) => <tr key={item.id}>
                <td><strong>{item.studentName || item.studentLogin}</strong></td>
                <td>{item.seriesTitle}</td>
                <td>{formatDate(item.grantedAt)}</td>
                <td>{item.revokedAt ? <><span className="status warning">已撤销</span>{item.revokeReason ? <div className="muted">{item.revokeReason}</div> : null}</> : <Status value="ACTIVE" />}</td>
              </tr>)}</tbody>
            </table></div> : <Empty title="还没有授权记录" body="选择课包与学员后点击授权，记录会显示在这里。" />}
    </Panel>
  </>;
}
