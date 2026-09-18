// P03「机构与课包人次」四个页面共用的展示件（2026-09-18 按线框图对齐）。
//
// 为什么单独一个文件：机构列表（P03-01）/ 机构详情（P03-02）/ 机构课包与授权次数（P03-03）/
// 授权次数变更记录（P03-04）都要「机构卡 + 状态徽标 + 脱敏电话」，抄四份迟早漂。
//
// 口径（用户 2026-09-18 定死）：
//   ① 平台侧**没有**「算力额度」，只有**授权次数**：总授权次数 / 已授权次数 / 剩余授权次数（= 前两者之差）。
//      界面上不出现「算力额度」「总人次」「已分配人次」。
//   ② 状态一律中文徽标（启用 / 禁用），不把 ACTIVE / DISABLED 枚举原文甩给用户。
import { Link } from 'react-router-dom';
import { formatDate } from '@platform/shared';

/** 机构状态枚举 → 中文徽标文案（organizations.status：TRIAL/ACTIVE/FROZEN/DISABLED/EXPIRED）。 */
export const ORGANIZATION_STATUS_TEXT = {
  ACTIVE: '启用',
  TRIAL: '试用中',
  FROZEN: '已冻结',
  DISABLED: '禁用',
  EXPIRED: '已过期',
};

export function organizationStatusText(status) {
  return ORGANIZATION_STATUS_TEXT[String(status || '').toUpperCase()] || '未知状态';
}

/** 机构状态徽标：启用=绿，禁用/冻结/过期=红，试用=橙。 */
export function OrganizationStatusBadge({ status = '' }) {
  const value = String(status || '').toUpperCase();
  const tone = value === 'ACTIVE' ? 'success' : ['DISABLED', 'FROZEN', 'EXPIRED'].includes(value) ? 'danger' : 'warning';
  return <span className={'status ' + tone}>{organizationStatusText(value)}</span>;
}

/** 机构开课包的状态（course_assignments.status）→ 中文。 */
export const ASSIGNMENT_STATUS_TEXT = { ACTIVE: '已开通', REVOKED: '已撤销' };

export function AssignmentStatusBadge({ status = '' }) {
  const value = String(status || '').toUpperCase();
  return <span className={'status ' + (value === 'ACTIVE' ? 'success' : 'muted')}>{ASSIGNMENT_STATUS_TEXT[value] || '未知状态'}</span>;
}

/**
 * 联系电话脱敏（**在前端做**，2026-09-18 用户口径）。
 *
 * 为什么不在后端做：平台端目前返回的是明文号码（`organizations.contact.phone`），仓里也没有
 * `phoneMasked` 这类字段 —— 而机构详情/列表是「看一眼就走」的页面，完整号码摊在屏幕上会被
 * 截图、投屏、录屏带走。后端若哪天补了脱敏字段，这个函数就是删除点（改成读字段即可）。
 *
 * 规则：11 位手机号保留前 3 位 + 后 4 位 → `13800138000` → `138****8000`；
 *      固话/带区号/带分机这类保留前 3 位 + 后 2 位；短于 6 位直接整串打码，
 *      免得「脱敏」之后反而只剩原样（`1234` 打码成 `1234` 就白脱了）。
 */
export function maskPhone(phone) {
  const text = String(phone ?? '').trim();
  if (!text) return '';
  if (/^1\d{10}$/.test(text)) return `${text.slice(0, 3)}****${text.slice(7)}`;
  if (text.length <= 5) return '*'.repeat(text.length);
  return `${text.slice(0, 3)}****${text.slice(-2)}`;
}

/**
 * 机构卡（图3 / 图5 / 图8 顶部那张）：
 * 图标 + 名称 + 状态徽标 + 联系人 + **脱敏电话** + 创建时间；
 * 机构简称 / 机构编码 / 所属区域**有就显示**（这三个字段服务端还在补，见交接文档第二节）。
 */
export function OrganizationCard({ organization = {}, meta = null, actions = null }) {
  const contact = organization.contact || {};
  const extra = [
    organization.shortName ? `机构简称：${organization.shortName}` : null,
    organization.orgCode ? `机构编码：${organization.orgCode}` : null,
    organization.region ? `所属区域：${organization.region}` : null,
  ].filter(Boolean);
  return <section className="panel org-summary">
    <div className="org-summary-identity">
      <span className="avatar" aria-hidden="true">♙</span>
      <div className="org-summary-text">
        <div className="row-actions">
          <strong className="org-summary-name">{organization.name || '未命名机构'}</strong>
          <OrganizationStatusBadge status={organization.status} />
        </div>
        <p className="muted">联系人：{contact.name || '未填写'} · 联系电话：{maskPhone(contact.phone) || '未填写'}</p>
        <p className="muted">创建时间：{formatDate(organization.createdAt)}</p>
        {extra.length ? <p className="muted">{extra.join(' · ')}</p> : null}
        {meta}
      </div>
    </div>
    {actions ? <div className="row-actions org-summary-actions">{actions}</div> : null}
  </section>;
}

/**
 * 图3 的 4 个入口卡。三个有落点：
 *   授权次数 → 本机构的课包与授权次数（P03-03，本页自己的子路由）
 *   教师 / 学生 → 平台用户（/users，按机构筛选）—— ⚠️ 该页目前**不读** URL 上的筛选参数，
 *                 所以点过去只会是「全部机构」的列表，需要另一个人给 PlatformUsers 加两行
 *                 `useSearchParams` 初始化（不在本次改动的地盘里，已在报告里说明）。
 *   课堂记录 → 平台端**没有**这个页面（全仓 grep「课堂记录」只在机构端有），所以做成不可点卡片，
 *              并在数据概览里给出「当前活跃课堂数」。
 */
export function OrganizationEntryCards({ orgId = '' }) {
  const encoded = encodeURIComponent(orgId);
  const entries = [
    { key: 'quota', icon: '▦', title: '授权次数', hint: '本机构的课包与授权次数', to: `/organizations/${encoded}/quota` },
    { key: 'teachers', icon: '◉', title: '教师', hint: '去平台用户按机构看教师账号', to: `/users?role=TEACHER&orgId=${encoded}` },
    { key: 'students', icon: '☺', title: '学生', hint: '去平台用户按机构看学生账号', to: `/users?role=STUDENT&orgId=${encoded}` },
    { key: 'sessions', icon: '▤', title: '课堂记录', hint: '平台端暂无课堂记录页面，先看数据概览的当前活跃课堂数', to: '' },
  ];
  return <div className="org-entry-grid">{entries.map((item) => (item.to
    ? <Link className="org-entry-card" key={item.key} to={item.to}>
      <span className="org-entry-icon" aria-hidden="true">{item.icon}</span>
      <strong>{item.title}</strong>
      <small>{item.hint}</small>
    </Link>
    : <div className="org-entry-card is-disabled" key={item.key} aria-disabled="true">
      <span className="org-entry-icon" aria-hidden="true">{item.icon}</span>
      <strong>{item.title}</strong>
      <small>{item.hint}</small>
    </div>))}</div>;
}
