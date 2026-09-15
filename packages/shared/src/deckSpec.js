const PPT_LAYOUTS = new Set(['section', 'quote', 'thanks', 'metrics', 'timeline', 'comparison', 'chart', 'table', 'process']);
const NON_IMAGE_LAYOUTS = new Set([...PPT_LAYOUTS]);
export const MAX_SLIDES = 40;

function cleanText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function cleanChart(value) {
  if (!value || typeof value !== 'object') return null;
  const rawLabels = Array.isArray(value.labels) ? value.labels : [];
  const rawValues = Array.isArray(value.values) ? value.values : [];
  const points = rawLabels.map((label, index) => ({
    originalIndex: index,
    label: cleanText(label).trim().slice(0, 12),
    value: Number(rawValues[index]),
  })).filter((point) => point.label && Number.isFinite(point.value) && point.value >= 0).slice(0, 7);
  if (points.length < 2) return null;
  const requestedHighlight = Number(value.highlight);
  const remappedHighlight = Number.isInteger(requestedHighlight) ? points.findIndex((point) => point.originalIndex === requestedHighlight) : -1;
  return {
    type: ['bar', 'column'].includes(String(value.type || '').toLowerCase()) ? String(value.type).toLowerCase() : 'bar',
    labels: points.map((point) => point.label),
    values: points.map((point) => point.value),
    unit: cleanText(value.unit || '').trim().slice(0, 16),
    highlight: remappedHighlight >= 0 ? remappedHighlight : points.length - 1,
  };
}

function cleanTable(value) {
  if (!value || typeof value !== 'object') return null;
  const headers = (Array.isArray(value.headers) ? value.headers : []).map((item) => cleanText(item).trim().slice(0, 12)).slice(0, 5);
  if (headers.length < 2) return null;
  const cellLimit = headers.length >= 4 ? 18 : 28;
  const rows = (Array.isArray(value.rows) ? value.rows : []).slice(0, 6).map((row) =>
    Array.from({ length: headers.length }, (_, index) => cleanText(Array.isArray(row) ? row[index] : '').trim().slice(0, cellLimit)),
  ).filter((row) => row.some(Boolean));
  return rows.length ? { headers, rows } : null;
}

function cleanProcess(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    title: cleanText(typeof item === 'string' ? item : item?.title || '').trim().slice(0, 14),
    detail: cleanText(typeof item === 'string' ? '' : item?.detail || item?.description || '').trim().slice(0, 32),
  })).filter((item) => item.title).slice(0, 5);
}

export function parseDeckSpec(content) {
  const text = cleanText(content).trim();
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fenced) candidates.unshift(fenced[1]);
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const slides = Array.isArray(parsed.slides) ? parsed.slides : [];
    if (!slides.length) continue;
    return {
      title: cleanText(parsed.title || '').trim().slice(0, 120),
      subtitle: cleanText(parsed.subtitle || '').trim().slice(0, 180),
      author: cleanText(parsed.author || '').trim().slice(0, 80),
      theme: String(parsed.theme || '').trim().toLowerCase().slice(0, 20) || undefined,
      cover: parsed.cover && typeof parsed.cover === 'object' && String(parsed.cover.prompt || '').trim()
        ? { prompt: cleanText(parsed.cover.prompt).trim().slice(0, 300) } : undefined,
      slides: slides.slice(0, MAX_SLIDES).map((slide) => {
        const requestedLayout = PPT_LAYOUTS.has(String(slide?.layout || '').toLowerCase())
          ? String(slide.layout).toLowerCase() : undefined;
        const chart = cleanChart(slide?.chart);
        const table = cleanTable(slide?.table);
        const process = cleanProcess(slide?.process || (requestedLayout === 'process' ? slide?.steps : []));
        const inferredLayout = requestedLayout || (chart ? 'chart' : table ? 'table' : process.length >= 2 ? 'process' : undefined);
        const layout = inferredLayout === 'chart' && !chart
          ? undefined : inferredLayout === 'table' && !table
            ? undefined : inferredLayout === 'process' && process.length < 2
              ? undefined : inferredLayout;
        const supportsImage = !NON_IMAGE_LAYOUTS.has(layout);
        const attachment = Number(slide?.image?.attachment ?? slide?.imageAttachment);
        return {
          title: cleanText(slide?.title || '').trim().slice(0, 120),
          bullets: (Array.isArray(slide?.bullets) ? slide.bullets : []).map((item) => cleanText(item).trim().slice(0, 160)).filter(Boolean).slice(0, 8),
          imageAttachment: supportsImage && Number.isInteger(attachment) && attachment >= 1 && attachment <= 20 ? attachment : null,
          imagePrompt: supportsImage ? (cleanText(slide?.image?.prompt || slide?.imagePrompt || '').trim().slice(0, 300) || null) : null,
          metrics: (Array.isArray(slide?.metrics) ? slide.metrics : []).map((item) => ({
            value: cleanText(item?.value || '').trim().slice(0, 24),
            label: cleanText(item?.label || '').trim().slice(0, 36),
          })).filter((item) => item.value || item.label).slice(0, 4),
          steps: (Array.isArray(slide?.steps) ? slide.steps : []).map((item) => cleanText(typeof item === 'string' ? item : item?.text || item?.title || '').trim().slice(0, 48)).filter(Boolean).slice(0, 6),
          columns: (Array.isArray(slide?.columns) ? slide.columns : []).map((item) => ({
            title: cleanText(item?.title || '').trim().slice(0, 28),
            bullets: (Array.isArray(item?.bullets) ? item.bullets : []).map((value) => cleanText(value).trim().slice(0, 48)).filter(Boolean).slice(0, 5),
          })).filter((item) => item.title || item.bullets.length).slice(0, 2),
          chart,
          table,
          process,
          source: cleanText(slide?.source || '').trim().slice(0, 72),
          layout,
        };
      }).filter((slide) => slide.title || slide.bullets.length || slide.metrics.length || slide.steps.length || slide.columns.length || slide.chart || slide.table || slide.process.length || slide.imageAttachment || slide.imagePrompt || slide.layout),
    };
  }
  return null;
}

