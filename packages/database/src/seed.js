import { hashPassword, id, json, nowIso, q, row, transaction } from './schema.js';

const DAY = 24 * 60 * 60 * 1000;
const PLUS_DAYS = (days) => new Date(Date.now() + days * DAY).toISOString();

function ensurePlatformSettings(now) {
  q(
    `INSERT INTO platform_settings(id,platform_name,modalities,billing_settings,created_at,updated_at)
     VALUES (1,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       platform_name=excluded.platform_name,
       modalities=excluded.modalities,
       billing_settings=excluded.billing_settings,
       updated_at=excluded.updated_at`,
    [
      'AI 少儿编程平台（P0）',
      json({
        TEXT: { enabled: true },
        IMAGE: { enabled: true },
        MUSIC: { enabled: true },
        VIDEO: { enabled: true },
        PODCAST: { enabled: false },
        DUBBING: { enabled: false },
      }),
      json({ currency: 'CNY', defaultSessionCreditCap: 200 }),
      now,
      now,
    ],
  );
}

function ensureUser({ login, orgId = null, displayName, role, password, permissions = [], extras = {} }, now) {
  let user = row('SELECT * FROM users WHERE login = ?', [login]);
  if (!user) {
    const userId = id('user');
    q(
      `INSERT INTO users(
        id,org_id,login,display_name,role,permissions,password_hash,status,
        student_usage_scope,billing_package_id,monthly_credit_allowance,monthly_bonus_credits,
        month_period_boost_credits,used_credits_this_period,period_start_at,period_reset_at,
        magic_stones,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        userId,
        orgId,
        login,
        displayName,
        role,
        json(permissions),
        hashPassword(password),
        'ACTIVE',
        extras.studentUsageScope ?? null,
        extras.billingPackageId ?? null,
        extras.monthlyCreditAllowance ?? 0,
        extras.monthlyBonusCredits ?? 0,
        extras.monthPeriodBoostCredits ?? 0,
        extras.usedCreditsThisPeriod ?? 0,
        extras.periodStartAt ?? now,
        extras.periodResetAt ?? PLUS_DAYS(30),
        extras.magicStones ?? 0,
        now,
        now,
      ],
    );
    user = row('SELECT * FROM users WHERE id = ?', [userId]);
  } else {
    // 演示账号以稳定登录名为锚点复用；只补齐和纠正 P0 必需字段，不清理任何历史业务数据。
    q(
      `UPDATE users SET
        org_id=?,display_name=?,role=?,permissions=?,password_hash=?,status='ACTIVE',deleted_at=NULL,
        student_usage_scope=?,billing_package_id=?,monthly_credit_allowance=?,monthly_bonus_credits=?,
        month_period_boost_credits=?,period_start_at=COALESCE(period_start_at,?),
        period_reset_at=COALESCE(period_reset_at,?),updated_at=?
       WHERE id=?`,
      [
        orgId,
        displayName,
        role,
        json(permissions),
        hashPassword(password),
        extras.studentUsageScope ?? null,
        extras.billingPackageId ?? null,
        extras.monthlyCreditAllowance ?? 0,
        extras.monthlyBonusCredits ?? 0,
        extras.monthPeriodBoostCredits ?? 0,
        extras.periodStartAt ?? now,
        extras.periodResetAt ?? PLUS_DAYS(30),
        now,
        user.id,
      ],
    );
    user = row('SELECT * FROM users WHERE id = ?', [user.id]);
  }
  return user;
}

function ensureOrganization(now) {
  let organization = row('SELECT * FROM organizations WHERE name = ?', ['示例创新学校']);
  if (!organization) {
    const orgId = id('org');
    q(
      `INSERT INTO organizations(
        id,name,status,contract_start_at,contract_expires_at,is_trial,
        base_teacher_seats,purchased_teacher_seats,contact,created_by,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        orgId,
        '示例创新学校',
        'ACTIVE',
        now,
        PLUS_DAYS(365),
        0,
        3,
        2,
        json({ contact: '张校长', phone: '13800000000', email: 'demo@example.edu.cn' }),
        null,
        now,
        now,
      ],
    );
    organization = row('SELECT * FROM organizations WHERE id = ?', [orgId]);
  } else {
    q(
      `UPDATE organizations SET status='ACTIVE',is_trial=0,
       contract_expires_at=CASE WHEN contract_expires_at < ? THEN ? ELSE contract_expires_at END,
       base_teacher_seats=MAX(base_teacher_seats,3),
       purchased_teacher_seats=MAX(purchased_teacher_seats,2),updated_at=? WHERE id=?`,
      [now, PLUS_DAYS(365), now, organization.id],
    );
    organization = row('SELECT * FROM organizations WHERE id = ?', [organization.id]);
  }
  q(
    `INSERT INTO org_billing_accounts(org_id,credit_balance,total_credits_in,total_credits_spent,currency_paid_total_fen,updated_version)
     VALUES (?,?,?,?,?,1)
     ON CONFLICT(org_id) DO UPDATE SET
       credit_balance=MAX(org_billing_accounts.credit_balance, excluded.credit_balance),
       total_credits_in=MAX(org_billing_accounts.total_credits_in, excluded.total_credits_in)`,
    [organization.id, 100000, 100000, 0, 0],
  );
  return organization;
}

