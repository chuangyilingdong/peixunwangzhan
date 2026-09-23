import { useEffect, useMemo, useState } from 'react';
import { ErrorState, Loading, Notice, Panel, useData, errorText } from '@platform/shared';

/**
 * 「AI 能力与价格 → 模型显示名」（2026-09-23 用户口径）。
 *
 * 用户原话：「AI能力与价格页面能否有个单独配置页面来配置映射名字，比如这边显示的是 deepseek-flash，
 *   我可以自定义给这个模型取名，然后在画布或者 vibecoding 课堂模型名字这里可以映射我改过的名字」。
 *
 * 这一页只做一件事：**模型 ID → 显示名**。读写的是同一份 AI 渠道策略里的 `modelDisplayNames`
 * （`PUT admin/billing-config/ai-provider` —— 与「渠道与价格」是同一份配置，**不另造写接口**，
 * 也就不会出现"两处各存一份、改了一边另一边不知道"的老问题）。
 *
 * ⚠️ 三条要记住的：
 *   ① 它只改**给人看的字样**：画布框体那两处（标题行的配置标签 + 参数胶囊）与 VibeCoding 课堂的
 *      模型下拉。**发给上游的永远是真 ID** —— 填错了最坏是显示成你填的名字，不会把请求打歪。
 *   ② 显示名在**每次下发时现算**（服务端 lib.js 的 `modelDisplayName`），所以保存完学生刷新就见效，
 *      **不需要重新发布课包**；反过来，这里改完也不会动任何已发布的快照内容。
 *   ③ 清空 = 恢复原来的名字（没配就用渠道里那个技术名）。
 *
 * 列表里的模型来自**各渠道已启用的模型**（`channel.models` + 渠道默认模型）——那是"真的会被用到"的那批；
 * 「读取模型」拿回来的几百条候选**不列在这**（它们没启用，学生永远看不到）。
 */
export function ModelNamePanel({ api }) {
  const config = useData(() => api.get('admin/billing-config/ai-provider'), [api]);
  // ⚠️ 这个接口回的是**包装体** `{ policy, capabilityDefaults, ... }` —— 策略在 `.policy` 里。
  //    第一版读成了 `config.data.modelDisplayNames`（少一层），页面就一直是"还没有渠道启用模型"的空状态，
  //    而接口其实是好的（与第十六轮那次"把包装体当内容用"是同一个形状的坑，别再少读这一层）。
  const policy = config.data?.policy;
  const [names, setNames] = useState({});
  const [saved, setSaved] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!policy) return;
    // 只取**有值的**别名（空串等于没配 —— 与服务端消毒口径一致）
    const initial = Object.fromEntries(Object.entries(policy.modelDisplayNames || {}).filter(([, value]) => String(value || '').trim()));
    setNames(initial);
    setSaved(initial);
  }, [policy]);

  /** 模型清单：各渠道已启用的模型 + 渠道默认模型 + 已经配过别名的（别让改过名的模型从这里消失）。 */
  const models = useMemo(() => {
    if (!policy) return [];
    const byId = new Map();
    for (const channel of policy.channels || []) {
      const ids = [...(Array.isArray(channel.models) ? channel.models : []), channel.model].map((id) => String(id || '').trim()).filter(Boolean);
      for (const id of new Set(ids)) {
        const item = byId.get(id) || { id, channels: [] };
        if (channel.name && !item.channels.includes(channel.name)) item.channels.push(channel.name);
        byId.set(id, item);
      }
    }
    for (const id of Object.keys(names)) if (!byId.has(id)) byId.set(id, { id, channels: [] });
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [policy, names]);

  const dirty = useMemo(() => JSON.stringify(names) !== JSON.stringify(saved), [names, saved]);
  const aliasOf = (id) => String(names[id] || '').trim();

  async function save() {
    setBusy(true); setMessage(''); setError('');
    try {
      // 与「渠道与价格」那一页**同一条保存路径**、同一个载荷形状：整份策略 PUT 回去
      // （apiKey 传空串 = 保留原密钥；空串的显示名会被服务端丢掉 = 恢复原名）。
      await api.put('admin/billing-config/ai-provider', { ...policy, apiKey: '', reason: '模型显示名', modelDisplayNames: names });
      setMessage('已保存。学生端刷新后就是新名字（不用重新发布课包）。');
      setSaved(names);
      config.refresh();
    } catch (e) { setError(errorText(e.message || '保存失败')); } finally { setBusy(false); }
  }

  if (config.loading) return <Loading label="正在读取渠道配置…" />;
  if (config.error) return <ErrorState error={config.error} onRetry={config.refresh} />;

  return <>
    {message ? <Notice tone="success">{message}</Notice> : null}
    {error ? <Notice tone="danger">{error}</Notice> : null}
    <Panel title="模型 ID → 学生看到的显示名" actions={<div className="row-actions"><button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => setNames(saved)}>撤销改动</button><button type="button" className="primary-button" disabled={busy || !dirty} onClick={save}>{busy ? '保存中…' : '保存'}</button></div>}>
      {/* ⚠️ 这里列的是**各渠道已启用的模型**（真的会被用到的那些）。要让新模型出现在这里，
          先去「渠道与价格」把它勾进某个渠道。 */}
      {!models.length ? <Notice tone="info">还没有任何渠道启用模型 —— 先去「渠道与价格」里添加渠道并勾选可用模型，再回来给它们取名字。</Notice> : <>
        <div className="notice info">共 <strong>{models.length}</strong> 个已启用的模型。显示名只影响<strong>学生看到的字样</strong>：画布框体标题那行与参数胶囊、VibeCoding 课堂的模型下拉。清空 = 恢复原名。</div>
        <div className="table-wrap top-gap"><table><thead><tr><th>模型 ID（发给上游的就是它）</th><th>用在哪些渠道</th><th>显示名（留空 = 用原名）</th><th>画布上会显示</th></tr></thead><tbody>
          {models.map((item) => <tr key={item.id}>
            <td><code>{item.id}</code></td>
            <td className="muted">{item.channels.length ? item.channels.join('、') : '（已配别名，当前没勾在任何渠道）'}</td>
            <td><input value={names[item.id] || ''} maxLength={40} placeholder="例如：飞闪" onChange={(event) => setNames((current) => ({ ...current, [item.id]: event.target.value }))} /></td>
            <td>{aliasOf(item.id) || item.id}</td>
          </tr>)}
        </tbody></table></div>
        <div className="row-actions top-gap"><button type="button" className="primary-button" disabled={busy || !dirty} onClick={save}>{busy ? '保存中…' : '保存显示名'}</button>{dirty ? <span className="muted">有未保存的改动</span> : <span className="muted">已与服务器一致</span>}</div>
      </>}
    </Panel>
    <Panel title="这一栏改了什么、没改什么">
      <p className="muted">· 改的是：画布框体标题那行（<code>生视频 · 480P · MiniMax-H3 · 首尾帧</code> 里的模型那一段）、框体参数胶囊、以及 VibeCoding 课堂里的模型下拉。</p>
      <p className="muted">· 没改的是：调用上游时发的模型 ID、课包/课时里存的模型、发布快照里的内容 —— 所以改名字不会影响生成结果，也不用重新发布课包。</p>
      <p className="muted">· 改完学生<strong>刷新页面</strong>就能看到新名字；正在上课的学生下一次打开画布/课堂也是新名字。</p>
    </Panel>
  </>;
}
