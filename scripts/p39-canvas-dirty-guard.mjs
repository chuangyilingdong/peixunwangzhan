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

const result = { name: 'canvas-dirty-guard', pass: findings.length === 0, scannedFiles: 2, findings };
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exit(1);
