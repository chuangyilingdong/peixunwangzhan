#!/usr/bin/env node
/**
 * 把 **aimagc.cn 首页 `#works` 区那批静态 HTML 学员作品**导入我们的作品广场（2026-09-19）。
 *
 * 用户口径：「抓 `aimagc.cn/#works` 那批作品 —— 能抓吗？应该可以直接在我们网站打开吧？」
 * 结论：能抓，而且是**单文件静态 HTML**（托管在用户自己的域名 `works.aimagc.cn`，阿里云 OSS），
 * 整目录抓下来就能在我们站跑（还带一张现成的封面图，正好当广场卡片的封面）。
 *
 * ⚠️ 三条不许破的（见 `docs/operations/新对话交接-第二十轮-作品广场与导入-20260919.md` §五.A.1）：
 *
 *   ① **必须走沙箱，且绝不能带 `allow-same-origin`**：作品托管在 `/media/` 下，与主站**同源**
 *      （这和上一轮 ltai 那批"外链件"不一样）。看图层的 iframe 一旦带上 `allow-same-origin`，
 *      学生 HTML 就能读我们的 cookie / localStorage。
 *      同理**不提供**"在新窗口打开原文件"的出口：那等于把学生代码提到我们源上当顶层页面跑。
 *   ② **不带旧品牌**：源站属于「五格殿下 / Magic Academy」那套旧品牌，每件的 `<head>` 里都写着
 *      `AI魔法学院`（og:site_name / description）。官网守卫 p115 有一条反向断言
 *      （`RETIRED_COPY`）不许出现那个名字，入库前必须把 meta 换成我们的口径。
 *   ③ **依赖尽量自托管**：作品引了 unpkg / jsdelivr 的 three.js、cdnjs 的 p5、threejs.org 的行星贴图、
 *      wikimedia 的月球图，以及旧品牌域名下的一张背景图 —— 下到作品目录里并**改写引用**。
 *      理由有两条：项目本身就有「自托管、不把访客 IP/UA 带给外域」的口径（见 `apps/website/src/main.jsx`
 *      首页那段注释）；而且外链一断，这几件 3D/交互作品直接废掉。
 *
 *      ⚠️ 实测**这台服务器连不上 cdnjs 与 wikimedia**（unpkg / jsdelivr / threejs.org / 源站都通）：
 *        · cdnjs 的 p5 走 `MIRRORS` 换到 jsdelivr 的同一份文件 → 照样自托管；
 *        · wikimedia 那张月球图**没有镜像**，那就**保留原地址**（访客的浏览器连得上，
 *          作品照常显示），只在日志里报出来 —— 宁可留一条外链，也不改学生作品用的素材。
 *
 *      另一条同源的纪律：**只有全部 addon 都下成功，才改写 importmap 的 `three/addons/` 前缀**——
 *      改了前缀却没把文件下下来，作品会直接白屏（比留外链坏得多）。
 *
 * 为什么在**服务器上**跑：只有服务器能直连那个站（本机出网受限），媒体也直接落到对外目录。
 *
 * 入库形状与上一轮一致：一条 `works` + `student_projects` + 一个署名账号 + 一个机构；
 * 作品本体/封面/依赖放在 `MEDIA_ROOT/web-works/<uuid>/`，元数据塞进 `works.canvas_snapshot.imported`
 * —— 比上一轮多一个 **`entryUrl`**（作品入口页的站内地址），前端据此走"沙箱里跑网页"那条路。
 *
 * 幂等：文件在且非空就跳过下载、`INSERT OR IGNORE` 写库，可随时重跑。
 *
 * 跑法（服务器上）：
 *   node scripts/import-aimagc-webworks.mjs [--dry-run] [--skip-media]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_MEDIA = process.argv.includes('--skip-media');

const HOMEPAGE = 'https://aimagc.cn/';
const THREE_CDN = 'https://unpkg.com/three@0.160.0';
const DB_PATH = process.env.PLATFORM_DB_PATH || '/srv/ai-kids-platform/production/data/platform.db';
const MEDIA_ROOT = process.env.PLAZA_MEDIA_ROOT || '/srv/ai-kids-platform/public-media';
const MEDIA_URL = (process.env.PLAZA_MEDIA_URL || 'https://iicili.cyou/media').replace(/\/$/, '');
/** 旧品牌 → 我们的口径（只改 head 里的 meta 与 title，不动作品本体）。 */
const RETIRED_BRAND = /AI\s?魔法学院/g;
const OUR_BRAND = '灵动ai学院';
/** 留着不本地化的**运行时接口**：授时（作品自带 catch 回退）与字体（缺了只降级，不会"打不开"）。 */
const KEPT_HOSTS = /^https:\/\/(time\.akamai\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
/**
 * 镜像：这台机器连不上的主机，换成能连上的**同一份文件**。
 * 只放"文件内容确实一样"的映射，不做近似替换（不许悄悄换掉学生作品用的素材）。
 */
const MIRRORS = [
  [/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/p5\.js\/([\d.]+)\/p5\.min\.js$/, (m) => `https://cdn.jsdelivr.net/npm/p5@${m[1]}/lib/p5.min.js`],
];
const ORG_ID = 'org_webworks';
const ORG_NAME = '青藤少儿编程';
/** 这 9 件的署名（源站没公开作者名，是导入件的署名账号，登不进来）。 */
const AUTHORS = ['小宇', '朵朵', '阿哲', '晨曦', '乐乐', '小雨', '果果', '天天', '一诺'];

const log = (...rest) => console.log(...rest);
const short = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
const urlPattern = () => /https?:\/\/[^"'` )>\\]+/g;

/** 下载一个文件；已存在且非空就跳过。返回 'ok' | 'skip' | 'dry' | 'fail'（**不抛**）。 */
async function downloadTo(url, dest) {
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return 'skip';
  } catch { /* 当它不存在 */ }
  if (SKIP_MEDIA || DRY_RUN) return 'dry';
  let bytes;
  try {
    const response = await fetch(url, { headers: { accept: '*/*' } });
    if (!response.ok) { log(`    !! HTTP ${response.status}：${url.slice(0, 90)}`); return 'fail'; }
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // 网络层失败（连不上/超时）常发生在这台机器上 —— 算失败，交给上层决定是换镜像还是留外链
    log(`    !! 下载异常（${error?.cause?.code || error?.code || error.message}）：${url.slice(0, 90)}`);
    return 'fail';
  }
  // 空响应**算失败**（上一轮踩过：源站偶尔 200 + 0 字节，写下去就是一张裂图，脚本还以为下过了）
  if (bytes.length === 0) { log(`    !! 空内容：${url.slice(0, 90)}`); return 'fail'; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  return 'ok';
}

/** 先按原地址下，失败再试镜像。返回 { state, via }。 */
async function downloadWithMirror(url, dest) {
  const direct = await downloadTo(url, dest);
  if (direct !== 'fail') return { state: direct, via: null };
  for (const [pattern, build] of MIRRORS) {
    const match = pattern.exec(url);
    if (!match) continue;
    const mirror = build(match);
    log(`    · 原地址不通，换镜像重试：${mirror.slice(0, 90)}`);
    const state = await downloadTo(mirror, dest);
    if (state !== 'fail') return { state, via: mirror };
  }
  return { state: 'fail', via: null };
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { accept: 'text/html,*/*' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}：${url}`);
  return response.text();
}

/** 源站首页 `#works` 区 → [{ url, uuid, version, fileName, title }]。 */
async function listWorks() {
  const html = await fetchText(HOMEPAGE);
  const out = [];
  for (const chunk of html.match(/<a class="work-card"[\s\S]*?<\/a>/g) || []) {
    const href = /href="(https:\/\/works\.aimagc\.cn\/[^"]+)"/.exec(chunk);
    if (!href) continue;
    const url = href[1];
    const match = /\/public\/works\/([\w-]+)\/(v\d+)\/([\w.-]+\.html)$/.exec(url);
    if (!match) continue;
    // 卡片上的 iframe `title="点泡泡预览"` 才是给人看的名字；源站的 og:title 有两件直接是
    // 文件名（`snake` / `earth_3d`），所以**以卡片上的名字为准**，og:title 不参与定名。
    const titleAttr = /title="([^"]+)"/.exec(chunk);
    const title = titleAttr ? titleAttr[1].replace(/预览$/, '').trim() : '';
    out.push({ url, uuid: match[1], version: match[2], fileName: match[3], title });
  }
  return out;
}

