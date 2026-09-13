// 学生作品「在作品广场上的状态」——两条链路（画布 works / VibeCoding vibecoding_submissions）共用一套词。
//
// 为什么要有这个文件（2026-09-12，梳理文档第 5 节）：两条链路以前各说一套 ——
// 画布看 `status`（PENDING/APPROVED/REJECTED/PUBLISHED），VibeCoding 看 `is_public` 布尔；
// 平台端两个面板也因此显示得不一样（精选只在画布那栏有）。
// 现在的口径（用户要求「一页看全、字段一致」）：
//   对外讲五件事 —— 已提交待发布 / 已发布到作品广场 / 精选 / **未通过** / 已下架（含原因）。
//
// ⚠️ 2026-09-13（C2）存储层已经统一：画布的「下架」现在写独立状态 `UNPUBLISHED` +
//    独立原因列 `works.unpublish_reason`，**不再复用 REJECTED 与 teacher_comment**。
//    这一层仍保持「按实际字段推导」而不是直接读 status，原因有两条：
//      ① VibeCoding 链路没有 status，只有 is_public + unpublish_reason；
//      ② 历史行（C2 之前下架的）是 REJECTED + teacher_comment，没法可靠区分，读取时兜底保持原话术。
// ⚠️ 纯逻辑写成 .js（不是 .jsx）：这样 scripts/ 下的守卫能用 node 直接 import 它跑断言。
export const WORK_PLAZA_STATES = Object.freeze(['SUBMITTED', 'PLAZA', 'FEATURED', 'REJECTED', 'UNPUBLISHED']);
const LABELS = Object.freeze({
  SUBMITTED: '已提交待发布',
  PLAZA: '已发布到作品广场',
  FEATURED: '精选',
  REJECTED: '未通过',
  UNPUBLISHED: '已下架',
});
// 与 Status 组件的色调一致：success 绿 / warning 黄 / muted 灰
const TONES = Object.freeze({ SUBMITTED: 'warning', PLAZA: 'success', FEATURED: 'success', REJECTED: 'danger', UNPUBLISHED: 'muted' });

/** 这两条链路的「在广场上」字段名不同：画布是 plazaPublished（来自 is_public），VibeCoding 是 isPublic。 */
export function inWorkPlaza(item) {
  return item?.plazaPublished === true || item?.isPublic === true;
}

/**
 * 推导一条作品对外的状态。
 * 优先级：**已下架**（有下架状态或原因，且不在广场）> 精选 > 在广场 > **未通过**（审核不通过）> 已提交。
 * ⚠️ 「在广场」以**实际字段**为准（不是 status），两条链路统一用 plazaPublished/isPublic 判断。
 * ⚠️ 「已下架」优先于「未通过」：历史行下架时写的是 REJECTED + teacher_comment，
 *    那种行有原因但没有 unpublish 状态，按原因判成「已下架」才与 C2 之前的话术一致。
 */
export function workPlazaState(item) {
  if (!item) return 'SUBMITTED';
  if (!inWorkPlaza(item) && (item.status === 'UNPUBLISHED' || item.unpublishReason)) return 'UNPUBLISHED';
  if (item.featured === true) return 'FEATURED';
  if (inWorkPlaza(item)) return 'PLAZA';
  if (item.status === 'REJECTED') return 'REJECTED';
  return 'SUBMITTED';
}

export function workPlazaLabel(item) {
  return LABELS[workPlazaState(item)] || LABELS.SUBMITTED;
}

export function workPlazaTone(item) {
  return TONES[workPlazaState(item)] || 'muted';
}
