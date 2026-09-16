// 「从一个学生的创作环境里取回产物」——走查/导出/留存三件事的实现在这里。
//
// 为什么单独一个文件：宿主侧那几个 .sh 是**给 sudoers 白名单**用的入口，
// 而这一层要做的事（递归走查、路径越界判定、按引用收集同目录素材、把二进制编成 base64）
// 用 bash 写会又长又容易出错。.sh 只负责「解析参数 + 身份与工作区的守卫」，然后调这里。
//
// 产物在哪（2026-09-16 真机核实，而不是按文档推的）：
//   · 学生的工作区 = /home/<runtime>/workspace，dsh 的 <base href="/"> 之外就这一个落点；
//   · dsh 自己的 PPT 插件（dsh-ppt）做完一份演示文稿时，走 publishWorkspaceOutput()
//     在**工作区里**建一个以标题命名的目录（第 2 版起是 <标题>-r2），里面既有 PPTD 工程
//     文件，也有**成品 .pptx** —— 所以「枚举工作区」对网页与 PPT 都成立；
//   · 会话日志里的 deliverables/presented 事件只记**路径**、不复制内容，而且依赖模型
//     记得调用 present 工具，所以这里**不拿它当唯一真相**（它顶多当「推荐」用）。
//
// 安全边界（这条链路是 root 在跑，取回的东西最终会给学生下载，所以每一步都要卡）：
//   ① 只允许工作区**内部**的普通文件：realpath 后必须落在工作区里（挡住 ../../etc/shadow）；
//   ② 拒收符号链接本身（lstat 判定）—— realpath 会把链接解开，只看它会被指出去；
//   ③ 只认白名单扩展名（学生能提交的就那四种），其余一律不当产物；
//   ④ 单文件与总量都有上限，超了就**报出来**（skipped/warnings），不悄悄少给。
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ENTRY_EXTENSIONS = new Set(['.html', '.htm', '.pptx', '.docx', '.xlsx']);
// 能当「素材」被主产物引用的扩展名（HTML 引用的本地图）。白名单而不是黑名单：
// 学生的作品可以是任何东西，但**我们取回来的东西**必须是能安全落库/落盘的。
const ASSET_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.webm', '.txt', '.md', '.csv',
]);
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.cache', 'dist', 'build', 'tmp']);
const MAX_DEPTH = 6;
const MAX_FILES_SCANNED = 20000;

// 上限：一节课的作品不该有这么大；超了说明学生把数据集也放进来了，那不是作品。
// 与平台侧 vibecoding 的既有口径（单产物 256KB 文本）不同 —— 这里允许二进制，
// 所以是「单文件 24MB / 一次导出 48MB」这种量级。
const MAX_FILE_BYTES = Number(process.env.COLLECT_MAX_FILE_BYTES || 24 * 1024 * 1024);
const MAX_TOTAL_BYTES = Number(process.env.COLLECT_MAX_TOTAL_BYTES || 48 * 1024 * 1024);

function fail(message, code = 'COLLECT_FAILED') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function kindForName(name) {
  const extension = path.extname(name).toLowerCase();
  if (extension === '.htm') return 'html';
  return extension.replace(/^\./, '') || 'text';
}

/** 工作区的真实路径（跟着符号链接走一次），后面所有越界判定都以它为准。 */
function workspaceRealPath(workspace) {
  if (!path.isAbsolute(workspace)) fail('工作区必须是绝对路径', 'COLLECT_BAD_WORKSPACE');
  if (!existsSync(workspace)) fail(`工作区不存在：${workspace}`, 'COLLECT_NO_WORKSPACE');
  return realpathSync(workspace);
}

/**
 * 把一个「工作区相对路径」解析成可安全读取的绝对路径。
 * 这是整条链路唯一接受外部输入（平台传来的产物名）的地方，所以判定要严：
 * 逐段拒绝 `..`、拒收符号链接、realpath 后必须仍在工作区内。
 */