/**
 * 要本地化的资源按 URL 的**路径尾巴**认（不认主机名）——同一份 three.js 在
 * unpkg 与 jsdelivr 上都出现过，认主机名就会漏掉一个。
 * 返回作品目录内的相对路径；null = 不本地化（运行时接口 / 认不出的）。
 */
function localPathFor(url) {
  const clean = url.split('?')[0];
  const base = path.basename(clean);
  if (clean.endsWith('/three@0.160.0/build/three.module.js')) return 'vendor/three.module.js';
  if (/\/p5(\.min)?\.js$/.test(clean)) return 'vendor/p5.min.js';
  if (/^https:\/\/threejs\.org\/examples\/textures\//.test(clean)) return `vendor/tex/${base}`;
  if (/^https:\/\/upload\.wikimedia\.org\//.test(clean)) return `vendor/tex/${base}`;
  // 旧品牌域名下的自有素材（背景图之类）→ 落 assets/
  if (/^https:\/\/works\.aimagc\.cn\/public\/users\//.test(clean)) return `assets/${base}`;
  return null;
}

/**
 * HTML 里的**相对**资源引用（`src=` / `href=` / CSS 的 `url()`）。
 * 跳过：绝对地址、协议相对、根相对、`data:`、`#`，以及任何带 scheme 的（`mailto:` 等）。
 * ⚠️ 只抓"HTML 里写出来的绝对地址"会漏东西：`单词小侦探` 的背景图和背景音乐就是这样漏掉的
 *    （`url('bg.jpg')` 与 `<source src="bgm.mp3">`）—— 广场上打开就是缺图 + 没声音。
 */
function relativeAssetPaths(html) {
  const found = new Set();
  const push = (raw) => {
    const value = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
    if (!value || value.startsWith('#') || value.startsWith('/')) return;   // 含 `//host`
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return;                          // http: data: mailto: …
    found.add(value.split('?')[0].split('#')[0]);
  };
  for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/g)) push(m[1]);
  for (const m of html.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) push(m[2]);
  return [...found];
}

/** 抓一件作品：下本体 + 封面 + 依赖，改写引用。返回落盘信息（单件失败由调用方兜住）。 */
async function fetchWork(work) {
  const dir = path.join(MEDIA_ROOT, 'web-works', work.uuid);
  const html = await fetchText(work.url);

  // 封面：源站每件都在 head 里带 og:image（`/public/works/covers/<id>/v<ver>/cover.<ext>`）
  const coverUrl = /og:image"\s+content="([^"]+)"/.exec(html)?.[1] || null;
  const coverExt = coverUrl ? (path.extname(coverUrl.split('?')[0]).toLowerCase() || '.png') : '.png';
  const coverFile = `cover${coverExt}`;
  let coverState = 'none';
  if (coverUrl) coverState = await downloadTo(coverUrl, path.join(dir, coverFile));

  // 依赖：HTML 里出现的**每一条**外域资源都下下来，然后把 URL 全量替换成相对路径。
  // ⚠️ 这里**不能**按「域名等于源站就跳过」来排除 —— 源站域名下除了封面，还有作品用到的
  //    自有素材（`/public/users/7/cloud/50/bg.jpg` 那张背景图）。只排除**封面**与**自身地址**
  //    这两条已知的，其余交给 `localPathFor` 判（它认路径尾巴，不认主机名）。
  const externals = [...new Set(html.match(urlPattern()) || [])]
    .filter((url) => url !== coverUrl && url !== work.url && !KEPT_HOSTS.test(url));

  const counts = { ok: 0, skip: 0, dry: 0, mirrored: 0, kept: 0, failed: 0 };
  const failedUrls = [];
  const replacements = [];
  const jsmPrefix = externals.find((url) => /three@0\.160\.0\/examples\/jsm\/$/.test(url)) || null;

  for (const url of externals) {
    if (url === jsmPrefix) continue;                  // 目录前缀，等 addon 下完再决定改不改
    const rel = localPathFor(url);
    if (!rel) { counts.kept += 1; continue; }
    const { state, via } = await downloadWithMirror(url, path.join(dir, rel.split('/').join(path.sep)));
    // 下不到就**保留原地址**（访客的浏览器连得上，作品照常跑）—— 绝不写一个空壳路径进去
    if (state === 'fail') { counts.failed += 1; failedUrls.push(url); continue; }
    counts[via ? 'mirrored' : state] += 1;
    replacements.push([url, `./${rel}`]);
  }

  // addon 是按裸名 `three/addons/...` 引的：先把文件补齐，**全成功才**改 importmap 前缀
  const addons = [...new Set([...html.matchAll(/from\s+['"](three\/addons\/[^'"]+)['"]/g)].map((m) => m[1]))];
  let addonsOk = true;
  for (const spec of addons) {
    const inner = spec.replace('three/addons/', '');
    const rel = `vendor/jsm/${inner}`;
    const state = await downloadTo(`${THREE_CDN}/examples/jsm/${inner}`, path.join(dir, rel.split('/').join(path.sep)));
    if (state === 'fail') { addonsOk = false; counts.failed += 1; failedUrls.push(`${THREE_CDN}/examples/jsm/${inner}`); continue; }
    counts[state] += 1;
  }
  if (jsmPrefix && addonsOk && addons.length) replacements.push([jsmPrefix, './vendor/jsm/']);
  if (jsmPrefix && !addonsOk) log('    !! 有 addon 没下到 —— 保留 importmap 的 CDN 前缀（改了会白屏）');

  // 相对引用：作品自有素材，按入口页地址解析后**下到同样的相对位置**（引用本身不用改）。
  // 只在作品自己的目录里取 —— 不许顺着 `../` 爬到站上别处去。
  const basePath = new URL(work.url).pathname.replace(/[^/]*$/, '');
  for (const rel of relativeAssetPaths(html)) {
    let target;
    try { target = new URL(rel, work.url); } catch { continue; }
    if (target.origin !== new URL(work.url).origin || !target.pathname.startsWith(basePath)) {
      log(`    · 跳过越界的相对引用：${rel}`);
      continue;
    }
    const localRel = decodeURIComponent(target.pathname.slice(basePath.length));
    const state = await downloadTo(target.href, path.join(dir, ...localRel.split('/')));
    if (state === 'fail') { counts.failed += 1; failedUrls.push(target.href); } else counts[state] += 1;
  }

  // 改写：依赖地址 → 本地；封面 → 站内绝对地址；og:url → 我们的地址；旧品牌 → 我们的口径
  let out = html;
  for (const [from, to] of replacements) out = out.split(from).join(to);
  const coverAt = coverUrl ? `${MEDIA_URL}/web-works/${work.uuid}/${coverFile}` : null;
  if (coverUrl) out = out.split(coverUrl).join(coverAt);
  out = out.replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${MEDIA_URL}/web-works/${work.uuid}/${work.fileName}" />`);
  out = out.replace(RETIRED_BRAND, OUR_BRAND);
  if (work.title) out = out.replace(/<title>[^<]*<\/title>/, `<title>${work.title}</title>`);

  const entryUrl = `${MEDIA_URL}/web-works/${work.uuid}/${work.fileName}`;
  if (!DRY_RUN && !SKIP_MEDIA) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, work.fileName), out);
  }

  // 自检：改完不许再有旧品牌名；外域引用只允许"运行时接口"与"确实下不到的"两类
  const brandLeft = (out.match(RETIRED_BRAND) || []).length;
  const dangling = [...new Set(out.match(urlPattern()) || [])]
    .filter((url) => !/iicili\.cyou/.test(url) && !KEPT_HOSTS.test(url) && !failedUrls.includes(url));
  return { dir, coverFile, coverAt, coverState, entryUrl, counts, failedUrls, brandLeft, dangling, addonsOk };
}

