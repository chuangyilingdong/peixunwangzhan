// 联调日志查询（只读测试库）：最近 N 条 compute_attempts + 假上游 JSONL 末尾。
//
// 用法：
//   set -a; . /etc/ai-kids-platform/test.env; set +a
//   node scripts/test-stream-logs.mjs [N]
import fs from 'node:fs';
import { arows } from '../packages/database/src/store.js';

const dbPath = String(process.env.PLATFORM_DB_PATH || '');
if (!dbPath.includes('test-runtime')) {
  throw new Error(`PLATFORM_DB_PATH 必须指向 test-runtime 测试库，当前：${dbPath || '(空)'}`);
}
const limit = Math.max(1, Math.min(200, Number(process.argv[2] || 20)));
const rows = await arows(
  `SELECT id, client_request_id, status, error_code, error_message,
          output_started, channel_id, model, gateway_log_id,
          created_at, completed_at
     FROM compute_attempts
    ORDER BY created_at DESC
    LIMIT ?`,
  [limit],
);
console.log('== compute_attempts（最近 ' + rows.length + ' 条）');
console.log(JSON.stringify(rows, null, 2));

const fakeLog = String(process.env.FAKE_SSE_LOG || '/srv/ai-kids-platform/test-runtime/fake-sse.jsonl');
try {
  const lines = fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).slice(-limit);
  console.log(`\n== fake-sse 上游日志（${fakeLog}，最近 ${lines.length} 条）`);
  for (const line of lines) console.log(line);
} catch (error) {
  console.log(`\n== fake-sse 上游日志（读取失败：${error.message}）`);
}
