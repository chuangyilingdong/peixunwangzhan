#!/usr/bin/env node
/**
 * 一次性数据迁移：把**会中和驱动音频**的 `audio_control` 从渠道/模型请求模板里去掉。
 *
 * 为什么需要它：2026-09-21 用户报「视频全能参考好像音频无法参考 —— 让他参考音频前 5 秒，
 * 结果做出来的视频跟音频完全不一样」。两处原因，这是**配置**那一处（另一处在代码里：
 * 音频要从 `reference_audio` 改成 `drive_audio`，见 modelCapabilities 的 referenceItems）：
 * `MiniMax-H3` 的模型模板里钉了 `"audio_control":{"mode":"native","add_drive_as_reference":false}`，
 * 而上游文档写的是 ——
 *   · `native`：生成原生音轨，**不锁**驱动音频；是否把驱动音频当声音参考由 `add_drive_as_reference` 决定；
 *   · `add_drive_as_reference` 在 native 下**默认 false**，显式 false 更是关掉。
 * 两条叠在一起 = 连过来的音频对产物**一点作用都没有**（画面不听它的、音轨也不是它）。
 *
 * 去掉之后由上游缺省规则接手（正是我们要的两种情形都对）：
 *   · 有驱动音频 → `lock_source`（画面跟着音频动，并把这条音频留在产物音轨里）；
 *   · 没有驱动音频 → `native`（生成原生音轨，与迁移前**行为一致**，不会把「带音频」的课弄哑）。
 *
 * 判据（改完怎么知道对不对）：跑 `deploy/production/live-audio-drive-check.mjs`，
 * 产物音轨与源音频的归一化互相关应该明显 > 0（迁移前实测 0.018，等于没用上）。
 *
 * 幂等：只处理"模板里带 `{{referenceItems}}`（能带参考素材）且 audio_control 会中和驱动音频"的模板；
 * 跑第二遍会报「无需改动」。
 *
 * 用法（在服务器上；**先 --dry-run 看清改什么**）：
 *   export PATH=/srv/ai-kids-platform/runtime/node/bin:$PATH
 *   node deploy/production/migrate-h3-audio-control-20260921.mjs --dry-run
 *   node deploy/production/migrate-h3-audio-control-20260921.mjs
 *   # 换库（副本上先试）：--db /tmp/platform.db
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] || fallback) : fallback;
}
const dbPath = path.resolve(arg('--db', process.env.PLATFORM_DB_PATH || '/srv/ai-kids-platform/production/data/platform.db'));
const dryRun = process.argv.includes('--dry-run');
if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);

/** 这条 audio_control 会不会把驱动音频中和掉？ */
function neutralizesDriveAudio(template) {
  const control = template?.audio_control;
  if (!control || typeof control !== 'object') return false;
  return String(control.mode || '').toLowerCase() === 'native' && control.add_drive_as_reference !== true;
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 8000');
const row = db.prepare('SELECT ai_provider_policy, updated_at FROM platform_settings WHERE id=1').get();
if (!row) throw new Error('platform_settings 里没有 id=1 这一行');
const policy = JSON.parse(row.ai_provider_policy || '{}');

// 逐模板盘点：只有"能带参考素材（模板里出现 {{referenceItems}}）"的才需要 audio_control 配合驱动音频 ——
// 不带参考的模板改了没意义，也不该动（模板越少动越好）。
const targets = [];
for (const channel of policy.channels || []) {
  for (const [modality, template] of Object.entries(channel.requestTemplates || {})) {
    if (!/\{\{referenceItems\}\}/.test(JSON.stringify(template || {}))) continue;
    if (!neutralizesDriveAudio(template)) continue;
    targets.push({ channel, bucket: channel.requestTemplates, key: modality, label: `渠道模板 requestTemplates.${modality}`, template });
  }
  for (const [model, template] of Object.entries(channel.modelRequestTemplates || {})) {
    if (!/\{\{referenceItems\}\}/.test(JSON.stringify(template || {}))) continue;
    if (!neutralizesDriveAudio(template)) continue;
    targets.push({ channel, bucket: channel.modelRequestTemplates, key: model, label: `模型模板 modelRequestTemplates.${model}`, template });
  }
}

console.log(`库：${dbPath}`);
console.log(`渠道数：${(policy.channels || []).length}，需要改的模板：${targets.length} 个`);
for (const target of targets) {
  console.log(`  · ${target.channel.id}（${target.channel.name || ''}）${target.label}`);
  console.log(`      改前：${JSON.stringify(target.template.audio_control)}`);
  console.log('      改后：（整键去掉，由上游缺省规则接手）');
}
if (!targets.length) { console.log('\n无需改动（没有会中和驱动音频的 audio_control）。'); process.exit(0); }
if (dryRun) { console.log('\n（--dry-run：什么都没写）'); process.exit(0); }

// 备份：整份策略先落盘一份，改坏了能对着回滚（生产库那一行是整套 AI 配置，不能只有"我记得原来是什么"）。
const backupDir = arg('--backup-dir', path.join(path.dirname(dbPath), 'backups'));
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15) + 'Z';
const backupFile = path.join(backupDir, `policy-before-h3-audio-control-${stamp}.json`);
fs.writeFileSync(backupFile, row.ai_provider_policy);

for (const target of targets) delete target.template.audio_control;
const after = JSON.stringify(policy);
db.prepare('UPDATE platform_settings SET ai_provider_policy=?, updated_at=? WHERE id=1')
  .run(after, new Date().toISOString());
// 与后台保存同一条账：`platform_config_change_logs`（config_type/record_id/field 与 billingConfig 路由一致），
// 这样在「计费与模型 → 变更记录」里能查到这次改动是谁、为什么。
db.prepare(`INSERT INTO platform_config_change_logs(
    id,config_type,record_id,field_name,old_value,new_value,changed_by,reason,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?)`)
  .run(`ccl_${randomUUID().replace(/-/g, '').slice(0, 20)}`, 'AI_PROVIDER_POLICY', '1', 'aiProviderPolicy',
    row.ai_provider_policy, after, 'migration:20260921',
    '去掉会中和驱动音频的 audio_control（用户 2026-09-21 报「全能参考的音频没被用上」；上游文档：native 模式不锁驱动音频、add_drive_as_reference 默认 false）',
    new Date().toISOString());
db.close();
console.log(`\n✅ 已改 ${targets.length} 个模板；改前整份策略备份在 ${backupFile}`);
console.log('   复核：跑 deploy/production/live-audio-drive-check.mjs（产物音轨与源音频应明显相关）；');
console.log('   或直接看后台「计费与模型」里该模型的请求模板 —— 已经没有 audio_control 这一项。');
