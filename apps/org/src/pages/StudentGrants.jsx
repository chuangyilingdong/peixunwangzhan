// 机构端 - 学员许可：把课包的「可用次数」分给学员。
// 规则（用户口径）：每分给一名学员用掉 1 次；同一学员同一课包只能授权一次；
// 机构侧不可撤销（次数已消耗不可逆），误授权要找平台兜底撤销。
//
// 2026-09-16（用户口径）：学员名单会很长（「万一有100个学生呢」），所以这里改成
// **搜索 + 分页**，并且**最新添加的学员排在最前**（服务端 created_at DESC）。
// 跨页选择必须看得见：勾了谁就在下面用名单列出来、还能一键清空 ——
// 否则翻到第二页时「授权给 N 名」里的 N 有一部分是看不见的，很容易授权错人。
//
// 2026-09-18（用户反馈：「勾选要授权的学员布局和逻辑很不舒服」）重做这一块。
//
// **布局**：原来每个学员是一个 `<label className="checkbox-option">`，但 `checkbox-option`
// 这个类**只在平台端的 admin.css 里定义**（`.admin-console .checkbox-option`），而机构端引的是
// 共享样式表 + 本应用的 theme.css —— 它在这儿等于不存在，于是落到全局
// `label{display:grid;gap:6px;margin:12px 0}` 上：姓名与复选框被拆开、每行还撑到上百像素高
// （截图里复选框飘在名字右边很远处）。现在改成**表格**：复选框独占第一列、紧挨姓名，
// 列对齐、行高一致，一百个人也撑得住。选中行给一层底色。
//
// **逻辑**（原来是"提交失败了才知道不行"）：
//   ① 表头直接写清「本页可授权 N 人 · 已授权 M 人」，不用用户自己数；
//   ② 已授权的行不再给一个"能勾但坏了"的复选框，而是明确标「已授权」并停用；
//   ③ **按剩余人次封顶**：「全选本页」最多选到剩余人次，并在页面上说明；
//   ④ 提交前就把账算给用户看（本次用掉 N 次 / 授权后剩 Z-N 次），超了就禁用按钮并说明原因
//      —— 原来要等服务端 409 顶回来，提示还是「可用次数不足：授权 2 次，已用 2 次，本次需要 3 次」
//      这种要自己算的话；
//   ⑤ 课包次数为 0 时直接说明「平台还没给本机构分配人次」，而不是让人勾完再失败。
import { useMemo, useState } from 'react';
import { Empty, ErrorState, ListResultSummary, Loading, Notice, PageHeader, Pagination, Panel, formatDate, useData, errorText } from '@platform/shared';

