/**
 * P159 恢复演练必须能演「线上真正在用的那个库」（2026-09-27）。
 *
 * 起因：`restore-drill.sh` 原来是**深度绑定 SQLite** 的 —— 要 `platform.db`、
 * 要 `PRAGMA integrity_check`、还把临时服务指到那个数据目录。生产 2026-09-25 切到 RDS(MySQL) 之后：
 *
 *   · 它要么在门口就退 2（"Backup incomplete"：找不到 platform.db），
 *   · 要么"成功"地演练一个**早就不用了的库** —— 两种都是**没有演练**。
 *   · 实测证据：这台机上的 `/srv/ai-kids-platform/production/restore-drills/` **一直是空的**
 *     （从来没有过一次演练结果）。
 *
 * ⚠️ 而"备份能不能恢复"这件事**只看文件在不在是看不见的**：§44.2 那份转储
 *    （mysqldump 退出码 0 / gzip 完好 / sha256 对得上）**两张表根本建不起来**，
 *    得真灌进一个 MySQL 才知道。所以这条只能钉成**静态守卫** —— 演练要 MySQL、要一次性的演练库，
 *    放不进常规验收套件（MySQL 侧那套也一样：它建的是测试库，不是"从备份恢复"）。
 *
 * 这个守卫钉的是"脚本里那些**只有出过事才知道要写**的规矩"，尤其是：
 *   ① 驱动跟着 MANIFEST 走，且与线上配置**一致性校验**（§44.1「绿灯骗人的备份」的回归网）
 *   ② 演练**绝不动生产库**（目标库名比对两个来源 + 临时服务把两个库名变量都改掉）
 *   ③ 灌库的判据是「恢复出来的表数 == 转储里的表数」，不是 mysqldump 的退出码
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

const src = read('deploy/production/restore-drill.sh');

console.log('① 认驱动（而不是写死 SQLite）');
{
  check('从 MANIFEST 读 driver / databaseFile（单一出处）',
    /manifest_get "\$\{BACKUP\}\/MANIFEST\.json" driver/.test(src)
    && /manifest_get "\$\{BACKUP\}\/MANIFEST\.json" databaseFile/.test(src));
  check('⭐ 不再硬写 platform.db（"找不到 platform.db 就退 2" 就是演练断掉的形状）',
    !/! -f "\$\{BACKUP\}\/platform\.db"/.test(src) && !/sha256sum "\$\{BACKUP\}\/platform\.db"/.test(src));
  check('老备份没有 driver 字段时只兜到 sqlite（那之前的备份只可能是 sqlite）',
    /db_file="platform\.db"/.test(src) && /driver="sqlite"/.test(src));
  check('两个分支都在，未知驱动直接失败（不许"看不懂就放过"）',
    /sqlite\) run_sqlite_drill/.test(src) && /mysql\)\s+prepare_mysql_client; run_mysql_drill/.test(src)
    && /MANIFEST 里的驱动不认识/.test(src));
  check('sqlite 分支仍做 PRAGMA integrity_check（老路不许退化）', /pragma integrity_check/.test(src));

  console.log('   —— ② 驱动一致性：备的必须是"线上在用的那个库"');
  check('⭐ MANIFEST 的 driver 与线上配置的 DB_DRIVER 不一致就退 2（§44.1 那场事故的回归网）',
    /declared_driver="\$\{DB_DRIVER:-/.test(src) && /"\$driver" != "\$declared_driver"/.test(src)
    && /绿灯骗人的备份/.test(src));
  check('线上驱动从 production.env 读（定时器/手工跑都不一定有环境变量）',
    /env_file_value "\$PRODUCTION_ENV_FILE" DB_DRIVER/.test(src)
    && /PRODUCTION_ENV_FILE:-/i.test(src));
}

console.log('③ mysql 分支：绝不能碰到生产库');
{
  check('目标库名只允许字母数字下划线', /TARGET_DB_SAFE_RE='\^\[A-Za-z0-9_\]\+\$'/.test(src));
  check('⭐ 目标库名 = 生产库名 → 拒绝执行（exit 4，不是"演练失败"）',
    /refuse "演练库名（\$\{TARGET_DB\}）就是生产库名/.test(src));
  check('⭐ 生产库名要比对**两个来源**：跑脚本的环境 + 备份自己的 MANIFEST',
    /PROD_DB="\$\{MYSQL_DATABASE:-/.test(src) && /prod_db_from_manifest="\$\{url##\*\/\}"/.test(src)
    && /等于备份 MANIFEST 里记的生产库名/.test(src));
  check('aild_admin 再硬拦一次（写死的兜底）', /TARGET_DB" != "aild_admin"/.test(src));
  check('目标库不是空的、又没给 --clean → 退 3（**不动别人的库**）',
    /\(\( CLEAN == 1 \)\) \|\| not_run "演练库 \$\{TARGET_DB\} 不是空的/.test(src));
  check('--clean 只 DROP TABLE（外键先关），不是 DROP DATABASE',
    /SET FOREIGN_KEY_CHECKS=0/.test(src) && /DROP TABLE IF EXISTS /.test(src));

  const dropDb = src.split('\n').filter((line) => /DROP DATABASE/.test(line));
  check('全脚本只有一处 DROP DATABASE，且只针对演练库',
    dropDb.length === 1 && dropDb[0].includes('${TARGET_DB}'), dropDb.join(' | '));
  check('清理只在"真的动过演练库"时发生（没动过就不动）',
    /drill_db_touched == 1/.test(src) && /drill_db_touched=1/.test(src));

  console.log('   —— 临时服务：库指针必须改到演练库');
  check('⭐ MYSQL_DATABASE 与 RDS_DATABASE **两个都**改成演练库（只改一个的话，应用优先读另一个就是打到生产）',
    /"MYSQL_DATABASE=\$TARGET_DB"\s+"RDS_DATABASE=\$TARGET_DB"/.test(src));
  check('⭐ 临时服务必须 unset PLATFORM_DB_PATH（生产 env 里它指着那份 SQLite）',
    /unset PLATFORM_DB_PATH/.test(src));
  check('临时服务的库连接沿用生产那套变量名（MYSQL_*/RDS_*），驱动钉成 mysql',
    /export DB_DRIVER=mysql/.test(src) && /PLATFORM_DATA_DIR=\$data_dir/.test(src));
}

