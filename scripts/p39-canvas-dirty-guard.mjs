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

const result = { name: 'canvas-dirty-guard', pass: findings.length === 0, scannedFiles: 2, findings };
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exit(1);
