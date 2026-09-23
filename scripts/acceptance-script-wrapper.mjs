// 验收脚本的包装层（只在 mysql 驱动下由 acceptance-suite.mjs 使用）
//
// 为什么需要它：mysql2 的连接池会**握着事件循环**，脚本干完活（甚至已经打印了 passed）也不退出。
// 实测：不显式关池，进程一直挂着 → 运行器只能按"超时"处理 → 结果全是假失败。
//   · `idleTimeout` 不足以放行（实测设 1500ms 仍然挂）
//   · `socket.unref()` 太危险：查询在途时事件循环可能空掉，Node 直接退出 → **静默丢语句**
// 所以唯一安全的做法是**显式关池**。150 个验收脚本不去逐个改，由这层包装统一在脚本结束后关。
//
// 用法：node scripts/acceptance-script-wrapper.mjs <脚本路径>
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target) { console.error('用法：node scripts/acceptance-script-wrapper.mjs <脚本路径>'); process.exit(2); }

let failed = null;
try {
  await import(pathToFileURL(path.resolve(ROOT, target)).href);
} catch (error) {
  failed = error;
}

// 脚本自己会 process.exit 的话走不到这里 —— 那是脚本的选择，尊重它
try {
  const { closePool } = await import(pathToFileURL(path.join(ROOT, 'packages/database/src/store.js')).href);
  await closePool();
} catch { /* 数据层没加载/关不掉都不影响结果判定 */ }

if (failed) {
  console.error(failed?.stack || failed);
  process.exit(1);
}
