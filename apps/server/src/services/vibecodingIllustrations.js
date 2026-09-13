// 给 VibeCoding 的文档产物**生成插画**（PPT 里的配图）。
//
// 为什么需要它：只让模型写大纲、服务端排版，出来的就是「一页页要点」的纯文字 PPT —— 快，但不像样。
// 参考实现（豆包那类）在出稿之前有一段「收集素材」：规划风格 → 生成/搜集图片 → 再合成。
// 这里补的就是「生成图片」这一步，用的是平台**已有的生图渠道**（画布那套 IMAGE 模态），
// 不新引任何外部服务。
//
// 几条刻意的取舍：
//   · **数量上限 3 张**：出稿前先规划、只给封面/大图页配图，比每页都塞图既好看又便宜。
//   · **门禁沿用画布那一套**：课时没开放 image 能力、或课堂不允许时，一张都不生成 ——
//     文档产物不能变成绕过能力开关的后门。
//   · **失败只影响那一页**：某张图生成失败就那一页不放图，绝不因此让整份 PPT 或整轮对话失败。
//   · **图片存成公开素材**（与学生上传的图同一条下载地址），这样产物渲染、页面显示、
//     学生自己下载都能直接用。
import { errors } from '../lib.js';
import { getAiProviderPolicy } from '../routes/billingConfig.js';
import { providerSelectionForModality, assertGenerationPreflight } from '../routes/aiGeneration.js';
import { getGenerationProvider } from './generationProvider.js';
import { applyGatewayRoute } from './computeGateway.js';
import { priceFenFor } from './computePool.js';
import { recordAiUsage } from './creditUsage.js';
import { storeGeneratedAsset } from '../routes/fileAssets.js';
import { isDocumentKind, parseDeckSpec, deckIllustrationRequests } from './ooxml/documents.js';

/** 一份 deck 最多生成几张插画（先规划、别每页都配图） */
export const MAX_ILLUSTRATIONS_PER_DECK = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 生成渠道给回来的 assetUrl 可能是 data URL、也可能是远端地址；统一取成字节 */
async function readAssetBytes(assetUrl) {
  const value = String(assetUrl || '');
  const dataMatch = value.match(/^data:([^;,]+);base64,(.+)$/s);
  if (dataMatch) {
    const buffer = Buffer.from(dataMatch[2], 'base64');
    return { buffer, mimeType: dataMatch[1] };
  }
  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value, { redirect: 'follow' });
    if (!response.ok) throw errors.badRequest(`插画下载失败（HTTP ${response.status}）`, 'ILLUSTRATION_FETCH_FAILED');
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, mimeType: String(response.headers.get('content-type') || 'image/png').split(';')[0] };
  }
  throw errors.badRequest('生成渠道没有返回可用的图片地址', 'ILLUSTRATION_NO_ASSET');
}

function extensionFor(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  if (value.includes('webp')) return 'webp';
  if (value.includes('gif')) return 'gif';
  return 'png';
}

/**
 * 找出一轮里需要生成插画的文档产物。
 * @returns {Array<{ artifact, deck, requests }>}
 */
export function collectIllustrationTargets(artifacts) {
  const targets = [];
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (!isDocumentKind(artifact?.kind) || String(artifact.kind).toLowerCase() !== 'pptx') continue;
    const deck = parseDeckSpec(String(artifact.content || ''));
    if (!deck) continue;
    const requests = deckIllustrationRequests(deck).slice(0, MAX_ILLUSTRATIONS_PER_DECK);
    if (requests.length) targets.push({ artifact, deck, requests });
  }
  return targets;
}

/**
 * 跑一遍插画生成。
 *
 * @param {{ auth, context, artifacts, onProgress?: (info) => void }} params
 * @returns {Promise<Map<string, Array<{slideIndex:number,prompt:string,fileId:string,url:string}>>>} artifactId → 生成结果
 */