function resolveInside(root, relative) {
  const raw = String(relative || '').trim();
  if (!raw) fail('产物名不能为空', 'COLLECT_BAD_NAME');
  if (path.isAbsolute(raw)) fail(`产物名不能是绝对路径：${raw}`, 'COLLECT_BAD_NAME');
  const segments = raw.split(/[\\/]+/).filter((segment) => segment && segment !== '.');
  if (!segments.length || segments.some((segment) => segment === '..')) fail(`产物名不合法：${raw}`, 'COLLECT_BAD_NAME');
  const absolute = path.join(root, ...segments);
  const info = lstatSync(absolute, { throwIfNoEntry: false });
  if (!info) fail(`产物不在工作区里：${raw}`, 'COLLECT_NOT_FOUND');
  if (info.isSymbolicLink()) fail(`产物是符号链接，不收：${raw}`, 'COLLECT_SYMLINK');
  if (!info.isFile()) fail(`产物不是普通文件：${raw}`, 'COLLECT_NOT_FILE');
  const real = realpathSync(absolute);
  if (!isInside(root, real)) fail(`产物越出工作区：${raw}`, 'COLLECT_ESCAPE');
  return { absolute: real, relative: segments.join('/'), bytes: info.size };
}

/** 走查工作区，找出「可以直接交给平台当作品」的文件（主产物）。 */
function scanEntries(root) {
  const found = [];
  const skipped = [];
  let scanned = 0;
  let truncated = false;

  const walk = (directory, depth) => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // 读不动的目录直接跳过（权限/竞态），不为它中断整次走查
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith('.')) continue;
      if (scanned++ > MAX_FILES_SCANNED) { truncated = true; return; }
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { skipped.push({ name: path.relative(root, absolute), reason: 'SYMLINK' }); continue; }
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!ENTRY_EXTENSIONS.has(extension)) continue;
      if (entry.name.endsWith('.tmp')) continue;
      let info;
      try { info = statSync(absolute); } catch { continue; }
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (info.size > MAX_FILE_BYTES) {
        skipped.push({ name: relative, reason: 'TOO_LARGE', bytes: info.size });
        continue;
      }
      found.push({
        name: relative,
        kind: kindForName(entry.name),
        bytes: info.size,
        mtime: info.mtime.toISOString(),
        directory: path.dirname(relative) === '.' ? '' : path.dirname(relative),
        // 工作区根目录下的 index.html 是网页作品的惯例入口，界面默认选它
        recommended: relative === 'index.html',
      });
    }
  };

  walk(root, 0);
  found.sort((left, right) => (left.recommended === right.recommended ? right.mtime.localeCompare(left.mtime) : left.recommended ? -1 : 1));
  return { found, skipped, truncated };
}

/** 主产物自己引用的本地素材（只认同目录或子目录里的相对引用）。 */
function localReferences(name, text) {
  const values = [];
  if (/\.(html?|svg)$/i.test(name)) {
    for (const match of String(text).matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) values.push(match[1]);
  }
  if (/\.(html?|css|svg)$/i.test(name)) {
    for (const match of String(text).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) values.push(match[1]);
  }
  return values;
}

function isTextExtension(extension) {
  return new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.md', '.csv']).has(extension);
}

/**
 * 取一份主产物：它自己 + 它引用的本地素材（递归，HTML 引 CSS 引字体也算）。
 * 引用的解析以**主产物所在目录**为基准 —— 与浏览器一致；不支持的引用
 * （绝对地址、http、`..`、带查询串之外的怪写法）记进 missing，让平台/学生看得见。
 */
