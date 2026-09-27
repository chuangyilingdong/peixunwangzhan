// 机构端 - 002 机构课包库存与学生授权（2026-09-17 按线框图重做，六屏齐了）
//
// 线框图把这一套拆成 002-01 库存列表 / 002-02 单课包详情 / 002-03 学生授权中心 /
// 002-04 学生授权详情 / 002-04B 单授权详情（右侧抽屉）/ 002-06 采购·增购·开通记录。
// 它们是**同一个信息面的三个视角**，所以放在一个页面用页签切换，而不是三个互不相干的路由：
//   · 课包库存（002-01 / 002-02）—— 从**课包**看「分给了谁」
//   · 学生授权中心（002-03 / 002-04 / 002-04B）—— 从**学生**看「拿到了哪些课包」
//   · 采购与开通记录（002-06）—— 看「这些人次是从哪来的」
// ⚠️ 2026-09-26 用户口径：页签只留**只读视角**。「为学生添加课包」原来是第 5 个页签（跳到录入页），
//    现在改成「添加课包」**弹窗**（AddGrantModal）—— 写操作不再和只读视角混在一排；
//    批量给多人授权仍走 /grants 那一页，入口收在弹窗里。
//
// 与相邻页面的边界（沿用原注释，别又出现"三套东西说不清"）：
//   · 「课程中心」＝看课包内容（封面/课时/教案）
//   · 本页＝看课包的**分配与使用账**（次数、学生、课堂），并下钻到「谁被分到了」
//   · 「学生开通」＝学生的席位与有效期
//
// ⚠️ 「授权状态：待激活 / 学习中 / 已取消」这一层**数据库里没有状态列**（student_course_grants 只有
//    granted_at/revoked_at）。但线框图 002-04 的「授权规则」第一次给了判定口径，所以现在**能真算**：
//    待激活 = 尚未产生正式学习记录；学习中 = 已进入正式课堂或已产生有效 AI 学习记录；已取消 = 有 revoked_at。
//    「已完成」线框图只列了状态名、**没给口径** —— 按纪律不编，服务端不产出它。
//
// ⚠️ **取消授权只有平台端有权限**（用户 2026-09-17 明确）：机构端没有取消入口，
//    也不展示「取消资格」那一层 —— 给机构看「取消资格」却不给取消，是误导。
//    `p55` 断言的「机构侧撤销入口必须 404」就是这个口径，别去改它。
import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import {
  Empty, ErrorState, ListResultSummary, Loading, MetricCard, PageHeader, Pagination,
  Panel, Status, formatDate, useData, useDebouncedValue, errorText,
} from '@platform/shared';
import { Modal } from './classroom/ui.jsx';

const DAYS_OPTIONS = [['1', '近 1 天'], ['7', '近 7 天'], ['30', '近 30 天'], ['90', '近 90 天']];
const ACCOUNT_STATUS_OPTIONS = [['', '全部'], ['ACTIVE', '正常'], ['DISABLED', '已停用']];
const GRANT_STATE_OPTIONS = [['', '全部'], ['WITH', '已有课包'], ['WITHOUT', '暂无课包']];
const BUSINESS_TYPE_LABELS = { FIRST_OPENING: '初次开通', ADDITIONAL: '增购', PLATFORM_ADJUSTMENT: '平台调整' };
const BUSINESS_TYPE_OPTIONS = [['', '全部'], ['FIRST_OPENING', '初次开通'], ['ADDITIONAL', '增购'], ['PLATFORM_ADJUSTMENT', '平台调整']];
const SOURCE_LABELS = { ORDER: '订单', CONTRACT: '合同', PLATFORM: '平台开通' };
const SOURCE_OPTIONS = [['', '全部'], ['ORDER', '订单'], ['CONTRACT', '合同'], ['PLATFORM', '平台开通']];
const TAB_META = {
  overview: { eyebrow: '002-01', title: '机构课包库存', description: '查看机构当前拥有的课包权益、人次库存及使用情况' },
  students: { eyebrow: '002-03', title: '学生授权中心', description: '按学生看授权：谁已经有课包、谁还没有；点开可看单个学生的授权明细' },
  records: { eyebrow: '002-05', title: '学生授权记录', description: '记录学生课包授权与取消授权的操作历史（只看得见成功的操作）' },
  batches: { eyebrow: '002-06', title: '采购 / 增购 / 开通记录', description: '本机构的人次是从哪来的：初次开通、增购与平台调整' },
};

/** 权益状态：有效 / 已禁用（平台撤销授权）—— 只有这两态，没有「待激活」。 */
function EntitlementBadge({ status }) {
  if (!status) return <Status value="NONE" />;
  return <span className={'status' + (status === 'ACTIVE' ? ' success' : '')}>{status === 'ACTIVE' ? '有效' : '已禁用'}</span>;
}

/** 账号状态：users.status 只有 ACTIVE / DISABLED 两态。 */
function AccountBadge({ status }) {
  const active = status === 'ACTIVE';
  return <span className={'status' + (active ? ' success' : '')}>{active ? '正常' : '已停用'}</span>;
}

/**
 * 002-03 学生授权中心：从**学生**这一侧看授权（课包视角在「课包库存」页签）。
 * 4 张卡的口径：学生总数 = 在册学生；已有课包 = 至少一条有效授权；本月新增 = 本月**发生过**的授权
 * （含后来被平台撤销的 —— 那次授权确实发生过，这样才对得上总览页的 month.grants）。
 */
