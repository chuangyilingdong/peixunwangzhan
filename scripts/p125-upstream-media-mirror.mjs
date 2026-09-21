/**
 * P125 上游素材镜像 + 2.5 低价版生图模板（2026-09-21，用户报的两件）。
 *
 * ①「图1还是没法参考，完全不一样的内容」（视频首帧）+「引用没有真实生效」（生图参考）——
 *   真正的根因**不在请求体形状**（形状早就对了，用户报的那两条模板都在发首帧），而是：
 *   **上游在境外，抓不到 iicili.cyou 上的素材**：
 *     · 用户那两条视频任务（09-21 15:21）上游**压根没到我们的 nginx**（access.log 零条）；
 *     · 唯一到了的一条（15:35，python-httpx、腾讯云香港）**只读了 105703 / 538855 字节**就断了。
 *   上游读不到图**不报错** → 当文生跑 → 出来一段跟参考毫无关系的画面（用户看到的「完全不一样」）。
 *   受控实验：同一张图**先传到上游**再当首帧 → 视频第一帧就是那张画 ✓。
 *   所以修法是：请求体里凡是指向**我们自己域名**的素材，先传到上游、换成上游自己的 URL。
 *
 * ②「2.5 这个模型会报错…2.0 正常」，上游原话 `output_format is not supported by this model`。
 *   第一版修错了（以为是"字段位置"问题，换成顶层照样报）—— 实际是**两款模型能力不同**：
 *   2.5 低价扩展版**压根不支持** output_format / quality / background（上游文档原话
 *   「此扩展版不提供质量档位、输出格式、透明背景或流式选项」），而 flare/sunburst 支持（放顶层）。
 *
 * 这个守卫**真跑纯函数**（渲染 + 镜像改写 + 真发一次假请求看请求体），不是读源码猜。
 */
import assert from 'node:assert/strict';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const {
  mirrorSelfHostedMedia, mirrorMediaUrl, isSelfHostedMediaUrl, resetUpstreamMediaMirrorCache, upstreamMediaMirrorCacheSize,
} = await import('../apps/server/src/services/upstreamMediaMirror.js');
const { openAiCompatibleProvider } = await import('../apps/server/src/services/openaiCompatibleProvider.js');
const { requestTemplateFor, renderRequestTemplate } = await import('../apps/server/src/services/modelCapabilities.js');

const SELF = 'https://iicili.cyou';
const OUR_IMAGE = `${SELF}/api/public/file-assets/file_a65dc46d919e4b9dbf91/download`;
const OUR_IMAGE_2 = `${SELF}/api/public/file-assets/file_second/download`;
const UPSTREAM_HOSTED = 'https://api.seedance.nz/f/tmp-uploaded-9f2c.jpg';
const UPSTREAM_HOSTED_2 = 'https://api.seedance.nz/f/tmp-uploaded-second.jpg';
const UPLOAD_URL = 'https://api.seedance.nz/v1/files/upload';
const VIDEO_SUBMIT = 'https://api.seedance.nz/v2/video_generation';
const IMAGE_SUBMIT = 'https://api.seedance.nz/v1/image/generations';

/* ── ① 哪些 URL 算「我们自己站点上的素材」 ───────────────────────────────── */
check('① 我们自己域名的素材 URL 认得出来', isSelfHostedMediaUrl(OUR_IMAGE, [SELF]) === true);
check('② 上游自己的 URL 不动（生成的图/视频本来就在上游存储上）', isSelfHostedMediaUrl(UPSTREAM_HOSTED, [SELF]) === false);
check('③ data: / mock: 这类内联素材不动（上游自己收 data URI）',
  isSelfHostedMediaUrl('data:image/png;base64,AAAA', [SELF]) === false && isSelfHostedMediaUrl('mock://x.png', [SELF]) === false);
check('④ 没配自站域名时一律不动（默认关，别的上游不受影响）', isSelfHostedMediaUrl(OUR_IMAGE, []) === false);

