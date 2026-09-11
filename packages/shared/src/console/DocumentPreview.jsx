// 文档产物的**预览**（PPT / Word / Excel）。
//
// 为什么在客户端渲染而不是让服务端转一份 HTML 回来：
// 产物里存的就是**规格文本**（PPT=JSON 提纲、Word=Markdown、Excel=CSV），前端手上已经有全部素材，
// 本地渲染既不用多一次请求、也没有"预览和下载是两份实现"的漂移风险。
// 真正的文件由服务端在下载那一刻渲染（apps/server/src/services/ooxml/），
// 所以这里的预览是**近似**：版式比不上 PowerPoint，但配色、版式与图文关系都跟着同一份规格走。
//
// ⚠️ 主题色板与版式命名必须和服务端 pptx.js 保持一致（`scripts/p50-theme-parity.mjs` 盯着）。
import { useMemo } from 'react';
import { ConsoleIcon } from './icons.jsx';
import { MarkdownView } from '../markdown.jsx';
import { parseCsvLoose } from './attachments.js';
import { themeOf, themeHex as hex } from './themes.js';

/** PPT：规格 JSON 的宽容解析（与服务端 parseDeckSpec 一个口径，但这边只用于预览） */
export function parseDeckPreview(content) {
  const text = String(content || '').trim();
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fenced) candidates.unshift(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.slides)) return parsed;
    } catch { /* 试下一个 */ }
  }
  return null;
}

function SlideFrame({ children, theme, number, style }) {
  return (
    <section className="c-doc-slide" style={{ background: hex(theme.bg), color: hex(theme.ink), ...style }}>
      {children}
      {number ? <span className="c-doc-slide__no">{number}</span> : null}
    </section>
  );
}

function DeckPreview({ content, resolveImage }) {
  const deck = useMemo(() => parseDeckPreview(content), [content]);
  if (!deck) return <div className="c-doc-fallback"><ConsoleIcon name="alert" size={20} />这份 PPT 的内容不是可识别的规格，下载后可能打不开。</div>;
  const theme = themeOf(deck.theme);
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const total = slides.length + 1;
  const coverImage = resolveImage?.({}, -1) || null;

  return (
    <div className="c-doc-deck">
      {/* 封面：有图就整页铺图 + 深色蒙层（白字压在照片上必须压暗才看得清） */}
      <section className="c-doc-slide c-doc-slide--cover" style={{ background: hex(coverImage ? theme.cover : theme.cover), color: '#fff' }}>
        {coverImage ? <img className="c-doc-slide__bg" src={coverImage} alt="" /> : null}
        {coverImage ? <span className="c-doc-slide__scrim" style={{ background: hex(theme.cover) }} /> : null}
        {!coverImage ? <span className="c-doc-slide__decor" style={{ background: hex(theme.accent) }} /> : null}
        <span className="c-doc-slide__rule" style={{ background: hex(theme.accent) }} />
        <h3>{deck.title || '演示文稿'}</h3>
        {deck.subtitle ? <p style={{ color: hex(theme.soft) }}>{deck.subtitle}</p> : null}
        {deck.author ? <small style={{ color: hex(theme.soft) }}>{deck.author}</small> : null}
      </section>

      {slides.map((slide, index) => {
        const layout = String(slide?.layout || '').toLowerCase();
        const image = resolveImage?.(slide, index) || null;
        const bullets = Array.isArray(slide?.bullets) ? slide.bullets : [];
        const number = `${index + 2} / ${total}`;

        if (layout === 'thanks') {
          return (
            <section className="c-doc-slide c-doc-slide--thanks" key={index} style={{ background: hex(theme.cover), color: '#fff' }}>
              <span className="c-doc-slide__rule c-doc-slide__rule--center" style={{ background: hex(theme.accent) }} />
              <h3>谢谢观看</h3>
              <p style={{ color: hex(theme.soft) }}>{deck.title || ''}</p>
            </section>
          );
        }
        if (layout === 'section') {
          return (
            <SlideFrame key={index} theme={theme} style={{ background: hex(theme.cover), color: '#fff' }}>
              <span className="c-doc-slide__rule" style={{ background: hex(theme.accent) }} />
              <h3 className="c-doc-slide__section">{slide.title || ''}</h3>
              <span className="c-doc-slide__sectionno" style={{ color: hex(theme.accent) }}>{String(index + 2).padStart(2, '0')}</span>
            </SlideFrame>
          );
        }
        if (layout === 'quote') {
          return (
            <SlideFrame key={index} theme={theme}>
              <blockquote className="c-doc-slide__quote">{slide.title || bullets[0] || ''}</blockquote>
            </SlideFrame>
          );
        }
        // 只有图没有要点：整页图 + 底部色带压标题
        if (!bullets.length && image) {
          return (
            <SlideFrame key={index} theme={theme}>
              <img className="c-doc-slide__bg" src={image} alt="" />
              <span className="c-doc-slide__caption" style={{ background: hex(theme.cover) }}>
                <strong>{slide.title || ''}</strong>
              </span>
              <span className="c-doc-slide__no c-doc-slide__no--light">{number}</span>
            </SlideFrame>
          );
        }
        return (
          <SlideFrame key={index} theme={theme} number={number}>
            <h4 style={{ color: hex(theme.ink) }}>{slide.title || '（无标题）'}</h4>
            <span className="c-doc-slide__title-rule" style={{ background: hex(theme.accent) }} />
            <div className={`c-doc-slide__body${image ? ' has-image' : ''}`}>
              {bullets.length ? <ul style={{ color: hex(theme.body) }}>{bullets.map((item, i) => <li key={i}>{String(item)}</li>)}</ul> : null}
              {image ? <img src={image} alt="" loading="lazy" /> : null}
            </div>
            <span className="c-doc-slide__foot" style={{ color: hex(theme.body) }}>
              <i style={{ background: hex(theme.accent) }} />
            </span>
          </SlideFrame>
        );
      })}
      <p className="c-doc-deck__note">共 {total} 页 · 这是预览，版式以下载后的文件为准</p>
    </div>
  );
}

function SheetPreview({ content }) {
  const rows = useMemo(() => parseCsvLoose(content), [content]);
  if (!rows.length) return <div className="c-doc-fallback"><ConsoleIcon name="alert" size={20} />这张表格还没有内容。</div>;
  const columns = Math.max(...rows.map((row) => row.length));
  return (
    <div className="c-doc-sheet">
      <table>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: columns }, (_, columnIndex) => (
                rowIndex === 0
                  ? <th key={columnIndex}>{row[columnIndex] ?? ''}</th>
                  : <td key={columnIndex}>{row[columnIndex] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="c-doc-sheet__note">{rows.length} 行 × {columns} 列 · 首行是表头</p>
    </div>
  );
}

/**
 * @param artifact { kind, content, name, generatedImages }
 * @param resolveImage (slide, slideIndex) => 图片地址 or null（slideIndex 为 -1 表示封面）
 */
export function DocumentPreview({ artifact, resolveImage }) {
  const kind = String(artifact?.kind || '').toLowerCase();
  if (kind === 'pptx') return <DeckPreview content={artifact.content} resolveImage={resolveImage} />;
  if (kind === 'xlsx') return <SheetPreview content={artifact.content} />;
  if (kind === 'docx') {
    return (
      <div className="c-doc-paper">
        <MarkdownView content={String(artifact.content || '')} />
      </div>
    );
  }
  return <div className="c-doc-fallback"><ConsoleIcon name="file" size={20} />这个文件还不支持站内预览，请下载后用 Office 打开。</div>;
}
