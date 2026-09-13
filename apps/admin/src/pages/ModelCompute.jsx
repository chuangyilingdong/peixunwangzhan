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
    <PageHeader eyebrow="算力管理" title="模型与算力" description={usage ? '按机构、学员和调用记录核查用量，查看已知上游成本与未知记录。' : '维护渠道与模型、上游成本估算、网关连接和能力开关。'} />
    <nav className="admin-tabs" aria-label="模型与算力视图">
      <NavLink to="/compute/config">渠道与模型配置</NavLink>
      <NavLink to="/compute/usage">用量与成本</NavLink>
    </nav>
    {usage ? <>
      <Notice>用户包算力。课堂总预算仅预警，超额仍可调用。金额来自上游尝试记录，历史售价不是真实上游成本；未知不按零处理。机构归属来自服务器会话，内部调用密钥不发送到浏览器。</Notice>
      <OrgStudentUsagePanel api={api} />
      <BillingUsagePanel api={api} />
      <details className="admin-detail">
        <summary>课堂平台预警与跨机构课时汇总</summary>
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
