import { useEffect, useState } from 'react';
import { ErrorState, Loading, Notice, Panel, useData, errorText } from '@platform/shared';

/**
 * 「AI 能力与价格 → 作品调用模型」（2026-11-03）。
 *
 * 这一页维护的是**作品运行时**用的模型：学生作品里的 LLM 桥在没填自己的 Key 时会走它。
 * ⚠️ 它**独立于上面的「渠道与价格」**：Agent 的渠道/路由/模型下拉不受这里影响，反之亦然。
 * ⚠️ Key 只写不读：保存后页面只显示「已配置」，永远不会回显 Key 正文。
 */
function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function WorksLlmPanel({ api }) {
  const config = useData(() => api.get('admin/works-llm'), [api]);
  const [form, setForm] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [test, setTest] = useState(null);

  useEffect(() => {
    const value = config.data?.config;
    if (!value) return;
    setForm({
      ...value,
      scopes: { classroom: true, preview: true, public: false, ...(value.scopes || {}) },
      quotas: { ...(value.quotas || {}) },
    });
  }, [config.data]);

  if (config.loading) return <Loading label="正在读取作品调用模型配置…" />;
  if (config.error) return <ErrorState error={config.error} onRetry={config.refresh} />;
  if (!form) return null;

  const keyConfigured = Boolean(config.data?.keyConfigured);
  const ready = Boolean(form.enabled && keyConfigured);
  const usage = config.data?.usage || { rows: [], calls: 0, inputTokens: 0, outputTokens: 0 };
  const update = (patch) => setForm((current) => ({ ...current, ...patch }));
  const updateScope = (name, checked) => setForm((current) => ({ ...current, scopes: { ...current.scopes, [name]: checked } }));
  const updateQuota = (name, value) => setForm((current) => ({ ...current, quotas: { ...current.quotas, [name]: numberValue(value, 0) } }));

  async function save() {
    setBusy(true); setMessage(''); setError('');
    try {
      const result = await api.put('admin/works-llm', {
        config: {
          enabled: Boolean(form.enabled),
          endpoint: String(form.endpoint || '').trim(),
          model: String(form.model || '').trim(),
          maxTokens: numberValue(form.maxTokens, 1024),
          temperature: numberValue(form.temperature, 0.7),
          timeoutMs: numberValue(form.timeoutMs, 60000),
          scopes: form.scopes,
          quotas: form.quotas,
        },
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setForm({
        ...result.config,
        scopes: { classroom: true, preview: true, public: false, ...(result.config?.scopes || {}) },
        quotas: { ...(result.config?.quotas || {}) },
      });
      setApiKey('');
      setMessage('已保存。新配置立即生效（在途请求不受影响）。');
      config.refresh();
    } catch (e) { setError(errorText(e.message || '保存失败')); } finally { setBusy(false); }
  }

  async function runTest() {
    setBusy(true); setTest(null); setMessage(''); setError('');
    try {
      const result = await api.post('admin/works-llm/test', {});
      setTest(result);
    } catch (e) { setError(errorText(e.message || '测试失败')); } finally { setBusy(false); }
  }

  async function clearKey() {
    if (!window.confirm('确定清除作品模型的 API Key？清除后所有作品都无法再调用平台模型。')) return;
    setBusy(true); setMessage(''); setError('');
    try {
      await api.delete('admin/works-llm/key');
      setMessage('已清除 Key。');
      config.refresh();
    } catch (e) { setError(errorText(e.message || '清除失败')); } finally { setBusy(false); }
  }

  return <>
    {message ? <Notice tone="success">{message}</Notice> : null}
    {error ? <Notice tone="danger">{error}</Notice> : null}
    <Notice tone={ready ? 'success' : 'warning'}>
      {ready
        ? '作品模型已启用，学生作品不需要自己填 Key。'
        : form.enabled
          ? '已启用，但还没有配置 API Key —— 作品调用会被拒绝。'
          : '未启用：作品里的 LLM 桥仍然只按「学生自己填的 Key 直连厂商」工作。'}
    </Notice>

    <Panel
      title="作品调用模型"
      actions={<div className="row-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={runTest}>{busy ? '测试中…' : '试一次'}</button>
        <button type="button" className="primary-button" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
      </div>}
    >
      <div className="notice info">
        这套配置<strong>只给作品运行时用</strong>，和上面的「渠道与价格」（Agent 的模型）互不影响。
        Key 只保存在服务端，作品文档里只有短期授权（grant）；停用开关一关，所有作品的平台模型调用立即失效。
      </div>
      <div className="form-grid top-gap">
        <label className="checkbox-label span-2">
          <input type="checkbox" checked={Boolean(form.enabled)} onChange={(event) => update({ enabled: event.target.checked })} />
          启用作品调用模型（总开关）
        </label>
        <label className="span-2">调用地址（必须是完整的 chat/completions 地址）
          <input value={form.endpoint || ''} onChange={(event) => update({ endpoint: event.target.value })} placeholder="https://open.bigmodel.cn/api/paas/v4/chat/completions" />
        </label>
        <label>模型 ID
          <input value={form.model || ''} onChange={(event) => update({ model: event.target.value })} placeholder="glm-4-flash-250414" />
        </label>
        <label>API Key {keyConfigured ? <span className="muted">（已配置，留空 = 不修改）</span> : <span className="danger-text">（未配置）</span>}
          <input type="password" value={apiKey} autoComplete="new-password" onChange={(event) => setApiKey(event.target.value)} placeholder={keyConfigured ? '留空保持当前 Key' : '粘贴平台 Key（只写不读）'} />
        </label>
        <label>单次最大输出 tokens
          <input type="number" min="1" max="4096" value={form.maxTokens ?? 1024} onChange={(event) => update({ maxTokens: numberValue(event.target.value, 1024) })} />
        </label>
        <label>温度
          <input type="number" min="0" max="2" step="0.1" value={form.temperature ?? 0.7} onChange={(event) => update({ temperature: numberValue(event.target.value, 0.7) })} />
        </label>
        <label>超时（毫秒）
          <input type="number" min="5000" max="120000" step="1000" value={form.timeoutMs ?? 60000} onChange={(event) => update({ timeoutMs: numberValue(event.target.value, 60000) })} />
        </label>
      </div>
      {keyConfigured ? <div className="row-actions top-gap"><button type="button" className="secondary-button" disabled={busy} onClick={clearKey}>清除 Key</button></div> : null}
      {test ? <Notice tone={test.ok ? 'success' : 'danger'}>{test.ok ? `连接成功（${test.latencyMs} ms）：${String(test.content || '').slice(0, 120)}` : `连接失败：${test.error || '未知原因'}`}</Notice> : null}
    </Panel>

    <Panel title="生效范围">
      <div className="notice info">关闭某一档 = 该入口签发的授权直接失效；已经打开的页面要刷新才会拿到新授权。</div>
      <label className="checkbox-label"><input type="checkbox" checked={Boolean(form.scopes?.classroom)} onChange={(event) => updateScope('classroom', event.target.checked)} />课堂内（学生实时预览）</label>
      <label className="checkbox-label"><input type="checkbox" checked={Boolean(form.scopes?.preview)} onChange={(event) => updateScope('preview', event.target.checked)} />老师端 / 平台端预览</label>
      <label className="checkbox-label"><input type="checkbox" checked={Boolean(form.scopes?.public)} onChange={(event) => updateScope('public', event.target.checked)} />作品广场 / 学生主页 / 分享页（公开、匿名）</label>
      <p className="muted top-gap">公开入口任何人都能打开作品并触发调用，请务必配限额；免费模型不等于无限。</p>
    </Panel>

    <Panel title="配额与限流">
      <div className="muted">0 = 不允许；所有计数按 UTC 自然日。</div>
      <div className="form-grid top-gap">
        <label>每学生每天
          <input type="number" min="0" value={form.quotas?.studentDaily ?? 200} onChange={(event) => updateQuota('studentDaily', event.target.value)} />
        </label>
        <label>每作品每天
          <input type="number" min="0" value={form.quotas?.workDaily ?? 500} onChange={(event) => updateQuota('workDaily', event.target.value)} />
        </label>
        <label>每 IP 每天（公开页）
          <input type="number" min="0" value={form.quotas?.ipDaily ?? 200} onChange={(event) => updateQuota('ipDaily', event.target.value)} />
        </label>
        <label>全平台每天
          <input type="number" min="0" value={form.quotas?.globalDaily ?? 5000} onChange={(event) => updateQuota('globalDaily', event.target.value)} />
        </label>
        <label>每秒并发（QPS）
          <input type="number" min="1" max="200" value={form.quotas?.qps ?? 5} onChange={(event) => updateQuota('qps', event.target.value)} />
        </label>
      </div>
    </Panel>

    <Panel title={`今日用量（${usage.day || '—'}）`}>
      <p className="muted">总调用 <strong>{Number(usage.calls || 0).toLocaleString()}</strong> 次 · 输入 {Number(usage.inputTokens || 0).toLocaleString()} tokens · 输出 {Number(usage.outputTokens || 0).toLocaleString()} tokens</p>
      {usage.rows?.length
        ? <div className="table-wrap"><table><thead><tr><th>范围</th><th>对象</th><th>次数</th><th>输入 tokens</th><th>输出 tokens</th></tr></thead><tbody>
          {usage.rows.map((row) => <tr key={`${row.scope}:${row.subjectId}`}><td>{row.scope}</td><td><code>{row.subjectId}</code></td><td>{row.calls}</td><td>{row.inputTokens}</td><td>{row.outputTokens}</td></tr>)}
        </tbody></table></div>
        : <p className="muted">今天还没有调用。</p>}
    </Panel>
  </>;
}