function StudentGrantCenter({ api, onOpenStudent }) {
  const [draft, setDraft] = useState({ search: '', status: '', grantState: '' });
  const [applied, setApplied] = useState({ search: '', status: '', grantState: '' });
  const [page, setPage] = useState(1);
  // 「添加课包」= 弹窗（2026-09-26 用户口径）：不再跳到另一个页签
  const [adding, setAdding] = useState(false);
  const query = new URLSearchParams({ page: String(page), limit: '20' });
  if (applied.search) query.set('search', applied.search);
  if (applied.status) query.set('status', applied.status);
  if (applied.grantState) query.set('grantState', applied.grantState);
  const queryString = query.toString();
  const data = useData(() => api.get(`org/student-grants-summary?${queryString}`), [api, queryString]);
  const totals = data.data?.totals || {};
  const items = data.data?.items || [];

  function submit(event) {
    event.preventDefault();
    setPage(1);
    setApplied(draft);
  }

  return <>
    <div className="metrics">
      <MetricCard label="学生总数" value={totals.students ?? '—'} hint="本机构在册学生账号" />
      <MetricCard label="已有课包学生" value={totals.withGrants ?? '—'} hint="至少有一条有效授权" tone="teal" />
      <MetricCard label="暂无课包学生" value={totals.withoutGrants ?? '—'} hint="还没有任何有效授权" tone="orange" />
      <MetricCard label="本月新增授权" value={totals.grantedThisMonth ?? '—'} hint="本月发生过的授权次数" tone="pink" />
    </div>

    <Panel title="筛选">
      <form className="filter-form" onSubmit={submit}>
        <label>学生<input value={draft.search} placeholder="姓名 / 登录名 / 手机号" onChange={(event) => setDraft({ ...draft, search: event.target.value })} /></label>
        <label>账号状态<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
          {ACCOUNT_STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>授权情况<select value={draft.grantState} onChange={(event) => setDraft({ ...draft, grantState: event.target.value })}>
          {GRANT_STATE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <div className="row-actions">
          <button className="primary-button" disabled={data.loading}>查询</button>
          <button className="secondary-button" type="button" disabled={data.loading} onClick={() => { setDraft({ search: '', status: '', grantState: '' }); setApplied({ search: '', status: '', grantState: '' }); setPage(1); }}>重置</button>
          <button className="secondary-button" type="button" onClick={() => setAdding(true)}>添加课包</button>
        </div>
      </form>
    </Panel>

    <Panel title="学生授权">
      {data.loading ? <Loading label="正在读取学生授权…" /> : data.error ? <ErrorState error={data.error} onRetry={data.refresh} /> : items.length ? <>
        <ListResultSummary total={data.data?.total} page={data.data?.page} totalPages={data.data?.totalPages} label="名学生" />
        <div className="table-wrap"><table>
          <thead><tr><th>学生</th><th>登录账号</th><th>账号状态</th><th>已授权课包数</th><th>体验课包授权次数</th><th>最近授权时间</th><th>授权概览</th><th>操作</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.studentId}>
            <td><strong>{item.displayName || item.login}</strong></td>
            <td className="muted">{item.login}</td>
            <td><AccountBadge status={item.status} /></td>
            <td>{item.grantedCount}</td>
            {/* ⭐ 2026-09-26 用户口径：体验课包可以重复授权给同一个账号，所以这里要看得见**授权次数**
                （次数记在许可行上：授权 N 次 / 已核销 M 次 / 还剩 N−M 次）。没有体验包的学生显示「—」。 */}
            <td>{item.experienceGrantedUnits
              ? <><strong>{item.experienceGrantedUnits} 次</strong><div className="muted">已核销 {item.experienceConsumedUnits} · 剩 {item.experienceRemainingUnits}</div></>
              : <span className="muted">—</span>}</td>
            <td>{item.lastGrantedAt ? formatDate(item.lastGrantedAt) : '—'}</td>
            <td>{item.grantedSeries.length
              ? <span className="muted">{item.grantedSeries.slice(0, 3).map((series) => `${series.title}${series.seriesType === 'EXPERIENCE' ? ` ×${series.grantedUnits}` : ''}`).join('、')}{item.grantedSeries.length > 3 ? ` 等 ${item.grantedSeries.length} 个` : ''}</span>
              : <span className="muted">暂无课包</span>}</td>
            <td><button type="button" className="text-button" onClick={() => onOpenStudent(item.studentId)}>查看授权</button></td>
          </tr>)}</tbody>
        </table></div>
        <Pagination page={data.data?.page} totalPages={data.data?.totalPages} onChange={setPage} disabled={data.loading} />
      </> : <Empty title="没有符合条件的学生" body="调整筛选条件，或先在「机构成员管理」里创建学生账号。" />}
    </Panel>

    {adding ? <AddGrantModal api={api} source="STUDENT_CENTER" onClose={() => setAdding(false)}
      onDone={() => { setAdding(false); data.refresh(); }} /> : null}
  </>;
}

/** 授权状态徽标：线框图 002-04 的 3 态（「已完成」口径未定，服务端不产出它）。 */
function GrantStateBadge({ item }) {
  if (item.state === 'REVOKED') return <><span className="status">已取消</span>{item.revokeReason ? <div className="muted">{item.revokeReason}</div> : null}</>;
  if (item.state === 'LEARNING') return <span className="status success">学习中</span>;
  return <span className="status warning">待激活</span>;
}

