/**
 * 平台级 VibeCoding 全局系统提示词（2026-11-01，客户端契约
 * 《给平台-课堂发送计数与全局提示词-20261101.md》第二节）。
 *
 * 客户端怎么用：`GET /api/student/runtime/client-context` 里带
 *   `globalSystemPrompt` / `globalSystemPromptRevision`；
 * 客户端把它原子写入独立文件，新建任务/新 runtime 时作为一个**独立 system section** 追加，
 * 主 Agent 与子 Agent 都生效。平台提示词不替换内置安全边界，也不给学生编辑。
 *
 * 四条硬约束（全部在这里兜住，不要指望调用方记得）：
 *   ① **正文 ≤ 32 KiB UTF-8**。超了整段作废（不是截断）—— 客户端契约明确"超过 32 KiB 时
 *      不出现半截提示词"。所以这里宁可返回空，也不返回被切一半的规则。
 *   ② **空字符串/缺失 = 不启用**：字段整块不下发（客户端看到 undefined 即"没有"）。
 *   ③ **revision 只用于诊断**：绝不拼进模型上下文，也别拿它当版本号做逻辑分支。
 *   ④ **不放敏感信息**：接口层做一次显然的密钥形态拦截（见 assertNoSecretShapes），
 *      真正的内容审查仍要运营自己把关 —— 这段正文会直接进模型上下文。
 */
import { arow, aq } from '../lib.js';

export const GLOBAL_PROMPT_MAX_BYTES = 32 * 1024;

/** revision 的形态约束：短字符串、只用于日志。太长就截断（它不是正文）。 */
const MAX_REVISION_LENGTH = 64;

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

/**
 * 明显的密钥形态（不是穷举，只挡"一眼就是密钥"的那种 —— 契约要求不放敏感数据）。
 * 命中就拒，不做自动脱敏：脱敏过的提示词语义会变形，不如让运营改。
 */
function assertNoSecretShapes(prompt) {
  const patterns = [
    /sk-[A-Za-z0-9_-]{16,}/,            // OpenAI / DeepSeek 一类
    /AKIA[0-9A-Z]{16}/,                 // AWS Access Key
    /(?:LTAI|STS\.)[A-Za-z0-9]{12,}/,    // 阿里云 AccessKey / STS
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b\d{17}[\dXx]\b/,                 // 中国大陆身份证号
    /\b1[3-9]\d{9}\b/,                  // 手机号
  ];
  for (const pattern of patterns) {
    if (pattern.test(prompt)) {
      const error = new Error('提示词里疑似包含密钥/手机号/身份证号，请删掉后再保存');
      error.code = 'GLOBAL_PROMPT_SENSITIVE';
      error.status = 400;
      throw error;
    }
  }
}

/** 原样读库（不做长度/内容校验）—— 给接口与诊断用，便于运营看到"存进去的到底是什么"。 */
export async function readGlobalPromptRaw() {
  const row = await arow('SELECT vibecoding_global_prompt, vibecoding_global_prompt_revision, updated_at FROM platform_settings WHERE id=1');
  const prompt = String(row?.vibecoding_global_prompt || '');
  return {
    prompt,
    revision: String(row?.vibecoding_global_prompt_revision || ''),
    updatedAt: row?.updated_at || null,
    bytes: byteLength(prompt),
    maxBytes: GLOBAL_PROMPT_MAX_BYTES,
    enabled: prompt.trim().length > 0 && byteLength(prompt) <= GLOBAL_PROMPT_MAX_BYTES,
  };
}

/**
 * 下发用：返回要并进 client-context 的两个字段。
 * 空 / 超限（历史脏数据）→ 返回空对象（整块不下发，客户端按"没有"处理）。
 */
export async function globalPromptForClient() {
  const raw = await readGlobalPromptRaw();
  if (!raw.enabled) {
    if (raw.prompt && raw.bytes > GLOBAL_PROMPT_MAX_BYTES) {
      console.warn(`[全局提示词] 库里那段有 ${raw.bytes} 字节，超过上限 ${GLOBAL_PROMPT_MAX_BYTES}，本次不下发`);
    }
    return {};
  }
  return {
    globalSystemPrompt: raw.prompt,
    // ⚠️ 只进日志/诊断，客户端不把它拼进上下文
    globalSystemPromptRevision: raw.revision || raw.updatedAt || '',
  };
}

/**
 * 保存。`prompt` 传空字符串 = 清空（客户端下一次新建任务就不再有旧提示词）。
 * `revision` 不传就用保存时刻（ISO）—— 它只是诊断标识，不是业务版本号。
 */
export async function saveGlobalPrompt({ prompt, revision } = {}) {
  const text = String(prompt ?? '');
  if (byteLength(text) > GLOBAL_PROMPT_MAX_BYTES) {
    const error = new Error(`提示词不能超过 ${GLOBAL_PROMPT_MAX_BYTES / 1024} KiB（当前 ${(byteLength(text) / 1024).toFixed(1)} KiB）`);
    error.code = 'GLOBAL_PROMPT_TOO_LARGE';
    error.status = 400;
    throw error;
  }
  if (text.trim()) assertNoSecretShapes(text);
  const now = new Date().toISOString();
  const rev = String(revision ?? '').trim().slice(0, MAX_REVISION_LENGTH) || now;
  await aq(
    'UPDATE platform_settings SET vibecoding_global_prompt=?, vibecoding_global_prompt_revision=?, updated_at=? WHERE id=1',
    [text, rev, now],
  );
  return readGlobalPromptRaw();
}
