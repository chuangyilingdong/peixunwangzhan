/**
 * P157 备份必须认驱动（2026-09-27「绿灯骗人的备份」那一轮）。
 *
 * 起因是两条实测发现，都不是推测：
 *
 *   ① **切库到 RDS 之后，每晚的备份其实一直在备那份切库时冻结的 SQLite。**
 *      链路 `daily-backup.sh` → `backup-production.sh` → `backup-production.mjs` 里，
 *      最后那个只 `import { DatabaseSync } from 'node:sqlite'`、用 `VACUUM INTO` —— 完全不认 `DB_DRIVER`。
 *      于是备份目录一天天涨、`state/last-backup-state.json` 一天天写 `state:"ok"`，
 *      而**切库后写进 RDS 的数据一份备份都没有**（实测：备份产物里 `max(users.created_at)`
 *      = 2026-09-25T03:46Z，早于切库时刻 05:01Z）。SHA256 与 integrity_check 全绿 —— 因为那确实是
 *      一份**完好但过期**的 SQLite：绿灯骗人，监控看不出来。
 *      ⚠️ 而且那条 systemd 定时器**没有 `EnvironmentFile`**，环境里根本没有 `DB_DRIVER` ——
 *      所以修法必须是"脚本自己去读 production.env"，不能指望"改一下 systemd 就有了"。
 *
 *   ② **那份转储其实恢复不了。** 09-25 的「444 列拉齐 MEDIUMTEXT」把 `course_series.title` 与
 *      `organizations.org_code` 变成了 MEDIUMTEXT，而 `13-partial-indexes-mysql.sql` 里这两条
 *      函数索引**直接返回裸列** → MySQL 拒绝在返回 TEXT/BLOB 的表达式上建索引（ERROR 3757）。
 *      线上没事（索引当初按 VARCHAR 建的，MySQL 不回头校验），但**按转储重建就炸**：
 *      实测灌进 MySQL 8.0.46，`course_series` / `organizations` 两张表建不起来 + 各 4 条 ERROR 1146。
 *      ⇒ **只看"备份文件生成了没有"完全看不见这个。**
 *      修法与文件里既有的手法一致（同文件里 7 条 CONCAT 早就包了 MD5，就是为躲这条）：
 *      把这两条的**结果**也包上 MD5。
 *
 * 这个守卫是**静态**的（不需要 MySQL、不需要 Chrome）—— 因为本地测试库根本不建这些函数索引
 * （12 号生成器把带 WHERE 的部分索引剥离、交人工处理，13 号只手工跑在生产上），
 * 所以 SQLite/MySQL 两套验收套件**永远看不见**这一类雷。只能靠这里钉住。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();

console.log('① backup-production.mjs 必须认驱动（而不是写死 SQLite）');
{
  const source = read('deploy/production/backup-production.mjs');
  check('会去读 production.env（定时器没有 EnvironmentFile，只能脚本自己读）',
    /PRODUCTION_ENV_FILE/.test(source) && /\/etc\/ai-kids-platform\/production\.env/.test(source));
  check('按 --driver > DB_DRIVER > env 文件的顺序解析', /envFileValue\(envFile, 'DB_DRIVER'\)/.test(source));
  check('⭐ 解析不出来就**报错**，不默认 sqlite（默认值 = 那次静默故障会原样重演）',
    /解析不出 DB_DRIVER/.test(source) && !/\|\|\s*'sqlite'/.test(source));
  check('参数名是 --production-env（`--env-file` 是 Node 自己的标志，会被 node 抢走、脚本根本起不来）',
    /arg\('--production-env'/.test(source) && !/arg\('--env-file'/.test(source));

  console.log('   —— mysql 分支的口径');
  for (const flag of ['--single-transaction', '--set-gtid-purged=OFF', '--no-tablespaces', '--hex-blob']) {
    check(`mysqldump 带 ${flag}`, source.includes(flag));
  }
  check('⭐ 口令不上命令行（会进 ps）：走 MYSQL_PWD，且 argv 里没有 -p 口令',
    /MYSQL_PWD/.test(source) && !/'-p'/.test(source) && !/`-p\$\{/.test(source));
  check('优先 --defaults-file（/root/.my.cnf 约定）', /--defaults-file=/.test(source) && /\/root\/\.my\.cnf/.test(source));
  check('⭐ 转储要与线上对账（只信 mysqldump 的退出码会漏掉截断的转储）',
    /tableCount/.test(source) && /inDump/.test(source) && /inDatabase/.test(source));
  check('半份转储不许留下（它会骗过"文件在不在"的检查）', /fs\.rmSync\(target/.test(source));
  check('mysqldump 起不来时给人话，不是 node 栈', /起不了 mysqldump/.test(source));
}

console.log('② daily-backup.sh 的完整性检查必须跟着驱动走');
{
  const source = read('deploy/production/daily-backup.sh');
  check('驱动与库文件名从 MANIFEST 读（单一出处）',
    /m\.driver/.test(source) && /m\.databaseFile/.test(source));
  check('⭐ 不再硬写 platform.db（那就是"每晚认证一份冻结的旧库"的根源）',
    !/! -f "\$\{backup_dir\}\/platform\.db"/.test(source) && !/sha256sum "\$\{backup_dir\}\/platform\.db"/.test(source));
  check('sqlite 分支仍做 PRAGMA integrity_check', /pragma integrity_check/.test(source));
  check('mysql 分支做 gzip 完整性校验', /gzip -t "\$\{backup_dir\}\/\$\{db_file\}"/.test(source));
  check('未知驱动直接报错（不许"看不懂就放过"）', /Unknown driver in manifest/.test(source));
  check('state 文件里记下 driver（下次一眼能看出备的是哪个库）', /databaseFile:dbFile/.test(source) && /\{state:'ok'/.test(source));
}

console.log('③ 建表侧：函数索引的表达式不能返回裸 TEXT/BLOB 列');
{
  const partial = read('deploy/production/migrate/13-partial-indexes-mysql.sql');
  const fix = read('deploy/production/migrate/19-fix-text-functional-indexes.sql');
  const expressionFor = (text, indexName) => {
    const match = new RegExp(`(?:CREATE|ADD)\\s+UNIQUE\\s+INDEX\\s+\`?${indexName}\`?`, 'i').exec(text);
    if (!match) return null;
    const open = text.indexOf('((', match.index);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') { depth -= 1; if (depth === 0) return text.slice(open, i + 1); }
    }
    return null;
  };

  check('文件头把这条规矩写全了（不只 CONCAT —— 任何返回裸 TEXT/BLOB 列的表达式都不行）',
    /任何\*\*返回裸 TEXT\/BLOB 列\*\*/.test(partial) && /ERROR 3757/.test(partial));

  for (const [indexName, column] of [
    ['idx_course_series_platform_title', 'title'],
    ['idx_organizations_org_code', 'org_code'],
  ]) {
    const expression = expressionFor(partial, indexName);
    check(`${indexName} 存在且表达式包了 MD5`,
      Boolean(expression) && new RegExp(`md5\\(\`${column}\`\\)`, 'i').test(expression),
      String(expression));
    check(`${indexName} 不再出现"裸列当结果"的写法（这就是 ERROR 3757 的来源）`,
      Boolean(expression) && !new RegExp(`[,(]\\s*\`${column}\`\\s*,`, 'i').test(expression)
        && !new RegExp(`,\\s*\`${column}\`\\s*\\)`, 'i').test(expression),
      String(expression));
  }

  // 生产侧那条一次性迁移（19 号）与源头的 13 号必须逐字同源 —— 否则"以后重建又变回坏的"。
  for (const indexName of ['idx_course_series_platform_title', 'idx_organizations_org_code']) {
    const a = expressionFor(partial, indexName);
    const b = expressionFor(fix, indexName);
    check(`13 号与 19 号的 ${indexName} 定义逐字一致（防漂移）`,
      Boolean(a) && norm(a).toLowerCase() === norm(b).toLowerCase(), `${norm(a)} vs ${norm(b)}`);
  }
  check('19 号带着"先查重复值"的前置检查（有重复值的话重建唯一索引会失败）',
    /重复组数/.test(fix) && /HAVING COUNT\(\*\) > 1/.test(fix));
  check('19 号把 DROP 与 ADD 放在同一条 ALTER 里（不留"约束暂时不在"的窗口）',
    /DROP INDEX[\s\S]{0,200}ADD UNIQUE INDEX/.test(fix));
}

if (failures) {
  console.error(JSON.stringify({ name: 'p157-rds-backup-driver', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p157-rds-backup-driver', pass: true }, null, 1));
