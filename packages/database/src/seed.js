import { pathToFileURL } from 'node:url';
import { hashPassword, id, json, nowIso, q, row, transaction, arow, aq, atransaction, isMysql, SQL_MAX, closePool } from './store.js';
import { WEBSITE_CONTENT_DEFAULTS } from './websiteContentDefaults.js';

const DAY = 24 * 60 * 60 * 1000;
const PLUS_DAYS = (days) => new Date(Date.now() + days * DAY).toISOString();

async function ensureWebsiteContent(now) {
  const defaults = WEBSITE_CONTENT_DEFAULTS;
  for (const [contentKey, content] of Object.entries(defaults)) {
    const existing = await arow('SELECT content_key FROM website_contents WHERE content_key=?', [contentKey]);
    if (!existing) {
      const value = json(content);
      await aq('INSERT INTO website_contents(content_key,draft_content,published_content,draft_version,published_version,updated_by,published_by,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [contentKey, value, value, 1, 1, null, null, now, now, now]);
      await aq('INSERT INTO website_content_revisions(id,content_key,version,content,action,changed_by,reason,created_at) VALUES (?,?,?,?,?,?,?,?)', [id('wrev'), contentKey, 1, value, 'PUBLISH', null, 'seed default', now]);
    }
  }
}

async function ensurePlatformSettings(now) {
  await aq(
    // 2026-09-18：modalities / billing_settings 两列已下线（只有本种子写过，全仓无读取方）。
    // upsert 的方言差异（RDS 阶段 2）：SQLite 用 `ON CONFLICT(x) DO UPDATE … excluded.y`，
    // MySQL 8 用 `… AS new ON DUPLICATE KEY UPDATE y=new.y`（VALUES(y) 在 8.0.20+ 已废弃但仍可用）。
    isMysql
      ? `INSERT INTO platform_settings(id,platform_name,created_at,updated_at)
     VALUES (1,?,?,?) AS new
     ON DUPLICATE KEY UPDATE
       platform_name=new.platform_name,
       updated_at=new.updated_at`
      : `INSERT INTO platform_settings(id,platform_name,created_at,updated_at)
     VALUES (1,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       platform_name=excluded.platform_name,
       updated_at=excluded.updated_at`,
    ['灵动ai学院', now, now],
  );
}

async function ensureUser({ login, orgId = null, displayName, role, password, permissions = [], extras = {} }, now) {
  let user = await arow('SELECT * FROM users WHERE login = ?', [login]);
  if (!user) {
    const userId = id('user');
    await aq(
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
    user = await arow('SELECT * FROM users WHERE id = ?', [userId]);
  } else {
    // 演示账号以稳定登录名为锚点复用；只补齐和纠正 P0 必需字段，不清理任何历史业务数据。
    await aq(
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
    user = await arow('SELECT * FROM users WHERE id = ?', [user.id]);
  }
  return user;
}

async function ensureOrganization(now) {
  let organization = await arow('SELECT * FROM organizations WHERE name = ?', ['示例创新学校']);
  if (!organization) {
    const orgId = id('org');
    await aq(
      `INSERT INTO organizations(
        id,name,status,contract_start_at,contract_expires_at,is_trial,
        base_teacher_seats,purchased_teacher_seats,student_seats,contact,created_by,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        orgId,
        '示例创新学校',
        'ACTIVE',
        now,
        PLUS_DAYS(365),
        0,
        3,
        2,
        30,
        json({ name: '张校长', phone: '13800000000', email: 'demo@example.edu.cn' }),
        null,
        now,
        now,
      ],
    );
    organization = await arow('SELECT * FROM organizations WHERE id = ?', [orgId]);
  } else {
    await aq(
      `UPDATE organizations SET status='ACTIVE',is_trial=0,
       contract_expires_at=CASE WHEN contract_expires_at < ? THEN ? ELSE contract_expires_at END,
       base_teacher_seats=${SQL_MAX}(base_teacher_seats,3),
       purchased_teacher_seats=${SQL_MAX}(purchased_teacher_seats,2),updated_at=? WHERE id=?`,
      [now, PLUS_DAYS(365), now, organization.id],
    );
    organization = await arow('SELECT * FROM organizations WHERE id = ?', [organization.id]);
  }
  await aq(
    `INSERT INTO org_billing_accounts(org_id,credit_balance,total_credits_in,total_credits_spent,currency_paid_total_fen,updated_version)
     VALUES (?,?,?,?,?,1)${isMysql ? ' AS new' : ''}
     ${isMysql
    ? `ON DUPLICATE KEY UPDATE credit_balance=${SQL_MAX}(org_billing_accounts.credit_balance, new.credit_balance), total_credits_in=${SQL_MAX}(org_billing_accounts.total_credits_in, new.total_credits_in)`
    : `ON CONFLICT(org_id) DO UPDATE SET
       credit_balance=${SQL_MAX}(org_billing_accounts.credit_balance, excluded.credit_balance),
       total_credits_in=${SQL_MAX}(org_billing_accounts.total_credits_in, excluded.total_credits_in)`}`,
    [organization.id, 100000, 100000, 0, 0],
  );
  // Keep the seeded opening balance auditable without inventing a paid recharge order.
  await aq(
    `INSERT INTO credit_entries(id,org_id,direction,type,credits,balance_after,status,reason,actor_id,created_at)
     SELECT ?,?,?,?,?,?,'EFFECTIVE',?,NULL,?
     WHERE NOT EXISTS (SELECT 1 FROM credit_entries WHERE org_id=? AND type='OPENING_BALANCE')`,
    [id('credit'), organization.id, 'IN', 'OPENING_BALANCE', 100000, 100000, '示例机构期初授权次数', now, organization.id],
  );
  return organization;
}

async function ensurePackage(orgId, now) {
  let pkg = await arow('SELECT * FROM billing_packages WHERE org_id = ? AND name = ?', [orgId, '标准创作套餐']);
  if (!pkg) {
    const packageId = id('pkg');
    await aq(
      `INSERT INTO billing_packages(
        id,org_id,name,price_fen,monthly_credits,bonus_credits,duration_days,
        allow_image,allow_music,allow_video,allow_podcast,allow_dubbing,student_seats,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [packageId, orgId, '标准创作套餐', 9900, 500, 50, 30, 1, 1, 1, 0, 0, 30, 'ACTIVE', now, now],
    );
    pkg = await arow('SELECT * FROM billing_packages WHERE id = ?', [packageId]);
  } else {
    await aq(
      `UPDATE billing_packages SET monthly_credits=500,bonus_credits=50,duration_days=30,
       allow_image=1,allow_music=1,allow_video=1,allow_podcast=0,allow_dubbing=0,student_seats=${SQL_MAX}(student_seats,30),status='ACTIVE',updated_at=?
       WHERE id=?`,
      [now, pkg.id],
    );
    pkg = await arow('SELECT * FROM billing_packages WHERE id = ?', [pkg.id]);
  }
  return pkg;
}

async function ensureCourse(now) {
  let series = await arow(`SELECT * FROM course_series WHERE owner_type='PLATFORM' AND title=?`, ['AI古诗词创意营']);
  if (!series) {
    const seriesId = id('series');
    await aq(
      `INSERT INTO course_series(id,title,description,owner_type,visibility,version,sort,status,difficulty_level,age_range_min,age_range_max,tags,stock_total,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [seriesId, 'AI古诗词创意营', '5 课时古诗情景动画与创意表达课程', 'PLATFORM', 'PUBLIC', '1.0', 1, 'PUBLISHED', 3, 8, 16, JSON.stringify(['语文', '创意', '古诗词', '动画']), 30, now, now],
    );
    series = await arow('SELECT * FROM course_series WHERE id=?', [seriesId]);
  } else {
    // P5-W05: 补全新课程元数据字段
    await aq(`UPDATE course_series SET description=?,visibility='PUBLIC',status='PUBLISHED',difficulty_level=?,age_range_min=?,age_range_max=?,tags=?,updated_at=? WHERE id=?`, ['5 课时古诗情景动画与创意表达课程', 3, 8, 16, JSON.stringify(['语文', '创意', '古诗词', '动画']), now, series.id]);
    series = await arow('SELECT * FROM course_series WHERE id=?', [series.id]);
  }

  const lessons = [
    ['第1课：认识古诗与创作主题', '认识古诗意境，选择想要表达的诗词主题。', '本课时带领学生了解古诗词的意境美，初步感受古诗与创意表达的结合。学生将选择一个自己喜爱的诗词主题，为后续创作奠定基础。'],
    ['第2课：设计诗词主角与场景', '设计人物、动物或精灵主角，并规划故事发生的场景。', '在选定诗词主题后，学生学习如何设计故事中的主角（人物、动物或精灵），并根据诗词意境规划故事发生的场景。通过角色设定练习，培养学生的创意构思能力。'],
    ['第3课：生成画面与故事分镜', '把诗句转化为画面，完成故事分镜与画面提示词。', '学习如何将抽象的诗句转化为具体的画面，并完成故事分镜。本课时重点练习画面描述词的编写，为AI生成画面提供精准的提示词。'],
    ['第4课：编排动画与声音', '为画面安排动作、镜头和声音，让诗词故事动起来。', '在已完成的画面基础上，学习如何为诗词故事编排动画动作、镜头切换和声音效果。通过本课时的学习，学生将掌握简单的动画编排技巧。'],
    ['第5课：完成作品并展示', '完善创作、讲述设计思路并提交作品展示。', '最后一课时聚焦于作品的整体完善与展示。学生将完成整个诗词创意动画的制作，并准备一段简短的设计思路分享，为作品展示做好充分准备。'],
  ];
  const lessonRows = [];
  for (const [index, [title, summary, content]] of lessons.entries()) {
    const sort = index + 1;
    let lesson = await arow('SELECT * FROM course_lessons WHERE series_id=? AND sort=?', [series.id, sort]);
    if (!lesson) {
      const lessonId = id('lesson');
      await aq(
        `INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,lesson_content,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [lessonId, series.id, title, summary, sort, 'PUBLISHED', 45, content, now, now],
      );
      lesson = await arow('SELECT * FROM course_lessons WHERE id=?', [lessonId]);
    } else {
      await aq(`UPDATE course_lessons SET title=?,summary=?,status='PUBLISHED',duration_minutes=45,lesson_content=?,updated_at=? WHERE id=?`, [title, summary, content, now, lesson.id]);
      lesson = await arow('SELECT * FROM course_lessons WHERE id=?', [lesson.id]);
    }
    lessonRows.push(lesson);
  };
  return { series, lessons: lessonRows };
}

async function ensureClass({ orgId, teacherId, students, series, lessons }, now) {
  let klass = await arow(`SELECT * FROM classes WHERE org_id=? AND name=? AND status='ACTIVE'`, [orgId, '三年级AI创作一班']);
  if (!klass) {
    const classId = id('class');
    await aq(
      `INSERT INTO classes(id,org_id,name,teacher_id,usage_mode,default_series_id,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [classId, orgId, '三年级AI创作一班', teacherId, 'CLASS_ONLY', series.id, 'ACTIVE', now, now],
    );
    klass = await arow('SELECT * FROM classes WHERE id=?', [classId]);
  } else {
    await aq(`UPDATE classes SET teacher_id=?,usage_mode='CLASS_ONLY',default_series_id=?,updated_at=? WHERE id=?`, [teacherId, series.id, now, klass.id]);
    klass = await arow('SELECT * FROM classes WHERE id=?', [klass.id]);
  }

  const ensureMember = async (userId, role) => {
    const active = await arow(`SELECT id FROM class_members WHERE class_id=? AND user_id=? AND removed_at IS NULL`, [klass.id, userId]);
    if (!active) await aq(`INSERT INTO class_members(id,class_id,user_id,role,joined_at) VALUES (?,?,?,?,?)`, [id('member'), klass.id, userId, role, now]);
  };
  await ensureMember(teacherId, 'TEACHER');
  for (const student of students) { await ensureMember(student.id, 'STUDENT'); };

  for (const [index, lesson] of lessons.entries()) {
    const current = await arow(`SELECT id FROM class_curriculum_items WHERE class_id=? AND lesson_id=?`, [klass.id, lesson.id]);
    if (!current) {
      await aq(
        `INSERT INTO class_curriculum_items(id,class_id,lesson_id,sort,source_series_id,added_at)
         VALUES (?,?,?,?,?,?)`,
        [id('curriculum'), klass.id, lesson.id, index + 1, series.id, now],
      );
    }
  };
  // 2026-09-13（批次 B）记录一个**试过又回滚**的做法：曾在这里给第一个课时自动开一个「演示课堂」，
  // 好让演示账号一登录就能进课。但大量守卫依赖「初始状态干净」（断言开课前所有课时都是关的），
  // 种子一开课它们就集体变红 —— 所以种子只保留**结构性数据**（班级/课单/成员），
  // 「课堂」由用的人（或测试）按需创建。演示要进课，就让老师建一个课堂、把学生加进去。
  return klass;
}


export async function seedDatabase() {
  const now = nowIso();
  return await atransaction(async () => {
    await ensurePlatformSettings(now);
    await ensureWebsiteContent(now);
    await ensureUser({ login: 'root', displayName: '平台超管', role: 'SUPER_ADMIN', password: 'admin123' }, now);

    const organization = await ensureOrganization(now);
    const pkg = await ensurePackage(organization.id, now);
    await ensureUser({ login: 'org-admin', orgId: organization.id, displayName: '机构管理员', role: 'ORG_ADMIN', password: 'org123' }, now);
    const teacher1 = await ensureUser({ login: 'teacher-1', orgId: organization.id, displayName: '王老师', role: 'TEACHER', password: 'teach123', permissions: [] }, now);
    await ensureUser({ login: 'teacher-2', orgId: organization.id, displayName: '李老师', role: 'TEACHER', password: 'teach123', permissions: [] }, now);
    const student1 = await ensureUser({
      login: 'student-1', orgId: organization.id, displayName: '小明', role: 'STUDENT', password: 'study123',
      extras: { studentUsageScope: 'FOLLOW_CLASS', billingPackageId: pkg.id, monthlyCreditAllowance: 100, monthlyBonusCredits: 20, magicStones: 120 },
    }, now);
    const student2 = await ensureUser({
      login: 'student-2', orgId: organization.id, displayName: '小红', role: 'STUDENT', password: 'study123',
      extras: { studentUsageScope: 'HOME_PRACTICE', billingPackageId: pkg.id, monthlyCreditAllowance: 100, monthlyBonusCredits: 20, magicStones: 120 },
    }, now);

    const course = await ensureCourse(now);
    const assignment = await arow('SELECT id FROM course_assignments WHERE series_id=? AND org_id=?', [course.series.id, organization.id]);
    // 新演示授权显式给出有限额度；重复 seed 不重置现有额度或恢复已撤销许可。
    let assignmentId = assignment?.id || null;
    if (!assignment) {
      assignmentId = id('assignment');
      await aq(`INSERT INTO course_assignments(id,series_id,org_id,status,assigned_by,assigned_at,quota_total,quota_used)
         VALUES (?,?,?,?,?,?,?,?)`, [assignmentId, course.series.id, organization.id, 'ACTIVE', null, now, 30, 2]);
    }
    // ⭐ 2026-09-24：**许可也要补齐**，不能只在"没有授权单"时才发。
    //    为什么：`schema.js` 被 import 的时候会写一批默认行（含一条课包 + 一条授权单），而验收脚本的
    //    夹具现在走**数据层** —— 父进程哪怕只为拿连接也会先加载 schema.js，于是上面那条
    //    `if (!assignment)` 守卫直接跳过发许可 → 夹具拿到 0 条许可 → 表现成"数据不存在"
    //    （实测：p119 报"夹具没把任何学生放进课堂"、p52 报 403 NOT_IN_CLASSROOM）。
    //    补齐是**幂等**的（按 (student_id, series_id) 查一次），也不动任何已用额度、
    //    不恢复已撤销的许可 —— 与上面那条守卫的初衷不冲突。
    for (const student of [student1, student2]) {
      const granted = await arow(
        'SELECT id FROM student_course_grants WHERE student_id=? AND series_id=? AND revoked_at IS NULL',
        [student.id, course.series.id],
      );
      if (granted) continue;
      await aq(`INSERT INTO student_course_grants(id,org_id,student_id,series_id,source_assignment_id,granted_by,granted_at)
         VALUES (?,?,?,?,?,?,?)`, [id('coursegrant'), organization.id, student.id, course.series.id, assignmentId, null, now]);
    }
    await ensureClass({ orgId: organization.id, teacherId: teacher1.id, students: [student1, student2], ...course }, now);
    return { organizationId: organization.id, courseSeriesId: course.series.id };
  });
}

if (process.argv[1] && /seed\.js$/i.test(process.argv[1])) {
  await seedDatabase();
  console.log('Seed complete.');
}

// mysql 驱动下要显式关池才会退出（SQLite 不需要；见 mysql.js 的 closePool 注释）。
// ⚠️ **只能在本文件被当作入口运行时做**：这行是顶层代码，别人 `import` 它做夹具时也会执行 ——
//    那样会把调用方正在用的连接池提前关掉（实测表现：后续查询全报 "Pool is closed"，打挂 p4-o09）。
if (isMysql && process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await closePool();