function collectDeliverable(root, relative) {
  const entry = resolveInside(root, relative);
  const entryExtension = path.extname(entry.relative).toLowerCase();
  if (!ENTRY_EXTENSIONS.has(entryExtension)) {
    fail(`只有网页、PPT、Word、Excel 可以作为作品提交（收到 ${entryExtension || '无扩展名'}）`, 'COLLECT_NOT_SUBMITTABLE');
  }
  const payloads = new Map();
  const missing = [];
  // 记录「哪个主产物里的哪个引用指向了哪个文件」—— 拍平时要靠它改写引用（见 flattenForSubmission）
  const references = [];
  let totalBytes = 0;

  const load = (absolute, name, depth) => {
    if (payloads.has(name)) return;
    if (depth > MAX_DEPTH) return;
    const info = lstatSync(absolute, { throwIfNoEntry: false });
    if (!info || info.isSymbolicLink() || !info.isFile()) { missing.push(name); return; }
    if (info.size > MAX_FILE_BYTES) fail(`文件太大（${name}，${info.size} 字节）`, 'COLLECT_TOO_LARGE');
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_BYTES) fail(`一次取回的内容太多（超过 ${MAX_TOTAL_BYTES} 字节）`, 'COLLECT_TOO_LARGE');
    const extension = path.extname(name).toLowerCase();
    const text = isTextExtension(extension);
    const bytes = readFileSync(absolute);
    payloads.set(name, {
      name,
      origin: name,
      encoding: text ? 'utf8' : 'base64',
      bytes: bytes.length,
      content: text ? bytes.toString('utf8') : bytes.toString('base64'),
      // 与平台侧 vibecoding 的产物口径对齐：改动它的人能一眼看出这份是二进制
      binary: !text,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    if (text) {
      // 引用按**主产物所在目录**解析（与浏览器一致）。少一张图不该让整份作品交不上来，
      // 所以解析不出来只记 missing，不抛错。
      const baseDirectory = path.dirname(absolute);
      for (const reference of localReferences(name, bytes.toString('utf8'))) {
        const clean = String(reference).split(/[?#]/)[0].trim();
        if (!clean || clean.startsWith('#') || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) continue;
        if (!clean.includes('.')) continue;
        const resolved = resolveRelative(root, baseDirectory, clean);
        if (!resolved) { missing.push(String(reference)); continue; }
        references.push({ source: name, raw: String(reference), target: resolved.relative });
        load(resolved.absolute, resolved.relative, depth + 1);
      }
    }
  };

  load(entry.absolute, entry.relative, 0);
  return {
    name: entry.relative,
    kind: kindForName(entry.relative),
    files: [...payloads.values()],
    references,
    missing: [...new Set(missing)],
    totalBytes,
  };
}

/**
 * 拍平成「同层文件」——现有作品链路只认扁平名字（服务端的产物名校验、
 * 公开下载口、前端预览三处都拒 `/`，2026-09-16 核实）。
 * 所以取回来的嵌套作品（`mygame/index.html` + `mygame/assets/hero.png`）要拍平，
 * 并且**把引用一起改写**，否则拍平之后图就找不到了。
 *
 * 只在「交作品」这条路上做；`--preserve` 留的是原样（留存件是底档，不该被改写）。
 * 引用改写只动**我们扫出来并成功取回**的那些引用字符串，不做猜测性的替换。
 */
function flattenForSubmission(collected) {
  const flatNames = new Map();
  const used = new Set();
  const warnings = [];
  for (const file of collected.files) {
    let flat = path.basename(file.name);
    if (used.has(flat)) {
      // 撞名：用父目录名做区分（`a/logo.png` 与 `b/logo.png` → logo.png / b-logo.png），
      // 仍然撞就加序号。改写引用时用的是最终算出来的名字，所以撞名不会指向错的文件。
      const parent = path.basename(path.dirname(file.name)) || 'file';
      let candidate = `${parent}-${flat}`;
      let index = 2;
      while (used.has(candidate)) candidate = `${parent}-${index++}-${flat}`;
      warnings.push(`有重名文件，已改名为 ${candidate}（原 ${file.name}）`);
      flat = candidate;
    }
    used.add(flat);
    flatNames.set(file.name, flat);
  }

  const files = collected.files.map((file) => {
    if (file.encoding !== 'utf8') return { ...file, name: flatNames.get(file.name) };
    let text = file.content;
    for (const reference of collected.references.filter((item) => item.source === file.name)) {
      const flat = flatNames.get(reference.target);
      if (flat && flat !== reference.raw) text = text.split(reference.raw).join(flat);
    }
    return {
      ...file,
      name: flatNames.get(file.name),
      content: text,
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    };
  });

  const entryName = flatNames.get(collected.name) || path.basename(collected.name);
  if (entryName !== collected.name) warnings.push(`作品入口已拍平：${collected.name} → ${entryName}`);
  return {
    name: entryName,
    origin: collected.name,
    kind: collected.kind,
    files,
    // 拍平后的名字与原始位置都给出来：后台/审计要能回答「这份原来是哪个文件」
    renamed: collected.files.filter((file) => flatNames.get(file.name) !== file.name)
      .map((file) => ({ from: file.name, to: flatNames.get(file.name) })),
    missing: collected.missing,
    warnings,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

function isInside(root, absolute) {
  // 前缀判定必须带分隔符，否则 /home/x/workspace-evil 会被误判成工作区内部
  return absolute === root || absolute.startsWith(root + path.sep);
}

/**
 * 把一个相对引用解析成工作区内的绝对路径；解析不出来返回 null。
 * 与 resolveInside 同一条尺度（拒 `..`、拒符号链接、必须在工作区内、必须在素材白名单里），
 * 区别只在于**基准目录是主产物所在目录**而不是工作区根。
 */
function resolveRelative(root, baseDirectory, reference) {
  const segments = String(reference).split(/[\\/]+/).filter((segment) => segment && segment !== '.');
  if (!segments.length || segments.some((segment) => segment === '..')) return null;
  const absolute = path.join(baseDirectory, ...segments);
  if (!isInside(root, absolute)) return null;
  const info = lstatSync(absolute, { throwIfNoEntry: false });
  if (!info || info.isSymbolicLink() || !info.isFile()) return null;
  if (!ASSET_EXTENSIONS.has(path.extname(absolute).toLowerCase())) return null;
  return { absolute, relative: path.relative(root, absolute).split(path.sep).join('/') };
}

/** 留存：把产物原样留一份到工作区之外，收环境前用（家目录删了作品还在）。 */
function preserve(root, target) {
  const { found } = scanEntries(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(target, stamp);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const saved = [];
  for (const entry of found) {
    try {
      const collected = collectDeliverable(root, entry.name);
      const deliverableDirectory = path.join(directory, entry.name.replace(/[\\/]+/g, '__'));
      mkdirSync(deliverableDirectory, { recursive: true, mode: 0o700 });
      for (const file of collected.files) {
        const payload = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
        // 按原样保留目录结构：留存件是「出事时的最后一份底」，拍平会看不出原来的引用关系
        const mirrorPath = path.join(deliverableDirectory, ...file.name.split('/'));
        mkdirSync(path.dirname(mirrorPath), { recursive: true, mode: 0o700 });
        writeFileSync(mirrorPath, payload, { mode: 0o600 });
      }
      // 来源路径与清单也留一份：以后要回答「这份是哪次课堂的哪个文件」靠它
      writeFileSync(path.join(deliverableDirectory, 'MANIFEST.json'), JSON.stringify(collected, null, 2), { mode: 0o600 });
      saved.push({ name: entry.name, files: collected.files.length, bytes: collected.totalBytes });
    } catch (error) {
      saved.push({ name: entry.name, error: String(error.message || error) });
    }
  }
  writeFileSync(path.join(directory, 'INDEX.json'), JSON.stringify({ runtime: path.basename(path.dirname(root)), saved }, null, 2), { mode: 0o600 });
  return { directory, saved };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const workspace = process.env.COLLECT_WORKSPACE || '';
  const root = workspaceRealPath(workspace);

  if (command === 'list') {
    const { found, skipped, truncated } = scanEntries(root);
    process.stdout.write(JSON.stringify({
      workspace: root,
      truncated,
      deliverables: found,
      skipped,
      limits: { maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES },
    }) + '\n');
    return;
  }
  if (command === 'export') {
    // 交作品这条路要的是「平铺、引用自洽」的一份，见 flattenForSubmission 的说明
    process.stdout.write(JSON.stringify(flattenForSubmission(collectDeliverable(root, rest[0]))) + '\n');
    return;
  }
  if (command === 'preserve') {
    const target = String(process.env.COLLECT_PRESERVE_ROOT || '/srv/dsh-runtime/deliverables');
    process.stdout.write(JSON.stringify(preserve(root, target)) + '\n');
    return;
  }
  fail(`不认识的子命令：${command}`, 'COLLECT_BAD_COMMAND');
}

try {
  main();
} catch (error) {
  // 失败要吵：把错误码与原因打在 **stderr**（stdout 只放 JSON），退出码非 0 让平台侧看得见
  process.stderr.write(`[collect] ${error.code || 'COLLECT_FAILED'}: ${error.message}\n`);
  process.exit(1);
}
