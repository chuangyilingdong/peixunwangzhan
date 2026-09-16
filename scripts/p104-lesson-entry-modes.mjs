// P104 学生入口按「课时已发布的类型」放行 —— 2026-09-16 口径变更
//
// 变更前：一个课堂（class_sessions.delivery_mode）只有一种入口，学生能不能用画布 / VibeCoding
// 由**课堂那个单值**决定。老师创建课堂时要自己挑一个 —— 但上课类型明明是**平台**在课包课时里
// 设定的，而且平台端课时配置的原文写的是「两种都开：学生在这节课可以选『画布创作』或
// 『VibeCoding』进入」。也就是说：课时能开两种，课堂的单值却把其中一种废掉了。
//
// 变更后（用户 2026-09-16 口径）：入口只看**课时已发布的 deliveryModes**，
// 课堂的 delivery_mode 退化成历史兼容值（仍会写、仍下发，但没有门禁作用）。
//
// 这个守卫直接把规则钉在 lessonAvailability 上（纯函数，不起服务、不读库），
// 因为它是**唯一**决定「学生看到哪个入口、点了会不会被拒」的地方。
// 特别注意最后两组反例：只开一种时，另一种必须**锁死** —— 别把「放行两种」做成「什么都放行」。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p104-entry-modes-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AUTH_PEPPER = process.env.AUTH_PEPPER || 'p104-pepper';

const { lessonAvailability } = await import(pathToFileURL(path.join(root, 'apps/server/src/services/studentContext.js')).href);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

// 学生已在名单里、课堂正在进行 —— 这是「许可 + 名单 + 课堂进行中」三样都满足的状态，
// 差别只剩「课时开哪种入口」。
const live = (sessionMode) => ({
  status: 'ACTIVE',
  session_status: 'ACTIVE',
  session_delivery_mode: sessionMode,
});
const lesson = (modes, legacy = modes[0]) => ({ deliveryMode: legacy, deliveryModes: modes });
const avail = (modes, sessionMode) => lessonAvailability({
  lesson: lesson(modes),
  hasGrant: true,
  participation: live(sessionMode),
});

/* ① 两种都开 → 两个入口都放行（这正是本次变更的目的） */
const dualCanvasSession = avail(['CANVAS', 'VIBECODING'], 'CANVAS');
check('两种都开 + 画布课堂：画布入口亮', dualCanvasSession.canStart === true);
check('两种都开 + 画布课堂：VibeCoding 入口也亮（变更前是灭的）', dualCanvasSession.canStartVibeCoding === true);
const dualVibeSession = avail(['CANVAS', 'VIBECODING'], 'VIBECODING');
check('两种都开 + VibeCoding 课堂：两个入口都亮（与课堂那个单值无关）',
  dualVibeSession.canStart === true && dualVibeSession.canStartVibeCoding === true);

/* ② 反例：只开一种时，另一种必须锁死 */
const onlyCanvas = avail(['CANVAS'], 'CANVAS');
check('只开画布：画布入口亮', onlyCanvas.canStart === true);
check('只开画布：VibeCoding 入口锁死', onlyCanvas.canStartVibeCoding === false);
const onlyVibe = avail(['VIBECODING'], 'VIBECODING');
check('只开 VibeCoding：VibeCoding 入口亮', onlyVibe.canStartVibeCoding === true);
check('只开 VibeCoding：画布入口锁死', onlyVibe.canStart === false);
check('只开 VibeCoding（但课堂单值写成 CANVAS 的脏数据）：仍然只放 VibeCoding',
  avail(['VIBECODING'], 'CANVAS').canStart === false && avail(['VIBECODING'], 'CANVAS').canStartVibeCoding === true);

/* ③ 老数据：没有 deliveryModes 数组时回退到单值 deliveryMode */
const legacy = lessonAvailability({
  lesson: { deliveryMode: 'VIBECODING' },
  hasGrant: true,
  participation: live('VIBECODING'),
});
check('老数据（无 deliveryModes）：按单值回退，VibeCoding 亮、画布灭',
  legacy.canStartVibeCoding === true && legacy.canStart === false);

/* ④ 前面几道闸门仍然优先：没许可 / 不在名单 / 课堂没开始 → 两个入口都不亮 */
const noGrant = lessonAvailability({ lesson: lesson(['CANVAS', 'VIBECODING']), hasGrant: false, participation: live('CANVAS') });
check('没许可：两个入口都不亮', noGrant.canStart === false && noGrant.canStartVibeCoding === false);
const pending = lessonAvailability({
  lesson: lesson(['CANVAS', 'VIBECODING']),
  hasGrant: true,
  participation: { status: 'PENDING', session_status: 'PENDING', session_delivery_mode: 'CANVAS' },
});
check('课堂还没开始：两种都开的课时也不放行', pending.canStart === false && pending.canStartVibeCoding === false);

assert.ok(typeof lessonAvailability === 'function');
// 临时目录不主动删：Windows 上库文件还被进程占着，rmSync 会 EPERM（别的守卫也不删）。

if (failures) { console.log(`\nP104 有 ${failures} 项未通过`); process.exitCode = 1; }
else console.log('P104 学生入口按课时已发布类型放行：两种都开都亮、只开一种另一种锁死、老数据回退、前三道闸门优先 通过');
