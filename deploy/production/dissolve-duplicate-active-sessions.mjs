#!/usr/bin/env node
/**
 * 收口「一个学生同时挂在多个未终态课堂」的脏数据（2026-09-29 客户端契约第二版 待办 4）。
 *
 * 背景（两句话）：产品口径是**一个学生全局最多属于一个未终态课堂**（`docs/README.md`），
 * 加人 / 开课两条写路径都会拦（`IN_OTHER_SESSION` / `STUDENT_IN_OTHER_SESSION`，守卫 p66/p78/p62）——
 * **但库里不一定干净**：种子与历史数据绕过过校验。线上实测就有一个学生同时挂着两场 ACTIVE 课堂，
 * 后果是学生做 A 课作业、`client-context` 可能给他 B 课的**次数上限与预设**（界面上看不出来）。
 *
 * 这个脚本按**平台自己的判据**找出这类学生，并只做一件事：把多余的**成员关系**标成 `REMOVED`
 * （与后台「移除学生」同一条 SQL：`status='REMOVED' + removed_by/at/reason`，见
 * `services/classroomSessions.js` 的 removeStudent 那条）。**不删课堂、不动别班学生、不碰终态课堂。**
 *
 * ⚠️ 三条判据必须与产品一致（照抄，别自己发明）：
 *   ① 「占用」= `session_students.status IN ('PENDING','ACTIVE')` **且**
 *      `class_sessions.status IN ('PENDING','ACTIVE')` —— 这就是闸门 `activeParticipationFor()` 用的那条
 *      （**PENDING 也算占用**：名额已经被这学生占着了）；
 *   ② 保留哪一场：**先 ACTIVE 后 PENDING**（学生真正在上的那场优先），同状态里取
 *      **最近开始/创建的那一场**（与 `client-context` 的默认解析 `ORDER BY session.started_at DESC,
 *      session.created_at DESC` 同一个口径）；
 *   ③ 终态课堂（ENDED / DISSOLVED / 其它）一律不碰 —— 那是历史，不是占用。
 *
 * 用法（服务器上；先备份）：
 *   bash deploy/production/daily-backup.sh
 *   cd /srv/ai-kids-platform/source
 *   export PATH=/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin:$PATH
 *   set -a; . /etc/ai-kids-platform/production.env; set +a
 *   node deploy/production/dissolve-duplicate-active-sessions.mjs                    # 试运行（只读，列出计划）
 *   node deploy/production/dissolve-duplicate-active-sessions.mjs --student=<登录名>  # 只看/只清一个学生
 *   node deploy/production/dissolve-duplicate-active-sessions.mjs --apply            # 真改（逐条 REMOVED）
 *
 * 现场留痕：改动逐条打印，并写一份 JSON 到 `<production>/logs/dissolved-duplicate-sessions-<时间戳>.json`
 * （给人看的，不是备份）。回滚：把那些行的 `status` 改回 `ACTIVE`、清掉 `removed_*` 即可（脚本不删数据）。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const studentFilter = String(args.find((a) => a.startsWith('--student=')) || '').split('=')[1] || '';

const { arow, arows, aq } = await import('../../packages/database/src/store.js');

/** 占用规则（与 `activeParticipationFor` 逐字一致）—— PENDING 也算占用。 */
const OCCUPYING = "part.status IN ('PENDING','ACTIVE') AND session.status IN ('PENDING','ACTIVE')";

/**
 * 找出「占用了 >1 场未终态课堂」的学生。
 * ⚠️ 先按 `student_id` 分组拿到人，再逐人取明细 —— 一条 SQL 里既分组又取明细会被 MySQL 的
 * `ONLY_FULL_GROUP_BY` 挡（本地 SQLite 不报错，生产会 500，这套雷踩过多次）。
 */
async function findOffenders() {
  const having = studentFilter ? ' AND student.login = ?' : '';
  const params = studentFilter ? [studentFilter] : [];
  return await arows(
    `SELECT part.student_id, student.login, student.display_name, COUNT(*) AS n
       FROM session_students part
       JOIN class_sessions session ON session.id = part.session_id
       JOIN users student ON student.id = part.student_id
      WHERE ${OCCUPYING}${having}
      GROUP BY part.student_id, student.login, student.display_name
     HAVING COUNT(*) > 1
      ORDER BY n DESC, student.login`,
    params,
  );
}

