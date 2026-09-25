import { audit, clearAuthCookie, count, errors, id, json, normalizeOrg, normalizePackage, normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson, assignmentActiveSql, orgSeriesAccessSql, pageParams, pageResult, q, requireRole, row, rows, transaction, verifyPassword, normalizeLogin, assertLoginAvailable, assertDisplayNameAvailable, arows, arow, aq, acount, atransaction, amap } from '../lib.js';
import { normalizeLesson, canvasMediaFrom } from '../lib.js';
import { normalizeSubmission, parseSnapshotArtifacts, snapshotArtifactByName, snapshotDocumentFileIds, snapshotImageFileIds } from './vibecoding.js';
import { prepareFileDownload, prepareFilePreview, prepareWorkImage } from './fileAssets.js';
import { hashPassword, isUniqueViolation } from '@platform/database';

import { scheduleReminder } from './communication.js';
import { assertTransition } from '../services/domainState.js';
import {
  addSessionStudents, assertSessionManager, canManageSession, sessionRuntimeDetail, removeSessionStudent,
  sessionCandidates, sessionScope, sessionStudentCounts, settleSessionStudents,
} from '../services/classroomSessions.js';
// 体验课包（2026-09-24 用户口径）：课包类型 + 次数账（剩余次数、按有效产出核销）
import { experienceBalanceByStudent, grantUnitsOf, isExperienceSeries, seriesTypeOf } from '../services/courseGrants.js';
import { computePoolSummary, salePriceFenSuccessSql } from '../services/computePool.js';
import { appendLicenseGrantRevenue } from '../services/licenseLedger.js';
import { COURSE_QUOTA_SOURCES, recordQuotaChange } from '../services/courseQuotaLedger.js';

/**
 * 老师点「开始上课」时，**提前把这节课学生的创作环境热起来**（2026-09-16）。
 *
 * 为什么：用户口径「无论什么时候都要秒进」——而 dsh 进程冷启动实测 17.9 秒
 * （平台侧同步等它起来，学生就干等十几秒，体验很差）。进程本身的启动速度我们改不了，
 * 能改的是**什么时候付这个 17.9 秒**：放在老师点「开始上课」那一刻（那时学生在进教室、
 * 还没坐下打开页面），学生点「进入创作环境」时环境已经热了 → 复用路径 0.07 秒。
 *
 * 三条约束（与 releaseSessionRuntimes 同一套理由）：
 *   ① **绝不连累老师**：fire-and-forget + 逐人 try/catch，开始上课的响应不等它；
 *   ② **串行开**：同时拉起一批会让宿主机瞬间打满（每个环境 ~490MB），串行对课堂开始更友好；
 *   ③ 宿主侧有**容量闸门**（run-student-user.sh），装不下会明确拒绝 —— 这里只是尽力预热，
 *      拒绝掉的等到学生真点进去再开（那次就会等一下，但不影响其他学生）。
 */
async function warmSessionRuntimes(sessionId, lessonId, orgId) {
  let studentIds = [];
  try {
    studentIds = (await arows("SELECT DISTINCT student_id FROM session_students WHERE session_id=? AND status='ACTIVE'", [sessionId])).map((item) => item.student_id);
  } catch (error) {
    console.warn(`[runtime] 预热前读名单失败 session=${sessionId}：${error?.message || error}`);
    return;
  }
  if (!studentIds.length) return;
  let launchStudentRuntime = null;
  try {
    ({ launchStudentRuntime } = await import('../services/studentRuntime.js'));
  } catch (error) {
    console.warn(`[runtime] 预热的通道不可用：${error?.message || error}`);
    return;
  }
  // 并发 3 个一批：一个环境冷启动 ~18 秒，串行预热 30 个学生要 9 分钟（那时都快下课了）；
  // 也不能一次全开（宿主机内存会被瞬间打满，其他学生反而更慢）。3 个一批是「够快又不打爆」的折中。
  const WARM_CONCURRENCY = 3;
  let warmed = 0;
  let lastError = '';
  for (let at = 0; at < studentIds.length; at += WARM_CONCURRENCY) {
    const batch = studentIds.slice(at, at + WARM_CONCURRENCY);
    const results = await Promise.all(batch.map((studentId) => launchStudentRuntime({ sessionId, studentId, orgId, lessonId: lessonId || null })
      .then(() => true)
      // 容量不够、学生没许可等都会走到这里 —— 预热是尽力而为，绝不能影响老师上课
      .catch((error) => { lastError = String(error?.message || error); return false; })));
    warmed += results.filter(Boolean).length;
  }
  console.log(`[runtime] 课堂 ${sessionId} 预热完成：${warmed}/${studentIds.length} 个学生环境已就绪${lastError ? `（最后一个未就绪：${lastError}）` : ''}`);
}

/**
 * 课堂结束 / 解散时，把这个课堂所有学生的**创作环境收掉**（2026-09-16）。
 *
 * 为什么必须在这里做：一个学生的创作环境（dsh）是**常驻进程**，生产实测 RSS 486MB
 * （cgroup 峰值 643MB）。课堂结束不收，它就一直在机器上挂着 —— 这条以前完全没接线
 * （`/api/student/runtime/stop` 前端从来没调用过，也没有任何定时任务），
 * 结果是「今天有多少学生上过课」变成「机器上挂着多少个 500MB」，
 * 一台 1.6GB 的机器**两个学生就满**。收掉之后，占用只跟「这一刻真的在上课的课堂」有关 ——
 * 这才是「很多人同时上课」能成立的前提。
 *
 * 三条设计约束：
 *   ① **绝不连累老师**：整个流程 fire-and-forget、逐人 try/catch，失败只打一行日志；
 *      收环境失败绝不能让「结束课堂」这个动作失败或变慢。
 *   ② 用户版按「课堂 + 学生」收（用户名由这两者哈希推导，宿主脚本自己算得回来），
 *      所以这里逐人调，不能只给课堂。
 *   ③ 用**动态 import** 引 stopStudentRuntime：路线文件之间没有静态环，
 *      避免「一个 import 把整个服务拖成链接期错误」（这个项目踩过这类问题）。
 */
async function releaseSessionRuntimes(sessionId, reason = 'SESSION_END') {
  let studentIds = [];
  try {
    studentIds = (await arows('SELECT DISTINCT student_id FROM session_students WHERE session_id=?', [sessionId])).map((item) => item.student_id);
  } catch (error) {
    console.warn(`[runtime] 收环境前读名单失败 session=${sessionId}：${error?.message || error}`);
    return;
  }
  if (!studentIds.length) return;
  let stopStudentRuntime = null;
  try {
    ({ stopStudentRuntime } = await import('../services/studentRuntime.js'));
  } catch (error) {
    console.warn(`[runtime] 收环境的通道不可用（${reason}）：${error?.message || error}`);
    return;
  }
  let stopped = 0;
  let lastError = '';
  for (const studentId of studentIds) {
    try {
      await stopStudentRuntime({ sessionId, studentId });
      stopped += 1;
    } catch (error) {
      // 「这个学生根本没开过环境」是最常见的正常情况，也会走到这里 —— 宿主的收环境脚本是幂等的
      lastError = String(error?.message || error);
    }
  }
  console.log(`[runtime] 课堂 ${sessionId} ${reason}：已回收 ${stopped}/${studentIds.length} 个学生环境${lastError ? `（最后一次未收原因：${lastError}）` : ''}`);
}


// 批次 D（班级退场）：原来这里还导入 classInOrg / assertTeachingClassManager / classMemberships /
// teacherCanAccessClass / teacherScope / classSessionRows / classProgressRows / classDetail / curriculumItem
// —— 那些都是班级口径的辅助函数，随 `/classes/*` 旧接口一起下线了。
import { ensureOrgBilling, integer, orgId, orgUser, hasPermission, accessibleLesson, accessibleSeries, ORG_MEMBER_ROLES, validateMemberPhone, validateMemberPermissions, orgMemberRow, ENROLLMENT_STATUSES, PAYMENT_STATUSES, packageSnapshot, enrollmentDate, enrollmentRow, normalizeEnrollment, appendEnrollmentEvent, expireDueEnrollments, occupiedStudentSeats, assertEnrollmentSeat, setStudentEnrollmentAccess, packageWithSeatUsage, previewImport, createMember, validateTeacher, workInReviewScope, workReportRows, workReportInReviewScope, reportResolution, normalizeWorkPublishRequest, sessionTeacherScope, sessionOwnedByTeacherExists } from './adminOrg.js';
/**
 * 学生课包授权的展示状态（线框图 002-04「授权规则」给的判定口径）。
 * ⚠️ 「已完成」不在其中：线框图只列了这个状态名，**没给判定口径**，按纪律不编。
 */
const GRANT_STATE_LABELS = { PENDING_ACTIVATION: '待激活', LEARNING: '学习中', REVOKED: '已取消' };

/**
 * 授权操作的「来源」枚举（002-05 的「来源」列要它）。
 * 审计表原来只记 request_path，而机构授权的路径都是 `/api/org/course-grants`，分不出是哪个入口发起的；
 * 所以让调用方带一个**受限枚举**，存进 `audit_logs.after_data` —— 不是新列，不需要迁移。
 * 白名单外的值一律当没传（不让前端往审计里塞任意字符串）。
 */
const GRANT_SOURCE_LABELS = {
  STUDENT_CENTER: '学生授权中心',
  STUDENT_DETAIL: '学生授权详情',
  ADD_GRANT_DRAWER: '学生授权详情（添加课包）',
  GRANT_PAGE: '为学生添加课包',
};

