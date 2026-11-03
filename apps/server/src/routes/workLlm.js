/**
 * 作品调用模型的运行时入口（2026-11-03）
 *
 * 只有一条：`POST /api/works-llm/chat`。
 * 调用方是**学生作品里的 LLM 桥**（沙箱文档，Origin: null），所以这里显式回 `ACAO: null`；
 * 不带 cookie、不读会话 —— 身份全在 grant 里（短期、按作品/课堂作用域签发）。
 *
 * 为什么不复用 `/api/gateway/v1/chat/completions`：那条要求「课堂 ACTIVE + 学生运行时密钥 + 名单」，
 * 课后、老师预览、广场/主页都没有这些条件。这条是给"作品"用的，门禁按 grant 的 scope 分开。
 */
import { arow, errors } from '../lib.js';
import {
  callWorksLlm,
  checkWorksLlmQuota,
  recordWorksLlmUsage,
  verifyWorksLlmGrant,
} from '../services/workLlm.js';

function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

export async function handleWorksLlm(ctx) {
  if (ctx.pathname !== '/api/works-llm/chat' || ctx.method !== 'POST') return null;
  // 沙箱是 opaque origin（Origin: null）。只放行这条、只放行 POST；无 cookie、无 credentials。
  ctx.extraHeaders = {
    'access-control-allow-origin': 'null',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-max-age': '600',
  };

  const body = ctx.body || {};
  const grant = verifyWorksLlmGrant(body.grant);
  if (!grant) throw errors.forbidden('作品模型授权无效或已过期，请刷新页面再试', 'WORK_LLM_GRANT_INVALID');

  const scope = grant.scope;
  let subjectId = grant.subject;
  if (scope === 'classroom') {
    // 每次调用都重验：课堂还在进行、学生还在名单（老师一结束课堂就立刻失效）。
    const session = await arow(
      `SELECT session.id FROM class_sessions session
         JOIN session_students part ON part.session_id=session.id AND part.student_id=?
        WHERE session.id=? AND session.status='ACTIVE' AND part.status <> 'REMOVED'`,
      [grant.uid, grant.room],
    );
    if (!session) throw errors.forbidden('这节课已经结束，作品模型不再可用', 'WORK_LLM_CLASSROOM_CLOSED');
    subjectId = grant.uid;
  } else if (scope === 'preview' || scope === 'public') {
    // 签发方（org/admin/公开作品接口）已经验过权限；这里只确认作品还在。
    const work = await arow('SELECT id FROM vibecoding_submissions WHERE id=?', [grant.work]);
    if (!work) throw errors.notFound('作品不存在', 'WORK_LLM_WORK_NOT_FOUND');
    subjectId = grant.work;
  } else {
    throw errors.forbidden('作品模型授权范围无效', 'WORK_LLM_SCOPE_INVALID');
  }

  const ip = clientIp(ctx.req);
  const quota = await checkWorksLlmQuota({ scope, subjectId, ip });
  if (!quota.ok) return { ok: false, code: quota.code, error: quota.message };

  const result = await callWorksLlm({ messages: body.messages, temperature: body.temperature, json: body.json === true });
  if (!result.ok) return result;
  await recordWorksLlmUsage({ scope, subjectId, ip, usage: result.usage });
  return result;
}