/**
 * 「添加课包」弹窗（2026-09-26 用户口径，取代原来的 002-04A 抽屉 +「为学生添加课包」页签）：
 *   · **不跳转**：从学生授权中心（列表）或某学生的授权详情里直接弹窗，三步 —— 为谁添加 → 添加什么课包 → 确认；
 *   · **体验课包要填次数**（可以重复分给同一个学生、次数累加；上限 = 该课包剩余人次）；
 *   · **普通课包不给次数输入**（每人只能授权一次），点确认即可 —— 服务端对 units>1 会 400
 *     （UNITS_NOT_SUPPORTED，见 p140 ④′），所以这里固定按 1 次提交。
 *
 * 候选课包规则（沿用 002-04A 线框图右栏）：机构已开通 + 剩余人次 > 0 + 该学生当前没有这一课包的**有效**授权。
 *   ⚠️ 线框图那条写的是「剩余人次 ≥ 0」，紧接着又说「剩余人次 = 0 的课包不展示」—— 按后者实现
 *      （平台口径：余额必须大于零才能分配，零次不代表不限）。
 *   ⚠️ 体验课包**不参与**「已授权就不再出现」的过滤 —— 重复分配就是它的正常用法。
 *
 * 候选**不新增接口**：库存与权益状态来自 series-overview、该学生的已有授权来自学生授权接口，
 * 再开一个接口等于把同一份账算两遍。次数上限服务端在事务里还会按真实 quota_used 再算一次。
 */
