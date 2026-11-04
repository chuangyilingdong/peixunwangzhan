import { useEffect, useRef, useState } from 'react';
import { hasAdminPermission } from '../shared.jsx';
import './../monitor.css';

const WINDOWS = [['5m', '5 分钟'], ['15m', '15 分钟'], ['60m', '60 分钟']];
const REFRESH_MS = 5000;
const BALANCE_REFRESH_MS = 60000;
const LOW_BALANCE_YUAN = 50;
const WALLET_LABELS = { 'runninghub-global': 'RH 全球站', 'runninghub-cn': 'RH 国内站', xkwuai: 'xkwuai' };

const fmtTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(11, 19) || '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
};
const fmtMinute = (value) => (value ? String(value).slice(11, 16) : '');
const fmtYuan = (fen) => `¥${(Number(fen || 0) / 100).toFixed(2)}`;
const fmtMs = (ms) => {
  if (ms === null || ms === undefined) return '—';
  const value = Number(ms);
  if (!Number.isFinite(value)) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
};
const fmtAgo = (value) => {
  if (!value) return '—';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
};
const pctText = (value) => (value === null || value === undefined ? '—' : `${value}%`);

function usePolling(fn, { intervalMs = REFRESH_MS, enabled = true, deps = [], onError } = {}) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const depKey = deps.map((item) => String(item)).join('|');
  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let timer = null;
    let controller = null;
    let delay = intervalMs;
    let busy = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(tick, intervalMs);
        return;
      }
      if (busy) {
        timer = setTimeout(tick, 1000);
        return;
      }
      busy = true;
      controller?.abort();
      controller = new AbortController();
      try {
        await fnRef.current(controller.signal);
        delay = intervalMs;
      } catch (error) {
        if (error?.name !== 'AbortError') {
          delay = Math.min(30000, Math.max(intervalMs, delay * 2));
          errorRef.current?.(error);
        }
      } finally {
        busy = false;
        if (!stopped) timer = setTimeout(tick, delay);
      }
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [enabled, intervalMs, depKey]);
}