export async function generateIllustrationsForArtifacts({ auth, context, artifacts, onProgress }) {
  const results = new Map();
  const targets = collectIllustrationTargets(artifacts);
  if (!targets.length) return results;

  // 门禁：和画布生图完全相同的那一套（课时能力 / 课堂开关 / 平台模态开关 / **算力池**）。
  // 任一条不满足就一张都不生成 —— 抛出去的 code 由调用方决定是提示还是静默。
  // units 传「这次一共打算出几张」：池子要按张数预估，不然一次任务算成 1 张会漏掉 2/3 的花费。
  assertGenerationPreflight({
    user: auth.rawUser, orgId: auth.user.orgId, context, modality: 'IMAGE',
    units: targets.reduce((total, target) => total + target.requests.length, 0),
  });

  const policy = getAiProviderPolicy();
  // 插画也是这个学生在花算力，同样按他的令牌走网关。
  const selection = await applyGatewayRoute(providerSelectionForModality(policy, 'IMAGE', ''), {
    orgId: auth.user.orgId, studentId: auth.user.id, lessonId: context?.lesson?.id || '', modality: 'IMAGE',
  });
  const provider = getGenerationProvider(selection);
  const seriesId = context?.series?.id || null;

  for (const target of targets) {
    const images = [];
    let index = 0;
    for (const request of target.requests) {
      index += 1;
      onProgress?.({ phase: 'image', done: index - 1, total: target.requests.length, prompt: request.prompt, artifactName: target.artifact.name });
      try {
        const generated = await provider.generate({
          modality: 'IMAGE',
          prompt: request.prompt,
          title: `${target.artifact.name} 插图${request.slideIndex + 1}`,
          userId: auth.user.id,
          // 幻灯片是 16:9，让上游按这个比例出图（模板里的 size 用得到）
          options: { aspectRatio: '16:9' },
        });
        const assetUrl = generated?.assets?.[0]?.assetUrl;
        const { buffer, mimeType } = await readAssetBytes(assetUrl);
        if (!buffer?.length || buffer.length > MAX_IMAGE_BYTES) throw errors.badRequest('生成的图片不可用', 'ILLUSTRATION_TOO_LARGE');
        const stored = await storeGeneratedAsset({
          buffer,
          mimeType,
          fileName: `illustration-${request.slideIndex + 1}.${extensionFor(mimeType)}`,
          ownerUserId: auth.user.id,
          ownerOrgId: auth.user.orgId,
          metadata: { source: 'vibecoding-illustration', artifactId: target.artifact.id, slideIndex: request.slideIndex, prompt: request.prompt, provider: provider.name, model: selection.model },
        });
        images.push({ slideIndex: request.slideIndex, prompt: request.prompt, fileId: stored.id, url: stored.url });
        // 插画以前**一条用量记录都不写**（交接说明里的老缺口：VibeCoding 插画完全无记录），
        // 于是「每节课花了多少」里少了这一块。现在按张记一笔，并计入算力池。
        recordAiUsage({
          orgId: auth.user.orgId, userId: auth.user.id, sessionId: context?.activeSession?.id || null,
          modality: 'IMAGE', model: selection.model, status: 'SUCCESS',
          costFen: priceFenFor({ modality: 'IMAGE', model: selection.model }), seriesId,
          pricing: { source: 'vibecoding-illustration', provider: provider.name, artifactId: target.artifact.id, slideIndex: request.slideIndex },
        });
      } catch (error) {
        // 单张失败不打断整体：记下来、这一页就不放图（界面上会说明有几张没做出来）。
        // 失败记 0 成本（不花学生的钱），但留一条记录以便看出「有哪些白花的调用」。
        recordAiUsage({
          orgId: auth.user.orgId, userId: auth.user.id, sessionId: context?.activeSession?.id || null,
          modality: 'IMAGE', model: selection.model, status: 'FAILED',
          failCode: error?.code || 'ILLUSTRATION_FAILED', costFen: 0, seriesId,
          pricing: { source: 'vibecoding-illustration', provider: provider.name, artifactId: target.artifact.id, slideIndex: request.slideIndex },
        });
        images.push({ slideIndex: request.slideIndex, prompt: request.prompt, error: String(error?.message || error).slice(0, 200) });
      }
    }
    results.set(target.artifact.id, images);
    onProgress?.({ phase: 'image', done: target.requests.length, total: target.requests.length, artifactName: target.artifact.name });
  }
  return results;
}
