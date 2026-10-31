// 生成失败的**统一人话**（2026-10-31 用户口径）。
//
// 上游把同一件事分成几种说法：英文 content review、中文「内容审核失败」、
// 以及失败两次后的「12 小时冷却期」。平台原来把它们拼成
// 「AI 服务暂时不可用（…）」/「AI 服务请求频率受限（…）」，学生看不懂。
// 统一成「内容审核没通过」，并给出唯一可执行的动作。
//
// ⚠️ 服务端 `apps/server/src/services/providerContract.js` 有同一份正则与文案；
//    两边要同步（服务端管新任务和历史 job，前端管画布快照里的旧 generationError）。
export const CONTENT_REVIEW_MESSAGE = '内容审核没通过。请调整提示词或参考素材后再试。';
const CONTENT_REVIEW_PATTERN = /content\s*(review|safety|policy)|safety\s*system|moderation|内容审核|内容安全|内容未通过|审核(?:失败|未通过|没通过)|冷却期|filtered\s*by[^.]*safety|rejected[^.]*(?:safety|content)/i;

export function isContentReviewFailure(value) {
  return CONTENT_REVIEW_PATTERN.test(String(value || ''));
}

export function normalizeGenerationErrorMessage(value) {
  const message = String(value || '');
  return isContentReviewFailure(message) ? CONTENT_REVIEW_MESSAGE : message;
}

/** 画布快照里旧节点可能还存着长文案；只改显示用的副本，不动其它字段。 */
export function normalizeSnapshotGenerationErrors(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.nodes)) return snapshot;
  let changed = false;
  const nodes = snapshot.nodes.map((node) => {
    const current = node?.data?.generationError;
    const normalized = normalizeGenerationErrorMessage(current);
    if (normalized === String(current || '')) return node;
    changed = true;
    return { ...node, data: { ...node.data, generationError: normalized } };
  });
  return changed ? { ...snapshot, nodes } : snapshot;
}