function AddGrantModal({ api, student = null, source = 'STUDENT_CENTER', onClose, onDone }) {
  // 学生：从某个学生的详情进来时**固定**（不再让用户选一遍），否则先在弹窗里选。
  // ⚠️ deps 里只能用 `fixedStudent` 这个**布尔**，不能把 student 对象塞进去 ——
  //    调用方是内联 `{{ ...student, studentId }}`，对象每次渲染都是新的，
  //    useData 按引用比较 deps → 取数 → setState → 再渲染 → 再取数，转成死循环。
  const fixedStudent = Boolean(student);
  const [pickedStudent, setPickedStudent] = useState(student);
  const [keyword, setKeyword] = useState('');
  const search = useDebouncedValue(keyword, 350);   // 即时搜索防抖（§三十五 的口径）
  const students = useData(
    () => (fixedStudent ? Promise.resolve({ items: [] })
      : api.get(`org/users?role=STUDENT&limit=8${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`)),
    [api, fixedStudent, search],
  );
  const overview = useData(() => api.get('org/series-overview?days=30'), [api]);
  const studentId = pickedStudent?.studentId || pickedStudent?.id || '';
  // 这名学生手上的许可：普通课包「每人只能一次」要靠它过滤，体验课包不看它
  const held = useData(
    () => (studentId ? api.get(`org/students/${encodeURIComponent(studentId)}/course-grants`) : Promise.resolve({ items: [] })),
    [api, studentId],
  );
  const [seriesId, setSeriesId] = useState('');
  const [units, setUnits] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const heldNormal = new Set((held.data?.items || [])
    .filter((row) => row.status === 'ACTIVE' && row.seriesType !== 'EXPERIENCE')
    .map((row) => row.seriesId));
  const candidates = (overview.data?.items || []).filter((item) => item.assignmentStatus === 'ACTIVE'
    && Number(item.remaining || 0) > 0 && !heldNormal.has(item.seriesId));
  const picked = candidates.find((item) => item.seriesId === seriesId) || null;
  const isExperience = picked?.seriesType === 'EXPERIENCE';
  const maxUnits = picked ? Math.max(1, Number(picked.remaining || 1)) : 1;
  const useNow = isExperience ? units : 1;
  // 换人 / 换课包时把次数夹回本课包的上限，别把上一门课的数字带过去
  useEffect(() => { setUnits((value) => Math.min(Math.max(1, Number(value) || 1), maxUnits)); }, [maxUnits, seriesId]);

  async function submit() {
    if (!studentId || !picked) return;
    setBusy(true); setError('');
    try {
      await api.post('org/course-grants', { seriesId: picked.seriesId, studentIds: [studentId], units: useNow, source });
      onDone();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  return <Modal title="添加课包" description="选学生、选课包；体验课包填次数，普通课包确认即可。"
    onClose={onClose} busy={busy} error={error}
    footer={<>
      <button className="primary-button" disabled={busy || !studentId || !picked} onClick={submit}>
        {busy ? '授权中…' : (isExperience && useNow > 1 ? `授权 ${useNow} 次` : '确认授权')}
      </button>
      <button className="secondary-button" type="button" onClick={onClose}>取消</button>
      {/* 批量那条路没删（一次给很多学生分课包还是它合适），只是不再占一个页签 */}
      <Link className="text-button" to="/grants" onClick={onClose}>批量添加课包（一次多名学生）</Link>
    </>}
  >
    <h3>① 为谁添加</h3>
    {studentId ? <div className="row-actions">
      <strong>{pickedStudent.displayName || pickedStudent.login}</strong>
      <span className="muted">{pickedStudent.login}</span>
      {pickedStudent.status ? <AccountBadge status={pickedStudent.status} /> : null}
      {!student ? <button type="button" className="text-button" onClick={() => { setPickedStudent(null); setSeriesId(''); }}>重选</button> : null}
    </div> : <>
      <label>搜索学生（姓名 / 登录名 / 手机号）<input value={keyword} placeholder="输入关键字；留空显示最近创建的学生" onChange={(event) => setKeyword(event.target.value)} /></label>
      {students.loading ? <Loading label="正在读取学生…" /> : students.error ? <ErrorState error={students.error} onRetry={students.refresh} />
        : (students.data?.items || []).length ? <div className="card-list">
          {(students.data.items || []).map((item) => <button type="button" className="secondary-button wide" key={item.id}
            onClick={() => { setPickedStudent(item); setSeriesId(''); }} style={{ textAlign: 'left' }}>
            <strong>{item.displayName || item.login}</strong> <span className="muted">{item.login}{item.phone ? ` · ${item.phone}` : ''}</span>
          </button>)}
        </div> : <Empty title="没有匹配的学生" body="换个关键字，或先在「机构成员管理」里创建学生账号。" />}
    </>}

    <h3 className="top-gap">② 添加什么课包</h3>
    {!studentId ? <p className="muted">先选学生。</p> : overview.loading ? <Loading label="正在读取可授权课包…" />
      : overview.error ? <ErrorState error={overview.error} onRetry={overview.refresh} />
        : candidates.length ? <>
          <label>课包<select value={seriesId} onChange={(event) => setSeriesId(event.target.value)}>
            <option value="">选择课包</option>
            {candidates.map((item) => <option key={item.seriesId} value={item.seriesId}>
              {item.title}（{item.seriesType === 'EXPERIENCE' ? '体验课包 · ' : ''}剩 {item.remaining} 次）
            </option>)}
          </select></label>
          {picked ? <div className="row-actions">
            <span className="status">{isExperience ? '体验课包' : '普通课包'}</span>
            <span className="muted">总人次 {picked.quotaTotal} · 已分配 {picked.quotaUsed} · 剩余 {picked.remaining}</span>
          </div> : null}
        </> : <Empty title="没有可授权的课包" body="可能原因：该学生已持有这些课包的有效授权（体验课包可以重复授权），或课包剩余人次为 0。" />}

    {picked ? <><h3 className="top-gap">③ 确认</h3>
      {isExperience ? <div className="row-actions">
        <span className="muted">授权次数：</span>
        <span className="ta-zoom">
          <button type="button" className="secondary-button" disabled={units <= 1} onClick={() => setUnits((value) => Math.max(1, value - 1))} aria-label="减少">−</button>
          <input className="units-input" type="number" min="1" max={maxUnits} value={units} aria-label="授权次数"
            onChange={(event) => setUnits((value) => { const parsed = Math.floor(Number(event.target.value)); return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, maxUnits) : Math.max(1, value); })} />
          <button type="button" className="secondary-button" disabled={units >= maxUnits} onClick={() => setUnits((value) => Math.min(maxUnits, value + 1))} aria-label="增加">＋</button>
        </span>
        <span className="muted">次（本课包剩余 {picked.remaining} 次，最多 {maxUnits} 次）</span>
      </div> : <p className="muted">普通课包每人只能授权一次，点「确认授权」即可。</p>}
      <p className="muted">授权后：{picked.title}{isExperience ? ` 该学生 +${useNow} 次` : ' 一笔学习许可（待激活）'}，本课包剩 {Math.max(0, Number(picked.remaining || 0) - useNow)} 次。</p>
    </> : null}
  </Modal>;
}
/**
 * 002-04 学生授权详情（2026-09-17 按线框图第 1 张重排）。两个抽屉：002-04A 添加课包 / 002-04B 单授权详情。
 *
 * 与线框图的**两处有意偏离**（都是按用户口径，别当成漏做）：
 *   ① 线框图 header 写「撤销授权进入 002-04C」、规则 4 写「取消后返还 1 人次」——
 *      用户已定：**机构端没有取消授权权限**，所以 002-04C 不做，也不展示撤销资格校验。
 *   ② 规则 1 列了「已完成」这一态，但线框图**没给判定口径**（规则 2 只定义了待激活 / 学习中），
 *      所以服务端不产出 COMPLETED —— 要它得先定口径。
 */
function StudentGrantDetail({ api, studentId, onBack, onOpenRecords }) {
  const data = useData(() => api.get(`org/students/${encodeURIComponent(studentId)}/course-grants`), [api, studentId]);
  const [openGrantId, setOpenGrantId] = useState('');
  const [adding, setAdding] = useState(false);
  const student = data.data?.student;
  const summary = data.data?.summary || {};
  const items = data.data?.items || [];
  const activeItems = items.filter((item) => item.status === 'ACTIVE');
  const openGrant = items.find((item) => item.id === openGrantId) || null;

  return <>
    <PageHeader eyebrow="002-04" title="学生授权详情" description="父级：002-03 | 学生授权中心"
      actions={<><button className="secondary-button" onClick={onBack}>← 返回学生授权中心</button><button className="primary-button" onClick={() => setAdding(true)}>添加课包</button></>} />
    {data.loading ? <Loading label="正在读取该学生的授权…" /> : data.error ? <ErrorState error={data.error} onRetry={data.refresh} /> : <>
      <Panel title="学生">
        <div className="row-actions">
          <strong>{student?.displayName || student?.login || '—'}</strong>
          <span className="muted">登录账号：{student?.login}</span>
          <AccountBadge status={student?.status} />
        </div>
        <div className="metrics top-gap">
          <MetricCard label="当前授权课包" value={summary.activeSeriesCount ?? 0} hint="当前未取消的授权" />
          <MetricCard label="已产生正式学习记录" value={summary.learnedSeriesCount ?? 0} hint={`其中学习中 ${summary.learningCount ?? 0} · 待激活 ${summary.pendingActivationCount ?? 0}`} tone="teal" />
        </div>
        <p className="muted top-gap">账号信息仅用于确认授权对象；学生基础资料请前往「机构成员管理」。</p>
      </Panel>

      <Panel title={`当前课包授权（当前未取消授权：${activeItems.length} 条）`}
        actions={<>
          <button className="secondary-button" type="button" onClick={() => onOpenRecords?.(student?.displayName || student?.login || '')}>授权记录</button>
          <button className="secondary-button" type="button" onClick={() => setAdding(true)}>添加课包</button>
        </>}>
        {activeItems.length ? <div className="table-wrap"><table>
          <thead><tr><th>课包</th><th>当前版本</th><th>授权时间</th><th>授权状态</th></tr></thead>
          <tbody>{activeItems.map((item) => <tr key={item.id}>
            <td><button type="button" className="text-button" onClick={() => setOpenGrantId(item.id)}>{item.seriesTitle || item.seriesId}</button></td>
            <td>{item.version ? `v${item.version}` : '—'}</td>
            <td>{formatDate(item.grantedAt)}</td>
            <td><GrantStateBadge item={item} /></td>
          </tr>)}</tbody>
        </table></div> : <Empty title="该学生还没有任何课包授权" body="点右上角「添加课包」为他开一笔；每分给一人用掉 1 次。" />}
      </Panel>


    </>}

    {openGrant ? <div className="drawer-overlay" onClick={() => setOpenGrantId('')}>
      <div className="drawer-panel" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <div><span className="eyebrow">002-04B 单授权详情</span><h2>{openGrant.seriesTitle || openGrant.seriesId}</h2></div>
          <button type="button" className="drawer-close" onClick={() => setOpenGrantId('')} aria-label="关闭">×</button>
        </header>
        <div className="drawer-body">
          <section className="drawer-section">
            <h3>授权对象</h3>
            <p><strong>{student?.displayName || student?.login}</strong> <span className="muted">{student?.login}</span></p>
          </section>
          <section className="drawer-section">
            <h3>授权信息</h3>
            <p>授权时间：{formatDate(openGrant.grantedAt)}</p>
            <p>操作账号：{openGrant.grantedByName || openGrant.grantedByLogin || '—'}</p>
            <p>来源：{openGrant.sourceLabel}</p>
            <p>占用人次：{openGrant.quotaConsumed} 次</p>
            <p>授权状态：<GrantStateBadge item={openGrant} /></p>
          </section>
          <section className="drawer-section">
            <h3>正式学习记录</h3>
            <p>{openGrant.learned ? <span className="status success">已产生</span> : <span className="muted">未产生</span>}</p>
          </section>
        </div>
        <footer className="drawer-foot"><button className="secondary-button" onClick={() => setOpenGrantId('')}>关闭</button></footer>
      </div>
    </div> : null}

    {adding && student ? <AddGrantModal api={api} source="STUDENT_DETAIL" student={{ ...student, studentId }}
      onClose={() => setAdding(false)} onDone={() => { setAdding(false); data.refresh(); }} /> : null}
  </>;
}

/**
 * 002-06 采购 / 增购 / 开通记录：机构能看到的「人次是从哪来的」。
 * 三分类是服务端按批次序号推出来的（库里没有这个分类列），别在前端再算一遍。
 */
function LicenseBatches({ api, seriesOptions }) {
  const [draft, setDraft] = useState({ seriesId: '', businessType: '', source: '', from: '', to: '' });
  const [applied, setApplied] = useState({ seriesId: '', businessType: '', source: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ page: String(page), limit: '20' });
  Object.entries(applied).forEach(([key, value]) => { if (value) query.set(key, value); });
  const queryString = query.toString();
  const data = useData(() => api.get(`org/license-batches?${queryString}`), [api, queryString]);
  const totals = data.data?.totals || {};
  const items = data.data?.items || [];

  function submit(event) {
    event.preventDefault();
    setPage(1);
    setApplied(draft);
  }

  return <>
    <div className="metrics">
      <MetricCard label="业务记录" value={totals.total ?? 0} hint={`共 ${totals.quantity ?? 0} 人次`} />
      <MetricCard label="初次开通" value={totals.firstOpening ?? 0} hint="该授权单的第一条采购" tone="teal" />
      <MetricCard label="增购" value={totals.additional ?? 0} hint="同一授权单里的后续采购" tone="orange" />
      <MetricCard label="平台调整" value={totals.platformAdjustment ?? 0} hint="平台开通时结转的期初人次" tone="pink" />
    </div>

    <Panel title="筛选">
      <form className="filter-form" onSubmit={submit}>
        <label>课包<select value={draft.seriesId} onChange={(event) => setDraft({ ...draft, seriesId: event.target.value })}>
          <option value="">全部</option>
          {seriesOptions.map((series) => <option key={series.id} value={series.id}>{series.title}</option>)}
        </select></label>
        <label>业务类型<select value={draft.businessType} onChange={(event) => setDraft({ ...draft, businessType: event.target.value })}>
          {BUSINESS_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>来源<select value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })}>
          {SOURCE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>起始时间<input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
        <label>结束时间<input type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
        <div className="row-actions">
          <button className="primary-button" disabled={data.loading}>查询</button>
          <button className="secondary-button" type="button" disabled={data.loading} onClick={() => { const blank = { seriesId: '', businessType: '', source: '', from: '', to: '' }; setDraft(blank); setApplied(blank); setPage(1); }}>重置</button>
        </div>
      </form>
    </Panel>

    <Panel title="业务记录">
      {data.loading ? <Loading label="正在读取采购与开通记录…" /> : data.error ? <ErrorState error={data.error} onRetry={data.refresh} /> : items.length ? <>
        <ListResultSummary total={data.data?.total} page={data.data?.page} totalPages={data.data?.totalPages} label="条记录" />
        <div className="table-wrap"><table>
          <thead><tr><th>业务时间</th><th>课包</th><th>业务类型</th><th>人次数量</th><th>业务来源</th><th>经办</th><th>备注</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.id}>
            <td>{formatDate(item.purchasedAt)}</td>
            <td><strong>{item.seriesTitle || item.seriesId}</strong></td>
            <td><span className="status">{BUSINESS_TYPE_LABELS[item.businessType] || item.businessType}</span></td>
            <td>{item.quantity}</td>
            <td>{SOURCE_LABELS[item.source] || item.source}</td>
            <td>{item.actorName || '—'}</td>
            <td className="muted">{item.note}</td>
          </tr>)}</tbody>
        </table></div>
        <Pagination page={data.data?.page} totalPages={data.data?.totalPages} onChange={setPage} disabled={data.loading} />
      </> : <Empty title="没有符合条件的记录" body="调整筛选条件；如果本机构还没有过采购或开通，这里会是空的。" />}
    </Panel>
  </>;
}

