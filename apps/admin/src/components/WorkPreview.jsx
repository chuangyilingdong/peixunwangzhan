// 平台端「学生作品预览」（2026-09-20）。
//
// 用户口径：「平台能看到作品，但是也要能预览吧。现在只有个标题」—— 列表那条只给标题/状态，
// 所以这里另取一次详情（`/api/admin/vibecoding-works/:id`，带 files / entryFile / artifacts /
// 服务端拼好的 fileUrls），再用与机构端同一套 Replay* 组件渲染：
//   · 网页产物 → 在不带 allow-same-origin 的沙箱里**真跑**（学生代码能玩）；
//   · 真文件产物（PPT/Word/Excel）→ 给服务端转出来的 PDF（这类没有「规格文本」，前端渲染不了）；
//   · 规格文本产物（老链路）→ ReplayDocument。
// 平台作用域与机构端同样把作品快照里的私有图片转成 data:，供沙箱网页和规格文档使用。
import { useEffect, useState } from 'react';
import { buildPreviewDocument, Empty, ErrorState, formatDate, Loading, Notice, Panel, ReplayDocument, ReplayFiles, ReplayPreview, useData } from '@platform/shared';

export function WorkPreview({ api, workId, title, onClose }) {
  // ⚠️ admin 应用的接口路径要带 `admin/` 前缀（这个页面别处的调用都长这样：
  //    `admin/works/...` / `admin/vibecoding-works/...`）。少写这一段就会打到 `/api/vibecoding-works/...`，
  //    界面报的是「接口不存在」——2026-09-20 我第一版就是这么漏的。
  const detail = useData(() => api.get(`admin/vibecoding-works/${encodeURIComponent(workId)}`), [api, workId]);
  const [activeName, setActiveName] = useState('');
  const [images, setImages] = useState({});
  const [imageError, setImageError] = useState('');
  const data = detail.data;
  useEffect(() => {
    let cancelled = false;
    setImages({}); setImageError('');
    Promise.allSettled(Object.entries(data?.imageUrls || {}).map(async ([id, path]) => {
      const prefix = `/api/admin/vibecoding-works/${encodeURIComponent(workId)}/images/`;
      if (typeof path !== 'string' || !path.startsWith(prefix)) throw new Error('图片地址不属于此作品。');
      return [id, await api.fetchDataUrl(path)];
    })).then((entries) => {
      if (cancelled) return;
      setImages(Object.fromEntries(entries.filter((entry) => entry.status === 'fulfilled' && entry.value?.[1]).map((entry) => entry.value)));
      if (entries.some((entry) => entry.status === 'rejected')) setImageError('部分作品图片不可用，已保留其余内容。');
    });
    return () => { cancelled = true; };
  }, [api, data]);

  const snapshotImage = (value) => {
    const raw = String(value || '');
    const match = raw.match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:[?#].*)?$/);
    if (match) return images[match[1]] || null;
    const entry = Object.entries(data?.imageUrls || {}).find(([, path]) => path === raw);
    if (entry) return images[entry[0]] || null;
    return /^data:image\//i.test(raw) || /^https:\/\//i.test(raw) ? raw : null;
  };
  const files = Object.fromEntries(Object.entries(data?.files || {}).map(([name, content]) => {
    let resolved = String(content ?? '');
    for (const [id, url] of Object.entries(images)) resolved = resolved.split(`/api/student/file-assets/${id}/download`).join(url);
    return [name, resolved];
  }));
  const artifacts = data?.artifacts || [];
  const views = artifacts.filter((item) => item.document
    || ['pptx', 'docx', 'xlsx', 'html', 'htm'].includes(String(item.kind).toLowerCase())
    || /\.html?$/i.test(String(item.name || '')));
  const selected = views.find((item) => item.name === activeName)
    || views.find((item) => item.name === data?.preview?.name)
    || views.find((item) => item.name === data?.entryFile)
    || views[0];
  const entry = selected?.name || data?.entryFile;
  const isDocument = Boolean(selected) && (selected.document || ['pptx', 'docx', 'xlsx'].includes(String(selected.kind).toLowerCase()));
  const documentFile = isDocument ? (data?.fileUrls?.[selected.name] || null) : null;
  // 学生代码跑在不带 allow-same-origin 的沙箱里（口径⑧），网络一律禁掉
  const html = !isDocument && entry && Object.hasOwn(files, entry)
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">${buildPreviewDocument(files, entry)}`
    : '';

  return <Panel title={`作品预览 · ${title || '未命名作品'}`}
    actions={<button className="secondary-button" onClick={onClose}>关闭预览</button>}>
    {detail.loading ? <Loading label="正在读取作品内容…" />
      : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} />
        : data ? <>
          <p className="muted">{data.title || '未命名作品'} · 提交于 {formatDate(data.submittedAt)}</p>
          {imageError ? <Notice tone="warning">{imageError}</Notice> : null}
          {views.length > 1 ? <label>作品文件<select value={entry || ''} onChange={(event) => setActiveName(event.target.value)}>
            {views.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select></label> : null}
          {documentFile ? <iframe className="c-replay__doc" src={documentFile.preview} title={selected.name} />
            : isDocument ? <ReplayDocument artifact={{ ...selected, content: String(files[selected.name] ?? selected.content ?? '') }} resolveImage={(slide, slideIndex) => {
            const generated = selected.generatedImages?.find((item) => Number(item.slideIndex) === slideIndex && images[item.fileId]);
            if (generated) return images[generated.fileId];
            const ordinal = Number(slide?.image?.attachment ?? slide?.imageAttachment);
            const attachment = ordinal > 0 && selected.attachmentImages?.find((item) => Number(item.index) === ordinal && images[item.fileId]);
            if (attachment) return images[attachment.fileId];
            const reference = typeof slide?.image === 'string' ? slide.image : slide?.image?.url || slide?.image?.src;
            const embedded = selected.embeddedImages?.find((item) => item.fileId === slide?.image?.fileId && images[item.fileId]);
            return (embedded && images[embedded.fileId]) || snapshotImage(reference);
          }} />
            : html ? <ReplayPreview html={html} title={data.title || '学生作品'} />
              : <Empty title="这件作品没有可预览的产物" body="没有网页入口、也没有可预览的文档产物。" />}
          {documentFile?.download ? <p className="muted top-gap"><a href={documentFile.download}>下载原文件</a>（预览是服务端转出来的 PDF）</p> : null}
          {Object.keys(files).length ? <details className="top-gap"><summary>查看作品源文件</summary><ReplayFiles files={files} entryFile={entry} /></details> : null}
        </> : null}
  </Panel>;
}
