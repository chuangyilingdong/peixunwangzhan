// 作品页的**媒体**展示：图片 / 视频 / 音频（+ 生成的文字）。
//
// 用户 2026-09-21 口径：「图4图5 作品发布后，网站显示的是画布内容，应该显示的是图片/视频/音频等等，
// 而不是画布」——作品读面要看成出来的**东西**，画布只是过程（过程想看还能切过去，见调用方的「看创作画布」）。
//
// 数据有两路（调用方给哪路用哪路）：
//   · `media`：服务端从**画布快照**提的媒体清单（`{ url, modality, fileId, caption }`，带 fileId 好换 data:）；
//   · `assets`：这次创作产出的 `media_assets`（`{ modality, url, previewUrl, text, label }`）。
// 地址解析交给调用方的 `resolveSrc`（受鉴权的站内素材要转 data: 才能显示，见共享 api 的 fetchDataUrl）；
// 没给解析器就用原地址（上游图床的 https 外链本来就能直接显示）。
import { useMemo, useState } from 'react';

const MODALITY_LABELS = { IMAGE: '图片', VIDEO: '视频', AUDIO: '音频', MUSIC: '音乐', TEXT: '文字' };

/**
 * 媒体本体：**加载失败时说一句人话**。
 *
 * 为什么要有它（用户 2026-09-22 报的坏图）：作品里挂的媒体有些是上游的**临时地址**，
 * 过期后返回 403 —— 浏览器的默认表现是一个破图图标，学生/老师看不出那是什么、也不知道该怎么办。
 * ⚠️ 这只是把现象说清楚；**真正不让它发生**的是生成时把产物归档到本机
 * （`services/generatedAssetArchive.js`），存量由 `deploy/production/backfill-generated-media.mjs` 收。
 */
function MediaContent({ modality, src, caption }) {
  const [failed, setFailed] = useState(false);
  const label = MODALITY_LABELS[modality] || '这份素材';
  if (!src || failed) return <div className="work-media__missing">{label}已失效，读不出来了</div>;
  if (modality === 'IMAGE') return <img src={src} alt={caption || '作品图片'} loading="lazy" onError={() => setFailed(true)} />;
  if (modality === 'VIDEO') return <video src={src} controls playsInline preload="metadata" onError={() => setFailed(true)} />;
  return <audio src={src} controls preload="metadata" onError={() => setFailed(true)} />;
}

function normalizeItems(media = [], assets = []) {
  const list = [];
  const seen = new Set();
  const push = (item) => {
    const url = String(item?.url || item?.previewUrl || '').trim();
    const text = String(item?.text || '').trim();
    if (!url && !text) return;
    const key = url ? `u:${url}` : `t:${text.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ ...item, url, text, modality: String(item.modality || (text ? 'TEXT' : 'IMAGE')).toUpperCase() });
  };
  (Array.isArray(media) ? media : []).forEach(push);
  (Array.isArray(assets) ? assets : []).forEach(push);
  // 先看画面（图/视频），再听声音，最后读文字 —— 与"作品是给别人看的"一致。
  const rank = { IMAGE: 0, VIDEO: 1, AUDIO: 2, MUSIC: 2, TEXT: 3 };
  return list.sort((a, b) => (rank[a.modality] ?? 9) - (rank[b.modality] ?? 9));
}

export function WorkMediaGallery({ media = [], assets = [], resolveSrc = null, emptyText = '这件作品还没有图片 / 视频 / 音频，可以切到「创作画布」看过程。', className = '' }) {
  const items = useMemo(() => normalizeItems(media, assets), [media, assets]);
  if (!items.length) return <p className={`work-media__empty ${className}`.trim()}>{emptyText}</p>;
  const srcOf = (item) => {
    const resolved = typeof resolveSrc === 'function' ? resolveSrc(item) : '';
    return String(resolved || item.url || '');
  };
  return <div className={`work-media ${className}`.trim()} data-media-count={items.length}>
    {items.map((item, index) => {
      const src = srcOf(item);
      const caption = item.caption || item.label || '';
      const key = `${item.modality}-${index}-${item.url || item.text.slice(0, 24)}`;
      if (item.modality === 'TEXT') {
        return <article className="work-media__text" key={key}>
          {caption ? <h4>{caption}</h4> : null}
          <p>{item.text}</p>
        </article>;
      }
      if (item.modality === 'VIDEO') {
        return <figure className="work-media__item is-video" key={key}>
          <MediaContent modality="VIDEO" src={src} caption={caption} />
          {caption ? <figcaption>{caption}</figcaption> : null}
        </figure>;
      }
      if (item.modality === 'AUDIO' || item.modality === 'MUSIC') {
        return <figure className="work-media__item is-audio" key={key}>
          <MediaContent modality={item.modality} src={src} caption={caption} />
          <figcaption>{caption || MODALITY_LABELS[item.modality]}</figcaption>
        </figure>;
      }
      return <figure className="work-media__item is-image" key={key}>
        <MediaContent modality="IMAGE" src={src} caption={caption} />
        {caption ? <figcaption>{caption}</figcaption> : null}
      </figure>;
    })}
  </div>;
}
