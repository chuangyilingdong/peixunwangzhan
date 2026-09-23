import { PageHeader, Panel, PasswordChangeForm } from '@platform/shared';

const ORG_ROLE_LABEL = { ORG_ADMIN: '机构管理员', TEACHER: '授课教师' };

/**
 * 机构端「账号安全」（2026-09-23 用户口径）：
 * 「机构端/老师端/学生端创建了账号后，他们应该是有自行修改密码的按钮和操作」。
 *
 * 在这之前机构端改密码只有一条路 —— **让机构管理员在「机构成员管理」里替你改**
 * （那条接口改的是别人，`PUT org/members/:id/password`）。这一页对的是**自己**：
 * 接口 `PUT org/me/password`，机构管理员与老师都能用。
 *
 * 表单本身在三端共用（packages/shared/src/account.jsx 的 PasswordChangeForm）——
 * 平台端那页（apps/admin/src/pages/Security.jsx）也换成了同一个组件，
 * 免得三处的校验规则、错误文案、改密后行为各说各话。
 */
export function AccountSecurity({ api, user, onSignedOut }) {
  return <>
    <PageHeader eyebrow="我的账号" title="账号安全" description="修改你自己的登录密码。机构管理员与老师都能自己改，不用再找机构管理员代改。" />
    <Panel title="当前账号">
      <p className="muted">登录名 <strong>{user?.login || '—'}</strong> · 角色 <strong>{ORG_ROLE_LABEL[user?.role] || user?.role || '—'}</strong></p>
    </Panel>
    <Panel title="登录密码">
      <PasswordChangeForm api={api} endpoint="org/me/password" onSignedOut={onSignedOut} />
    </Panel>
  </>;
}
