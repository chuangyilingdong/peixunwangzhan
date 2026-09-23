import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@platform/shared';
import { AiCapabilityPanel, OrgStudentUsagePanel } from '../components/BillingPanels.jsx';
import { ModelNamePanel } from '../components/ModelNamePanel.jsx';
import { ComputeBudgetPanel } from '../components/ComputePanels.jsx';
import { FinancialReconciliation } from '../components/FinancialReconciliation.jsx';

// 2026-09-18 页面收敛（用户口径：「一个页面一个名字」「必须做大量的减法」）。
//   · 名字统一：菜单 / 分组头 / 页面标题 / 路径都叫「AI 能力与价格」，
//     二级页签只留两个 —— 「渠道与价格」「用量与成本」（路径 /compute/config、/compute/usage）。
//   · 「AI 网关」这个说法随算力网关（new-api）UI 一起下线。
//   · 用量页删掉「高级」一级页签：它下面只有「供应商账单」与「匹配与核销」两屏，
//     而我们上游（Seedance 直连、DeepSeek）是逐笔回实扣金额、账已经在 compute_attempts 里，
//     那两屏永远是空的（用户口径：供应商账单两条线整体下线）。删掉比继续展示一份空账更诚实。
// 2026-09-23 加第三个页签「模型显示名」（用户口径：「AI能力与价格页面能否有个单独配置页面来配置映射名字」）：
//   它有自己的路径 /compute/names，是**单独一屏**（不是往渠道卡里再加一个输入框）——
//   同一件事在一张表里看全：所有已启用模型的显示名并排，改完一眼能核对。
const USAGE_VIEWS = new Set(['calls', 'orgs', 'margin']);

export function ModelCompute({ api }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const usage = location.pathname.endsWith('/usage');
  const names = location.pathname.endsWith('/names');
  const requested = searchParams.get('view');
  const view = USAGE_VIEWS.has(requested) ? requested : 'calls';
  const setView = (next) => setSearchParams({ view: next }, { replace: true });
  return <>
    <nav aria-label="面包屑" className="breadcrumb row-actions"><NavLink to="/compute/config">AI 能力与价格</NavLink>{usage ? <><span className="muted" aria-hidden="true">/</span><span>用量与成本</span></> : null}{names ? <><span className="muted" aria-hidden="true">/</span><span>模型显示名</span></> : null}</nav>
    <PageHeader eyebrow={usage ? '平台运营' : '平台配置'} title={names ? '模型显示名' : 'AI 能力与价格'}
      description={usage
        ? '看每一笔调用的对外售价与上游成本（两本账），并按机构 / 学员对照；两账与毛利看收入侧。'
        : names
          ? '给模型取一个学生看得懂的名字 —— 画布与 VibeCoding 课堂显示的就是它。只改显示：调用上游仍然用模型 ID，也不动课包快照。'
          : '三块就配完：① 渠道（怎么连上游）② 价目表（成本价与对外价并排）③ 路由与开关（用哪个渠道）。'} />
    <nav className="admin-tabs" aria-label="AI 能力与价格视图">
      <NavLink to="/compute/config">渠道与价格</NavLink>
      <NavLink to="/compute/names">模型显示名</NavLink>
      <NavLink to="/compute/usage">用量与成本</NavLink>
    </nav>
    {names ? <ModelNamePanel api={api} /> : usage ? <>
      <nav className="admin-tabs" aria-label="用量与成本视图">
        <button type="button" className={view === 'calls' ? 'active' : ''} aria-pressed={view === 'calls'} onClick={() => setView('calls')}>调用账</button>
        <button type="button" className={view === 'orgs' ? 'active' : ''} aria-pressed={view === 'orgs'} onClick={() => setView('orgs')}>机构与学员</button>
        <button type="button" className={view === 'margin' ? 'active' : ''} aria-pressed={view === 'margin'} onClick={() => setView('margin')}>两账与毛利</button>
      </nav>
      {view === 'calls' ? <FinancialReconciliation api={api} view="calls" /> : null}
      {view === 'orgs' ? <OrgStudentUsagePanel api={api} /> : null}
      {view === 'margin' ? <><FinancialReconciliation api={api} view="margin" /><ComputeBudgetPanel api={api} /></> : null}
    </> : <AiCapabilityPanel api={api} />}
  </>;
}