const PAGE_SIZE = 20;
const toPicked = (student) => ({ id: student.id, name: student.displayName || student.login });

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
  const [hint, setHint] = useState('');
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
      const assignment = (series.assignments || []).find((row) => Number(row.quotaTotal || 0) > 0)
        || (series.assignments || []).find((row) => row.quotaTotal !== undefined);
      if (assignment) map.set(series.id, assignment);
    }
    return map;
  }, [items]);
  const quota = seriesId ? quotaOf.get(seriesId) : null;
  const quotaTotal = quota ? Number(quota.quotaTotal || 0) : 0;
  // quotaTotal = 0 在服务端是**拒绝授权**的（`quotaTotal <= 0` 直接 409），所以这里不能当成「不限次数」
  const noQuota = Boolean(seriesId) && (!quota || quotaTotal <= 0);
  // remaining = null 表示「拿不到次数口径」，此时不做封顶（交服务端兜底）
  const remaining = noQuota || !quota ? null : Math.max(0, quotaTotal - Number(quota.quotaUsed || 0));
  const overLimit = remaining !== null && picked.length > remaining;
  const activeStudentIds = new Set((grants.data?.items || []).filter((row) => !row.revokedAt).map((row) => row.studentId));
  // 体验课包（2026-09-24 用户口径）：**可以重复分给同一个学生**、未使用的次数**预先累积** ——
  // 所以「已授权」不再等于"不能再选"，改看这名学生手上还剩几次。
  const selectedSeries = items.find((series) => series.id === seriesId) || null;
  const isExperience = selectedSeries?.seriesType === 'EXPERIENCE';
  const remainingByStudent = new Map((grants.data?.items || [])
    .filter((row) => !row.revokedAt)
    .map((row) => [row.studentId, Number(row.remainingUnits ?? 1)]));

  // 普通课包：已授权的学生不能重复选；体验课包：人人都能再分一次（次数会累加）
  const addableOnPage = isExperience
    ? studentItems
    : studentItems.filter((student) => !activeStudentIds.has(student.id));
  const alreadyOnPage = studentItems.length - addableOnPage.length;

  function toggle(student, checked) {
    setHint('');
    setPicked((current) => (checked
      ? [...current, toPicked(student)]
      : current.filter((item) => item.id !== student.id)));
  }
  // 「全选」只作用于**当前这一页**（与服务端分页一致）：在几百人的名册上做跨页全选是个陷阱。
  // 而且最多只选到剩余人次 —— 让用户在点之前就看到结果，而不是提交后被顶回来。
  function selectCurrentPage() {
    const addable = addableOnPage.filter((student) => !pickedIds.has(student.id));
    if (!addable.length) return;
    if (remaining !== null) {
      const room = Math.max(0, remaining - picked.length);
      if (addable.length > room) {
        setPicked((current) => [...current, ...addable.slice(0, room).map(toPicked)]);
        setHint(room
          ? `这一页还能选的人比剩余人次多：已按上限只选了 ${room} 人（剩余 ${remaining} 次）。要授权更多请先让平台增购次数。`
          : `本课包剩余 ${remaining} 次已经用完，无法再选。要授权更多请先让平台增购次数。`);
        return;
      }
    }
    setPicked((current) => [...current, ...addable.map(toPicked)]);
  }

  async function submit() {
    if (!seriesId || !picked.length || overLimit) return;
    setBusy(true); setMessage(''); setHint('');
    try {
      const result = await api.post('org/course-grants', { seriesId, studentIds: picked.map((item) => item.id), source: 'GRANT_PAGE' });
      const left = result.quotaTotal > 0 ? `本课包已用 ${result.quotaUsed} / ${result.quotaTotal} 次` : '本课包不限次数';
      setMessage(`已授权 ${result.granted} 名学员${result.skipped ? `（跳过已授权 ${result.skipped} 名）` : ''}；${left}。`);
      setPicked([]); grants.refresh(); courses.refresh(); students.refresh();
    } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); }
  }

  return <>
    <PageHeader
      eyebrow="学习成果"
      title="学员许可"
      description={isExperience
        ? '体验课包：每分给一名学员用掉 1 次；同一个学员可以重复分配、次数会累积；每场课堂正常结束且有有效 AI 产出才核销 1 次。'
        : '把课包的可用次数分给学员：每分给一名学员用掉 1 次；同一学员同一课包只能授权一次。'}
      actions={<button className="secondary-button" onClick={() => { courses.refresh(); grants.refresh(); students.refresh(); }}>刷新</button>}
    />
    {message && <Notice tone="success">{message}</Notice>}
    {/* B3：把「账号 / 席位有效期 / 课包许可」三件事的边界写在页面上，省得老师找错地方 */}
    <p className="muted">学员账号在「教师与学生」创建，席位与有效期在「学员开通」，<strong>能不能学某个课包就看这里</strong>。</p>

    <Panel title="① 选课包">
      {courses.loading ? <Loading /> : <>
        <div className="form-grid">
          <label>课包
            <select value={seriesId} onChange={(event) => { setSeriesId(event.target.value); setPicked([]); setHint(''); }}>
              <option value="">选择课包</option>
              {items.map((series) => {
                const assignment = quotaOf.get(series.id);
                const left = assignment && Number(assignment.quotaTotal || 0) > 0
                  ? `剩 ${Math.max(0, Number(assignment.quotaTotal) - Number(assignment.quotaUsed || 0))} 次` : '无可用次数';
                return <option key={series.id} value={series.id}>{series.title}（{left}）</option>;
              })}
            </select>
          </label>
          <label>可用次数
            <input readOnly value={!seriesId ? '先选课包' : noQuota ? '0 次（不可授权）' : `已用 ${quota.quotaUsed} / ${quotaTotal} 次 · 剩 ${remaining} 次`} />
          </label>
        </div>
        {!items.length ? <Notice tone="info">当前机构还没有被平台授权的课包，请先在「课程中心」查看，或联系平台授权。</Notice> : null}
        {noQuota ? <Notice tone="warning">
          这个课包当前**可授权次数为 0**：平台还没有给本机构分配人次，所以现在不能授权。
        </Notice> : null}
      </>}
    </Panel>

    {seriesId && !noQuota ? <Panel title="② 勾选要授权的学员"
      actions={<span className="muted">本页可授权 <strong>{addableOnPage.length}</strong> 人{alreadyOnPage ? ` · 已授权 ${alreadyOnPage} 人` : ''}</span>}>
      <div className="pick-bar">
        <input value={studentSearch} placeholder="搜索姓名 / 登录名 / 手机号" onChange={(event) => { setStudentSearch(event.target.value); setStudentPage(1); }} />
        <button type="button" className="secondary-button" disabled={!addableOnPage.length} onClick={selectCurrentPage}>全选本页可授权（{addableOnPage.length}）</button>
        <button type="button" className="secondary-button" disabled={!picked.length} onClick={() => { setPicked([]); setHint(''); }}>清空选择</button>
        <span className="muted">已选 <strong>{picked.length}</strong> 人</span>
      </div>
      {hint ? <Notice tone="info">{hint}</Notice> : null}
      {students.loading ? <Loading label="正在读取学员…" />
        : students.error ? <ErrorState error={students.error} onRetry={students.refresh} />
          : <>
            <ListResultSummary total={students.data?.total} page={students.data?.page} totalPages={students.data?.totalPages} label="名学员" />
            {studentItems.length ? <div className="table-wrap"><table>
              <thead><tr><th style={{ width: 40 }}>选</th><th>学员</th><th>登录账号</th><th>手机号</th><th>授权情况</th></tr></thead>
              <tbody>{studentItems.map((student) => {
                const already = activeStudentIds.has(student.id);
                const pickedNow = pickedIds.has(student.id);
                const heldUnits = remainingByStudent.get(student.id) || 0;
                // 体验课包：已授权的也**能再选**（重复分配 = 次数累加），所以勾选框不禁用
                const blocked = already && !isExperience;
                return <tr key={student.id} className={'student-pick-row' + (!blocked && pickedNow ? ' is-picked' : '')}>
                  <td>{blocked
                    ? <input type="checkbox" checked disabled aria-label="已授权，不能重复选择" />
                    : <input type="checkbox" checked={pickedNow} aria-label={`选择 ${student.displayName || student.login}`} onChange={(event) => toggle(student, event.target.checked)} />}</td>
                  <td><strong>{student.displayName || student.login}</strong></td>
                  <td className="muted">{student.login}</td>
                  <td className="muted">{student.phone || '—'}</td>
                  <td>{already
                    ? (isExperience
                      ? <span className="status success">可用 {heldUnits} 次</span>
                      : <span className="status success">已授权</span>)
                    : <span className="muted">{isExperience ? '还没有体验次数' : '可授权'}</span>}</td>
                </tr>;
              })}</tbody>
            </table></div> : <Empty title="没有学员" body={studentSearch.trim() ? `没有匹配「${studentSearch.trim()}」的学员。` : '当前机构还没有学员账号，请先在「成员管理」里创建。'} />}
            <Pagination page={students.data?.page} totalPages={students.data?.totalPages} onChange={setStudentPage} disabled={students.loading} />
          </>}
    </Panel> : null}

    {seriesId && !noQuota ? <Panel title={`③ 本次授权（已选 ${picked.length} 人）`}>
      <div className="row-actions">
        <span className="muted">本次将用掉 <strong>{picked.length}</strong> 次</span>
        <span className="muted">·</span>
        <span className={overLimit ? 'status danger' : 'muted'}>
          {overLimit ? `剩余人次不足：本课包只剩 ${remaining} 次，选多了 ${picked.length - remaining} 人` : `授权后本课包剩 ${remaining === null ? '—' : Math.max(0, remaining - picked.length)} 次`}
        </span>
      </div>
      {/* 跨页选择要看得见：把勾了谁原样列出来（翻页之后也不丢） */}
      {picked.length ? <div className="row-actions top-gap">
        <span className="muted">将要授权：</span>
        {picked.map((item) => <span className="pick-tag" key={item.id}>{item.name}</span>)}
      </div> : <p className="muted top-gap">还没有选择学员。上面的名单里勾选即可{isExperience ? '（体验课包可以重复分给同一个学员，次数会累加）' : '（已授权的学员不能重复选）'}。</p>}
      <div className="row-actions top-gap">
        <button className="primary-button" disabled={busy || !picked.length || overLimit} onClick={submit}>{busy ? '授权中…' : `授权给 ${picked.length} 名学员`}</button>
        {overLimit ? <span className="muted">先去掉几个人，或让平台增购次数。</span> : null}
      </div>
      <p className="muted">用掉一次后不可撤销（机构侧没有撤销入口）；如果是误授权，请联系平台兜底撤销。{isExperience ? ' 体验课包的次数没被核销掉的（课堂没有有效产出、或课堂被解散），平台撤销时按未消费余额退回。' : ''}</p>
    </Panel> : null}

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
                <td>{item.revokedAt
                  ? <><span className="status warning">已撤销</span>{item.revokeReason ? <div className="muted">{item.revokeReason}</div> : null}</>
                  : <span className="status success">已授权</span>}</td>
              </tr>)}</tbody>
            </table></div> : <Empty title="还没有授权记录" body="选择课包与学员后点击授权，记录会显示在这里。" />}
    </Panel>
  </>;
}
