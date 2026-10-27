#!/usr/bin/env node
/**
 * 把官网「课堂作品」用的 6 件**官方示例网页作品**登记进作品广场（2026-10-27）。
 *
 * 这些作品是单文件 HTML（CSS/JS 全内联），托管在我们自己的 `/media/web-works/<slug>/` 下：
 *   · 入口页 `index.html` 由前端在**不带 allow-same-origin 的沙箱 iframe** 里整屏运行；
 *   · `cover.jpg` 是 1440×810 的真实首屏截图，广场卡片直接用它当封面；
 *   · 元数据塞进 `works.canvas_snapshot.imported`（与 `scripts/import-aimagc-webworks.mjs`
 *     同一套形状，前端 `publicWorkRow()` 原样吐出）。
 *
 * 幂等：按固定 id（`work_showcase_<slug>` / `project_showcase_<slug>`）先查后写；
 * 改标题、改截图后直接重跑即可覆盖，不会产生重复作品。
 *
 * 前置：文件已经在服务器上（本脚本**不**负责上传）：
 *   /srv/ai-kids-platform/public-media/web-works/<slug>/{index.html,cover.jpg}
 *
 * 跑法（生产机、仓库源码树里）：
 *   set -a; . /etc/ai-kids-platform/production.env; set +a
 *   node scripts/import-showcase-webworks.mjs --dry-run
 *   node scripts/import-showcase-webworks.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { aq, arow, closePool } from '../packages/database/src/store.js';

const DRY_RUN = process.argv.includes('--dry-run');
const MEDIA_ROOT = process.env.PLAZA_MEDIA_ROOT || '/srv/ai-kids-platform/public-media';
const MEDIA_URL = (process.env.PLAZA_MEDIA_URL
  || `${process.env.PUBLIC_SITE_URL || 'https://aicyld.com'}/media`).replace(/\/$/, '');

const ORG_ID = 'org_showcase';
const ORG_NAME = '灵动ai学院';
const ORG_CODE = 'ORG9001';
const USER_ID = 'user_showcase_official';
const USER_LOGIN = 'showcase_official';
const AUTHOR = '官方课堂';

/**
 * 顺序 = 广场上的顺序（`submitted_at` 依次递减 1 分钟，最新的排最前）。
 * `workType` 决定角标与分类（webpage/miniGame 都归 VibeCoding 分类，见 services/plazaCategories.js）。
 */
const WORKS = [
  {
    slug: 'travel-english-helper',
    title: '旅行英语应急助手',
    description: '输入英文自动纠错、按场景推荐句型，还能常速/慢速跟读——出门在外也能开口说。',
    workType: 'webpage',
  },
  {
    slug: 'ai-english-tutor',
    title: '我的 AI 英语私教',
    description: '选一个主题和 AI 外教聊天，点对话里的任意单词就能看中文释义，附语法纠正。',
    workType: 'webpage',
  },
  {
    slug: 'anime-dimension-museum',
    title: '动漫次元博物馆',
    description: '动漫主题的互动博物馆：角色档案、名场面与彩蛋，点开就能在馆里逛。',
    workType: 'webpage',
  },
  {
    slug: 'misty-forest-adventure',
    title: '迷雾森林 · 文字冒险',
    description: '选择驱动的文字冒险：五条路线、五种结局，收集到的结局会记在浏览器里。',
    workType: 'miniGame',
  },
  {
    slug: 'guess-the-number',
    title: '猜数字小游戏',
    description: '1~100 猜数字，实时提示范围与次数，适合课间来一局。',
    workType: 'miniGame',
  },
  {
    slug: 'class-homepage',
    title: '南街小学三年级2班 · 班级主页',
    description: '公告、相册、成员、学习园地、活动记录与留言板一应俱全的班级主页模板。',
    workType: 'webpage',
  },
];

const log = (...args) => console.log('[showcase]', ...args);

function checkMedia() {
  let ok = true;
  for (const work of WORKS) {
    for (const file of ['index.html', 'cover.jpg']) {
      const target = path.join(MEDIA_ROOT, 'web-works', work.slug, file);
      const exists = fs.existsSync(target) && fs.statSync(target).size > 0;
      log(`  ${exists ? '✓' : '✗'} ${path.relative(MEDIA_ROOT, target)}${exists ? `（${fs.statSync(target).size} 字节）` : ' —— 缺失或为空'}`);
      if (!exists) ok = false;
    }
  }
  if (!ok) throw new Error('媒体文件不齐，先上传再跑这个脚本');
}

async function ensureOrg(now) {
  const existing = await arow('SELECT id FROM organizations WHERE id=? OR name=? LIMIT 1', [ORG_ID, ORG_NAME]);
  if (existing) return existing.id;
  if (DRY_RUN) return ORG_ID;
  await aq(
    `INSERT INTO organizations
       (id,name,org_code,status,contract_start_at,contract_expires_at,is_trial,base_teacher_seats,purchased_teacher_seats,contact,created_at,updated_at)
     VALUES (?,?,?, 'ACTIVE', ?, '2030-01-01T00:00:00.000Z', 1, 3, 0, '{}', ?, ?)`,
    [ORG_ID, ORG_NAME, ORG_CODE, now, now, now],
  );
  return ORG_ID;
}

