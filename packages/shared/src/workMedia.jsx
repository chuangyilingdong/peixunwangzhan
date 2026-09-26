// 作品页的**媒体**展示：图片 / 视频 / 音频（+ 生成的文字）。
//
// 用户 2026-09-21 口径：「图4图5 作品发布后，网站显示的是画布内容，应该显示的是图片/视频/音频等等，
// 而不是画布」——作品读面要看成出来的**东西**，画布只是过程（过程想看还能切过去，见调用方的「看创作画布」）。
//
// 用户 2026-09-22 口径（**这一版改的就是它**）：「提交的作品，如果是画布的作品，一个画布课堂可能会产出
// 很多图像和视频/音频，这里应该是一个卡片形式展示，点击后放大。而不是现在这样一个大图，还看不完比如下拉。」
// 所以：**网格卡片（固定比例缩略图）+ 点开大图浮层**。原来图片是"撑满一列"、视频/音频整行铺开，
// 一件作品出十来张图时就是一条几屏长的瀑布，看不到全貌。
//
// 数据有两路（调用方给哪路用哪路）：
//   · `media`：服务端从**画布快照**提的媒体清单（`{ url, modality, fileId, caption }`，带 fileId 好换 data:）；
//   · `assets`：这次创作产出的 `media_assets`（`{ modality, url, previewUrl, text, label }`）。
// 地址解析交给调用方的 `resolveSrc`（受鉴权的站内素材要转 data: 才能显示，见共享 api 的 fetchDataUrl）；
// 没给解析器就用原地址（上游图床的 https 外链本来就能直接显示）。
//
// ⚠️ 音频播放器与画布上的音乐框体**共用同一个组件**（`@platform/canvas` 的 AudioPlayer，两行式：
//    进度条一行、按钮一行）—— 别在这儿再写一个原生 `<audio controls>`，那个在窄容器里会把进度条压没。
import { useEffect, useMemo, useState } from 'react';
import { AudioPlayer } from '@platform/canvas';

const MODALITY_LABELS = { IMAGE: '图片', VIDEO: '视频', AUDIO: '音频', MUSIC: '音乐', TEXT: '文字' };

/**
 * 把作品快照里的**站内素材地址**换成"当前这一端自己能取到"的地址（同步、同源）。
 *
 * 为什么需要它（2026-09-25 用户报「作品预览还是失效状态」）：
 *   快照里存的是**学生域**地址 `/api/student/file-assets/<id>/download`，它只认学生角色；
 *   机构端（老师）/访客拿它去取必然 403。而 `<img>/<video>/<audio>` 发不出 Authorization 头，
 *   只能靠 cookie —— 浏览器会**立刻**拿这个地址去请求一次（403），缩略图于是被打上「已失效」，
 *   老师看到的就是"整片作品图都失效"。原来的转 data: 方案要等每张图 fetch 完再 base64，
 *   2.4MB 一张、7 张走 5Mbps 出口要几十秒，这段时间里页面就是那个失效的样子。
 *
 * 所以：**同步**返回服务端已经备好的同源代理地址（`imageUrls`，见 orgAdmin/public 那两处），
 *   · 同源 → cookie 就是这一端自己的会话，`<img>` 直接能取到（也顺着流式边下边显示）；
 *   · 同步 → 第一帧渲染就是对的地址，不会"先失败一次再补救"；
 *   · 不 base64 → 省掉整张图的 JS 内存与时间。
 * 拿不到代理地址时返回 `null`（调用方显示占位），**绝不回退到学生域地址**。
 * 外链（上游图床 https）、data:、以及本来就是本站相对地址的（`/media/…`）原样返回。
 */
export function resolveWorkMediaUrl(value, imageUrls = null) {
  const raw = String(value || '');
  if (!raw) return null;
  const fileId = raw.match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:\?.*)?$/)?.[1] || null;
  if (fileId) return String(imageUrls?.[fileId] || '') || null;
  if (/^data:/i.test(raw) || /^https:\/\//i.test(raw)) return raw;
  if (/^\/(?!\/)/.test(raw)) return raw;
  return null;
}

