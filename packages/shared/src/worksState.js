// 学生作品「在作品广场上的状态」——两条链路（画布 works / VibeCoding vibecoding_submissions）共用一套词。
//
// 为什么要有这个文件（2026-09-12，梳理文档第 5 节）：两条链路以前各说一套 ——
// 画布看 `status`（PENDING/APPROVED/REJECTED/PUBLISHED，且**下架复用了「被拒」的 REJECTED**、
// 语义含糊），VibeCoding 看 `is_public` 布尔；平台端两个面板也因此显示得不一样（精选只在画布那栏有）。
// 现在的口径（用户要求「一页看全、字段一致」）：
//   **对外只讲四件事** —— 已提交待发布 / 已发布到作品广场 / 精选 / 已下架（含原因）。
// 这一层是**只读推导**：不动库里已有的 status 语义（那是下一步「统一状态机」要迁移的事），
// 但用户看到的话术从此只有一套（平台端、学生端都调这里）。
// ⚠️ 纯逻辑写成 .js（不是 .jsx）：这样 scripts/ 下的守卫能用 node 直接 import 它跑断言。
export const WORK_PLAZA_STATES = Object.freeze(['SUBMITTED', 'PLAZA', 'FEATURED', 'UNPUBLISHED']);
const LABELS = Object.freeze({
  SUBMITTED: '已提交待发布',
  PLAZA: '已发布到作品广场',
  FEATURED: '精选',
  UNPUBLISHED: '已下架',
});
// 与 Status 组件的色调一致：success 绿 / warning 黄 / muted 灰
const TONES = Object.freeze({ SUBMITTED: 'warning', PLAZA: 'success', FEATURED: 'success', UNPUBLISHED: 'muted' });

/** 这两条链路的「在广场上」字段名不同：画布是 plazaPublished（来自 is_public），VibeCoding 是 isPublic。 */
export function inWorkPlaza(item) {
  return item?.plazaPublished === true || item?.isPublic === true;
}

/**
 * 推导一条作品对外的状态。
 * 优先级：**已下架**（有原因且不在广场）> 精选 > 在广场 > 已提交。
 * ⚠️ 「在广场」以**实际字段**为准（不是 status）：画布链路下架时把 status 改成 REJECTED，但
 *    is_public 不一定同步，所以两条链路统一用 plazaPublished/isPublic 判断，避免再次各说一套。
 */
export function workPlazaState(item) {
  if (!item) return 'SUBMITTED';
  if (!inWorkPlaza(item) && item.unpublishReason) return 'UNPUBLISHED';
  if (item.featured === true) return 'FEATURED';
  if (inWorkPlaza(item)) return 'PLAZA';
  return 'SUBMITTED';
}

export function workPlazaLabel(item) {
  return LABELS[workPlazaState(item)] || LABELS.SUBMITTED;
}

export function workPlazaTone(item) {
  return TONES[workPlazaState(item)] || 'muted';
}
