// 机构端 - 002 机构课包库存与学生授权（2026-09-17 按线框图重做，六屏齐了）
//
// 线框图把这一套拆成 002-01 库存列表 / 002-02 单课包详情 / 002-03 学生授权中心 /
// 002-04 学生授权详情 / 002-04B 单授权详情（右侧抽屉）/ 002-06 采购·增购·开通记录。
// 它们是**同一个信息面的三个视角**，所以放在一个页面用页签切换，而不是三个互不相干的路由：
//   · 课包库存（002-01 / 002-02）—— 从**课包**看「分给了谁」
//   · 学生授权中心（002-03 / 002-04 / 002-04B）—— 从**学生**看「拿到了哪些课包」
//   · 采购与开通记录（002-06）—— 看「这些人次是从哪来的」
// 「为学生添加课包」保留原有流程（那是**写**操作，其余三屏都是只读）。
//
// 与相邻页面的边界（沿用原注释，别又出现"三套东西说不清"）：
//   · 「课程中心」＝看课包内容（封面/课时/教案）
//   · 本页＝看课包的**分配与使用账**（次数、学员、课堂），并下钻到「谁被分到了」
//   · 「学员开通」＝学员的席位与有效期
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
import { StudentGrants } from './StudentGrants.jsx';
import { useState } from 'react';
import {
  Empty, ErrorState, ListResultSummary, Loading, MetricCard, Notice, PageHeader, Pagination,
  Panel, Status, formatDate, useData,
} from '@platform/shared';

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
function StudentGrantCenter({ api, onOpenStudent, onAddGrants }) {
  const [draft, setDraft] = useState({ search: '', status: '', grantState: '' });
  const [applied, setApplied] = useState({ search: '', status: '', grantState: '' });
  const [page, setPage] = useState(1);
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
    <Notice tone="info">这一屏按<strong>学生</strong>看授权。课包侧的库存、明细与「最近授权」在「课包库存」页签。</Notice>
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
          <button className="secondary-button" type="button" onClick={onAddGrants}>为学生添加课包</button>
        </div>
      </form>
    </Panel>

    <Panel title="学生授权">
      {data.loading ? <Loading label="正在读取学生授权…" /> : data.error ? <ErrorState error={data.error} onRetry={data.refresh} /> : items.length ? <>
        <ListResultSummary total={data.data?.total} page={data.data?.page} totalPages={data.data?.totalPages} label="名学生" />
        <div className="table-wrap"><table>
          <thead><tr><th>学生</th><th>登录账号</th><th>账号状态</th><th>已授权课包数</th><th>最近授权时间</th><th>授权概览</th><th>操作</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.studentId}>
            <td><strong>{item.displayName || item.login}</strong></td>
            <td className="muted">{item.login}</td>
            <td><AccountBadge status={item.status} /></td>
            <td>{item.grantedCount}</td>
            <td>{item.lastGrantedAt ? formatDate(item.lastGrantedAt) : '—'}</td>
            <td>{item.grantedSeries.length
              ? <span className="muted">{item.grantedSeries.slice(0, 3).map((series) => series.title).join('、')}{item.grantedSeries.length > 3 ? ` 等 ${item.grantedSeries.length} 个` : ''}</span>
              : <span className="muted">暂无课包</span>}</td>
            <td><button type="button" className="text-button" onClick={() => onOpenStudent(item.studentId)}>查看授权</button></td>
          </tr>)}</tbody>
        </table></div>
        <Pagination page={data.data?.page} totalPages={data.data?.totalPages} onChange={setPage} disabled={data.loading} />
      </> : <Empty title="没有符合条件的学生" body="调整筛选条件，或先在「机构成员管理」里创建学生账号。" />}
      <p className="muted top-gap">「已授权课包数」只数<strong>有效（未撤销）</strong>的授权。学生学没学是另一件事，看「查看授权」里的「正式学习记录」。</p>
    </Panel>
  </>;
}

/** 授权状态徽标：线框图 002-04 的 3 态（「已完成」口径未定，服务端不产出它）。 */
function GrantStateBadge({ item }) {
  if (item.state === 'REVOKED') return <><span className="status">已取消</span>{item.revokeReason ? <div className="muted">{item.revokeReason}</div> : null}</>;
  if (item.state === 'LEARNING') return <span className="status success">学习中</span>;
  return <span className="status warning">待激活</span>;
}

