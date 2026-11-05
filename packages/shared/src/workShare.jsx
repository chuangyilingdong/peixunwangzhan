// 作品分享面板（二维码 + 「选哪一件」）—— 2026-09-30 用户口径：
//   「点到对应的作品，查看作品的右上方有个分享按钮」「这节课有 1 个图片和 1 个视频，每个都可以独立去分享」
//   「机构端/老师端也需要有」。
//
// 所以它放在 `@platform/shared`：**学生端（自己的主页）与机构/老师端（学生学习结果与作品）用同一套 UI** ——
// 两份实现的话，弹窗里的文案、二维码尺寸、"选哪一件"的位置迟早有一边走样。
// ⚠️ 发码的口径（幂等 / 件怎么定位 / 与作品广场解耦）在服务端 `services/workShare.js` 一份；
//    这个组件只管"显示 + 调 createShare"，**不自己拼 pieceKey**（那是服务端算的）。
// ⚠️ 目前**没有公众号** → 不做微信 JS-SDK，面板里给"复制链接 + 微信里点右上角 ···"的手动路径。
import { useEffect, useMemo, useState } from 'react';
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
 * 「全部分享」的 piece_key（2026-10-23 用户口径：
 * 「现在分享是必须选择分享哪个，我理解是可以直接全部分享，在手机端可以依次排列展示。也可以单个分享」）。
 *
 * 服务端同一条常量在 `apps/server/src/services/workShare.js` —— **两边必须逐字一致**
 * （服务端不依赖 shared 包；p171 有一条静态断言钉住）。
 * 单件分享仍是 `media:` / `artifact:` 键；这个是"这件作品的全部"，扫码页按顺序铺开。
 */
export const ALL_SHARE_PIECES_KEY = '__all__';

/**
 * @param title 面板标题里的作品名（例如「我的网页 · 图片」）
 * @param pieces `[{ pieceKey, label }]`（**服务端算好的键**，来自作品详情里的 media / artifacts）
 * @param createShare `async (pieceKey) => ({ code })` —— 由调用方按自己的作用域调接口
 *        （学生端 `student/share-links`、机构端 `org/share-links`；两边拿到的码是同一枚）
 */
