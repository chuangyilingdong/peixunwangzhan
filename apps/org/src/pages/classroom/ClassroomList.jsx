// 005-01 我的课堂列表（2026-09-17 按线框图重做）。
//
// 与旧版的差别：① 四张状态卡取自服务端的 statusCounts（不再是「本页里数一数」，
// 那样一分页就只数到当前页）；② 筛选栏补上「课包 / 课程」两个维度 + 显式的查询/重置；
// ③ 表格按线框图拆开「创建时间 / 实际开始 / 实际结束」；④ 底部有真实分页。
import { useMemo, useState } from 'react';
import { Empty, ErrorState, formatDate, ListResultSummary, Loading, MetricCard, Notice, Pagination, PageHeader, Panel, SearchSelect, useData } from '@platform/shared';
import { ParentLine } from './ui.jsx';
import { DELIVERY_LABEL, SESSION_STATE, StateBadge } from './states.jsx';

const DAYS_OPTIONS = [['7', '近 7 天'], ['30', '近 30 天'], ['90', '近 90 天'], ['365', '近 1 年']];
const TONES = { PENDING: 'orange', ACTIVE: 'teal', ENDED: 'violet', DISSOLVED: 'pink' };
const emptyFilters = { search: '', status: '', seriesId: '', lessonId: '', days: '90' };

function statusHint(key, count) {
  if (key === 'PENDING') return count ? `${count} 个待上课课堂` : '当前无待上课课堂';
  if (key === 'ACTIVE') return count ? (count === 1 ? '当前唯一进行中课堂' : `${count} 个进行中课堂`) : '当前无进行中课堂';
  return `${count} 历史课堂`;
}

