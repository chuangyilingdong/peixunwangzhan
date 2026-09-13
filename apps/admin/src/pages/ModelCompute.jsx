import { NavLink } from 'react-router-dom';
import { Notice, PageHeader } from '@platform/shared';
import { ProviderPolicyPanel, BillingUsagePanel, OrgStudentUsagePanel } from '../components/BillingPanels.jsx';
import { GatewayPanel, PricingPanel, ComputeUsagePanel } from '../components/ComputePanels.jsx';
import { BillingSettings } from '../components/BillingSettings.jsx';
import { useLocation } from 'react-router-dom';

export function ModelCompute({ api }) {
  const location = useLocation();
  const usage = location.pathname.endsWith('/usage');
  return <>
    <PageHeader eyebrow="算力管理" title="模型与算力" description={usage ? '按机构、学员和调用记录核查用量，区分平台扣费与上游成本。' : '维护渠道与模型、平台调用单价、网关连接和能力开关。'} />
    <nav className="admin-tabs" aria-label="模型与算力视图">
      <NavLink to="/compute/config">渠道与模型配置</NavLink>
      <NavLink to="/compute/usage">用量与成本</NavLink>
    </nav>
    {usage ? <>
      <Notice>数据来源：机构与学员用量及调用明细来自平台用量记录；算力池扣费来自算力池账本；网关归集来自已连接网关。平台扣费代表按配置单价计入的额度消耗，不能直接视为供应商成本。缺少上游账单或可核对记录时，上游成本为未知，不按 0 元处理。</Notice>
      <OrgStudentUsagePanel api={api} />
      <BillingUsagePanel api={api} />
      <details className="admin-detail">
        <summary>网关归集、算力池与对账</summary>
        <ComputeUsagePanel api={api} />
      </details>
    </> : <>
      <ProviderPolicyPanel api={api} />
      <PricingPanel api={api} />
      <details className="admin-detail"><summary>网关连接与令牌管理（可选）</summary>
        <Notice>网关是可选的调用出口。启用连接不代表所有调用均经过网关，也不保证网关金额等于供应商最终账单。地址与凭据需来自实际部署的网关。</Notice>
        <GatewayPanel api={api} />
      </details>
      <BillingSettings api={api} />
    </>}
  </>;
}
