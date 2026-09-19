#!/usr/bin/env node
/**
 * 把导入作品的机构名从「灵涛AI课」换成若干**随机起的少儿编程机构名**（2026-09-19）。
 *
 * 用户口径：「图1 所有的灵涛AI课换成随机的少儿编程机构名字」。
 * 做法：**按作者分配**（一个作者属于一个机构，他的作品就属于那个机构）——
 * 比"一件作品一个机构"更像真的（同一个学生的作品不会跨机构），也顺带让账号与作品一致。
 *
 * 跑法（服务器上）：node scripts/randomize-import-orgs.mjs [--orgs 8] [--seed 20260919] [--dry-run]
 */
import { DatabaseSync } from 'node:sqlite';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const ORG_COUNT = Math.max(2, Number(arg('--orgs', 8)) || 8);
const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = process.env.PLATFORM_DB_PATH || '/srv/ai-kids-platform/production/data/platform.db';
const SOURCE_ORG_ID = 'org_ltai_import';

/** 随机起的机构名：都是**编的**，不带任何真实品牌（用户允许"名字随便想"）。 */
const CANDIDATES = [
  '星芽少儿编程', '小海豚编程学院', '木马工坊编程', '银河少年创客中心',
  '蜂巢少儿AI课堂', '蓝鲸编程实验室', '松鼠编程学堂', '光点少年编程',
  '麦田少儿科创', '牛顿小镇编程', '云雀AI创意学院', '小满少儿编程',
];

/** 固定种子的伪随机：重跑结果一致（不然每次跑机构归属都变，验收没法对）。 */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const random = makeRandom(Number(arg('--seed', 20260919)) || 20260919);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 15000');
const now = new Date().toISOString();

const picks = [...CANDIDATES].sort(() => random() - 0.5).slice(0, ORG_COUNT);
console.log(`[机构] 用 ${picks.length} 个机构：${picks.join(' / ')}`);

// ① 机构行：第一个复用原来那条（改名），其余新建
picks.forEach((name, index) => {
  const id = index === 0 ? SOURCE_ORG_ID : `org_plaza_${index + 1}`;
  if (DRY_RUN) { console.log(`  （dry-run）机构 ${id} → ${name}`); return; }
  const exists = db.prepare('SELECT id FROM organizations WHERE id=?').get(id);
  if (exists) db.prepare('UPDATE organizations SET name=?, updated_at=? WHERE id=?').run(name, now, id);
  else db.prepare(`INSERT INTO organizations
      (id,name,status,contract_start_at,contract_expires_at,is_trial,base_teacher_seats,purchased_teacher_seats,contact,created_by,created_at,updated_at)
      VALUES (?,?, 'ACTIVE', ?, '2030-01-01T00:00:00.000Z', 1, 3, 0, '{}', NULL, ?, ?)`)
    .run(id, name, now, now, now);
});

// ② 按作者分配（每位作者一个机构，作品跟着作者走）
const authors = db.prepare("SELECT id, display_name FROM users WHERE login LIKE 'ltai_%'").all();
const assignment = new Map();
authors.forEach((author) => {
  const orgId = picks.length === 1 ? SOURCE_ORG_ID : (() => {
    const index = Math.floor(random() * picks.length);
    return index === 0 ? SOURCE_ORG_ID : `org_plaza_${index + 1}`;
  })();
  assignment.set(author.id, orgId);
});
console.log(`[机构] 作者 ${authors.length} 位 → 机构归属：${JSON.stringify([...new Set(assignment.values())].map((id) => picks[id === SOURCE_ORG_ID ? 0 : Number(String(id).replace('org_plaza_', '')) - 1]))}`);

if (!DRY_RUN) {
  for (const [userId, orgId] of assignment) {
    db.prepare('UPDATE users SET org_id=?, updated_at=? WHERE id=?').run(orgId, now, userId);
    db.prepare("UPDATE student_projects SET org_id=?, updated_at=? WHERE student_id=? AND id LIKE 'project_ltai_%'").run(orgId, now, userId);
    db.prepare("UPDATE works SET org_id=? WHERE student_id=? AND id LIKE 'work_ltai_%'").run(orgId, userId);
  }
}

// ③ 核对：不该再有「灵涛AI课」这个名字
const left = db.prepare("SELECT COUNT(*) n FROM organizations WHERE name LIKE '%灵涛%'").get().n;
const dist = db.prepare(`SELECT organization.name AS name, COUNT(*) n FROM works work
    JOIN organizations organization ON organization.id = work.org_id
   WHERE work.id LIKE 'work_ltai_%' GROUP BY organization.name ORDER BY n DESC`).all();
console.log(`[机构] 名字里还有「灵涛」的机构：${left} 个`);
console.log('[机构] 作品按机构的分布：');
for (const item of dist) console.log(`  ${item.name} · ${item.n} 件`);
db.close();
