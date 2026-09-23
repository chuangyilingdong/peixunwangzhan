// 官网 - 学生「账号安全」（2026-09-23 用户口径）
//   「机构端/老师端/学生端创建了账号后，他们应该是有自行修改密码的按钮和操作」。
// 学生端在这之前只有**接口**（PUT /api/student/account/password，守卫 p37 一直钉着它），
// **界面上没有入口** —— 学生改不了密码，只能让老师/机构管理员替他改。
// 表单本身三端共用：packages/shared/src/account.jsx 的 PasswordChangeForm。
import { PasswordChangeForm } from '@platform/shared';

export function StudentAccountPage({ api, user, onSignedOut }) {
  return <div className="student-page">
    <header className="student-page-head">
      <h1>账号安全</h1>
      <p>修改你自己的登录密码。改完所有设备上的登录都会退出，需要用新密码重新登录。</p>
    </header>
    <section className="student-account">
      <p className="muted">登录名 <strong>{user?.login || '—'}</strong></p>
      <PasswordChangeForm api={api} endpoint="student/account/password" onSignedOut={onSignedOut} submitLabel="修改密码" />
    </section>
  </div>;
}