/**
 * 002-05 学生授权记录（按线框图第 2 张）：授权 / 取消授权的操作审计。
 *
 * ⚠️ 页面上必须留着**三条如实说明**（服务端 orgAdmin.js 同段有完整理由，别为了好看删掉）：
 *   ① 只看得见**成功**的操作 —— 失败的授权在抛错前就返回了，根本不落审计；
 *   ② **旧记录的「来源」是空的**（本版起调用方才带上 source），所以显示「机构端授权（旧记录无来源）」；
 *   ③ **机构端没有取消授权权限** → 表里「取消授权」那些行的操作账号一定是**平台**侧账号。
 */
function GrantRecords({ api, seriesOptions, initialSearch = '' }) {
  const blank = { search: initialSearch, seriesId: '', operationType: '', actorId: '', from: '', to: '' };
  const [draft, setDraft] = useState(blank);
  const [applied, setApplied] = useState(blank);
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ page: String(page), limit: '20' });
  Object.entries(applied).forEach(([key, value]) => { if (value) query.set(key, value); });
  const queryString = query.toString();
  const data = useData(() => api.get(`org/student-grant-records?${queryString}`), [api, queryString]);
  const totals = data.data?.totals || {};
  const items = data.data?.items || [];
  const actors = data.data?.actorOptions || [];

  function submit(event) {
    event.preventDefault();
    setPage(1);
    setApplied(draft);
  }

  return <>
    <div className="metrics">
      <MetricCard label="本月授权" value={totals.grantedThisMonth ?? 0} hint="本月新增的学生课包授权" />
      <MetricCard label="本月取消" value={totals.revokedThisMonth ?? 0} hint="本月由平台取消的授权" tone="orange" />
      <MetricCard label="今日授权" value={totals.grantedToday ?? 0} hint="今日新增授权" tone="teal" />
      <MetricCard label="记录总数" value={totals.total ?? 0} hint="累计授权操作记录（按学生拆分后）" tone="pink" />
    </div>

    <Panel title="筛选">
      <form className="filter-form" onSubmit={submit}>
        <label>学生<input value={draft.search} placeholder="姓名 / 登录账号" onChange={(event) => setDraft({ ...draft, search: event.target.value })} /></label>
        <label>课包<select value={draft.seriesId} onChange={(event) => setDraft({ ...draft, seriesId: event.target.value })}>
          <option value="">全部课包</option>
          {seriesOptions.map((series) => <option key={series.id} value={series.id}>{series.title}</option>)}
        </select></label>
        <label>操作类型<select value={draft.operationType} onChange={(event) => setDraft({ ...draft, operationType: event.target.value })}>
          <option value="">全部</option><option value="GRANT">授权</option><option value="REVOKE">取消授权</option>
        </select></label>
        <label>操作账号<select value={draft.actorId} onChange={(event) => setDraft({ ...draft, actorId: event.target.value })}>
          <option value="">全部</option>
          {actors.map((actor) => <option key={actor.actorId} value={actor.actorId}>{actor.name}{actor.scope === 'PLATFORM' ? '（平台）' : ''}</option>)}
        </select></label>
        <label>起始时间<input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
        <label>结束时间<input type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
        <div className="row-actions">
          <button className="primary-button" disabled={data.loading}>查询</button>
          <button className="secondary-button" type="button" disabled={data.loading} onClick={() => { const reset = { search: '', seriesId: '', operationType: '', actorId: '', from: '', to: '' }; setDraft(reset); setApplied(reset); setPage(1); }}>重置</button>
        </div>
      </form>
    </Panel>

    <Panel title="授权操作记录">
      {data.loading ? <Loading label="正在读取授权记录…" /> : data.error ? <ErrorState error={data.error} onRetry={data.refresh} /> : items.length ? <>
        <ListResultSummary total={data.data?.total} page={data.data?.page} totalPages={data.data?.totalPages} label="条记录" />
        <div className="table-wrap"><table>
          <thead><tr><th>时间</th><th>学生</th><th>课包</th><th>操作类型</th><th>操作结果</th><th>操作账号</th><th>来源</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.id}>
            <td>{formatDate(item.occurredAt)}</td>
            <td><strong>{item.studentName || '—'}</strong>{item.studentLogin ? <div className="muted">{item.studentLogin}</div> : null}</td>
            <td>{item.seriesTitle || '—'}</td>
            <td>{item.operationType === 'GRANT'
              ? <span className="status success">授权</span>
              : <><span className="status warning">取消授权</span>{item.note ? <div className="muted">{item.note}</div> : null}</>}</td>
            <td><span className="status success">{item.resultLabel}</span></td>
            <td>{item.actorName}{item.actorScope === 'PLATFORM' ? <div className="muted">平台侧</div> : null}</td>
            <td className="muted">{item.sourceLabel}</td>
          </tr>)}</tbody>
        </table></div>
        <Pagination page={data.data?.page} totalPages={data.data?.totalPages} onChange={setPage} disabled={data.loading} />
      </> : <Empty title="没有符合条件的记录" body="调整筛选条件；本机构还没有发生过授权时这里会是空的。" />}
    </Panel>
  </>;
}