export function WorkSharePanel({ title, pieces = [], createShare, onClose }) {
  const [state, setState] = useState({ pieceKey: '', url: '', svg: '', busy: true, notice: '' });
  // 2026-11-05 用户口径：特定场景扫码要**直接播放作品**（不显示分享页）。
  // 默认关闭，正常分享码完全不变；勾选后只在链接末尾加 `/play`。
  const [playMode, setPlayMode] = useState(false);
  const qrUrl = state.url ? `${state.url}${playMode ? '/play' : ''}` : '';
  const qrSvg = useMemo(() => (qrUrl ? qrSvgText(qrUrl) : ''), [qrUrl]);

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

  // 打开面板就把"全部分享"发出来（用户点「分享」时最想要的是"马上有个码"；
  // 2026-10-23 口径：可以直接全部分享，单件仍可选）。只有一件时就是那一件，等价。
  useEffect(() => { void pick(pieces.length > 1 ? ALL_SHARE_PIECES_KEY : (pieces[0]?.pieceKey || '')); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const current = pieces.find((piece) => piece.pieceKey === state.pieceKey) || null;
  const allSelected = state.pieceKey === ALL_SHARE_PIECES_KEY;

  return <div className="share-modal" role="dialog" aria-modal="true" data-testid="share-modal" onClick={(event) => event.stopPropagation()}>
    <div className="share-modal__panel">
      <div className="share-modal__head">
        <strong>分享作品</strong>
        <button type="button" className="text-button" onClick={onClose}>关闭</button>
      </div>
      {/* ⚠️ 只有**一件**时不再后缀那一件名（此前网页作品会显示成「index.html · index.html」——
          作品名本来就是入口文件名，重复一遍既丑、又像"还有别的可挑"）。 */}
      <p className="share-modal__title">{title}{allSelected ? ` · 全部 ${pieces.length} 件` : (pieces.length > 1 && current?.label ? ` · ${current.label}` : '')}</p>
      {/* 这件作品有好几件产出物时，让用户**选哪一件**；第一项是「全部分享」（扫码页依次铺开）。
          ⚠️ 网页作品（入口 + 它引用的 css/js/图）是**一个整体**，不会再出现这个下拉（2026-10-02 用户口径）。 */}
      {pieces.length > 1 ? <label className="share-modal__pick">选哪一件
        <select value={state.pieceKey} onChange={(event) => pick(event.target.value)} data-testid="share-piece-select">
          <option value={ALL_SHARE_PIECES_KEY} data-testid="share-piece-all">全部分享（{pieces.length} 件）</option>
          {pieces.map((piece) => <option key={piece.pieceKey} value={piece.pieceKey}>{piece.label}</option>)}
        </select>
      </label> : null}
      {state.busy ? <p className="share-modal__hint">正在生成二维码…</p> : null}
      <label className="share-modal__play"><input type="checkbox" checked={playMode} onChange={(event) => setPlayMode(event.target.checked)} /> 扫码直接播放作品（不显示分享页）</label>
      {qrSvg ? <div className="share-modal__qr" dangerouslySetInnerHTML={{ __html: qrSvg }} /> : null}
      {state.notice ? <p className="share-modal__hint">{state.notice}</p> : null}
      {/* ⭐ 2026-10-03 用户口径：「"先看看分享页"删除，复制链接点击后**显示复制成功提示即可，
          不用显示具体的链接地址**」——链接那么长，贴在提示里既读不了也用不上（微信里还得手抄）。
          ⚠️ 失败时也别再把地址倒出来（用户原话：「实际这个操作根本不可能用」）——给一句能照做的。 */}
      {state.url ? <div className="share-modal__actions">
        <button type="button" className="button" onClick={async () => {
          try { await navigator.clipboard.writeText(qrUrl); setState((old) => ({ ...old, notice: '链接已复制' })); }
          catch { setState((old) => ({ ...old, notice: '复制失败，请长按二维码保存后发送' })); }
        }}>复制链接</button>
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
    // ⚠️ 2026-10-02：`shareable === false` 的是**网页作品引用的零件**（css/js/图片/音视频）——
    //    它们是入口那件作品的组成部分，不是独立的"一件"（用户口径：「客户端传过来的是 1 个主文件，
    //    然后是一些引用文件……这里肯定就是一个整体啊」）。服务端在产物清单上标了这一位。
    return (detail?.artifacts || [])
      .filter((item) => item?.pieceKey && item.shareable !== false)
      .map((item) => ({ pieceKey: item.pieceKey, label: String(item.name || '这一件').slice(0, 24) }));
  }
  const labels = { IMAGE: '图片', VIDEO: '视频', AUDIO: '音频', TEXT: '文字' };
  // 没有 fileId/url 的产出（例如画布里的 AI 文字）没有可发码的键；空键 `media:` 要挡掉，
  // 否则分享面板会出现一件"看得见但发不了"的条目（服务端 assertSharePiece 会拒）。
  //
  // ⚠️ 2026-11-02：标签**不能直接用 caption**。画布产出的 caption 是**生成提示词**
  //    （实测一条几百字：「…只能看见背面，严禁露出侧脸。2个视图必须是同一人物…」），
  //    塞进 <select> 会把下拉框撑成一条横幅，把二维码挤出屏幕（用户截图）。
  //    规则：学生自己起的短名字（≤12 字）才用，否则一律「图片 1 / 视频 2」这种短标签，
  //    同类按出现顺序编号区分。
  const counters = {};
  return (detail?.media || [])
    .filter((item) => item?.pieceKey && !String(item.pieceKey).endsWith(':'))
    .map((item) => {
      const kind = labels[item.modality] || '产出';
      counters[kind] = (counters[kind] || 0) + 1;
      const ordinal = counters[kind];
      // 先压掉换行/多余空白，再判"够不够短" —— 提示词里全是换行，只看原串长度会误判
      const caption = String(item.caption || '').replace(/\s+/g, ' ').trim();
      return { pieceKey: item.pieceKey, label: caption && caption.length <= 12 ? caption : `${kind} ${ordinal}` };
    });
}