/* ── ② 改写：首帧 / 尾帧 / 参考素材都换成上游的 URL，且带缓存 ─────────────── */
let calls = [];
function fakeFetch({ failUpload = false, uploadUrls = [UPSTREAM_HOSTED, UPSTREAM_HOSTED_2], contentLength = 4 } = {}) {
  calls = [];
  let uploads = 0;
  const impl = async (url, init = {}) => {
    const target = String(url);
    // 记一下 multipart 里的文件名（上游按后缀认类型，这条必须钉住）
    let fileName = '';
    try { fileName = String(init.body?.get?.('file')?.name || ''); } catch { fileName = ''; }
    calls.push({ url: target, method: String(init.method || 'GET').toUpperCase(), fileName });
    if (init.method === 'POST' && target === UPLOAD_URL) {
      if (failUpload) return new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } });
      const hosted = uploadUrls[Math.min(uploads, uploadUrls.length - 1)];
      uploads += 1;
      return new Response(JSON.stringify({ url: hosted, file_type: 'image', expires_in: 86400 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.startsWith(SELF)) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(contentLength) } });
    if (target === VIDEO_SUBMIT) return new Response(JSON.stringify({ task_id: 'task_x' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (target.startsWith('https://api.seedance.nz/v2/query/')) return new Response(JSON.stringify({ task: { status: 'succeeded', content: { url: 'https://example.test/v.mp4' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  impl.uploadCount = () => uploads;
  impl.count = (url) => calls.filter((item) => item.url === url).length;
  impl.calls = () => calls;
  return impl;
}

resetUpstreamMediaMirrorCache();
const f1 = fakeFetch();
// 先单独镜像一张、钉住它的映射：这样后面并行那几条的期望值是确定的（不会因为谁先跑完而变）
const firstFrameHosted = await mirrorMediaUrl(OUR_IMAGE, { uploadUrl: UPLOAD_URL, apiKey: 'sk-test', fetchImpl: f1 });
check('⑤ 单张素材被换成了上游自己的 URL', firstFrameHosted === UPSTREAM_HOSTED, firstFrameHosted);
const mirrored = await mirrorSelfHostedMedia(
  { firstFrameUrl: OUR_IMAGE, lastFrameUrl: OUR_IMAGE_2, referenceAssets: [{ type: 'IMAGE', url: OUR_IMAGE }] },
  { selfOrigins: [SELF], uploadUrl: UPLOAD_URL, apiKey: 'sk-test', fetchImpl: f1 },
);
check('⑥ 首帧走缓存（同一个源 URL 不再重复上传）', mirrored.firstFrameUrl === firstFrameHosted, mirrored.firstFrameUrl);
check('⑦ 参考素材用**同一个**镜像结果（首帧与参考是同一张图时不会传两遍）',
  mirrored.referenceAssets[0].url === firstFrameHosted, mirrored.referenceAssets[0].url);
check('⑧ 尾帧是另一张 → 换成了另一个上游 URL，且不是我们域名',
  mirrored.lastFrameUrl === UPSTREAM_HOSTED_2, mirrored.lastFrameUrl);
check('⑨ 参考素材的 type 等其它字段没被丢掉', mirrored.referenceAssets[0].type === 'IMAGE');
check('⑩ 一共只上传了 2 次（3 处引用、2 张不同的图）', f1.uploadCount() === 2, `uploads=${f1.uploadCount()}`);
check('⑩b 缓存条数 = 2（按源 URL 记账）', upstreamMediaMirrorCacheSize() === 2, `cache=${upstreamMediaMirrorCacheSize()}`);
check('⑩c 原来的 options 对象没被就地改（不污染调用方）',
  (await (async () => { const original = { firstFrameUrl: OUR_IMAGE }; await mirrorSelfHostedMedia(original, { selfOrigins: [SELF], uploadUrl: UPLOAD_URL, fetchImpl: f1 }); return original.firstFrameUrl === OUR_IMAGE; })()) === true);

resetUpstreamMediaMirrorCache();
const f2 = fakeFetch();
const mirrored2 = await mirrorSelfHostedMedia(
  { firstFrameUrl: OUR_IMAGE, referenceAssets: [{ type: 'IMAGE', url: UPSTREAM_HOSTED }] },
  { selfOrigins: [SELF], uploadUrl: UPLOAD_URL, fetchImpl: f2 },
);
check('⑪ 上游自己的素材**不**上传（只是补了一次首帧的上传）',
  f2.uploadCount() === 1 && mirrored2.referenceAssets[0].url === UPSTREAM_HOSTED, `uploads=${f2.uploadCount()}`);
check('⑫ 没有任何要镜像的素材时，options 原样返回',
  (await mirrorSelfHostedMedia({ firstFrameUrl: UPSTREAM_HOSTED }, { selfOrigins: [SELF], uploadUrl: UPLOAD_URL, fetchImpl: f2 })).firstFrameUrl === UPSTREAM_HOSTED);

resetUpstreamMediaMirrorCache();
const f3 = fakeFetch({ failUpload: true });
let uploadError = null;
try { await mirrorSelfHostedMedia({ firstFrameUrl: OUR_IMAGE }, { selfOrigins: [SELF], uploadUrl: UPLOAD_URL, fetchImpl: f3 }); } catch (error) { uploadError = error; }
check('⑬ 上传失败**必须报错**，不许退回原 URL 静默继续（静默=生成出与参考无关的作品）',
  Boolean(uploadError) && /素材上传到上游失败/.test(String(uploadError?.message || '')), String(uploadError?.message || '(没报错)'));

// ⚠️ 上游按**文件名后缀**认素材类型（实测：filename=asset → 400 说
//    「unsupported file type; allowed: jpg/jpeg/png/webp…」）；我们的下载路径是 /download、
//    没有后缀 —— 必须按 content-type 补一个，否则**每种素材都传不上去**（第一版就是这么挂的）。
resetUpstreamMediaMirrorCache();
const fExt = fakeFetch();
await mirrorSelfHostedMedia({ firstFrameUrl: OUR_IMAGE }, { selfOrigins: [SELF], uploadUrl: UPLOAD_URL, fetchImpl: fExt });
const uploadBody = String(fExt.calls().find((item) => item.url === UPLOAD_URL)?.fileName || '');
check('⑬b 上传时文件名带上了后缀（上游只认 jpg/png/webp/mp3/wav/flac/mp4… 这些后缀）',
  /\.jpe?g$/i.test(uploadBody), uploadBody || '(假 fetch 没记到文件名)');
check('⑬c 上游的错误原文会带进报错里（不然只剩一句 HTTP 400，排不动）',
  /素材上传到上游失败/.test(String(uploadError?.message || '')));

// 上游对素材有大小上限（图片 30MB / 音频视频 50MB），而我们单文件上限是 200MB ——
// 传个 100MB 的课件当参考完全可能，必须在**读 body 之前**按 content-length 拦下来。
resetUpstreamMediaMirrorCache();
const fBig = fakeFetch({ contentLength: 120 * 1024 * 1024 });
let bigError = null;
try { await mirrorSelfHostedMedia({ firstFrameUrl: OUR_IMAGE }, { selfOrigins: [SELF], uploadUrl: UPLOAD_URL, fetchImpl: fBig }); } catch (error) { bigError = error; }
check('⑬d 素材超过上游上限时给一句能行动的提示（不是把上游那句英文甩给学生）',
  /超过上游 30\.0MB 的上限/.test(String(bigError?.message || '')) && !/读取素材失败/.test(String(bigError?.message || '')),
  String(bigError?.message || '(没报错)'));
check('⑬e 超限时**没有**真的发起上传（不该白传一趟）', fBig.uploadCount() === 0, `uploads=${fBig.uploadCount()}`);

/* ── ③ 端到端：适配器发出去的请求体里，首帧已经是上游的 URL ───────────────── */
resetUpstreamMediaMirrorCache();
const f4 = fakeFetch();
globalThis.fetch = f4;
const provider = openAiCompatibleProvider({
  name: 'custom', model: 'MiniMax-H3', endpoint: 'https://api.seedance.nz/v1', apiKey: 'sk-test',
  mediaUploadPath: '/v1/files/upload', selfOrigins: [SELF],
  requestPaths: { VIDEO: '/v2/video_generation' }, pollPaths: { VIDEO: '/v2/query/video_generation/{taskId}' },
  modelRequestTemplates: { 'MiniMax-H3': { model: '{{model}}', content: [{ type: 'text', text: '{{prompt}}' }, '{{frameItems}}', '{{referenceItems}}'], duration: '{{durationSecondsNumber}}', resolution: '{{resolution}}', ratio: '{{aspectRatio}}' } },
  pollIntervalMs: 300,
});
const submitted = [];
const realFetch = f4;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === VIDEO_SUBMIT && String(init.method || '').toUpperCase() === 'POST') submitted.push(JSON.parse(String(init.body || '{}')));
  return realFetch(url, init);
};
await provider.generate({ modality: 'VIDEO', prompt: '让图片动起来', options: { aspectRatio: '16:9', resolution: '480P', durationSeconds: 5, firstFrameUrl: OUR_IMAGE } });
const videoBody = submitted[0] || {};
const frameItem = (videoBody.content || []).find((item) => item && item.role === 'first_frame');
check('⑭ 发出去的请求体里，首帧用的是**上游自己**的 URL（不是我们的域名）',
  frameItem?.image_url?.url === UPSTREAM_HOSTED, JSON.stringify(frameItem));
check('⑮ 上传发生在提交任务**之前**（顺序不能反）',
  calls_in_order(f4), '');
check('⑯ 请求体的其余形状没变（text 项 / duration / resolution / ratio）',
  videoBody.content?.[0]?.text === '让图片动起来' && videoBody.duration === 5 && videoBody.resolution === '480P' && videoBody.ratio === '16:9',
  JSON.stringify(videoBody));

function calls_in_order(impl) {
  const uploadIndex = impl.count(UPLOAD_URL);
  const submitIndex = impl.calls().findIndex((item) => item.url === VIDEO_SUBMIT);
  const firstUpload = impl.calls().findIndex((item) => item.url === UPLOAD_URL);
  return uploadIndex > 0 && firstUpload >= 0 && submitIndex > firstUpload;
}

/* ── ④ 2.5 低价扩展版：一个不支持的字都不能带 ───────────────────────────── */
const lowprice = requestTemplateFor({}, 'IMAGE', { model: 'zhenzhen-image-g-v2.5-lowprice' });
check('⑰ 2.5 低价版模板里**没有** output_format（上游对这款明确不支持，传了就是 400）',
  !/output_format/.test(JSON.stringify(lowprice || {})), JSON.stringify(lowprice));
check('⑱ 也没有 quality / background / metadata（同样是这款不支持的能力）',
  !/quality|background|metadata/.test(JSON.stringify(lowprice || {})), JSON.stringify(lowprice));
check('⑲ resolution / size / n 在顶层，且仍然带得动参考图（否则图片那条门禁会当场拒绝）',
  lowprice?.resolution === '{{resolution}}' && lowprice?.size === '{{aspectRatio}}' && lowprice?.n === 1
  && /\{\{referenceImageUrls\}\}/.test(JSON.stringify(lowprice)));

const lowpriceBody = renderRequestTemplate(lowprice, { model: 'zhenzhen-image-g-v2.5-lowprice', prompt: '古风图', aspectRatio: '9:16', resolution: '1k' });
check('⑳ 渲染出来的低价版请求体：字段恰好是上游文档里那几项（无输出格式、无 metadata）',
  JSON.stringify(lowpriceBody) === JSON.stringify({ model: 'zhenzhen-image-g-v2.5-lowprice', prompt: '古风图', n: 1, size: '9:16', resolution: '1k' }),
  JSON.stringify(lowpriceBody));
const lowpriceWithRef = renderRequestTemplate(lowprice, { model: 'zhenzhen-image-g-v2.5-lowprice', prompt: '改色', aspectRatio: '16:9', resolution: '2k', referenceAssets: [{ type: 'IMAGE', url: UPSTREAM_HOSTED }] });
check('㉑ 带参考图时 images 是那张图，仍然没有 output_format',
  JSON.stringify(lowpriceWithRef.images) === JSON.stringify([UPSTREAM_HOSTED]) && !('output_format' in lowpriceWithRef), JSON.stringify(lowpriceWithRef));

check('㉒ flare / sunburst 那两款**是**支持 output_format 的（放顶层），别一起删了',
  requestTemplateFor({}, 'IMAGE', { model: 'zhenzhen-image-g-v2.5-flare' })?.output_format === 'png'
  && requestTemplateFor({}, 'IMAGE', { model: 'zhenzhen-image-g-v2.5-sunburst' })?.output_format === 'png');
check('㉓ 2.0（zhenzhen-image-g-v2-lowprice）形状不变 —— 它一直能用，别动',
  requestTemplateFor({}, 'IMAGE', { model: 'zhenzhen-image-g-v2-lowprice' })?.metadata?.output_format === 'png');
check('㉔ 管理员在渠道/模型上配过的模板优先于内置默认（内置只是兜底）',
  JSON.stringify(requestTemplateFor({ modelRequestTemplates: { 'zhenzhen-image-g-v2.5-lowprice': { model: 'x' } } }, 'IMAGE', { model: 'zhenzhen-image-g-v2.5-lowprice' })) === JSON.stringify({ model: 'x' }));

assert.ok(true);
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
