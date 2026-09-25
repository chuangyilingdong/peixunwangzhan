// VibeCoding 的入口：**在客户端里做，不在网页里做**（2026-09-19 用户口径）。
//
// 这个文件换掉的是原来的 `runtimeWorkspace.jsx`：那时网页上点「进入创作环境」会由平台
// 在服务器上拉起一台 dsh 盒子、再新标签页打开它（还有配套的「提交作品」）。
// 用户口径：「网站上的 dsh 就不要了，以后 vibecoding 就是在客户端进行」——
// 所以网页这一屏现在只做一件事：**把学生送到他自己的电脑上的客户端**。
// ⚠️ 别再往这里加任何"在网页里开创作环境"的按钮：网页不拉起任何创作环境。
//
// 为什么用 `<a href="lingdong://…">` 而不是按钮 + `location.href`：`lingdong://` 是装客户端时
// 注册进系统的协议，只有**真正的导航**才会被交给系统去拉起应用（按钮里手动赋值在某些
// Chromium 版本上会被当成脚本行为挡掉）。
//
// ⚠️ 2026-09-25 用户口径：课时卡片上**只留「打开创作客户端」** —— 原来并排的「下载客户端」
//    按钮和「打开没反应？先下载客户端。」那句引导文案一起删掉。
//    （客户端下载在官网导航与页脚还留着，只是不再挂在课时卡片上。）
export const CLIENT_DEEP_LINK = 'lingdong://open';

/**
 * VibeCoding 课时卡片右边那排按钮。
 * @param lesson 这一节课（按钮文案要读它的参与状态：已完课 / 未授权 / 等待开课）
 * @param canEnter 老师已经开始这节课（`lesson.canStartVibeCoding`，服务端算的）
 */
export function ClientEntryActions({ lesson, canEnter }) {
  // 点不动时的那几个词沿用改版前那套口径：学生在同一张卡片上看到的原因，
  // 不该因为入口换了个地方就换一套说法。
  const reason = lesson?.participationStatus === 'COMPLETED' ? '已完课'
    : lesson?.hasGrant === false ? '未授权'
      : '等待开课';
  return canEnter
    ? <a className="primary-button" href={CLIENT_DEEP_LINK}>打开创作客户端</a>
    : <button className="secondary-button" disabled>{reason}</button>;
}
