#!/usr/bin/env node
/**
 * 把 **ltai.cc（用户自己的另一个站）作品广场**的作品导入我们的作品广场（2026-09-19）。
 *
 * 用户口径：「我们现在灵动作品的展示有问题，参考这个网站的展示来设计，并且把这个网站的作品
 * 提取出来到我们网站，并且能像他这样运行，名字和机构你可以随便想，这个网站也是我的，你随便扒」。
 *
 * 为什么在**服务器上**跑：① 只有服务器能直连那个站（本机出网受限）；
 * ② 媒体文件直接落到**对外目录**，不用先下到本机再传一遍。
 *
 * 数据源（公开接口，不需要登录）：
 *   GET https://ltai.cc/api/ke/creation/list?size=100&page=N&isMine=0
 *   → { id, title, author, type, imageUrl(封面), contentUrl(本体，逗号分隔), createTime }
 *
 * 导入规则：
 *   · 每个作品 → 一条 `works`（`is_public=1`、`status='PUBLISHED'`、带 `share_token` 与
 *     `copyright_confirmed_at` —— 这三样是公开作品广场那条查询的硬条件，缺一个就不显示）；
 *   · 作者 → 造一个学生账号（按作者名去重，54 个）；机构 → 造一个「灵涛AI课」；
 *     作品 × 作者之间靠 `student_projects`（`works.project_id` 有唯一索引，一件作品一个项目）；
 *   · **封面与本体**：`f.ltai.cc` 上的真文件下到 `MEDIA_ROOT/ltai-works/<id>/`，
 *     元数据（类型/封面/本体地址/原站链接/日期）写进 `works.canvas_snapshot`（那是 NOT NULL 列，
 *     本来就是放作品内容的，导入件用它存元数据）；外链作品的 `contentUrl` 指向别的平台
 *     （豆包/灵光/扣子/千问…），**不下也不改**，存进 `externalUrl`，由前端「在原平台打开」。
 *
 * 幂等：重复跑只补缺失（`INSERT OR IGNORE` + 文件存在就跳过下载），可以随时重跑。
 *
 * 跑法（服务器上）：
 *   node scripts/import-plaza-works.mjs [--limit 50] [--skip-media] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const LIMIT = Number(arg('--limit', 0)) || 0;          // 0 = 全部
const SKIP_MEDIA = process.argv.includes('--skip-media');
const DRY_RUN = process.argv.includes('--dry-run');

const SOURCE_API = 'https://ltai.cc/api/ke/creation/list';
const DB_PATH = process.env.PLATFORM_DB_PATH || '/srv/ai-kids-platform/production/data/platform.db';
const MEDIA_ROOT = process.env.PLAZA_MEDIA_ROOT || '/srv/ai-kids-platform/public-media';
const MEDIA_URL = (process.env.PLAZA_MEDIA_URL || 'https://iicili.cyou/media').replace(/\/$/, '');
const ORG_ID = 'org_ltai_import';
const ORG_NAME = '灵涛AI课';
/** 单文件下载上限：他的视频里最大的几十 MB，超过这个数就只留外链（避免一个坏文件拖死整轮）。 */
const MAX_FILE_BYTES = Number(process.env.PLAZA_MAX_FILE_BYTES || 120 * 1024 * 1024);

/** 他的类型 → 我们广场上显示的名字（顺序就是筛选栏的顺序）。 */
const TYPE_LABEL = {
  image: '图片', video: '视频', webpage: '网页', miniGame: '小游戏', ppt: 'PPT',
  brandDesign: '品牌设计', music: '音乐', podcast: 'AI播客', agent: '智能体',
  workflow: '工作流', pictureBook: '绘本',
};

const log = (...rest) => console.log(...rest);
const isSourceFile = (url) => /^https:\/\/f\.ltai\.cc\//.test(url);

