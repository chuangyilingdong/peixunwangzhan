// 平台管理端共用：CSV 下载、侧栏导航、权限判定与标签。
import { Notice, PageHeader } from '@platform/shared';

// 服务端返回 { filename, content }，这里统一触发浏览器下载
export function downloadCsv(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'export.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export const navigation = [
  { heading: '平台工作台' },
  { to: '/dashboard', icon: '◈', label: '平台工作台', permission: 'ADMIN_ANALYTICS' },
  { heading: '课包与课程' },
  { to: '/courses', icon: '▦', label: '课包与课程编排', permission: 'ADMIN_COURSES' },
  // 2026-09-18 一个页面一个名字（用户口径）：菜单 / 分组头 / 页面标题 / 路径统一成「AI 能力与价格」。
  // 「AI 网关」这个词随算力网关（new-api）UI 一起下线 —— 生产未启用，留着只会让人以为要配。
  { heading: 'AI 能力与价格' },
  { to: '/compute/config', icon: '⚡', label: 'AI 能力与价格', permission: 'ADMIN_BILLING' },
  { heading: '机构与课包人次' },
  { to: '/organizations', icon: '♙', label: '机构与课包人次', permission: 'ADMIN_ORGANIZATIONS' },
  // 官网「联系我们」表单的提交收件箱（2026-09-18：此前只有接口没有页面，提交没人看得见）
  { to: '/leads', icon: '☎', label: '联系我们（商机）', permission: 'ADMIN_ORGANIZATIONS' },
  { to: '/authorizations', icon: '▦', label: '授权与人次流水', permission: 'ADMIN_BILLING' },
  { to: '/users', icon: '◉', label: '平台用户', permission: 'ADMIN_ORGANIZATIONS' },
  { heading: '用量与成本' },
  { to: '/compute/usage', icon: '◌', label: '用量与成本', permission: 'ADMIN_BILLING' },
  { heading: '作品管理与发布' },
  { to: '/works', icon: '◇', label: '学生作品库与发布', permission: 'ADMIN_WORKS' },
  { heading: '内容运营' },
  { to: '/materials', icon: '▤', label: '素材与物料', permission: 'ADMIN_CONTENT' },
  { to: '/website-content', icon: '✎', label: '官网内容', permission: 'ADMIN_CONTENT' },
  { to: '/notifications', icon: '✉', label: '通知事件', permission: 'ADMIN_CONTENT' },
  { to: '/inbox', icon: '✉', label: '站内信', permission: 'ADMIN_CONTENT' },
  { heading: '系统管理' },
  { to: '/admins', icon: '⚙', label: '平台管理员', permission: 'ADMIN_AUDIT' },
  { to: '/audit', icon: '☉', label: '操作审计', permission: 'ADMIN_AUDIT' },
  { to: '/client-update', icon: '⇧', label: '客户端更新', permission: 'ADMIN_AUDIT' },
  { to: '/security', icon: '🔑', label: '账号安全', permission: null },
];

// ⚠️ 2026-09-23：这里原来导出 `demos`（平台超管的登录名 + 口令），喂给登录页的「演示账号」区块。
//    用户口径「演示账号这些全部删除」—— 口令明文写在前端包里（打包后的 .js 谁都能下载）、
//    而且指的是生产上真在用的账号，所以整块删掉，别再从这里导出任何口令。

// 官网内容区块的中文名（对应后端 website_contents.key）
export const WEBSITE_CONTENT_LABELS = { HOME: '首页', FAQ: '常见问题', BRAND: '品牌信息', ORG: '机构方案', HANDBOOK: '机构手册', COMPARE: '选型对比', MARKETPLACE: '灵动课程' };

export const ADMIN_PERMISSION_LABELS = {
  ADMIN_ORGANIZATIONS: '机构与平台用户',
  ADMIN_COURSES: '课程与课程广场',
  ADMIN_WORKS: '作品与内容审核',
  ADMIN_BILLING: 'AI 能力与价格',
  ADMIN_CONTENT: '通知、物料与官网内容',
  ADMIN_ANALYTICS: '平台概览与统计',
  ADMIN_AUDIT: '平台管理员与操作审计',
};

export function hasAdminPermission(user, permission) {
  if (!permission) return true;
  const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
  return user?.login === 'root' || permissions.includes('*') || permissions.includes(permission)
    || Object.keys(ADMIN_PERMISSION_LABELS).every((item) => permissions.includes(item));
}

export function visibleNavigation(user) {
  const output = []; let pendingHeading = null;
  for (const item of navigation) {
    if (item.heading) { pendingHeading = item; continue; }
    if (!hasAdminPermission(user, item.permission)) continue;
    if (pendingHeading) { output.push(pendingHeading); pendingHeading = null; }
    output.push(item);
  }
  return output;
}

export function AdminPermissionGate({ user, permission, children }) {
  if (hasAdminPermission(user, permission)) return children;
  return <><PageHeader eyebrow="平台权限" title="暂无访问权限" description="当前账号没有该业务域的访问权限。" /><Notice tone="danger">需要权限码：<strong>{permission}</strong>（{ADMIN_PERMISSION_LABELS[permission] || permission}）。如需访问，请联系平台管理员授权。</Notice></>;
}

export function isoDateInput(iso) {
  return iso ? new Date(iso).toISOString().slice(0, 10) : '';
}
