import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { Notice, PageHeader } from '@platform/shared';
import { ProviderPolicyPanel, OrgStudentUsagePanel } from '../components/BillingPanels.jsx';
import { GatewayPanel, PricingPanel, ComputeBudgetPanel } from '../components/ComputePanels.jsx';
import { BillingSettings } from '../components/BillingSettings.jsx';
import { FinancialReconciliation } from '../components/FinancialReconciliation.jsx';

// 2026-09-15 重排（用户反馈「好多东西、好混乱」）：
//   · 默认三屏就是用户要的两条主线 —— 配好渠道与售价 / 按机构与学员对照消耗。
//   · 「供应商账单」「匹配与核销」只对**按账期开票**的上游有用；我们上游（Seedance 直连）
//     是逐笔回实扣金额的，这两屏永远是空的，所以收进「高级」里，不再占默认视野。
//   · 「算力网关」生产里一直是关的、而且上游本身就是一层 new-api 网关，同样收进「高级」；
//     没有直接删掉 —— 删了组件留下后端就是死代码，那正是这次要清理的问题。
const FINANCIAL_VIEWS = new Set(['calls', 'orgs', 'margin', 'advanced']);
const ADVANCED_VIEWS = new Set(['bills', 'matching']);

export function ModelCompute({ api }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const usage = location.pathname.endsWith('/usage');
  const requested = searchParams.get('view');
  const view = FINANCIAL_VIEWS.has(requested) ? requested : 'calls';
  // 「高级」里再分供应商账单 / 匹配与核销两个子视图
  const advancedView = ADVANCED_VIEWS.has(searchParams.get('advanced')) ? searchParams.get('advanced') : 'bills';
  const setView = (next) => setSearchParams(next === 'advanced' ? { view: next, advanced: advancedView } : { view: next }, { replace: true });
  const setAdvanced = (next) => setSearchParams({ view: 'advanced', advanced: next }, { replace: true });
  return <>
    <PageHeader eyebrow="算力管理" title="模型与算力"
      description={usage
        ? '看每一笔调用的对外售价与我们的实际成本，并按机构 / 学员对照；三账与毛利看收入侧。'
        : '维护渠道与模型、定对外售价。日常只需要这两块，网关与能力开关在页面底部。'} />
    <nav className="admin-tabs" aria-label="模型与算力视图">
      <NavLink to="/compute/config">渠道与模型配置</NavLink>
      <NavLink to="/compute/usage">用量与成本</NavLink>
    </nav>
    {usage ? <>
      <nav className="admin-tabs" aria-label="用量与成本视图">
        <button type="button" className={view === 'calls' ? 'active' : ''} aria-pressed={view === 'calls'} onClick={() => setView('calls')}>调用账</button>
        <button type="button" className={view === 'orgs' ? 'active' : ''} aria-pressed={view === 'orgs'} onClick={() => setView('orgs')}>机构与学员</button>
        <button type="button" className={view === 'margin' ? 'active' : ''} aria-pressed={view === 'margin'} onClick={() => setView('margin')}>三账与毛利</button>
        <button type="button" className={view === 'advanced' ? 'active' : ''} aria-pressed={view === 'advanced'} onClick={() => setView('advanced')}>高级</button>
      </nav>
      {view === 'calls' ? <FinancialReconciliation api={api} view="calls" /> : null}
      {view === 'orgs' ? <OrgStudentUsagePanel api={api} /> : null}
      {view === 'margin' ? <><FinancialReconciliation api={api} view="margin" /><ComputeBudgetPanel api={api} /></> : null}
      {view === 'advanced' ? <>
        <Notice tone="info">这两屏只对<strong>按账期开票</strong>的上游有用：要把供应商账单导进来、再人工匹配核销。
          我们现在用的上游（Seedance 直连、DeepSeek）都是<strong>逐笔回实扣金额</strong>的，
          成本在调用时就已经记进账本了，所以这里通常是空的 —— 不需要配，也不影响调用账的数字。</Notice>
        <nav className="admin-tabs" aria-label="高级对账视图">
          <button type="button" className={advancedView === 'bills' ? 'active' : ''} aria-pressed={advancedView === 'bills'} onClick={() => setAdvanced('bills')}>供应商账单</button>
          <button type="button" className={advancedView === 'matching' ? 'active' : ''} aria-pressed={advancedView === 'matching'} onClick={() => setAdvanced('matching')}>匹配与核销</button>
        </nav>
        <FinancialReconciliation api={api} view={advancedView} />
      </> : null}
    </> : <>
      <ProviderPolicyPanel api={api} />
      <PricingPanel api={api} />
      <details className="top-gap">
        <summary>高级：算力网关与能力总开关</summary>
        <p className="muted">算力网关用于把调用转给一层 new-api 再出网（生产当前未启用，上游本身已是网关）；
          「模态开关」是平台级总开关，关掉后学生无法使用对应能力。</p>
        <GatewayPanel api={api} />
        <BillingSettings api={api} />
      </details>
    </>}
  </>;
}
