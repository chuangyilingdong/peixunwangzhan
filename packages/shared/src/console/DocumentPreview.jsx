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
import { inspectDeckQuality, parseDeckSpec } from '../deckSpec.js';

/** PPT：规格解析与服务端下载共用 deckSpec.js，避免预览/文件漂移。 */
export function parseDeckPreview(content) {
  return parseDeckSpec(content);
}

function quoteLines(text) {
  const parts = String(text || '').trim().match(/[^，。！？；]+[，。！？；]?/g)?.map((part) => part.trim()).filter(Boolean) || [];
  const lines = [];
  for (const part of parts) {
    const previous = lines[lines.length - 1];
    if (previous && previous.length + part.length <= 16) lines[lines.length - 1] += part;
    else lines.push(part);
  }
  return lines.slice(0, 4);
}

function SlideFrame({ children, theme, number, source, style }) {
  return (
    <section className="c-doc-slide" style={{ background: hex(theme.bg), color: hex(theme.ink), ...style }}>
      {children}
      {source ? <span className="c-doc-slide__source" style={{ color: hex(theme.body) }}>来源：{source}</span> : null}
      {number ? <span className="c-doc-slide__no">{number}</span> : null}
    </section>
  );
}

function DeckPreview({ content, resolveImage }) {
  const deck = useMemo(() => parseDeckPreview(content), [content]);
  if (!deck) return <div className="c-doc-fallback"><ConsoleIcon name="alert" size={20} />这份 PPT 的内容不是可识别的规格，下载后可能打不开。</div>;
  const theme = themeOf(deck.theme);
  const quality = useMemo(() => inspectDeckQuality(deck), [deck]);
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const total = slides.length + 1;
  const coverImage = resolveImage?.({}, -1) || null;
  const coverTopics = slides.filter((slide) => !['section', 'thanks'].includes(String(slide?.layout || '').toLowerCase()) && slide?.title).slice(0, 3).map((slide) => slide.title);

  return (
    <div className="c-doc-deck">
      {quality.issues.length ? (
        <div className={quality.pass ? 'c-doc-quality' : 'c-doc-quality is-error'}>
          <ConsoleIcon name={quality.pass ? 'info' : 'alert'} size={16} />
          <span>{quality.issues.slice(0, 3).map((issue) => `${issue.page ? `第 ${issue.page} 页` : '整份'}：${issue.message}`).join('；')}</span>
        </div>
      ) : null}
      {/* 封面：有图就整页铺图 + 深色蒙层（白字压在照片上必须压暗才看得清） */}
      <section className={`c-doc-slide c-doc-slide--cover${!coverImage && coverTopics.length ? ' has-topics' : ''}`} style={{ background: hex(theme.cover), color: '#fff' }}>
        {coverImage ? <img className="c-doc-slide__bg" src={coverImage} alt="" /> : null}
        {coverImage ? <span className="c-doc-slide__scrim" style={{ background: hex(theme.cover) }} /> : null}
        <div className="c-doc-cover-copy">
          <h3>{deck.title || '演示文稿'}</h3>
          {deck.subtitle ? <p style={{ color: hex(theme.soft) }}>{deck.subtitle}</p> : null}
          {deck.author ? <small style={{ color: hex(theme.soft) }}>{deck.author}</small> : null}
        </div>
        {!coverImage && coverTopics.length ? <ol className="c-doc-cover-topics">{coverTopics.map((topic, index) => <li key={topic}><b>{String(index + 1).padStart(2, '0')}</b><span>{topic}</span></li>)}</ol> : null}
      </section>

      {slides.map((slide, index) => {
        const layout = String(slide?.layout || '').toLowerCase();
        const image = resolveImage?.(slide, index) || null;
        const bullets = Array.isArray(slide?.bullets) ? slide.bullets : [];
        const number = `${index + 2} / ${total}`;
        const pageProps = { theme, number, source: slide?.source || '' };

        if (layout === 'thanks') {
          return (
            <section className="c-doc-slide c-doc-slide--thanks" key={index} style={{ background: hex(theme.cover), color: '#fff' }}>
              <h3>谢谢观看</h3>
              <p style={{ color: hex(theme.soft) }}>{deck.title || ''}</p>
            </section>
          );
        }
        if (layout === 'section') {
          const topics = [];
          for (let cursor = index + 1; cursor < slides.length && topics.length < 3; cursor += 1) {
            const candidate = slides[cursor];
            if (['section', 'thanks'].includes(String(candidate?.layout || '').toLowerCase())) break;
            if (candidate?.title) topics.push(candidate.title);
          }
          const matched = String(slide.title || '').match(/^\s*(\d{1,2})[\s、.：:-]*(.*)$/);
          const sectionNo = matched ? matched[1].padStart(2, '0') : '';
          const sectionTitle = matched?.[2] || slide.title || '';
          return (
            <SlideFrame key={index} theme={theme} style={{ background: hex(theme.cover), color: '#fff' }}>
              <span className="c-doc-section-no" style={{ color: hex(theme.accent) }}>{sectionNo || '•'}</span>
              <h3 className="c-doc-slide__section">{sectionTitle}</h3>
              {topics.length ? <ol className="c-doc-section-topics">{topics.map((topic, topicIndex) => <li key={topic}><b>{String(topicIndex + 1).padStart(2, '0')}</b><span>{topic}</span></li>)}</ol> : null}
            </SlideFrame>
          );
        }
        if (layout === 'quote') {
          return (
            <SlideFrame key={index} theme={theme}>
              <blockquote className="c-doc-slide__quote">{quoteLines(slide.title || bullets[0] || '').map((line) => <span key={line}>{line}</span>)}</blockquote>
            </SlideFrame>
          );
        }
        if (layout === 'metrics') {
          const metrics = Array.isArray(slide?.metrics) ? slide.metrics.slice(0, 4) : [];
          return (
            <SlideFrame key={index} {...pageProps}>
              <h4 style={{ color: hex(theme.ink) }}>{slide.title || '关键数据'}</h4>
              <div className="c-doc-metrics" style={{ '--metrics-count': metrics.length === 3 ? 3 : metrics.length <= 2 ? Math.max(1, metrics.length) : 2 }}>
                {metrics.map((item, metricIndex) => (
                  <div key={metricIndex} style={{ background: hex(theme.soft) }}>
                    <strong style={{ color: hex(theme.accent) }}>{item?.value || ''}</strong>
                    <span style={{ color: hex(theme.body) }}>{item?.label || ''}</span>
                  </div>
                ))}
              </div>
            </SlideFrame>
          );
        }
        if (layout === 'timeline') {
          const steps = Array.isArray(slide?.steps) ? slide.steps.slice(0, 6) : [];
          return (
            <SlideFrame key={index} {...pageProps}>
              <h4 style={{ color: hex(theme.ink) }}>{slide.title || '推进步骤'}</h4>
              <ol className="c-doc-timeline" style={{ '--timeline-count': steps.length, '--slide-accent': hex(theme.accent), '--slide-soft': hex(theme.soft), color: hex(theme.body) }}>
                {steps.map((step, stepIndex) => <li key={stepIndex}><b>{String(stepIndex + 1).padStart(2, '0')}</b><span>{typeof step === 'string' ? step : step?.text || step?.title || ''}</span></li>)}
              </ol>
            </SlideFrame>
          );
        }
        if (layout === 'comparison') {
          const columns = Array.isArray(slide?.columns) ? slide.columns.slice(0, 2) : [];
          return (
            <SlideFrame key={index} {...pageProps}>
              <h4 style={{ color: hex(theme.ink) }}>{slide.title || '方案对比'}</h4>
              <div className="c-doc-comparison">
                {columns.map((column, columnIndex) => (
                  <section key={columnIndex} style={{ background: columnIndex === 0 ? hex(theme.soft) : `color-mix(in srgb, ${hex(theme.soft)} 58%, ${hex(theme.bg)})` }}>
                    <strong style={{ color: hex(theme.ink) }}>{column?.title || ''}</strong>
                    <ul style={{ color: hex(theme.body) }}>{(column?.bullets || []).map((item, itemIndex) => <li key={itemIndex}>{String(item)}</li>)}</ul>
                  </section>
                ))}
              </div>
            </SlideFrame>
          );
        }
        if (layout === 'chart' && slide?.chart) {
          const chart = slide.chart;
          const labels = (Array.isArray(chart.labels) ? chart.labels : []).slice(0, 7);
          const values = (Array.isArray(chart.values) ? chart.values.map(Number) : []).slice(0, labels.length);
          const max = Math.max(...values.map((value) => Math.abs(value)), 1);
          return (
            <SlideFrame key={index} {...pageProps}>
              <h4 style={{ color: hex(theme.ink) }}>{slide.title || '数据变化'}</h4>
              <div className={`c-doc-chart is-${chart.type || 'bar'}`}>
                {labels.map((label, itemIndex) => {
                  const value = values[itemIndex] || 0;
                  const active = itemIndex === Number(chart.highlight);
                  return (
                    <div className={active ? 'is-highlight' : ''} key={itemIndex} style={{ '--chart-color': hex(active ? theme.accent : theme.ink), '--chart-size': `${Math.max(4, Math.abs(value) / max * 100)}%` }}>
                      <span>{label}</span><i /><strong>{value}{chart.unit || ''}</strong>
                    </div>
                  );
                })}
              </div>
            </SlideFrame>
          );
        }
        if (layout === 'table' && slide?.table) {
          return (
            <SlideFrame key={index} {...pageProps}>
              <h4 style={{ color: hex(theme.ink) }}>{slide.title || '关键明细'}</h4>
              <div className="c-doc-data-table">
                <table>
                  <thead><tr>{(slide.table.headers || []).slice(0, 5).map((header, headerIndex) => <th key={headerIndex} style={{ background: hex(theme.ink) }}>{header}</th>)}</tr></thead>
                  <tbody>{(slide.table.rows || []).slice(0, 6).map((row, rowIndex) => <tr key={rowIndex}>{row.slice(0, 5).map((cell, cellIndex) => <td key={cellIndex} style={{ background: rowIndex % 2 === 0 ? hex(theme.soft) : hex(theme.bg), color: cellIndex === 0 ? hex(theme.ink) : hex(theme.body) }}>{cell}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </SlideFrame>
          );
        }
        if (layout === 'process') {
          const items = Array.isArray(slide?.process) ? slide.process.slice(0, 5) : [];
          return (
            <SlideFrame key={index} {...pageProps}>
              <h4 style={{ color: hex(theme.ink) }}>{slide.title || '实施路径'}</h4>
              <ol className="c-doc-process" style={{ '--process-count': items.length, '--slide-accent': hex(theme.accent), '--slide-ink': hex(theme.ink), '--slide-body': hex(theme.body) }}>
                {items.map((item, itemIndex) => <li key={itemIndex}><b>{String(itemIndex + 1).padStart(2, '0')}</b><strong>{item?.title || ''}</strong>{item?.detail ? <span>{item.detail}</span> : null}</li>)}
              </ol>
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
          <SlideFrame key={index} {...pageProps}>
            <h4 style={{ color: hex(theme.ink) }}>{slide.title || '（无标题）'}</h4>
            <div className={`c-doc-slide__body${image ? ' has-image' : ''}${!image ? ' is-numbered' : ''}`}>
              {bullets.length ? (image
                ? <ul style={{ color: hex(theme.body) }}>{bullets.map((item, i) => <li key={i}>{String(item)}</li>)}</ul>
                : <ol style={{ color: hex(theme.body) }}>{bullets.map((item, i) => <li key={i}><b style={{ color: i === 0 ? hex(theme.accent) : hex(theme.ink) }}>{String(i + 1).padStart(2, '0')}</b><span>{String(item)}</span></li>)}</ol>) : null}
              {image ? <img src={image} alt="" loading="lazy" /> : null}
            </div>
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