export function deckIllustrationRequests(deck, coverImageKey = -1) {
  const requests = [];
  if (deck?.cover?.prompt) requests.push({ slideIndex: coverImageKey, prompt: String(deck.cover.prompt).trim() });
  (Array.isArray(deck?.slides) ? deck.slides : []).forEach((slide, index) => {
    const prompt = String(slide?.imagePrompt || '').trim();
    if (prompt) requests.push({ slideIndex: index, prompt });
  });
  return requests;
}

export function inspectDeckQuality(deck) {
  const slides = Array.isArray(deck?.slides) ? deck.slides : [];
  const issues = [];
  let repeated = 1;
  slides.forEach((slide, index) => {
    const page = index + 2;
    const layout = slide.layout || 'bullets';
    if (index > 0 && layout === (slides[index - 1].layout || 'bullets')) repeated += 1;
    else repeated = 1;
    if (repeated >= 4 && !['section', 'thanks'].includes(layout)) issues.push({ level: 'warning', code: 'REPEATED_LAYOUT', page, message: `连续 ${repeated} 页使用 ${layout} 版式` });
    if (String(slide.title || '').length > 36) issues.push({ level: 'warning', code: 'LONG_TITLE', page, message: '标题超过 36 字' });
    if (slide.bullets?.length > 7) issues.push({ level: 'warning', code: 'DENSE_BULLETS', page, message: `正文有 ${slide.bullets.length} 条要点` });
    if (layout === 'metrics' && (slide.metrics?.length || 0) < 2) issues.push({ level: 'warning', code: 'SPARSE_METRICS', page, message: '指标页少于 2 个指标' });
    if (layout === 'metrics' && !slide.source) issues.push({ level: 'error', code: 'MISSING_SOURCE', page, message: '指标页没有标注数据来源或统计口径' });
    if (layout === 'chart' && !slide.source) issues.push({ level: 'error', code: 'MISSING_SOURCE', page, message: '图表页没有标注数据来源' });
    if (layout === 'chart' && new Set(slide.chart?.values || []).size === 1) issues.push({ level: 'warning', code: 'FLAT_CHART', page, message: '图表所有数值相同，难以表达趋势' });
    if (layout === 'table' && !slide.source) issues.push({ level: 'error', code: 'MISSING_SOURCE', page, message: '表格页没有标注数据来源' });
    const tableChars = (slide.table?.rows || []).flat().reduce((sum, cell) => sum + String(cell || '').length, 0);
    if (layout === 'table' && tableChars > 260) issues.push({ level: 'warning', code: 'DENSE_TABLE', page, message: '表格文字接近容量上限' });
    if (layout === 'process' && (slide.process?.length || 0) < 3) issues.push({ level: 'warning', code: 'SHORT_PROCESS', page, message: '流程少于 3 步' });
  });
  const contentLayouts = new Set(slides.map((slide) => slide.layout || 'bullets').filter((layout) => !['section', 'thanks'].includes(layout)));
  if (slides.length >= 7 && contentLayouts.size < 3) issues.push({ level: 'warning', code: 'LOW_LAYOUT_VARIETY', page: 0, message: '较长演示稿至少应使用 3 种内容版式' });
  return { pass: !issues.some((issue) => issue.level === 'error'), issues };
}