function slug(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}
function safeExt(url) {
  const clean = url.split('?')[0];
  const ext = path.extname(clean).toLowerCase();
  return /^\.[a-z0-9]{2,5}$/.test(ext) ? ext : '.bin';
}
/** 学生账号的登录名：作者名可能是中文/空格/符号，登录名要稳定且唯一 —— 用哈希兜底。 */
function loginFor(author) {
  return `ltai_${slug(author)}`;
}

async function fetchList() {
  const all = [];
  for (let page = 1; page <= 60; page += 1) {
    const response = await fetch(`${SOURCE_API}?size=100&page=${page}&isMine=0`, {
      headers: { accept: 'application/json', referer: 'https://ltai.cc/works-square' },
    });
    if (!response.ok) throw new Error(`第 ${page} 页取失败：HTTP ${response.status}`);
    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    all.push(...rows);
    log(`  第 ${page} 页：${rows.length} 条（累计 ${all.length}）`);
    if (rows.length < 100) break;
  }
  return LIMIT ? all.slice(0, LIMIT) : all;
}

/** 下载一个文件（已存在且非空就跳过）。返回相对媒体根的路径，失败返回 null。 */
async function download(url, destDir, fileName) {
  const dest = path.join(destDir, fileName);
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return path.relative(MEDIA_ROOT, dest);
  } catch { /* 当它不存在 */ }
  if (SKIP_MEDIA || DRY_RUN) return null;
  const response = await fetch(url, { headers: { referer: 'https://ltai.cc/works-square' } });
  if (!response.ok) { log(`    !! 下载失败 HTTP ${response.status}：${url.slice(0, 80)}`); return null; }
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_FILE_BYTES) { log(`    !! 太大（${(length / 1024 / 1024).toFixed(1)}MB），只留外链：${url.slice(-40)}`); return null; }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) { log('    !! 实际大小超限，丢弃'); return null; }
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, bytes);
  return path.relative(MEDIA_ROOT, dest);
}

const mediaUrlOf = (relative) => (relative ? `${MEDIA_URL}/${relative.split(path.sep).join('/')}` : null);

