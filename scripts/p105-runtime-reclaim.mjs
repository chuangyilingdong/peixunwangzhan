// P105 课堂收尾要回收学生创作环境 —— 2026-09-16
//
// 背景：学生的创作环境（dsh）是**常驻进程**，生产实测 RSS 486MB（cgroup 峰值 643MB）。
// 这条链路以前完全没接线：`/api/student/runtime/stop` 存在、但**前端从来没调用过**，
// 服务端也没有任何定时任务 —— 于是「今天有多少学生上过课」变成「机器上挂着多少个 500MB」，
// 一台 1.6GB 的机器两个学生就满了。用户口径（2026-09-16）：要「AI 真替学生干活」，
// 那就必须让环境**短命**：占用只跟「这一刻真的在上课的课堂」有关。
//
// 这个守卫是**接线守卫**（读源码断言，不是跑行为）：它钉不住「收得对不对」，
// 但能钉住「有没有接上」—— 而这次的问题恰恰就是没接上。
// 真正跑行为的验证在真机（起课堂 → 结束课堂 → 环境消失）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'apps/server/src/routes/orgAdmin.js'), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ① 助手本身：按名单逐人收 + 动态 import + 逐人兜底 */
check('回收助手存在', /async function releaseSessionRuntimes\(/.test(source));
check('按课堂名单逐人收（用户版的用户名由「课堂+学生」推导，只给课堂算不出来）',
  /SELECT DISTINCT student_id FROM session_students WHERE session_id=\?/.test(source));
check('用动态 import 引 stopStudentRuntime（避免路线文件之间的静态环）',
  /await import\('\.\.\/services\/studentRuntime\.js'\)/.test(source));
check('逐人 try/catch —— 一个学生没收掉不能连累其它人',
  /for \(const studentId of studentIds\)[\s\S]{0,200}try \{[\s\S]{0,120}await stopStudentRuntime\(/.test(source));
check('读名单失败也兜住（不能因为读名单把老师的动作打断）',
  /收环境前读名单失败/.test(source));

/* ② 三条收尾路径都要接上（并且紧跟在各自的 audit 事件之后，别接到别的地方去了） */
const callSites = (source.match(/releaseSessionRuntimes\(/g) || []).length;
check('至少接到 3 条收尾路径（结束课堂 / 解散课堂 / 移出学生）', callSites >= 4, `实际 ${callSites} 处（含定义 1 处）`);
const wiredAfterAudit = (auditEvent, reason) => {
  const call = `releaseSessionRuntimes(target.id, '${reason}')`;
  const at = source.indexOf(call);
  if (at < 0) return false;
  const before = source.slice(Math.max(0, at - 400), at);
  return before.includes(`'${auditEvent}'`);
};
check('结束课堂接上了（紧跟 SESSION_END 审计）', wiredAfterAudit('SESSION_END', 'SESSION_END'));
check('解散课堂接上了（紧跟 SESSION_DISSOLVE 审计）', wiredAfterAudit('SESSION_DISSOLVE', 'SESSION_DISSOLVE'));
check('把学生移出名单接上了（紧跟 SESSION_STUDENT_REMOVE 审计）', wiredAfterAudit('SESSION_STUDENT_REMOVE', 'SESSION_STUDENT_REMOVE'));

/* ③ 三条路径都不能因为收环境而失败：调用点前面不能有 await（fire-and-forget） */
check('回收调用是 fire-and-forget（不能 await，否则老师的动作会被几十个学生的回收拖住）',
  !/await releaseSessionRuntimes\(/.test(source));

/* ④ 「开始上课」要预热环境：用户口径「无论什么时候都要秒进」——
      dsh 冷启动 17.9 秒改不了，能改的是**什么时候付**：老师点开始上课时就热起来，
      学生点进去走复用（0.07 秒）。 */
check('预热助手存在', /async function warmSessionRuntimes\(/.test(source));
check('开始上课接上了预热（紧跟 SESSION_START 审计）',
  /'SESSION_START'[\s\S]{0,500}warmSessionRuntimes\(target\.id, target\.lesson_id, target\.org_id\);/.test(source));
check('预热是 fire-and-forget（不能 await，否则老师点「开始上课」要等全班开完环境）',
  !/await warmSessionRuntimes\(/.test(source));
check('预热逐人兜底（容量不够/没许可的学生不能拖垮整轮预热）',
  /batch\.map\(\(studentId\) => launchStudentRuntime\([\s\S]{0,200}\.catch\(/.test(source)
  || /for \(const studentId of studentIds\)[\s\S]{0,200}try \{[\s\S]{0,120}await launchStudentRuntime\(/.test(source));
check('预热传了 orgId（launchStudentRuntime 的门禁要用它校验学生归属）',
  /launchStudentRuntime\(\{ sessionId, studentId, orgId, lessonId/.test(source));
check('预热是**有上限的并发**（串联太慢：30 个学生要 9 分钟；但不许一次性全开把宿主机打爆）',
  /WARM_CONCURRENCY = \d+/.test(source) && !/Promise\.all\(studentIds\.map/.test(source));

assert.ok(source.length > 0);

if (failures) { console.log(`\nP105 有 ${failures} 项未通过`); process.exitCode = 1; }
else console.log('P105 课堂收尾回收创作环境：助手按名单逐人收 + 三条路径都接上 + fire-and-forget 通过');