// 三个时间列用紧凑格式（线框图就是 09-15 09:40）：整表九列，
// 再用 formatDate 的「2026年9月17日 17:05」会把「操作」列挤出可视区。
// 完整时间挂在 title 上，鼠标停一下就能看到。
function shortTime(value) {
  const raw = String(value || '');
  if (!raw) return '—';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ClassroomList({ api, isAdmin, onOpen, onCreate }) {
  const [draft, setDraft] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const series = useData(() => api.get('org/course-series?limit=200'), [api]);
  const seriesItems = series.data?.items || [];
  const query = useMemo(() => {
    const value = new URLSearchParams({ days: applied.days, page: String(page) });
    for (const key of ['search', 'status', 'seriesId', 'lessonId']) if (applied[key]) value.set(key, applied[key]);
    return value.toString();
  }, [applied, page]);
  const list = useData(() => api.get('org/sessions?' + query), [api, query]);
  const sessions = list.data?.items || [];
  const statusCounts = list.data?.statusCounts || {};
  const total = Number(list.data?.total || 0);
  const ongoing = list.data?.ongoingSession || null;
  // 一个老师同时只能有一个未终态课堂（服务端 assertTeacherSessionAvailable 的口径）。
  // 机构管理员不受这条限制，所以只对「我负责的课堂」提示。
  const blocking = !isAdmin ? Number(statusCounts.PENDING || 0) + Number(statusCounts.ACTIVE || 0) : 0;

  const lessonOptions = useMemo(() => {
    const source = applied.seriesId ? seriesItems.filter((item) => item.id === applied.seriesId) : seriesItems;
    return source.flatMap((item) => (item.lessons || [])
      .filter((lesson) => lesson.status === 'PUBLISHED')
      .map((lesson) => ({ id: lesson.id, label: `第 ${lesson.sort} 节 · ${lesson.title}`, seriesTitle: item.title })));
  }, [seriesItems, applied.seriesId]);

  function submit(event) {
    event.preventDefault();
    setPage(1);
    setApplied(draft);
  }
  function reset() {
    setDraft(emptyFilters);
    setApplied(emptyFilters);
    setPage(1);
  }

  return <div className="classrooms-page">
    <PageHeader eyebrow="开课与上课" title="我的课堂列表"
      description={isAdmin ? '本机构全部课堂；可按课堂名称、状态、课包与课程筛选。' : '仅展示当前登录账号自己创建的课堂。'}
      actions={onCreate ? <button className="primary-button" disabled={blocking > 0} onClick={onCreate}>创建课堂</button> : null} />

    {blocking > 0 ? <Notice tone="warning">
      当前账号已有 {blocking} 个「待上课 / 上课中」课堂，因此不能创建新的课堂。
      <div className="muted">结束或解散当前课堂后，创建课堂按钮会恢复可用。{ongoing ? <> 当前课堂：{ongoing.title}（{SESSION_STATE[ongoing.status]?.label || ongoing.status}）。</> : null}</div>
    </Notice> : <Notice tone="success">
      当前账号无「待上课 / 上课中」课堂，可以创建新的课堂。
      <div className="muted">保存成功后新课堂状态为「待上课」，学生将在课堂创建后单独添加。</div>
    </Notice>}

    <div className="metrics">
      {Object.entries(SESSION_STATE).map(([key, item]) => (
        <MetricCard key={key} label={item.label} value={statusCounts[key] ?? 0} hint={statusHint(key, Number(statusCounts[key] || 0))} tone={TONES[key]} />
      ))}
    </div>

    <Panel title="筛选课堂">
      <form className="filter-form" onSubmit={submit}>
        <label>课堂名称<input value={draft.search} placeholder="请输入课堂名称" onChange={(event) => setDraft({ ...draft, search: event.target.value })} /></label>
        <label>状态<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
          <option value="">全部状态</option>
          {Object.entries(SESSION_STATE).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
        </select></label>
        <label>课包<SearchSelect ariaLabel="按课包筛选" value={draft.seriesId} options={seriesItems} placeholder="全部课包"
          getLabel={(item) => item.title} onChange={(seriesId) => setDraft({ ...draft, seriesId, lessonId: '' })} /></label>
        <label>课程<SearchSelect ariaLabel="按课程筛选" value={draft.lessonId} options={lessonOptions} placeholder="全部课程"
          getLabel={(item) => item.label} onChange={(lessonId) => setDraft({ ...draft, lessonId })} /></label>
        <label>时间范围<select value={draft.days} onChange={(event) => setDraft({ ...draft, days: event.target.value })}>
          {DAYS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <div className="row-actions">
          <button className="primary-button" disabled={list.loading}>查询</button>
          <button className="secondary-button" type="button" disabled={list.loading} onClick={reset}>重置</button>
        </div>
      </form>
    </Panel>

    <Panel title="我的课堂">
      {list.loading ? <Loading label="正在读取课堂…" /> : list.error ? <ErrorState error={list.error} onRetry={list.refresh} /> : sessions.length ? <>
        <div className="table-wrap"><table>
          <thead><tr>
            <th>课堂名称</th><th>课包</th><th>课程</th><th>学生数</th><th>状态</th>
            <th>创建时间</th><th>实际开始</th><th>实际结束</th><th>操作</th>
          </tr></thead>
          <tbody>{sessions.map((item) => <tr key={item.id}>
            <td><strong>{item.title || '未命名课堂'}</strong><div className="muted">{DELIVERY_LABEL[item.deliveryMode] || item.deliveryMode || '—'}{isAdmin && item.teacherName ? ` · ${item.teacherName}` : ''}</div></td>
            <td>{item.seriesTitle || '—'}</td>
            <td>{item.lessonTitle || '—'}{item.lessonSort ? <div className="muted">第 {item.lessonSort} 节</div> : null}</td>
            <td>{item.studentCount ?? 0}<div className="muted">完课 {item.completedCount ?? 0}</div></td>
            <td><StateBadge value={item.status} /></td>
            <td>{shortTime(item.createdAt)}</td>
            <td title={formatDate(item.startedAt)}>{shortTime(item.startedAt)}</td>
            <td title={formatDate(item.endedAt)}>{shortTime(item.endedAt)}{item.status === 'DISSOLVED' && item.endedAt ? <div className="muted">解散时间</div> : null}</td>
            <td><button className="text-button" onClick={() => onOpen(item.id)}>查看详情</button></td>
          </tr>)}</tbody>
        </table></div>
        <ListResultSummary total={total} page={list.data?.page || 1} totalPages={list.data?.totalPages || 1} label="条课堂记录" />
        <Pagination page={list.data?.page || 1} totalPages={list.data?.totalPages || 1} onChange={setPage} disabled={list.loading} />
      </> : <Empty title="没有符合条件的课堂" body="调整筛选条件，或创建一个新课堂。" />}
    </Panel>
  </div>;
}
