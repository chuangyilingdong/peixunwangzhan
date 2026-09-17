// 机构端 - 002 机构课包库存与学生授权（2026-09-17 按线框图重做）
//
// 线框图把这一套拆成 002-01 库存列表 / 002-02 单课包详情 / 002-03 学生授权中心 /
// 002-04 学生授权详情 / 002-06 采购·增购·开通记录。本轮先落 **002-01 + 002-02**，
// 并保留原有的「分配给学生」入口（等 002-03/04 做完再合并进来，别中途把功能删掉）。
//
// 与相邻页面的边界（沿用原注释，别又出现"三套东西说不清"）：
//   · 「课程中心」＝看课包内容（封面/课时/教案）
//   · 本页＝看课包的**分配与使用账**（次数、学员、课堂），并下钻到「谁被分到了」
//   · 「学员开通」＝学员的席位与有效期
//
// ⚠️ 线框图里「授权状态：待激活 / 学习中」这一层**数据库里没有**（student_course_grants 只有
//    granted_at/revoked_at，没有任何状态列）。按用户口径**不伪造**：只用
//    「有效（未撤销）/ 已取消（有 revoked_at）」两态。同理，单课包详情里的「学习记录
//    已产生/未产生」现在也没有字段支撑，**不显示**，等有口径再加。
import { Link } from 'react-router-dom';
import { StudentGrants } from './StudentGrants.jsx';
import { useState } from 'react';
import { Empty, ErrorState, Loading, MetricCard, Notice, PageHeader, Panel, Status, formatDate, useData } from '@platform/shared';

const DAYS_OPTIONS = [['1', '近 1 天'], ['7', '近 7 天'], ['30', '近 30 天'], ['90', '近 90 天']];

/** 权益状态：有效 / 已禁用（平台撤销授权）—— 只有这两态，没有「待激活」。 */
function EntitlementBadge({ status }) {
  if (!status) return <Status value="NONE" />;
  return <span className={'status' + (status === 'ACTIVE' ? ' success' : '')}>{status === 'ACTIVE' ? '有效' : '已禁用'}</span>;
}

export function SeriesOverview({ api }) {
  const [tab, setTab] = useState('overview');
  const [days, setDays] = useState('30');
  const [openId, setOpenId] = useState('');          // 002-02：当前打开的课包
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

  function submitFilters(event) {
    event.preventDefault();
    setApplied(draft);
  }

  return <>
    {tab === 'grant' || openId ? <nav aria-label="面包屑" className="breadcrumb row-actions">
      <button type="button" className="text-button" onClick={() => { setOpenId(''); setTab('overview'); }}>机构课包库存与学生授权</button>
      {openId ? <><span className="muted" aria-hidden="true">/</span><span>{current?.title || '课包详情'}</span></> : null}
      {tab === 'grant' ? <><span className="muted" aria-hidden="true">/</span><span>为学生添加课包</span></> : null}
    </nav> : null}

    {openId ? <PageHeader eyebrow="002-02" title="单课包库存详情" description={`父级：002-01 | 机构课包库存`}
      actions={<button className="secondary-button" onClick={() => setOpenId('')}>← 返回课包库存</button>} />
      : <PageHeader eyebrow="002-01" title="机构课包库存" description="查看机构当前拥有的课包权益、人次库存及使用情况"
        actions={<Link className="secondary-button" to="/courses">浏览课程内容</Link>} />}

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
            这里只列**学生授权**引起的库存变化。
            <div className="muted">平台的采购 / 增购 / 权益调整记录在平台侧，机构端不展示（线框图里那串「53→52」的前后值数据库里也没有存，不编）。</div>
          </Notice>
        </Panel>
      </div>
    </> : <>
      {tab === 'grant' ? <StudentGrants api={api} /> : <>
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
              有课包的「已授权学生」多于「已授权次数」——说明其中一部分许可是**演示/历史数据**（没走分配计数器）。
              剩余次数按计数器算；要核对具体是谁，点「查看详情」。
            </Notice> : null}
          </Panel>

          <Panel title="常用入口">
            <div className="row-actions">
              <button className="secondary-button" type="button" onClick={() => setTab('grant')}>学生授权中心<div className="muted">为学生添加课包</div></button>
              <Link className="secondary-button" to="/courses">教学课程库<div className="muted">课包 / 课程 / 教学资料</div></Link>
              <Link className="secondary-button" to="/members">机构成员管理<div className="muted">学生 / 教师 / 账号</div></Link>
            </div>
            <p className="muted">机构管理员，只读查看平台授予的人次库存；采购 / 增购 / 开通记录由平台侧维护。</p>
          </Panel>
        </>}
      </>}
    </>}
  </>;
}