/** 一个学生的全部占位（明细），按"保留哪一场"的顺序排好。 */
async function participationsOf(studentId) {
  return await arows(
    `SELECT part.id AS part_id, part.status AS part_status, part.added_at,
            session.id AS session_id, session.title AS session_title, session.status AS session_status,
            session.started_at, session.created_at,
            lesson.title AS lesson_title, teacher.display_name AS teacher_name
       FROM session_students part
       JOIN class_sessions session ON session.id = part.session_id
       LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
       LEFT JOIN users teacher ON teacher.id = session.teacher_id
      WHERE part.student_id = ? AND ${OCCUPYING}
      ORDER BY (session.status='ACTIVE') DESC, session.started_at DESC, session.created_at DESC, session.id DESC`,
    [studentId],
  );
}

const offenders = await findOffenders();
console.log(`[口径] 占用 = ${OCCUPYING}（PENDING 也算占用，照 activeParticipationFor）`);
console.log(`[扫描] ${offenders.length ? '' : '没有'}占用多场未终态课堂的学生：${offenders.length} 人`);
for (const row of offenders) console.log(`        · ${row.login}（${row.display_name || '—'}）占 ${row.n} 场`);

if (!offenders.length) {
  console.log('\n✓ 库是干净的：没有需要收口的学生。');
  process.exit(0);
}

const plan = [];
for (const offender of offenders) {
  const parts = await participationsOf(offender.student_id);
  const [keep, ...drop] = parts;
  console.log(`\n${offender.login}（${offender.display_name || '—'}）`);
  console.log(`  ✓ 保留：${keep.session_id} · ${keep.session_title || '未命名'} · ${keep.session_status}`
    + ` · ${keep.lesson_title || '未知课程'} · ${keep.teacher_name || '未知老师'} · 开始于 ${keep.started_at || keep.created_at || '—'}`);
  for (const item of drop) {
    console.log(`  ✗ 移除：${item.session_id} · ${item.session_title || '未命名'} · ${item.session_status}`
      + ` · ${item.lesson_title || '未知课程'} · ${item.teacher_name || '未知老师'}`);
  }
  plan.push({ studentId: offender.student_id, login: offender.login, keep, drop });
}

if (!apply) {
  console.log('\n（试运行：一个字节都没改。真要收口就加 --apply；建议先跑一次 deploy/production/daily-backup.sh）');
  process.exit(0);
}

const now = new Date().toISOString();
const done = [];
for (const item of plan) {
  for (const drop of item.drop) {
    // 与后台「移除学生」同一条 SQL（services/classroomSessions.js）：只标成员关系，不删行。
    await aq(
      "UPDATE session_students SET status='REMOVED', removed_by=?, removed_at=?, removed_reason=?, updated_at=? WHERE id=? AND status IN ('PENDING','ACTIVE')",
      [null, now, 'DUPLICATE_ACTIVE_CLASSROOM_CLEANUP', now, drop.part_id],
    );
    done.push({ studentId: item.studentId, login: item.login, partId: drop.part_id, sessionId: drop.session_id, sessionTitle: drop.session_title, removedAt: now });
  }
}

const root = process.env.PRODUCTION_ROOT || process.env.PLATFORM_DATA_DIR || process.cwd();
const logDir = path.join(root, 'logs');
try {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `dissolved-duplicate-sessions-${now.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: now, reason: 'DUPLICATE_ACTIVE_CLASSROOM_CLEANUP', plan, removed: done }, null, 2));
  console.log(`\n[留痕] 现场写到 ${file}`);
} catch (error) {
  console.log(`\n[留痕] 写日志失败（不影响数据）：${error.message}`);
}

// 收口后复查一遍：必须清零
const after = await findOffenders();
console.log(`[复查] 现在占用多场未终态课堂的学生：${after.length} 人 ${after.length ? '⚠️ 还有，请看上面的明细' : '✓'}`);
console.log(`\n✓ 收口完成：${done.length} 条成员关系标为 REMOVED（回滚就把这些行改回 ACTIVE 并清 removed_*）。`);
process.exitCode = after.length ? 1 : 0;
