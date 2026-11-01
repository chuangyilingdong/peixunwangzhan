// 平台配置：VibeCoding 全局系统提示词（2026-11-01）。
//
// 客户端契约：《给平台-课堂发送计数与全局提示词-20261101.md》第二节。
// 这里只管**存取与校验**，下发在 `routes/studentRuntime.js` 的 client-context 里
// （`globalPromptForClient()`），正文长度/敏感形态的规则全在 `services/vibecodingGlobalPrompt.js`。
//
// ⚠️ 为什么 GET 也回 `bytes` / `maxBytes` / `enabled`：后台要能直接显示"还能写多少"，
//    而"存进去但超限不下发"这种状态必须让运营看得见（否则会出现"我明明填了、学生端没生效"）。
import { audit, errors } from '../../lib.js';
import { readGlobalPromptRaw, saveGlobalPrompt } from '../../services/vibecodingGlobalPrompt.js';

export async function handlePlatformSettings(ctx, part, method) {
  if (part !== '/vibecoding-prompt') return null;

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
