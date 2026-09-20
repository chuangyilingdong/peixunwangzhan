// 平台端「学生作品预览」（2026-09-20）。
//
// 用户口径：「平台能看到作品，但是也要能预览吧。现在只有个标题」—— 列表那条只给标题/状态，
// 所以这里另取一次详情（`/api/admin/vibecoding-works/:id`，带 files / entryFile / artifacts /
// 服务端拼好的 fileUrls），再用与机构端同一套 Replay* 组件渲染：
//   · 网页产物 → 在不带 allow-same-origin 的沙箱里**真跑**（学生代码能玩）；
//   · 真文件产物（PPT/Word/Excel）→ 给服务端转出来的 PDF（这类没有「规格文本」，前端渲染不了）；
//   · 规格文本产物（老链路）→ ReplayDocument。
// 与机构端那个弹窗的差别只有两处：作用域是平台（超管），以及**不做**图片 blob → data: 的转换
// （那套是机构端为私有图片加的；平台这边嵌入图多半引用学生私有素材地址，取不到就空着，不假装有）。
import { useState } from 'react';
import { buildPreviewDocument, Empty, ErrorState, formatDate, Loading, Notice, Panel, ReplayDocument, ReplayFiles, ReplayPreview, useData } from '@platform/shared';

export function WorkPreview({ api, workId, title, onClose }) {
  // ⚠️ admin 应用的接口路径要带 `admin/` 前缀（这个页面别处的调用都长这样：
  //    `admin/works/...` / `admin/vibecoding-works/...`）。少写这一段就会打到 `/api/vibecoding-works/...`，
  //    界面报的是「接口不存在」——2026-09-20 我第一版就是这么漏的。
  const detail = useData(() => api.get(`admin/vibecoding-works/${encodeURIComponent(workId)}`), [api, workId]);
  const [activeName, setActiveName] = useState('');
  const data = detail.data;

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
  const files = data?.files || {};
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
          {views.length > 1 ? <label>作品文件<select value={entry || ''} onChange={(event) => setActiveName(event.target.value)}>
            {views.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select></label> : null}
          {documentFile ? <>
            <iframe className="c-replay__doc" src={documentFile.preview} title={selected.name} />
            <p className="muted top-gap"><a href={documentFile.download}>下载原文件</a>（预览是服务端转出来的 PDF）</p>
          </> : isDocument ? <ReplayDocument artifact={{ ...selected, content: String(files[selected.name] ?? selected.content ?? '') }} />
            : html ? <ReplayPreview html={html} title={data.title || '学生作品'} />
              : <Empty title="这件作品没有可预览的产物" body="没有网页入口、也没有可预览的文档产物。" />}
          {Object.keys(files).length ? <details className="top-gap"><summary>查看作品源文件</summary><ReplayFiles files={files} entryFile={entry} /></details> : null}
        </> : null}
  </Panel>;
}
