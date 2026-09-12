// 统一的作品广场状态标签（两条链路一套词）。纯逻辑在 worksState.js —— 拆开是因为 scripts/ 下的守卫
// 要用 node 直接 import 纯逻辑跑断言，而 node 不认 .jsx。
import { workPlazaLabel, workPlazaState, workPlazaTone } from './worksState.js';

export function WorkPlazaStatus({ item, className = 'status' }) {
  const state = workPlazaState(item);
  const reason = state === 'UNPUBLISHED' && item?.unpublishReason ? `下架原因：${item.unpublishReason}` : undefined;
  return <span className={`${className} ${workPlazaTone(item)}`} title={reason}>{workPlazaLabel(item)}</span>;
}
