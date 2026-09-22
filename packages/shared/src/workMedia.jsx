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
 * 媒体本体：**加载失败时说一句人话**。
 *
 * 为什么要有它（用户 2026-09-22 报的坏图）：作品里挂的媒体有些是上游的**临时地址**，
 * 过期后返回 403 —— 浏览器的默认表现是一个破图图标，学生/老师看不出那是什么、也不知道该怎么办。
 * ⚠️ 这只是把现象说清楚；**真正不让它发生**的是生成时把产物归档到本机
 * （`services/generatedAssetArchive.js`），存量由 `deploy/production/backfill-generated-media.mjs` 收。
 */
function useMediaFailure(src) {
  const [failed, setFailed] = useState(false);
  // 地址变了要把"失效"清掉：授权地址是**异步**解析出来的（resolveSrc → fetchDataUrl），
  // 先拿不到地址的那一瞬间不能把这一项永久判成"已失效"。
  useEffect(() => { setFailed(false); }, [src]);
  return [failed, () => setFailed(true)];
}

/** 卡片上的缩略图（点开才放大：图片/视频用画面本身当缩略图，音频/文字用一张符号卡）。 */
function MediaThumb({ item, src }) {
  const [failed, markFailed] = useMediaFailure(src);
  const label = MODALITY_LABELS[item.modality] || '这份素材';
  if (!src || failed) return <div className="work-media__thumb-missing">{label}已失效</div>;
  if (item.modality === 'IMAGE') return <img className="work-media__thumb-img" src={src} alt={item.caption || '作品图片'} loading="lazy" onError={markFailed} />;
  if (item.modality === 'VIDEO') {
    return <div className="work-media__thumb-video">
      <video src={src} muted playsInline preload="metadata" onError={markFailed} />
      <span className="work-media__play" aria-hidden="true">▶</span>
    </div>;
  }
  if (item.modality === 'AUDIO' || item.modality === 'MUSIC') return <div className="work-media__thumb-audio"><span aria-hidden="true">♫</span><small>{item.caption || item.label || label}</small></div>;
  return <div className="work-media__thumb-text">{(item.text || '').slice(0, 96)}{(item.text || '').length > 96 ? '…' : ''}</div>;
}

/** 点开之后的大图浮层：把**完整**的那一份放进来（图片/视频原尺寸、音频给播放器、文字给整段）。 */
function MediaLightbox({ item, src, onClose }) {
  const [failed, markFailed] = useMediaFailure(src);
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
        {!src || failed ? <p className="work-media__missing">{label}已失效，读不出来了</p>
          : item.modality === 'IMAGE' ? <img src={src} alt={caption} onError={markFailed} />
            : item.modality === 'VIDEO' ? <video src={src} controls autoPlay playsInline onError={markFailed} />
              : item.modality === 'AUDIO' || item.modality === 'MUSIC' ? <AudioPlayer src={src} label={caption} />
                : <p className="work-media__lightbox-text">{item.text}</p>}
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
    const text = String(item.text || '').trim();
    if (modality !== 'TEXT' && !url) return;
    if (modality === 'TEXT' && !text) return;
    const key = `${modality}:${url || text.slice(0, 40)}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ modality, url, text, caption: String(item.caption || item.label || '').trim(), fileId: item.fileId || null, label: String(item.label || '').trim() });
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
  const srcOf = (item) => {
    const resolved = typeof resolveSrc === 'function' ? resolveSrc(item) : '';
    return String(resolved || item.url || '');
  };
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
            <AudioPlayer className="work-media__player" src={src} label={caption} />
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