export async function handleOrg(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/org/')) return null;
  // /api/org/file-assets 由独立路由处理（含 STUDENT 角色）
  if (pathname.startsWith('/api/org/file-assets')) return null;
  const auth = requireRole(ctx, ['ORG_ADMIN', 'TEACHER']); const currentOrgId = orgId(auth); const part = pathname.slice('/api/org'.length);

  // ── 自助改密（2026-09-23 用户口径：「机构端/老师端/学生端创建了账号后，他们应该是有自行修改密码的按钮和操作」）
  // 在这之前机构端**没有**自助改密：本文件里只有「机构管理员改本机构成员密码」那条（改的是**别人**），
  // 于是机构管理员与老师只能用创建账号时发的那个临时口令，自己改不掉。
  // 三条与平台端（admin/me/password）、学生端（student/account/password）逐字对齐 ——
  // 三端界面共用同一个组件（packages/shared/src/account.jsx 的 PasswordChangeForm），口径必须一致：
  //   ① 必须验**当前密码**（捡到一次登录就能改密 = 能把别人的账号锁死）；
  //   ② 成功后撤销该账号**所有**会话（含当前这一处）→ 界面只能回登录页重新登录；
  //   ③ 新密码 ≥6 位、不能与当前密码相同。
  // 放在 handleOrg 最前面（紧跟 auth）：这是**对自己**的操作，不依赖任何机构权限域，
  // 所以不能学 /members/:id/password 那种"管理员改别人"的形状。
  if (part === '/me/password' && method === 'PUT') {
    const currentPassword = String(ctx.body?.currentPassword || '');
    const newPassword = String(ctx.body?.newPassword || '');
    if (!currentPassword) throw errors.badRequest('请输入当前密码', 'CURRENT_PASSWORD_REQUIRED');
    if (newPassword.length < 6) throw errors.badRequest('新密码至少 6 位', 'PASSWORD_TOO_SHORT');
    if (newPassword === currentPassword) throw errors.badRequest('新密码不能与当前密码相同', 'PASSWORD_UNCHANGED');
    const me = await arow('SELECT * FROM users WHERE id=? AND deleted_at IS NULL', [auth.user.id]);
    if (!me) throw errors.notFound('账号不存在', 'USER_NOT_FOUND');
    if (!verifyPassword(currentPassword, me.password_hash)) throw errors.forbidden('当前密码不正确', 'CURRENT_PASSWORD_INVALID');
    const now = nowIso();
    let sessionsRevoked = 0;
    await atransaction(async () => {
      // ⚠️ 只按主键 id 定位，**不**再叠 org_id 之类的条件：多一个条件就多一种
      //    「UPDATE 匹配到 0 行、却照样返回成功」的静默失败。写完当场核对影响行数。
      const written = (await aq('UPDATE users SET password_hash=?, updated_at=? WHERE id=? AND deleted_at IS NULL', [hashPassword(newPassword), now, me.id])).changes;
      if (written !== 1) throw errors.conflict('密码没有写进库，请重试或联系平台', 'PASSWORD_WRITE_FAILED');
      sessionsRevoked = (await aq('UPDATE sessions SET superseded_at=? WHERE user_id=? AND superseded_at IS NULL', [now, me.id])).changes;
    });
    await audit(ctx, 'ORG_PASSWORD_CHANGE', 'USER', me.id, null, { sessionsRevoked });
    ctx.setCookie = clearAuthCookie();
    return { passwordChanged: true, sessionsRevoked, reloginRequired: true };
  }

  if (part === '/overview' && method === 'GET') {
    // 2026-09-13（P4 删积分）：原来这里会 ensureOrgBilling() 并读机构积分账户，积分废弃后不再需要。
    const isTeacher = auth.user.role === 'TEACHER';
    const orgRecord = await arow('SELECT * FROM organizations WHERE id=?', [currentOrgId]);
    const normalizedOrg = await normalizeOrg(orgRecord);
    // 批次 D（2026-09-13）：教师数据范围从「班级」改成「课堂」——**只看自己创建的课堂**。
    // 落点统一在 class_sessions.teacher_id（作品靠 works.class_session_id、用量靠 usage_records.class_session_id）。
    // ⚠️ 安全相关：改这段之前先看 scripts/p69-teacher-data-scope.mjs，它把每一处范围都钉成了期望。
    const sessionScopeParams = [];
    const teacherSessionScope = sessionTeacherScope('session', auth, sessionScopeParams);
    const sessionParams = [currentOrgId, ...sessionScopeParams];
    const activeSessions = await acount("SELECT COUNT(*) n FROM class_sessions session WHERE session.org_id=? AND session.status='ACTIVE'" + teacherSessionScope, sessionParams);
    // 待上课也算「排了课但还没开始」，机构总览要能看出存量
    const pendingSessions = await acount("SELECT COUNT(*) n FROM class_sessions session WHERE session.org_id=? AND session.status='PENDING'" + teacherSessionScope, sessionParams);
    // 班级退场：这个键保留但恒为 0（既有读取方不炸），课堂上数用 activeSessions/pendingSessions
    const activeClasses = 0;
    // 学员数：教师＝**自己课堂名单里的学员**（去重）；管理员＝本机构全部有效学员
    const students = isTeacher
      ? await acount(
        "SELECT COUNT(DISTINCT part.student_id) n FROM session_students part JOIN class_sessions session ON session.id=part.session_id JOIN users student ON student.id=part.student_id WHERE session.org_id=? AND part.status<>'REMOVED' AND student.deleted_at IS NULL" + teacherSessionScope,
        sessionParams,
      )
      : await acount("SELECT COUNT(*) n FROM users WHERE org_id=? AND role='STUDENT' AND deleted_at IS NULL AND status='ACTIVE'", [currentOrgId]);
    const teachers = isTeacher ? 1 : await acount("SELECT COUNT(*) n FROM users WHERE org_id=? AND role='TEACHER' AND deleted_at IS NULL", [currentOrgId]);
    // 作品范围：挂在**我创建的课堂**上（班级退场后不再有 work.class_id 这一层）
    const workScopeParams = [currentOrgId];
    const workSessionScope = sessionOwnedByTeacherExists('work.class_session_id', auth, workScopeParams, { orgColumn: 'work.org_id' });
    const worksScope = 'work.org_id=?' + workSessionScope;
    const worksParams = [...workScopeParams];
    const works = await acount('SELECT COUNT(*) n FROM works work WHERE ' + worksScope, worksParams);
    const pendingWorks = await acount('SELECT COUNT(*) n FROM works work WHERE ' + worksScope + ' AND work.status=\'PENDING\'', worksParams);
    const workBreakdown = (await arows('SELECT work.status,COUNT(*) n FROM works work WHERE ' + worksScope + ' GROUP BY work.status', worksParams))
      .reduce((result, item) => ({ ...result, [item.status]: Number(item.n || 0) }), {});
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
    // 用量范围：同一套逻辑，换成 usage_records.class_session_id
    const usageScopeParams = [currentOrgId, since7];
    const usageSessionScope = sessionOwnedByTeacherExists('usage.class_session_id', auth, usageScopeParams);
    const usageScope = 'usage.org_id=? AND usage.created_at>=?' + usageSessionScope;
    const usageParams = [...usageScopeParams];
    // 2026-09-13（P4 删积分）：这里原来统计 SUM(credits_charged)（积分），积分废弃后恒为 0，
    // 改成数调用次数 —— 「近 7 天 AI 调用」这个口径仍然有意义。
    const usage7 = Number((await arow('SELECT COUNT(*) n FROM usage_records AS `usage` WHERE ' + usageScope, usageParams))?.n || 0);
    const recentSessions = (await arows(
      "SELECT session.id,session.class_id,session.lesson_id,session.status,session.started_at,session.ended_at,session.title,session.delivery_mode,lesson.title lesson_title,series.title series_title,teacher.display_name teacher_name FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id LEFT JOIN course_series series ON series.id=session.series_id LEFT JOIN users teacher ON teacher.id=session.teacher_id WHERE session.org_id=?" + teacherSessionScope + " ORDER BY COALESCE(session.started_at,session.created_at) DESC LIMIT 8",
      sessionParams,
    )).map((item) => ({
      id: item.id, classId: null, className: item.title || null, title: item.title || null,
      seriesTitle: item.series_title || null, deliveryMode: item.delivery_mode || 'CANVAS',
      lessonId: item.lesson_id || null, lessonTitle: item.lesson_title || null,
      teacherName: item.teacher_name || null,
      status: item.status, startedAt: item.started_at, endedAt: item.ended_at || null, startedByName: item.teacher_name || null,
    }));
    const pendingWorkItems = await amap((await arows(
      'SELECT work.*,student.display_name student_name,lesson.title lesson_title FROM works work JOIN users student ON student.id=work.student_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id WHERE ' + worksScope + ' AND work.status=\'PENDING\' ORDER BY work.submitted_at DESC LIMIT 6',
      worksParams,
    )), async (item) => await normalizeWork(item));
    const notificationNow = nowIso();
    const notificationScope = "recipient.user_id=? AND recipient.delivery_status='DELIVERED' AND recipient.read_at IS NULL AND n.status='PUBLISHED' AND (n.publish_at IS NULL OR n.publish_at<=?) AND (n.scope_type='PLATFORM' OR (n.scope_type='ORG' AND n.org_id=?))";
    const notificationParams = [auth.user.id, notificationNow, currentOrgId];
    const unreadNotifications = await acount('SELECT COUNT(*) n FROM notification_recipients recipient JOIN notifications n ON n.id=recipient.notification_id WHERE ' + notificationScope, notificationParams);
    const unreadNotificationItems = (await arows(
      'SELECT n.*,sender.display_name sender_name,recipient.read_at,recipient.delivery_status FROM notification_recipients recipient JOIN notifications n ON n.id=recipient.notification_id LEFT JOIN users sender ON sender.id=n.sender_id WHERE ' + notificationScope + ' ORDER BY n.pinned DESC,COALESCE(n.publish_at,n.created_at) DESC LIMIT 5',
      notificationParams,
    )).map((item) => ({ id: item.id, title: item.title, body: item.body, kind: item.kind, senderName: item.sender_name || null, createdAt: item.created_at, publishAt: item.publish_at || null }));
    const alerts = [];
    if (!isTeacher) {
      const contractTimestamp = Date.parse(normalizedOrg?.contractExpiresAt || '');
      const contractDaysRemaining = Number.isFinite(contractTimestamp) ? Math.ceil((contractTimestamp - Date.now()) / 86400000) : null;
      if (contractDaysRemaining !== null && contractDaysRemaining <= 30) alerts.push({ code: contractDaysRemaining < 0 ? 'CONTRACT_EXPIRED' : 'CONTRACT_EXPIRING', level: contractDaysRemaining < 0 ? 'danger' : 'warning', title: contractDaysRemaining < 0 ? '合同已到期' : '合同即将到期', message: contractDaysRemaining < 0 ? '请尽快联系平台处理续约或停用安排。' : '请提前确认续约安排，避免影响机构使用。', daysRemaining: contractDaysRemaining });
      if (normalizedOrg.teacherSeats > 0 && normalizedOrg.teacherUsedSeats >= normalizedOrg.teacherSeats) alerts.push({ code: 'TEACHER_SEATS_FULL', level: 'warning', title: '教师席位已用满', message: '当前有效教师数已达到可用席位上限。', used: normalizedOrg.teacherUsedSeats, total: normalizedOrg.teacherSeats });
      // 2026-09-13（P4 删积分）：原来这里还有一条「积分余额为零」的预警，积分废弃后删除。
    }
    if (isTeacher) normalizedOrg.teacherUsedSeats = null;
    // 2026-09-17（001-01 机构工作台线框图）：补「机构运营摘要」要的**本月**口径与两个关注项。
    // 只对机构管理员算；教师视图一律 0（线框图也写明教师工作台不展示机构运营数据）。
    const monthStart = `${nowIso().slice(0, 7)}-01`;
    const monthCount = async (sql, params) => (isTeacher ? 0 : await acount(sql, params));
    const monthNewStudents = await monthCount('SELECT COUNT(*) n FROM users WHERE org_id=? AND role=\'STUDENT\' AND deleted_at IS NULL AND created_at>=?', [currentOrgId, monthStart]);
    const monthNewTeachers = await monthCount('SELECT COUNT(*) n FROM users WHERE org_id=? AND role=\'TEACHER\' AND deleted_at IS NULL AND created_at>=?', [currentOrgId, monthStart]);
    const monthGrants = await monthCount('SELECT COUNT(*) n FROM student_course_grants WHERE org_id=? AND granted_at>=?', [currentOrgId, monthStart]);
    // 人次口径（2026-09-24）：体验课包可重复分给同一学生、次数记在同一行上，所以"授权条数"与
    // "人次"要分开给 —— grantUnits 才是次数账上真正消耗掉的人次。
    const monthGrantUnits = await monthCount('SELECT COALESCE(SUM(granted_units),0) n FROM student_course_grants WHERE org_id=? AND granted_at>=?', [currentOrgId, monthStart]);
    const monthExperienceConsumed = await monthCount('SELECT COALESCE(SUM(units),0) n FROM student_course_grant_consumptions WHERE org_id=? AND consumed_at>=?', [currentOrgId, monthStart]);
    const monthEndedSessions = await monthCount("SELECT COUNT(*) n FROM class_sessions WHERE org_id=? AND status='ENDED' AND ended_at>=?", [currentOrgId, monthStart]);
    // 「需要关注」的两条（合约/席位那两条仍在 alerts 里）：
    const restrictedAccounts = await monthCount('SELECT COUNT(*) n FROM users WHERE org_id=? AND role IN (\'STUDENT\',\'TEACHER\') AND deleted_at IS NULL AND status<>\'ACTIVE\'', [currentOrgId]);
    // ⚠️ 线框图写的是「剩余人次不足」，但平台没定义「不足」的阈值 —— 这里只数**已经用尽**的，
    //    不替平台发明一个阈值（宁可少报，也不给机构一个凭空的门槛）。
    const exhaustedSeries = await monthCount('SELECT COUNT(*) n FROM course_assignments WHERE org_id=? AND status=\'ACTIVE\' AND quota_total>0 AND quota_used>=quota_total', [currentOrgId]);
    return {
      scope: {
        role: auth.user.role,
        label: isTeacher ? '教师教学视图' : '机构管理员经营视图',
        // 批次 D：口径从「班级」改成「课堂」——教师只看自己创建的课堂
        description: isTeacher ? '仅统计本人创建的课堂（及这些课堂上的作品与用量）。' : '统计当前机构的经营与教学运行数据。',
        sessionCount: activeSessions + pendingSessions,
      },
      org: normalizedOrg, students, teachers, activeClasses, activeSessions, pendingSessions, works, pendingWorks, usage7,
      unreadNotifications,
      recentSessions, pendingWorkItems, unreadNotificationItems, alerts,
      month: { newStudents: monthNewStudents, newTeachers: monthNewTeachers, grants: monthGrants, grantUnits: monthGrantUnits, experienceConsumed: monthExperienceConsumed, endedSessions: monthEndedSessions },
      attention: { exhaustedSeries, restrictedAccounts },
      breakdown: { students, activeClasses, activeSessions, pendingSessions, works: workBreakdown, pendingWorks, usage7 },
    };
  }
  if (auth.user.role === 'TEACHER' && (/^\/users(?:\/|$)/.test(part) || part === '/course-grants' || part === '/series-overview'
    // 2026-09-17：002-03 / 002-04 / 002-06 这三个新入口与库存、授权同一权限面 ——
    // 教师只能看自己课堂，看不到机构的人次账与学生授权明细。
    || part === '/student-grants-summary' || part === '/license-batches' || part === '/student-grant-records' || /^\/students\/[^/]+\/course-grants$/.test(part))) throw errors.forbidden('仅机构管理员可管理学生及授权', 'ORG_ADMIN_REQUIRED');
  if (part === '/users' && method === 'GET') {
    const role = ctx.search.get('role');
    // 教师需要读取本机构学生名册，才能履行“将学生加入班级”的职责；不开放教师名册和机构成员管理权限。
    if (!(auth.user.role === 'TEACHER' && role === 'STUDENT') && !hasPermission(auth, 'MANAGE_MEMBERS')) throw errors.forbidden('无账号管理权限', 'ORG_MEMBER_PERMISSION_REQUIRED');
    const search = String(ctx.search.get('search') || '').trim(); const params = [currentOrgId]; let where = 'org_id=? AND deleted_at IS NULL';
    if (ORG_MEMBER_ROLES.has(role)) { where += ' AND role=?'; params.push(role); }
    if (search) { where += ' AND (login LIKE ? OR display_name LIKE ? OR phone LIKE ?)'; const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'; params.push(keyword, keyword, keyword); }
    // 2026-09-16：名单会很长（一百个学生很正常），所以支持**真分页 + 搜索**，
    // 并且**最新添加的排在最前**（created_at DESC）—— 老师刚建完账号就能在第一页看到。
    //
    // ⚠️ **带 page 才分页，不带 page 维持老的整表语义（上限 500）**。
    // 为什么这么设计：这个接口还有三个「当选项源用」的调用方（机构成员管理页、
    // 学员开通页的学生选择、课堂的「负责老师」下拉），它们只读 items、不翻页 ——
    // 如果一律按 20 条分页，这些页面会**静默只显示前 20 个人**（本轮差点就这么上线）。
    // 所以：分页由调用方显式声明（带 page），老调用方行为不变；total 一律给真的。
    const wantsPaging = ctx.search.get('page') !== null;
    const total = Number(await acount('SELECT COUNT(*) n FROM users WHERE ' + where, params) || 0);
    if (!wantsPaging) {
      const items = (await arows('SELECT * FROM users WHERE ' + where + ' ORDER BY created_at DESC, id DESC LIMIT 500', params)).map((item) => orgMemberRow(item, currentOrgId));
      // 老形态：给 items 与真 total（原来那个 total 是「当页条数」，本来就是错的）
      return { items, total, page: 1, limit: 500, totalPages: Math.max(1, Math.ceil(total / 500)) };
    }
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 20, maxLimit: 200 });
    const items = (await arows('SELECT * FROM users WHERE ' + where + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [...params, limit, offset])).map((item) => orgMemberRow(item, currentOrgId));
    return pageResult(items, { page, limit, total });
  }
  let importMatch = part.match(/^\/users\/import\/(preview|commit)$/);
  if (importMatch && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可批量导入账号', 'ORG_ADMIN_REQUIRED');
    const preview = await previewImport(ctx.body || {}, currentOrgId);
    if (importMatch[1] === 'preview') return preview;
    if (preview.invalidCount) throw errors.badRequest('批量导入校验失败，未写入任何账号', 'IMPORT_VALIDATION_FAILED', preview);
    const created = await atransaction(async () => await amap(preview.items, async (item) => await createMember(currentOrgId, item.value)));
    for (const item of created) { await audit(ctx, 'USER_IMPORT_CREATE', 'USER', item.id, null, { role: item.role, login: item.login }); };
    await audit(ctx, 'USER_IMPORT_COMMIT', 'IMPORT_BATCH', null, null, { total: created.length, logins: created.map((item) => item.login) });
    return { total: created.length, validCount: created.length, invalidCount: 0, items: created.map((item) => orgMemberRow(item, currentOrgId)) };
  }
  if (part === '/users' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可创建账号', 'ORG_ADMIN_REQUIRED');
    const body = ctx.body || {}; const role = String(body.role || '').trim().toUpperCase(); const login = String(body.login || '').trim(); const displayName = String(body.displayName || '').trim();
    if (!ORG_MEMBER_ROLES.has(role) || !displayName || String(body.password || '').length < 6) throw errors.badRequest('账号信息不完整');
    // 登录名：只允许英文数字（可带 . _ -），全局唯一且**忽略大小写**；
    // 姓名：同机构同角色不允许重名（2026-09-16 用户口径：不同用户可能同登录名或同名字）
    normalizeLogin(login, '登录名');
    await assertLoginAvailable(login);
    await assertDisplayNameAvailable(displayName, { orgId: currentOrgId, role });
    const phone = await validateMemberPhone(body.phone);
    const permissions = validateMemberPermissions(body.permissions, role);
    const organization = await normalizeOrg(await arow('SELECT * FROM organizations WHERE id=?', [currentOrgId]));
    if (role === 'TEACHER' && organization.teacherSeats - organization.teacherUsedSeats <= 0) throw errors.badRequest('教师席位不足', 'TEACHER_SEAT_LIMIT');
    if (body.billingPackageId && !await arow('SELECT id FROM billing_packages WHERE id=? AND org_id=?', [body.billingPackageId, currentOrgId])) throw errors.badRequest('套餐不属于当前机构', 'INVALID_BILLING_PACKAGE');
    // 批次 D：不再接受 classIds（班级退场）—— 学员进课堂改在「课堂」页做。
    const created = await atransaction(async () => await createMember(currentOrgId, {
      role, login, displayName, password: String(body.password), phone: phone || null,
      permissions, expiresAt: body.expiresAt || null,
      // 批次 D：student_usage_scope 已退役（取消「在家练习」免课堂通道后它不再决定任何事，
      // 见 aiGeneration 的 /api/ai/center）。新号统一写 FOLLOW_CLASS 作为**语义正确的历史值**，
      // 不再默认 HOME_PRACTICE —— 那个默认值会让看库的人以为「这个学生可以不上课堂就创作」。
      studentUsageScope: role === 'STUDENT' ? 'FOLLOW_CLASS' : null,
      billingPackageId: role === 'STUDENT' ? (body.billingPackageId || null) : null,
      // 2026-09-13（P4 删积分）：不再接受 monthlyCreditAllowance / aiCreditLimit（两道刹车都没了）
    }));
    await audit(ctx, 'USER_CREATE', 'USER', created.id, null, { role, login });
    return orgMemberRow(created, currentOrgId);
  }  let match = part.match(/^\/users\/([^/]+)$/);
  if (match && ['GET','PUT','DELETE'].includes(method)) {
    if (!hasPermission(auth, 'MANAGE_MEMBERS')) throw errors.forbidden('无账号管理权限', 'ORG_MEMBER_PERMISSION_REQUIRED'); const target = await orgUser(auth, match[1]); if (method === 'GET') return normalizeUser(target, { includeAuthMeta: true });
    if (method === 'DELETE') {
      const now = nowIso();
      await assertTransition(ctx, 'user', target.status, 'DISABLED', { targetType: 'USER', targetId: target.id, before: target, allowSameState: true });
      await atransaction(async () => { await aq('UPDATE users SET deleted_at=?,status=?,updated_at=? WHERE id=? AND org_id=?', [now, 'DISABLED', now, target.id, currentOrgId]); await aq('UPDATE sessions SET superseded_at=COALESCE(superseded_at,?) WHERE user_id=? AND superseded_at IS NULL', [now, target.id]); });
      await audit(ctx, 'USER_DELETE', 'USER', target.id, normalizeUser(target), { status: 'DISABLED', deletedAt: now }); return { ok: true };
    }
    const body = ctx.body || {};
    if (body.billingPackageId && !await arow('SELECT id FROM billing_packages WHERE id=? AND org_id=?', [body.billingPackageId, currentOrgId])) throw errors.badRequest('套餐不属于当前机构', 'INVALID_BILLING_PACKAGE');
    const nextStatus = body.status === undefined ? target.status : body.status;
    if (!['ACTIVE', 'DISABLED'].includes(nextStatus)) throw errors.badRequest('账号状态无效', 'INVALID_MEMBER_STATUS');
    await assertTransition(ctx, 'user', target.status, nextStatus, { targetType: 'USER', targetId: target.id, before: target, allowSameState: true, code: 'INVALID_MEMBER_STATUS' });
    if (nextStatus === 'DISABLED' && target.id === auth.user.id) throw errors.badRequest('不能停用当前登录账号', 'SELF_DISABLE_FORBIDDEN');
    const phone = body.phone === undefined ? target.phone : await validateMemberPhone(body.phone, target.id);
    const displayName = body.displayName === undefined ? target.display_name : String(body.displayName).trim(); if (!displayName) throw errors.badRequest('姓名不能为空', 'DISPLAY_NAME_REQUIRED');
    if (displayName !== target.display_name) await assertDisplayNameAvailable(displayName, { orgId: currentOrgId, role: target.role, excludeUserId: target.id });
    // 批次 D：`studentUsageScope` 不再接受修改 —— 字段已退役（不再决定任何门禁）。
    // 传了就忽略（不报错），列本身保留历史值。要「能不能用 AI」请看算力池与课堂名单。
    const permissions = body.permissions === undefined ? parseJson(target.permissions, []) : validateMemberPermissions(body.permissions, target.role);
    const now = nowIso();
    await atransaction(async () => { await aq('UPDATE users SET display_name=?,phone=?,permissions=?,status=?,billing_package_id=?,updated_at=? WHERE id=? AND org_id=?', [displayName, phone, json(permissions), nextStatus, body.billingPackageId === undefined ? target.billing_package_id : body.billingPackageId, now, target.id, currentOrgId]); if (nextStatus === 'DISABLED') await aq('UPDATE sessions SET superseded_at=COALESCE(superseded_at,?) WHERE user_id=? AND superseded_at IS NULL', [now, target.id]); });
    await audit(ctx, 'USER_UPDATE', 'USER', target.id, normalizeUser(target), { ...body, status: nextStatus }); return orgMemberRow(await arow('SELECT * FROM users WHERE id=?', [target.id]), currentOrgId);
  }
  match = part.match(/^\/users\/([^/]+)\/(password|permissions)$/);
  if (match && method === 'PUT') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可操作', 'ORG_ADMIN_REQUIRED'); const target = await orgUser(auth, match[1]);
    if (match[2] === 'password') { const password = String(ctx.body?.password || ''); if (password.length < 6) throw errors.badRequest('密码至少6位'); const now = nowIso(); await atransaction(async () => { await aq('UPDATE users SET password_hash=?,updated_at=? WHERE id=? AND org_id=?', [hashPassword(password), now, target.id, currentOrgId]); await aq('UPDATE sessions SET superseded_at=COALESCE(superseded_at,?) WHERE user_id=? AND superseded_at IS NULL', [now, target.id]); }); }
    if (match[2] === 'permissions') { if (target.role !== 'TEACHER') throw errors.badRequest('只能设置教师权限', 'INVALID_ROLE'); await aq('UPDATE users SET permissions=?,updated_at=? WHERE id=? AND org_id=?', [json(validateMemberPermissions(ctx.body?.permissions, target.role)), nowIso(), target.id, currentOrgId]); }
    // 2026-09-13（P4 删积分）：原来还有 period-boosts（给成员加「本周期额外积分」），积分废弃后删除。
    await audit(ctx, 'USER_' + match[2].toUpperCase(), 'USER', target.id, null, ctx.body); return normalizeUser(await arow('SELECT * FROM users WHERE id=?', [target.id]), { includeAuthMeta: true });
  }
  if (part === '/audit-logs' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看操作审计', 'ORG_ADMIN_REQUIRED');
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const action = String(ctx.search.get('action') || '').trim(); const params = [currentOrgId]; let where = 'audit.org_id=?';
    if (action) { where += ' AND audit.action=?'; params.push(action); }
    const items = (await arows(`SELECT audit.*,actor.display_name actor_name,actor.login actor_login
      FROM audit_logs audit LEFT JOIN users actor ON actor.id=audit.actor_id
      WHERE ${where} ORDER BY audit.created_at DESC LIMIT ${limit}`, params)).map((item) => ({
      id: item.id, action: item.action, targetType: item.target_type, targetId: item.target_id || null,
      actorName: item.actor_name || item.actor_login || '系统', actorRole: item.actor_role || null,
      before: parseJson(item.before_data, null), after: parseJson(item.after_data, null), createdAt: item.created_at,
    }));
    return { items, total: items.length };
  }
  if (part === '/billing/packages' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看计费套餐', 'ORG_ADMIN_REQUIRED');
    await expireDueEnrollments(currentOrgId);
    return { items: await amap((await arows('SELECT * FROM billing_packages WHERE org_id=? ORDER BY created_at DESC', [currentOrgId])), async (item) => await packageWithSeatUsage(currentOrgId, item)) };
  }
  if (part === '/billing/packages' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可创建套餐', 'ORG_ADMIN_REQUIRED');
    const body = ctx.body || {}; const name = String(body.name || '').trim();
    if (!name) throw errors.badRequest('套餐名称必填', 'PACKAGE_NAME_REQUIRED');
    if (await arow('SELECT id FROM billing_packages WHERE org_id=? AND name=?', [currentOrgId, name])) throw errors.conflict('同名套餐已存在', 'BILLING_PACKAGE_EXISTS');
    const capabilities = body.capabilities || {}; const packageId = id('pkg'); const now = nowIso();
    const studentSeats = integer(body.studentSeats, '学员席位', { min: 1, max: 100000, fallback: 1 });
    // 2026-09-13（P4 删积分）：套餐的「月度积分 / 赠送积分」两列保留（历史数据），
    // 但不再作为输入 —— 新套餐一律写 0。套餐现在只服务「学员席位 + 能力开关」。
    await aq('INSERT INTO billing_packages(id,org_id,name,price_fen,monthly_credits,bonus_credits,duration_days,allow_image,allow_music,allow_video,allow_podcast,allow_dubbing,student_seats,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      packageId, currentOrgId, name, integer(body.priceFen, '价格'), 0, 0, integer(body.durationDays, '套餐有效期', { min: 1, max: 3650, fallback: 30 }),
      capabilities.allowImage ? 1 : 0, capabilities.allowMusic ? 1 : 0, capabilities.allowVideo ? 1 : 0, capabilities.allowPodcast ? 1 : 0, capabilities.allowDubbing ? 1 : 0, studentSeats, now, now,
    ]);
    const created = await arow('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [packageId, currentOrgId]);
    await audit(ctx, 'BILLING_PACKAGE_CREATE', 'BILLING_PACKAGE', packageId, null, normalizePackage(created), { orgId: currentOrgId });
    return await packageWithSeatUsage(currentOrgId, created);
  }
  let packageMatch = part.match(/^\/billing\/packages\/([^/]+)$/);
  if (packageMatch && ['GET', 'PUT'].includes(method)) {
    const target = await arow('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [packageMatch[1], currentOrgId]);
    if (!target) throw errors.notFound('套餐不存在', 'BILLING_PACKAGE_NOT_FOUND');
    if (method === 'GET') return await packageWithSeatUsage(currentOrgId, target);
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可修改套餐', 'ORG_ADMIN_REQUIRED');
    await expireDueEnrollments(currentOrgId);
    const body = ctx.body || {}; const capabilities = body.capabilities || {};
    const name = body.name === undefined ? target.name : String(body.name).trim();
    if (!name) throw errors.badRequest('套餐名称必填', 'PACKAGE_NAME_REQUIRED');
    let status = target.status;
    if (body.status !== undefined) {
      status = body.status;
      if (!['ACTIVE', 'DISABLED'].includes(status)) throw errors.badRequest('套餐状态无效', 'INVALID_PACKAGE_STATUS');
      if (status === 'DISABLED' && target.status !== 'DISABLED' && await occupiedStudentSeats(currentOrgId, target.id) > 0) {
        throw errors.conflict('套餐仍有已开通学员，请先停用或到期处理对应开通单', 'PACKAGE_HAS_ACTIVE_ENROLLMENTS');
      }
    }
    const studentSeats = body.studentSeats === undefined ? Number(target.student_seats || 0) : integer(body.studentSeats, '学员席位', { min: 1, max: 100000, fallback: 1 });
    const occupied = await occupiedStudentSeats(currentOrgId, target.id);
    if (studentSeats < occupied) throw errors.conflict('学员席位不能低于当前已占用数量', 'STUDENT_SEAT_BELOW_OCCUPIED');
    await aq('UPDATE billing_packages SET name=?,price_fen=?,monthly_credits=?,bonus_credits=?,duration_days=?,allow_image=?,allow_music=?,allow_video=?,allow_podcast=?,allow_dubbing=?,student_seats=?,status=?,updated_at=? WHERE id=? AND org_id=?', [
      name,
      body.priceFen === undefined ? target.price_fen : integer(body.priceFen, '价格'),
      // 两列「月度积分 / 赠送积分」不再接受输入，原值原样保留（历史数据不动）
      target.monthly_credits,
      target.bonus_credits,
      body.durationDays === undefined ? target.duration_days : integer(body.durationDays, '套餐有效期', { min: 1, max: 3650, fallback: 30 }),
      capabilities.allowImage === undefined ? target.allow_image : (capabilities.allowImage ? 1 : 0),
      capabilities.allowMusic === undefined ? target.allow_music : (capabilities.allowMusic ? 1 : 0),
      capabilities.allowVideo === undefined ? target.allow_video : (capabilities.allowVideo ? 1 : 0),
      capabilities.allowPodcast === undefined ? target.allow_podcast : (capabilities.allowPodcast ? 1 : 0),
      capabilities.allowDubbing === undefined ? target.allow_dubbing : (capabilities.allowDubbing ? 1 : 0),
      studentSeats, status, nowIso(), target.id, currentOrgId,
    ]);
    const updated = await arow('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [target.id, currentOrgId]);
    await audit(ctx, 'BILLING_PACKAGE_UPDATE', 'BILLING_PACKAGE', target.id, normalizePackage(target), normalizePackage(updated), { orgId: currentOrgId });
    return await packageWithSeatUsage(currentOrgId, updated);
  }

  if (part === '/billing/enrollments' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看学员开通', 'ORG_ADMIN_REQUIRED');
    await expireDueEnrollments(currentOrgId);
    const status = String(ctx.search.get('status') || '').trim().toUpperCase();
    if (status && !ENROLLMENT_STATUSES.has(status)) throw errors.badRequest('开通状态无效', 'INVALID_ENROLLMENT_STATUS');
    const params = [currentOrgId]; let where = 'enrollment.org_id=?';
    if (status) { where += ' AND enrollment.status=?'; params.push(status); }
    const items = await amap((await arows(`SELECT enrollment.*,student.display_name student_name,student.login student_login,package.name package_name,
        COUNT(event.id) event_count,MAX(event.created_at) last_event_at
      FROM student_enrollments enrollment
      JOIN users student ON student.id=enrollment.student_id AND student.org_id=enrollment.org_id
      JOIN billing_packages package ON package.id=enrollment.package_id AND package.org_id=enrollment.org_id
      LEFT JOIN student_enrollment_events event ON event.enrollment_id=enrollment.id
      WHERE ${where}
      GROUP BY enrollment.id ORDER BY CASE enrollment.status WHEN 'ACTIVE' THEN 0 WHEN 'PENDING' THEN 1 WHEN 'SUSPENDED' THEN 2 ELSE 3 END,enrollment.expires_at ASC,enrollment.created_at DESC LIMIT 500`, params)), normalizeEnrollment);
    const active = items.filter((item) => item.status === 'ACTIVE');
    const now = Date.now();
    return { items, summary: { total: items.length, pending: items.filter((item) => item.status === 'PENDING').length, active: active.length, suspended: items.filter((item) => item.status === 'SUSPENDED').length, expiringSoon: active.filter((item) => { const days = Math.ceil((Date.parse(item.expiresAt) - now) / 86400000); return days >= 0 && days <= 30; }).length } };
  }
  if (part === '/billing/enrollments' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可创建学员开通单', 'ORG_ADMIN_REQUIRED');
    const body = ctx.body || {}; const studentId = String(body.studentId || '').trim(); const packageId = String(body.packageId || '').trim();
    const student = await arow("SELECT * FROM users WHERE id=? AND org_id=? AND role='STUDENT' AND deleted_at IS NULL", [studentId, currentOrgId]);
    if (!student) throw errors.badRequest('学员不属于当前机构', 'INVALID_ENROLLMENT_STUDENT');
    const pkg = await arow("SELECT * FROM billing_packages WHERE id=? AND org_id=? AND status='ACTIVE'", [packageId, currentOrgId]);
    if (!pkg) throw errors.badRequest('套餐不存在或已停用', 'INVALID_ENROLLMENT_PACKAGE');
    if (await arow("SELECT id FROM student_enrollments WHERE student_id=? AND status='ACTIVE'", [student.id])) throw errors.conflict('该学员已有生效中的开通单，请使用续费或停用操作', 'STUDENT_ALREADY_ENROLLED');
    const now = nowIso(); const startsAt = enrollmentDate(body.startsAt, '开始时间', now);
    const expiresAt = new Date(new Date(startsAt).valueOf() + Number(pkg.duration_days || 0) * 86400000).toISOString();
    const paymentStatus = body.paymentStatus === undefined ? 'UNRECORDED' : String(body.paymentStatus).trim().toUpperCase();
    if (!PAYMENT_STATUSES.has(paymentStatus)) throw errors.badRequest('线下收款登记状态无效', 'INVALID_PAYMENT_STATUS');
    const notes = String(body.notes || '').trim(); if (notes.length > 2000) throw errors.badRequest('备注不能超过 2000 个字符', 'ENROLLMENT_NOTES_TOO_LONG');
    const enrollmentId = id('enrollment'); const snapshot = packageSnapshot(pkg);
    await aq(`INSERT INTO student_enrollments(id,org_id,student_id,package_id,status,payment_status,price_fen,package_snapshot,starts_at,expires_at,notes,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [enrollmentId, currentOrgId, student.id, pkg.id, 'PENDING', paymentStatus, Number(pkg.price_fen || 0), json(snapshot), startsAt, expiresAt, notes, auth.user.id, auth.user.id, now, now]);
    await appendEnrollmentEvent({ enrollmentId, currentOrgId, eventType: 'CREATE', afterStatus: 'PENDING', actorId: auth.user.id, data: { packageId: pkg.id, paymentStatus, startsAt, expiresAt, notes } });
    const created = await enrollmentRow(currentOrgId, enrollmentId);
    await audit(ctx, 'STUDENT_ENROLLMENT_CREATE', 'STUDENT_ENROLLMENT', enrollmentId, null, await normalizeEnrollment(created), { orgId: currentOrgId });
    return await normalizeEnrollment(created, { includeEvents: true });
  }
  let enrollmentMatch = part.match(/^\/billing\/enrollments\/([^/]+)$/);
  if (enrollmentMatch && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看学员开通', 'ORG_ADMIN_REQUIRED');
    await expireDueEnrollments(currentOrgId);
    return await normalizeEnrollment(await enrollmentRow(currentOrgId, enrollmentMatch[1]), { includeEvents: true });
  }
  let enrollmentActionMatch = part.match(/^\/billing\/enrollments\/([^/]+)\/(payment-record|activate|suspend|resume|renew|void)$/);
  if (enrollmentActionMatch && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可操作学员开通', 'ORG_ADMIN_REQUIRED');
    await expireDueEnrollments(currentOrgId);
    const enrollment = await enrollmentRow(currentOrgId, enrollmentActionMatch[1]); const action = enrollmentActionMatch[2]; const before = enrollment.status; const now = nowIso();
    const pkg = await arow('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [enrollment.package_id, currentOrgId]);
    if (!pkg) throw errors.conflict('开通单关联套餐已不可用', 'ENROLLMENT_PACKAGE_MISSING');
    let after = before; let eventData = {};
    if (action === 'payment-record') {
      const paymentStatus = String(ctx.body?.paymentStatus || 'RECORDED').trim().toUpperCase();
      if (!PAYMENT_STATUSES.has(paymentStatus)) throw errors.badRequest('线下收款登记状态无效', 'INVALID_PAYMENT_STATUS');
      await assertTransition(ctx, 'payment', enrollment.payment_status, paymentStatus, {
        targetType: 'STUDENT_ENROLLMENT', targetId: enrollment.id, before: await normalizeEnrollment(enrollment),
        code: 'INVALID_PAYMENT_STATUS_TRANSITION', details: { action }, message: `收款状态 ${enrollment.payment_status} 不允许转换为 ${paymentStatus}`, allowSameState: true,
      });
    } else {
      const requestedStatus = { activate: 'ACTIVE', suspend: 'SUSPENDED', resume: 'ACTIVE', renew: 'ACTIVE', void: 'VOIDED' }[action];
      const allowedFrom = { activate: ['PENDING'], suspend: ['ACTIVE'], resume: ['SUSPENDED'], renew: ['ACTIVE', 'SUSPENDED', 'EXPIRED'], void: ['PENDING', 'SUSPENDED'] }[action];
      if (requestedStatus) await assertTransition(ctx, 'enrollment', before, requestedStatus, {
        targetType: 'STUDENT_ENROLLMENT', targetId: enrollment.id, before: await normalizeEnrollment(enrollment),
        code: 'INVALID_ENROLLMENT_TRANSITION', details: { action }, message: `当前开通单状态 ${before} 不允许执行 ${action}`, allowedFrom, allowSameState: action === 'renew',
      });
    }
    await atransaction(async () => {
      if (action === 'payment-record') {
        const paymentStatus = String(ctx.body?.paymentStatus || 'RECORDED').trim().toUpperCase();
        const notes = ctx.body?.notes === undefined ? enrollment.notes : String(ctx.body.notes || '').trim();
        if (notes.length > 2000) throw errors.badRequest('备注不能超过 2000 个字符', 'ENROLLMENT_NOTES_TOO_LONG');
        await aq('UPDATE student_enrollments SET payment_status=?,notes=?,updated_by=?,updated_at=? WHERE id=? AND org_id=?', [paymentStatus, notes, auth.user.id, now, enrollment.id, currentOrgId]);
        eventData = { paymentStatus, notes };
      } else if (action === 'activate') {
        if (before !== 'PENDING') throw errors.conflict('仅待开通记录可以完成开通', 'INVALID_ENROLLMENT_TRANSITION');
        if (pkg.status !== 'ACTIVE') throw errors.conflict('套餐已停用，不能继续开通', 'PACKAGE_DISABLED');
        await assertEnrollmentSeat(currentOrgId, pkg);
        after = 'ACTIVE';
        await aq("UPDATE student_enrollments SET status='ACTIVE',activated_at=?,updated_by=?,updated_at=? WHERE id=? AND org_id=?", [now, auth.user.id, now, enrollment.id, currentOrgId]);
        await setStudentEnrollmentAccess(currentOrgId, enrollment, 'ACTIVE');
      } else if (action === 'suspend') {
        if (before !== 'ACTIVE') throw errors.conflict('仅生效中的开通单可以停用', 'INVALID_ENROLLMENT_TRANSITION');
        after = 'SUSPENDED';
        await aq("UPDATE student_enrollments SET status='SUSPENDED',suspended_at=?,updated_by=?,updated_at=? WHERE id=? AND org_id=?", [now, auth.user.id, now, enrollment.id, currentOrgId]);
        await setStudentEnrollmentAccess(currentOrgId, enrollment, 'SUSPENDED');
      } else if (action === 'resume') {
        if (before !== 'SUSPENDED') throw errors.conflict('仅已停用记录可以恢复', 'INVALID_ENROLLMENT_TRANSITION');
        if (enrollment.expires_at <= now) throw errors.conflict('开通单已到期，请先续费后再恢复', 'ENROLLMENT_EXPIRED');
        if (pkg.status !== 'ACTIVE') throw errors.conflict('套餐已停用，不能恢复开通', 'PACKAGE_DISABLED');
        await assertEnrollmentSeat(currentOrgId, pkg, { excludeEnrollmentId: enrollment.id });
        after = 'ACTIVE';
        await aq("UPDATE student_enrollments SET status='ACTIVE',suspended_at=NULL,updated_by=?,updated_at=? WHERE id=? AND org_id=?", [auth.user.id, now, enrollment.id, currentOrgId]);
        await setStudentEnrollmentAccess(currentOrgId, enrollment, 'ACTIVE');
      } else if (action === 'renew') {
        if (!['ACTIVE', 'SUSPENDED', 'EXPIRED'].includes(before)) throw errors.conflict('当前开通单不能续费', 'INVALID_ENROLLMENT_TRANSITION');
        if (pkg.status !== 'ACTIVE') throw errors.conflict('套餐已停用，不能续费', 'PACKAGE_DISABLED');
        if (before !== 'ACTIVE') await assertEnrollmentSeat(currentOrgId, pkg, { excludeEnrollmentId: enrollment.id });
        const snapshot = parseJson(enrollment.package_snapshot, packageSnapshot(pkg)); const durationDays = Number(snapshot.durationDays || pkg.duration_days || 0);
        if (!Number.isInteger(durationDays) || durationDays < 1) throw errors.conflict('开通单套餐快照无有效期，无法续费', 'INVALID_ENROLLMENT_SNAPSHOT');
        const baseTime = Math.max(Date.parse(enrollment.expires_at), Date.now()); const expiresAt = new Date(baseTime + durationDays * 86400000).toISOString();
        after = 'ACTIVE'; eventData = { previousExpiresAt: enrollment.expires_at, expiresAt, durationDays };
        await aq("UPDATE student_enrollments SET status='ACTIVE',expires_at=?,activated_at=COALESCE(activated_at,?),suspended_at=NULL,updated_by=?,updated_at=? WHERE id=? AND org_id=?", [expiresAt, now, auth.user.id, now, enrollment.id, currentOrgId]);
        const renewed = { ...enrollment, expires_at: expiresAt };
        await setStudentEnrollmentAccess(currentOrgId, renewed, 'ACTIVE');
      } else if (action === 'void') {
        if (!['PENDING', 'SUSPENDED'].includes(before)) throw errors.conflict('仅待开通或已停用记录可以作废', 'INVALID_ENROLLMENT_TRANSITION');
        after = 'VOIDED';
        await aq("UPDATE student_enrollments SET status='VOIDED',voided_at=?,updated_by=?,updated_at=? WHERE id=? AND org_id=?", [now, auth.user.id, now, enrollment.id, currentOrgId]);
        if (before === 'SUSPENDED') await setStudentEnrollmentAccess(currentOrgId, enrollment, 'VOIDED');
      }
      await appendEnrollmentEvent({ enrollmentId: enrollment.id, currentOrgId, eventType: action.toUpperCase(), beforeStatus: before, afterStatus: after, actorId: auth.user.id, data: eventData });
    });
    const updated = await enrollmentRow(currentOrgId, enrollment.id);
    await audit(ctx, 'STUDENT_ENROLLMENT_' + action.toUpperCase(), 'STUDENT_ENROLLMENT', enrollment.id, await normalizeEnrollment(enrollment), await normalizeEnrollment(updated), { orgId: currentOrgId });
    return await normalizeEnrollment(updated, { includeEvents: true });
  }

  if (part === '/ai-usage' && method === 'GET') {
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 500, fallback: 200 });
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const modality = String(ctx.search.get('modality') || '').trim().toUpperCase();
    const status = String(ctx.search.get('status') || '').trim().toUpperCase();
    const sessionId = String(ctx.search.get('sessionId') || '').trim();
    const studentId = String(ctx.search.get('studentId') || '').trim();
    const search = String(ctx.search.get('search') || '').trim();
    if (modality && !['TEXT', 'IMAGE', 'MUSIC', 'VIDEO'].includes(modality)) throw errors.badRequest('不支持的素材类型', 'UNSUPPORTED_MODALITY');
    if (status && !['SUCCESS', 'FAILED', 'BLOCKED'].includes(status)) throw errors.badRequest('无效的用量状态', 'INVALID_USAGE_STATUS');
    const params = [currentOrgId, since]; const conditions = ['usage.org_id=?', 'usage.created_at>=?'];
    if (modality) { conditions.push('usage.modality=?'); params.push(modality); }
    if (status) { conditions.push('usage.status=?'); params.push(status); }
    if (sessionId) { conditions.push('usage.class_session_id=?'); params.push(sessionId); }
    if (studentId) { conditions.push('usage.user_id=?'); params.push(studentId); }
    if (auth.user.role === 'TEACHER') {
      // 批次 D：教师范围 = 「这笔用量挂在我创建的课堂上」
      const teacherUsageParams = [currentOrgId];
      const teacherUsageScope = sessionOwnedByTeacherExists('usage.class_session_id', auth, teacherUsageParams, { orgColumn: '?' });
      params.push(...teacherUsageParams);
      conditions.push(`(${teacherUsageScope.replace(/^ AND /, '')})`);
    }
    if (search) { const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'; conditions.push('(user.login LIKE ? OR user.display_name LIKE ? OR project.title LIKE ? OR class.name LIKE ? OR usage.fail_code LIKE ?)'); params.push(keyword, keyword, keyword, keyword, keyword); }
    const items = (await arows(`SELECT \`usage\`.*,user.login user_login,user.display_name user_name,project.title project_title,project.course_lesson_id project_lesson_id,
      session.title session_title,session.lesson_id session_lesson_id,lesson.title lesson_title,
      job.provider job_provider,job.model job_model,
      attempt.sale_price_fen sale_price_fen
      FROM usage_records AS \`usage\`
      LEFT JOIN users user ON user.id=usage.user_id AND user.org_id=usage.org_id
      LEFT JOIN student_projects project ON project.id=usage.project_id AND project.org_id=usage.org_id
      LEFT JOIN class_sessions session ON session.id=usage.class_session_id
      LEFT JOIN course_lessons lesson ON lesson.id=COALESCE(session.lesson_id, project.course_lesson_id)
      LEFT JOIN generation_jobs job ON job.id=usage.generation_job_id AND job.org_id=usage.org_id
      -- 对外售价口径（2026-09-15）：金额取算力账本里逐笔写的售价快照，不再读 usage_records.cost_fen
      -- （那一列现行代码恒为 0）。只认成功尝试 —— 失败与主备重试没有交付东西，不该显示消耗。
      LEFT JOIN compute_attempts attempt ON attempt.id = (
        SELECT a.id FROM compute_attempts a WHERE a.call_id = usage.compute_call_id AND a.status='SUCCESS'
        ORDER BY a.attempt LIMIT 1)
      WHERE ${conditions.join(' AND ')} ORDER BY usage.created_at DESC LIMIT ${limit}`, params)).map((item) => ({
      id: item.id, userId: item.user_id, userLogin: item.user_login || null, userName: item.user_name || null,
      classSessionId: item.class_session_id || null, classId: item.class_id || null, sessionTitle: item.session_title || null,
      lessonId: item.session_lesson_id || item.project_lesson_id || null, lessonTitle: item.lesson_title || null,
      projectId: item.project_id || null, projectTitle: item.project_title || null, generationJobId: item.generation_job_id || null,
      modality: item.modality, model: item.model || item.job_model || null, provider: item.job_provider || null,
      // 对外售价口径（分）：机构端看到的「消耗」就是它；平台自己的进货成本与毛利只在平台端「用量与成本」看。
      // 没有关联算力记录的历史行（2026-09-13 之前）没有售价证据，按「缺证据不猜」记 0。
      costFen: Number(item.sale_price_fen || 0),
      status: item.status, failCode: item.fail_code || null, createdAt: item.created_at,
    }));
    return { items, total: items.length, filters: { days, modality: modality || null, status: status || null, sessionId: sessionId || null, studentId: studentId || null } };
  }
  if (part === '/billing/usage-overview' && method === 'GET') {
    // 2026-09-15 口径定稿：机构端「消耗」= **对外售价合计**（算力账本里逐笔写的公告价快照，只计成功尝试）。
    // 原来读 usage_records.cost_fen —— 那一列现行代码恒为 0（平台承担成本、不扣学生），
    // 于是这个账单页面永远显示 0。平台自己的进货成本与毛利只在平台端「用量与成本」看。
    const SALE_FEN = salePriceFenSuccessSql();
    const SALE_FEN_ATTEMPT = salePriceFenSuccessSql('attempt');
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 }); const since = new Date(Date.now() - days * 86400000).toISOString();
    const totals = await arow(`SELECT ${SALE_FEN} costFen, COUNT(DISTINCT call_id) calls FROM compute_attempts WHERE org_id=? AND created_at>=?`, [currentOrgId, since]);
    return {
      totalFen: Number(totals?.costFen || 0), calls: Number(totals?.calls || 0),
      modalities: await arows(`SELECT modality,${SALE_FEN} costFen,COUNT(DISTINCT call_id) calls FROM compute_attempts WHERE org_id=? AND created_at>=? GROUP BY modality ORDER BY costFen DESC`, [currentOrgId, since]),
      topUsers: await arows(`SELECT user.id,user.display_name studentName,${SALE_FEN_ATTEMPT} costFen,COUNT(DISTINCT attempt.call_id) calls FROM compute_attempts attempt JOIN users user ON user.id=attempt.user_id AND user.org_id=attempt.org_id WHERE attempt.org_id=? AND attempt.created_at>=? GROUP BY user.id ORDER BY costFen DESC LIMIT 10`, [currentOrgId, since]),
    };
  }

  if (part === '/course-series' && method === 'GET') {
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 50 });
    const fromWhere = `FROM course_series series LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND ${assignmentActiveSql()} WHERE series.status='PUBLISHED' AND ${orgSeriesAccessSql()}`;
    const total = Number((await arow(`SELECT COUNT(DISTINCT series.id) n ${fromWhere}`, [currentOrgId, currentOrgId]))?.n || 0);
    // 平台给本机构的授权次数（页面要显示「还剩几次」）：单独查一次，别动上面那条 DISTINCT 查询
    const quotaBySeries = new Map((await arows("SELECT series_id, quota_total, quota_used FROM course_assignments WHERE org_id=? AND status='ACTIVE' AND (expires_at IS NULL OR expires_at > ?)", [currentOrgId, nowIso()])).map((item) => [item.series_id, { quotaTotal: Number(item.quota_total || 0), quotaUsed: Number(item.quota_used || 0) }]));
    const items = await amap((await arows(`SELECT DISTINCT series.* ${fromWhere} ORDER BY series.sort,series.title LIMIT ? OFFSET ?`, [currentOrgId, currentOrgId, limit, offset])), async (series) => ({ ...await normalizeSeries(series, { orgId: currentOrgId, includeLessons: true, includeTeaching: true, asPublished: true }), assignments: [quotaBySeries.get(series.id) || { quotaTotal: 0, quotaUsed: 0 }] }));
    return pageResult(items, { page, limit, total });
  }
  let orgCourseDetailMatch = part.match(/^\/course-series\/([^/]+)$/);
  if (orgCourseDetailMatch && method === 'GET') {
    const series = await arow(`SELECT series.* FROM course_series series LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND ${assignmentActiveSql()} WHERE series.id=? AND series.status='PUBLISHED' AND ${orgSeriesAccessSql()}`, [currentOrgId, orgCourseDetailMatch[1], currentOrgId]);
    if (!series) throw errors.notFound('课包不存在或不可访问', 'COURSE_SERIES_NOT_FOUND');
    const detail = await normalizeSeries(series, { orgId: currentOrgId, includeLessons: true, includeTeaching: true, asPublished: true });
    // 「有哪些课时」已经由 normalizeSeries 里的 publishedLessonVisibilitySql 判完了，这里**不要**再
    // 加一道自己的过滤 —— 2026-09-20 那道 `filter(l => l.status === 'PUBLISHED')` 就是"两条规则打架"：
    // 它读的是**实时** status，于是把「快照里已发布、实时被下掉」的课时从机构端滤没了，
    // 与「没更新发布就还按上一版给机构看」的口径正好相反。判据只留一处。
    return detail;
  }
  /* ─────────────── 课堂（2026-09-13 批次 B：班级退场，课堂成为主对象）───────────────
   *
   * 四态：待上课（创建即此）→ 上课中（老师点开始）→ 已结束（老师点结束）；
   *       待上课也可直接「解散」。学员六态与完课判定见 services/classroomSessions.js。
   * 教师只能操作自己创建的课堂（sessionScope / assertSessionManager），机构管理员管全机构。
   * ⚠️ 下列接口与旧的 /classes/* 并存一段时间：界面已切到课堂，旧接口留待批次 D 清理。
   */
  const assertTeacherSessionAvailable = async (teacherId, excludeId = '') => {
    // ⚠️ 2026-09-20（用户报「我登录的是机构测试账号，为什么说我账号异常或已停用」）：
    //    这里以前**完全不查账号能不能用**（不是 TEACHER 就直接 return），而界面上的预检
    //    （sessionPrecheck）却要求 `role === 'TEACHER'` —— 两条规则不一致，机构管理员建的课堂
    //    在界面上被标成「账号异常或已停用」（其实一点问题都没有，点开始上课也能开）。现在统一：
    //    「能不能教学」= 账号存在、未删除、未停用；「有没有被别的课堂占着」只对 TEACHER 角色算。
    const teacher = await arow('SELECT role, status, deleted_at, display_name FROM users WHERE id=?', [teacherId]);
    if (!teacher) throw errors.badRequest('课堂的负责账号不存在', 'TEACHER_NOT_FOUND');
    if (teacher.deleted_at) throw errors.badRequest('课堂的负责账号已删除，请先换一位负责老师', 'TEACHER_DELETED');
    if (teacher.status !== 'ACTIVE') throw errors.badRequest('课堂的负责账号已停用，请先换一位负责老师', 'TEACHER_DISABLED');
    if (teacher.role !== 'TEACHER') return;
    const occupied = await arow("SELECT id,title FROM class_sessions WHERE teacher_id=? AND status IN ('PENDING','ACTIVE') AND id<>? LIMIT 1", [teacherId, excludeId]);
    if (occupied) throw errors.conflict(`教师已有待上课或上课中的课堂（${occupied.title || occupied.id}），请先结束或解散`, 'TEACHER_SESSION_OCCUPIED');
  };
  /**
   * 「开始上课 / 解散课堂」二次确认弹窗里的逐条校验（2026-09-17）。
   *
   * 为什么要有它：确认弹窗要逐条显示「通过」，而这些检查原来只散落在下面各个 POST 的 throw 里。
   * 前端凭详情字段推，其中「老师账号是否可正常教学」「N 名学生资格是否仍有效」两条根本推不出来
   * —— 在界面上给一条没真跑过的检查打绿勾，就是在撒谎，所以判定挪到服务端，界面只负责显示。
   *
   * ⚠️ 这里**只读、只给界面看**。真正的写操作仍以下面 POST 里的断言为准：
   * 预检通过之后状态可能已经被别人改了，预检不是放行凭据。
   */
  const sessionPrecheck = async (session, action) => {
    const check = (key, label, passed, detail) => ({ key, label, passed: Boolean(passed), detail });
    const pendingLabel = normalizeSession(session).statusLabel || session.status;
    const statusCheck = check('SESSION_PENDING', '课堂状态 = 待上课', session.status === 'PENDING',
      session.status === 'PENDING' ? '当前状态正确' : `当前是「${pendingLabel}」`);
    if (action === 'dissolve') {
      return [
        statusCheck,
        check('NOT_STARTED', '尚未记录实际开始时间', !session.started_at,
          session.started_at ? `已记录开始时间 ${session.started_at}` : '实际开始时间仍为空'),
        // 与写路径同一口径：负责人本人，或本机构的机构管理员（canManageSession）
        check('OWNER_MATCH', '课堂由你负责，或你是本机构的机构管理员', canManageSession(auth, session),
          canManageSession(auth, session) ? '你有权管理这个课堂' : '你不是这个课堂的负责老师，也不是本机构的机构管理员'),
      ];
    }
    const teacher = await arow('SELECT id, display_name, status, role, deleted_at FROM users WHERE id=?', [session.teacher_id]);
    // ⚠️ 2026-09-20：**预检必须与写路径同一口径**（`assertTeacherSessionAvailable`）——
    //    以前这里要求必须是 `TEACHER` 角色，而写路径对非 TEACHER 直接放行，于是机构管理员
    //    （`teacher_id` 默认就是创建者自己，见建课堂那处 `let teacherId = auth.user.id`）建的课堂
    //    在界面上被标红成「账号异常或已停用」，点开始上课却能开 —— 界面在撒谎。
    //    现在：可用 = 存在 / 未删除 / 未停用；「被别的课堂占着」只对 TEACHER 角色算。
    const teacherUsable = Boolean(teacher) && !teacher.deleted_at && teacher.status === 'ACTIVE';
    const teacherBusy = teacherUsable && teacher.role === 'TEACHER'
      ? await arow("SELECT id,title FROM class_sessions WHERE teacher_id=? AND status IN ('PENDING','ACTIVE') AND id<>? LIMIT 1", [session.teacher_id, session.id])
      : null;
    const lessonOk = Boolean(await arow("SELECT lesson.id FROM course_lessons lesson JOIN course_series series ON series.id=lesson.series_id WHERE lesson.id=? AND lesson.status='PUBLISHED' AND series.status='PUBLISHED'", [session.lesson_id]))
      && Boolean(await accessibleLesson(currentOrgId, session.lesson_id));
    const roster = await arows(`SELECT part.student_id, student.display_name, student.login, student.status account_status, student.expires_at
      FROM session_students part JOIN users student ON student.id=part.student_id
      WHERE part.session_id=? AND part.status='PENDING'`, [session.id]);
    const seriesRow = await arow('SELECT id, series_type FROM course_series WHERE id=?', [session.series_id]);
    const experience = isExperienceSeries(seriesRow);
    const balanceByStudent = await experienceBalanceByStudent({ orgId: session.org_id, seriesId: session.series_id });
    const granted = new Set(balanceByStudent.keys());
    const ineligible = roster.filter((item) => item.account_status !== 'ACTIVE'
      || (item.expires_at && Date.parse(item.expires_at) <= Date.now()) || !granted.has(item.student_id)
      // 体验课包：次数用完的学生**开始上课前**就该拦下来（否则结束结算时才会失败，老师更被动）
      || (experience && (balanceByStudent.get(item.student_id) || 0) <= 0));
    return [
      statusCheck,
      check('TEACHER_READY', '教师账号可正常教学', teacherUsable && !teacherBusy,
        !teacher ? '找不到课堂的负责账号'
          : teacher.deleted_at ? `${teacher.display_name || '未知教师'} · 账号已删除`
            : teacher.status !== 'ACTIVE' ? `${teacher.display_name || '未知教师'} · 账号已停用`
              : teacherBusy ? `${teacher.display_name} · 另有待上课/上课中的课堂（${teacherBusy.title || teacherBusy.id}）`
                : `${teacher.display_name} · 状态正常（${teacher.role === 'TEACHER' ? '老师' : '机构管理员'}账号）`),
      check('LESSON_AVAILABLE', '课包 / 课程当前可用', lessonOk, lessonOk ? '当前版本与课程有效' : '课时未发布或课包授权已失效'),
      check('ROSTER_NOT_EMPTY', '课堂至少有 1 名学生', roster.length > 0, `当前 ${roster.length} 名`),
      check('STUDENTS_ELIGIBLE', `${roster.length} 名学生资格仍有效`, roster.length > 0 && ineligible.length === 0,
        ineligible.length
          ? `${ineligible.length} 名已失效：${ineligible.slice(0, 3).map((item) => item.display_name || item.login).join('、')}${ineligible.length > 3 ? ' 等' : ''}`
          : (experience ? '账号 / 课包许可 / 体验次数均通过' : '账号 / 课包许可均通过')),
    ];
  };
  const sessionInOrg = async (id, { manage = true } = {}) => {
    const value = await arow('SELECT * FROM class_sessions WHERE id=?', [id]);
    if (!value) throw errors.notFound('课堂不存在', 'SESSION_NOT_FOUND');
    if (value.org_id !== currentOrgId) throw errors.notFound('课堂不存在', 'SESSION_NOT_FOUND');
    return manage || auth.user.role === 'TEACHER' ? assertSessionManager(auth, value) : value;
  };

  /**
   * 「作品详情 / 作品图片 / 作品文件」三条读路由的**作用域**（2026-09-20）。
   *
   * 原来只有**课堂作用域**（`/sessions/:id/works/...`）：机构端/老师在课堂详情里点「查看作品」走它。
   * 但「作品管理」那个页面是按**机构**看的 —— 一份 VibeCoding 作品可能没有课堂
   * （老数据、或提交时没挂课堂），用课堂作用域根本打不开。于是同一套读逻辑现在支持两种作用域：
   *   · session：课堂属于本机构 **且** 作品挂在这堂课里（原行为，一字不改）；
   *   · org    ：作品属于本机构即可（机构内可见，不看有没有课堂）。
   * 两种作用域返回**同一套 URL 前缀**，前端（ClassroomWork）才能一处复用。
   */
  const resolveWorkScope = async (sessionId) => {
    if (!sessionId) return { sessionId: null, base: '/api/org/works' };
    const session = await sessionInOrg(sessionId, { manage: false });
    return { sessionId: session.id, base: `/api/org/sessions/${encodeURIComponent(session.id)}/works` };
  };
  /** VibeCoding 作品：课堂作用域要它挂在这堂课里；机构作用域只认机构。 */
  const vibeWorkWhere = (scope) => (scope.sessionId
    ? { sql: 'submission.id=? AND submission.org_id=? AND conversation.class_session_id=?', params: [] }
    : { sql: 'submission.id=? AND submission.org_id=?', params: [] });

  // 机构/老师看**私有作品里的真文件**（学生创作环境交上来的 PPT/Word/Excel 原文件）。
  // 预览走服务端转出来的 PDF、下载给原文件；准入与图片那条一样 ——
  // **只认这份作品快照里出现过的 fileId**，拿得到别人的 id 也读不到别人的文件。
  // （作品没发布时走不了公开地址，所以机构端必须有自己的这一条。）
  const sessionWorkFileMatch = part.match(/^\/sessions\/([^/]+)\/works\/(VIBECODING)\/([^/]+)\/files\/(.+?)\/(preview|download)$/);
  const orgWorkFileMatch = part.match(/^\/works\/(VIBECODING)\/([^/]+)\/files\/(.+?)\/(preview|download)$/);
  if ((sessionWorkFileMatch || orgWorkFileMatch) && method === 'GET') {
    const scope = sessionWorkFileMatch ? await resolveWorkScope(sessionWorkFileMatch[1]) : await resolveWorkScope(null);
    const [, workId, rawName, mode] = sessionWorkFileMatch
      ? [, sessionWorkFileMatch[3], sessionWorkFileMatch[4], sessionWorkFileMatch[5]]
      : [, orgWorkFileMatch[2], orgWorkFileMatch[3], orgWorkFileMatch[4]];
    let name = '';
    try { name = decodeURIComponent(rawName); } catch { throw errors.badRequest('文件名编码无效', 'INVALID_FILE_NAME_ENCODING'); }
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) throw errors.badRequest('文件名不合法', 'INVALID_FILE_NAME');
    const work = await arow(`SELECT submission.*,student.display_name student_name FROM vibecoding_submissions submission
          JOIN vibecoding_conversations conversation ON conversation.id=submission.conversation_id
            AND conversation.org_id=submission.org_id AND conversation.student_id=submission.student_id
          JOIN users student ON student.id=submission.student_id AND student.org_id=submission.org_id
          WHERE ${vibeWorkWhere(scope).sql}`, scope.sessionId ? [workId, currentOrgId, scope.sessionId] : [workId, currentOrgId]);
    if (!work) throw errors.notFound(scope.sessionId ? '作品不属于此课堂' : '作品不存在', 'SESSION_WORK_NOT_FOUND');
    const fileId = snapshotArtifactByName(work, name)?.fileId;
    if (!fileId || !snapshotDocumentFileIds(work).has(String(fileId))) {
      throw errors.notFound('文件不属于此作品', 'SESSION_WORK_FILE_NOT_FOUND');
    }
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
    if (!file || file.storage_kind !== 'INTERNAL_PROXY' || file.status !== 'ACTIVE') throw errors.notFound('作品文件不可用', 'SESSION_WORK_FILE_NOT_FOUND');
    if (file.expires_at && Date.parse(file.expires_at) <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
    return mode === 'preview' ? prepareFilePreview(ctx, file) : prepareFileDownload(ctx, file);
  }

  const sessionWorkMatch = part.match(/^\/sessions\/([^/]+)\/works\/(CANVAS|VIBECODING)\/([^/]+)(?:\/images\/([^/]+))?$/);
  const orgWorkMatch = part.match(/^\/works\/(CANVAS|VIBECODING)\/([^/]+)(?:\/images\/([^/]+))?$/);
  if ((sessionWorkMatch || orgWorkMatch) && method === 'GET') {
    const scope = sessionWorkMatch ? await resolveWorkScope(sessionWorkMatch[1]) : await resolveWorkScope(null);
    const [source, workId, imageId] = sessionWorkMatch
      ? [sessionWorkMatch[2], sessionWorkMatch[3], sessionWorkMatch[4]]
      : [orgWorkMatch[1], orgWorkMatch[2], orgWorkMatch[3]];
    const work = source === 'CANVAS'
      ? await arow(`SELECT work.*,student.display_name student_name FROM works work
          JOIN users student ON student.id=work.student_id AND student.org_id=work.org_id
          WHERE work.id=? AND work.org_id=?${scope.sessionId ? ' AND work.class_session_id=?' : ''}`,
          scope.sessionId ? [workId, currentOrgId, scope.sessionId] : [workId, currentOrgId])
      : await arow(`SELECT submission.*,student.display_name student_name FROM vibecoding_submissions submission
          JOIN vibecoding_conversations conversation ON conversation.id=submission.conversation_id
            AND conversation.org_id=submission.org_id AND conversation.student_id=submission.student_id
          JOIN users student ON student.id=submission.student_id AND student.org_id=submission.org_id
          WHERE ${vibeWorkWhere(scope).sql}`,
          scope.sessionId ? [workId, currentOrgId, scope.sessionId] : [workId, currentOrgId]);
    if (!work) throw errors.notFound(scope.sessionId ? '作品不属于此课堂' : '作品不存在', 'SESSION_WORK_NOT_FOUND');
    const canvasSnapshot = source === 'CANVAS' ? (await normalizeWork(work, { includeSnapshot: true })).canvasSnapshot : null;
    // 准入清单 = 画布里挂的站内素材 **∪ 生成产物归档件**。后者不在画布上也照样是"这件作品的东西"
    // （作品读面会把 media_assets 列出来给老师看）—— 少这一半就是"界面上看得到地址、点开 404"。
    const allowedImages = source === 'VIBECODING' ? snapshotImageFileIds(work) : new Set([
      ...(Array.isArray(canvasSnapshot?.nodes) ? canvasSnapshot.nodes : []).flatMap((node) =>
        ['previewUrl', 'assetUrl', 'referenceUrl'].map((key) => String(node?.data?.[key] || '').match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:\?.*)?$/)?.[1]).filter(Boolean)),
      ...canvasMediaFrom(canvasSnapshot).map((item) => item.fileId).filter(Boolean),
      ...(await arows('SELECT asset_url FROM media_assets WHERE project_id=?', [work.project_id])).map((asset) => String(asset.asset_url || '').match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:\?.*)?$/)?.[1]).filter(Boolean),
    ]);
    if (imageId) {
      if (!allowedImages.has(imageId)) throw errors.notFound('图片不属于此作品', 'SESSION_WORK_IMAGE_NOT_FOUND');
      const file = await arow('SELECT * FROM file_assets WHERE id=?', [imageId]);
      if (!file || file.storage_kind !== 'INTERNAL_PROXY' || file.status !== 'ACTIVE' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'video/mp4', 'video/webm'].includes(String(file.mime_type || '').toLowerCase())
        || (file.owner_user_id !== work.student_id && !['PUBLIC_PLATFORM', 'PUBLIC_RELEASE'].includes(file.visibility))
        || (file.expires_at && Date.parse(file.expires_at) <= Date.now())) throw errors.notFound('作品图片不可用', 'SESSION_WORK_IMAGE_NOT_FOUND');
      return String(file.mime_type || '').toLowerCase().startsWith('image/') ? prepareWorkImage(ctx, file) : prepareFileDownload(ctx, file);
    }
    const base = { id: work.id, source, title: work.title, studentId: work.student_id, studentName: work.student_name || null, status: work.status, submittedAt: work.submitted_at };
    const imageUrls = Object.fromEntries([...allowedImages].map((fileId) => [fileId, `${scope.base}/${source}/${encodeURIComponent(work.id)}/images/${encodeURIComponent(fileId)}`]));
    // 作品页要展示的**媒体**（图/视频/音频）——老师端预览也要看"做出来的东西"，不是画布
    // （用户 2026-09-21：「应该显示的是图片/视频/音频等等，而不是画布」）。
    if (source === 'CANVAS') return { ...base, canvasSnapshot, imageUrls, media: canvasMediaFrom(canvasSnapshot) };
    const content = normalizeSubmission(work, { includeContent: true });
    // 真文件产物（学生创作环境交上来的 PPT/Word/Excel）的取用地址也在服务端拼好：
    // 前端不该自己去拼路由（前缀/编码错一处就是 404，而且两边都没法测）。
    const workBase = `${scope.base}/VIBECODING/${encodeURIComponent(work.id)}`;
    const fileUrls = Object.fromEntries(parseSnapshotArtifacts(work)
      .filter((item) => item.fileId)
      .map((item) => [item.name, {
        preview: `${workBase}/files/${encodeURIComponent(item.name)}/preview`,
        download: `${workBase}/files/${encodeURIComponent(item.name)}/download`,
      }]));
    // Keep private references intact; the authenticated viewer resolves them to local blob URLs.
    return { ...base, files: content.files, entryFile: content.entryFile, artifacts: content.artifacts, preview: content.preview, imageUrls, fileUrls };
  }

  if (part === '/sessions' && method === 'GET') {
    // 2026-09-17：补上真分页与四态计数。原先是硬编码 LIMIT 200、不返回总数 ——
    // 界面上做不出「共 N 条 / 翻页」，超过 200 个课堂的机构还会**静默**看不到后面的，
    // 正是本项目最主要的失败类型（字段没人填、界面不报错）。
    const baseParams = [currentOrgId];
    const baseConditions = ['1=1'];
    // 课堂归属：org_id 是权威列（老数据迁移时从负责老师回填过）
    baseConditions.push('session.org_id = ?');
    const scope = sessionScope('session', auth, baseParams);
    if (scope) baseConditions.push(scope.replace(/^ AND /, ''));
    const lessonId = String(ctx.search.get('lessonId') || '').trim();
    if (lessonId) { baseConditions.push('session.lesson_id=?'); baseParams.push(lessonId); }
    const seriesId = String(ctx.search.get('seriesId') || '').trim();
    if (seriesId) { baseConditions.push('session.series_id=?'); baseParams.push(seriesId); }
    const search = String(ctx.search.get('search') || '').trim();
    if (search) { baseConditions.push('(session.title LIKE ? OR lesson.title LIKE ?)'); baseParams.push(`%${search}%`, `%${search}%`); }
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 90 });
    baseConditions.push('COALESCE(session.created_at, session.started_at) >= ?');
    baseParams.push(new Date(Date.now() - days * 86400000).toISOString());
    // 状态过滤单独拼：四张状态汇总卡要的是**不带状态过滤**的口径，
    // 否则选中某个状态之后另外三张卡会全部归零，看着像数据丢了。
    const status = String(ctx.search.get('status') || '').trim().toUpperCase();
    const statusFiltered = ['PENDING', 'ACTIVE', 'ENDED', 'DISSOLVED'].includes(status);
    const conditions = statusFiltered ? [...baseConditions, 'session.status=?'] : baseConditions;
    const params = statusFiltered ? [...baseParams, status] : baseParams;
    const FROM = `FROM class_sessions session
      LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
      LEFT JOIN course_series series ON series.id = session.series_id
      LEFT JOIN users teacher ON teacher.id = session.teacher_id`;
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 20, maxLimit: 100 });
    const total = await acount(`SELECT COUNT(*) n ${FROM} WHERE ${conditions.join(' AND ')}`, params);
    const statusCounts = { PENDING: 0, ACTIVE: 0, ENDED: 0, DISSOLVED: 0 };
    for (const item of await arows(`SELECT session.status status, COUNT(*) n ${FROM} WHERE ${baseConditions.join(' AND ')} GROUP BY session.status`, baseParams)) {
      if (statusCounts[item.status] !== undefined) statusCounts[item.status] = Number(item.n || 0);
    }
    const items = await arows(`SELECT session.*, lesson.title lesson_title, lesson.sort lesson_sort, series.title series_title,
        teacher.display_name teacher_name
      ${FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY CASE session.status WHEN 'ACTIVE' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,
               COALESCE(session.started_at, session.created_at) DESC
      LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const counts = await sessionStudentCounts(items.map((item) => item.id));
    return {
      ...pageResult(items.map((item) => ({
        ...normalizeSession(item),
        studentCount: (counts.get(`${item.id}:PENDING`) || 0) + (counts.get(`${item.id}:ACTIVE`) || 0)
          + (counts.get(`${item.id}:COMPLETED`) || 0) + (counts.get(`${item.id}:INCOMPLETE`) || 0),
        completedCount: counts.get(`${item.id}:COMPLETED`) || 0,
      })), { page, limit, total }),
      statusCounts,
      ongoingSession: auth.user.role === 'TEACHER' ? await arow("SELECT id,title,status FROM class_sessions WHERE org_id=? AND teacher_id=? AND status IN ('PENDING','ACTIVE') ORDER BY created_at DESC LIMIT 1", [currentOrgId, auth.user.id]) || null : null,
      filters: { status: statusFiltered ? status : null, days, seriesId: seriesId || null, lessonId: lessonId || null },
    };
  }
  if (part === '/sessions' && method === 'POST') {
    const body = ctx.body || {};
    const lessonId = String(body.lessonId || '').trim();
    if (!lessonId) throw errors.badRequest('请选择这节课（课包里的第几节）', 'SESSION_LESSON_REQUIRED');
    const lesson = await arow("SELECT * FROM course_lessons WHERE id=? AND status='PUBLISHED'", [lessonId]);
    if (!lesson) throw errors.notFound('课时不存在或未发布', 'LESSON_NOT_FOUND');
    if (!await accessibleLesson(currentOrgId, lessonId)) throw errors.forbidden('这个课包还没有授权给本机构', 'COURSE_NOT_ASSIGNED');
    const publishedLesson = await normalizeLesson(lesson, { asPublished: true });
    const deliveryMode = String(body.deliveryMode || publishedLesson.deliveryMode || 'CANVAS').trim().toUpperCase();
    if (!['CANVAS', 'VIBECODING'].includes(deliveryMode) || !publishedLesson.deliveryModes.includes(deliveryMode)) throw errors.badRequest('该课时未发布此入口类型', 'INVALID_DELIVERY_MODE');
    // 负责老师：教师建课挂自己；机构管理员可以指定本机构的教师，默认也挂自己
    let teacherId = auth.user.id;
    if (auth.user.role === 'ORG_ADMIN' && body.teacherId) {
      const teacher = await arow("SELECT id FROM users WHERE id=? AND org_id=? AND role='TEACHER' AND deleted_at IS NULL", [String(body.teacherId), currentOrgId]);
      if (!teacher) throw errors.badRequest('指定的老师不属于本机构', 'INVALID_TEACHER');
      teacherId = teacher.id;
    }
    const lessonCapabilities = (await lessonCanvasConfig(lessonId)).capabilities || [];
    const capability = body.capabilities || {};
    const capabilityDefault = (flag, key) => (capability[flag] === undefined ? (lessonCapabilities.includes(key) ? 1 : 0) : (capability[flag] ? 1 : 0));
    const sessionId = id('csession');
    const now = nowIso();
    const title = String(body.title || '').trim().slice(0, 120)
      || `${lesson.title} · ${new Date(now).toISOString().slice(5, 10)}`;
    await atransaction(async () => {
      await assertTeacherSessionAvailable(teacherId);
      // 2026-09-18（用户口径，两次更正后的最终口径）：学生算力额度**只观测、不真拦**
      // （原话：「学生算力额度的设置目前都是不真拦，都是给我们内部看的」）。
      // 这里写的是 `student_cost_cap_fen`：本课堂**每名学生**的**算力观测上限（分）**，
      // 依据上游成本（`compute_attempts.upstream_cost_fen`），只用于老师端/平台端看数
      // （见 services/sessionCostCap.js，`enforced` 恒 false）——**它不会拦任何一次调用**。
      // **留空/不传 = NULL = 不设观测上限**（照样记账、照样统计，只是没有"超没超"可比）。
      // 字段名：capabilities.studentCostCapFen（单位「分」，不是次数；老字段 studentCallCap
      // 已退役，**故意不做单位换算**：把「次数」乘一个价猜成钱等于凭空发明数字）。
      await aq(`INSERT INTO class_sessions(id, title, org_id, series_id, lesson_id, teacher_id, status, delivery_mode,
         ai_paused, student_cost_cap_fen, allow_text, allow_image, allow_music, allow_video, allow_podcast, allow_dubbing, created_at, updated_at, platform_budget_fen)
       VALUES (?,?,?,?,?,?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, title, currentOrgId, lesson.series_id, lessonId, teacherId, deliveryMode,
      capability.aiPaused ? 1 : 0,
      // 空串也算「没填」→ NULL（留空 = 不设观测上限；显式 0 也拒绝，避免出现一个"看起来超了"的假分母）。
      capability.studentCostCapFen === undefined || capability.studentCostCapFen === null || capability.studentCostCapFen === ''
        ? null
        : integer(capability.studentCostCapFen, '算力观测上限（分/人）', { min: 1, max: 100000000 }),
      capabilityDefault('allowText', 'text'), capabilityDefault('allowImage', 'image'),
      capabilityDefault('allowMusic', 'music'), capabilityDefault('allowVideo', 'video'), 0, 0, now, now, publishedLesson.platformBudgetFen ?? null]);
    });
    await audit(ctx, 'SESSION_CREATE', 'CLASS_SESSION', sessionId, null, { title, lessonId, deliveryMode, teacherId });
    const created = await arow(`SELECT session.*, lesson.title lesson_title, lesson.sort lesson_sort, series.title series_title, teacher.display_name teacher_name
      FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id
      LEFT JOIN course_series series ON series.id=session.series_id LEFT JOIN users teacher ON teacher.id=session.teacher_id
      WHERE session.id=?`, [sessionId]);
    return normalizeSession(created);
  }
  let sessionDetailMatch = part.match(/^\/sessions\/([^/]+)$/);
  if (sessionDetailMatch && method === 'PUT') {
    return await atransaction(async () => {
    const target = await sessionInOrg(sessionDetailMatch[1]);
    if (target.status !== 'PENDING') throw errors.conflict('只有待上课课堂可以编辑名称', 'SESSION_NOT_PENDING');
    const body = ctx.body || {};
    const titleProvided = Object.prototype.hasOwnProperty.call(body, 'title');
    const lessonProvided = Object.prototype.hasOwnProperty.call(body, 'lessonId');
    const title = titleProvided ? String(body.title || '').trim().slice(0, 120) : target.title;
    if (titleProvided && !title) throw errors.badRequest('课堂名称不能为空', 'SESSION_TITLE_REQUIRED');
    if (!lessonProvided && !Object.prototype.hasOwnProperty.call(body, 'deliveryMode')) {
      await aq('UPDATE class_sessions SET title=?,updated_at=? WHERE id=?', [title, nowIso(), target.id]);
      const updated = await arow('SELECT * FROM class_sessions WHERE id=?', [target.id]);
      await audit(ctx, 'SESSION_UPDATE', 'CLASS_SESSION', target.id, normalizeSession(target), { ...normalizeSession(updated), swappedLesson: false, rosterCleared: false });
      return normalizeSession(updated);
    }
    const nextLessonId = lessonProvided ? String(body.lessonId || '').trim() : target.lesson_id;
    if (!nextLessonId) throw errors.badRequest('请选择这节课（课包里的第几节）', 'SESSION_LESSON_REQUIRED');
    const nextLesson = await arow("SELECT * FROM course_lessons WHERE id=? AND status='PUBLISHED'", [nextLessonId]);
    if (!nextLesson) throw errors.notFound('课时不存在或未发布', 'LESSON_NOT_FOUND');
    if (!await accessibleLesson(currentOrgId, nextLessonId)) throw errors.forbidden('这个课包还没有授权给本机构', 'COURSE_NOT_ASSIGNED');
    const roster = Number((await arow("SELECT COUNT(*) n FROM session_students WHERE session_id=? AND status<>'REMOVED'", [target.id]))?.n || 0);
    if (lessonProvided && nextLessonId !== target.lesson_id && roster > 0 && body.confirmClearStudents !== true) throw errors.conflict('换课会清空当前课堂名单，请明确确认', 'SESSION_SWAP_CONFIRM_REQUIRED');
    const publishedLesson = await normalizeLesson(nextLesson, { asPublished: true });
    // 未显式传 deliveryMode 时，换课取新课默认；同课编辑保留现有配置。
    const lessonChanged = lessonProvided && nextLessonId !== target.lesson_id;
    const deliveryMode = String(Object.prototype.hasOwnProperty.call(body, 'deliveryMode') ? (body.deliveryMode ?? '') : ((lessonChanged ? publishedLesson.deliveryMode : target.delivery_mode) || 'CANVAS')).trim().toUpperCase();
    if (!['CANVAS', 'VIBECODING'].includes(deliveryMode) || !publishedLesson.deliveryModes.includes(deliveryMode)) throw errors.badRequest('该课时未发布此入口类型', 'INVALID_DELIVERY_MODE');
    const before = normalizeSession(target); const now = nowIso();
    {
      if (lessonChanged && roster > 0) await aq("UPDATE session_students SET status='REMOVED', removed_by=?, removed_at=?, removed_reason='SESSION_LESSON_SWAP', updated_at=? WHERE session_id=? AND status<>'REMOVED'", [auth.user.id, now, now, target.id]);
      // 2026-09-18：`student_call_cap`（次数）→ `student_cost_cap_fen`（分，**观测口径、不拦人**）。
      // 「换课」时与 platform_budget_fen 一样重新取新课时快照 → 这里没有课时级的观测上限基准，
      // 所以换课就**清成 NULL（= 不设观测上限）**，绝不用老课的数字顶替新课堂。
      await aq('UPDATE class_sessions SET title=?,lesson_id=?,series_id=?,delivery_mode=?,platform_budget_fen=?,ai_paused=?,student_cost_cap_fen=?,allow_text=?,allow_image=?,allow_music=?,allow_video=?,allow_podcast=?,allow_dubbing=?,updated_at=? WHERE id=?', [title, nextLessonId, nextLesson.series_id, deliveryMode, lessonChanged ? (publishedLesson.platformBudgetFen ?? null) : target.platform_budget_fen, lessonChanged ? 0 : target.ai_paused, lessonChanged ? null : target.student_cost_cap_fen, lessonChanged ? (publishedLesson.capabilities || []).includes('text') * 1 : target.allow_text, lessonChanged ? (publishedLesson.capabilities || []).includes('image') * 1 : target.allow_image, lessonChanged ? (publishedLesson.capabilities || []).includes('music') * 1 : target.allow_music, lessonChanged ? (publishedLesson.capabilities || []).includes('video') * 1 : target.allow_video, lessonChanged ? 0 : target.allow_podcast, lessonChanged ? 0 : target.allow_dubbing, now, target.id]);
    }
    const updated = await arow('SELECT * FROM class_sessions WHERE id=?', [target.id]);
    await audit(ctx, 'SESSION_UPDATE', 'CLASS_SESSION', target.id, before, { ...normalizeSession(updated), title, swappedLesson: lessonChanged, rosterCleared: lessonChanged && roster > 0 });
    return normalizeSession(updated);
    });
  }
  if (sessionDetailMatch && method === 'GET') {
    const target = await sessionInOrg(sessionDetailMatch[1], { manage: false });
    const detail = await arow(`SELECT session.*, lesson.title lesson_title, lesson.sort lesson_sort, lesson.lesson_content lesson_content,
        series.title series_title, teacher.display_name teacher_name
      FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id
      LEFT JOIN course_series series ON series.id=session.series_id LEFT JOIN users teacher ON teacher.id=session.teacher_id
      WHERE session.id=?`, [target.id]);
    const students = await arows(`SELECT part.*, student.display_name student_name, student.login student_login, adder.display_name added_by_name
      FROM session_students part
      JOIN users student ON student.id=part.student_id
      LEFT JOIN users adder ON adder.id=part.added_by
      WHERE part.session_id=? ORDER BY
        CASE part.status WHEN 'ACTIVE' THEN 0 WHEN 'PENDING' THEN 1 WHEN 'COMPLETED' THEN 2 WHEN 'INCOMPLETE' THEN 3 ELSE 4 END,
        student.display_name`, [target.id]);
    return {
      ...normalizeSession(detail),
      // 「查看课件」用：前端拿它在新标签打开机构端的课时教案抽屉
      coursewareUrl: detail.series_id ? `/org/courses/${detail.series_id}?lesson=${detail.lesson_id || ''}` : null,
      ...await sessionRuntimeDetail(target, auth, students),
      studentSummary: {
        total: students.filter((item) => item.status !== 'REMOVED').length,
        pending: students.filter((item) => item.status === 'PENDING').length,
        active: students.filter((item) => item.status === 'ACTIVE').length,
        completed: students.filter((item) => item.status === 'COMPLETED').length,
        incomplete: students.filter((item) => item.status === 'INCOMPLETE').length,
        removed: students.filter((item) => item.status === 'REMOVED').length,
      },
    };
  }
  // 读权限与详情一致（本人课堂 / 机构管理员看全机构），因为它只是把详情的字段组合成一张清单。
  let sessionPrecheckMatch = part.match(/^\/sessions\/([^/]+)\/precheck$/);
  if (sessionPrecheckMatch && method === 'GET') {
    const target = await sessionInOrg(sessionPrecheckMatch[1], { manage: false });
    const action = String(ctx.search.get('action') || 'start').trim().toLowerCase();
    if (!['start', 'dissolve'].includes(action)) throw errors.badRequest('预检类型只有 start / dissolve', 'INVALID_PRECHECK_ACTION');
    const checks = await sessionPrecheck(target, action);
    return { sessionId: target.id, action, allPassed: checks.every((item) => item.passed), checks };
  }
  let sessionActionMatch = part.match(/^\/sessions\/([^/]+)\/(start|end|dissolve)$/);
  if (sessionActionMatch && method === 'POST') {
    const target = await sessionInOrg(sessionActionMatch[1]);
    const action = sessionActionMatch[2];
    const reason = String(ctx.body?.reason || '').trim().slice(0, 500) || null;
    const now = nowIso();
    if (action === 'start') {
      if (target.status !== 'PENDING') throw errors.conflict('只有待上课的课堂可以开始上课', 'SESSION_NOT_PENDING');
      const ready = await acount("SELECT COUNT(*) n FROM session_students WHERE session_id=? AND status='PENDING'", [target.id]);
      if (!ready) throw errors.badRequest('先添加学员再开始上课（名单为空不能开课）', 'SESSION_STUDENTS_REQUIRED');
      // ⭐ 开课要**复查占用**（2026-09-20，用户口径：「他进了这个课堂，别的课堂就加不进，必须先解散/结束」）。
      //    加人那一步已经拦了（`IN_OTHER_SESSION`，连 PENDING 也算占用），但**开课这一步以前不查** ——
      //    于是只要名单里存在异常占用（2026-09-13 那条校验最初**只按同一课时**过滤，跨课时拦不住，
      //    生产的演示数据就是那样进去的；后来校验改宽了，可这些历史名单还在），
      //    老师一点「开始上课」就会造出**同一个学生两场 ACTIVE 课堂**，
      //    而 `client-context` 只会默默挑"最近开始的那一场"（学生做 A 课作业、拿到 B 课的次数上限）。
      //    正常库上这条永不触发（加人时就已经拦住），它只对历史/异常名单说话。
      const busy = await arows(
        `SELECT DISTINCT student.display_name AS name, session.title AS session_title,
                COALESCE(lesson.published_title, lesson.title) AS lesson_title
           FROM session_students part
           JOIN class_sessions session ON session.id = part.session_id
           JOIN users student ON student.id = part.student_id
           LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
          WHERE part.status IN ('PENDING','ACTIVE') AND session.status IN ('PENDING','ACTIVE')
            AND session.id <> ?
            AND part.student_id IN (SELECT student_id FROM session_students WHERE session_id=? AND status='PENDING')`,
        [target.id, target.id],
      );
      if (busy.length) {
        const detail = busy.map((item) => `${item.name}（${item.session_title || '未命名课堂'} · ${item.lesson_title || '未知课程'}）`).join('、');
        throw errors.conflict(`这些学员还在另一场课堂里：${detail}。先结束或解散那场课堂，再开始这一节。`, 'STUDENT_IN_OTHER_SESSION');
      }
      await atransaction(async () => {
        await assertTeacherSessionAvailable(target.teacher_id, target.id);
        if (!await arow("SELECT lesson.id FROM course_lessons lesson JOIN course_series series ON series.id=lesson.series_id WHERE lesson.id=? AND lesson.status='PUBLISHED' AND series.status='PUBLISHED'", [target.lesson_id]) || !await accessibleLesson(currentOrgId, target.lesson_id)) throw errors.forbidden('课时未发布或授权已失效', 'LESSON_NOT_ASSIGNED');
        await assertTransition(ctx, 'classSession', target.status, 'ACTIVE', { targetType: 'CLASS_SESSION', targetId: target.id, before: normalizeSession(target), code: 'INVALID_CLASS_SESSION_TRANSITION', message: '当前状态不能开始上课' });
        await aq("UPDATE class_sessions SET status='ACTIVE', started_by=?, started_at=?, updated_at=? WHERE id=?", [auth.user.id, now, now, target.id]);
        await aq("UPDATE session_students SET status='ACTIVE', updated_at=? WHERE session_id=? AND status='PENDING'", [now, target.id]);
      });
      await audit(ctx, 'SESSION_START', 'CLASS_SESSION', target.id, normalizeSession(target), { status: 'ACTIVE', studentCount: ready });
      // 开始上课就把这节课学生的环境**预热**（尽力而为、不阻塞这个响应）：
      // 学生点「进入创作环境」时环境已经热了 → 复用 0.07 秒，而不是干等 17.9 秒冷启动。
      warmSessionRuntimes(target.id, target.lesson_id, target.org_id);
    } else if (action === 'end') {
      if (target.status !== 'ACTIVE') throw errors.conflict('只有正在上课的课堂可以结束', 'SESSION_NOT_ACTIVE');
      const settlement = await atransaction(async () => {
        await assertTransition(ctx, 'classSession', target.status, 'ENDED', { targetType: 'CLASS_SESSION', targetId: target.id, before: normalizeSession(target), code: 'INVALID_CLASS_SESSION_TRANSITION', message: '当前状态不能结束课堂' });
        // 先结算学员（按「这节课有没有消耗过算力」），再落课堂状态：两件事在同一事务里
        const summary = await settleSessionStudents({ sessionId: target.id, actorId: auth.user.id });
        await aq("UPDATE class_sessions SET status='ENDED', ended_by=?, ended_at=?, ended_reason=?, updated_at=? WHERE id=?", [auth.user.id, now, reason || 'MANUAL', now, target.id]);
        return summary;
      });
      await audit(ctx, 'SESSION_END', 'CLASS_SESSION', target.id, normalizeSession(target), { status: 'ENDED', ...settlement });
      releaseSessionRuntimes(target.id, 'SESSION_END');
    } else {
      if (target.status !== 'PENDING') throw errors.conflict('只有待上课的课堂可以解散', 'SESSION_NOT_PENDING');
      await atransaction(async () => {
        await assertTransition(ctx, 'classSession', target.status, 'DISSOLVED', { targetType: 'CLASS_SESSION', targetId: target.id, before: normalizeSession(target), code: 'INVALID_CLASS_SESSION_TRANSITION', message: '当前状态不能解散课堂' });
        await aq(`UPDATE session_students SET status='REMOVED', removed_by=?, removed_at=?, removed_reason=?, updated_at=?
            WHERE session_id=? AND status<>'REMOVED'`, [auth.user.id, now, reason || '课堂已解散', now, target.id]);
        await aq("UPDATE class_sessions SET status='DISSOLVED', ended_by=?, ended_at=?, ended_reason=?, updated_at=? WHERE id=?", [auth.user.id, now, reason || 'DISSOLVED', now, target.id]);
      });
      await audit(ctx, 'SESSION_DISSOLVE', 'CLASS_SESSION', target.id, normalizeSession(target), { status: 'DISSOLVED' });
      releaseSessionRuntimes(target.id, 'SESSION_DISSOLVE');
    }
    const updated = await arow(`SELECT session.*, lesson.title lesson_title, lesson.sort lesson_sort, series.title series_title, teacher.display_name teacher_name
      FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id
      LEFT JOIN course_series series ON series.id=session.series_id LEFT JOIN users teacher ON teacher.id=session.teacher_id
      WHERE session.id=?`, [target.id]);
    return normalizeSession(updated);
  }
  if (part.match(/^\/sessions\/([^/]+)\/candidates$/) && method === 'GET') {
    const target = await sessionInOrg(part.match(/^\/sessions\/([^/]+)\/candidates$/)[1], { manage: false });
    return { sessionId: target.id, lessonId: target.lesson_id, seriesId: target.series_id, status: target.status, ...await sessionCandidates(target) };
  }
  if (part.match(/^\/sessions\/([^/]+)\/students$/) && method === 'POST') {
    const target = await sessionInOrg(part.match(/^\/sessions\/([^/]+)\/students$/)[1]);
    const studentIds = Array.isArray(ctx.body?.studentIds) ? [...new Set(ctx.body.studentIds.map(String).filter(Boolean))] : [];
    if (!studentIds.length) throw errors.badRequest('请选择要添加的学员', 'SESSION_STUDENTS_REQUIRED');
    const result = await addSessionStudents({ session: target, studentIds, actorId: auth.user.id });
    await audit(ctx, 'SESSION_STUDENTS_ADD', 'CLASS_SESSION', target.id, null, { added: result.added.length, skipped: result.skipped });
    return result;
  }
  let sessionStudentMatch = part.match(/^\/sessions\/([^/]+)\/students\/([^/]+)$/);
  if (sessionStudentMatch && method === 'DELETE') {
    const target = await sessionInOrg(sessionStudentMatch[1]);
    const result = await removeSessionStudent({ session: target, studentId: sessionStudentMatch[2], actorId: auth.user.id, reason: String(ctx.body?.reason || '').trim().slice(0, 200) || null });
    await audit(ctx, 'SESSION_STUDENT_REMOVE', 'CLASS_SESSION', target.id, null, { studentId: result.studentId });
    // 被移出名单的学生：环境留着他也用不了（每次调用都会被门禁挡），但会一直占内存 —— 一并收掉。
    releaseSessionRuntimes(target.id, 'SESSION_STUDENT_REMOVE');
    return result;
  }

  if (part === '/work-reports' && method === 'GET') {
    // 批次 D：教师范围按「作品挂在我创建的课堂上」（班级退场）
    const params = [currentOrgId];
    let where = 'report.org_id=?';
    where += sessionOwnedByTeacherExists('work.class_session_id', auth, params, { orgColumn: 'work.org_id' });
    const status = ctx.search.get('status'); if (['PENDING', 'RESOLVED', 'DISMISSED'].includes(status)) { where += ' AND report.status=?'; params.push(status); }
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 50 });
    const fromWhere = `FROM work_reports report JOIN works work ON work.id=report.work_id AND work.org_id=report.org_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id WHERE ${where}`;
    const total = Number((await arow(`SELECT COUNT(*) n ${fromWhere}`, params))?.n || 0);
    // pending 是筛选范围内的待处理总数（不是本页条数），页头徽标要一直准确
    const pending = Number((await arow(`SELECT COUNT(*) n ${fromWhere} AND report.status='PENDING'`, params))?.n || 0);
    const items = (await arows(
      `SELECT report.*, work.title AS work_title, work.status AS work_status, reporter.display_name AS reporter_name, handler.display_name AS handler_name
       FROM work_reports report JOIN works work ON work.id=report.work_id AND work.org_id=report.org_id
       JOIN users reporter ON reporter.id=report.reporter_id LEFT JOIN users handler ON handler.id=report.handled_by
       WHERE ${where}
       ORDER BY CASE report.status WHEN 'PENDING' THEN 0 ELSE 1 END, report.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset],
    )).map((report) => normalizeWorkReport(report, { includeReporter: true }));
    return { ...pageResult(items, { page, limit, total }), pending };
  }
  let orgReportMatch = part.match(/^\/work-reports\/([^/]+)$/);
  if (orgReportMatch && method === 'PUT') {
    const report = await workReportInReviewScope(auth, currentOrgId, orgReportMatch[1]);
    if (report.status !== 'PENDING') throw errors.conflict('举报已处理，不能重复处理', 'WORK_REPORT_ALREADY_HANDLED');
    const status = ctx.body?.status; if (!['RESOLVED', 'DISMISSED'].includes(status)) throw errors.badRequest('举报处理状态无效', 'INVALID_WORK_REPORT_STATUS');
    const actionTaken = ctx.body?.actionTaken || 'NONE'; if (!['NONE', 'UNPUBLISH'].includes(actionTaken)) throw errors.badRequest('举报处理动作无效', 'INVALID_WORK_REPORT_ACTION');
    const resolution = reportResolution(ctx.body); const work = await workInReviewScope(auth, currentOrgId, report.work_id);
    if (actionTaken === 'UNPUBLISH' && work.status !== 'PUBLISHED') throw errors.conflict('仅已发布作品可因举报下架', 'WORK_NOT_PUBLISHED');
    const now = nowIso();
    await atransaction(async () => {
      if (actionTaken === 'UNPUBLISH') {
        await aq('UPDATE works SET status=?,unpublish_reason=?,unpublished_at=?,is_public=0,reviewed_by=?,reviewed_at=?,featured_at=NULL,featured_by=NULL,featured_reason=NULL WHERE id=? AND org_id=?', ['UNPUBLISHED', resolution, now, auth.user.id, now, work.id, currentOrgId]);
        const latestSubmission = await arow('SELECT id FROM work_submissions WHERE work_id=? ORDER BY round DESC LIMIT 1', [work.id]);
        if (latestSubmission) await aq('UPDATE work_submissions SET review_status=?,review_comment=?,reviewed_at=?,updated_at=? WHERE id=?', ['REJECTED', resolution, now, now, latestSubmission.id]);
        await aq(
          "UPDATE student_projects SET status='DRAFT',updated_at=? WHERE id=? AND org_id=? AND status='SUBMITTED' AND deleted_at IS NULL",
          [now, work.project_id, currentOrgId],
        );
      }
      await aq('UPDATE work_reports SET status=?,handled_by=?,handled_at=?,resolution=?,action_taken=? WHERE id=? AND org_id=?', [status, auth.user.id, now, resolution, actionTaken, report.id, currentOrgId]);
    });
    await audit(ctx, 'ORG_WORK_REPORT_HANDLE', 'WORK_REPORT', report.id, normalizeWorkReport(report), { status, actionTaken, resolution }, { orgId: currentOrgId });
    if (actionTaken === 'UNPUBLISH') await audit(ctx, 'ORG_WORK_UNPUBLISH_REPORT', 'WORK', work.id, normalizeWorkReport(report), { status: 'REJECTED', reportId: report.id }, { orgId: currentOrgId });
    // 自动提醒：举报已处理 → 通知作品作者学生（P4-O09）
    try {
      if (work?.student_id) {
        await scheduleReminder({
          title: status === 'RESOLVED' ? '举报已有处理结果' : '举报已被驳回',
          body: status === 'RESOLVED'
            ? `您举报的作品《${work.title || report.work_id}》已处理：${resolution}`
            : `您举报的作品《${work.title || report.work_id}》因证据不足已被驳回`,
          targetUserId: work.student_id,
          targetOrgId: currentOrgId,
          eventKey: `WORK_REPORT_RESOLVED:${report.id}`,
          targetUrl: '/works',
        });
      }
    } catch { /* 提醒失败不影响主流程 */ }
    return (await workReportRows('report.id=?', [report.id]))[0];
  }
  if (part === '/works' && method === 'GET') {
    const status = String(ctx.search.get('status') || '').trim();
    // 批次 D：按**课堂**筛（旧参数 classId 保留兼容，但班级退场后它已经没用）
    const sessionFilter = String(ctx.search.get('sessionId') || '').trim();
    const search = String(ctx.search.get('search') || '').trim().slice(0, 100);
    if (status && !['PENDING', 'APPROVED', 'REJECTED', 'PUBLISHED'].includes(status)) throw errors.badRequest('作品状态筛选无效', 'INVALID_WORK_STATUS_FILTER');
    const params = [currentOrgId]; let where = 'work.org_id=?';
    if (status) { where += ' AND work.status=?'; params.push(status); }
    if (sessionFilter) { where += ' AND work.class_session_id=?'; params.push(sessionFilter); }
    if (search) {
      const keyword = '%' + search.replace(new RegExp(`[%\\_]`, 'g'), (char) => '\\' + char) + '%';
      where += " AND (work.title LIKE ? ESCAPE '\\' OR student.display_name LIKE ? ESCAPE '\\' OR lesson.title LIKE ? ESCAPE '\\')";
      params.push(keyword, keyword, keyword);
    }
    // 教师范围：作品挂在我创建的课堂（班级退场后不再按 class 圈定）
    where += sessionOwnedByTeacherExists('work.class_session_id', auth, params, { orgColumn: 'work.org_id' });
    const canvasItems = await amap((await arows(`SELECT work.*,student.display_name student_name,lesson.title lesson_title,series.title series_title,session.title session_title,reviewer.display_name reviewer_name,COALESCE((SELECT COUNT(1) FROM work_reports report WHERE report.work_id=work.id AND report.status='PENDING'),0) pending_report_count FROM works work JOIN users student ON student.id=work.student_id AND student.org_id=work.org_id LEFT JOIN class_sessions session ON session.id=work.class_session_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id LEFT JOIN course_series series ON series.id=lesson.series_id LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by WHERE ${where} ORDER BY CASE WHEN work.featured_at IS NULL THEN 1 ELSE 0 END, work.featured_at DESC, work.submitted_at DESC LIMIT 200`, params)), async (work) => ({ ...await normalizeWork(work, { includeSnapshot: ctx.search.get('includeSnapshot') === 'true' }), seriesTitle: work.series_title || null, sessionTitle: work.session_title || null, pendingReportCount: Number(work.pending_report_count || 0) }));

    // VibeCoding 提交（2026-09-20）：**这个列表原来只读 `works`（画布）**，于是学生从创作环境交上来的
    // 网页 / PPT 作品在「作品管理」里根本不出现 —— 平台端看得到、机构端看不到
    // （用户报的「机构/老师看不到学生提交的作品」就是它）。按学生端 / 平台端同一套形状并进来。
    // ⚠️ 筛选口径的差异：VibeCoding 没有 `PUBLISHED` 这个状态，那个筛选值在这里等价于
    //    「已发布到官网」（is_public=1）；举报（work_reports）只挂 `works`，所以这类作品的待处理举报恒为 0。
    // ⚠️ 老师范围与画布那条一致：只看得见**自己课堂**的作品 —— 没挂课堂的提交对老师不可见、机构管理员可见。
    const vibeParams = [currentOrgId];
    let vibeWhere = 'submission.org_id=?';
    if (status) {
      if (status === 'PUBLISHED') vibeWhere += ' AND submission.is_public=1';
      else { vibeWhere += ' AND submission.status=?'; vibeParams.push(status); }
    }
    if (sessionFilter) { vibeWhere += ' AND conversation.class_session_id=?'; vibeParams.push(sessionFilter); }
    if (search) {
      // 与上面画布那条**逐字同一套转义**（LIKE 的通配符要转义掉，否则用户输入 % 会把整表搜出来）。
      // ⚠️ 这两行的反斜杠别用脚本往里写：脚本会吃掉一层、写成 `'\'` 就是语法错误，
      //    而且**只有服务端跑起来才炸**（前端构建拦不到）。
      const keyword = '%' + search.replace(new RegExp(`[%\\_]`, 'g'), (char) => '\\' + char) + '%';
      vibeWhere += " AND (submission.title LIKE ? ESCAPE '\\' OR student.display_name LIKE ? ESCAPE '\\' OR lesson.title LIKE ? ESCAPE '\\')";
      vibeParams.push(keyword, keyword, keyword);
    }
    vibeWhere += sessionOwnedByTeacherExists('(SELECT class_session_id FROM vibecoding_conversations conv WHERE conv.id=submission.conversation_id)', auth, vibeParams, { orgColumn: 'submission.org_id' });
    const vibeItems = (await arows(`SELECT submission.*,student.display_name student_name,COALESCE(lesson.published_title,lesson.title) lesson_title,series.title series_title,session.title session_title,conversation.class_session_id class_session_id FROM vibecoding_submissions submission JOIN users student ON student.id=submission.student_id AND student.org_id=submission.org_id LEFT JOIN course_lessons lesson ON lesson.id=submission.lesson_id LEFT JOIN course_series series ON series.id=lesson.series_id LEFT JOIN vibecoding_conversations conversation ON conversation.id=submission.conversation_id LEFT JOIN class_sessions session ON session.id=conversation.class_session_id WHERE ${vibeWhere} ORDER BY submission.submitted_at DESC LIMIT 200`, vibeParams)).map((submission) => ({
      id: submission.id,
      source: 'VIBECODING',
      title: submission.title,
      description: submission.description || '',
      studentId: submission.student_id,
      studentName: submission.student_name || null,
      status: submission.status,
      submittedAt: submission.submitted_at,
      seriesTitle: submission.series_title || null,
      courseLessonTitle: submission.lesson_title || null,
      sessionTitle: submission.session_title || null,
      classSessionId: submission.class_session_id || null,
      entryFile: submission.entry_file || 'index.html',
      plazaPublished: Number(submission.is_public || 0) === 1,
      // 这两个字段画布那边有、这里没有：机构精选与举报都只作用于 `works`（口径见上面的注释）
      featured: false,
      pendingReportCount: 0,
      copyrightConfirmedAt: submission.copyright_confirmed_at || null,
    }));

    // 作品预览里"做出来的东西"现在可能是**我们自己存的**生成产物（生成成功时归档成学生私有素材），
    // 而 `<img>` 发不出 Authorization 头 —— 前端要有一份 fileId → 地址 的表才能显示
    // （学生端/广场那两条链路早就是这么做的，这里补上，机构端才不至于"点开预览是一片坏图"）。
    // 批量查一次 media_assets：**别每行一个查询**（列表上限 200 条）。
    const projectIds = [...new Set(canvasItems.map((item) => item.projectId).filter(Boolean))];
    const assetIdsByProject = new Map();
    if (projectIds.length) {
      for (const asset of await arows(`SELECT project_id, asset_url FROM media_assets WHERE project_id IN (${projectIds.map(() => '?').join(',')})`, projectIds)) {
        const fileId = String(asset.asset_url || '').match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:\?.*)?$/)?.[1];
        if (!fileId) continue;
        if (!assetIdsByProject.has(asset.project_id)) assetIdsByProject.set(asset.project_id, new Set());
        assetIdsByProject.get(asset.project_id).add(fileId);
      }
    }
    for (const item of canvasItems) {
      const fileIds = new Set([
        ...canvasMediaFrom(item.canvasSnapshot).map((media) => media.fileId).filter(Boolean),
        ...(assetIdsByProject.get(item.projectId) || []),
      ]);
      item.imageUrls = Object.fromEntries([...fileIds].map((fileId) => [fileId, `/api/org/works/CANVAS/${encodeURIComponent(item.id)}/images/${encodeURIComponent(fileId)}`]));
    }

    // 两类合并后统一排序：**精选仍置顶**（画布那条的既有口径），其余按提交时间倒序 ——
    // 单独按来源分页/拼接会让"最新作品"被来源顺序盖住。
    const items = [...canvasItems, ...vibeItems].sort((a, b) => (Number(Boolean(b.featured)) - Number(Boolean(a.featured))) || String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
    return { items };
  }
  let orgFeatureMatch = part.match(/^\/works\/([^/]+)\/feature$/);
  if (orgFeatureMatch && method === 'PUT') {
    const work = await workInReviewScope(auth, currentOrgId, orgFeatureMatch[1]);
    if (!Object.hasOwn(ctx.body || {}, 'featured') || typeof ctx.body.featured !== 'boolean') throw errors.badRequest('请选择是否设为机构精选', 'WORK_FEATURED_REQUIRED');
    const featured = ctx.body.featured;
    if (featured && work.status !== 'PUBLISHED') throw errors.conflict('仅已发布作品可以设为机构精选', 'WORK_NOT_PUBLISHED');
    if (featured && !work.student_allow_feature) throw errors.forbidden('该学生已关闭机构精选展示授权', 'STUDENT_FEATURE_OPT_OUT');
    const reason = featured ? String(ctx.body?.reason || '').trim().slice(0, 500) : null;
    const now = nowIso();
    await atransaction(async () => {
      await aq('UPDATE works SET featured_at=?,featured_by=?,featured_reason=? WHERE id=? AND org_id=?', [featured ? now : null, featured ? auth.user.id : null, reason || null, work.id, currentOrgId]);
    });
    await audit(ctx, featured ? 'ORG_WORK_FEATURE' : 'ORG_WORK_UNFEATURE', 'WORK', work.id, await normalizeWork(work), { featured, reason: reason || null }, { orgId: currentOrgId });
    return await normalizeWork(await arow('SELECT * FROM works WHERE id=? AND org_id=?', [work.id, currentOrgId]));
  }


  /**
   * 机构端「课包概览」（2026-09-13，用户要求）：一眼看清每个已授权课包的
   * 可授权次数 / 已分配 / 剩余 / 已分配学员数 / 涉及老师数 / 课堂情况。
   *
   * 口径说明（字段刻意设计成**在班级退场前后都成立**，免得模型一改又要重写）：
   *   · 次数：quotaTotal 来自平台给本机构的授权单，quotaUsed 是「分给学生」用掉的次数（每人次 1）
   *   · 已分配学员：student_course_grants 未撤销的去重人数（人次另给 grantedCount）
   *   · 课堂：按「课时属于哪个课包」归集（课时的 series_id），所以与"课堂挂在班级还是独立"无关
   *     ⚠️ 进行中/待上课是**存量口径**（现在有多少），已结束按 days 区间（这段时间上完多少）
   *   · 涉及老师：开过这个课包课堂的老师去重（老师与课包没有直接绑定关系，只有课堂这一条实证）
   */
  if (part === '/series-overview' && method === 'GET') {
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 });
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const until = nowIso();
    const series = await arows(`SELECT series.id, series.title, series.cover_image_url, series.sort, series.version,
        series.difficulty_level, series.age_range_min, series.age_range_max,
        COALESCE(assignment.quota_total, 0) quota_total, COALESCE(assignment.quota_used, 0) quota_used,
        assignment.status assignment_status, assignment.assigned_at assignment_assigned_at
      FROM course_series series
      LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND ${assignmentActiveSql()}
      WHERE series.status='PUBLISHED' AND ${orgSeriesAccessSql()}
      ORDER BY series.sort, series.title`, [currentOrgId, currentOrgId]);
    // 分给学生的许可（未撤销）：人次 + 去重人数
    // ⚠️ 人次按 **SUM(granted_units)** 算，不是 COUNT(*) —— 体验课包的次数记在**同一行**上
    //    （可重复分给同一学生、未用次数预先累积），按行数会把它算少。普通课包每行恒为 1，值不变。
    const grantBySeries = new Map((await arows(`SELECT series_id, COALESCE(SUM(granted_units),0) granted, COUNT(DISTINCT student_id) students
      FROM student_course_grants WHERE org_id=? AND revoked_at IS NULL GROUP BY series_id`, [currentOrgId]))
      .map((item) => [item.series_id, { grantedCount: Number(item.granted || 0), grantedStudents: Number(item.students || 0) }]));
    // 课堂：存量（待上课/上课中）
    const liveBySeries = new Map((await arows(`SELECT lesson.series_id series_id, session.status status, COUNT(*) n
      FROM class_sessions session JOIN course_lessons lesson ON lesson.id=session.lesson_id
      WHERE session.org_id=? AND session.status IN ('PENDING','ACTIVE') GROUP BY lesson.series_id, session.status`, [currentOrgId]))
      .map((item) => [`${item.series_id}:${item.status}`, Number(item.n || 0)]));
    // 课堂：区间内已结束/已解散 + 涉及老师
    // ⚠️ 批次 A 阶段课堂还没有 teacher_id（批次 B 才加），所以先用 started_by；
    //    批次 B 落地后改成 COALESCE(session.teacher_id, session.started_by)（一行改动）。
    const doneBySeries = new Map((await arows(`SELECT lesson.series_id series_id, session.status status, COUNT(*) n,
        COUNT(DISTINCT session.teacher_id) teachers
      FROM class_sessions session JOIN course_lessons lesson ON lesson.id=session.lesson_id
      WHERE session.org_id=? AND session.ended_at IS NOT NULL AND session.ended_at >= ? AND session.ended_at < ?
      GROUP BY lesson.series_id, session.status`, [currentOrgId, since, until]))
      .map((item) => [`${item.series_id}:${item.status}`, { n: Number(item.n || 0), teachers: Number(item.teachers || 0) }]));
    const items = series.map((row0) => {
      const grant = grantBySeries.get(row0.id) || { grantedCount: 0, grantedStudents: 0 };
      const ended = doneBySeries.get(`${row0.id}:ENDED`) || { n: 0, teachers: 0 };
      const dissolved = doneBySeries.get(`${row0.id}:DISSOLVED`) || { n: 0, teachers: 0 };
      const quotaTotal = Number(row0.quota_total || 0);
      const quotaUsed = Number(row0.quota_used || 0);
      return {
        seriesId: row0.id, title: row0.title, coverImageUrl: row0.cover_image_url || null,
        // 2026-09-17（002-01/002-02 线框图）：库存列表与单课包详情要「当前版本 / 开通时间 / 权益状态」，
        // 这三个都在 course_series 与 course_assignments 上，直接带出来，不再让前端去别处拼。
        version: row0.version || null,
        assignmentStatus: row0.assignment_status || null,
        assignedAt: row0.assignment_assigned_at || null,
        difficultyLevel: row0.difficulty_level ?? null,
        ageRangeMin: row0.age_range_min ?? null,
        ageRangeMax: row0.age_range_max ?? null,
        quotaTotal, quotaUsed, remaining: Math.max(0, quotaTotal - quotaUsed),
        grantedCount: grant.grantedCount, grantedStudents: grant.grantedStudents,
        pendingSessions: liveBySeries.get(`${row0.id}:PENDING`) || 0,
        activeSessions: liveBySeries.get(`${row0.id}:ACTIVE`) || 0,
        endedSessions: ended.n, dissolvedSessions: dissolved.n,
        teacherCount: Math.max(ended.teachers, dissolved.teachers),
      };
    });
    const sum = (key) => items.reduce((total, item) => total + Number(item[key] || 0), 0);
    return {
      days, since, until,
      totals: {
        seriesCount: items.length, quotaTotal: sum('quotaTotal'), quotaUsed: sum('quotaUsed'), remaining: sum('remaining'),
        grantedStudents: sum('grantedStudents'), pendingSessions: sum('pendingSessions'), activeSessions: sum('activeSessions'),
      },
      items,
    };
  }

  // 机构端：把课包的「可用次数」分给学生（用掉 1 次；同一学生同一课包只能一次；机构侧不可撤销）
  if (part === '/course-grants' && method === 'GET') {
    const seriesFilter = String(ctx.search.get('seriesId') || '').trim();
    const params = [currentOrgId];
    let where = 'grant.org_id=?';
    if (seriesFilter) { where += ' AND grant.series_id=?'; params.push(seriesFilter); }
    const items = (await arows(`SELECT grant.id, grant.student_id, grant.series_id, grant.granted_at, grant.revoked_at, grant.revoke_reason,
        grant.granted_units, grant.consumed_units,
        student.display_name student_name, student.login student_login, series.title series_title, series.series_type
      FROM student_course_grants AS \`grant\`
      JOIN users student ON student.id=grant.student_id
      JOIN course_series series ON series.id=grant.series_id
      WHERE ${where} ORDER BY grant.granted_at DESC LIMIT 500`, params)).map((item) => ({
      id: item.id, studentId: item.student_id, studentName: item.student_name || null, studentLogin: item.student_login || null,
      seriesId: item.series_id, seriesTitle: item.series_title || null, grantedAt: item.granted_at,
      revokedAt: item.revoked_at || null, revokeReason: item.revoke_reason || null,
      // 体验课包（seriesType='EXPERIENCE'）的次数账：前端据此显示「可用 N 次」而不是「已授权」
      seriesType: seriesTypeOf({ series_type: item.series_type }),
      grantedUnits: grantUnitsOf(item).granted, consumedUnits: grantUnitsOf(item).consumed, remainingUnits: grantUnitsOf(item).remaining,
    }));
    return { items, total: items.length };
  }
  if (part === '/course-grants' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可以给学员授权课包', 'ORG_ADMIN_REQUIRED');
    const seriesId = nonEmptyString(ctx.body?.seriesId, '课包', { max: 100 });
    // 002-05「来源」列要它，见 GRANT_SOURCE_LABELS 的注释（白名单外的值当没传）
    const requestedSource = String(ctx.body?.source || '').trim().toUpperCase();
    const grantSource = GRANT_SOURCE_LABELS[requestedSource] ? requestedSource : null;
    const requested = Array.isArray(ctx.body?.studentIds) ? ctx.body.studentIds : [];
    const studentIds = [...new Set(requested.map((value) => String(value || '').trim()).filter(Boolean))];
    if (!studentIds.length || studentIds.length > 200) throw errors.badRequest('请选择 1-200 名学员', 'INVALID_STUDENT_IDS');
    return await atransaction(async () => {
    if (!await arow("SELECT id FROM course_series WHERE id=? AND status='PUBLISHED'", [seriesId])) throw errors.forbidden('课包未发布', 'COURSE_NOT_PUBLISHED');
    // 课包类型决定"重复分配"的语义：普通课包重复授权跳过，体验课包累加次数（见下面 already/fresh）
    const series = await arow('SELECT id, series_type FROM course_series WHERE id=?', [seriesId]);
    const experience = isExperienceSeries(series);
    const assignment = await arow("SELECT * FROM course_assignments WHERE series_id=? AND org_id=? AND status='ACTIVE' AND (expires_at IS NULL OR expires_at > ?)", [seriesId, currentOrgId, nowIso()]);
    if (!assignment) throw errors.forbidden('该课包未授权给当前机构', 'COURSE_NOT_AUTHORIZED');
    const placeholders = studentIds.map(() => '?').join(',');
    const students = await arows(`SELECT id, display_name, login FROM users WHERE id IN (${placeholders}) AND org_id=? AND role='STUDENT' AND deleted_at IS NULL`, [...studentIds, currentOrgId]);
    if (students.length !== studentIds.length) throw errors.badRequest('存在不属于本机构的学员', 'STUDENT_NOT_FOUND');
    // 已授权过的跳过（不重复扣次数）：同一机构 + 同一学生 + 同一课包只允许一条有效记录
    // ⭐ 体验课包例外（2026-09-24 用户口径）：**同一个体验课包可以重复分给同一个学生**，
    //    未使用的次数**预先累积** —— 每次分配都算一次（同一行 `granted_units` +1），不跳过。
    const already = experience
      ? new Set()
      : new Set((await arows(`SELECT student_id FROM student_course_grants WHERE org_id=? AND series_id=? AND revoked_at IS NULL AND student_id IN (${placeholders})`, [currentOrgId, seriesId, ...studentIds])).map((item) => item.student_id));
    const fresh = studentIds.filter((studentId) => !already.has(studentId));
    const quotaTotal = Number(assignment.quota_total || 0);
    const quotaUsed = Number(assignment.quota_used || 0);
    if (fresh.length && (quotaTotal <= 0 || quotaUsed + fresh.length > quotaTotal)) {
      throw errors.conflict(`可用次数不足：授权 ${quotaTotal} 次，已用 ${quotaUsed} 次，本次需要 ${fresh.length} 次`, 'COURSE_QUOTA_EXHAUSTED');
    }
    const now = nowIso();
    // ⚠️ 并发同一个学生时，两个请求都"查不到 → 一起插"，输的那个会撞唯一索引。
    //    撞了必须按"这个学生已经授权过"处理（跳过本次）—— 与"重复授权跳过"是同一件事，
    //    不能把整个请求打成 500（p77/p82 在 MySQL 上就是这么红的：SQLite 侧全局写锁替我们兜住了）。
    const raced = [];
      for (const studentId of fresh) {
        const existing = await arow('SELECT id FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=?', [currentOrgId, studentId, seriesId]);
        let grantId;
        let unitSeq = 1;
        if (existing) {
          // 主键维持稳定；每次重发由新的 granted_at 形成一代新事件，旧代必须已经完整冲销。
          grantId = existing.id;
          if (experience) {
            // 体验课包：次数**累加在同一行**（唯一索引与历史都保住），撤销过就顺手复活。
            // 不走下面那条「上一代必须已冲销」的检查：每一次分配都是独立的一次次数确认收入，
            // 各自带自己的幂等键（见下面 appendLicenseGrantRevenue 的 key）。
            await aq('UPDATE student_course_grants SET revoked_at=NULL,revoked_by=NULL,revoke_reason=NULL,granted_at=?,granted_by=?,source_assignment_id=?,granted_units=granted_units+1 WHERE id=?',
              [now, auth.user.id, assignment.id, grantId]);
            unitSeq = Number((await arow('SELECT granted_units FROM student_course_grants WHERE id=?', [grantId]))?.granted_units || 1);
          } else {
            const unreversed = await arow(`SELECT event.id FROM license_revenue_events event
              LEFT JOIN license_revenue_events reversal ON reversal.reversal_of_event_id=event.id
              WHERE event.grant_id=? AND event.event_type='GRANT' AND reversal.id IS NULL LIMIT 1`, [grantId]);
            if (unreversed) throw errors.conflict('上一次许可收入尚未冲销，不能重新授权', 'LICENSE_GRANT_REVERSAL_REQUIRED');
            await aq('UPDATE student_course_grants SET revoked_at=NULL,revoked_by=NULL,revoke_reason=NULL,granted_at=?,granted_by=?,source_assignment_id=? WHERE id=?', [now, auth.user.id, assignment.id, grantId]);
          }
        } else {
          grantId = id('coursegrant');
          try {
            await aq('INSERT INTO student_course_grants(id,org_id,student_id,series_id,source_assignment_id,granted_by,granted_at,granted_units,consumed_units) VALUES (?,?,?,?,?,?,?,?,?)', [grantId, currentOrgId, studentId, seriesId, assignment.id, auth.user.id, now, 1, 0]);
          } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            raced.push(studentId);
            continue;
          }
        }
        await appendLicenseGrantRevenue({ assignmentId: assignment.id, orgId: currentOrgId, seriesId, grantId, actorId: auth.user.id, occurredAt: now, idempotencyKey: experience ? `license-grant:${grantId}:${now}:u${unitSeq}` : `license-grant:${grantId}:${now}` });
      };
      // 授权次数变更流水（P03-04 写入点④ 授权消耗）：只有真的扣了次数才记一笔
      // ——「同一学生同一课包重复授权被跳过」「撤销后重新授权（同一 grant 复活）」两条路径
      //   都以 `fresh`（= 本次真正新增的授权数）为准，所以不会记成两笔、也不会漏记。
      // 体验课包的重复分配同样是"真的扣了次数"（每次 +1 人次），所以照样记这一笔。
      // 与 quota_used 的更新在**同一个事务**里（本函数上面就是 atransaction(async () => {...})）。
      const grantedNow = fresh.length - raced.length;
      if (grantedNow) {
        await aq('UPDATE course_assignments SET quota_used=quota_used+? WHERE id=?', [grantedNow, assignment.id]);
        await recordQuotaChange({
          orgId: currentOrgId, seriesId, assignmentId: assignment.id,
          changeType: 'GRANT_CONSUME', quotaTotalBefore: quotaTotal, quotaUsedBefore: quotaUsed,
          actorId: auth.user.id, actorRole: auth.user.role,
          reason: '', source: COURSE_QUOTA_SOURCES.ORG_GRANT,
        });
      }
    await audit(ctx, 'ORG_COURSE_GRANT', 'COURSE_SERIES', seriesId, null, { studentIds: fresh.filter((studentId) => !raced.includes(studentId)), skipped: studentIds.length - grantedNow, racedCount: raced.length, source: grantSource, seriesType: seriesTypeOf(series) }, { orgId: currentOrgId });
    return { granted: grantedNow, skipped: studentIds.length - grantedNow, quotaTotal, quotaUsed: quotaUsed + grantedNow, seriesType: seriesTypeOf(series) };
    });
  }

  /**
   * 002-03 学生授权中心（2026-09-17 按线框图）：换一个视角看同一份授权 ——
   * 上面那些接口是从**课包**看「分给了谁」，这里从**学生**看「拿到了哪些课包」。
   *
   * 口径（别自己发明状态）：
   *   · 学生 = 本机构 role='STUDENT' 且未删除的账号；「账号状态」就是 users.status 的 ACTIVE / DISABLED。
   *   · 「已有课包」= student_course_grants 里**未撤销**的记录数 > 0（没有「待激活」这一层，见 002-01 注释）。
   *   · 「本月新增授权」= 本月 granted_at 的授权条数。含后来被平台撤销的 —— 那次授权确实发生过，
   *     按「发生过的事」计数才对得上总览页的 month.grants。
   *   · 「授权概览」只给前几个课包名，前端自己接「等 N 个」——不然这一格会把表格撑变形。
   */
  if (part === '/student-grants-summary' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看学生授权中心', 'ORG_ADMIN_REQUIRED');
    const monthStart = `${nowIso().slice(0, 7)}-01`;
    const totals = {
      students: await acount("SELECT COUNT(*) n FROM users WHERE org_id=? AND role='STUDENT' AND deleted_at IS NULL", [currentOrgId]),
      grantedThisMonth: await acount('SELECT COUNT(*) n FROM student_course_grants WHERE org_id=? AND granted_at>=?', [currentOrgId, monthStart]),
      withGrants: await acount(`SELECT COUNT(DISTINCT grant.student_id) n FROM student_course_grants AS \`grant\`
        JOIN users student ON student.id=grant.student_id AND student.deleted_at IS NULL
        WHERE grant.org_id=? AND grant.revoked_at IS NULL AND student.role='STUDENT'`, [currentOrgId]),
    };
    totals.withoutGrants = Math.max(0, totals.students - totals.withGrants);
    // 「体验人次」与「课包数」分开算（2026-09-24 用户口径）：
    //   · 课包数看 withGrants / active_count（一个课包算一个，体验包重复分也只有一条许可行）
    //   · 体验人次看**核销明细**：每场课堂正常结束且有有效产出核销 1 次（见 services/courseGrants.js）
    totals.experienceConsumedUnits = await acount(
      'SELECT COALESCE(SUM(units),0) n FROM student_course_grant_consumptions WHERE org_id=?',
      [currentOrgId],
    );

    const search = String(ctx.search.get('search') || '').trim();
    const accountStatus = String(ctx.search.get('status') || '').trim().toUpperCase();
    const grantState = String(ctx.search.get('grantState') || '').trim().toUpperCase();
    const params = [currentOrgId];
    let where = "student.org_id=? AND student.role='STUDENT' AND student.deleted_at IS NULL";
    if (accountStatus === 'ACTIVE' || accountStatus === 'DISABLED') { where += ' AND student.status=?'; params.push(accountStatus); }
    if (search) {
      const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
      where += ' AND (student.login LIKE ? OR student.display_name LIKE ? OR student.phone LIKE ?)';
      params.push(keyword, keyword, keyword);
    }
    // 有效课包数用**同一个字面量表达式**算两遍（HAVING 与 SELECT）：SQLite 里别名进 HAVING 靠不住，
    // 两处必须逐字一致，否则「筛选说 0 个、列里显示 2 个」。
    // ⚠️ `grant.id IS NOT NULL` 不能省：左连接没匹配到时 grant.revoked_at 也是 NULL，
    //    只判 revoked_at 会把「一个课包都没有的学生」数成 1（p111 当场抓到过这个 bug）。
    const activeCountSql = 'SUM(CASE WHEN grant.id IS NOT NULL AND grant.revoked_at IS NULL THEN 1 ELSE 0 END)';
    // 体验课包的「可用 N 次」：同一行上的 已授权 − 已核销（普通课包恒 1 − 0 = 1，前端可以不显示它）
    const remainingUnitsSql = 'SUM(CASE WHEN grant.id IS NOT NULL AND grant.revoked_at IS NULL THEN COALESCE(grant.granted_units,1) - COALESCE(grant.consumed_units,0) ELSE 0 END)';
    let having = '';
    if (grantState === 'WITH') having = ` HAVING ${activeCountSql} > 0`;
    else if (grantState === 'WITHOUT') having = ` HAVING ${activeCountSql} = 0`;
    const fromSql = `FROM users student
      LEFT JOIN student_course_grants AS \`grant\` ON grant.student_id=student.id AND grant.org_id=student.org_id
      WHERE ${where} GROUP BY student.id${having}`;
    const total = await acount(`SELECT COUNT(*) n FROM (SELECT student.id ${fromSql})`, params);
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 20, maxLimit: 200 });
    const listRows = await arows(`SELECT student.id, student.login, student.display_name, student.phone, student.status,
        ${activeCountSql} active_count,
        ${remainingUnitsSql} remaining_units,
        MAX(CASE WHEN grant.revoked_at IS NULL THEN grant.granted_at END) last_granted_at
      ${fromSql}
      ORDER BY last_granted_at IS NULL, last_granted_at DESC, student.created_at DESC
      LIMIT ? OFFSET ?`, [...params, limit, offset]);
    // 当前页学生的课包名（只为「授权概览」这一格）
    const seriesByStudent = new Map();
    if (listRows.length) {
      const placeholders = listRows.map(() => '?').join(',');
      for (const item of await arows(`SELECT grant.student_id, series.id series_id, series.title
        FROM student_course_grants AS \`grant\` JOIN course_series series ON series.id=grant.series_id
        WHERE grant.org_id=? AND grant.revoked_at IS NULL AND grant.student_id IN (${placeholders})
        ORDER BY grant.granted_at DESC`, [currentOrgId, ...listRows.map((item) => item.id)])) {
        if (!seriesByStudent.has(item.student_id)) seriesByStudent.set(item.student_id, []);
        seriesByStudent.get(item.student_id).push({ seriesId: item.series_id, title: item.title });
      }
    }
    const items = listRows.map((item) => ({
      studentId: item.id, displayName: item.display_name, login: item.login, phone: item.phone || null, status: item.status,
      grantedCount: Number(item.active_count || 0),
      // 有效许可上还剩多少次（体验课包用；普通课包恒等于课包数）
      remainingUnits: Number(item.remaining_units || 0),
      lastGrantedAt: item.last_granted_at || null,
      grantedSeries: seriesByStudent.get(item.id) || [],
    }));
    return { ...pageResult(items, { page, limit, total }), totals };
  }

  /**
   * 002-04 学生授权详情：一个学生拿到了哪些课包、每个课包有没有**正式学习记录**。
   * 002-04B 那个右侧抽屉（单条授权详情）也用这个接口的数据，不另开接口。
   *
   * 「正式学习记录 已产生/未产生」数据库里**没有标志位**，用现成口径算：
   * 「该学生在属于这个课包的课堂上，有过成功且非 mock 的 AI 调用」——
   * 与完课判定（services/classroomSessions.js:164）**逐字同一套条件**。
   * ⚠️ 那三个 NOT LIKE '%MOCK%' 是三处不同的东西（模型名 / 供应商 / 运行模式），
   *    要改必须两边一起改，否则会出现「课堂算完课了、这里说没学」。
   */
  const studentGrantsMatch = part.match(/^\/students\/([^/]+)\/course-grants$/);
  if (studentGrantsMatch && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看学生授权详情', 'ORG_ADMIN_REQUIRED');
    const studentId = studentGrantsMatch[1];
    const student = await arow("SELECT id, login, display_name, phone, status FROM users WHERE id=? AND org_id=? AND role='STUDENT' AND deleted_at IS NULL", [studentId, currentOrgId]);
    if (!student) throw errors.notFound('学生不存在或不属于本机构', 'STUDENT_NOT_FOUND');
    const learnedSeries = new Set((await arows(`SELECT DISTINCT lesson.series_id series_id
      FROM usage_records AS \`usage\`
      JOIN class_sessions session ON session.id=usage.class_session_id
      JOIN course_lessons lesson ON lesson.id=session.lesson_id
      WHERE usage.user_id=? AND usage.org_id=? AND usage.status='SUCCESS'
        AND UPPER(usage.model) NOT LIKE '%MOCK%'
        AND UPPER(COALESCE(json_extract(usage.pricing_snapshot, '$.provider'), '')) NOT LIKE '%MOCK%'
        AND UPPER(COALESCE(json_extract(usage.pricing_snapshot, '$.mode'), '')) NOT LIKE '%MOCK%'`,
      [studentId, currentOrgId])).map((item) => item.series_id));
    // 「已进入正式课堂」= 这个学生在属于该课包的课堂上，课堂**已经正式开过**（上课中 / 已结束）。
    // 与「有没有 AI 调用」是两条不同的线：线框图把「学习中」定义成**两者之一**成立即可
    // （待激活 = 两者都没有）；而「完课」只看 AI 调用那一条（services/classroomSessions.js:164）。
    // 待上课（PENDING）不算 —— 排了课但没开课，学生还没真正进过课堂。
    const enteredSeries = new Set((await arows(`SELECT DISTINCT lesson.series_id series_id
      FROM session_students part
      JOIN class_sessions session ON session.id=part.session_id
      JOIN course_lessons lesson ON lesson.id=session.lesson_id
      WHERE part.student_id=? AND session.org_id=? AND session.status IN ('ACTIVE','ENDED')`,
      [studentId, currentOrgId])).map((item) => item.series_id));
    const items = (await arows(`SELECT grant.id, grant.series_id, grant.granted_at, grant.revoked_at, grant.revoke_reason,
        grant.source_assignment_id, grant.granted_units, grant.consumed_units, series.title, series.version, series.series_type,
        actor.display_name granted_by_name, actor.login granted_by_login
      FROM student_course_grants AS \`grant\`
      JOIN course_series series ON series.id=grant.series_id
      LEFT JOIN users actor ON actor.id=grant.granted_by
      WHERE grant.org_id=? AND grant.student_id=?
      ORDER BY grant.revoked_at IS NOT NULL, grant.granted_at DESC`, [currentOrgId, studentId])).map((item) => {
      const learned = learnedSeries.has(item.series_id);
      const entered = enteredSeries.has(item.series_id);
      // 授权状态（线框图 002-04「授权规则」1/2 第一次给了判定口径，所以现在能真算，不再是「没有状态列」）：
      //   已取消   = 有 revoked_at
      //   学习中   = **已进入正式课堂** 或 **已产生有效 AI 学习记录**（两者之一）
      //   待激活   = 两者都没有
      // ⚠️ 线框图 rule 1 还列了「已完成」，但**通篇没给判定口径**（rule 2 只定义了待激活/学习中）。
      //    所以这里**不编**：不产出 COMPLETED。要它就得先定口径（是「全部课时完课」还是别的）。
      const state = item.revoked_at ? 'REVOKED' : ((learned || entered) ? 'LEARNING' : 'PENDING_ACTIVATION');
      return {
        id: item.id, seriesId: item.series_id, seriesTitle: item.title || null, version: item.version || null,
        grantedAt: item.granted_at,
        status: item.revoked_at ? 'REVOKED' : 'ACTIVE',
        state, stateLabel: GRANT_STATE_LABELS[state],
        revokedAt: item.revoked_at || null, revokeReason: item.revoke_reason || null,
        learned, enteredClass: entered,
        grantedByName: item.granted_by_name || null, grantedByLogin: item.granted_by_login || null,
        // 占用人次：普通课包授给一名学生就是 1 次（平台口径），不是估算出来的。
        // 体验课包是**同一行里累积的次数**：占用人次 = 累计授权次数，另给「还剩几次」。
        seriesType: seriesTypeOf({ series_type: item.series_type }),
        quotaConsumed: grantUnitsOf(item).granted,
        grantedUnits: grantUnitsOf(item).granted,
        consumedUnits: grantUnitsOf(item).consumed,
        remainingUnits: grantUnitsOf(item).remaining,
        sourceAssignmentId: item.source_assignment_id || null,
        sourceLabel: item.source_assignment_id ? '平台授予本机构的课包权益' : '历史数据（无授权单）',
      };
    });
    const activeItems = items.filter((item) => item.status === 'ACTIVE');
    return {
      student: { studentId: student.id, displayName: student.display_name, login: student.login, phone: student.phone || null, status: student.status },
      summary: {
        activeSeriesCount: activeItems.length,
        learnedSeriesCount: activeItems.filter((item) => item.learned).length,
        learningCount: activeItems.filter((item) => item.state === 'LEARNING').length,
        pendingActivationCount: activeItems.filter((item) => item.state === 'PENDING_ACTIVATION').length,
        revokedCount: items.length - activeItems.length,
      },
      items, total: items.length,
    };
  }

  /**
   * 002-06 采购 / 增购 / 开通记录：机构能看到的「这些人次是从哪来的」。
   *
   * ⚠️ 批次表里**没有**「初次开通 / 增购 / 平台调整」这三列 —— 它只有
   *    purchase_type（PURCHASE | LEGACY_OPENING_BALANCE）。线框图要的三分类按
   *    **批次在同一张授权单里的序号**推出来：LEGACY → 平台调整；PURCHASE 的第一条 → 初次开通，
   *    之后的 → 增购。用窗口函数算序号，而不是给库加一列（加列要迁移，且历史批次补不出真序号）。
   *    序号**只按 PURCHASE 排**（PARTITION BY 带上 purchase_type）：期初结转那条批次日期通常最早，
   *    若把它算进序号，真正的第一笔采购会被挤成「增购」（p111 抓到过这个）。
   *
   * 卡片口径：只吃「课包 / 时间 / 来源」三个筛选，**不吃业务类型** —— 卡片本身就是业务类型的
   * 分布，再按业务类型筛会让另外三张卡变成 0。
   */
  if (part === '/license-batches' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看采购与开通记录', 'ORG_ADMIN_REQUIRED');
    const seriesFilter = String(ctx.search.get('seriesId') || '').trim();
    const businessFilter = String(ctx.search.get('businessType') || '').trim().toUpperCase();
    const sourceFilter = String(ctx.search.get('source') || '').trim().toUpperCase();
    const from = String(ctx.search.get('from') || '').trim();
    const to = String(ctx.search.get('to') || '').trim();
    const allRows = await arows(`SELECT batch.id, batch.series_id, batch.purchase_type, batch.quantity, batch.payment_status,
        batch.order_no, batch.contract_no, batch.purchased_at,
        series.title series_title, actor.display_name actor_name,
        ROW_NUMBER() OVER (PARTITION BY batch.assignment_id, batch.purchase_type ORDER BY batch.purchased_at, batch.created_at, batch.id) seq
      FROM license_purchase_batches batch
      JOIN course_series series ON series.id=batch.series_id
      LEFT JOIN users actor ON actor.id=batch.purchased_by
      WHERE batch.org_id=? AND batch.status='ACTIVE'
      ORDER BY batch.purchased_at DESC, batch.id DESC`, [currentOrgId]);
    const mapped = allRows.map((item) => {
      const businessType = item.purchase_type === 'LEGACY_OPENING_BALANCE'
        ? 'PLATFORM_ADJUSTMENT'
        : (Number(item.seq) <= 1 ? 'FIRST_OPENING' : 'ADDITIONAL');
      const source = item.order_no ? 'ORDER' : (item.contract_no ? 'CONTRACT' : 'PLATFORM');
      const note = [
        item.order_no ? `订单 ${item.order_no}` : null,
        item.contract_no ? `合同 ${item.contract_no}` : null,
      ].filter(Boolean).join(' · ');
      return {
        id: item.id, purchasedAt: item.purchased_at, seriesId: item.series_id, seriesTitle: item.series_title || null,
        businessType, source, quantity: Number(item.quantity || 0),
        actorName: item.actor_name || null, paymentStatus: item.payment_status || null,
        note: note || (item.purchase_type === 'LEGACY_OPENING_BALANCE' ? '平台开通时结转的期初人次' : '—'),
      };
    });
    const scoped = mapped.filter((item) => {
      if (seriesFilter && item.seriesId !== seriesFilter) return false;
      if (from && String(item.purchasedAt) < from) return false;
      if (to && String(item.purchasedAt) > to) return false;
      if (sourceFilter && item.source !== sourceFilter) return false;
      return true;
    });
    const totals = {
      total: scoped.length,
      firstOpening: scoped.filter((item) => item.businessType === 'FIRST_OPENING').length,
      additional: scoped.filter((item) => item.businessType === 'ADDITIONAL').length,
      platformAdjustment: scoped.filter((item) => item.businessType === 'PLATFORM_ADJUSTMENT').length,
      quantity: scoped.reduce((sum, item) => sum + item.quantity, 0),
    };
    const filtered = businessFilter ? scoped.filter((item) => item.businessType === businessFilter) : scoped;
    const { page, limit } = pageParams(ctx.search, { defaultLimit: 20, maxLimit: 200 });
    return { ...pageResult(filtered.slice((page - 1) * limit, page * limit), { page, limit, total: filtered.length }), totals };
  }

  /**
   * 002-05 学生授权记录（2026-09-17 按线框图第 2 张）。
   *
   * 数据源 = **现有审计表** `audit_logs`（用户 2026-09-17 定的口径，不为它新建表）：
   *   · `ORG_COURSE_GRANT` —— 机构授权（target=COURSE_SERIES，`after_data.studentIds` 是被授权的人）
   *   · `COURSE_GRANT_REVOKE` —— 平台撤销（target=STUDENT_COURSE_GRANT，target_id 就是 grant.id）
   *
   * ⚠️ 套用审计表有**三处对不全**（用户已知并接受，所以界面上要如实说明，不能看起来像全的）：
   *   ① 「操作结果」只有成功 —— 失败的授权在抛错前就返回了，**根本不落审计**；
   *   ② 「来源」老记录没有（只有 request_path，而机构授权的路径永远是 `/api/org/course-grants`）；
   *      所以从这一版起让调用方带 `source` 存进 after_data，老记录只能显示「机构端授权」；
   *   ③ 一次批量授权在审计里是**一条**记录，这里按 `studentIds` 拆成每人一行（线框图要的是人维度）。
   * 另外注意：机构端**没有**取消授权权限，所以「取消授权」那些行的操作账号一定是**平台**侧账号。
   */
  if (part === '/student-grant-records' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看学生授权记录', 'ORG_ADMIN_REQUIRED');
    const logs = await arows(`SELECT log.id, log.action, log.target_id, log.actor_id, log.before_data, log.after_data, log.created_at,
        actor.display_name actor_name, actor.login actor_login
      FROM audit_logs log
      LEFT JOIN users actor ON actor.id=log.actor_id
      WHERE log.org_id=? AND log.action IN ('ORG_COURSE_GRANT','COURSE_GRANT_REVOKE')
      ORDER BY log.created_at DESC, log.id DESC
      LIMIT 2000`, [currentOrgId]);
    // 批量把名字查出来（逐条查库会 N+1）
    const studentIds = new Set();
    const grantIds = new Set();
    for (const log of logs) {
      if (log.action === 'ORG_COURSE_GRANT') {
        for (const studentId of (parseJson(log.after_data, {})?.studentIds || [])) studentIds.add(studentId);
      } else if (log.target_id) grantIds.add(log.target_id);
    }
    const grantById = new Map();
    if (grantIds.size) {
      const placeholders = [...grantIds].map(() => '?').join(',');
      for (const item of await arows(`SELECT id, student_id, series_id FROM student_course_grants WHERE id IN (${placeholders})`, [...grantIds])) {
        grantById.set(item.id, item);
        studentIds.add(item.student_id);
      }
    }
    const studentById = new Map();
    if (studentIds.size) {
      const placeholders = [...studentIds].map(() => '?').join(',');
      for (const item of await arows(`SELECT id, login, display_name FROM users WHERE id IN (${placeholders})`, [...studentIds])) studentById.set(item.id, item);
    }
    // 课包：机构的授权记录里 target_id 就是 seriesId；撤销的要从 grant 行反查
    const seriesIds = new Set();
    for (const log of logs) {
      if (log.action === 'ORG_COURSE_GRANT') { if (log.target_id) seriesIds.add(log.target_id); }
      else { const grant = grantById.get(log.target_id); if (grant?.series_id) seriesIds.add(grant.series_id); }
    }
    const seriesById = new Map();
    if (seriesIds.size) {
      const ids = [...seriesIds];
      const placeholders = ids.map(() => '?').join(',');
      for (const item of await arows(`SELECT id, title FROM course_series WHERE id IN (${placeholders})`, ids)) seriesById.set(item.id, item);
    }
    const records = [];
    for (const log of logs) {
      const isGrant = log.action === 'ORG_COURSE_GRANT';
      const after = parseJson(log.after_data, {}) || {};
      // 授权：操作账号 = 发起授权的机构账号；取消：平台侧账号
      const base = {
        occurredAt: log.created_at,
        operationType: isGrant ? 'GRANT' : 'REVOKE',
        operationLabel: isGrant ? '授权' : '取消授权',
        // 能进审计的就只有成功的（失败的没落库）—— 这不是"全部成功"，是"只看得见成功"
        result: 'SUCCESS', resultLabel: '成功',
        actorId: log.actor_id || null,
        actorName: log.actor_name || log.actor_login || (isGrant ? '机构账号' : '平台账号'),
        actorScope: isGrant ? 'ORG' : 'PLATFORM',
        source: isGrant ? (after.source || 'ORG_UNKNOWN') : 'PLATFORM',
        sourceLabel: isGrant ? (GRANT_SOURCE_LABELS[after.source] || '机构端授权（旧记录无来源）') : '平台撤销',
        note: isGrant ? null : (after.reason || null),
      };
      if (isGrant) {
        for (const studentId of (Array.isArray(after.studentIds) ? after.studentIds : [])) {
          const student = studentById.get(studentId);
          records.push({
            ...base, id: `${log.id}:${studentId}`,
            studentId, studentName: student?.display_name || null, studentLogin: student?.login || null,
            seriesId: log.target_id, seriesTitle: seriesById.get(log.target_id)?.title || null,
          });
        }
      } else {
        const grant = grantById.get(log.target_id);
        const student = grant ? studentById.get(grant.student_id) : null;
        records.push({
          ...base, id: log.id,
          studentId: grant?.student_id || null, studentName: student?.display_name || null, studentLogin: student?.login || null,
          seriesId: grant?.series_id || null, seriesTitle: grant ? (seriesById.get(grant.series_id)?.title || null) : null,
        });
      }
    }
    // 卡片：三条是**绝对口径**（本月 / 今日），记录总数是全部 —— 与筛选无关（和 002-06 同一套理由）
    const monthStart = `${nowIso().slice(0, 7)}-01`;
    const dayStart = `${nowIso().slice(0, 10)}`;
    const totals = {
      grantedThisMonth: records.filter((item) => item.operationType === 'GRANT' && String(item.occurredAt) >= monthStart).length,
      revokedThisMonth: records.filter((item) => item.operationType === 'REVOKE' && String(item.occurredAt) >= monthStart).length,
      grantedToday: records.filter((item) => item.operationType === 'GRANT' && String(item.occurredAt) >= dayStart).length,
      total: records.length,
    };
    const search = String(ctx.search.get('search') || '').trim().toLowerCase();
    const seriesFilter = String(ctx.search.get('seriesId') || '').trim();
    const typeFilter = String(ctx.search.get('operationType') || '').trim().toUpperCase();
    const actorFilter = String(ctx.search.get('actorId') || '').trim();
    const from = String(ctx.search.get('from') || '').trim();
    const to = String(ctx.search.get('to') || '').trim();
    const filtered = records.filter((item) => {
      if (seriesFilter && item.seriesId !== seriesFilter) return false;
      if (typeFilter && item.operationType !== typeFilter) return false;
      if (actorFilter && item.actorId !== actorFilter) return false;
      if (from && String(item.occurredAt) < from) return false;
      if (to && String(item.occurredAt) > to) return false;
      if (search && !`${item.studentName || ''} ${item.studentLogin || ''}`.toLowerCase().includes(search)) return false;
      return true;
    });
    // 「操作账号」下拉：本机构记录里出现过的账号去重（只有平台侧账号做过取消）
    const actorOptions = [...new Map(records.filter((item) => item.actorId).map((item) => [item.actorId, { actorId: item.actorId, name: item.actorName, scope: item.actorScope }])).values()];
    const { page, limit } = pageParams(ctx.search, { defaultLimit: 20, maxLimit: 200 });
    return { ...pageResult(filtered.slice((page - 1) * limit, page * limit), { page, limit, total: filtered.length }), totals, actorOptions };
  }

  // P1: 机构端 - 查看成员配额列表
  
  // P1: 机构端 - 调整单个用户配额
  
  // P1: 机构端 - 批量分配配额
  
  // P1: 机构端 - 查看用户配额调整历史

  return null;
}
