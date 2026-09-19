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
// Chromium 版本上会被当成脚本行为挡掉）。点了没反应只说明这台电脑还没装 ——
// 所以「下载客户端」永远站在旁边，而不是等学生来问。
export const CLIENT_DEEP_LINK = 'lingdong://open';

/**
 * VibeCoding 课时卡片右边那排按钮。
 * @param lesson 这一节课（按钮文案要读它的参与状态：已完课 / 未授权 / 等待开课）
 * @param canEnter 老师已经开始这节课（`lesson.canStartVibeCoding`，服务端算的）
 * @param downloadHref 下载页地址（默认官网 `/download`）
 */
export function ClientEntryActions({ lesson, canEnter, downloadHref = '/download' }) {
  // 点不动时的那几个词沿用改版前那套口径：学生在同一张卡片上看到的原因，
  // 不该因为入口换了个地方就换一套说法。
  const reason = lesson?.participationStatus === 'COMPLETED' ? '已完课'
    : lesson?.hasGrant === false ? '未授权'
      : '等待开课';
  return <>
    {canEnter
      ? <a className="primary-button" href={CLIENT_DEEP_LINK}>打开创作客户端</a>
      : <button className="secondary-button" disabled>{reason}</button>}
    <a className="secondary-button" href={downloadHref} target="_blank" rel="noreferrer">下载客户端</a>
    {/* 右栏只有 128px 宽：这句话会自动折行，「端。」被甩到第二行很难看（实测），
        所以这里自己断行。 */}
    {canEnter ? <p className="lesson-block-reason">打开没反应？<br />先下载客户端。</p> : null}
  </>;
}
