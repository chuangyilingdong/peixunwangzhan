/**
 * p39 画布「刷新复原」静态守卫（纯静态检查，不起服务）。
 *
 * 背景：学生挪框体、平移/缩放视角，一刷新全复原。两个原因都在客户端，服务端冒烟（p33）发现不了：
 *   1. 判断「有没有未保存改动」的 canvasContentSignature 只签了 id/type/data，**漏了节点位置**，
 *      于是挪框体不算改动 → 不触发自动保存 → 刷新回原位。
 *   2. 画布组件无条件写了 `fitView`，每次挂载都重新适配视野，把存下来的视角覆盖掉。
 * 这个守卫盯住这两点：改动它们必须是有意的。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const findings = [];

/** 取出一个函数的源码（从 function 名到下一行顶格 } 为止）。 */
function readFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const end = source.indexOf('\n}', start);
  return end < 0 ? null : source.slice(start, end);
}

// 1) 内容签名必须带节点位置
const workspacePath = path.join(root, 'packages/shared/src/canvasWorkspace.jsx');
const workspace = fs.readFileSync(workspacePath, 'utf8');
const signatureBody = readFunctionBody(workspace, 'canvasContentSignature');
if (!signatureBody) {
  findings.push(`${workspacePath}: 找不到 canvasContentSignature()`);
} else {
  if (!/position\s*:/.test(signatureBody)) {
    findings.push(
      `${workspacePath}: canvasContentSignature() 没有把节点 position 计入签名 —— `
      + '挪框体会被判成「没有改动」而不自动保存，刷新后位置复原。',
    );
  }
  if (!/viewport\s*:/.test(signatureBody)) {
    findings.push(`${workspacePath}: canvasContentSignature() 没有把 viewport 计入签名 —— 平移/缩放的视角不会被保存。`);
  }
}

// 2) 画布不能无条件 fitView（那会覆盖存下来的视角）
const canvasPath = path.join(root, 'packages/canvas/src/index.jsx');
const canvas = fs.readFileSync(canvasPath, 'utf8');
const bareFitView = canvas.match(/^\s*fitView\s*$/m);
if (bareFitView) {
  findings.push(
    `${canvasPath}: 出现了无条件 \`fitView\` —— 每次挂载都会重新适配视野、把快照里存的视角覆盖掉，`
    + '应写成 `fitView={!hasStoredViewport}`。',
  );
}
if (!/fitView=\{[^}]*hasStoredViewport[^}]*\}/.test(canvas)) {
  findings.push(`${canvasPath}: 没有看到 \`fitView={...hasStoredViewport...}\`，无法确认是否只在「没存过视角」时适配。`);
}