/**
 * 002-04A「添加课包」抽屉：为**一个**学生新增一笔授权。
 *
 * 候选课包规则（线框图右栏）：机构已开通 + 当前可授权 + 剩余人次 > 0 + 该学生当前无这一课包的有效授权。
 *   ⚠️ 线框图那条规则写的是「剩余人次 ≥ 0」，但紧接着又说「剩余人次 = 0 的课包不展示」——
 *      按后者实现（这也是平台口径：余额必须大于零才能分配，零次不代表不限）。
 * 只允许选 1 个：线框图「页面边界」明说不支持多选 / 批量，所以这里不接「为学生添加课包」那套批量流程。
 *
 * 候选**不新增接口**：库存与权益状态来自 series-overview、已有授权来自学生授权接口，
 * 两份数据都在手上，再开一个接口等于把同一份账算两遍。
 */
function AddGrantDrawer({ api, student, grants, onClose, onDone }) {
  const overview = useData(() => api.get('org/series-overview?days=30'), [api]);
  const [search, setSearch] = useState('');
  const [pickedId, setPickedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const heldSeries = new Set((grants || []).filter((item) => item.status === 'ACTIVE').map((item) => item.seriesId));
  const candidates = (overview.data?.items || []).filter((item) => item.assignmentStatus === 'ACTIVE'
    && Number(item.remaining || 0) > 0
    && !heldSeries.has(item.seriesId)
    && (!search.trim() || String(item.title || '').toLowerCase().includes(search.trim().toLowerCase())));
  const picked = candidates.find((item) => item.seriesId === pickedId) || null;

  async function submit() {
    if (!picked) return;
    setBusy(true); setError('');
    try {
      await api.post('org/course-grants', { seriesId: picked.seriesId, studentIds: [student.studentId] });
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return <div className="drawer-overlay" onClick={onClose}>
    <div className="drawer-panel" onClick={(event) => event.stopPropagation()}>
      <header className="drawer-head">
        <div><span className="eyebrow">002-04A</span><h2>添加课包</h2><span className="muted">父级：002-04 | 学生授权详情</span></div>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭">×</button>
      </header>
      <div className="drawer-body">
        <section className="drawer-section">
          <h3>当前学生</h3>
          <div className="row-actions"><strong>{student.displayName || student.login}</strong><span className="muted">{student.login}</span><AccountBadge status={student.status} /></div>
        </section>
        <section className="drawer-section">
          <h3>候选课包规则</h3>
          <p className="muted">仅展示：机构已开通 + 当前可授权 + 剩余人次 &gt; 0 + 该学生当前无这一课包的有效授权。</p>
          <p className="muted">一次只能选 1 个课包；已存在有效授权、权益已停用、剩余人次为 0 的课包都不展示。</p>
        </section>
        <section className="drawer-section">
          <h3>可授权课包（共 {candidates.length} 个）</h3>
          <label>搜索课包<input value={search} placeholder="输入课包名称" onChange={(event) => setSearch(event.target.value)} /></label>
          {overview.loading ? <Loading label="正在读取可授权课包…" /> : overview.error ? <ErrorState error={overview.error} onRetry={overview.refresh} /> : candidates.length ? <div className="card-list">
            {/* 这里刻意**不用** `.checkbox-option` 那套：全局 `label{display:grid}` 会把每一行拆成竖排，
                而线框图这一行是「单选 + 课包名 + 三个数字 + 状态徽标」一整行（`checkbox-option` 这个类
                其实在样式表里根本没有定义）。所以用 row-actions 排一行，label 内联 flex 覆盖 grid。 */}
            {candidates.map((item) => <div className="row-actions item-card" key={item.seriesId} style={{ justifyContent: 'space-between' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontWeight: 800 }}>
                <input type="radio" name="grant-series" style={{ width: 'auto' }} checked={pickedId === item.seriesId} onChange={() => setPickedId(item.seriesId)} />
                {item.title}
                <span className="muted">v{item.version || '—'}</span>
              </label>
              <span className="muted">总人次 {item.quotaTotal} · 已分配 {item.quotaUsed} · 剩余 {item.remaining}</span>
              <span className={'status' + (pickedId === item.seriesId ? ' success' : '')}>{pickedId === item.seriesId ? '已选择' : '可授权'}</span>
            </div>)}
          </div> : <Empty title="没有可授权的课包" body="可能原因：该学生已持有这些课包的有效授权，或课包剩余人次为 0。" />}
        </section>
        {picked ? <section className="drawer-section">
          <h3>本次授权预览</h3>
          <div className="row-actions"><strong>{picked.title}</strong><span className="muted">v{picked.version || '—'}</span></div>
          <p>授权后状态：<span className="status warning">待激活</span></p>
          <p className="muted">已分配 {picked.quotaUsed} → {Number(picked.quotaUsed) + 1} · 剩余人次 {picked.remaining} → {Number(picked.remaining) - 1} · 总人次 {picked.quotaTotal}（不变）</p>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <h3 className="top-gap">确认授权后</h3>
          <ol className="muted">
            <li>创建学生课包授权，初始状态 = 待激活</li>
            <li>已分配人次 +1，剩余人次 −1</li>
            <li>写入平台侧的授权审计与许可收入台账</li>
          </ol>
          <p className="muted">页面边界：不支持多选 / 批量授权，不设置授权有效期，不修改平台总人次。</p>
        </section> : null}
      </div>
      <footer className="drawer-foot">
        <button className="secondary-button" onClick={onClose}>取消</button>
        <button className="primary-button" disabled={!picked || busy} onClick={submit}>{busy ? '授权中…' : '确认授权'}</button>
      </footer>
    </div>
  </div>;
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
function StudentGrantDetail({ api, studentId, onBack }) {
  const data = useData(() => api.get(`org/students/${encodeURIComponent(studentId)}/course-grants`), [api, studentId]);
  const [openGrantId, setOpenGrantId] = useState('');
  const [adding, setAdding] = useState(false);
  const student = data.data?.student;
  const summary = data.data?.summary || {};
  const items = data.data?.items || [];
  const activeItems = items.filter((item) => item.status === 'ACTIVE');
  const revokedCount = summary.revokedCount ?? (items.length - activeItems.length);
  const openGrant = items.find((item) => item.id === openGrantId) || null;

  return <>
    <PageHeader eyebrow="002-04" title="学生授权详情" description="父级：002-03 | 学生授权中心"
      actions={<><button className="secondary-button" onClick={onBack}>← 返回学生授权中心</button><button className="primary-button" onClick={() => setAdding(true)}>添加课包</button></>} />
    <Notice tone="info">
      本页只管理<strong>学生课包授权</strong>关系；学习结果、作品、课堂数据不在本页处理。新增授权进入 002-04A；单条授权进入 002-04B。
      <div className="muted">撤销授权只有平台端有权限，机构端不提供该入口（因此没有 002-04C 这一步）。</div>
    </Notice>
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
        actions={<button className="secondary-button" type="button" onClick={() => setAdding(true)}>添加课包</button>}>
        {activeItems.length ? <div className="table-wrap"><table>
          <thead><tr><th>课包</th><th>当前版本</th><th>授权时间</th><th>授权状态</th></tr></thead>
          <tbody>{activeItems.map((item) => <tr key={item.id}>
            <td><button type="button" className="text-button" onClick={() => setOpenGrantId(item.id)}>{item.seriesTitle || item.seriesId}</button></td>
            <td>{item.version ? `v${item.version}` : '—'}</td>
            <td>{formatDate(item.grantedAt)}</td>
            <td><GrantStateBadge item={item} /></td>
          </tr>)}</tbody>
        </table></div> : <Empty title="该学生还没有任何课包授权" body="点右上角「添加课包」为他开一笔；每分给一人用掉 1 次。" />}
        {revokedCount ? <p className="muted top-gap">另有 {revokedCount} 条已取消的授权不在本列表（按线框图口径本页只展示未取消的）—— 撤销由平台执行，原因与时间在单授权详情里。</p> : null}
      </Panel>

      <Panel title="授权规则">
        <ol className="muted">
          <li>授权状态：待激活 / 学习中 / 已取消；本页展示当前未取消的授权。</li>
          <li>待激活＝尚未在该课包产生正式学习记录；学习中＝已进入正式课堂，或已产生有效 AI 学习记录。</li>
          <li>「查看授权」进入 002-04B 单授权详情；<strong>撤销授权只有平台端有权限</strong>，本页不提供撤销，也不做撤销资格校验。</li>
          <li>新增授权成功扣除 1 人次；误授权由平台兜底撤销，平台撤销后返还 1 人次。</li>
        </ol>
      </Panel>

      <Panel title="本页负责">
        <ol className="muted">
          <li>确认授权对象：{student?.displayName || student?.login} · {student?.login}</li>
          <li>查看学生当前课包授权及授权状态</li>
          <li>发起新增课包授权（002-04A）</li>
          <li>进入单授权详情判断后续操作（002-04B）</li>
        </ol>
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
            <p className="muted">判定口径：该学生在属于这个课包的课堂上，有过成功且<strong>非演示（mock）</strong>的 AI 调用 —— 与课堂的「完课」判定同一套条件。</p>
          </section>
          <section className="drawer-section">
            <h3>页面边界</h3>
            {/* 线框图在这里画的是「取消资格校验 5 条 + 校验结论 + 取消成功后的影响 + 取消授权按钮」。
                用户已定：机构端没有取消授权权限，所以那一整块不做 —— 连展示也不做，
                否则等于给机构看「能不能取消」却不给按钮，是误导。施工文档 一.4 有完整口径。 */}
            <p className="muted">本抽屉只做<strong>只读</strong>展示。取消授权只有平台端有权限，机构端不提供该操作，
              因此也不展示「取消资格校验」与「取消后的影响」。</p>
          </section>
        </div>
        <footer className="drawer-foot"><button className="secondary-button" onClick={() => setOpenGrantId('')}>关闭</button></footer>
      </div>
    </div> : null}

    {adding && student ? <AddGrantDrawer api={api} student={student} grants={items}
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
    <Notice tone="info">本页只列<strong>平台侧发生</strong>的人次记录，机构只读。机构把课包分给学生的消耗在「课包库存」与「学生授权中心」。</Notice>
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
      <p className="muted top-gap">
        页面边界：这里只有<strong>平台侧</strong>的采购 / 增购 / 开通 / 调整记录，机构只读；付款与合同口径以平台结算为准，
        金额不在本页展示。「初次开通 / 增购」是按批次在同一张授权单里的先后顺序推出来的（库里没有这个分类列），
        「平台调整」是平台开通时结转的期初人次。
      </p>
    </Panel>
  </>;
}

export function SeriesOverview({ api }) {
  const [tab, setTab] = useState('overview');
  const [days, setDays] = useState('30');
  const [openId, setOpenId] = useState('');                  // 002-02：当前打开的课包
  const [openStudentId, setOpenStudentId] = useState('');    // 002-04：当前打开的学生
  const [draft, setDraft] = useState({ search: '', status: '' });
  const [applied, setApplied] = useState({ search: '', status: '' });
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
  // 下钻明细：谁被分到了这个课包（复用「学员许可」那条接口）
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
      {[['overview', '课包库存'], ['students', '学生授权中心'], ['batches', '采购与开通记录'], ['grant', '为学生添加课包']]
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
        : tab === 'grant' ? null
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
          <Notice tone="info">
            这里只列<strong>学生授权</strong>引起的库存变化。
            <div className="muted">平台的采购 / 增购 / 权益调整记录在「采购与开通记录」页签（线框图里那串「53→52」的前后值数据库里没有存，不编）。</div>
          </Notice>
        </Panel>
      </div>
    </> : openStudentId ? <StudentGrantDetail api={api} studentId={openStudentId} onBack={() => setOpenStudentId('')} />
      : tab === 'students' ? <StudentGrantCenter api={api} onOpenStudent={setOpenStudentId} onAddGrants={() => goTab('grant')} />
        : tab === 'batches' ? <LicenseBatches api={api} seriesOptions={seriesOptions} />
          : tab === 'grant' ? <StudentGrants api={api} />
            : <>
              {overview.loading ? <Loading label="正在读取课包库存…" /> : overview.error ? <ErrorState error={overview.error} onRetry={overview.refresh} /> : <>
                <Notice tone="info">总人次由平台授予，机构仅查看与使用，不可在本页面直接修改总人次。</Notice>
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
                  <p className="muted top-gap">
                    次数口径：平台给本机构的授权单上是「可授权次数」，每分给一名学生用掉 1 次；余额必须大于零才能分配，零次不代表不限。
                    课堂按「这节课属于哪个课包」归集，所以待上课/上课中是<strong>当前存量</strong>，已结束是近 {days} 天内的。
                  </p>
                  {allItems.some((item) => item.grantedCount > item.quotaUsed) ? <Notice tone="info">
                    有课包的「已授权学生」多于「已授权次数」——说明其中一部分许可是<strong>演示/历史数据</strong>（没走分配计数器）。
                    剩余次数按计数器算；要核对具体是谁，点「查看详情」。
                  </Notice> : null}
                </Panel>

                <Panel title="常用入口">
                  <div className="row-actions">
                    <button className="secondary-button" type="button" onClick={() => goTab('students')}>学生授权中心<div className="muted">按学生看授权</div></button>
                    <button className="secondary-button" type="button" onClick={() => goTab('batches')}>采购与开通记录<div className="muted">人次从哪来</div></button>
                    <button className="secondary-button" type="button" onClick={() => goTab('grant')}>为学生添加课包<div className="muted">分发人次</div></button>
                    <Link className="secondary-button" to="/courses">教学课程库<div className="muted">课包 / 课程 / 教学资料</div></Link>
                    <Link className="secondary-button" to="/members">机构成员管理<div className="muted">学生 / 教师 / 账号</div></Link>
                  </div>
                  <p className="muted">机构管理员，只读查看平台授予的人次库存；采购 / 增购 / 开通记录由平台侧维护。</p>
                </Panel>
              </>}
            </>}
  </>;
}
