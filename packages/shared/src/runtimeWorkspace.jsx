// 学生创作环境（dsh）：进环境、把作品交上来。
//
// 为什么单独一个文件：这是「平台侧拉起 / 取产物」那套接口**唯一的界面出口**
// （apps/server/src/routes/studentRuntime.js），与老的 VibeCoding 工作台是两条链
// （老工作台读平台库里的产物，这条读学生自己机器上的工作区）。
//
// ⚠️ 2026-09-17 的口径：**创作环境是「升级」不是入口**。
// VibeCoding 进去默认走平台自己的链路（没有沙箱、秒进），学生想要「AI 真的动手做出来」
// 时再点这里的「让 AI 真的做出来」把盒子开起来。所以这个文件现在是那个**升级点**的实现：
//   · 课程中心的入口按钮（RuntimeActions）与 VibeCoding 工作台里的按钮共用同一个 hook；
//   · **运行时没配好就不接管**：`/runtime/status` 说不可以用时一律渲染 null，
//     课程中心继续走平台链路 —— 学生入口永远不会因为这台机器没配好而变成点不动的按钮。
import { useEffect, useState } from 'react';
import { Notice } from './ui.jsx';

const KIND_LABEL = { html: '网页', pptx: 'PPT', docx: 'Word', xlsx: 'Excel' };

function sizeText(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 这台机器能不能开创作环境、学生现在有没有课上。
 * 失败一律当作「不可用」处理（不接管入口），**不把错误摊到界面**上 ——
 * 它不是学生能处理的东西，弹出来只会让人以为整个课堂坏了。
 */
export function useRuntimeStatus(api) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve(api.get('student/runtime/status'))
      .then((data) => { if (alive) setStatus(data || { available: false }); })
      .catch(() => { if (alive) setStatus({ available: false }); });
    return () => { alive = false; };
  }, [api]);
  return { status, ready: Boolean(status?.available) && Boolean(status?.classroom) };
}

// 「正在开环境」这件事必须能**跨页面刷新**记住（2026-09-17 实测踩到）。
// 前端那个按钮本来是禁用着的（busy 期间点不动），但学生看到一直转圈会**刷新页面**，
// 刷新之后组件的忙状态归零、按钮又能点了 —— 而服务器上第一个请求还在跑。
// 于是一次「进不去」变成了三个开环境脚本互抢同一个 systemd 单元，环境起来了、
// 入口却没写成，前端永远卡在「正在开环境…」。用 sessionStorage 把这个状态钉住：
// 最近一次点过、且还没超过保护窗口，就继续显示「正在开环境…」并且不让再点。
const LAUNCH_KEY = 'dsh-launch-started-at';
const LAUNCH_GUARD_MS = 170 * 1000;   // 比服务端 90 秒超时 + nginx 180 秒都留出余量

/**
 * 「开创作环境」这件事的**唯一实现**：课程中心的入口按钮与 VibeCoding 工作台里的
 * 「让 AI 真的做出来」两处共用同一份 —— 两处各写一份的话，忙状态、超时、
 * sessionStorage 那几个坑迟早只在一边被修好（这几种坑我们已经踩过一遍了）。
 *
 * @returns {{ launching: boolean, elapsed: number, message: string, launch: () => Promise<void>, clearMessage: () => void }}
 *   `launch()` 成功时会**新标签页**打开学生自己的盒子（创作环境不该顶掉我们的页面）。
 */
