// 作品分享面板（二维码 + 「选哪一件」）—— 2026-09-30 用户口径：
//   「点到对应的作品，查看作品的右上方有个分享按钮」「这节课有 1 个图片和 1 个视频，每个都可以独立去分享」
//   「机构端/老师端也需要有」。
//
// 所以它放在 `@platform/shared`：**学生端（自己的主页）与机构/老师端（学生学习结果与作品）用同一套 UI** ——
// 两份实现的话，弹窗里的文案、二维码尺寸、"选哪一件"的位置迟早有一边走样。
// ⚠️ 发码的口径（幂等 / 件怎么定位 / 与作品广场解耦）在服务端 `services/workShare.js` 一份；
//    这个组件只管"显示 + 调 createShare"，**不自己拼 pieceKey**（那是服务端算的）。
// ⚠️ 目前**没有公众号** → 不做微信 JS-SDK，面板里给"复制链接 + 微信里点右上角 ···"的手动路径。
import { useEffect, useState } from 'react';
// 二维码：仓库里 vendored 的那份（MIT，Kazuhiko Arase）—— **零依赖**（服务器没有 npm，发布不该为它下载新包）。
// 正确性：同一段文本与 npm 上成熟的 `qrcode` 生成结果**逐格比对一致**（33×33、0 处不同）后才投入使用。
import qrcode from './vendor/qrcode-generator.mjs';

/** 二维码 SVG（黑白两色、带静默边）。 */
export function qrSvgText(text, { cell = 4, margin = 2 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text || ''));
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + margin * 2) * cell;
  let rects = '';
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (qr.isDark(r, c)) rects += `<rect x="${(c + margin) * cell}" y="${(r + margin) * cell}" width="${cell}" height="${cell}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="分享二维码">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><g fill="#111">${rects}</g></svg>`;
}

/**
 * @param title 面板标题里的作品名（例如「我的网页 · 图片」）
 * @param pieces `[{ pieceKey, label }]`（**服务端算好的键**，来自作品详情里的 media / artifacts）
 * @param createShare `async (pieceKey) => ({ code })` —— 由调用方按自己的作用域调接口
 *        （学生端 `student/share-links`、机构端 `org/share-links`；两边拿到的码是同一枚）
 */
export function WorkSharePanel({ title, pieces = [], createShare, onClose }) {
  const [state, setState] = useState({ pieceKey: '', url: '', svg: '', busy: true, notice: '' });

  async function pick(pieceKey) {
    if (!pieceKey) return;
    setState({ pieceKey, url: '', svg: '', busy: true, notice: '' });
    try {
      const saved = await createShare(pieceKey);
      const url = `${window.location.origin}/s/${saved.code}`;
      setState({ pieceKey, url, svg: qrSvgText(url), busy: false, notice: '' });
    } catch (error) {
      setState({ pieceKey, url: '', svg: '', busy: false, notice: `分享没成功：${error?.message || error}` });
    }
  }

  // 打开面板就把第一件发出来（用户点「分享」时最想要的就是"马上有个码"）
  useEffect(() => { void pick(pieces[0]?.pieceKey || ''); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const current = pieces.find((piece) => piece.pieceKey === state.pieceKey) || null;

  return <div className="share-modal" role="dialog" aria-modal="true" data-testid="share-modal" onClick={(event) => event.stopPropagation()}>
    <div className="share-modal__panel">
      <div className="share-modal__head">
        <strong>分享作品</strong>
        <button type="button" className="text-button" onClick={onClose}>关闭</button>
      </div>
      <p className="share-modal__title">{title}{current?.label ? ` · ${current.label}` : ''}</p>
      {/* 这件作品有好几件产出物时，让用户**选哪一件**（一节课的 1 张图 + 1 段视频就是两个选项） */}
      {pieces.length > 1 ? <label className="share-modal__pick">选哪一件
        <select value={state.pieceKey} onChange={(event) => pick(event.target.value)} data-testid="share-piece-select">
          {pieces.map((piece) => <option key={piece.pieceKey} value={piece.pieceKey}>{piece.label}</option>)}
        </select>
      </label> : null}
      {state.busy ? <p className="share-modal__hint">正在生成二维码…</p> : null}
      {state.svg ? <div className="share-modal__qr" dangerouslySetInnerHTML={{ __html: state.svg }} /> : null}
      {state.svg ? <p className="share-modal__hint">用手机扫这个二维码，就能看到这一件。</p> : null}
      {state.notice ? <p className="share-modal__hint">{state.notice}</p> : null}
      {state.url ? <div className="share-modal__actions">
        <button type="button" className="button" onClick={async () => {
          try { await navigator.clipboard.writeText(state.url); setState((old) => ({ ...old, notice: `链接已复制：${state.url}` })); }
          catch { setState((old) => ({ ...old, notice: `请手动复制：${state.url}` })); }
        }}>复制链接</button>
        <a className="button soft" href={state.url} target="_blank" rel="noreferrer">先看看分享页</a>
      </div> : null}
      {/* ⚠️ 2026-09-30 用户口径「分享按钮这些多余的文案全部删除」：这里原来还有两行
          （微信"点右上角 ···"的引导 + 「看 TA 的主页 · 更多作品」）。面板只干一件事：给码、给链接。 */}
    </div>
  </div>;
}

/**
 * 一件作品里**每一件产出物**（面板里"选哪一件"用的那份列表）。
 * `pieceKey` 是**服务端算好的**（作品详情里的 `media` / `artifacts` 都带）——前端别自己拼，
 * 两边口径飘了就会出现"看得见却分享不了"（写守卫时实测踩到）。
 */
export function shareablePiecesOf(detail, source) {
  if ((source || 'CANVAS') === 'VIBECODING') {
    return (detail?.artifacts || []).filter((item) => item?.pieceKey).map((item) => ({ pieceKey: item.pieceKey, label: item.name || '这一件' }));
  }
  const labels = { IMAGE: '图片', VIDEO: '视频', AUDIO: '音频' };
  return (detail?.media || []).filter((item) => item?.pieceKey).map((item) => ({ pieceKey: item.pieceKey, label: item.caption || labels[item.modality] || '这一件' }));
}