async function main() {
  log(`[导入] 数据库 ${DB_PATH}`);
  log(`[导入] 媒体目录 ${MEDIA_ROOT}${SKIP_MEDIA ? '（--skip-media：只写库）' : ''}${DRY_RUN ? '（--dry-run：不写任何东西）' : ''}`);
  log(` 拉取源站首页 ${HOMEPAGE} 的 #works 区…`);
  const works = await listWorks();
  log(`[导入] 找到 ${works.length} 件作品`);
  if (!works.length) throw new Error('一件都没解析到 —— 源站首页结构变了，别硬跑');

  const results = [];
  for (const [index, work] of works.entries()) {
    log(`  · [${index + 1}/${works.length}] ${work.title}（${work.uuid} ${work.version}/${work.fileName}）`);
    try {
      const info = await fetchWork(work);
      log(`      封面 ${info.coverState}；自托管 ok=${info.counts.ok} skip=${info.counts.skip} 镜像=${info.counts.mirrored}` +
          `；保留外链 ${info.counts.kept + info.counts.failed} 条${info.counts.failed ? `（其中 ${info.counts.failed} 条是这台机器下不到的）` : ''}` +
          `${info.brandLeft ? `；⚠️ 残留旧品牌 ${info.brandLeft} 处` : ''}` +
          `${info.dangling.length ? `；⚠️ 意外残留外域引用 ${info.dangling.join(' ')}` : ''}`);
      if (info.failedUrls.length) log(`      · 未自托管（访客浏览器会去原地址取）：${info.failedUrls.map((u) => u.split('/').pop()).join(', ')}`);
      results.push({ ...work, ...info });
    } catch (error) {
      // 单件失败不打断整轮：把剩下的抓完，失败的这一件不登记（下次重跑会补）
      log(`      !! 这一件抓失败，跳过：${error.message}`);
    }
  }
  log(`[导入] 成功 ${results.length}/${works.length} 件`);
  if (DRY_RUN) { log('[导入] dry-run 结束（没有写库、没有落文件）'); return; }
  if (!results.length) throw new Error('一件都没抓成 —— 别写库');

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 15000');
  const now = new Date().toISOString();

  db.prepare(`INSERT OR IGNORE INTO organizations
      (id,name,status,contract_start_at,contract_expires_at,is_trial,base_teacher_seats,purchased_teacher_seats,contact,created_at,updated_at)
      VALUES (?,?, 'ACTIVE', ?, ?, 1, 3, 0, '{}', ?, ?)`)
    .run(ORG_ID, ORG_NAME, now, '2030-01-01T00:00:00.000Z', now, now);

  const authors = new Map();
  results.forEach((item, index) => {
    const name = AUTHORS[index % AUTHORS.length];
    const userId = `user_webworks_${short(name)}`;
    // password_hash 是不可登录的占位（与上一轮导入件一致）：这些是**署名账号**，不是真人学生
    db.prepare(`INSERT OR IGNORE INTO users
        (id,org_id,login,display_name,role,permissions,password_hash,status,created_at,updated_at)
        VALUES (?,?,?,?, 'STUDENT', '[]', ?, 'ACTIVE', ?, ?)`)
      .run(userId, ORG_ID, `webworks_${short(name)}`, name, `imported-no-login:${short(name)}`, now, now);
    authors.set(item.uuid, { id: userId, name });
  });

  let written = 0;
  for (const [index, item] of results.entries()) {
    const author = authors.get(item.uuid);
    const workId = `work_webworks_${item.uuid.slice(0, 8)}`;
    const projectId = `project_webworks_${item.uuid.slice(0, 8)}`;
    const title = item.title || item.fileName.replace(/\.html$/, '') || `作品 ${item.uuid.slice(0, 8)}`;
    // 排在最近两周内、按顺序错开一天 —— 广场按 submitted_at 倒序，顺序才是稳定的
    const submittedAt = `2026-09-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`;

    db.prepare(`INSERT OR IGNORE INTO student_projects
        (id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at)
        VALUES (?,?,?,?, 'SUBMITTED', '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}', 1, ?, ?, ?)`)
      .run(projectId, author.id, ORG_ID, title, submittedAt, submittedAt, submittedAt);

    const snapshot = JSON.stringify({
      nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },   // 保持画布形状，别的读方不会炸
      imported: {
        source: 'webworks', sourceId: item.uuid, workType: 'webpage', workTypeLabel: '网页',
        coverUrl: item.coverAt, contentUrls: [], externalUrl: null,
        // ⭐ 唯一的新字段：作品入口页（站内地址）。前端据此在**沙箱**里跑它，而不是当外链跳出去。
        entryUrl: item.entryUrl,
        sourceUrl: item.url, authorName: author.name, createdAt: submittedAt,
      },
    });
    db.prepare(`INSERT OR IGNORE INTO works
        (id,project_id,student_id,org_id,title,description,canvas_snapshot,status,submitted_at,is_public,share_token,copyright_confirmed_at)
        VALUES (?,?,?,?,?, '', ?, 'PUBLISHED', ?, 1, ?, ?)`)
      .run(workId, projectId, author.id, ORG_ID, title, snapshot, submittedAt, `ww${item.uuid.replace(/-/g, '').slice(0, 12)}`, now);
    written += 1;
  }

  const total = db.prepare("SELECT COUNT(*) n FROM works WHERE id LIKE 'work_webworks_%'").get().n;
  const live = db.prepare(`SELECT COUNT(*) n FROM works WHERE id LIKE 'work_webworks_%'
      AND is_public=1 AND status='PUBLISHED' AND share_token IS NOT NULL AND copyright_confirmed_at IS NOT NULL`).get().n;
  db.close();
  log(`[导入] 完成：本轮写入 ${written} 条；库里累计 ${total} 条，其中**四样齐全能上广场的 ${live} 条**`);
  log(`[导入] 作品落盘：${path.join(MEDIA_ROOT, 'web-works')}`);
}

await main().catch((error) => { console.error('[导入] 失败：', error); process.exit(1); });
