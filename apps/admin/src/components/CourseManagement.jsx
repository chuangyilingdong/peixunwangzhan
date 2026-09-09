// 平台课包管理：列表视图 + 课包详情（标签页）+ 课时编辑抽屉
import { useEffect, useMemo, useState } from 'react';
import {
  Empty, ErrorState, ListResultSummary, Loading, MetricCard, Notice, PageHeader, Panel,
  Pagination, Status, formatDate, useData,
} from '@platform/shared';

const VISIBILITY_LABELS = { ALL_ORGS: '所有机构', ASSIGNED_ORGS: '仅已授权机构', PRIVATE: '私有' };
const LESSON_CAPABILITY_OPTIONS = [
  ['text', 'AI 文字'], ['image', 'AI 生图'], ['video', 'AI 生视频'],
  ['music', 'AI 音乐'], ['podcast', 'AI 播客'], ['dubbing', 'AI 配音'],
];
const MATERIAL_TYPE_OPTIONS = [
  ['IMAGE', '图片'], ['VIDEO', '视频'], ['AUDIO', '音频'], ['NOTE', '文字说明'], ['PROMPT', '提示词'],
];
const TEACHING_TYPE_OPTIONS = [
  ['VIDEO', '视频'], ['PPT', 'PPT'], ['PDF', 'PDF'], ['WORD', 'Word'], ['EXCEL', 'Excel'], ['FILE', '其他文件'],
];
// 生成比例/清晰度/时长的可选项来自「计费与模型」里每个模型的能力配置，这里只负责兜底展示历史值。
function valueOptionsFor(options, current) {
  const list = Array.isArray(options) ? options : [];
  if (current !== undefined && current !== null && current !== '' && !list.includes(current)) return [current, ...list];
  return list;
}
let uidSeed = 0;
function nextUid() { uidSeed += 1; return `tmp-${Date.now().toString(36)}-${uidSeed}`; }
const defaultClassroomConfig = {
  version: 1,
  generationSlots: {
    image: { count: 0, aspectRatio: '16:9', resolution: '1k', model: '' },
    video: { count: 0, aspectRatio: '16:9', resolution: '480p', durationSeconds: 5, model: '', audio: false },
  },
};
const emptyCourseForm = {
  title: '', description: '', coverImageUrl: '', coverAssetId: '', priceYuan: '', version: '1.0',
  estimatedCreditsPerPerson: '', gradeRange: '', visibility: 'ALL_ORGS', deliveryMode: 'CANVAS',
  difficultyLevel: '', ageRangeMin: '', ageRangeMax: '', tags: '',
};

function classroomConfigFor(lesson, edit) {
  const value = edit.classroomConfig ?? lesson.classroomConfig ?? {};
  return {
    ...defaultClassroomConfig,
    ...value,
    generationSlots: {
      ...defaultClassroomConfig.generationSlots,
      ...(value.generationSlots || {}),
      image: { ...defaultClassroomConfig.generationSlots.image, ...(value.generationSlots?.image || {}) },
      video: { ...defaultClassroomConfig.generationSlots.video, ...(value.generationSlots?.video || {}) },
    },
  };
}

function coverUrlOf(course) {
  if (course.coverAssetId) return `/api/public/file-assets/${course.coverAssetId}/download`;
  return course.coverImageUrl || '';
}

/* ---------------------------------------------------------------- 课时画布配置 */

// 教学素材（教师备课资料，学生不可见）
function LessonTeachingEditor({ api, lesson, edit, onChange }) {
  const groups = edit.teachingGroups ?? lesson.teachingGroups ?? [];
  const [uploading, setUploading] = useState('');
  // 一律用函数式更新：上传回调完成时要基于最新 state 合并，否则会把上传期间新增的素材覆盖掉。
  const updateGroups = (mapper) => onChange((current) => ({ ...current, teachingGroups: mapper(current.teachingGroups ?? lesson.teachingGroups ?? []) }));
  const updateGroup = (index, patch) => updateGroups((list) => list.map((group, i) => i === index ? { ...group, ...patch } : group));
  function updateAsset(groupIndex, assetIndex, uid, patch) {
    updateGroups((list) => list.map((group, i) => {
      if (i !== groupIndex) return group;
      const assets = group.assets || [];
      const matched = uid ? assets.findIndex((item) => item.uid === uid) : -1;
      const index = matched >= 0 ? matched : assetIndex;
      if (!assets[index]) return group;
      return { ...group, assets: assets.map((item, j) => j === index ? { ...item, ...patch } : item) };
    }));
  }
  const removeAsset = (groupIndex, assetIndex) => updateGroups((list) => list.map((group, i) => i !== groupIndex ? group : { ...group, assets: (group.assets || []).filter((_, j) => j !== assetIndex) }));
  const addAsset = (groupIndex) => updateGroups((list) => list.map((group, i) => {
    if (i !== groupIndex) return group;
    const assets = group.assets || [];
    return { ...group, assets: [...assets, { uid: nextUid(), title: `素材${assets.length + 1}`, description: '', assetType: 'FILE', assetUrl: '' }] };
  }));
  async function uploadAsset(groupIndex, assetIndex, file) {
    if (!file) return;
    const uid = groups[groupIndex]?.assets?.[assetIndex]?.uid;
    const key = `${groupIndex}:${assetIndex}`; setUploading(key);
    try {
      const asset = await api.upload('admin/file-assets/upload', file, { category: 'TEACHING_ASSET', visibility: 'PUBLIC_PLATFORM' });
      if (!asset?.id) throw new Error('上传成功但未返回文件标识');
      // 教学素材走机构端受控下载路由，下载时会校验课包对当前机构的授权。
      updateAsset(groupIndex, assetIndex, uid, { assetUrl: `/api/org/file-assets/${asset.id}/download`, fileAssetId: asset.id });
    } catch (error) { window.alert(error.message); } finally { setUploading(''); }
  }
  return <div className="lesson-teaching-materials">
    <div className="lesson-config-heading"><strong>教学素材（教师备课资料，学生不可见）</strong><button type="button" className="text-button" onClick={() => updateGroups((list) => [...list, { uid: nextUid(), title: `教学素材${list.length + 1}`, assets: [] }])}>＋素材组</button></div>
    {groups.map((group, groupIndex) => <div className="lesson-material-group-editor" key={group.id || group.uid || `new-${groupIndex}`}>
      <div className="lesson-config-row"><input value={group.title || ''} placeholder={`教学素材${groupIndex + 1}`} onChange={(event) => updateGroup(groupIndex, { title: event.target.value })} /><button type="button" className="text-button danger-text" onClick={() => updateGroups((list) => list.filter((_, i) => i !== groupIndex))}>删除组</button></div>
      {(group.assets || []).map((asset, assetIndex) => <div className="lesson-material-item-editor" key={asset.id || asset.uid || `new-${assetIndex}`}>
        <div className="lesson-config-row"><input value={asset.title || ''} placeholder="素材名称" onChange={(event) => updateAsset(groupIndex, assetIndex, asset.uid, { title: event.target.value })} /><select value={asset.assetType || 'FILE'} onChange={(event) => updateAsset(groupIndex, assetIndex, asset.uid, { assetType: event.target.value })}>{TEACHING_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button type="button" className="text-button danger-text" onClick={() => removeAsset(groupIndex, assetIndex)}>删除</button></div>
        <input value={asset.description || ''} placeholder="给老师看的说明（可选）" onChange={(event) => updateAsset(groupIndex, assetIndex, asset.uid, { description: event.target.value })} />
        <input value={asset.assetUrl || ''} placeholder="文件地址（可上传）" onChange={(event) => updateAsset(groupIndex, assetIndex, asset.uid, { assetUrl: event.target.value })} />
        <label className="inline-file-upload">{uploading === `${groupIndex}:${assetIndex}` ? '上传中…' : '上传文件'}<input type="file" accept="video/*,application/pdf,.pptx,.docx,.xlsx,.zip,.txt" disabled={uploading === `${groupIndex}:${assetIndex}`} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; uploadAsset(groupIndex, assetIndex, file); }} /></label>
      </div>)}
      <button type="button" className="text-button" onClick={() => addAsset(groupIndex)}>＋素材</button>
    </div>)}
    {!groups.length && <p className="muted">还没有教学素材。上传课件、视频等备课资料后，机构端教师可在课时详情查看下载。</p>}
  </div>;
}

