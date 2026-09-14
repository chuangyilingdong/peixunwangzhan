import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { Notice, PageHeader } from '@platform/shared';
import { ProviderPolicyPanel } from '../components/BillingPanels.jsx';
import { GatewayPanel, PricingPanel } from '../components/ComputePanels.jsx';
import { BillingSettings } from '../components/BillingSettings.jsx';
import { FinancialReconciliation } from '../components/FinancialReconciliation.jsx';

const FINANCIAL_VIEWS = new Set(['calls', 'bills', 'matching', 'margin']);

export function ModelCompute({ api }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const usage = location.pathname.endsWith('/usage');
  const requestedView = searchParams.get('view');
  const view = FINANCIAL_VIEWS.has(requestedView) ? requestedView : 'calls';
  const setView = (next) => setSearchParams({ view: next }, { replace: true });
  return <>
    <PageHeader eyebrow="算力管理" title="模型与算力" description={usage ? '核查调用账、供应商账、匹配核销与真实毛利。' : '维护渠道与模型、上游成本估算、网关连接和能力开关。'} />
    <nav className="admin-tabs" aria-label="模型与算力视图">
      <NavLink to="/compute/config">渠道与模型配置</NavLink>
      <NavLink to="/compute/usage">财务与对账</NavLink>
    </nav>
    {usage ? <>
      <nav className="admin-tabs" aria-label="财务与对账四视图">
        <button type="button" className={view === 'calls' ? 'active' : ''} aria-pressed={view === 'calls'} onClick={() => setView('calls')}>调用账</button>
        <button type="button" className={view === 'bills' ? 'active' : ''} aria-pressed={view === 'bills'} onClick={() => setView('bills')}>供应商账单</button>
        <button type="button" className={view === 'matching' ? 'active' : ''} aria-pressed={view === 'matching'} onClick={() => setView('matching')}>匹配与核销</button>
        <button type="button" className={view === 'margin' ? 'active' : ''} aria-pressed={view === 'margin'} onClick={() => setView('margin')}>三账与毛利</button>
      </nav>
      <FinancialReconciliation api={api} view={view} />
    </> : <>
      <ProviderPolicyPanel api={api} />
      <PricingPanel api={api} />
      <GatewayPanel api={api} />
      <BillingSettings api={api} />
    </>}
  </>;
}