function Sparkline({ values = [], secondary = [], height = 46 }) {
  const width = 260;
  const all = [...values, ...secondary].map((item) => Number(item || 0));
  const max = Math.max(1, ...all);
  const pointsOf = (list) => list.map((value, index) => {
    const x = list.length <= 1 ? 0 : (index / (list.length - 1)) * width;
    const y = height - (Number(value || 0) / max) * (height - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="monitor-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
      <line x1="0" y1={height - 1} x2={width} y2={height - 1} className="monitor-spark-axis" />
      {values.length > 1 ? <polyline className="monitor-spark-line" points={pointsOf(values)} /> : null}
      {secondary.length > 1 ? <polyline className="monitor-spark-line is-error" points={pointsOf(secondary)} /> : null}
    </svg>
  );
}

function Kpi({ label, value, hint, tone = 'default', children }) {
  return (
    <div className={`monitor-kpi tone-${tone}`}>
      <div className="monitor-kpi-label">{label}</div>
      <div className="monitor-kpi-value">{value}</div>
      {hint ? <div className="monitor-kpi-hint">{hint}</div> : null}
      {children}
    </div>
  );
}

function HealthDot({ level, title }) {
  return <span className={`monitor-dot is-${level}`} title={title || level} />;
}

function ErrorTable({ items, empty = '窗口内没有错误' }) {
  if (!items?.length) return <div className="monitor-empty">{empty}</div>;
  return (
    <div className="monitor-table-wrap monitor-errors">
      <table>
        <thead><tr><th>时间</th><th>级别</th><th>机构 / 课堂 / 学生</th><th>来源</th><th>错误</th></tr></thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.source}:${item.id}:${item.at}`} className={`severity-${item.severity}`}>
              <td className="monitor-nowrap">{fmtTime(item.at)}</td>
              <td><span className={`monitor-severity is-${item.severity}`}>{item.severity === 'critical' ? '严重' : item.severity === 'warning' ? '警告' : '错误'}</span></td>
              <td>
                <div>{item.orgName || '—'}</div>
                <div className="monitor-muted">{item.sessionTitle || '—'} · {item.userName || '—'}</div>
              </td>
              <td className="monitor-nowrap">{item.source === 'ATTEMPT' ? '上游' : item.source === 'USAGE' ? '应用' : item.source === 'JOB' ? '画布任务' : 'VibeCoding'}{item.failover ? ' · 备用' : ''}{item.recovered ? ' · 已恢复' : ''}</td>
              <td>
                <div className="monitor-code">{item.errorCode || 'UNKNOWN'}</div>
                {item.message ? <div className="monitor-message" title={item.message}>{item.message}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Monitor({ api, user }) {
  const canBilling = hasAdminPermission(user, 'ADMIN_BILLING');
  const [windowKey, setWindowKey] = useState('5m');
  const [orgId, setOrgId] = useState('');
  const [orgSearch, setOrgSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0);
  const [snapshot, setSnapshot] = useState(null);
  const [snapshotError, setSnapshotError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [balance, setBalance] = useState(null);
  const [balanceError, setBalanceError] = useState(null);
  const [walletHistory, setWalletHistory] = useState(null);
  const [historyRange, setHistoryRange] = useState(24);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [classroom, setClassroom] = useState(null);
  const [classroomError, setClassroomError] = useState(null);

  usePolling(async (signal) => {
    const params = new URLSearchParams({ window: windowKey });
    if (orgId) params.set('orgId', orgId);
    const data = await api.get(`admin/dashboard/monitor/snapshot?${params.toString()}`, { signal, timeoutMs: 15000 });
    setSnapshot(data);
    setUpdatedAt(new Date());
    setSnapshotError(null);
  }, { intervalMs: REFRESH_MS, enabled: !paused, deps: [windowKey, orgId, paused, tick], onError: (error) => setSnapshotError(error) });

  usePolling(async (signal) => {
    if (!canBilling) return;
    const data = await api.get('admin/dashboard/monitor/balance', { signal, timeoutMs: 20000 });
    setBalance(data);
    setBalanceError(null);
  }, { intervalMs: BALANCE_REFRESH_MS, enabled: canBilling && !paused, deps: [canBilling, paused, tick], onError: (error) => setBalanceError(error) });

  // 余额趋势：服务端 5 分钟采样落库后的历史，刷新页面不丢。
  usePolling(async (signal) => {
    if (!canBilling) return;
    const data = await api.get(`admin/dashboard/monitor/balance/history?hours=${historyRange}`, { signal, timeoutMs: 15000 });
    setWalletHistory(data);
  }, { intervalMs: BALANCE_REFRESH_MS, enabled: canBilling && !paused, deps: [canBilling, paused, historyRange, tick], onError: () => {} });

  usePolling(async (signal) => {
    if (!selectedSessionId) return;
    const data = await api.get(`admin/dashboard/monitor/classroom/${selectedSessionId}`, { signal, timeoutMs: 15000 });
    setClassroom(data);
    setClassroomError(null);
  }, { intervalMs: REFRESH_MS, enabled: Boolean(selectedSessionId) && !paused, deps: [selectedSessionId, paused, tick], onError: (error) => setClassroomError(error) });

  useEffect(() => {
    if (!selectedSessionId) { setClassroom(null); setClassroomError(null); }
  }, [selectedSessionId]);

  const live = snapshot?.live || {};
  const usage = snapshot?.usage || {};
  const series = snapshot?.series || [];
  const orgs = snapshot?.orgs || [];
  const sessions = snapshot?.sessions || [];
  const errors = snapshot?.errors || [];
  const errorTop = snapshot?.errorTop || [];
  const stuck = snapshot?.stuck || [];
  const costTop = snapshot?.costTop || [];
  const channels = snapshot?.channels || [];
  const failover = snapshot?.failover || { count: 0, success: 0, byChannel: [] };
  const studentCostTop = snapshot?.studentCostTop || [];
  const wallets = balance?.wallets?.sources || [];
  const walletTotalCny = wallets.some((item) => item.ok && item.cny !== null && item.cny !== undefined)
    ? wallets.reduce((sum, item) => sum + (item.ok && item.cny !== null && item.cny !== undefined ? Number(item.cny) : 0), 0)
    : null;
  const walletFailed = wallets.filter((item) => !item.ok).length;
  // 总余额按人民币口径比较（RH 全球 ×7.2、xkwuai 1:1），不再拿美元阈值套。
  const lowBalance = walletTotalCny !== null && walletTotalCny < LOW_BALANCE_YUAN;
  const errorRate = usage.errorRate;
  const status = lowBalance || (errorRate !== null && errorRate >= 20) ? 'critical'
    : (errorRate !== null && errorRate >= 5) || (usage.failed || 0) > 0 ? 'degraded' : 'ok';
  const statusText = status === 'critical' ? '需要处理' : status === 'degraded' ? '有异常' : '正常';

  // 页面内告警：不推飞书，直接列在页头下面（用户口径 2026-11-04）。
  const alerts = [];
  if (walletFailed) alerts.push({ key: 'wallet', level: 'warning', text: `${walletFailed} 家供应商余额读取失败（不计入总余额）` });
  if (walletTotalCny !== null && walletTotalCny < LOW_BALANCE_YUAN) {
    alerts.push({ key: 'low', level: 'danger', text: `总余额 ¥${walletTotalCny.toFixed(2)} 低于 ¥${LOW_BALANCE_YUAN}` });
  }
  if (errorRate !== null && errorRate >= 20) alerts.push({ key: 'error', level: 'danger', text: `错误率 ${errorRate}%（${windowKey} 窗口）` });
  else if (errorRate !== null && errorRate >= 5) alerts.push({ key: 'error', level: 'warning', text: `错误率 ${errorRate}%（${windowKey} 窗口）` });
  if (canBilling && usage.unknownCostCalls > 0) {
    alerts.push({ key: 'unknown', level: 'warning', text: `未知成本 ${usage.unknownCostCalls} 笔（占成功 ${usage.unknownCostRate ?? '—'}%）` });
  }
  if (stuck.length > 0) {
    alerts.push({ key: 'stuck', level: 'warning', text: `卡住任务 ${stuck.length} 个（超过 15 分钟未完成）` });
  }

  const callsSeries = series.map((item) => item.calls);
  const failedSeries = series.map((item) => item.failed);
  const costSeries = series.map((item) => item.costFen || 0);
  const balanceSeries = (walletHistory?.total || [])
    .filter((item) => item.cny !== null && item.cny !== undefined)
    .map((item) => Number(item.cny));
  const orgKeyword = orgSearch.trim().toLowerCase();
  const filteredOrgs = orgKeyword
    ? orgs.filter((org) => String(org.name || '').toLowerCase().includes(orgKeyword))
    : orgs;

  const refreshNow = () => setTick((value) => value + 1);

  return (
    <div className={`monitor-page monitor-status-${status}`}>
      <header className="monitor-head">
        <div>
          <div className="monitor-eyebrow">平台控制台 / 实时监控</div>
          <h1>实时监控 <span className={`monitor-status is-${status}`}>{statusText}</span></h1>
          <div className="monitor-sub">每 5 秒刷新 · 最后更新 {updatedAt ? fmtTime(updatedAt) : '—'} · 时间口径 UTC</div>
        </div>
        <div className="monitor-controls">
          <label>窗口
            <select value={windowKey} onChange={(event) => setWindowKey(event.target.value)}>
              {WINDOWS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button type="button" className="monitor-btn" onClick={() => setPaused((value) => !value)}>{paused ? '继续' : '暂停'}</button>
          <button type="button" className="monitor-btn" onClick={refreshNow}>刷新</button>
        </div>
      </header>

      {snapshotError ? <div className="monitor-banner is-danger">监控数据读取失败：{snapshotError.message || '未知错误'}（显示上一次数据）</div> : null}

      {alerts.length ? <div className="monitor-alerts">
        {alerts.map((alert) => <div key={alert.key} className={`monitor-banner is-${alert.level}`}>{alert.text}</div>)}
      </div> : null}

      <div className="monitor-kpis">
        <Kpi label="总余额 · 三家供应商" tone={lowBalance ? 'danger' : 'teal'}
          value={canBilling ? (walletTotalCny !== null ? `¥${walletTotalCny.toFixed(2)}` : (balanceError ? '不可用' : '读取中…')) : '无权限'}
          hint={canBilling ? (walletFailed ? `${walletFailed} 家读取失败` : undefined) : '需要「AI 能力与价格」权限'}>
          {canBilling ? (
            <>
              <div className="monitor-wallet-lines">
                {wallets.length ? wallets.map((item) => (
                  <div key={item.id} className="monitor-wallet-line">
                    <span>{WALLET_LABELS[item.id] || item.name}</span>
                    <b>{item.ok && item.cny !== null && item.cny !== undefined ? `¥${Number(item.cny).toFixed(2)}` : (item.error || '不可用')}</b>
                  </div>
                )) : <div className="monitor-wallet-line"><span>读取中…</span></div>}
              </div>
              <div className="monitor-kpi-foot">RH 全球 ×7.2 · xkwuai 1:1 · 更新 {fmtTime(balance?.fetchedAt)}</div>
            </>
          ) : null}
        </Kpi>
        <Kpi label="活跃课堂" value={live.activeSessions ?? 0} hint={`在线学生 ${live.activeStudents ?? 0}`} />
        <Kpi label="运行中任务" value={(live.runningAttempts ?? 0) + (live.vibecodingRunning ?? 0)}
          hint={`画布排队 ${live.queuedJobs ?? 0} · 运行 ${live.runningJobs ?? 0} · VibeCoding ${live.vibecodingRunning ?? 0}${snapshot?.queue?.ok ? ` · RH 队列 ${snapshot.queue.queued}/${snapshot.queue.running}` : ''}`} />
        <Kpi label={`${windowKey} 调用`} value={usage.calls ?? 0} hint={`成功 ${usage.success ?? 0} · 失败 ${usage.failed ?? 0} · 拦截 ${usage.blocked ?? 0}`} />
        <Kpi label="错误率" tone={(errorRate || 0) >= 20 ? 'danger' : (errorRate || 0) >= 5 ? 'warning' : 'default'}
          value={pctText(errorRate)} hint={canBilling ? `已知成本 ${fmtYuan(usage.knownCostFen)} · 未知 ${usage.unknownCostCalls ?? 0} 笔` : '按上游尝试计算'} />
      </div>

      <div className="monitor-charts">
        <div className="monitor-card">
          <div className="monitor-card-title">调用 / 分钟 <span>近 {windowKey} · 绿=总调用 · 红=失败</span></div>
          <Sparkline values={callsSeries} secondary={failedSeries} />
        </div>
        <div className="monitor-card">
          <div className="monitor-card-title">失败 / 分钟 <span>近 {windowKey}</span></div>
          <Sparkline values={failedSeries} />
        </div>
        {canBilling ? <div className="monitor-card">
          <div className="monitor-card-title">成本 / 分钟 <span>近 {windowKey} · 已知上游成本</span></div>
          <Sparkline values={costSeries} />
        </div> : null}
        {canBilling ? <div className="monitor-card">
          <div className="monitor-card-title">余额趋势
            <span>
              <select className="monitor-select-mini" value={historyRange} onChange={(event) => setHistoryRange(Number(event.target.value))}>
                <option value={6}>近 6 小时</option>
                <option value={24}>近 24 小时</option>
                <option value={168}>近 7 天</option>
              </select>
              {walletHistory?.bucketMinutes ? ` · ${walletHistory.bucketMinutes} 分钟采样` : ''}
            </span>
          </div>
          <Sparkline values={balanceSeries} />
        </div> : null}
      </div>

      <div className="monitor-grid">
        <section className="monitor-card">
          <div className="monitor-card-title">机构
            <span className="monitor-org-tools">
              {orgId
                ? <button type="button" className="monitor-link-btn" onClick={() => { setOrgId(''); setSelectedSessionId(''); }}>← 全部机构</button>
                : <input className="monitor-search" placeholder="搜索机构" value={orgSearch} onChange={(event) => setOrgSearch(event.target.value)} />}
              <em>{orgs.length} 家</em>
            </span>
          </div>
          <div className="monitor-table-wrap">
            <table>
              <thead><tr><th>机构</th><th>老师</th><th>学生</th><th>课堂</th><th>调用</th>{canBilling ? <th>成本</th> : null}<th>错误</th><th /></tr></thead>
              <tbody>
                {filteredOrgs.map((org) => {
                  const hasActive = Number(org.activeSessions) > 0;
                  return <tr key={org.id} className={org.id === orgId ? 'is-selected' : undefined} onClick={() => { setOrgId(org.id); setSelectedSessionId(''); }}>
                    <td><strong>{org.name}</strong><div className="monitor-muted">{org.status}</div></td>
                    <td>{org.teachers}</td>
                    <td>{org.students}</td>
                    <td>{org.activeSessions}</td>
                    <td>{org.calls}</td>
                    {canBilling ? <td>{fmtYuan(org.knownCostFen)}</td> : null}
                    <td>{org.failed}</td>
                    <td><HealthDot level={hasActive ? 'ok' : 'off'} title={hasActive ? `进行中课堂 ${org.activeSessions} 场` : '没有进行中的课堂'} /></td>
                  </tr>;
                })}
                {!filteredOrgs.length ? <tr><td colSpan={canBilling ? 8 : 7} className="monitor-empty">{orgs.length ? '没有匹配的机构' : '没有机构'}</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="monitor-card">
          <div className="monitor-card-title">活跃课堂
            <span>
              {sessions.length} 场
              {orgId ? <button type="button" className="monitor-link-btn" onClick={() => { setOrgId(''); setSelectedSessionId(''); }}>查看全部机构</button> : null}
            </span>
          </div>
          <div className="monitor-table-wrap">
            <table>
              <thead><tr><th>课堂</th><th>老师</th><th>名单 / 在线</th><th>调用</th>{canBilling ? <th>成本</th> : null}<th>错误</th><th>预算</th></tr></thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id} className={session.id === selectedSessionId ? 'is-selected' : undefined} onClick={() => setSelectedSessionId(session.id)}>
                    <td><strong>{session.title}</strong><div className="monitor-muted">{session.orgName || '—'} · {session.lessonTitle || '—'}</div></td>
                    <td>{session.teacherName || '—'}</td>
                    <td>{session.roster} / {session.activeStudents}</td>
                    <td>{session.calls}</td>
                    {canBilling ? <td>{fmtYuan(session.knownCostFen)}</td> : null}
                    <td>{session.failed}</td>
                    <td><span className={`monitor-badge is-${session.budget.state === 'OVER_BUDGET' ? 'danger' : session.budget.state === 'UNKNOWN' ? 'warning' : 'ok'}`}>{session.budget.state === 'OVER_BUDGET' ? '超预算' : session.budget.state === 'UNKNOWN' ? '成本未知' : session.budget.state === 'UNCONFIGURED' ? '未配置' : '正常'}</span></td>
                  </tr>
                ))}
                {!sessions.length ? <tr><td colSpan={canBilling ? 7 : 6} className="monitor-empty">当前没有进行中的课堂</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="monitor-grid">
        <section className="monitor-card">
          <div className="monitor-card-title">卡住任务 <span>超过 15 分钟 · 最多 20 条</span></div>
          <div className="monitor-table-wrap">
            <table>
              <thead><tr><th>类型</th><th>模态 / 模型</th><th>渠道</th><th>已等</th><th>开始于</th></tr></thead>
              <tbody>
                {stuck.map((item) => (
                  <tr key={`${item.kind}:${item.id}`}>
                    <td><strong>{item.kind === 'VIBE' ? 'VibeCoding' : item.kind === 'JOB' ? '画布任务' : '上游调用'}</strong><div className="monitor-muted">{item.status}</div></td>
                    <td>{item.modality || '—'}<div className="monitor-muted">{item.model || '—'}</div></td>
                    <td>{item.channelName || item.channelId || '—'}</td>
                    <td>{item.ageMinutes === null ? '—' : `${item.ageMinutes} 分钟`}</td>
                    <td>{fmtTime(item.createdAt)}</td>
                  </tr>
                ))}
                {!stuck.length ? <tr><td colSpan={5} className="monitor-empty">没有卡住的任务</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>

        {canBilling ? <section className="monitor-card">
          <div className="monitor-card-title">成本 Top <span>{windowKey} · 已知上游成本</span></div>
          <div className="monitor-table-wrap">
            <table>
              <thead><tr><th>渠道</th><th>模型</th><th>调用</th><th>已知成本</th><th>未知</th></tr></thead>
              <tbody>
                {costTop.map((item, index) => (
                  <tr key={`${item.channelId || 'none'}:${item.model || ''}:${item.modality || ''}:${index}`}>
                    <td><strong>{item.channelName || item.channelId || '—'}</strong><div className="monitor-muted">{item.modality || '—'}</div></td>
                    <td>{item.model || '—'}</td>
                    <td>{item.calls}<div className="monitor-muted">成功 {item.success}</div></td>
                    <td>{fmtYuan(item.knownCostFen)}</td>
                    <td>{item.unknownCalls}</td>
                  </tr>
                ))}
                {!costTop.length ? <tr><td colSpan={5} className="monitor-empty">窗口内没有调用</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section> : null}
      </div>

      <div className="monitor-grid monitor-grid-errors">
        <section className="monitor-card">
          <div className="monitor-card-title">渠道健康 <span>{windowKey} · 主备切换 {failover.count} 次（成功 {failover.success}）</span></div>
          <div className="monitor-table-wrap">
            <table>
              <thead><tr><th>渠道</th><th>调用</th><th>失败</th><th>错误率</th><th>P50 / P95</th><th>最近成功</th><th>主备切换</th></tr></thead>
              <tbody>
                {channels.map((item) => (
                  <tr key={item.channelId || 'none'} title={item.channelId || ''}>
                    <td><strong>{item.channelName}</strong><div className="monitor-muted">{item.channelId || '—'}</div></td>
                    <td>{item.calls}<div className="monitor-muted">成功 {item.success}</div></td>
                    <td>{item.failed}<div className="monitor-muted">认证 {item.authFailed} · 限流 {item.rateLimited} · 超时 {item.timeout} · HTTP {item.httpError} · 其他 {item.otherError}</div></td>
                    <td>{pctText(item.errorRate)}</td>
                    <td>{fmtMs(item.p50Ms)} / {fmtMs(item.p95Ms)}</td>
                    <td>{fmtAgo(item.lastSuccessAt)}</td>
                    <td>{item.failovers ? `${item.failovers} 次` : '—'}<div className="monitor-muted">{item.failovers ? `成功 ${item.failoverSuccess}` : ''}</div></td>
                  </tr>
                ))}
                {!channels.length ? <tr><td colSpan={7} className="monitor-empty">窗口内没有调用</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>

        {canBilling ? <section className="monitor-card">
          <div className="monitor-card-title">学生成本 Top <span>{windowKey} · 已知上游成本</span></div>
          <div className="monitor-table-wrap">
            <table>
              <thead><tr><th>学生</th><th>调用 / 未知</th><th>成本</th></tr></thead>
              <tbody>
                {studentCostTop.map((item) => (
                  <tr key={item.userId || item.name}>
                    <td><strong>{item.name}</strong></td>
                    <td>{item.calls}<div className="monitor-muted">未知 {item.unknownCalls}</div></td>
                    <td>{fmtYuan(item.knownCostFen)}</td>
                  </tr>
                ))}
                {!studentCostTop.length ? <tr><td colSpan={3} className="monitor-empty">窗口内没有学生调用</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section> : null}
      </div>

      <div className="monitor-grid monitor-grid-errors">
        <section className="monitor-card">
          <div className="monitor-card-title">错误流 <span>最近 {windowKey} · 四源合并</span></div>
          <ErrorTable items={errors} />
        </section>
        <section className="monitor-card">
          <div className="monitor-card-title">错误 Top <span>按错误码</span></div>
          {errorTop.length ? <div className="monitor-top">
            {errorTop.map((item) => <div key={item.errorCode} className="monitor-top-row">
              <span className={`monitor-dot is-${item.severity === 'critical' ? 'crit' : item.severity === 'warning' ? 'warn' : 'error'}`} />
              <span className="monitor-code">{item.errorCode}</span>
              <span className="monitor-top-count">{item.count}</span>
              <span className="monitor-muted">{fmtTime(item.lastAt)}</span>
            </div>)}
          </div> : <div className="monitor-empty">没有错误</div>}
        </section>
      </div>

      {selectedSessionId ? <>
        <div className="monitor-drawer-backdrop" onClick={() => setSelectedSessionId('')} />
        <aside className="monitor-drawer">
          <header>
            <div>
              <div className="monitor-eyebrow">课堂下钻</div>
              <h2>{classroom?.session?.title || '读取中…'}</h2>
              <div className="monitor-sub">{classroom?.session?.orgName || ''} · {classroom?.session?.teacherName || ''} · {classroom?.session?.lessonTitle || ''}</div>
            </div>
            <button type="button" className="monitor-btn" onClick={() => setSelectedSessionId('')}>关闭</button>
          </header>
          {classroomError ? <div className="monitor-banner is-danger">{classroomError.message}</div> : null}
          {classroom ? <>
            <div className="monitor-kpis monitor-kpis-small">
              <Kpi label="名单 / 在线" value={`${classroom.students.length} / ${classroom.students.filter((item) => item.rosterStatus === 'ACTIVE').length}`} />
              <Kpi label="调用" value={classroom.totals.calls} hint={`成功 ${classroom.totals.success} · 失败 ${classroom.totals.failed}`} />
              <Kpi label="已知成本" value={fmtYuan(classroom.totals.knownCostFen)} hint={`未知 ${classroom.totals.unknownCostCalls} 笔`} />
              <Kpi label="预算" value={classroom.budget.budgetFen === null ? '未配置' : fmtYuan(classroom.budget.budgetFen)} hint={classroom.budget.state} />
            </div>
            <div className="monitor-table-wrap">
              <table>
                <thead><tr><th>学生</th><th>状态</th><th>调用</th><th>成功 / 失败</th><th>成本</th><th>未知</th><th>最后活动</th></tr></thead>
                <tbody>
                  {classroom.students.map((student) => <tr key={student.userId}>
                    <td><strong>{student.name}</strong><div className="monitor-muted">{student.login || ''}</div></td>
                    <td>{student.rosterStatus === 'ACTIVE' ? '在线' : student.rosterStatus}</td>
                    <td>{student.calls}</td>
                    <td>{student.success} / {student.failed}</td>
                    <td>{fmtYuan(student.knownCostFen)}</td>
                    <td>{student.unknownCostCalls}</td>
                    <td>{fmtTime(student.lastAt)}</td>
                  </tr>)}
                  {!classroom.students.length ? <tr><td colSpan={7} className="monitor-empty">名单为空</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="monitor-card-title top-gap">这堂课最近的错误</div>
            <ErrorTable items={classroom.errors} empty="这堂课没有错误" />
          </> : null}
        </aside>
      </> : null}
    </div>
  );
}