async function main() {
  log(`[导入] 数据库 ${DB_PATH}`);
  log(`[导入] 媒体目录 ${MEDIA_ROOT}${SKIP_MEDIA ? '（--skip-media：只写库）' : ''}${DRY_RUN ? '（--dry-run）' : ''}`);
  log(' 拉取源站作品列表…');
  const works = await fetchList();
  log(`[导入] 共 ${works.length} 件`);

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 15000');
  const now = new Date().toISOString();

  // 机构（一个）：导入件挂在它下面，广场详情页会显示机构名
  // ⚠️ --dry-run 时连机构/账号也不写：干跑就应该是只读的（否则"试一下"会留下一堆占位账号）
  if (!DRY_RUN) db.prepare(`INSERT OR IGNORE INTO organizations
      (id,name,status,contract_start_at,contract_expires_at,is_trial,base_teacher_seats,purchased_teacher_seats,contact,created_at,updated_at)
      VALUES (?,?, 'ACTIVE', ?, ?, 1, 3, 0, '{}', ?, ?)`)
    .run(ORG_ID, ORG_NAME, now, '2030-01-01T00:00:00.000Z', now, now);

  const authors = new Map();
  for (const work of works) {
    const author = String(work.author || '').trim() || '匿名创作者';
    if (!authors.has(author)) authors.set(author, `user_ltai_${slug(author)}`);
  }
  for (const [author, id] of authors) {
    // password_hash 放一个不可登录的占位：这些是**导入作品的署名账号**，
    // 不是真人学生（没有密码，也进不了任何入口）。
    if (DRY_RUN) break;
    db.prepare(`INSERT OR IGNORE INTO users
        (id,org_id,login,display_name,role,permissions,password_hash,status,created_at,updated_at)
        VALUES (?,?,?,?, 'STUDENT', '[]', ?, 'ACTIVE', ?, ?)`)
      .run(id, ORG_ID, loginFor(author), author, `imported-no-login:${slug(author)}`, now, now);
  }
  log(`[导入] 机构 1 个、署名账号 ${authors.size} 个`);

  let created = 0; let mediaOk = 0; let mediaFail = 0; let external = 0;
  for (const [index, work] of works.entries()) {
    const sourceId = String(work.id);
    const author = String(work.author || '').trim() || '匿名创作者';
    const studentId = authors.get(author);
    const workId = `work_ltai_${sourceId}`;
    const projectId = `project_ltai_${sourceId}`;
    const title = String(work.title || '').trim().slice(0, 120) || `作品 ${sourceId}`;
    const workType = String(work.type || '').trim() || 'image';
    const submittedAt = String(work.createTime || now).replace(' ', 'T') + (String(work.createTime || '').includes('Z') ? '' : '.000Z');

    const dir = path.join(MEDIA_ROOT, 'ltai-works', sourceId);
    const coverRelative = work.imageUrl ? await download(String(work.imageUrl), dir, `cover${safeExt(String(work.imageUrl))}`) : null;
    if (coverRelative) mediaOk += 1; else mediaFail += 1;

    // 本体：真文件下下来；外链原样留着（前端「在原平台打开」）
    const contentUrls = [];
    let externalUrl = null;
    for (const [fileIndex, raw] of String(work.contentUrl || '').split(',').map((item) => item.trim()).filter(Boolean).entries()) {
      if (isSourceFile(raw)) {
        const relative = await download(raw, dir, `content-${fileIndex + 1}${safeExt(raw)}`);
        if (relative) { contentUrls.push(mediaUrlOf(relative)); mediaOk += 1; } else { mediaFail += 1; }
      } else if (!externalUrl) {
        externalUrl = raw;
        external += 1;
      }
    }

    if (DRY_RUN) { if (index < 3) log(`  · 样例：${title} / ${author} / ${workType} / 封面 ${coverRelative || '（没下）'}`); continue; }

    db.prepare(`INSERT OR IGNORE INTO student_projects
        (id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at)
        VALUES (?,?,?,?, 'SUBMITTED', '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}', 1, ?, ?, ?)`)
      .run(projectId, studentId, ORG_ID, title, submittedAt, submittedAt, submittedAt);

    const snapshot = JSON.stringify({
      nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },   // 保持画布形状，别的读方不会炸
      imported: { source: 'ltai', sourceId: Number(work.id), workType, workTypeLabel: TYPE_LABEL[workType] || workType,
        coverUrl: mediaUrlOf(coverRelative), contentUrls, externalUrl, authorName: author, createdAt: work.createTime || null },
    });
    db.prepare(`INSERT OR IGNORE INTO works
        (id,project_id,student_id,org_id,title,description,canvas_snapshot,status,submitted_at,is_public,share_token,copyright_confirmed_at)
        VALUES (?,?,?,?,?, '', ?, 'PUBLISHED', ?, 1, ?, ?)`)
      .run(workId, projectId, studentId, ORG_ID, title, snapshot, submittedAt, `ltai${sourceId}${slug(title).slice(0, 6)}`, now);
    created += 1;
    if ((index + 1) % 50 === 0) log(`  … 已处理 ${index + 1}/${works.length}（媒体成功 ${mediaOk} / 失败 ${mediaFail}）`);
  }

  const total = db.prepare("SELECT COUNT(*) n FROM works WHERE id LIKE 'work_ltai_%'").get().n;
  db.close();
  log(`[导入] 完成：本轮写入 ${created} 条，库里累计导入件 ${total}`);
  log(`[导入] 媒体：成功 ${mediaOk} 个、失败 ${mediaFail} 个；外链作品 ${external} 件`);
}

await main().catch((error) => { console.error('[导入] 失败：', error); process.exit(1); });
