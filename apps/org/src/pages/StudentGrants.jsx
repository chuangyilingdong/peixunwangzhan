// 机构端 - 学生许可：把课包的「可用次数」分给学生。
// 规则（2026-11-10 用户口径，普通课包改成"按课时次数"之后）：
//   · 1 次授权 = 1 个**课时次数**：学生上 1 节课扣 1 次；普通课包可以重复分给同一学生（次数累加）；
//   · 同一个学生同一个普通课包，**上过的课不能重复上**（加学生时拦），没上过的都能上；
//   · 机构可以**回收**学生未使用的次数（普通课包；指定回收几次），退回到机构的总次数里；
//   · 体验课包保持原规则（可重复上同一节课、按有效产出核销、机构不可回收）。
//
// 2026-09-16（用户口径）：学生名单会很长（「万一有100个学生呢」），所以这里改成
// **搜索 + 分页**，并且**最新添加的学生排在最前**（服务端 created_at DESC）。
// 跨页选择必须看得见：勾了谁就在下面用名单列出来、还能一键清空 ——
// 否则翻到第二页时「授权给 N 名」里的 N 有一部分是看不见的，很容易授权错人。
//
// 2026-09-18（用户反馈：「勾选要授权的学生布局和逻辑很不舒服」）重做这一块：改成表格。
// 2026-11-10：普通课包也按次数之后，"已授权"不再等于"不能再选" —— 勾选框全部可用，
// 右侧显示「可用 N 次」；另外加了「回收」与「已上课程」两个面板。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty, ErrorState, ListResultSummary, Loading, Notice, PageHeader, Pagination, Panel, formatDate, useData, errorText } from '@platform/shared';
import { Modal } from './classroom/ui.jsx';

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
  // 选中的学生存**对象**（id + 姓名）：跨页之后要能把「我勾了谁」原样列出来
  const [picked, setPicked] = useState([]);
  const [units, setUnits] = useState(1); // 每人授权次数（两种课包都按次数；切课包/改选人时会被夹回上限）
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [hint, setHint] = useState('');
  const [reclaimTarget, setReclaimTarget] = useState(null); // 回收弹窗（普通课包的某条许可）
  const [usageTarget, setUsageTarget] = useState(null);     // 已上课程弹窗（某个学生）
  // 幂等键：同一份"课包 + 学生 + 次数"的提交在成功前复用同一个 key，
  // 双击/超时重试不会重复扣次数；成功后重置，下一次同样的操作算一次新的授权。
  const submitKeyRef = useRef({ signature: '', key: '' });
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
  // 每人次数上限 = 剩余次数 ÷ 已选人数（没选人就先按剩余次数本身给个上限）；服务端还会在事务里再算一次
  const maxUnits = remaining === null ? null : Math.max(1, Math.floor(remaining / Math.max(1, picked.length)));
  const clampUnits = (value) => {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return maxUnits ? Math.min(parsed, maxUnits) : Math.min(parsed, 999);
  };
  const needed = picked.length * units;
  const overLimit = remaining !== null && needed > remaining;
  useEffect(() => { setUnits((value) => clampUnits(value)); /* eslint-disable-next-line */ }, [seriesId, picked.length, remaining]);
  const activeStudentIds = new Set((grants.data?.items || []).filter((row) => !row.revokedAt).map((row) => row.studentId));
  // 体验课包（2026-09-24 用户口径）：**可以重复分给同一个学生**、未使用的次数**预先累积** ——
  // 所以「已授权」不再等于"不能再选"，改看这名学生手上还剩几次。
  const selectedSeries = items.find((series) => series.id === seriesId) || null;
  const isExperience = selectedSeries?.seriesType === 'EXPERIENCE';
  const remainingByStudent = new Map((grants.data?.items || [])
    .filter((row) => !row.revokedAt)
    .map((row) => [row.studentId, Number(row.remainingUnits ?? 1)]));

  // 2026-11-10：普通课包也按次数之后，**两种课包都允许重复分给同一学生**（次数累加），
  // 所以勾选框不再因为"已授权"而禁用；右侧直接显示这名学生手上还剩几次。
  const addableOnPage = studentItems;
  const alreadyOnPage = studentItems.filter((student) => activeStudentIds.has(student.id)).length;

  function toggle(student, checked) {
    setHint('');
    setPicked((current) => (checked
      ? [...current, toPicked(student)]
      : current.filter((item) => item.id !== student.id)));
  }
  // 「全选」只作用于**当前这一页**（与服务端分页一致）：在几百人的名册上做跨页全选是个陷阱。
  // 而且最多只选到剩余次数 —— 让用户在点之前就看到结果，而不是提交后被顶回来。
  function selectCurrentPage() {
    const addable = addableOnPage.filter((student) => !pickedIds.has(student.id));
    if (!addable.length) return;
    if (remaining !== null) {
      const room = Math.max(0, remaining - picked.length);
      if (addable.length > room) {
        setPicked((current) => [...current, ...addable.slice(0, room).map(toPicked)]);
        setHint(room
          ? `这一页还能选的人比剩余次数多：已按上限只选了 ${room} 人（剩余 ${remaining} 次）。要授权更多请先让平台增购次数。`
          : `本课包剩余 ${remaining} 次已经用完，无法再选。要授权更多请先让平台增购次数。`);
        return;
      }
    }
    setPicked((current) => [...current, ...addable.map(toPicked)]);
  }

  function grantKeyFor(signature) {
    if (submitKeyRef.current.signature !== signature) {
      submitKeyRef.current = {
        signature,
        key: globalThis.crypto?.randomUUID?.() || `grant-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
    }
    return submitKeyRef.current.key;
  }

  async function submit() {
    if (!seriesId || !picked.length || overLimit) return;
    setBusy(true); setMessage(''); setHint('');
    const signature = `${seriesId}|${picked.map((item) => item.id).sort().join(',')}|${units}`;
    try {
      const result = await api.post('org/course-grants', {
        seriesId, studentIds: picked.map((item) => item.id), units, source: 'GRANT_PAGE',
        idempotencyKey: grantKeyFor(signature),
      });
      submitKeyRef.current = { signature: '', key: '' };
      const left = result.quotaTotal > 0 ? `本课包已用 ${result.quotaUsed} / ${result.quotaTotal} 次` : '本课包不限次数';
      setMessage(`已授权 ${result.granted} 名学生（每人 ${units} 次、共 ${result.usedUnits ?? result.granted * units} 次）；${left}。`);
      setPicked([]); setUnits(1); grants.refresh(); courses.refresh(); students.refresh();
    } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); }
  }

  return <>
    <PageHeader
      eyebrow="学生授权"
      title="批量授权次数"
      description={isExperience
        ? '体验课包：每分给一名学生用掉 1 次；同一个学生可以再分、次数会累加（同一节课可反复上，正常结束且有有效产出才核销 1 次）。'
        : '普通课包：1 次 = 1 个课时次数（上 1 节扣 1 次）；同一个学生可以再分、次数会累加（上过的课不能重复上）。'}
      actions={<button className="secondary-button" onClick={() => { courses.refresh(); grants.refresh(); students.refresh(); }}>刷新</button>}
    />
    {message && <Notice tone="success">{message}</Notice>}
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
        {!items.length ? <Notice tone="info">当前机构还没有被平台授权的课包，请先在「课程备课」里查看，或联系平台授权。</Notice> : null}
        {noQuota ? <Notice tone="warning">
          这个课包当前**可授权次数为 0**：平台还没有给本机构分配次数，所以现在不能授权。
        </Notice> : null}
      </>}
    </Panel>

    {seriesId && !noQuota ? <Panel title="② 勾选要授权的学生"
      actions={<span className="muted">本页可授权 <strong>{addableOnPage.length}</strong> 人{alreadyOnPage ? ` · 已授权 ${alreadyOnPage} 人` : ''}</span>}>
      <div className="pick-bar">
        <input value={studentSearch} placeholder="搜索姓名 / 登录名 / 手机号" onChange={(event) => { setStudentSearch(event.target.value); setStudentPage(1); }} />
        <button type="button" className="secondary-button" disabled={!addableOnPage.length} onClick={selectCurrentPage}>全选本页可授权（{addableOnPage.length}）</button>
        <button type="button" className="secondary-button" disabled={!picked.length} onClick={() => { setPicked([]); setHint(''); }}>清空选择</button>
        <span className="muted">已选 <strong>{picked.length}</strong> 人</span>
      </div>
      {hint ? <Notice tone="info">{hint}</Notice> : null}
      {students.loading ? <Loading label="正在读取学生…" />
        : students.error ? <ErrorState error={students.error} onRetry={students.refresh} />
          : <>
            <ListResultSummary total={students.data?.total} page={students.data?.page} totalPages={students.data?.totalPages} label="名学生" />
            {studentItems.length ? <div className="table-wrap"><table>
              <thead><tr><th style={{ width: 40 }}>选</th><th>学生</th><th>登录账号</th><th>手机号</th><th>可用次数</th><th>操作</th></tr></thead>
              <tbody>{studentItems.map((student) => {
                const already = activeStudentIds.has(student.id);
                const pickedNow = pickedIds.has(student.id);
                const heldUnits = remainingByStudent.get(student.id) || 0;
                // 2026-11-10：两种课包都允许重复分配（次数累加），勾选框一律可用。
                return <tr key={student.id} className={'student-pick-row' + (pickedNow ? ' is-picked' : '')}>
                  <td><input type="checkbox" checked={pickedNow} aria-label={`选择 ${student.displayName || student.login}`} onChange={(event) => toggle(student, event.target.checked)} /></td>
                  <td><strong>{student.displayName || student.login}</strong></td>
                  <td className="muted">{student.login}</td>
                  <td className="muted">{student.phone || '—'}</td>
                  <td>{already
                    ? (heldUnits > 0
                      ? <span className="status success">可用 {heldUnits} 次</span>
                      : <span className="status warning">已用完</span>)
                    : <span className="muted">还没有次数</span>}</td>
                  <td><button type="button" className="text-button" onClick={() => setUsageTarget(student)}>已上课程</button></td>
                </tr>;
              })}</tbody>
            </table></div> : <Empty title="没有学生" body={studentSearch.trim() ? `没有匹配「${studentSearch.trim()}」的学生。` : '当前机构还没有学生账号，请先在「成员管理」里创建。'} />}
            <Pagination page={students.data?.page} totalPages={students.data?.totalPages} onChange={setStudentPage} disabled={students.loading} />
          </>}
    </Panel> : null}

    {seriesId && !noQuota ? <Panel title={`③ 本次授权（已选 ${picked.length} 人）`}>
      {/* ⭐ 每人授权次数（2026-09-26 体验课先加；2026-11-10 普通课包也按课时次数，所以两种类型都显示）。
          上限 = 剩余次数 ÷ 已选人数（选了 3 个人、课包剩 10 次 → 每人最多 3 次），
          提交时服务端在事务里**按刚读出来的 quota_used 再算一次**，前端算错也拦得住。 */}
      <div className="row-actions top-gap">
        <span className="muted">每人授权次数：</span>
        <span className="ta-zoom">
          <button type="button" className="secondary-button" disabled={units <= 1} onClick={() => setUnits((value) => Math.max(1, value - 1))} aria-label="减少">−</button>
          <input className="units-input" type="number" min="1" max={maxUnits || 999} value={units}
            onChange={(event) => setUnits(clampUnits(event.target.value))} aria-label="每人授权次数" />
          <button type="button" className="secondary-button" disabled={!maxUnits || units >= maxUnits} onClick={() => setUnits((value) => Math.min(maxUnits || 999, value + 1))} aria-label="增加">＋</button>
        </span>
        <span className="muted">次 / 人{maxUnits ? `（本课包剩余 ${remaining} 次，最多每人 ${maxUnits} 次）` : ''}</span>
        <button type="button" className="text-button" disabled={!maxUnits || units === maxUnits} onClick={() => setUnits(maxUnits)}>按库存拉满</button>
      </div>
      <div className="row-actions top-gap">
        <span className="muted">本次将用掉 <strong>{needed}</strong> 次{picked.length && units > 1 ? `（${picked.length} 人 × 每人 ${units} 次）` : ''}</span>
        <span className="muted">·</span>
        <span className={overLimit ? 'status danger' : 'muted'}>
          {overLimit ? `剩余次数不足：本课包只剩 ${remaining} 次，本次需要 ${needed} 次` : `授权后本课包剩 ${remaining === null ? '—' : Math.max(0, remaining - needed)} 次`}
        </span>
      </div>
      {/* 跨页选择要看得见：把勾了谁原样列出来（翻页之后也不丢）；每人多次时把 ×N 标出来 */}
      {picked.length ? <div className="row-actions top-gap">
        <span className="muted">将要授权：</span>
        {picked.map((item) => <span className="pick-tag" key={item.id}>{item.name}{units > 1 ? ` ×${units}` : ''}</span>)}
      </div> : <p className="muted top-gap">还没有选择学生。上面的名单里勾选即可（两种课包都可以重复分给同一个学生，次数会累加）。</p>}
      <div className="row-actions top-gap">
        <button className="primary-button" disabled={busy || !picked.length || overLimit} onClick={submit}>
          {busy ? '授权中…' : (units > 1 ? `授权给 ${picked.length} 名学生（每人 ${units} 次）` : `授权给 ${picked.length} 名学生`)}
        </button>
        {overLimit ? <span className="muted">先去掉几个人、把每人次数调小，或让平台增购次数。</span> : null}
      </div>
      <p className="muted">{isExperience
        ? '体验课包的次数不开放机构回收（课堂没有有效产出、或课堂被解散时不扣次）；如果是误授权，请联系平台兜底撤销。'
        : '普通课包的次数可以回收（在下方「已授权记录」里点「回收」，可指定回收几次）；已经核销掉的历史不可退。'}</p>
    </Panel> : null}

    <Panel title={`已授权记录（${grants.data?.items?.length || 0} 条）`}>
      {!seriesId ? <Empty title="先选一个课包" body="选择课包后可以看到这门课的授权记录。" />
        : grants.loading ? <Loading />
          : grants.error ? <ErrorState error={grants.error} onRetry={grants.refresh} />
            : (grants.data?.items || []).length ? <div className="table-wrap"><table>
              <thead><tr><th>学生</th><th>课包</th><th>授权</th><th>已用</th><th>可用</th><th>授权时间</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>{grants.data.items.map((item) => {
                const experience = item.seriesType === 'EXPERIENCE';
                const remaining = Number(item.remainingUnits ?? 0);
                return <tr key={item.id}>
                  <td><strong>{item.studentName || item.studentLogin}</strong></td>
                  <td>{item.seriesTitle}{experience ? <em>体验</em> : null}</td>
                  <td>{item.grantedUnits ?? 1} 次</td>
                  <td>{item.consumedUnits ?? 0} 次</td>
                  <td><span className={remaining > 0 ? 'status success' : 'status warning'}>{remaining} 次</span></td>
                  <td>{formatDate(item.grantedAt)}</td>
                  <td>{item.revokedAt
                    ? <><span className="status warning">已回收/撤销</span>{item.revokeReason ? <div className="muted">{item.revokeReason}</div> : null}</>
                    : <span className="status success">有效</span>}</td>
                  <td><div className="row-actions">
                    {!experience && !item.revokedAt && remaining > 0
                      ? <button type="button" className="text-button" onClick={() => setReclaimTarget(item)}>回收</button>
                      : null}
                    <button type="button" className="text-button" onClick={() => setUsageTarget({ id: item.studentId, displayName: item.studentName || item.studentLogin })}>已上课程</button>
                  </div></td>
                </tr>;
              })}</tbody>
            </table></div> : <Empty title="还没有授权记录" body="选择课包与学生后点击授权，记录会显示在这里。" />}
    </Panel>

    {reclaimTarget ? <ReclaimModal api={api} grant={reclaimTarget}
      onClose={() => setReclaimTarget(null)}
      onDone={(text) => { setReclaimTarget(null); setMessage(text); grants.refresh(); courses.refresh(); students.refresh(); }} /> : null}
    {usageTarget ? <StudentUsageModal api={api} student={usageTarget} onClose={() => setUsageTarget(null)} /> : null}
  </>;
}

/**
 * 回收学生未使用的课时次数（2026-11-10 用户口径：普通课包可回收，可指定回收几次）。
 * 服务端会再校验：不能超过未使用余额、学生还在课堂里就拒绝、每退 1 次冲销 1 笔许可收入。
 */
function ReclaimModal({ api, grant, onClose, onDone }) {
  const maxUnits = Number(grant?.remainingUnits || 0);
  const [units, setUnits] = useState(String(maxUnits));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keyRef = useRef({ signature: '', key: '' });
  const parsedUnits = Math.floor(Number(units));
  const unitsValid = Number.isFinite(parsedUnits) && parsedUnits >= 1 && parsedUnits <= maxUnits;
  const reasonValid = reason.trim().length > 0 && reason.trim().length <= 500;
  const studentName = grant?.studentName || grant?.studentLogin || '该学生';

  async function submit() {
    if (!unitsValid || !reasonValid) return;
    setBusy(true); setError('');
    const signature = `${grant.id}|${parsedUnits}|${reason.trim()}`;
    if (keyRef.current.signature !== signature) {
      keyRef.current = { signature, key: globalThis.crypto?.randomUUID?.() || `reclaim-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    }
    try {
      const result = await api.post(`org/course-grants/${encodeURIComponent(grant.id)}/reclaim`, {
        units: parsedUnits, reason: reason.trim(), idempotencyKey: keyRef.current.key,
      });
      onDone(`已从 ${studentName} 回收 ${result.reclaimedUnits} 次课时；该学生还剩 ${result.remainingUnits} 次，机构已用 ${result.quotaUsed} / ${result.quotaTotal} 次。`);
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }

  return <Modal title="回收课时次数" busy={busy} error={error} onClose={onClose}
    description={`${studentName} · ${grant?.seriesTitle || ''} · 当前可用 ${maxUnits} 次`}
    footer={<>
      <button type="button" className="primary-button" disabled={busy || !unitsValid || !reasonValid} onClick={submit}>{busy ? '回收中…' : '确认回收'}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
    </>}>
    <label>回收次数
      <input type="number" min="1" max={maxUnits} value={units} onChange={(event) => setUnits(event.target.value)} />
      <small className="muted">最多 {maxUnits} 次（只能回收没用过的；已核销的 {grant?.consumedUnits ?? 0} 次不可退）</small>
    </label>
    <label>回收原因（必填）
      <textarea rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="如：学生转班，未使用的课时退回机构" />
      <small className="muted">{reason.length}/500</small>
    </label>
    <p className="muted">回收后次数回到机构的总次数里；学生还在待上课/上课中的课堂里时不能回收（服务端会拒绝）。</p>
  </Modal>;
}

/** 学生「已上课程」面板：课包 / 课时 / 课堂 / 老师 / 是否扣次（2026-11-10 用户口径）。 */
function StudentUsageModal({ api, student, onClose }) {
  const data = useData(() => api.get(`org/students/${encodeURIComponent(student.id)}/course-usage`), [api, student.id]);
  const summary = data.data?.summary || {};
  const items = data.data?.items || [];
  return <Modal title={`已上课程 · ${student.displayName || student.login}`} wide onClose={onClose}
    description="这里列出这个学生上过的所有课（含没产出、未扣次的场次）。"
    footer={<button type="button" className="secondary-button" onClick={onClose}>关闭</button>}>
    {data.loading ? <Loading label="正在读取已上课程…" /> : data.error ? <ErrorState error={data.error} onRetry={data.refresh} /> : <>
      <p className="muted">共 {summary.total ?? 0} 场：已完课 {summary.completed ?? 0} 场（扣次 {summary.consumed ?? 0} 次）· 未完课 {summary.incomplete ?? 0} 场（不扣次）</p>
      {items.length ? <div className="table-wrap"><table>
        <thead><tr><th>课包</th><th>课时</th><th>课堂</th><th>老师</th><th>结束/完课时间</th><th>结果</th><th>扣次</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}>
          <td>{item.seriesTitle || '—'}{item.seriesType === 'EXPERIENCE' ? <em>体验</em> : null}</td>
          <td>{item.lessonTitle || '—'}</td>
          <td>{item.sessionTitle || '—'}</td>
          <td>{item.teacherName || '—'}</td>
          <td>{item.completedAt ? formatDate(item.completedAt) : '—'}</td>
          <td>{item.status === 'COMPLETED'
            ? <span className="status success">已完课</span>
            : <span className="status warning">未完课</span>}</td>
          <td>{item.consumed ? '已扣 1 次' : <span className="muted">未扣</span>}</td>
        </tr>)}</tbody>
      </table></div> : <Empty title="还没有上过课" body="这个学生还没有已结算的课堂记录。" />}
    </>}
  </Modal>;
}