async function ensureAuthor(orgId, now) {
  const existing = await arow('SELECT id FROM users WHERE id=? OR login=? LIMIT 1', [USER_ID, USER_LOGIN]);
  if (existing) return existing.id;
  if (DRY_RUN) return USER_ID;
  // password_hash 是不可登录的占位：这是**署名账号**，不是真人学生（与 aimagc 那批导入件一致）。
  await aq(
    `INSERT INTO users
       (id,org_id,login,display_name,role,permissions,password_hash,status,created_at,updated_at)
     VALUES (?,?,?,?, 'STUDENT', '[]', ?, 'ACTIVE', ?, ?)`,
    [USER_ID, orgId, USER_LOGIN, AUTHOR, `imported-no-login:${USER_LOGIN}`, now, now],
  );
  return USER_ID;
}

async function main() {
  log(`媒体根目录 ${MEDIA_ROOT}`);
  log(`媒体地址前缀 ${MEDIA_URL}`);
  if (DRY_RUN) log('dry-run：只检查、不写库');
  checkMedia();

  const now = new Date().toISOString();
  const orgId = await ensureOrg(now);
  const userId = await ensureAuthor(orgId, now);
  log(`机构 ${orgId} / 作者 ${userId}（${AUTHOR}）`);

  let written = 0;
  for (const [index, work] of WORKS.entries()) {
    const submittedAt = new Date(Date.now() - index * 60_000).toISOString();
    const workId = `work_showcase_${work.slug}`;
    const projectId = `project_showcase_${work.slug}`;
    const shareToken = `scw-${work.slug}`;
    const snapshot = JSON.stringify({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      imported: {
        source: 'showcase',
        sourceId: work.slug,
        workType: work.workType,
        workTypeLabel: work.workType === 'miniGame' ? '小游戏' : '网页',
        coverUrl: `${MEDIA_URL}/web-works/${work.slug}/cover.jpg`,
        contentUrls: [],
        externalUrl: null,
        entryUrl: `${MEDIA_URL}/web-works/${work.slug}/index.html`,
        sourceUrl: null,
        authorName: AUTHOR,
        createdAt: submittedAt,
      },
    });

    const existingProject = await arow('SELECT id FROM student_projects WHERE id=?', [projectId]);
    if (!existingProject) {
      if (!DRY_RUN) {
        await aq(
          `INSERT INTO student_projects
             (id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at)
           VALUES (?,?,?,?, 'SUBMITTED', ?, 1, ?, ?, ?)`,
          [projectId, userId, orgId, work.title, JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), submittedAt, submittedAt, submittedAt],
        );
      }
    } else if (!DRY_RUN) {
      await aq('UPDATE student_projects SET title=?, org_id=?, student_id=?, updated_at=? WHERE id=?', [work.title, orgId, userId, submittedAt, projectId]);
    }

    const existingWork = await arow('SELECT id FROM works WHERE id=?', [workId]);
    if (existingWork) {
      if (!DRY_RUN) {
        await aq(
          `UPDATE works SET project_id=?, student_id=?, org_id=?, title=?, description=?, canvas_snapshot=?,
             status='PUBLISHED', submitted_at=?, is_public=1, share_token=?, copyright_confirmed_at=?,
             unpublish_reason=NULL, unpublished_at=NULL
           WHERE id=?`,
          [projectId, userId, orgId, work.title, work.description, snapshot, submittedAt, shareToken, now, workId],
        );
      }
      log(`  ↻ ${work.title}`);
    } else {
      if (!DRY_RUN) {
        await aq(
          `INSERT INTO works
             (id,project_id,student_id,org_id,title,description,canvas_snapshot,status,submitted_at,is_public,share_token,copyright_confirmed_at)
           VALUES (?,?,?,?,?,?,?, 'PUBLISHED', ?, 1, ?, ?)`,
          [workId, projectId, userId, orgId, work.title, work.description, snapshot, submittedAt, shareToken, now],
        );
      }
      log(`  + ${work.title}`);
    }
    written += 1;
  }

  const total = (await arow("SELECT COUNT(*) n FROM works WHERE id LIKE 'work_showcase_%'"))?.n ?? 0;
  log(`${DRY_RUN ? '将写入' : '已处理'} ${written} 件；库里累计 ${total} 件 showcase 作品`);
  log(`广场地址：${process.env.PUBLIC_SITE_URL || 'https://aicyld.com'}/works`);
}

try {
  await main();
} catch (error) {
  console.error('[showcase] 失败：', error);
  process.exitCode = 1;
} finally {
  // MySQL 连接池会一直握着事件循环；不关的话脚本跑完不退出（只能等 ssh 超时）。
  await closePool().catch(() => {});
}
