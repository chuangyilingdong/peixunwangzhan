// 平台配置：VibeCoding 全局系统提示词（2026-11-01）+ 作品调用模型（2026-11-03）。
//
// 客户端契约：
//   · 全局提示词见《给平台-课堂发送计数与全局提示词-20261101.md》第二节；
//   · 作品调用模型见 `docs/architecture/作品调用模型-20261103.md`。
//
// 这里只管**存取与校验**：全局提示词的下发在 `routes/studentRuntime.js` 的 client-context；
// 作品模型的 Key 走 providerSecret，调用在 `routes/workLlm.js` + `services/workLlm.js`。
//
// ⚠️ 作品模型配置**独立于 ai_provider_policy**：Agent 的渠道/路由/模型下拉一概不动。
// ⚠️ Key 只写不读：GET 永远不返回 Key 正文，只回 `keyConfigured`。
import { audit, errors } from '../../lib.js';
import { readGlobalPromptRaw, saveGlobalPrompt } from '../../services/vibecodingGlobalPrompt.js';
import {
  clearWorksLlmKey,
  readWorksLlmConfig,
  saveWorksLlmConfig,
  saveWorksLlmKey,
  testWorksLlm,
  worksLlmAdminView,
} from '../../services/workLlm.js';

async function handleGlobalPrompt(ctx, method) {
  if (method === 'GET') return readGlobalPromptRaw();
  if (method === 'PUT') {
    const body = ctx.body || {};
    // 正文是明文直接进模型上下文的，所以写操作要有审计（谁能改、改前改后各是什么）。
    const before = await readGlobalPromptRaw();
    try {
      const after = await saveGlobalPrompt({ prompt: body.prompt, revision: body.revision });
      await audit(ctx, 'VIBECODING_GLOBAL_PROMPT_UPDATE', 'PLATFORM_SETTING', 'vibecoding-prompt',
        { revision: before.revision, bytes: before.bytes }, { revision: after.revision, bytes: after.bytes });
      return after;
    } catch (error) {
      // services 里抛的是带 code/status 的普通 Error，转成平台统一的 ApiError 形状
      if (error?.code) throw errors.badRequest(error.message, error.code);
      throw error;
    }
  }
  return null;
}

async function handleWorksLlm(ctx, part, method) {
  if (part === '/works-llm' && method === 'GET') return await worksLlmAdminView();

  if (part === '/works-llm' && method === 'PUT') {
    const body = ctx.body || {};
    const before = await readWorksLlmConfig();
    const after = await saveWorksLlmConfig(body.config && typeof body.config === 'object' ? body.config : body);
    if (String(body.apiKey || '').trim()) saveWorksLlmKey(body.apiKey);
    await audit(ctx, 'WORKS_LLM_CONFIG_UPDATE', 'PLATFORM_SETTING', 'works-llm',
      { enabled: before.enabled, endpoint: before.endpoint, model: before.model, scopes: before.scopes, quotas: before.quotas },
      {
        enabled: after.enabled, endpoint: after.endpoint, model: after.model, scopes: after.scopes, quotas: after.quotas,
        keyUpdated: Boolean(String(body.apiKey || '').trim()),
      });
    return await worksLlmAdminView();
  }

  if (part === '/works-llm/key' && method === 'DELETE') {
    const removed = clearWorksLlmKey();
    await audit(ctx, 'WORKS_LLM_KEY_CLEAR', 'PLATFORM_SETTING', 'works-llm', { keyConfigured: true }, { keyConfigured: false, removed });
    return await worksLlmAdminView();
  }

  if (part === '/works-llm/test' && method === 'POST') return await testWorksLlm();

  return null;
}

export async function handlePlatformSettings(ctx, part, method) {
  if (part === '/vibecoding-prompt') return await handleGlobalPrompt(ctx, method);
  if (part.startsWith('/works-llm')) return await handleWorksLlm(ctx, part, method);
  return null;
}
