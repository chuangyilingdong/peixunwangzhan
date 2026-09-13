// 平台端「模型与算力」（2026-09-13 合并页）
//
// 为什么合并：原来「算力网关」（/compute）和「计费与模型」（/billing）是两个页面 ——
// 上游渠道与模型在一边、网关与单价与池子在另一边，配一次要来回跳（用户反馈：理解成本太高）。
// 现在一页按**五步**排好，每步右上角能看出「配好了没有」：
//   ① 上游渠道与模型（多渠道 / 每渠道多模型 / 能力路由 / 每模型能力 / 用当前渠道试一次）
//   ② 每次调用单价（对学生的售价，算力池按它扣钱）
//   ③ 算力网关（可选：想让上游调用经网关出口、并拿到精确账单时才需要）
//   ④ 用量与账单（网关归集 / 算力池 / 两本账对账 / 逐条明细）
//   ⑤ 模态开关与预警
// 步骤条只是**导航**：每一步自己加载自己的数据，点步骤就滚到那一段。
import { useState } from 'react';
import { Empty, Loading, Notice, PageHeader, Panel, useData } from '@platform/shared';
import { ProviderPolicyPanel, BillingUsagePanel, OrgStudentUsagePanel } from '../components/BillingPanels.jsx';
import { GatewayPanel, PricingPanel, ComputeUsagePanel } from '../components/ComputePanels.jsx';
import { BillingSettings } from '../components/BillingSettings.jsx';

const STEPS = [
  { id: 'step-channels', no: '①', title: '上游渠道与模型', hint: '配供应商、密钥、模型清单，再把每个能力指到某个渠道' },
  { id: 'step-pricing', no: '②', title: '每次调用单价', hint: '对学生的售价（含毛利）；算力池按「单价 × 调用次数」扣' },
  { id: 'step-gateway', no: '③', title: '算力网关（可选）', hint: '要精确账单、或想把额度管在网关侧时才需要' },
  { id: 'step-usage', no: '④', title: '用量与账单', hint: '钱花在哪：网关归集 / 学员池子 / 两本账 / 逐条明细' },
  { id: 'step-switches', no: '⑤', title: '模态开关与预警', hint: '平台级总开关，以及给运营看的阈值' },
];

/** 步骤条：显示每步的状态（已配置 / 待配置 / 可选 / 只读），点一下滚到那一段。 */
function StepNav({ statuses }) {
  function jump(id) {
    const node = typeof document !== 'undefined' ? document.getElementById(id) : null;
    node?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }
  return <Panel title="配置步骤（按顺序走一遍就行）">
    <div className="step-nav">
      {STEPS.map((step) => {
        const status = statuses[step.id];
        const tone = status?.tone || 'muted';
        return <button type="button" key={step.id} className={`step-chip is-${tone}`} onClick={() => jump(step.id)}>
          <b>{step.no}{step.title}</b>
          {status?.label ? <span className="step-chip__state">{status.label}</span> : null}
          <span className="muted">{step.hint}</span>
        </button>;
      })}
    </div>
    <p className="muted">只有前两步是必须的：配好渠道与模型、定好单价，学生就能用了。第③步是可选的精确计费出口，第④⑤步是看账和开关。</p>
  </Panel>;
}

export function ModelCompute({ api }) {
  const config = useData(() => api.get('admin/compute-gateway'), [api]);
  const policy = useData(() => api.get('admin/billing-config/ai-provider'), [api]);
  const pools = useData(() => api.get('admin/compute-pools?limit=1'), [api]);
  const [message] = useState('');

  const channels = policy.data?.policy?.channels || [];
  const routing = policy.data?.policy?.modalityChannels || {};
  const routedModalities = Object.values(routing).filter(Boolean).length;
  const gatewayEnabled = config.data?.config?.enabled === true;
  const pricing = pools.data?.pricing;

  const statuses = {
    'step-channels': channels.length
      ? { label: `${channels.length} 个渠道 · ${routedModalities} 个能力已指定`, tone: routedModalities ? 'ok' : 'warn' }
      : { label: '待配置', tone: 'warn' },
    'step-pricing': pricing?.updatedAt ? { label: '已填过单价', tone: 'ok' } : { label: '用的还是默认单价', tone: 'warn' },
    'step-gateway': gatewayEnabled ? { label: '已启用', tone: 'ok' } : { label: '未启用（可选）', tone: 'muted' },
    'step-usage': { label: '只读', tone: 'muted' },
    'step-switches': { label: '只读 / 配置', tone: 'muted' },
  };

  const loadingSummary = config.loading || policy.loading || pools.loading;

  return <>
    <PageHeader
      eyebrow="算力总控"
      title="模型与算力"
      description="一页走完：上游渠道与模型 → 每次调用单价 → 算力网关（可选）→ 用量与账单 → 开关与预警。"
      actions={<button className="secondary-button" onClick={() => { config.refresh(); policy.refresh(); pools.refresh(); }}>刷新概览</button>}
    />
    {message ? <Notice tone="danger">{message}</Notice> : null}
    {loadingSummary ? <Loading label="正在读取配置概览…" /> : <StepNav statuses={statuses} />}

    <div id="step-channels" className="step-section">
      <Panel title="① 上游渠道与模型">
        <p className="muted">先加渠道（供应商 / 协议 / 地址 / 密钥），每个渠道用「读取模型」勾出<strong>这个渠道能用的多个模型</strong>；
          再用「能力路由」把 文本 / 图片 / 音乐 / 视频 分别指到某个渠道 —— 路由才是最终生效的选择。
          填完建议点一次「<strong>用当前渠道试一次</strong>」：它会拿当前参数真发一次最小请求，上游不认就直接告诉你原因。</p>
      </Panel>
    </div>
    <ProviderPolicyPanel api={api} />
    {!channels.length ? <Empty title="还没有渠道" body="上面的「渠道列表」里点「＋添加渠道」开始配第一个渠道。" /> : null}

    <div id="step-pricing" className="step-section" />
    <PricingPanel api={api} />

    <div id="step-gateway" className="step-section">
      <Panel title="③ 算力网关（可选）">
        <p className="muted">不启用也能正常用：学生的每个能力都按上面的单价从算力池扣。
          启用后，上游调用改成经网关出口，你能拿到<strong>精确账单</strong>（步骤④的「两本账对账」才有的对），
          也能在网关侧按令牌额度再兜一层。渠道与密钥要在 new-api 那侧维护，这里的「渠道池」是只读的。</p>
      </Panel>
    </div>
    <GatewayPanel api={api} />

    <div id="step-usage" className="step-section">
      <Panel title="④ 用量与账单">
        <p className="muted">四个角度看同一笔钱：<strong>按机构下钻到学员</strong>（谁花了多少，可导出台账）、<strong>网关归集</strong>（按令牌名还原到机构 / 学员 / 课时，只有启用网关才有）、
          <strong>算力池</strong>（每个学员在每个课包上花了多少、还剩多少）、<strong>两本账对账</strong>（池子按售价、网关按上游实耗，差额就是毛利）。</p>
      </Panel>
    </div>
    <OrgStudentUsagePanel api={api} />
    <ComputeUsagePanel api={api} />
    <BillingUsagePanel api={api} />

    <div id="step-switches" className="step-section" />
    <BillingSettings api={api} />
  </>;
}
