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
  { heading: '运营中心' },
  { to: '/dashboard', icon: '◈', label: '平台概览', permission: 'ADMIN_ANALYTICS' },
  { to: '/organizations', icon: '♙', label: '机构管理', permission: 'ADMIN_ORGANIZATIONS' },
  { to: '/users', icon: '◉', label: '平台用户', permission: 'ADMIN_ORGANIZATIONS' },
  { heading: '内容与活动' },
  { to: '/courses', icon: '▦', label: '平台课程', permission: 'ADMIN_COURSES' },
  { to: '/works', icon: '◇', label: '平台作品库', permission: 'ADMIN_WORKS' },
  { heading: '计费与设置' },
  { to: '/compute', icon: '⚡', label: '模型与算力', permission: 'ADMIN_BILLING' },
  { to: '/materials', icon: '▤', label: '素材与物料', permission: 'ADMIN_CONTENT' },
  { to: '/website-content', icon: '✎', label: '官网内容', permission: 'ADMIN_CONTENT' },
  { to: '/notifications', icon: '✉', label: '通知事件', permission: 'ADMIN_CONTENT' },
  { to: '/inbox', icon: '✉', label: '站内信', permission: 'ADMIN_CONTENT' },
  { to: '/admins', icon: '⚙', label: '平台管理员', permission: 'ADMIN_AUDIT' },
  { to: '/audit', icon: '☉', label: '操作审计', permission: 'ADMIN_AUDIT' },
  { heading: '我的账号' },
  { to: '/security', icon: '🔑', label: '账号安全', permission: null },
];

export const demos = [{ label: '平台超管', login: 'root', password: 'admin123' }];

// 官网内容区块的中文名（对应后端 website_contents.key）
export const WEBSITE_CONTENT_LABELS = { HOME: '首页', FAQ: '常见问题', BRAND: '品牌信息', ORG: '机构方案', HANDBOOK: '产品手册', COMPARE: '选型对比' };

export const ADMIN_PERMISSION_LABELS = {
  ADMIN_ORGANIZATIONS: '机构与平台用户',
  ADMIN_COURSES: '课程与课程广场',
  ADMIN_WORKS: '作品与内容审核',
  ADMIN_BILLING: '模型与算力',
  ADMIN_CONTENT: '通知、物料与官网内容',
  ADMIN_ANALYTICS: '平台概览（含官网转化）',
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
