// 文档产物的**预览**（PPT / Word / Excel）。
//
// 为什么在客户端渲染而不是让服务端转一份 HTML 回来：
// 产物里存的就是**规格文本**（PPT=JSON 提纲、Word=Markdown、Excel=CSV），前端手上已经有全部素材，
// 本地渲染既不用多一次请求、也没有"预览和下载是两份实现"的漂移风险。
// 真正的文件仍然由服务端在下载那一刻渲染（见 apps/server/src/services/ooxml/），
// 所以这里的预览是**近似**：版式比不上 PowerPoint，但足以让学生看清自己做出了什么、再决定下载。
//
// 配图：规格里的 {"attachment": N} 指「产出这一轮学生传的第 N 张图」，
// 由调用方用 resolveAttachment(artifact, N) 翻成公开地址（外链，<img> 直接能取）。
import { useMemo } from 'react';
import { ConsoleIcon } from './icons.jsx';
import { MarkdownView } from '../markdown.jsx';
import { parseCsvLoose } from './attachments.js';

/** PPT：规格 JSON 的宽容解析（和服务端 parseDeckSpec 一个口径，但这边只用于预览） */
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

function SlideCard({ slide, index, resolveImage }) {
  const image = slide?.image?.attachment ? resolveImage?.(Number(slide.image.attachment)) : null;
  const bullets = Array.isArray(slide?.bullets) ? slide.bullets : [];
  return (
    <section className="c-doc-slide">
      <span className="c-doc-slide__no">{index}</span>
      <h4>{slide?.title || '（无标题）'}</h4>
      <div className={`c-doc-slide__body${image ? ' has-image' : ''}`}>
        {bullets.length ? (
          <ul>{bullets.map((item, i) => <li key={i}>{String(item)}</li>)}</ul>
        ) : null}
        {image ? <img src={image} alt="" loading="lazy" /> : null}
      </div>
    </section>
  );
}

function DeckPreview({ content, resolveImage }) {
  const deck = useMemo(() => parseDeckPreview(content), [content]);
  if (!deck) {
    return <div className="c-doc-fallback"><ConsoleIcon name="alert" size={20} />这份 PPT 的内容不是可识别的规格，下载后可能打不开。</div>;
  }
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  return (
    <div className="c-doc-deck">
      <section className="c-doc-slide c-doc-slide--cover">
        <h3>{deck.title || '演示文稿'}</h3>
        {deck.subtitle ? <p>{deck.subtitle}</p> : null}
        {deck.author ? <small>{deck.author}</small> : null}
      </section>
      {slides.map((slide, index) => (
        <SlideCard key={index} slide={slide} index={index + 1} resolveImage={resolveImage} />
      ))}
      <p className="c-doc-deck__note">
        共 {slides.length + 1} 页 · 这是预览，版式以下载后的文件为准
      </p>
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
 * @param artifact { kind, content, name }
 * @param resolveImage (附件序号) => 图片地址 or null
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