function LessonCanvasConfigEditor({ api, lesson, edit, onChange }) {
  const providerConfig = useData(() => api.get('admin/billing-config/ai-provider'), [api]);
  const providerPolicy = providerConfig.data?.policy;
  const capabilityDefaults = providerConfig.data?.capabilityDefaults || {};
  function channelOf(modality) {
    const channelId = providerPolicy?.modalityChannels?.[modality];
    return (providerPolicy?.channels || []).find((item) => item.id === channelId) || null;
  }
  function channelModels(modality) {
    const channel = channelOf(modality);
    if (!channel) return [];
    if (Array.isArray(channel.models) && channel.models.length) return channel.models;
    return channel.model ? [channel.model] : [];
  }
  // 某模态下选定模型的有效能力（比例/清晰度/时长/音频）；未单独配置时用模态默认值。
  function capabilitiesFor(modality, modelId) {
    const channel = channelOf(modality);
    const model = String(modelId || '').trim() || String(channel?.model || '').trim();
    return channel?.modelCapabilities?.[model] || capabilityDefaults[modality] || { aspectRatios: [], resolutions: [], durations: [], audio: false };
  }
  const deliveryMode = edit.deliveryMode ?? lesson.deliveryMode ?? 'CANVAS';
  const capabilities = edit.capabilities ?? lesson.capabilities ?? ['text'];
  const groups = edit.materialGroups ?? lesson.materialGroups ?? [];
  const classroomConfig = classroomConfigFor(lesson, edit);
  const [uploading, setUploading] = useState('');
  // 全部改成函数式更新：连续编辑或上传回调都基于最新 state 合并，不会互相覆盖。
  const update = (patch) => onChange((current) => ({ ...current, ...patch }));
  const updateGroups = (mapper) => onChange((current) => ({ ...current, materialGroups: mapper(current.materialGroups ?? lesson.materialGroups ?? []) }));
  const updateGroup = (index, patch) => updateGroups((list) => list.map((group, i) => i === index ? { ...group, ...patch } : group));
  function updateMaterial(groupIndex, materialIndex, uid, patch) {
    updateGroups((list) => list.map((group, i) => {
      if (i !== groupIndex) return group;
      const materials = group.materials || [];
      const matched = uid ? materials.findIndex((item) => item.uid === uid) : -1;
      const index = matched >= 0 ? matched : materialIndex;
      if (!materials[index]) return group;
      return { ...group, materials: materials.map((item, j) => j === index ? { ...item, ...patch } : item) };
    }));
  }
  const removeMaterial = (groupIndex, materialIndex) => updateGroups((list) => list.map((group, i) => i !== groupIndex ? group : { ...group, materials: (group.materials || []).filter((_, j) => j !== materialIndex) }));
  function updateSlot(type, patch) {
    onChange((current) => {
      const config = classroomConfigFor(lesson, current);
      return { ...current, classroomConfig: { ...config, generationSlots: { ...config.generationSlots, [type]: { ...config.generationSlots[type], ...patch } } } };
    });
  }
  // 换模型后，把新模型不支持的比例/清晰度/时长重置为它的第一个可选项。
  function changeModel(type, model) {
    const caps = capabilitiesFor(type === 'image' ? 'IMAGE' : 'VIDEO', model);
    const slot = classroomConfig.generationSlots[type];
    const patch = { model };
    if (!caps.aspectRatios.includes(slot.aspectRatio)) patch.aspectRatio = caps.aspectRatios[0] || slot.aspectRatio;
    if (!caps.resolutions.includes(slot.resolution)) patch.resolution = caps.resolutions[0] || slot.resolution;
    if (type === 'video') {
      if (!caps.durations.includes(Number(slot.durationSeconds))) patch.durationSeconds = caps.durations[0] || slot.durationSeconds;
      if (!caps.audio) patch.audio = false;
    }
    updateSlot(type, patch);
  }
  // 能力与框体联动：取消勾选 AI 生图 / AI 生视频时把对应框体数量清零，
  // 否则学生端仍会看到无法生成的框体。
  function toggleCapability(value, checked) {
    onChange((current) => {
      const caps = current.capabilities ?? lesson.capabilities ?? ['text'];
      const next = checked ? [...new Set([...caps, value])] : caps.filter((item) => item !== value);
      const config = classroomConfigFor(lesson, current);
      const slots = { ...config.generationSlots };
      if (!next.includes('image')) slots.image = { ...slots.image, count: 0 };
      if (!next.includes('video')) slots.video = { ...slots.video, count: 0 };
      return { ...current, capabilities: next, classroomConfig: { ...config, generationSlots: slots } };
    });
  }
  async function uploadMaterial(groupIndex, materialIndex, file) {
    if (!file) return;
    const uid = groups[groupIndex]?.materials?.[materialIndex]?.uid;
    const key = `${groupIndex}:${materialIndex}`; setUploading(key);
    try {
      const asset = await api.upload('admin/file-assets/upload', file, { category: 'MEDIA_ASSET', visibility: 'PUBLIC_PLATFORM' });
      const assetUrl = asset?.id ? `/api/student/file-assets/${asset.id}/download` : '';
      if (!assetUrl) throw new Error('上传成功但未返回文件标识');
      updateMaterial(groupIndex, materialIndex, uid, { assetUrl, snapshot: { assetId: asset.id } });
    } catch (error) { window.alert(error.message); } finally { setUploading(''); }
  }
  const addMaterial = (groupIndex) => updateGroups((list) => list.map((group, i) => {
    if (i !== groupIndex) return group;
    const materials = group.materials || [];
    return { ...group, materials: [...materials, { uid: nextUid(), title: `素材${materials.length + 1}`, description: '', materialType: 'NOTE', assetUrl: '', snapshot: {} }] };
  }));
  const addGroup = () => updateGroups((list) => [...list, { uid: nextUid(), title: `素材${list.length + 1}`, materials: [] }]);

  const imageSlot = classroomConfig.generationSlots.image;
  const videoSlot = classroomConfig.generationSlots.video;
  const imageCapabilities = capabilitiesFor('IMAGE', imageSlot.model);
  const videoCapabilities = capabilitiesFor('VIDEO', videoSlot.model);
  const showImage = capabilities.includes('image');
  const showVideo = capabilities.includes('video');

  return <div className="lesson-canvas-config-editor">
    <label>课堂类型<select value={deliveryMode} onChange={(event) => update({ deliveryMode: event.target.value })}><option value="CANVAS">课堂画布</option><option value="VIBECODING">VibeCoding 课堂</option></select></label>
    {deliveryMode === 'VIBECODING' ? <Notice>VibeCoding 课堂已上线：学生进入后与 AI 对话写代码。发布前请为本课时勾选「AI 文字」能力，否则发布会被拦下。</Notice> : <>
      <div className="lesson-capability-checks"><strong>本课开放能力</strong>{LESSON_CAPABILITY_OPTIONS.map(([value, label]) => <label key={value}><input type="checkbox" checked={capabilities.includes(value)} onChange={(event) => toggleCapability(value, event.target.checked)} />{label}</label>)}</div>
      <div className="lesson-material-groups"><div className="lesson-config-heading"><strong>本节课画布素材</strong><button type="button" className="text-button" onClick={addGroup}>＋素材组</button></div>
        {groups.map((group, groupIndex) => <div className="lesson-material-group-editor" key={group.id || group.uid || `new-${groupIndex}`}>
          <div className="lesson-config-row"><input value={group.title || ''} placeholder={`素材${groupIndex + 1}`} onChange={(event) => updateGroup(groupIndex, { title: event.target.value })} /><button type="button" className="text-button danger-text" onClick={() => updateGroups((list) => list.filter((_, i) => i !== groupIndex))}>删除组</button></div>
          {(group.materials || []).map((material, materialIndex) => { const snapshot = material.snapshot || {}; const isText = ['NOTE', 'PROMPT'].includes(material.materialType); return <div className="lesson-material-item-editor" key={material.id || material.uid || `new-${materialIndex}`}>
            <div className="lesson-config-row"><input value={material.title || ''} placeholder="素材标题" onChange={(event) => updateMaterial(groupIndex, materialIndex, material.uid, { title: event.target.value })} /><select value={material.materialType || 'NOTE'} onChange={(event) => updateMaterial(groupIndex, materialIndex, material.uid, { materialType: event.target.value })}>{MATERIAL_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button type="button" className="text-button danger-text" onClick={() => removeMaterial(groupIndex, materialIndex)}>删除</button></div>
            <input value={material.description || ''} placeholder="给学生看的说明（可选）" onChange={(event) => updateMaterial(groupIndex, materialIndex, material.uid, { description: event.target.value })} />
            {isText ? <textarea rows={2} value={snapshot.content || ''} placeholder={material.materialType === 'PROMPT' ? '提示词内容' : '文字内容'} onChange={(event) => updateMaterial(groupIndex, materialIndex, material.uid, { snapshot: { ...snapshot, content: event.target.value } })} /> : <><input value={material.assetUrl || ''} placeholder="资源地址（可粘贴 HTTPS，也可上传文件）" onChange={(event) => updateMaterial(groupIndex, materialIndex, material.uid, { assetUrl: event.target.value })} /><label className="inline-file-upload">{uploading === `${groupIndex}:${materialIndex}` ? '上传中…' : '上传文件'}<input type="file" accept="image/*,video/*,audio/*" disabled={uploading === `${groupIndex}:${materialIndex}`} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; uploadMaterial(groupIndex, materialIndex, file); }} /></label></>}
          </div>; })}
          <button type="button" className="text-button" onClick={() => addMaterial(groupIndex)}>＋素材</button>
        </div>)}
        {!groups.length && <p className="muted">还没有画布素材。学生进入课时后，可在左侧素材面板点击加入画布；提示词素材点击时会让学生选择插入哪个框体。</p>}
      </div>
      <div className="lesson-generation-slots"><div className="lesson-config-heading"><strong>本课生成框体限制</strong><span className="muted">选项来自「计费与模型」里所选模型的能力配置；只显示已开放的能力</span></div>
        {showImage ? <div className="form-grid"><label>生图框体数量<input type="number" min="0" max="20" value={imageSlot.count} onChange={(event) => updateSlot('image', { count: event.target.value })} /></label><label>生图比例<select value={imageSlot.aspectRatio} onChange={(event) => updateSlot('image', { aspectRatio: event.target.value })}>{valueOptionsFor(imageCapabilities.aspectRatios, imageSlot.aspectRatio).map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>生图清晰度<select value={imageSlot.resolution} onChange={(event) => updateSlot('image', { resolution: event.target.value })}>{valueOptionsFor(imageCapabilities.resolutions, imageSlot.resolution).map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>生图模型{channelModels('IMAGE').length ? <select value={imageSlot.model || ''} onChange={(event) => changeModel('image', event.target.value)}><option value="">使用渠道默认模型</option>{channelModels('IMAGE').map((model) => <option key={model} value={model}>{model}</option>)}</select> : <input value={imageSlot.model || ''} placeholder="渠道未配置模型，可手填" onChange={(event) => changeModel('image', event.target.value)} />}</label></div> : null}
        {showImage && !imageCapabilities.aspectRatios.length ? <p className="muted">该模型还没有配置可用比例，请先到「计费与模型」里填写。</p> : null}
        {showVideo ? <div className="form-grid"><label>生视频框体数量<input type="number" min="0" max="20" value={videoSlot.count} onChange={(event) => updateSlot('video', { count: event.target.value })} /></label><label>生视频比例<select value={videoSlot.aspectRatio} onChange={(event) => updateSlot('video', { aspectRatio: event.target.value })}>{valueOptionsFor(videoCapabilities.aspectRatios, videoSlot.aspectRatio).map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>生视频清晰度<select value={videoSlot.resolution} onChange={(event) => updateSlot('video', { resolution: event.target.value })}>{valueOptionsFor(videoCapabilities.resolutions, videoSlot.resolution).map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>单个视频时长（秒）<select value={String(videoSlot.durationSeconds)} onChange={(event) => updateSlot('video', { durationSeconds: Number(event.target.value) })}>{valueOptionsFor(videoCapabilities.durations.map(String), String(videoSlot.durationSeconds)).map((value) => <option key={value} value={value}>{value} 秒</option>)}</select></label><label>生视频模型{channelModels('VIDEO').length ? <select value={videoSlot.model || ''} onChange={(event) => changeModel('video', event.target.value)}><option value="">使用渠道默认模型</option>{channelModels('VIDEO').map((model) => <option key={model} value={model}>{model}</option>)}</select> : <input value={videoSlot.model || ''} placeholder="渠道未配置模型，可手填" onChange={(event) => changeModel('video', event.target.value)} />}</label><label className="checkbox-label"><input type="checkbox" checked={videoSlot.audio === true} disabled={!videoCapabilities.audio} onChange={(event) => updateSlot('video', { audio: event.target.checked })} />生成音频{videoCapabilities.audio ? '' : '（当前模型不支持）'}</label></div> : null}
        {showVideo && !videoCapabilities.aspectRatios.length ? <p className="muted">该模型还没有配置可用比例，请先到「计费与模型」里填写。</p> : null}
        {!showImage && !showVideo ? <p className="muted">当前未开放 AI 生图 / AI 生视频，学生端不会出现生成框体。勾选上方的能力后即可配置数量、比例、清晰度、时长和模型。</p> : null}
      </div>
    </>}
    <LessonTeachingEditor api={api} lesson={lesson} edit={edit} onChange={onChange} />
  </div>;
}

/* ---------------------------------------------------------------- 课时编辑抽屉 */

function LessonDrawer({ api, lesson, onClose, onSaved }) {
  const [edit, setEdit] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const title = edit.title ?? lesson.title;
  const summary = edit.summary ?? lesson.summary ?? '';
  const durationMinutes = edit.durationMinutes ?? lesson.durationMinutes ?? 45;
  const status = edit.status ?? lesson.status;
  const lessonContent = edit.lessonContent ?? lesson.lessonContent ?? '';
  const update = (patch) => setEdit((current) => ({ ...current, ...patch }));

  async function save() {
    setBusy(true); setMessage('');
    try {
      const body = {
        title, summary, durationMinutes: Number(durationMinutes), lessonContent,
        deliveryMode: edit.deliveryMode ?? lesson.deliveryMode ?? 'CANVAS',
        classroomConfig: edit.classroomConfig ?? lesson.classroomConfig ?? {},
        capabilities: edit.capabilities ?? lesson.capabilities ?? ['text'],
        materialGroups: edit.materialGroups ?? lesson.materialGroups ?? [],
        teachingGroups: edit.teachingGroups ?? lesson.teachingGroups ?? [],
      };
      if (status !== lesson.status) body.status = status;
      await api.request(`admin/course-lessons/${lesson.id}`, { method: 'PUT', body });
      onSaved?.(`课时「${title}」已保存。`);
      onClose();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  return <div className="drawer-overlay" onClick={onClose}>
    <div className="drawer-panel" onClick={(event) => event.stopPropagation()}>
      <header className="drawer-head">
        <div><span className="eyebrow">课时配置</span><h2>{title || '未命名课时'}</h2></div>
        <button type="button" className="drawer-close" onClick={onClose}>×</button>
      </header>
      <div className="drawer-body">
        {message && <Notice tone="danger">{message}</Notice>}
        <section className="drawer-section">
          <h3>基本信息</h3>
          <label>课时标题<input value={title} onChange={(event) => update({ title: event.target.value })} required /></label>
          <label>课时简介<textarea rows={2} value={summary} onChange={(event) => update({ summary: event.target.value })} /></label>
          <div className="form-grid">
            <label>时长（分钟）<input type="number" min="1" max="1440" value={durationMinutes} onChange={(event) => update({ durationMinutes: event.target.value })} /></label>
            <label>状态<select value={status} onChange={(event) => update({ status: event.target.value })}><option value="DRAFT">草稿</option><option value="PUBLISHED">已发布</option><option value="ARCHIVED">已下架</option></select></label>
          </div>
          <label>课时正文 / 教学指引<textarea rows={4} placeholder="≤50000 字" value={lessonContent} onChange={(event) => update({ lessonContent: event.target.value })} /></label>
        </section>
        <section className="drawer-section">
          <h3>课堂配置</h3>
          <LessonCanvasConfigEditor api={api} lesson={lesson} edit={edit} onChange={setEdit} />
        </section>
      </div>
      <footer className="drawer-foot">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="primary-button" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存课时'}</button>
      </footer>
    </div>
  </div>;
}

/* ---------------------------------------------------------------- 新建课包 */

const CREATE_STEPS = ['基本信息', '课时与课堂配置', '更多设置', '完成并发布'];

function emptyLessonDraft() {
  return { title: '', capabilities: ['text'], materialGroups: [], teachingGroups: [], classroomConfig: {} };
}

function CreateCourseModal({ api, onClose, onCreated }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(emptyCourseForm);
  const [lessons, setLessons] = useState([emptyLessonDraft()]);
  const [expandedLesson, setExpandedLesson] = useState(0);
  const [publishNow, setPublishNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const lessonTitles = lessons.map((lesson) => String(lesson.title).trim());
  const filledLessons = lessonTitles.filter(Boolean);
  const canNext = step === 0 ? Boolean(String(form.title).trim()) : step === 1 ? lessons.length > 0 && filledLessons.length === lessons.length : true;
  function updateLessonTitle(index, value) { setLessons((current) => current.map((item, i) => i === index ? { ...item, title: value } : item)); }
  // 课时配置编辑器内部用函数式更新，这里把它合并回该课时的草稿对象。
  function updateLessonDraft(index, updater) {
    setLessons((current) => current.map((item, i) => {
      if (i !== index) return item;
      const patch = typeof updater === 'function' ? updater(item) : updater;
      return { ...item, ...patch };
    }));
  }
  function addLesson() { setLessons((current) => { setExpandedLesson(current.length); return [...current, emptyLessonDraft()]; }); }
  function removeLesson(index) {
    setLessons((current) => current.length <= 1 ? [emptyLessonDraft()] : current.filter((_, i) => i !== index));
    setExpandedLesson(0);
  }

  async function submit() {
    setBusy(true); setMessage('');
    try {
      const priceText = String(form.priceYuan || '0').trim();
      if (!/^\d+(?:\.\d{1,2})?$/.test(priceText)) throw new Error('课包价格必须是有效的元金额，最多两位小数');
      if (form.coverImageUrl && !/^(https:\/\/|\/api\/)/.test(form.coverImageUrl)) throw new Error('封面地址必须是 HTTPS 链接或平台上传地址');
      const payload = {
        title: form.title, description: form.description, coverImageUrl: form.coverImageUrl || null, coverAssetId: form.coverAssetId || null,
        priceFen: Math.round(Number(priceText) * 100), version: form.version || '1.0',
        estimatedCreditsPerPerson: Number(form.estimatedCreditsPerPerson || 0), gradeRange: form.gradeRange, visibility: form.visibility,
        deliveryMode: form.deliveryMode || 'CANVAS',
        // 选择「立即发布」时课时一并置为已发布，否则保持草稿、等待后续再发布。
        lessons: lessons.map((lesson) => ({
          title: String(lesson.title).trim(), status: publishNow ? 'PUBLISHED' : 'DRAFT',
          capabilities: lesson.capabilities, materialGroups: lesson.materialGroups,
          teachingGroups: lesson.teachingGroups, classroomConfig: lesson.classroomConfig,
        })),
      };
      if (form.difficultyLevel !== '' && form.difficultyLevel != null) payload.difficultyLevel = Number(form.difficultyLevel);
      if (form.ageRangeMin !== '' && form.ageRangeMin != null) payload.ageRangeMin = Number(form.ageRangeMin);
      if (form.ageRangeMax !== '' && form.ageRangeMax != null) payload.ageRangeMax = Number(form.ageRangeMax);
      if (form.tags) payload.tags = String(form.tags).split(',').map((t) => t.trim()).filter(Boolean);
      const created = await api.post('admin/course-series', payload);
      let published = false; let publishError = '';
      if (publishNow && created?.id) {
        try { await api.request(`admin/course-series/${created.id}/status`, { method: 'POST', body: { action: 'publish' } }); published = true; }
        catch (error) { publishError = error.message; }
      }
      onCreated?.(created, { published, publishError });
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  return <div className="modal-overlay" onClick={onClose}>
    <div className="modal-content modal-large" onClick={(event) => event.stopPropagation()}>
      <div className="modal-header"><div><span className="eyebrow">课程资产</span><h2>新建平台课包</h2></div><button className="modal-close" onClick={onClose}>×</button></div>
      <div className="modal-body">
        {message && <Notice tone="danger">{message}</Notice>}
        <ol className="wizard-steps">{CREATE_STEPS.map((label, index) => <li key={label} className={index === step ? 'is-active' : index < step ? 'is-done' : ''}><span>{index + 1}</span>{label}</li>)}</ol>

        {step === 0 ? <>
          <label>课包标题 *<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="例如：AI绘本创作大师营" /></label>
          <label>课程简介<textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="一句话说明这门课教什么" /></label>
          <div className="form-grid">
            <label>可见范围<select value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value })}><option value="ALL_ORGS">所有机构</option><option value="ASSIGNED_ORGS">仅已授权机构</option><option value="PRIVATE">私有</option></select></label>
            <label>课堂类型<select value={form.deliveryMode} onChange={(event) => setForm({ ...form, deliveryMode: event.target.value })}><option value="CANVAS">画布课堂</option><option value="VIBECODING">VibeCoding 课堂（预留）</option></select></label>
            <label>版本号<input value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} placeholder="1.0" /></label>
          </div>
          <p className="muted">「所有机构」的已发布课包会自动出现在官网课程广场。</p>
        </> : null}

        {step === 1 ? <>
          <div className="lesson-config-heading"><strong>课时与课堂配置</strong><button type="button" className="text-button" onClick={addLesson}>＋添加课时</button></div>
          <p className="muted">每节课在这里一次性配好：标题、开放能力、画布素材、生成框体与教学素材。之后仍可在「课时编排」里调整。</p>
          {lessons.map((lesson, index) => <div className="course-lesson-draft" key={index}>
            <div className="lesson-config-row">
              <span className="course-lesson-draft__no">{index + 1}</span>
              <input value={lesson.title} placeholder={`第 ${index + 1} 课标题`} onChange={(event) => updateLessonTitle(index, event.target.value)} />
              <button type="button" className="secondary-button" onClick={() => setExpandedLesson(expandedLesson === index ? -1 : index)}>{expandedLesson === index ? '收起配置' : '配置本节课'}</button>
              <button type="button" className="text-button danger-text" onClick={() => removeLesson(index)}>删除</button>
            </div>
            {expandedLesson === index ? <div className="lesson-draft-config">
              <LessonCanvasConfigEditor api={api} lesson={lesson} edit={{}} onChange={(updater) => updateLessonDraft(index, updater)} />
            </div> : null}
          </div>)}
        </> : null}

        {step === 2 ? <div className="course-more-settings">
          <label>封面图<span className="muted">（可上传或填写 HTTPS 地址）</span></label>
          <div className="form-grid">
            <input value={form.coverImageUrl} placeholder="https://… 或上传后自动填充" onChange={(event) => setForm({ ...form, coverImageUrl: event.target.value })} />
            <label className="inline-file-upload">上传封面<input type="file" accept="image/*" onChange={async (event) => {
              const file = event.target.files?.[0]; event.target.value = '';
              if (!file) return;
              try {
                const asset = await api.upload('admin/file-assets/upload', file, { category: 'PROMO_COVER', visibility: 'PUBLIC_PLATFORM' });
                if (!asset?.id) throw new Error('上传成功但未返回文件标识');
                setForm((current) => ({ ...current, coverAssetId: asset.id, coverImageUrl: `/api/public/file-assets/${asset.id}/download` }));
              } catch (error) { setMessage(error.message); }
            }} /></label>
          </div>
          <div className="form-grid">
            <label>价格（元）<input inputMode="decimal" value={form.priceYuan} placeholder="如 199.00" onChange={(event) => setForm({ ...form, priceYuan: event.target.value })} /></label>
            <label>预估积分/人<input type="number" min="0" value={form.estimatedCreditsPerPerson} onChange={(event) => setForm({ ...form, estimatedCreditsPerPerson: event.target.value })} /></label>
            <label>适合年级<input value={form.gradeRange} placeholder="如 3-6 年级" onChange={(event) => setForm({ ...form, gradeRange: event.target.value })} /></label>
            <label>难度（1-5）<input type="number" min="1" max="5" value={form.difficultyLevel} placeholder="留空表示未设置" onChange={(event) => setForm({ ...form, difficultyLevel: event.target.value })} /></label>
            <label>适学年龄下限<input type="number" min="3" max="99" value={form.ageRangeMin} placeholder="如 8" onChange={(event) => setForm({ ...form, ageRangeMin: event.target.value })} /></label>
            <label>适学年龄上限<input type="number" min="3" max="99" value={form.ageRangeMax} placeholder="如 16" onChange={(event) => setForm({ ...form, ageRangeMax: event.target.value })} /></label>
            <label>标签（英文逗号分隔）<input value={form.tags} placeholder="古诗, 创作, 动画" onChange={(event) => setForm({ ...form, tags: event.target.value })} /></label>
          </div>
          <p className="muted">这一步可以跳过，创建后在课包详情里继续补充。</p>
        </div> : null}

        {step === 3 ? <div className="course-create-summary">
          <div className="publish-checklist">
            <div className="publish-check is-ok"><strong>✓</strong><span>课包标题：{form.title}</span></div>
            <div className="publish-check is-ok"><strong>✓</strong><span>课时：{filledLessons.length} 节（含能力 / 素材 / 框体配置）</span></div>
            <div className="publish-check is-ok"><strong>✓</strong><span>可见范围：{VISIBILITY_LABELS[form.visibility]}</span></div>
            <div className="publish-check is-ok"><strong>✓</strong><span>课堂类型：{form.deliveryMode === 'VIBECODING' ? 'VibeCoding 课堂' : '画布课堂'}</span></div>
          </div>
          <label className="checkbox-label top-gap"><input type="checkbox" checked={publishNow} onChange={(event) => setPublishNow(event.target.checked)} />创建后立即发布课包</label>
          <p className="muted">勾选后课时会一并标记为已发布，课包直接上线；不勾选则先存为草稿，配置好课时后再发布。VibeCoding 课时需要先开放「AI 文字」能力才能发布。</p>
        </div> : null}
      </div>
      <div className="modal-footer">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
        {step > 0 ? <button type="button" className="secondary-button" disabled={busy} onClick={() => setStep((value) => value - 1)}>上一步</button> : null}
        {step < CREATE_STEPS.length - 1
          ? <button type="button" className="primary-button" disabled={!canNext} onClick={() => setStep((value) => value + 1)}>下一步</button>
          : <button type="button" className="primary-button" disabled={busy} onClick={submit}>{busy ? '创建中…' : (publishNow ? '创建并发布' : '完成创建')}</button>}
      </div>
    </div>
  </div>;
}

/* ---------------------------------------------------------------- 课包列表 */

function CourseCard({ course, onOpen, onStatus, onDelete, busy }) {
  const cover = coverUrlOf(course);
  return <article className="course-card">
    <div className="course-card__cover" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>{!cover && <span>✦</span>}</div>
    <div className="course-card__body">
      <div className="course-card__head"><h3>{course.title}</h3><Status value={course.status} /></div>
      <p className="course-card__desc">{course.description || '暂无简介'}</p>
      <div className="course-card__meta">
        <span>课时 <strong>{course.lessonCount}</strong></span>
        <span>{VISIBILITY_LABELS[course.visibility] || course.visibility}</span>
        <span>v{course.version}</span>
        {course.difficultyLevel ? <span>难度 {course.difficultyLevel}/5</span> : null}
        {course.ageRangeMin || course.ageRangeMax ? <span>{course.ageRangeMin ?? '?'}-{course.ageRangeMax ?? '?'} 岁</span> : null}
      </div>
      {Array.isArray(course.tags) && course.tags.length ? <div className="tag-list">{course.tags.slice(0, 5).map((tag) => <span key={tag} className="tag">{tag}</span>)}</div> : null}
      <div className="course-card__foot">
        <span className="muted">{formatDate(course.updatedAt)}</span>
        <div className="row-actions">
          <button className="primary-button" onClick={onOpen}>进入编排</button>
          {course.status === 'PUBLISHED' ? <button className="secondary-button" disabled={busy} onClick={() => onStatus(course, 'archive')}>下架</button> : null}
          {course.status !== 'PUBLISHED' ? <button className="secondary-button" disabled={busy} onClick={() => onStatus(course, 'publish')}>发布</button> : null}
          <button className="text-button danger-text" disabled={busy} onClick={() => onDelete(course)}>删除</button>
        </div>
      </div>
    </div>
  </article>;
}

function CourseList({ api, onOpen }) {
  const [filters, setFilters] = useState({ search: '', status: '', visibility: '' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(12);
  const [sort, setSort] = useState('manual');
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const query = useMemo(() => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    params.set('page', String(page)); params.set('limit', String(limit)); params.set('sort', sort);
    return params.toString();
  }, [filters, page, limit, sort]);
  const courses = useData(() => api.get(`admin/course-series?${query}`), [api, query]);

  async function changeStatus(course, action) {
    const text = action === 'archive'
      ? `确认下架「${course.title}」？下架后机构端不再可见该课包，数据保留，可随时重新发布。`
      : `确认发布「${course.title}」？发布后按可见范围对机构生效，并出现在官网课程广场。`;
    if (!window.confirm(text)) return;
    setBusy(true); setMessage('');
    try {
      await api.request(`admin/course-series/${course.id}/status`, { method: 'POST', body: { action } });
      setMessage(action === 'archive' ? '课包已下架。' : '课包已发布。');
      courses.refresh();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  async function deleteCourse(course) {
    if (!window.confirm(`确认删除课包「${course.title}」？删除后课包与课时配置不可恢复；已被班级课单或课堂引用的课包会拒绝删除，请改用「下架」。`)) return;
    setBusy(true); setMessage('');
    try { await api.request(`admin/course-series/${course.id}`, { method: 'DELETE' }); setMessage(`课包「${course.title}」已删除。`); courses.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  return <>
    <PageHeader eyebrow="课程资产" title="平台课包" description="维护平台级课程资料、课时编排、发布状态与机构授权；内容变更自动递增版本号。"
      actions={<button className="primary-button" onClick={() => setShowCreate(true)}>＋ 新建课包</button>} />
    {message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}
    <Panel title="筛选">
      <div className="form-grid">
        <label>关键词<input value={filters.search} placeholder="课包名称 / ID" onChange={(event) => { setFilters({ ...filters, search: event.target.value }); setPage(1); }} /></label>
        <label>状态<select value={filters.status} onChange={(event) => { setFilters({ ...filters, status: event.target.value }); setPage(1); }}><option value="">全部状态</option><option value="DRAFT">草稿</option><option value="PUBLISHED">已发布</option><option value="ARCHIVED">已下架</option></select></label>
        <label>可见范围<select value={filters.visibility} onChange={(event) => { setFilters({ ...filters, visibility: event.target.value }); setPage(1); }}><option value="">全部范围</option><option value="ALL_ORGS">所有机构</option><option value="ASSIGNED_ORGS">仅已授权机构</option><option value="PRIVATE">私有</option></select></label>
        <label>排序<select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="manual">手动顺序</option><option value="created">创建时间</option><option value="updated">更新时间</option><option value="title">课包名称</option></select></label>
        <label>每页<select value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setPage(1); }}><option value="12">12 个</option><option value="24">24 个</option><option value="48">48 个</option></select></label>
      </div>
    </Panel>
    {courses.loading ? <Loading /> : courses.error ? <ErrorState error={courses.error} onRetry={courses.refresh} /> : courses.data?.items?.length ? <>
      <ListResultSummary total={courses.data.total} page={courses.data.page} totalPages={courses.data.totalPages} label="个课包" />
      <div className="course-grid">{courses.data.items.map((course) => <CourseCard key={course.id} course={course} busy={busy} onStatus={changeStatus} onDelete={deleteCourse} onOpen={() => onOpen(course)} />)}</div>
      <Pagination page={courses.data.page} totalPages={courses.data.totalPages} onChange={setPage} disabled={courses.loading} />
    </> : <Empty title="没有符合条件的课包" body="可以调整关键词、状态或可见范围，或新建一个课包。" />}
    {showCreate && <CreateCourseModal api={api} onClose={() => setShowCreate(false)} onCreated={(course, extra) => { setShowCreate(false); courses.refresh(); if (extra?.publishError) window.alert(`课包已创建，但立即发布失败：${extra.publishError}\n可在课包详情里补充配置后再发布。`); if (course?.id) onOpen(course); }} />}
  </>;
}

/* ---------------------------------------------------------------- 课包详情 */

function CourseDetail({ api, course, onBack }) {
  const [activeTab, setActiveTab] = useState('basic');
  const [message, setMessage] = useState('');
  const [saveState, setSaveState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [assignOrgId, setAssignOrgId] = useState('');
  const [assignValidityDays, setAssignValidityDays] = useState('365');
  const [lessonDraft, setLessonDraft] = useState({ title: '', durationMinutes: 45 });
  const [editingLesson, setEditingLesson] = useState(null);
  const [uploadingCover, setUploadingCover] = useState(false);
  const detail = useData(() => api.get(`admin/course-series/${course.id}/detail`), [api, course.id]);
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  const series = detail.data?.series || null;

  useEffect(() => {
    if (!series) return;
    setEditForm({
      title: series.title, description: series.description || '', coverImageUrl: series.coverImageUrl || '', coverAssetId: series.coverAssetId || '',
      priceYuan: ((Number(series.priceFen || 0) / 100).toFixed(2)).replace(/\.00$/, ''), version: series.version || '1.0',
      estimatedCreditsPerPerson: series.estimatedCreditsPerPerson || '', gradeRange: series.gradeRange || '',
      visibility: series.visibility, sort: series.sort, difficultyLevel: series.difficultyLevel ?? '', ageRangeMin: series.ageRangeMin ?? '',
      ageRangeMax: series.ageRangeMax ?? '', tags: (series.tags || []).join(','), deliveryMode: series.deliveryMode || 'CANVAS',
    });
  }, [series?.id]);

  async function run(path, method, body, successMessage, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setMessage('');
    try { await api.request(path, { method, body }); setMessage(successMessage); detail.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  async function saveEdit(event) {
    event.preventDefault(); if (!editForm) return;
    setSaveState(null); setBusy(true); setMessage('');
    try {
      const priceText = String(editForm.priceYuan || '0').trim();
      if (!/^\d+(?:\.\d{1,2})?$/.test(priceText)) throw new Error('课包价格必须是有效的元金额，最多两位小数');
      const body = {
        title: editForm.title, description: editForm.description, coverImageUrl: editForm.coverImageUrl || null, coverAssetId: editForm.coverAssetId || null,
        priceFen: Math.round(Number(priceText) * 100),
        estimatedCreditsPerPerson: Number(editForm.estimatedCreditsPerPerson || 0), gradeRange: editForm.gradeRange || '',
        visibility: editForm.visibility, sort: Number(editForm.sort), deliveryMode: editForm.deliveryMode || 'CANVAS',
      };
      if (body.coverImageUrl && !/^(https:\/\/|\/api\/)/.test(body.coverImageUrl)) throw new Error('封面地址必须是 HTTPS 链接或平台上传地址');
      body.difficultyLevel = editForm.difficultyLevel !== '' && editForm.difficultyLevel != null ? Number(editForm.difficultyLevel) : null;
      body.ageRangeMin = editForm.ageRangeMin !== '' && editForm.ageRangeMin != null ? Number(editForm.ageRangeMin) : null;
      body.ageRangeMax = editForm.ageRangeMax !== '' && editForm.ageRangeMax != null ? Number(editForm.ageRangeMax) : null;
      body.tags = String(editForm.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      await api.request(`admin/course-series/${course.id}`, { method: 'PUT', body });
      setMessage('课包资料已保存，版本号已递增。');
      setSaveState({ tone: 'success', text: '已保存，版本号已递增。' });
      detail.refresh();
    } catch (error) { setMessage(error.message); setSaveState({ tone: 'danger', text: error.message }); }
    finally { setBusy(false); }
  }

  async function changeStatus(action) {
    const text = action === 'archive'
      ? `确认下架「${series.title}」？下架后机构端不再可见该课包，数据保留，可随时重新发布。`
      : `确认发布「${series.title}」？发布后按可见范围对机构生效，并出现在官网课程广场。`;
    await run(`admin/course-series/${course.id}/status`, 'POST', { action }, action === 'archive' ? '课包已下架。' : '课包已发布。', text);
  }

  async function deleteCourse() {
    if (!window.confirm(`确认删除课包「${series.title}」？删除后课包与课时配置不可恢复；已被班级课单或课堂引用的课包会拒绝删除，请改用「下架」。`)) return;
    setBusy(true); setMessage('');
    try { await api.request(`admin/course-series/${course.id}`, { method: 'DELETE' }); onBack(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  async function addLesson(event) {
    event.preventDefault();
    if (!lessonDraft.title.trim()) return;
    await run(`admin/course-series/${course.id}/lessons`, 'POST', { lessons: [{ title: lessonDraft.title.trim(), durationMinutes: Number(lessonDraft.durationMinutes || 45), deliveryMode: series?.deliveryMode || 'CANVAS', status: 'DRAFT' }] }, `已添加课时「${lessonDraft.title.trim()}」。`);
    setLessonDraft({ title: '', durationMinutes: 45 });
  }

  async function deleteLesson(lesson) {
    await run(`admin/course-lessons/${lesson.id}`, 'DELETE', undefined, `课时「${lesson.title}」已删除，剩余课时已重新排序。`, `确认删除课时「${lesson.title}」？已被班级课单或课堂引用的课时无法删除。`);
  }

  async function moveLesson(lesson, direction) {
    if (!series) return;
    const ids = series.lessons.map((item) => item.id);
    const index = ids.indexOf(lesson.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await run(`admin/course-series/${course.id}/lessons/reorder`, 'PUT', { lessonIds: ids }, '课时顺序已更新。');
  }

  async function assign() {
    if (!assignOrgId) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.post(`admin/course-series/${course.id}/assignments`, { orgIds: [assignOrgId], validityDays: Number(assignValidityDays || 365) });
      setMessage(`课包授权成功，有效期至 ${formatDate(result?.expiresAt) || '—'}。`);
      setAssignOrgId(''); detail.refresh();
    }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  async function uploadEditCover(file) {
    if (!file) return;
    setUploadingCover(true);
    try {
      const asset = await api.upload('admin/file-assets/upload', file, { category: 'PROMO_COVER', visibility: 'PUBLIC_PLATFORM' });
      if (!asset?.id) throw new Error('上传成功但未返回文件标识');
      setEditForm((current) => ({ ...current, coverAssetId: asset.id, coverImageUrl: `/api/public/file-assets/${asset.id}/download` }));
      setMessage('封面上传成功。');
    } catch (error) { setMessage(error.message); } finally { setUploadingCover(false); }
  }

  const publishedLessons = (series?.lessons || []).filter((lesson) => lesson.status === 'PUBLISHED').length;
  const vibecodingLessons = (series?.lessons || []).filter((lesson) => lesson.deliveryMode === 'VIBECODING').length;
  const vibecodingWithoutText = (series?.lessons || []).filter((lesson) => lesson.deliveryMode === 'VIBECODING' && !(lesson.capabilities || []).includes('text')).length;

  return <>
    <PageHeader eyebrow="课程资产 · 课包编排" title={series ? series.title : course.title}
      description={series ? `状态 ${series.status} · 版本 v${series.version} · 共 ${series.lessons.length} 个课时` : '正在读取课包详情…'}
      actions={<><button className="secondary-button" onClick={onBack}>← 返回课包列表</button>{series ? <button className="secondary-button" disabled={busy} onClick={() => changeStatus('archive')}>下架</button> : null}{series ? <button className="text-button danger-text" disabled={busy} onClick={deleteCourse}>删除</button> : null}{series && series.status !== 'PUBLISHED' ? <button className="primary-button" disabled={busy} onClick={() => changeStatus('publish')}>发布课包</button> : null}</>} />
    {message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}
    {detail.loading ? <Loading label="正在读取课包详情…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : !series ? <Empty title="课包不存在" /> : <>
      <div className="metrics">
        <MetricCard label="引用班级" value={detail.data.usage.classesUsingSeries} hint="以该课包为默认课程的班级数" />
        <MetricCard label="班级课单项" value={detail.data.usage.curriculumItems} hint="班级课单引用的课时条目数" tone="teal" />
        <MetricCard label="关联课堂" value={detail.data.usage.classSessions} hint="使用该课包课时的课堂场次" tone="orange" />
        <MetricCard label="学生作品" value={detail.data.usage.studentWorks} hint="基于该课包课时提交的作品数" tone="pink" />
      </div>
      <nav className="tabs" role="tablist">
        {[['basic', '基本信息'], ['lessons', `课时编排（${series.lessons.length}）`], ['assign', `机构授权（${detail.data.assignedOrgs.length}）`], ['publish', '发布检查']].map(([key, label]) =>
          <button key={key} type="button" role="tab" aria-selected={activeTab === key} className={`tab ${activeTab === key ? 'is-active' : ''}`} onClick={() => setActiveTab(key)}>{label}</button>)}
      </nav>

      {activeTab === 'basic' ? <Panel title="课包资料">
        {editForm ? <form onSubmit={saveEdit}>
          <h3 className="form-section-title">展示信息</h3>
          <label>课包标题<input value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} required /></label>
          <label>课程简介<textarea rows={3} value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} /></label>
          <label>封面图<span className="muted">（可上传或填写 HTTPS 地址）</span></label>
          <div className="form-grid">
            <input value={editForm.coverImageUrl} placeholder="https://… 或上传后自动填充" onChange={(event) => setEditForm({ ...editForm, coverImageUrl: event.target.value })} />
            <label className="inline-file-upload">{uploadingCover ? '上传中…' : '上传封面'}<input type="file" accept="image/*" disabled={uploadingCover} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadEditCover(file); }} /></label>
          </div>
          <h3 className="form-section-title">计费与属性</h3>
          <div className="form-grid">
            <label>价格（元）<input inputMode="decimal" value={editForm.priceYuan} onChange={(event) => setEditForm({ ...editForm, priceYuan: event.target.value })} /></label>
            <label>版本号<input value={editForm.version} disabled title="编辑资料时版本号由系统自动递增" /></label>
            <label>预估积分/人<input type="number" min="0" value={editForm.estimatedCreditsPerPerson} onChange={(event) => setEditForm({ ...editForm, estimatedCreditsPerPerson: event.target.value })} /></label>
            <label>适合年级<input value={editForm.gradeRange} placeholder="如 3-6 年级" onChange={(event) => setEditForm({ ...editForm, gradeRange: event.target.value })} /></label>
            <label>难度（1-5）<input type="number" min="1" max="5" value={editForm.difficultyLevel} placeholder="留空表示未设置" onChange={(event) => setEditForm({ ...editForm, difficultyLevel: event.target.value })} /></label>
            <label>适学年龄下限<input type="number" min="3" max="99" value={editForm.ageRangeMin} placeholder="如 8" onChange={(event) => setEditForm({ ...editForm, ageRangeMin: event.target.value })} /></label>
            <label>适学年龄上限<input type="number" min="3" max="99" value={editForm.ageRangeMax} placeholder="如 16" onChange={(event) => setEditForm({ ...editForm, ageRangeMax: event.target.value })} /></label>
          </div>
          <label>标签（英文逗号分隔）<input value={editForm.tags} placeholder="古诗, 创作, 动画" onChange={(event) => setEditForm({ ...editForm, tags: event.target.value })} /></label>
          <h3 className="form-section-title">可见范围与排序</h3>
          <div className="form-grid">
            <label>可见范围<select value={editForm.visibility} onChange={(event) => setEditForm({ ...editForm, visibility: event.target.value })}><option value="ALL_ORGS">所有机构</option><option value="ASSIGNED_ORGS">仅已授权机构</option><option value="PRIVATE">私有</option></select></label>
            <label>默认课堂类型<select value={editForm.deliveryMode} onChange={(event) => setEditForm({ ...editForm, deliveryMode: event.target.value })}><option value="CANVAS">画布课堂</option><option value="VIBECODING">VibeCoding 课堂（预留）</option></select></label>
            <label>排序<input type="number" min="0" value={editForm.sort} onChange={(event) => setEditForm({ ...editForm, sort: event.target.value })} /></label>
          </div>
          <button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存课包资料'}</button>
          {saveState ? <Notice tone={saveState.tone}>{saveState.text}</Notice> : null}
          <p className="muted">当前版本 {series.version}；保存后版本号自动递增。状态变更请使用右上角发布 / 下架。平台课包本身不设有效期，有效期在「机构授权」里按机构单独设置。</p>
        </form> : null}
      </Panel> : null}

      {activeTab === 'lessons' ? <>
        <Panel title="添加课时">
          <form onSubmit={addLesson} className="form-grid">
            <label>课时标题<input value={lessonDraft.title} onChange={(event) => setLessonDraft({ ...lessonDraft, title: event.target.value })} placeholder="例如：第 1 课 认识 AI 魔法师" required /></label>
            <label>时长（分钟）<input type="number" min="1" max="1440" value={lessonDraft.durationMinutes} onChange={(event) => setLessonDraft({ ...lessonDraft, durationMinutes: event.target.value })} /></label>
            <div><button className="primary-button" disabled={busy}>添加课时</button></div>
          </form>
          <p className="muted">添加后点击课时行，在右侧抽屉里配置课堂类型、能力、素材、生成框体与默认画布。</p>
        </Panel>
        <Panel title={`课时列表（${series.lessons.length}）`}>
          {series.lessons.length ? <div className="table-wrap"><table><thead><tr><th>#</th><th>标题</th><th>时长</th><th>课堂类型</th><th>状态</th><th>开放能力</th><th>素材/框体</th><th>操作</th></tr></thead><tbody>
            {series.lessons.map((lesson) => <tr key={lesson.id} className="lesson-row" onClick={() => setEditingLesson(lesson)}>
              <td>{lesson.sort}</td>
              <td><strong>{lesson.title}</strong>{lesson.summary ? <div className="muted">{lesson.summary}</div> : null}</td>
              <td>{lesson.durationMinutes} 分钟</td>
              <td>{lesson.deliveryMode === 'VIBECODING' ? <span className="status warning">VibeCoding</span> : '课堂画布'}</td>
              <td><Status value={lesson.status} /></td>
              <td><span className="tag-list">{(lesson.capabilities || []).map((cap) => <span key={cap} className="tag">{cap}</span>)}</span></td>
              <td className="muted">{(lesson.materialGroups || []).length} 组 · 图 {lesson.generationSlots?.image?.count || 0} / 视频 {lesson.generationSlots?.video?.count || 0}</td>
              <td><div className="row-actions" onClick={(event) => event.stopPropagation()}>
                <button className="text-button" disabled={busy} onClick={() => moveLesson(lesson, -1)}>上移</button>
                <button className="text-button" disabled={busy} onClick={() => moveLesson(lesson, 1)}>下移</button>
                <button className="secondary-button" onClick={() => setEditingLesson(lesson)}>配置</button>
                <button className="text-button danger-text" disabled={busy} onClick={() => deleteLesson(lesson)}>删除</button>
              </div></td>
            </tr>)}
          </tbody></table></div> : <Empty title="暂无课时" body="课包至少需要一个课时才能发布。" />}
        </Panel>
      </> : null}

      {activeTab === 'assign' ? <Panel title={`机构授权（${detail.data.assignedOrgs.length}）`}>
        <p className="muted">平台课包本身不设有效期：有效期在这里按机构单独设置，到期后该机构不再看到此课包，续期时重新授权即可。</p>
        <div className="form-grid">
          <label>授权给机构<select value={assignOrgId} onChange={(event) => setAssignOrgId(event.target.value)}><option value="">选择机构</option>{organizations.data?.items?.map((org) => <option key={org.id} value={org.id}>{org.name}</option>) || null}</select></label>
          <label>有效期（天）<input type="number" min="1" max="3650" value={assignValidityDays} onChange={(event) => setAssignValidityDays(event.target.value)} /></label>
          <div><button type="button" className="secondary-button" disabled={!assignOrgId || busy} onClick={assign}>授权</button></div>
        </div>
        {detail.data.assignedOrgs.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>授权时间</th><th>有效期至</th><th>操作</th></tr></thead><tbody>{detail.data.assignedOrgs.map((item) => <tr key={item.id}><td>{item.orgName}</td><td>{formatDate(item.assignedAt)}</td><td>{item.expiresAt ? <span className={item.expired ? 'status warning' : ''}>{formatDate(item.expiresAt)}{item.expired ? '（已过期）' : ''}</span> : '永久有效'}</td><td><button className="text-button danger-text" disabled={busy} onClick={() => run(`admin/course-series/${course.id}/assignments/revoke`, 'POST', { orgId: item.orgId }, `已撤销 ${item.orgName} 的授权，该机构将立即看不到此课包。`, `确认撤销「${item.orgName}」对此课包的授权？`)}>撤销授权</button></td></tr>)}</tbody></table></div> : <Empty title="暂无机构授权" body="「仅已授权机构」课包需完成授权后机构端才可见。" />}
      </Panel> : null}

      {activeTab === 'publish' ? <Panel title="发布检查">
        <div className="publish-checklist">
          <div className={`publish-check ${series.lessons.length ? 'is-ok' : 'is-warn'}`}><strong>{series.lessons.length ? '✓' : '!'}</strong><span>课时数量：共 {series.lessons.length} 个</span></div>
          <div className={`publish-check ${series.lessons.length && publishedLessons === series.lessons.length ? 'is-ok' : 'is-warn'}`}><strong>{series.lessons.length && publishedLessons === series.lessons.length ? '✓' : '!'}</strong><span>已发布课时：{publishedLessons} / {series.lessons.length}（未发布的课时无法随课包上线）</span></div>
          <div className={`publish-check ${vibecodingWithoutText ? 'is-warn' : 'is-ok'}`}><strong>{vibecodingWithoutText ? '!' : '✓'}</strong><span>VibeCoding 课时：{vibecodingLessons} 个{vibecodingWithoutText ? `（其中 ${vibecodingWithoutText} 个未开放 AI 文字能力，无法发布）` : '（均已开放 AI 文字能力）'}</span></div>
          <div className={`publish-check ${series.visibility === 'ASSIGNED_ORGS' && !detail.data.assignedOrgs.length ? 'is-warn' : 'is-ok'}`}><strong>{series.visibility === 'ASSIGNED_ORGS' && !detail.data.assignedOrgs.length ? '!' : '✓'}</strong><span>可见范围：{VISIBILITY_LABELS[series.visibility]}（{series.visibility === 'ASSIGNED_ORGS' ? `已授权 ${detail.data.assignedOrgs.length} 个机构` : '无需额外授权'}）</span></div>
        </div>
        <div className="row-actions top-gap">
          {series.status !== 'PUBLISHED' ? <button className="primary-button" disabled={busy} onClick={() => changeStatus('publish')}>发布课包</button> : <span className="status success">课包已发布</span>}
          {series.status !== 'ARCHIVED' ? <button className="secondary-button" disabled={busy} onClick={() => changeStatus('archive')}>下架课包</button> : null}
        </div>
        <p className="muted">发布前请确认课时均已发布、VibeCoding 课时已开放 AI 文字能力；「仅已授权机构」课包需完成授权。发布后按可见范围对机构生效。</p>
      </Panel> : null}

      {editingLesson ? <LessonDrawer api={api} lesson={editingLesson} onClose={() => setEditingLesson(null)} onSaved={(text) => { setMessage(text); detail.refresh(); }} /> : null}
    </>}
  </>;
}

/* ---------------------------------------------------------------- 顶层容器 */

export function Courses({ api }) {
  const [selected, setSelected] = useState(null);
  if (selected) return <CourseDetail api={api} course={selected} onBack={() => setSelected(null)} />;
  return <CourseList api={api} onOpen={setSelected} />;
}
