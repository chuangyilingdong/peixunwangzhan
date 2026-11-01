import { useEffect, useState } from 'react';
import { ErrorState, Loading, Notice, Panel, useData, errorText } from '@platform/shared';

/**
 * 「AI 能力与价格 → 全局提示词」（2026-11-01）。
 *
 * 客户端契约：《给平台-课堂发送计数与全局提示词-20261101.md》第二节。
 * 这一页只做一件事：维护**平台级 VibeCoding 全局系统提示词**，正文由
 * `client-context.globalSystemPrompt` 下发，客户端在新建任务/新 runtime 时把它作为一个
 * 独立 system section 追加给主 Agent 与子 Agent。
 *
 * ⚠️ 四条必须让运营看见的事（页面上都写了，别删）：
 *   ① 上限 **32 KiB（UTF-8 字节，不是字数）** —— 中文一个字 3 字节，所以"一万多字"就到顶；
 *   ② **空 = 不启用**：清空保存后，新任务不再带任何旧提示词；
 *   ③ **只影响新任务**：已经开着的会话保持原提示词（客户端刻意不重建 system 上下文）；
 *   ④ 正文会**明文直接进模型上下文** —— 不要放密钥、手机号、身份证号（服务端会拒收这两类形态）。
 */
function utf8Bytes(text) {
  // 不能用 text.length：中文/emoji 的字节数远大于字符数，而这个上限是按**字节**定的。
  try { return new TextEncoder().encode(text).length; } catch { return text.length * 3; }
}

export function VibecodingPromptPanel({ api }) {
  const config = useData(() => api.get('admin/vibecoding-prompt'), [api]);
  const [prompt, setPrompt] = useState('');
  const [saved, setSaved] = useState('');
  const [savedRevision, setSavedRevision] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!config.data) return;
    const text = String(config.data.prompt || '');
    setPrompt(text);
    setSaved(text);
    setSavedRevision(String(config.data.revision || ''));
  }, [config.data]);

  const bytes = utf8Bytes(prompt);
  const maxBytes = Number(config.data?.maxBytes) || 32 * 1024;
  const over = bytes > maxBytes;
  const dirty = prompt !== saved;

  async function save(next) {
    setBusy(true); setMessage(''); setError('');
    try {
      const result = await api.put('admin/vibecoding-prompt', { prompt: next });
      setSaved(String(result?.prompt || ''));
      setPrompt(String(result?.prompt || ''));
      setSavedRevision(String(result?.revision || ''));
      setMessage(next.trim() ? '已保存。学生开新任务时就会带上这段提示词（已开着的会话不变）。' : '已清空。学生开新任务时不再带平台提示词。');
      config.refresh();
    } catch (e) { setError(errorText(e.message || '保存失败')); } finally { setBusy(false); }
  }

  if (config.loading) return <Loading label="正在读取全局提示词…" />;
  if (config.error) return <ErrorState error={config.error} onRetry={config.refresh} />;

  return <>
    {message ? <Notice tone="success">{message}</Notice> : null}
    {error ? <Notice tone="danger">{error}</Notice> : null}
    <Panel
      title="VibeCoding 全局系统提示词"
      actions={<div className="row-actions">
        <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => setPrompt(saved)}>撤销改动</button>
        <button type="button" className="primary-button" disabled={busy || !dirty || over} onClick={() => save(prompt)}>{busy ? '保存中…' : '保存'}</button>
      </div>}
    >
      <div className="notice info">
        这段文字会作为<strong>独立的 system 段</strong>追加到客户端的 Agent 提示词里（主 Agent 与子 Agent 都生效），
        不会替换内置的安全边界，也不会显示给学生编辑。<strong>只影响新任务</strong>：已经开着的会话保持原提示词，新任务/重连/重登后才是新内容。
      </div>
      <textarea
        value={prompt}
        rows={14}
        spellCheck={false}
        placeholder="例如：回答必须使用简体中文；不要给出与课程无关的联网操作建议；涉及个人信息时提醒学生不要上传……（留空 = 不启用）"
        onChange={(event) => setPrompt(event.target.value)}
        style={{ width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.6 }}
      />
      <div className="row-actions top-gap">
        <span className={over ? 'danger-text' : 'muted'}>
          {bytes.toLocaleString()} / {maxBytes.toLocaleString()} 字节（UTF-8，中文按 3 字节算）
        </span>
        {over ? <span className="danger-text">已超过上限，保存会被拒绝（不会截断成半截提示词）</span> : null}
        {dirty ? <span className="muted">有未保存的改动</span> : <span className="muted">已与服务器一致</span>}
      </div>
      {savedRevision ? <p className="muted top-gap">当前 revision：<code>{savedRevision}</code>（只用于诊断日志，不会进入模型上下文）</p> : null}
      <div className="row-actions top-gap">
        <button type="button" className="secondary-button" disabled={busy || !saved} onClick={() => save('')}>清空提示词</button>
      </div>
    </Panel>
    <Panel title="这一栏改了什么、没改什么">
      <p className="muted">· 改的是：客户端新建任务时追加的那段平台 system 提示词。</p>
      <p className="muted">· 没改的是：平台内置的安全边界、每节课自己的预设提示词按钮、模型参数 —— 那些各有各的入口。</p>
      <p className="muted">· 不要在这里放密钥、手机号、身份证号：正文会明文进入模型上下文，服务端也会拒收这几类形态。</p>
      <p className="muted">· 保存后学生<strong>开新任务</strong>才生效；想立刻验证可以让学生重登一次。</p>
    </Panel>
  </>;
}