function ensurePackage(orgId, now) {
  let pkg = row('SELECT * FROM billing_packages WHERE org_id = ? AND name = ?', [orgId, '标准创作套餐']);
  if (!pkg) {
    const packageId = id('pkg');
    q(
      `INSERT INTO billing_packages(
        id,org_id,name,price_fen,monthly_credits,bonus_credits,duration_days,
        allow_image,allow_music,allow_video,allow_podcast,allow_dubbing,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [packageId, orgId, '标准创作套餐', 9900, 500, 50, 30, 1, 1, 1, 0, 0, 'ACTIVE', now, now],
    );
    pkg = row('SELECT * FROM billing_packages WHERE id = ?', [packageId]);
  } else {
    q(
      `UPDATE billing_packages SET monthly_credits=500,bonus_credits=50,duration_days=30,
       allow_image=1,allow_music=1,allow_video=1,allow_podcast=0,allow_dubbing=0,status='ACTIVE',updated_at=?
       WHERE id=?`,
      [now, pkg.id],
    );
    pkg = row('SELECT * FROM billing_packages WHERE id = ?', [pkg.id]);
  }
  return pkg;
}

function ensureCourse(now) {
  let series = row(`SELECT * FROM course_series WHERE owner_type='PLATFORM' AND title=?`, ['AI古诗词创意营']);
  if (!series) {
    const seriesId = id('series');
    q(
      `INSERT INTO course_series(id,title,description,owner_type,visibility,version,sort,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [seriesId, 'AI古诗词创意营', '5 课时古诗情景动画与创意表达课程', 'PLATFORM', 'ALL_ORGS', '1.0', 1, 'PUBLISHED', now, now],
    );
    series = row('SELECT * FROM course_series WHERE id=?', [seriesId]);
  } else {
    q(`UPDATE course_series SET description=?,visibility='ALL_ORGS',status='PUBLISHED',updated_at=? WHERE id=?`, ['5 课时古诗情景动画与创意表达课程', now, series.id]);
    series = row('SELECT * FROM course_series WHERE id=?', [series.id]);
  }

  const lessons = [
    ['第1课：认识古诗与创作主题', '认识古诗意境，选择想要表达的诗词主题。'],
    ['第2课：设计诗词主角与场景', '设计人物、动物或精灵主角，并规划故事发生的场景。'],
    ['第3课：生成画面与故事分镜', '把诗句转化为画面，完成故事分镜与画面提示词。'],
    ['第4课：编排动画与声音', '为画面安排动作、镜头和声音，让诗词故事动起来。'],
    ['第5课：完成作品并展示', '完善创作、讲述设计思路并提交作品展示。'],
  ];
  const lessonRows = [];
  lessons.forEach(([title, summary], index) => {
    const sort = index + 1;
    let lesson = row('SELECT * FROM course_lessons WHERE series_id=? AND sort=?', [series.id, sort]);
    if (!lesson) {
      const lessonId = id('lesson');
      q(
        `INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [lessonId, series.id, title, summary, sort, 'PUBLISHED', 45, now, now],
      );
      lesson = row('SELECT * FROM course_lessons WHERE id=?', [lessonId]);
    } else {
      q(`UPDATE course_lessons SET title=?,summary=?,status='PUBLISHED',duration_minutes=45,updated_at=? WHERE id=?`, [title, summary, now, lesson.id]);
      lesson = row('SELECT * FROM course_lessons WHERE id=?', [lesson.id]);
    }
    lessonRows.push(lesson);
  });
  return { series, lessons: lessonRows };
}

function ensureClass({ orgId, teacherId, students, series, lessons }, now) {
  let klass = row(`SELECT * FROM classes WHERE org_id=? AND name=? AND status='ACTIVE'`, [orgId, '三年级AI创作一班']);
  if (!klass) {
    const classId = id('class');
    q(
      `INSERT INTO classes(id,org_id,name,teacher_id,usage_mode,default_series_id,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [classId, orgId, '三年级AI创作一班', teacherId, 'CLASS_ONLY', series.id, 'ACTIVE', now, now],
    );
    klass = row('SELECT * FROM classes WHERE id=?', [classId]);
  } else {
    q(`UPDATE classes SET teacher_id=?,usage_mode='CLASS_ONLY',default_series_id=?,updated_at=? WHERE id=?`, [teacherId, series.id, now, klass.id]);
    klass = row('SELECT * FROM classes WHERE id=?', [klass.id]);
  }

  const ensureMember = (userId, role) => {
    const active = row(`SELECT id FROM class_members WHERE class_id=? AND user_id=? AND removed_at IS NULL`, [klass.id, userId]);
    if (!active) q(`INSERT INTO class_members(id,class_id,user_id,role,joined_at) VALUES (?,?,?,?,?)`, [id('member'), klass.id, userId, role, now]);
  };
  ensureMember(teacherId, 'TEACHER');
  students.forEach((student) => ensureMember(student.id, 'STUDENT'));

  lessons.forEach((lesson, index) => {
    const current = row(`SELECT id FROM class_curriculum_items WHERE class_id=? AND lesson_id=?`, [klass.id, lesson.id]);
    if (!current) {
      q(
        `INSERT INTO class_curriculum_items(id,class_id,lesson_id,sort,source_series_id,added_at)
         VALUES (?,?,?,?,?,?)`,
        [id('curriculum'), klass.id, lesson.id, index + 1, series.id, now],
      );
    }
  });
  return klass;
}

export function seedDatabase() {
  const now = nowIso();
  return transaction(() => {
    ensurePlatformSettings(now);
    ensureUser({ login: 'root', displayName: '平台超管', role: 'SUPER_ADMIN', password: 'admin123' }, now);

    const organization = ensureOrganization(now);
    const pkg = ensurePackage(organization.id, now);
    ensureUser({ login: 'org-admin', orgId: organization.id, displayName: '机构管理员', role: 'ORG_ADMIN', password: 'org123' }, now);
    const teacher1 = ensureUser({ login: 'teacher-1', orgId: organization.id, displayName: '王老师', role: 'TEACHER', password: 'teach123', permissions: ['MANAGE_CLASSES'] }, now);
    ensureUser({ login: 'teacher-2', orgId: organization.id, displayName: '李老师', role: 'TEACHER', password: 'teach123', permissions: ['MANAGE_CLASSES', 'MANAGE_MEMBERS'] }, now);
    const student1 = ensureUser({
      login: 'student-1', orgId: organization.id, displayName: '小明', role: 'STUDENT', password: 'study123',
      extras: { studentUsageScope: 'FOLLOW_CLASS', billingPackageId: pkg.id, monthlyCreditAllowance: 100, monthlyBonusCredits: 20, magicStones: 120 },
    }, now);
    const student2 = ensureUser({
      login: 'student-2', orgId: organization.id, displayName: '小红', role: 'STUDENT', password: 'study123',
      extras: { studentUsageScope: 'HOME_PRACTICE', billingPackageId: pkg.id, monthlyCreditAllowance: 100, monthlyBonusCredits: 20, magicStones: 120 },
    }, now);

    const course = ensureCourse(now);
    const assignment = row(`SELECT id FROM course_assignments WHERE series_id=? AND org_id=?`, [course.series.id, organization.id]);
    if (!assignment) {
      q(`INSERT INTO course_assignments(id,series_id,org_id,status,assigned_by,assigned_at) VALUES (?,?,?,?,?,?)`, [id('assignment'), course.series.id, organization.id, 'ACTIVE', null, now]);
    } else {
      q(`UPDATE course_assignments SET status='ACTIVE' WHERE id=?`, [assignment.id]);
    }
    ensureClass({ orgId: organization.id, teacherId: teacher1.id, students: [student1, student2], ...course }, now);
    return { organizationId: organization.id, courseSeriesId: course.series.id };
  });
}

if (process.argv[1] && /seed\.js$/i.test(process.argv[1])) {
  seedDatabase();
  console.log('Seed complete.');
}