export function useRuntimeLaunch(api, { enabled = true } = {}) {
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState('');
  const [elapsed, setElapsed] = useState(0);

  // 刷新后接着显示「正在开环境…」（服务器上那个请求没因为刷新而停下）
  useEffect(() => {
    const startedAt = Number((typeof sessionStorage !== 'undefined' && sessionStorage.getItem(LAUNCH_KEY)) || 0);
    if (startedAt && Date.now() - startedAt < LAUNCH_GUARD_MS) setLaunching(true);
  }, []);
  // 计时：让「正在开环境」看起来是在干活，而不是死住了
  useEffect(() => {
    if (!launching) { setElapsed(0); return undefined; }
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [launching]);

  async function launch() {
    if (!enabled || launching) return;
    setLaunching(true); setMessage(''); setElapsed(0);
    try { sessionStorage.setItem(LAUNCH_KEY, String(Date.now())); } catch { /* 隐私模式等，忽略 */ }
    try {
      // 给这次请求设超时：服务端开环境最长 90 秒 + 探针几秒，超过就不等了、明确报错。
      // 不设的话它会一直挂着，学生只能反复刷新重试 —— 那正是并发互撞的来源。
      const launched = await api.post('student/runtime/launch', undefined, { timeoutMs: LAUNCH_GUARD_MS });
      if (launched?.edgeUrl) {
        // 新标签页打开：创作环境是学生自己的一个「盒子」，不该顶掉我们的页面
        window.open(launched.edgeUrl, '_blank', 'noopener,noreferrer');
      }
      if (launched?.localOnly) setMessage('创作环境给的是本机地址，只有服务器上能打开 —— 请联系老师（这台机器还没配对外入口）。');
    } catch (error) { setMessage(error.message || '进入创作环境失败'); }
    finally {
      try { sessionStorage.removeItem(LAUNCH_KEY); } catch { /* 忽略 */ }
      setLaunching(false);
    }
  }

  return { launching, elapsed, message, launch, clearMessage: () => setMessage('') };
}

export function RuntimeActions({ api, lesson, canEnter }) {
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [picker, setPicker] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [report, setReport] = useState(null);
  const launchState = useRuntimeLaunch(api, { enabled: canEnter });
  const disabled = !canEnter || Boolean(busy) || launchState.launching;

  async function openPicker() {
    setBusy('list'); setMessage(''); setReport(null);
    try {
      const listed = await api.get('student/runtime/deliverables');
      if (!listed?.deliverables?.length) {
        setMessage('创作环境里还没有能交的作品。先做出一个网页或 PPT，再回来提交。');
      } else {
        setPicker(listed);
      }
    } catch (error) { setMessage(error.message || '读取作品列表失败'); }
    finally { setBusy(''); }
  }

  async function submit(item) {
    setConfirming(null); setBusy('submit');
    try {
      const submitted = await api.post('student/runtime/submit', { name: item.name, copyrightConfirmed: true });
      setReport({ ok: true, item, submitted });
    } catch (error) {
      setReport({ ok: false, item, message: error.message || '提交失败' });
    } finally { setBusy(''); }
  }

  return <>
    <button className={canEnter ? 'primary-button' : 'secondary-button'} disabled={disabled} onClick={launchState.launch}>
      {launchState.launching ? `正在开环境…${launchState.elapsed ? ` ${launchState.elapsed}s` : ''}` : '让 AI 真的做出来'}
    </button>
    <button className="secondary-button" disabled={disabled} onClick={openPicker}>
      {busy === 'list' ? '读取中…' : busy === 'submit' ? '提交中…' : '提交作品'}
    </button>
    {(message || launchState.message) && <p className="lesson-block-reason">{message || launchState.message}</p>}

    {picker ? <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-content">
        <div className="modal-header">
          <div>
            <span className="eyebrow">提交作品</span>
            <h2>交哪一份？</h2>
          </div>
          <button className="modal-close" onClick={() => setPicker(null)} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <p className="muted">这些是创作环境里现在能交的作品。交上来之后你可以继续改，改了再交一次就是覆盖（轮次 +1）。</p>
          <div className="card-list">
            {picker.deliverables.map((item) => <div className="item-card" key={item.name}>
              <div className="row-actions">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ margin: 0 }}>{item.name}</h3>
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    {KIND_LABEL[item.kind] || item.kind} · {sizeText(item.bytes)}{item.recommended ? ' · 建议交这一份' : ''}
                  </p>
                </div>
                <button className="primary-button" disabled={Boolean(busy)} onClick={() => setConfirming(item)}>选这份</button>
              </div>
            </div>)}
          </div>
          {/* 「看到了但不能给你」的东西也如实说：超限、符号链接都在 skipped 里 */}
          {picker.skipped?.length ? <Notice tone="warning">
            另有 {picker.skipped.length} 个文件不能作为作品提交：{picker.skipped.slice(0, 5).map((item) => item.name).join('、')}{picker.skipped.length > 5 ? ' 等' : ''}。
          </Notice> : null}
          {picker.truncated ? <Notice tone="warning">创作环境里的文件太多，这次只列出了一部分。</Notice> : null}
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={() => setPicker(null)}>取消</button>
        </div>
      </div>
    </div> : null}

    {confirming ? <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-content">
        <div className="modal-header">
          <div>
            <span className="eyebrow">提交作品</span>
            <h2>确认交《{confirming.name}》？</h2>
          </div>
          <button className="modal-close" onClick={() => setConfirming(null)} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <Notice tone="info">
            提交即确认：这是<strong>你自己的作品</strong>，并同意平台在<strong>作品广场</strong>展示它。
            提交后你仍然可以继续修改，再交一次就是新的一版。
          </Notice>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={() => setConfirming(null)}>再看看</button>
          <button className="primary-button" onClick={() => submit(confirming)}>确认提交</button>
        </div>
      </div>
    </div> : null}

    {report ? <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-content">
        <div className="modal-header">
          <div>
            <span className="eyebrow">提交结果</span>
            <h2>{report.ok ? `《${report.item.name}》已交给平台` : '这次没交上'}</h2>
          </div>
          <button className="modal-close" onClick={() => setReport(null)} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          {report.ok ? <>
            <Notice tone="success">
              老师平台已经收到。作品先由平台审核，发布后会在作品广场上出现。
            </Notice>
            {report.submitted?.warnings?.length ? <Notice tone="warning">
              <strong>但有几件事要说清楚：</strong>
              <ul>{report.submitted.warnings.map((text) => <li key={text}>{text}</li>)}</ul>
            </Notice> : null}
            {report.submitted?.missing?.length ? <Notice tone="warning">
              这些文件没跟着交上来（创作环境里没找到或读不到）：{report.submitted.missing.slice(0, 8).join('、')}
              {report.submitted.missing.length > 8 ? ' 等' : ''}。
            </Notice> : null}
          </> : <Notice tone="danger">{report.message}</Notice>}
        </div>
        <div className="modal-footer">
          <button className="primary-button" onClick={() => setReport(null)}>知道了</button>
        </div>
      </div>
    </div> : null}
  </>;
}
