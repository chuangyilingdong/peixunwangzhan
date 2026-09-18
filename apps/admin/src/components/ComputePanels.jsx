// 平台端「AI 能力与价格」页的面板（2026-09-13：从原 ComputeGateway.jsx 拆出）。
//
// 2026-09-18 只剩一个面板 ComputeBudgetPanel（平台侧成本预警，挂在「用量与成本 → 两账与毛利」下）。
// 同一天删掉的两个面板与理由（用户口径「大量减法、简单明了」）：
//   · GatewayPanel（算力网关 / new-api）—— 生产一直没启用（上游本身已经是网关），
//     留在页面上只会让人以为「这个必须配」；后端接口不动，等真要用再接回来。
//   · PricingPanel（对外售价）—— 它和渠道卡里的「上游合同单价」是**两个 API、两个面板**填同一件事的两半价。
//     现已并进「渠道与价格 → ② 价目表」的同一行（成本价与对外价并排 + 毛利列），见 BillingPanels.jsx。
import { ErrorState, Loading, Panel, useData } from '@platform/shared';

/** 金额（元）显示：归集结果里已经是元，别再套积分格式。 */
const yuan = (value) => value == null ? '未知' : `¥${Number(value).toFixed(2)}`;

/**
 * 平台侧的成本预警（按课堂 / 按课时）。
 * 原来这个组件（ComputeUsagePanel）里还有一张「上游调用与成本」表，与「调用账」重复且信息更少
 * （没有对外售价、没有上游成本与差额），已删掉；逐笔明细一律看调用账。
 */
export function ComputeBudgetPanel({ api }) {
  const budgets = useData(() => api.get('admin/compute-pools?limit=500'),[api]);
  const money = fen => fen == null ? '未知' : yuan(fen / 100);
  const state = {UNKNOWN:'成本未知',OVER_BUDGET:'超额预警（仍可调用）',WITHIN_BUDGET:'已知成本在基准内',UNCONFIGURED:'未配置预警基准'};
  return <>
    <Panel title="每场课堂平台预警" actions={<button className="secondary-button" onClick={budgets.refresh}>刷新</button>}>
      <p>每场课堂使用课时配置的总预警基准，不随参与人数放大，不阻止学生调用。成本包含失败、在途与成功尝试；未知部分单列。</p>
      {budgets.loading ? <Loading/> : budgets.error ? <ErrorState error={budgets.error} onRetry={budgets.refresh}/> : <div className="table-wrap"><table><thead><tr><th>机构 / 课堂</th><th>参与人数</th><th>预警基准</th><th>已知成本小计</th><th>超出</th><th>未知尝试</th><th>预警</th></tr></thead><tbody>{budgets.data?.items?.map(item=><tr key={item.sessionId}><td>{item.orgName} · {item.sessionTitle || item.lessonTitle}</td><td>{item.studentCount}</td><td>{item.budgetFen == null ? '未配置' : money(item.budgetFen)}</td><td>{money(item.knownCostFen)}</td><td className={item.overBudgetFen ? 'danger-text' : ''}>{item.budgetState === 'OVER_BUDGET' ? (item.overBudgetFen == null ? '含未知' : '+' + money(item.overBudgetFen)) : '—'}</td><td>{item.unknownCalls}</td><td>{state[item.budgetState]}</td></tr>)}</tbody></table></div>}
    </Panel>
    <Panel title="课时跨机构汇总">
      <p>相同课时合并所有机构课堂；预警基准合计为每场基准 × 场次，超额课堂单列。</p>
      <div className="table-wrap"><table><thead><tr><th>课时</th><th>机构 / 场次</th><th>预警基准合计</th><th>已知成本小计</th><th>超出合计</th><th>未知尝试 / 超额课堂</th></tr></thead><tbody>{budgets.data?.lessons?.map(item=><tr key={item.lessonId}><td>{item.lessonTitle}</td><td>{item.orgCount} / {item.sessionCount}</td><td>{item.budgetFen == null ? '未配置' : money(item.budgetFen)}</td><td>{money(item.knownCostFen)}</td><td className={item.overBudgetFen ? 'danger-text' : ''}>{item.overBudgetSessions ? (item.overBudgetFen == null ? '含未知' : '+' + money(item.overBudgetFen)) : '—'}</td><td>{item.unknownCalls} / {item.overBudgetSessions}</td></tr>)}</tbody></table></div>
    </Panel>
  </>;
}
