/**
 * 画布框体节点 ↔ 最新生成任务 的同步规则（纯函数，2026-11-04）。
 *
 * 为什么单独抽出来：这段逻辑决定「生成成功后错误提示会不会消失」，
 * 而画布是 JSX、不能直接在 node 里 import 组件；按项目既有约定（见 boxRules.js），
 * 把判定做成纯函数，守卫直接跑状态矩阵。
 *
 * 关键口径：
 *   · 最新任务 SUCCEEDED → **无论节点上是否已经有素材**，都要把 generationStatus/generationError 清掉。
 *     旧实现只在「节点还没有 assetUrl」时才清，导致内容审核失败后重试成功、错误提示一直挂着。
 *   · 最新任务 FAILED 且节点还在 PENDING → 落 FAILED + 人话错误。
 *   · 其它情况返回 null（不改）。
 */
import { normalizeGenerationErrorMessage } from './generationErrors.js';

export function syncNodeGeneration(node, job, assetPatch = null) {
  if (!node || !job) return null;
  const status = String(job.status || '');
  const data = node.data && typeof node.data === 'object' ? node.data : {};

  if (status === 'SUCCEEDED') {
    const hasOutput = Boolean(data.assetUrl || data.generatedText);
    if (assetPatch && !hasOutput) {
      return {
        ...node,
        data: { ...data, ...assetPatch, generationStatus: null, generationError: '', generationStartedAt: null },
      };
    }
    // 已经有成果、但状态还停在 FAILED/PENDING（重试成功/刷新后回填）：只清状态，不覆盖已有成果。
    if (data.generationStatus || data.generationError) {
      return { ...node, data: { ...data, generationStatus: null, generationError: '', generationStartedAt: null } };
    }
    return null;
  }

  if (status === 'FAILED' && data.generationStatus === 'PENDING') {
    return {
      ...node,
      data: { ...data, generationStatus: 'FAILED', generationError: normalizeGenerationErrorMessage(job.errorMessage) || '生成失败' },
    };
  }
  return null;
}
