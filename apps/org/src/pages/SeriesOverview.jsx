// 机构端 - 课包概览（2026-09-13，用户要求）
//
// 一句话：**机构把课包当成资源来盘** —— 每个课包可授权多少次、已经分给多少人、还剩几次、
// 多少人正在学、几个老师在开课、现在有几个课堂在等/在上的。
//
// 与相邻页面的边界（避免又出现"三套东西说不清"）：
//   · 「课程中心」＝看课包内容（封面/课时/教案）
//   · 本页＝看课包的**分配与使用账**（次数、学员、课堂），并下钻到「谁被分到了」
//   · 「学员许可」＝执行分配（勾学员、扣次数）
//   · 「学员开通」＝学员的席位与有效期
import { Link } from 'react-router-dom';
import { StudentGrants } from './StudentGrants.jsx';
import { useState } from 'react';
import { Empty, ErrorState, Loading, MetricCard, Notice, PageHeader, Panel, Status, formatDate, useData } from '@platform/shared';

export function SeriesOverview({ api }) {
  const [tab, setTab] = useState('overview');
  const [days, setDays] = useState('30');
  const [expanded, setExpanded] = useState('');
  const overview = useData(() => api.get(`org/series-overview?days=${days}`), [api, days]);
  const items = overview.data?.items || [];
  const totals = overview.data?.totals || {};
  // 下钻明细：复用「学员许可」那条接口（谁被分到了、什么时候、有没有被撤销）
  const detail = useData(
    () => (expanded ? api.get(`org/course-grants?seriesId=${encodeURIComponent(expanded)}`) : Promise.resolve({ items: [] })),
    [api, expanded],
  );
  const detailRows = detail.data?.items || [];
  const current = items.find((item) => item.seriesId === expanded) || null;
  const yuanRemaining = (item) => `${item.remaining} 次`;

  return <>
    <PageHeader
      eyebrow="课包经营"
      title="课包与授权"
      description="每个已授权课包的可授权次数、已分配、剩余，以及学员与课堂的使用情况；点课包名可下钻看「分给了谁」。"
      actions={<button className="secondary-button" onClick={overview.refresh}>刷新</button>}
    />
    <div className="row-actions"><button className="secondary-button" onClick={() => setTab('overview')}>分配概况</button><button className="secondary-button" onClick={() => setTab('grant')}>分配给学生</button><Link to="/courses">浏览课程内容</Link></div>
    {tab === 'grant' ? <StudentGrants api={api} /> : <>
    {overview.loading ? <Loading label="正在读取课包分配情况…" /> : overview.error ? <ErrorState error={overview.error} onRetry={overview.refresh} /> : <>
      <div className="metrics">
        <MetricCard label="已授权课包" value={totals.seriesCount ?? 0} hint="平台授权给本机构、且在有效期内的课包" />
        <MetricCard label="已分配 / 可授权" value={`${totals.quotaUsed ?? 0} / ${totals.quotaTotal ?? 0}`} hint={`剩余 ${totals.remaining ?? 0} 次`} tone="teal" />
        <MetricCard label="已分配学员" value={totals.grantedStudents ?? 0} hint="当前持有有效许可的学员（去重）" tone="orange" />
        <MetricCard label="进行中的课堂" value={totals.activeSessions ?? 0} hint={`另有 ${totals.pendingSessions ?? 0} 个课堂待上课`} tone="pink" />
      </div>

      <Panel title={`按课包（近 ${days} 天课堂）`} actions={
        <select value={days} onChange={(event) => setDays(event.target.value)}>
          <option value="1">近 1 天</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option>
        </select>
      }>
        {items.length ? <div className="table-wrap"><table>
          <thead><tr><th>课包</th><th>次数（已分配 / 可授权）</th><th>剩余</th><th>已分配学员</th><th>课堂（待 / 中 / 已结束）</th><th>涉及老师</th><th>明细</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.seriesId}>
            <td><strong>{item.title}</strong><div className="muted">{item.seriesId}</div></td>
            <td>{item.quotaUsed} / {item.quotaTotal || '—'}</td>
            <td>{yuanRemaining(item)}</td>
            <td>{item.grantedStudents}<div className="muted">{item.grantedCount} 人次</div></td>
            <td>{item.pendingSessions} / <strong>{item.activeSessions}</strong> / {item.endedSessions}{item.dissolvedSessions ? <span className="muted">（另解散 {item.dissolvedSessions}）</span> : null}</td>
            <td>{item.teacherCount}</td>
            <td><button type="button" className="text-button" onClick={() => setExpanded(expanded === item.seriesId ? '' : item.seriesId)}>{expanded === item.seriesId ? '收起' : '看分给了谁'}</button></td>
          </tr>)}</tbody>
        </table></div> : <Empty title="还没有被平台授权的课包" body="平台把课包授权给本机构后，这里会显示每个课包的次数与使用情况。" />}
        <p className="muted top-gap">
          次数口径：平台给本机构的授权单上是「可授权次数」，每分给一名学员用掉 1 次；余额必须大于零才能分配，零次不代表不限。
          课堂按「这节课属于哪个课包」归集，所以待上课/上课中是<strong>当前存量</strong>，已结束是近 {days} 天内的。
        </p>
        {/* 计数器与实际许可数不一致时要说出来（种子/演示数据、或平台侧直插库会出现），别让人对着两个数纳闷 */}
        {items.some((item) => item.grantedCount > item.quotaUsed) ? <Notice tone="info">
          有课包的「已分配学员」多于「已分配次数」——说明其中一部分许可是**演示/历史数据**（没走分配计数器）。
          剩余次数按计数器算；要核对具体是谁，点课包右侧的「看分给了谁」。
        </Notice> : null}
      </Panel>

      {expanded ? <Panel title={`${current?.title || '课包'} · 分给了谁`}>
        {detail.loading ? <Loading label="正在读取分配明细…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : detailRows.length ? <div className="table-wrap"><table>
          <thead><tr><th>学员</th><th>账号</th><th>分配时间</th><th>状态</th></tr></thead>
          <tbody>{detailRows.map((row) => <tr key={row.id}>
            <td><strong>{row.studentName || row.studentLogin}</strong></td>
            <td className="muted">{row.studentLogin}</td>
            <td>{formatDate(row.grantedAt)}</td>
            <td>{row.revokedAt ? <><Status value="REVOKED" /><div className="muted">{row.revokeReason || ''}</div></> : <Status value="ACTIVE" />}</td>
          </tr>)}</tbody>
        </table></div> : <Empty title="这个课包还没有分给任何学员" body="到「学员许可」页把课包分给学员；每分给一人用掉 1 次。" />}
        {detailRows.length ? <p className="muted top-gap">撤销由平台兜底执行（机构侧没有撤销入口）；撤销后学员立刻进不去，已上过的课次数不退。</p> : null}
      </Panel> : null}

      {!items.length ? <Notice tone="info">还没有授权课包时，先到「课程中心」确认平台是否已把课包授权给本机构。</Notice> : null}
    </>}
    </>}
  </>;
}
