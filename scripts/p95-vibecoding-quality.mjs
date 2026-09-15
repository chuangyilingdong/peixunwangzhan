import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p95-vibecoding-quality-'));
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = path.join(temp, 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';
process.env.AI_PROVIDER = 'local-mock';

const root = fileURLToPath(new URL('..', import.meta.url));
await import(pathToFileURL(path.join(root, 'packages/database/src/db.js')).href);
const { submissionArtifactNames } = await import('../apps/server/src/routes/vibecoding.js');
const { isSubmittableArtifactKind } = await import('../apps/server/src/services/vibecodingArtifacts.js');
const { parseDeckSpec } = await import('../apps/server/src/services/ooxml/documents.js');
const { buildPreviewDocument } = await import('../packages/shared/src/vibecodingProject.js');

const files = {
  'index.html': '<!doctype html><html><head><script defer src="app.js?v=1"></script><link rel="stylesheet" href="style.css?v=1"></head><body><img src="texture.svg"></body></html>',
  'style.css': '.hero { background: url("texture.svg") }',
  'app.js': 'console.error("early");',
  'texture.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>',
  'other.html': '<!doctype html><html><body>另一份作品</body></html>',
  'notes.txt': '不属于网页依赖',
  '汇报.pptx': '{"title":"汇报","slides":[{"title":"一"}]}',
};

assert.deepEqual(new Set(submissionArtifactNames(files, 'index.html')), new Set(['index.html', 'style.css', 'app.js', 'texture.svg']), 'HTML 提交应只包含入口及递归本地依赖');
assert.deepEqual(submissionArtifactNames(files, '汇报.pptx'), ['汇报.pptx'], '文档提交只能包含自身');
assert.deepEqual(submissionArtifactNames(files, 'style.css'), [], 'CSS 不能作为主作品提交');
assert.equal(isSubmittableArtifactKind('html'), true);
assert.equal(isSubmittableArtifactKind('pptx'), true);
assert.equal(isSubmittableArtifactKind('css'), false);

const preview = buildPreviewDocument(files, 'index.html');
assert.ok(!preview.includes('style.css?v=1') && !preview.includes('app.js?v=1'), '带查询串的本地 CSS/JS 也必须内联');
assert.ok(preview.includes("DOMContentLoaded',function(){console.error(\"early\")"), 'defer 本地脚本必须保留 DOM 就绪后执行语义');
assert.ok(preview.indexOf('vibecoding-console') < preview.indexOf('console.error("early")'), '控制台桥必须早于 head 里的业务脚本');
assert.ok(preview.includes('data:image/svg+xml'), '本地 SVG 必须内联进预览文档');
assert.ok(!preview.includes('src="texture.svg"') && !preview.includes('url("texture.svg")'), '预览不能留下无法加载的本地 SVG 地址');

const deck = parseDeckSpec(JSON.stringify({
  title: '新版式',
  slides: [
    { layout: 'metrics', title: '数据', metrics: [{ value: '72%', label: '参与率' }], source: '课堂示例数据', image: { prompt: '不该生成', attachment: 1 } },
    { layout: 'timeline', title: '步骤', steps: ['调研', '设计', '验证'] },
    { layout: 'comparison', title: '对比', columns: [{ title: 'A', bullets: ['快'] }, { title: 'B', bullets: ['稳'] }] },
  ],
}));
assert.deepEqual(deck.slides.map((slide) => slide.layout), ['metrics', 'timeline', 'comparison']);
assert.equal(deck.slides[0].metrics[0].value, '72%');
assert.equal(deck.slides[0].imagePrompt, null, '不渲染图片的特殊版式不能产生无效生图请求');
assert.equal(deck.slides[0].imageAttachment, null, '不渲染图片的特殊版式不能保留附件图片');
assert.equal(deck.slides[1].steps.length, 3);
assert.equal(deck.slides[2].columns.length, 2);
const inferred = parseDeckSpec(JSON.stringify({ title: '自动版式', slides: [
  { title: '图表', chart: { labels: ['A', '', 'C'], values: [1, 2, 3], highlight: 2 }, source: '课堂示例数据' },
  { title: '表格', table: { headers: ['项目', '数值'], rows: [['A', '1']] }, source: '课堂示例数据' },
  { title: '流程', process: [{ title: '开始' }, { title: '完成' }] },
  { title: '坏表格', layout: 'table', table: { headers: '不是数组', rows: '也不是数组' } },
] }));
assert.deepEqual(inferred.slides.slice(0, 3).map((slide) => slide.layout), ['chart', 'table', 'process'], '省略 layout 时应按结构推断版式');
assert.deepEqual(inferred.slides[0].chart.labels, ['A', 'C'], '无效图表标签应被过滤');
assert.equal(inferred.slides[0].chart.highlight, 1, '过滤数据点后高亮索引应重映射');
assert.equal(inferred.slides.some((slide) => slide.title === '坏表格' && slide.table), false, '异常表格不能进入预览/下载结构');

const workbench = fs.readFileSync(path.join(root, 'packages/shared/src/console/Workbench.jsx'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'packages/shared/src/vibecodingWorkspace.jsx'), 'utf8');
const dataHook = fs.readFileSync(path.join(root, 'packages/shared/src/classroom.jsx'), 'utf8');
const route = fs.readFileSync(path.join(root, 'apps/server/src/routes/vibecoding.js'), 'utf8');
const artifacts = fs.readFileSync(path.join(root, 'apps/server/src/services/vibecodingArtifacts.js'), 'utf8');

assert.match(workbench, /c-phone-frame/);
assert.match(workbench, /onFixConsole/);
assert.match(workbench, /updatedAt \|\| b\.createdAt/);
assert.match(workspace, /tabs=\{\['preview', 'console'\]\}/);
assert.match(workspace, /visibility: 'PRIVATE'/);
assert.match(workspace, /请修复当前作品/);
assert.match(workspace, /activeConversationIdRef/);
assert.match(workspace, /return \(\) => \{\s*abortRef\.current\?\.abort\(\)/);
assert.match(workspace, /!artifacts\.length \|\| !target/);
assert.match(dataHook, /request === requestRef\.current/);
assert.match(dataHook, /requestRef\.current \+= 1/);
assert.match(route, /390×844/);
assert.match(route, /assertExternalAiAllowed/);
assert.match(route, /VIBECODING_ARTIFACT_NOT_SUBMITTABLE/);
assert.match(route, /currentAttachmentImages/);
assert.match(route, /embeddedImages/);
assert.match(route, /mime_type/);
assert.match(route, /is_public=0,share_token=NULL,published_at=NULL,published_by=NULL/);
assert.match(artifacts, /fileCount >= ARTIFACT_LIMITS\.maxFiles/);
assert.match(artifacts, /total - Number\(existing\?\.bytes \|\| 0\) \+ bytes/);

fs.rm(temp, { recursive: true, force: true }, () => {});
console.log('P95 VibeCoding 精品化守卫通过（手机预览、错误修复、提交隔离、私有素材、配额、新 PPT 版式）');