/**
 * 媒体本体：**加载失败时说一句人话**。
 *
 * 为什么要有它（用户 2026-09-22 报的坏图）：作品里挂的媒体有些是上游的**临时地址**，
 * 过期后返回 403 —— 浏览器的默认表现是一个破图图标，学生/老师看不出那是什么、也不知道该怎么办。
 * ⚠️ 这只是把现象说清楚；**真正不让它发生**的是生成时把产物归档到本机
 * （`services/generatedAssetArchive.js`），存量由 `deploy/production/backfill-generated-media.mjs` 收。
 */
function useMediaFailure(src, fallbackUrl) {
  const [failed, setFailed] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);
  // 地址变了要把"失效"清掉：授权地址是异步解析出来的，先拿不到地址不能永久判坏。
  useEffect(() => { setFailed(false); setUsingFallback(false); }, [src, fallbackUrl]);
  const markFailed = () => {
    if (!usingFallback && fallbackUrl && fallbackUrl !== src) setUsingFallback(true);
    else setFailed(true);
  };
  return [failed, markFailed, usingFallback ? fallbackUrl : src];
}

/** 卡片上的缩略图（点开才放大：图片/视频用画面本身当缩略图，音频/文字用一张符号卡）。 */
function MediaThumb({ item, src }) {
  const [failed, markFailed, displaySrc] = useMediaFailure(src, item.fallbackUrl);
  const label = MODALITY_LABELS[item.modality] || '这份素材';
  if (item.modality === 'TEXT') return <div className="work-media__thumb-text">{(item.text || '').slice(0, 96)}{(item.text || '').length > 96 ? '…' : ''}</div>;
  if (item.modality === 'AUDIO' || item.modality === 'MUSIC') return <div className="work-media__thumb-audio"><span aria-hidden="true">♫</span><small>{item.caption || item.label || label}</small></div>;
  if (!displaySrc || failed) return <div className="work-media__thumb-missing">{label}已失效</div>;
  if (item.modality === 'IMAGE') return <img className="work-media__thumb-img" src={displaySrc} alt={item.caption || '作品图片'} loading="lazy" onError={markFailed} />;
  if (item.modality === 'VIDEO') {
    return <div className="work-media__thumb-video">
      <video src={displaySrc} muted playsInline preload="metadata" onError={markFailed} />
      <span className="work-media__play" aria-hidden="true">▶</span>
    </div>;
  }
  return null;
}

/** 点开之后的大图浮层：把**完整**的那一份放进来（图片/视频原尺寸、音频给播放器、文字给整段）。 */
function MediaLightbox({ item, src, onClose }) {
  const [failed, markFailed, displaySrc] = useMediaFailure(src, item.fallbackUrl);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const label = MODALITY_LABELS[item.modality] || '这份素材';
  const caption = item.caption || item.label || label;
  return <div className="work-media__lightbox" role="dialog" aria-modal="true" aria-label={caption} onClick={onClose}>
    <div className="work-media__lightbox-panel" onClick={(event) => event.stopPropagation()}>
      <div className="work-media__lightbox-head">
        <strong>{caption}</strong>
        <button type="button" className="work-media__lightbox-close" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="work-media__lightbox-body">
        {item.modality === 'TEXT' ? <p className="work-media__lightbox-text">{item.text}</p>
          : !displaySrc || failed ? <p className="work-media__missing">{label}已失效，读不出来了</p>
            : item.modality === 'IMAGE' ? <img src={displaySrc} alt={caption} onError={markFailed} />
              : item.modality === 'VIDEO' ? <video src={displaySrc} controls autoPlay playsInline onError={markFailed} />
                : item.modality === 'AUDIO' || item.modality === 'MUSIC' ? <AudioPlayer src={displaySrc} label={caption} />
                  : null}
      </div>
    </div>
  </div>;
}