export function SeriesOverview({ api }) {
  const [tab, setTab] = useState('overview');
  const [days, setDays] = useState('30');
  // 002-05 从 002-04 跳过来时带着学生姓名预填（所以 key 用 recordSearch 强制重挂，换人时筛选会刷新）
  const [recordSearch, setRecordSearch] = useState('');
  const [openId, setOpenId] = useState('');                  // 002-02：当前打开的课包
  const [openStudentId, setOpenStudentId] = useState('');    // 002-04：当前打开的学生
  const [draft, setDraft] = useState({ search: '', status: '' });
  const [applied, setApplied] = useState({ search: '', status: '' });
  // 「添加课包」弹窗（002-01 的常用入口也用它）：student 传 null = 弹窗里先选学生
  const [adding, setAdding] = useState(false);
  const overview = useData(() => api.get(`org/series-overview?days=${days}`), [api, days]);
  const allItems = overview.data?.items || [];
  const totals = overview.data?.totals || {};
  const items = allItems.filter((item) => {
    if (applied.search && !String(item.title || '').toLowerCase().includes(applied.search.trim().toLowerCase())) return false;
    if (applied.status === 'ACTIVE' && item.assignmentStatus !== 'ACTIVE') return false;
    if (applied.status === 'REVOKED' && item.assignmentStatus === 'ACTIVE') return false;
    return true;
  });
  const current = allItems.find((item) => item.seriesId === openId) || null;
  // 下钻明细：谁被分到了这个课包（复用「学生许可」那条接口）
  const detail = useData(
    () => (openId ? api.get(`org/course-grants?seriesId=${encodeURIComponent(openId)}`) : Promise.resolve({ items: [] })),
    [api, openId],
  );
  const detailRows = detail.data?.items || [];
  const activeRows = detailRows.filter((row) => !row.revokedAt);
  const recentGrants = [...detailRows].sort((a, b) => String(b.grantedAt).localeCompare(String(a.grantedAt))).slice(0, 5);
  const seriesOptions = allItems.map((item) => ({ id: item.seriesId, title: item.title }));

  function submitFilters(event) {
    event.preventDefault();
    setApplied(draft);
  }
  // 换页签要**清掉下钻**，否则会停在别的页签的详情里（面包屑指向错的地方）
  function goTab(next) {
    setTab(next);
    setOpenId('');
    setOpenStudentId('');
  }

  const drilling = Boolean(openId || openStudentId);
  const meta = TAB_META[tab];
  return <>
    <nav className="tabs" aria-label="课包与学生授权视图">
      {/* ⚠️ 2026-09-26 用户口径：原来是 5 个页签，最后那个「为学生添加课包」（写操作）是**跳转**到一个
          录入页，跟其余 4 个只读视角混在一起 —— 现在改成「添加课包」弹窗，页签回到 4 个只读视角。 */}
      {[['overview', '课包库存'], ['students', '学生授权中心'], ['records', '学生授权记录'], ['batches', '采购与开通记录']]
        .map(([key, label]) => <button key={key} type="button" className={'tab' + (tab === key && !drilling ? ' is-active' : '')} onClick={() => goTab(key)}>{label}</button>)}
    </nav>

    {drilling ? <nav aria-label="面包屑" className="breadcrumb row-actions">
      <button type="button" className="text-button" onClick={() => { setOpenId(''); setOpenStudentId(''); }}>机构课包库存与学生授权</button>
      {openId ? <><span className="muted" aria-hidden="true">/</span><span>{current?.title || '课包详情'}</span></> : null}
      {openStudentId ? <><span className="muted" aria-hidden="true">/</span><span>学生授权详情</span></> : null}
    </nav> : null}

    {openId ? <PageHeader eyebrow="002-02" title="单课包库存详情" description="父级：002-01 | 机构课包库存"
      actions={<button className="secondary-button" onClick={() => setOpenId('')}>← 返回课包库存</button>} />
      : openStudentId ? null
        : meta ? <PageHeader eyebrow={meta.eyebrow} title={meta.title} description={meta.description}
          actions={tab === 'overview' ? <Link className="secondary-button" to="/courses">浏览课程内容</Link> : null} /> : null}

    {openId ? <>
      {/* 002-02：课包头部 + 三张卡 + 已授权学生 + 最近授权 */}
      <Panel title="课包信息">
        <div className="row-actions">
          <strong>{current?.title || '—'}</strong>
          <span className="muted">当前版本：{current?.version ? `v${current.version}` : '—'}</span>
          <span className="muted">适用对象：{current?.ageRangeMin || current?.ageRangeMax ? `${current.ageRangeMin ?? '?'}-${current.ageRangeMax ?? '?'} 岁` : '—'}</span>
          <span className="muted">开通时间：{formatDate(current?.assignedAt)}</span>
          <EntitlementBadge status={current?.assignmentStatus} />
        </div>
        <p className="muted">机构已获得该课包的人次权益，可继续为符合条件的学生进行授权。</p>
      </Panel>
      <div className="metrics">
        <MetricCard label="总人次" value={current?.quotaTotal ?? 0} hint="平台授予 · 只读" />
        <MetricCard label="已授权" value={current?.quotaUsed ?? 0} hint="已分配给学生的" tone="teal" />
        <MetricCard label="剩余" value={current?.remaining ?? 0} hint="当前可分配库存" tone="orange" />
      </div>
      <div className="split">
        <Panel title={`已授权学生（当前 ${activeRows.length} 人）`}>
          {detail.loading ? <Loading label="正在读取授权明细…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : activeRows.length ? <div className="table-wrap"><table>
            <thead><tr><th>学生</th><th>登录账号</th><th>授权时间</th><th>授权状态</th></tr></thead>
            <tbody>{activeRows.map((row) => <tr key={row.id}>
              <td><strong>{row.studentName || row.studentLogin}</strong></td>
              <td className="muted">{row.studentLogin}</td>
              <td>{formatDate(row.grantedAt)}</td>
              <td><span className="status success">有效</span></td>
            </tr>)}</tbody>
          </table></div> : <Empty title="这个课包还没有分给任何学生" body="到「学生授权中心」把课包分给学生；每分给一人用掉 1 次。" />}
          <p className="muted top-gap">完整授权管理前往「学生授权中心」。撤销由平台兜底执行（机构侧没有撤销入口）；撤销后学生立刻进不去，已上过的课次数不退。</p>
        </Panel>
        <Panel title="最近授权">
          {recentGrants.length ? <div className="card-list">{recentGrants.map((row) => <div className="row-actions" key={row.id}>
            <span className="muted">{formatDate(row.grantedAt)}</span>
            <strong>{row.studentName || row.studentLogin}</strong>
            <span className={row.revokedAt ? 'muted' : 'status success'}>{row.revokedAt ? '已取消' : '授权成功'}</span>
            <span className="muted">-1</span>
          </div>)}</div> : <p className="muted">暂无授权记录。</p>}
        </Panel>
      </div>
    </> : openStudentId ? <StudentGrantDetail api={api} studentId={openStudentId} onBack={() => setOpenStudentId('')}
      onOpenRecords={(name) => { setOpenStudentId(''); setRecordSearch(name || ''); setTab('records'); }} />
      : tab === 'students' ? <StudentGrantCenter api={api} onOpenStudent={setOpenStudentId} />
        : tab === 'records' ? <GrantRecords key={recordSearch} api={api} seriesOptions={seriesOptions} initialSearch={recordSearch} />
        : tab === 'batches' ? <LicenseBatches api={api} seriesOptions={seriesOptions} />
          : <>
              {overview.loading ? <Loading label="正在读取课包库存…" /> : overview.error ? <ErrorState error={overview.error} onRetry={overview.refresh} /> : <>
                <div className="metrics">
                  <MetricCard label="已开通课包数" value={totals.seriesCount ?? 0} hint={`当前有效课包 ${allItems.filter((item) => item.assignmentStatus === 'ACTIVE').length} 个`} />
                  <MetricCard label="总人次" value={totals.quotaTotal ?? 0} hint="平台累计授予" tone="teal" />
                  <MetricCard label="已授权" value={totals.quotaUsed ?? 0} hint="已分配给学生的" tone="orange" />
                  <MetricCard label="剩余" value={totals.remaining ?? 0} hint="当前可分配库存" tone="pink" />
                </div>

                <Panel title="筛选">
                  <form className="filter-form" onSubmit={submitFilters}>
                    <label>课包名称<input value={draft.search} placeholder="请输入课包名称" onChange={(event) => setDraft({ ...draft, search: event.target.value })} /></label>
                    <label>权益状态<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
                      <option value="">全部</option><option value="ACTIVE">有效</option><option value="REVOKED">已禁用</option>
                    </select></label>
                    <label>课堂统计范围<select value={days} onChange={(event) => setDays(event.target.value)}>
                      {DAYS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select></label>
                    <div className="row-actions">
                      <button className="primary-button" disabled={overview.loading}>查询</button>
                      <button className="secondary-button" type="button" disabled={overview.loading} onClick={() => { setDraft({ search: '', status: '' }); setApplied({ search: '', status: '' }); }}>重置</button>
                    </div>
                  </form>
                </Panel>

                <Panel title="课包库存">
                  {items.length ? <div className="table-wrap"><table>
                    <thead><tr><th>课包</th><th>当前版本</th><th>权益状态</th><th>总人次</th><th>已授权</th><th>剩余</th><th>开通时间</th><th>操作</th></tr></thead>
                    <tbody>{items.map((item) => <tr key={item.seriesId}>
                      <td><strong>{item.title}</strong><div className="muted">机构已开通权益</div></td>
                      <td>{item.version ? `v${item.version}` : '—'}</td>
                      <td><EntitlementBadge status={item.assignmentStatus} /></td>
                      <td>{item.quotaTotal || '—'}</td>
                      <td>{item.quotaUsed}</td>
                      <td><span className="status warning">{item.remaining}</span></td>
                      <td>{formatDate(item.assignedAt)}</td>
                      <td><button type="button" className="text-button" onClick={() => setOpenId(item.seriesId)}>查看详情</button></td>
                    </tr>)}</tbody>
                  </table></div> : <Empty title="没有符合条件的课包" body="调整筛选条件，或等平台把课包授权给本机构。" />}
                </Panel>

                <Panel title="常用入口">
                  <div className="row-actions">
                    <button className="secondary-button" type="button" onClick={() => goTab('students')}>学生授权中心<div className="muted">按学生看授权</div></button>
                    <button className="secondary-button" type="button" onClick={() => goTab('batches')}>采购与开通记录<div className="muted">人次从哪来</div></button>
                    <button className="secondary-button" type="button" onClick={() => setAdding(true)}>为学生添加课包<div className="muted">弹窗分发人次</div></button>
                    <Link className="secondary-button" to="/courses">课程备课<div className="muted">课包 / 课程 / 教学资料</div></Link>
                    <Link className="secondary-button" to="/members">机构成员管理<div className="muted">学生 / 教师 / 账号</div></Link>
                  </div>
                </Panel>
              </>}
            </>}

    {adding ? <AddGrantModal api={api} source="STUDENT_CENTER" onClose={() => setAdding(false)}
      onDone={() => { setAdding(false); overview.refresh(); }} /> : null}
  </>;
}
