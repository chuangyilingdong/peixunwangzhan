// 学生创作环境（dsh）：进环境、把作品交上来。
//
// 为什么单独一个文件：这是「平台侧拉起 / 取产物」那套接口**唯一的界面出口**
// （apps/server/src/routes/studentRuntime.js），与老的 VibeCoding 工作台是两条链
// （老工作台读平台库里的产物，这条读学生自己机器上的工作区）。
//
// 一条刻意的设计：**运行时没配好就不接管入口**。`/runtime/status` 说不可用（这台机器没装宿主
// 脚本、或学生当前没有进行中的课堂）时，这里一律渲染 null，让课程中心继续用它原来的
// 「进入课堂」—— 学生入口不会因为这次迁移而变成点不动的按钮。
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

export function RuntimeActions({ api, lesson, canEnter }) {
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [picker, setPicker] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [report, setReport] = useState(null);
  const disabled = !canEnter || Boolean(busy);

  async function enterEnvironment() {
    if (!canEnter) return;
    setBusy('enter'); setMessage(''); setReport(null);
    try {
      const launched = await api.post('student/runtime/launch');
      if (launched?.edgeUrl) {
        // 新标签页打开：创作环境是学生自己的一个「盒子」，不该顶掉我们的页面
        window.open(launched.edgeUrl, '_blank', 'noopener,noreferrer');
      }
      if (launched?.localOnly) setMessage('创作环境给的是本机地址，只有服务器上能打开 —— 请联系老师（这台机器还没配对外入口）。');
    } catch (error) { setMessage(error.message || '进入创作环境失败'); }
    finally { setBusy(''); }
  }

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
    <button className={canEnter ? 'primary-button' : 'secondary-button'} disabled={disabled} onClick={enterEnvironment}>
      {busy === 'enter' ? '正在开环境…' : '进入创作环境'}
    </button>
    <button className="secondary-button" disabled={disabled} onClick={openPicker}>
      {busy === 'list' ? '读取中…' : busy === 'submit' ? '提交中…' : '提交作品'}
    </button>
    {message && <p className="lesson-block-reason">{message}</p>}

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