function normalizeItems(media = [], assets = []) {
  const list = [];
  const seen = new Set();
  const push = (item) => {
    if (!item) return;
    const modality = String(item.modality || 'IMAGE').toUpperCase();
    const url = String(item.url || '').trim();
    const previewUrl = String(item.previewUrl || '').trim();
    const fallbackUrl = previewUrl && previewUrl !== url ? previewUrl : '';
    const text = String(item.text || '').trim();
    if (modality !== 'TEXT' && !url && !fallbackUrl) return;
    if (modality === 'TEXT' && !text) return;
    const key = `${modality}:${url || fallbackUrl || text.slice(0, 40)}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ modality, url, fallbackUrl, previewUrl, text, caption: String(item.caption || item.label || '').trim(), fileId: item.fileId || null, label: String(item.label || '').trim() });
  };
  (Array.isArray(media) ? media : []).forEach(push);
  (Array.isArray(assets) ? assets : []).forEach(push);
  const rank = { IMAGE: 0, VIDEO: 1, AUDIO: 2, MUSIC: 2, TEXT: 3 };
  return list.sort((a, b) => (rank[a.modality] ?? 9) - (rank[b.modality] ?? 9));
}

export function WorkMediaGallery({ media = [], assets = [], resolveSrc = null, emptyText = '这件作品还没有图片 / 视频 / 音频，可以切到「创作画布」看过程。', className = '' }) {
  const items = useMemo(() => normalizeItems(media, assets), [media, assets]);
  const [opened, setOpened] = useState(-1);
  if (!items.length) return <p className={`work-media__empty ${className}`.trim()}>{emptyText}</p>;
  // ⚠️ 2026-09-26 全站审计：给了 `resolveSrc` 就**只信它** —— 原来在它返回空时又回退到 `item.url`，
  //    而 `item.url` 常常是学生域地址（服务端原样透出的那个），老师/访客的浏览器拿它请求必然 403，
  //    缩略图被打上「已失效」—— 正是 resolveWorkMediaUrl 契约里明令禁止的那次回退。
  //    返回空时 MediaThumb 会渲染「已失效」占位，比"先发一次必败的请求"干净。
  const srcOf = (item) => (typeof resolveSrc === 'function' ? String(resolveSrc(item) || '') : String(item.url || item.previewUrl || ''));
  const openedItem = opened >= 0 ? items[opened] : null;
  return <>
    <div className={`work-media work-media--cards ${className}`.trim()} data-media-count={items.length}>
      {items.map((item, index) => {
        const src = srcOf(item);
        const caption = item.caption || item.label || MODALITY_LABELS[item.modality];
        const key = `${item.modality}-${index}-${item.url || item.text.slice(0, 24)}`;
        // 音频卡片直接把播放器放进去（两行式，窄卡片里也读得出来）——
        // 这样"能不能听"不用点开就知道；图片/视频/文字点开看完整的那一份。
        if (item.modality === 'AUDIO' || item.modality === 'MUSIC') {
          return <figure className="work-media__item is-audio" key={key}>
            <div className="work-media__card is-static">
              <MediaThumb item={item} src={src} />
            </div>
            <AudioPlayer className="work-media__player" src={src} fallbackSrc={item.fallbackUrl} label={caption} />
            <figcaption>{caption}</figcaption>
          </figure>;
        }
        return <figure className={`work-media__item is-${item.modality.toLowerCase()}`} key={key}>
          <button type="button" className="work-media__card" onClick={() => setOpened(index)} aria-label={`放大查看：${caption}`}>
            <MediaThumb item={item} src={src} />
          </button>
          <figcaption>{caption}</figcaption>
        </figure>;
      })}
    </div>
    {openedItem ? <MediaLightbox item={openedItem} src={srcOf(openedItem)} onClose={() => setOpened(-1)} /> : null}
  </>;
}