console.log('④ 灌库的判据：表数，不是退出码');
{
  check('⭐ 恢复出来的表数与 MANIFEST.tableCount.inDump 比（44.2 那种"退出码 0 但表没建起来"只能这么抓）',
    /tableCount\.inDump/.test(src) && /restored_tables" != "\$in_dump"/.test(src));
  check('对不上时把**缺哪几张表**列出来（comm 转储的表名 vs 恢复出来的表名）',
    /comm -23/.test(src) && /dump-tables\.txt/.test(src) && /restored-tables\.txt/.test(src));
  check('转储自己就少/多建表语句时，说法改口成"备份文件本身不完整"（不是"建失败"）',
    /dump_declared/.test(src) && /备份文件本身不完整/.test(src));
  check('备份文件本身的 sha256 也要与 MANIFEST 对得上（bit rot / 半份文件）',
    /dump_sha=/.test(src) && /备份文件 SHA256 与 MANIFEST 对不上/.test(src));
  check('权限类报错分诊成"环境缺口"（exit 3），别让人去追一个不存在的备份问题',
    /ERROR \(1044\|1045\|1142\|1227\)/.test(src) && /权限不够，灌不进去/.test(src));
}

console.log('⑤ 凭据不上命令行');
{
  check('优先 --defaults-file（默认 /root/.my.cnf）', /--defaults-file=/.test(src) && /\/root\/\.my\.cnf/.test(src));
  check('退回环境变量时口令走 MYSQL_PWD（不是 argv）',
    /MYSQL_PWD="\$\{CLIENT_PASSWORD\}"/.test(src) && !/-p\$/.test(src) && !/'-p'/.test(src));
}

console.log('⑥ 退出码契约：三种"没通过"要分得开');
{
  check('头部写清了 0/2/3/4 的含义',
    /0 演练通过/.test(src) && /2 演练失败/.test(src) && /3 环境缺口/.test(src) && /4 拒绝执行/.test(src));
  check('演练失败 → 2', /fail\(\) \{[\s\S]{0,400}?exit 2/.test(src));
  check('环境缺口 → 3', /not_run\(\) \{[\s\S]{0,400}?exit 3/.test(src));
  check('危险配置 → 4', /refuse\(\) \{[\s\S]{0,400}?exit 4/.test(src));
  check('失败/没跑都留下一行 RESULT.txt（"什么都没写"是最难查的那种）',
    /write_result "failed"/.test(src) && /write_result "not_run"/.test(src) && /restore_drill=%s/.test(src));
}

console.log('⑦ 开发机也能演（本机没有 mysql 客户端）');
{
  check('给了 docker 那条路', /PRODUCTION_RESTORE_DRILL_MYSQL_DOCKER/.test(src) && /docker exec -i/.test(src));
  check('客户端地址与 app 地址分开给（容器内 3306 vs 宿主映射端口）',
    /PRODUCTION_RESTORE_DRILL_CLIENT_HOST/.test(src) && /PRODUCTION_RESTORE_DRILL_CLIENT_PORT/.test(src));
  check('SQLite 老路也保留了 --release 之外的原行为（临时服务 port 隔离 + 端口兜底清理）',
    /PRODUCTION_RESTORE_DRILL_PORT/.test(src) && /sport = :\$\{PORT\}/.test(src));
}

if (failures) {
  console.error(JSON.stringify({ name: 'p159-restore-drill-driver', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p159-restore-drill-driver', pass: true }, null, 1));
