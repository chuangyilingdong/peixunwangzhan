/**
 * P153 数字人口播：上游适配的纯函数守卫。
 *
 * 2026-10-25 实测出的两个真实 bug：
 *   ① Seedance 2.0 i2v 的参考图必须在顶层 images；放 metadata.images 会 400「requires at least one input image」。
 *   ② identify-face 返回 results 数组，session_id / face_id 分在两条 text 子 JSON 里；旧 parser 只认单对象。
 * 另外锁定「克隆通道不可用 → 参考音频直出」的降级标记，避免 UI 把参考直出当训练克隆。
 *
 * 跑法：node scripts/p153-junshi-avatar.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const { parseFaceSession, submitVideoTask } = await import('../apps/server/src/services/junshiAvatar.js');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('① identify-face 新版 results 数组能解析');
const observed = JSON.stringify({
  results: [
    { url: 'https://example.test/face.jpg', outputType: 'jpg', text: null, zindex: null },
    { url: null, outputType: 'text', text: '{"session_id":"943294915512387346"}', zindex: null },
    { url: null, outputType: 'text', text: '{"end_time":5300,"face_id":"0","start_time":0}', zindex: null },
  ],
});
const parsed = parseFaceSession(observed);
check('① session_id 从子 JSON 取出', parsed.sessionId === '943294915512387346', parsed.sessionId);
check('① face_id="0" 不被当成空值丢掉', parsed.faceId === '0', parsed.faceId);
check('① 旧版单对象格式仍兼容', parseFaceSession('{"sessionId":"s1","faceId":"f1"}').sessionId === 's1');
let threw = false;
try { parseFaceSession('{"results":[]}'); } catch { threw = true; }
check('① 没有会话字段时明确报错', threw);

console.log('② Seedance 2.0 i2v 顶层 images');
const originalFetch = global.fetch;
let captured = null;
global.fetch = async (_url, options) => {
  captured = JSON.parse(String(options?.body || '{}'));
  return { ok: true, text: async () => JSON.stringify({ task_id: 'task_test' }) };
};
try {
  const taskId = await submitVideoTask({ endpoint: 'https://example.test', apiKey: 'test-key', model: 'seedance-2.0-standard-i2v', metadata: { resolution: '720p' }, images: ['https://example.test/face.png'], promptOverride: '正面口播' });
  check('② 返回任务号', taskId === 'task_test', taskId);
  check('② images 在顶层，不在 metadata', Array.isArray(captured?.images) && captured.images[0] === 'https://example.test/face.png' && !captured?.metadata?.images, JSON.stringify(captured));
  check('② prompt 与 metadata 保留', captured?.prompt === '正面口播' && captured?.metadata?.resolution === '720p', JSON.stringify(captured));
} finally {
  global.fetch = originalFetch;
}

console.log('③ 降级口径写进代码，不静默冒充克隆/对口型');
const avatar = fs.readFileSync(path.join(root, 'apps/server/src/services/junshiAvatar.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'apps/server/src/routes/junshiWorkbench.js'), 'utf8');
const front = fs.readFileSync(path.join(root, 'apps/website/public/assets/junshi/workbench.js'), 'utf8');
check('③ 克隆失败会降级到参考音频直出', route.includes("'reference'") && route.includes('参考音频直出'));
check('③ 对口型失败会降级为底片+配音并带 note', route.includes('非精准对口型') && route.includes('muxAudioOntoVideo'));
check('③ 前端展示参考直出与降级说明', front.includes('（参考直出）') && front.includes('run.note'));
check('③ custom voice id 去掉下划线/只留字母数字', route.includes("replace(/[^A-Za-z0-9]/g, '')"));
check('③ 服务文件头记录顶层 images 约束', avatar.includes('i2v 参考图必须在顶层 images'));

if (failures) process.exitCode = 1;
else console.log('\nP153 全部通过');
