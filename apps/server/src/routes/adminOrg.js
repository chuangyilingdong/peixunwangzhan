// 平台管理端路由入口：只做鉴权与分发，各业务域在 routes/admin/*.js。
import { platformPermissionForPathname, requirePlatformPermission } from '../lib.js';
import { handleSelf } from './admin/self.js';
import { handleAudit } from './admin/audit.js';
import { handleOrganizations } from './admin/organizations.js';
import { handleCourses } from './admin/courses.js';
import { handleUsers } from './admin/users.js';
import { handleAdmins } from './admin/admins.js';
import { handleOverview } from './admin/overview.js';
import { handleWorks } from './admin/works.js';

export async function handleAdmin(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/admin/')) return null;
  const platformPermission = platformPermissionForPathname(pathname);
  if (platformPermission) requirePlatformPermission(ctx, platformPermission);
  const part = pathname.slice('/api/admin'.length) || '/';
  { const result = await handleSelf(ctx, part, method); if (result !== null) return result; }
  { const result = await handleAudit(ctx, part, method); if (result !== null) return result; }
  { const result = await handleOrganizations(ctx, part, method); if (result !== null) return result; }
  { const result = await handleCourses(ctx, part, method); if (result !== null) return result; }
  { const result = await handleUsers(ctx, part, method); if (result !== null) return result; }
  { const result = await handleAdmins(ctx, part, method); if (result !== null) return result; }
  { const result = await handleOverview(ctx, part, method); if (result !== null) return result; }
  { const result = await handleWorks(ctx, part, method); if (result !== null) return result; }
  return null;
}

export {
  ENROLLMENT_STATUSES,
  ORG_MEMBER_ROLES,
  ORG_TEACHER_PERMISSIONS,
  PAYMENT_STATUSES,
  WORK_DATA_DAYS,
  accessibleLesson,
  accessibleSeries,
  annotationRows,
  appendEnrollmentEvent,
  appendWorkDataScope,
  assertAnnotationNode,
  assertEnrollmentSeat,
  assertNotLastOrgAdmin,
  assertSelfPassword,
  assertTeachingClassManager,
  auditListQuery,
  auditQuery,
  auditRow,
  buildOrganizationDetail,
  buildStudentDataExport,
  buildWorkData,
  bumpSeriesVersion,
  classDetail,
  classInOrg,
  classMemberships,
  classProgressRows,
  classSessionRows,
  classroomCapabilities,
  contactPayload,
  createMember,
  csvDocument,
  csvFileName,
  curriculumItem,
  enrollmentDate,
  enrollmentRow,
  ensureOrgBilling,
  escapeCsv,
  expireDueEnrollments,
  hasAnyPlatformPermission,
  hasPermission,
  importItems,
  integer,
  lastSuperAdminGuard,
  maskedStudentName,
  maxTimestamp,
  normalizeCanvasTemplateSnapshot,
  normalizeClassroomConfig,
  normalizeDeliveryMode,
  normalizeEnrollment,
  normalizeWorkPublishRequest,
  occupiedStudentSeats,
  orgAccountRequestRow,
  orgAccountRequestRows,
  orgAdminRows,
  orgContractMeta,
  orgId,
  orgMemberRow,
  orgUser,
  orgWorkPublishRequestRow,
  orgWorkPublishRequestRows,
  organizationFilters,
  organizationRow,
  packageSnapshot,
  packageWithSeatUsage,
  pickCapability,
  platformAdminPermissions,
  platformIssuerName,
  platformUserFilters,
  platformUserRow,
  platformWorkFilters,
  previewImport,
  replaceLessonCanvasConfig,
  replaceLessonTeachingMaterials,
  reportResolution,
  setStudentEnrollmentAccess,
  softDeleteStudent,
  teacherCanAccessClass,
  teacherScope,
  userLoginMeta,
  validateImportItem,
  validateMemberPermissions,
  validateMemberPhone,
  validateSeriesForPublishing,
  validateTeacher,
  workDataDimension,
  workDataFilters,
  workInReviewScope,
  workReportInReviewScope,
  workReportRows,
  zeroWorkDataMetrics,
} from './admin/helpers.js';