// ③ ⭐ 2026-09-28 用户报「拖动了很多外部文件进画布，删了又出现删了又出现」。
//    上传是**异步**的（几秒到几十秒），这期间用户完全能把刚拖进来的框体删掉。
//    所以上传流程必须"每次写回都基于**最新那份**快照 + 只 patch 这一个节点" ——
//    一旦退回"把上传开始那一刻的整份快照存进 current、每传完一个就整份写回"，
//    用户删掉的框体就会被**每个文件的完成事件一次次带回来**（6 个文件 = 回来 6 次）。
{
  const uploadPath = 'packages/shared/src/canvasWorkspace.jsx';
  const uploadSource = fs.readFileSync(path.join(root, uploadPath), 'utf8');
  const body = readFunctionBody(uploadSource, 'uploadFiles');
  if (!body) {
    findings.push(`${uploadPath}: 找不到 uploadFiles()，无法确认"上传期间删掉的框体会不会被写回来"。`);
  } else {
    if (/setCanvasSnapshot\(current\)/.test(body) || /setDraft\(current\)/.test(body)) {
      findings.push(`${uploadPath}: uploadFiles() 里出现了整份写回（setCanvasSnapshot(current)/setDraft(current)）—— `
        + 'current 是上传开始那一刻的旧快照，每传完一个文件就把它整份盖回去 = "删了又出现"。');
    }
    if (!/patchNode\(latestCanvasRef\.current/.test(body)) {
      findings.push(`${uploadPath}: uploadFiles() 没有基于 latestCanvasRef.current 做 patch —— `
        + '离开"最新快照 + 只改这个节点"这个口径，删掉的框体又会被带回来。');
    }
    if (!/const latestCanvasRef = useRef\(null\)/.test(uploadSource) || !/const commitCanvas = \(next\) =>/.test(uploadSource)) {
      findings.push(`${uploadPath}: 没看到 latestCanvasRef / commitCanvas —— 画布写回没有"最新快照"这个单一出处。`);
    }
  }
}

// ④ ⭐⭐ 2026-09-28 生产事故（P0，学生**进不了画布课堂**：整页白屏）
//    `Cannot read properties of null (reading 'canvasSnapshot')`。
//    ③ 那次修复把 `latestCanvasRef` 挪到了"所有提前 return 之前"——**钩子顺序挪对了**
//    （p34 挡下的正是这个），但那一行由此变成**渲染期第一次就跑**，而那时 `project` 还在
//    loading（`useData` 初始态 `{loading:true, data:null}`）→ `project.data` 是 null →
//    读 `.canvasSnapshot` 直接抛。**"提前 return 之前"= 每次 render 都会跑 = 必须空安全。**
//    所以这条网盯两件事：那个区间里组件体那一层不许出现 `project.data.<字段>`（要用 `?.`）；
//    以及 `latestCanvasRef.current =` 那一行的兜底表达式必须带 `?.`。
//    ⚠️ 已知盲区：只扫"组件体那一层"（2 空格缩进）与它的续行；hook 回调体（≥4 空格）里
//       有自己的 `if (!project.data) return` 守卫，不在此网范围内。
{
  const guardPath = 'packages/shared/src/canvasWorkspace.jsx';
  const source = fs.readFileSync(path.join(root, guardPath), 'utf8');
  const cut = source.indexOf('if (project.loading) return');
  if (cut < 0) {
    findings.push(`${guardPath}: 找不到加载态的提前返回（if (project.loading) return）—— `
      + '无法确认"提前返回之前"那段是否空安全，请同步更新这条守卫。');
  } else {
    const lines = source.slice(0, cut).split('\n');
    const offenders = [];
    lines.forEach((line, index) => {
      const text = line.replace(/\/\/.*$/, '');
      if (!/project\.data\.[A-Za-z_$]/.test(text) || /project\.data\?\.[A-Za-z_$]/.test(text)) return;
      // 同一行里就有短路守卫的写法是安全的（`Boolean(project.data) && … project.data.status`）。
      if (/(!\s*project\.data\b)|(Boolean\(project\.data\))|(project\.data\s*\?\?)|(project\.data\s*&&)/.test(text)) return;
      const indent = text.match(/^ */)[0].length;
      // 组件体那一层：2 空格缩进，或者它的**续行**（多行表达式）。
      // 判"续行"的办法：往上找到第一个缩进更小的行 —— 若它是 2 空格且**不是开块的那一行**
      // （`…=> {` / `…{`），说明当前行只是那句组件体语句的下一行，同样每次 render 都会跑。
      let atComponentLevel = indent === 2;
      if (!atComponentLevel && indent > 2) {
        for (let i = index - 1; i >= 0; i -= 1) {
          const above = lines[i];
          if (!above.trim()) continue;
          const aboveIndent = above.match(/^ */)[0].length;
          if (aboveIndent < indent) {
            atComponentLevel = aboveIndent === 2 && !/(=>|\{)\s*$/.test(above.replace(/\/\/.*$/, ''));
            break;
          }
        }
      }
      if (atComponentLevel) offenders.push(index + 1);
    });
    for (const line of offenders) {
      findings.push(`${guardPath}:${line}: "提前 return 之前"（每次 render 都会跑）直接读了 `
        + '`project.data.<字段>` —— 那一档 `project` 还在 loading、`project.data` 是 **null**，'
        + '会抛 `Cannot read properties of null` 让整个画布课堂白屏（2026-09-28 线上事故）。'
        + '请写成 `project.data?.<字段>`。');
    }
    const refAssignment = source.match(/latestCanvasRef\.current\s*=\s*([^\n]*)/);
    if (!refAssignment) {
      findings.push(`${guardPath}: 找不到 latestCanvasRef.current 的赋值，无法确认它空安全。`);
    } else if (/project\.data\./.test(refAssignment[1])) {
      findings.push(`${guardPath}: latestCanvasRef.current 的兜底表达式里 \`project.data.\` 少了 \`?\` —— `
        + '这一行在渲染期先跑，加载中取它就是 null 解引用（画布课堂整页白屏）。');
    }
  }
}

const result = { name: 'canvas-dirty-guard', pass: findings.length === 0, scannedFiles: 2, findings };
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exit(1);
