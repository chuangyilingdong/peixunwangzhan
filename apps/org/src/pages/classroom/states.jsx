// 课堂的状态与类型口径（四个页面共用）。
//
// 四态：待上课 / 上课中 / 已结束 / 已解散 —— 与服务端 class_sessions.status 一一对应；
// 学员六态比课堂多两个终态（已完课 / 未完课）外加「被移除」。
// ⚠️「上课类型」是**平台**在课包课时里设定的（可同时开画布 + VibeCoding），老师只读不改，
//    所以这里只负责把值翻成人话，不提供任何入口让老师改。
export const SESSION_STATE = {
  PENDING: { label: '待上课', tone: 'warning' },
  ACTIVE: { label: '上课中', tone: 'success' },
  ENDED: { label: '已结束', tone: 'muted' },
  DISSOLVED: { label: '已解散', tone: 'danger' },
};

export const STUDENT_STATE = {
  ...SESSION_STATE,
  COMPLETED: { label: '已完课', tone: 'success' },
  INCOMPLETE: { label: '未完课', tone: 'danger' },
  REMOVED: { label: '被移除', tone: 'muted' },
};

export const DELIVERY_LABEL = { CANVAS: '画布课堂', VIBECODING: 'VibeCoding 课堂' };

export function StateBadge({ value, map = SESSION_STATE }) {
  const item = map[value] || { label: value || '未知状态', tone: 'muted' };
  return <span className={'status ' + (item.tone === 'muted' ? '' : item.tone)}>{item.label}</span>;
}

export function publishedModes(lesson) {
  return (lesson?.deliveryModes?.length ? lesson.deliveryModes : [lesson?.deliveryMode])
    .filter((mode) => Object.hasOwn(DELIVERY_LABEL, mode));
}

/** 课时的上课类型标签（可能两个都开：画布 + VibeCoding）。 */
export const deliveryModeLabels = (lesson) => publishedModes(lesson).map((mode) => DELIVERY_LABEL[mode]);

export function removedReasonLabel(reason) {
  const labels = {
    SESSION_LESSON_SWAP: '课程已更换，原名单已移除',
    SESSION_DISSOLVE: '课堂已解散，学员已移除',
    SESSION_DISSOLVED: '课堂已解散，学员已移除',
    DISSOLVED: '课堂已解散，学员已移除',
    SESSION_STUDENT_REMOVE: '老师已移除该学员',
    MANUAL: '老师手动移除',
  };
  return labels[reason] || (/^[A-Z][A-Z0-9_]*$/.test(reason) ? '学员已移除' : reason);
}
