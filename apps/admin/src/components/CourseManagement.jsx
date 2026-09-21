import { CreateCourseModal, MaterialPreview } from './CourseForms.jsx';
// 平台课包管理：列表视图 + 课包详情（标签页）+ 课时编辑抽屉
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Empty, ErrorState, Icon, ListResultSummary, Loading, MetricCard, Notice, PageHeader, Panel,
  Pagination, Status, formatDate, materialVisual, useData,
} from '@platform/shared';

// 可见范围（2026-09-16 用户口径：三值改两值）：**公开** = 官网课程广场 + 授权机构都可以；
// **私有** = 不对外。机构实际能不能用，仍只看「机构授权」那一栏（发布 ≠ 授权）。
const VISIBILITY_LABELS = { PUBLIC: '公开', PRIVATE: '私有' };
const VISIBILITY_OPTIONS = [
  ['PUBLIC', '公开（课程广场 + 授权机构都能用）'],
  ['PRIVATE', '私有（不对外，只能由平台自己安排）'],
];
// 授权有效期的常用档位：平台口径是按年授权（1 年 / 2 年），也允许自定义天数。
// 授权有效期不再由平台选（2026-09-16 口径）：它跟随机构的合同到期日，见 organizations 的同步。
const LESSON_CAPABILITY_OPTIONS = [
  ['text', 'AI 文字'], ['image', 'AI 生图'], ['video', 'AI 生视频'], ['music', 'AI 音乐'],
];
// 素材类型（2026-09-16 用户口径：删掉「文字说明」这个选项，文字类只留「提示词」）。
// ⚠️ 服务端与老数据里仍然会出现 NOTE（schema 默认值就是它），所以 NOTE **不能从白名单里删**——
// 只是不再作为可选项出现；历史课时打开时，下拉里会临时补一条「文字说明（旧数据）」让它显示正确。
const MATERIAL_TYPE_OPTIONS = [
  ['IMAGE', '图片'], ['VIDEO', '视频'], ['AUDIO', '音频'], ['PROMPT', '提示词'], ['GENERATION_BOX', '生成框体'],
];
const LEGACY_MATERIAL_TYPE_LABELS = { NOTE: '文字说明（旧数据）' };
// 生成框体支持的模态；每个框体单独选模型与参数。
const GENERATION_BOX_MODALITY_OPTIONS = [['TEXT', 'AI 文字'], ['IMAGE', 'AI 生图'], ['VIDEO', 'AI 生视频'], ['MUSIC', 'AI 音乐']];
// 生成框体的「生成方式」（用户 2026-09-21 口径：这几个是**完全不一样的概念**，不能靠连线多少去推）。
// 值就是服务端/上游那套枚举（VIDEO 的 inputModes、IMAGE 的 IMAGE_INPUT_MODES），标签只在这里给一次。
// 生成框体的「生成方式」（用户 2026-09-21 口径：这几个是**完全不一样的概念**，不能靠连线多少去推）。
// ⚠️ 用户当晚又定了一次：**视频只留「文生视频 / 全能参考」两种、图片只留「文生图 / 图生图」** ——
//    图生视频（首帧）/ 首尾帧不再放进选项里（模型能力里仍可能有，老课包若配过照旧生效）。
/** 下拉选项：本模态提供的那几种 + 这个框体已经存着的历史值（老课包可能配过首尾帧这类不再列出的方式）。
 *  历史值必须显示出来：不然老师打开只看到一片空白，不知道原来配的是什么、也没法改。 */
function generationModeSelectOptions(caps, modality, current) {
  const list = generationModeOptions(caps, modality);
  const value = String(current || '').toUpperCase();
  if (value && !list.some(([item]) => item === value)) list.push([value, `${GENERATION_MODE_LEGACY_LABELS[value] || value}（历史配置）`]);
  return list;
}
const GENERATION_MODE_LEGACY_LABELS = {
  FIRST_FRAME: '图生视频（首帧图）',
  FIRST_LAST_FRAME: '首尾帧（首帧 + 尾帧）',
};
const VIDEO_MODE_LABELS = {
  TEXT: '文生视频（纯文本）',
  OMNI_REFERENCE: '全能参考（多图 / 多视频 / 多音频）',
};
const IMAGE_MODE_LABELS = { TEXT: '文生图（不给参考）', IMAGE_REFERENCE: '图生图（参考素材）' };
function generationModeOptions(caps, modality) {
  const labels = String(modality).toUpperCase() === 'IMAGE' ? IMAGE_MODE_LABELS : VIDEO_MODE_LABELS;
  const supported = Array.isArray(caps?.inputModes) && caps.inputModes.length ? caps.inputModes : Object.keys(labels);
  // 只列我们提供的那几种，且这个模型得真支持（例如只会文生的模型就只出「文生视频」）
  return Object.keys(labels).filter((value) => supported.includes(value)).map((value) => [value, labels[value]]);
}
const MUSIC_MODE_OPTIONS = [['LYRICS', '歌词生音乐'], ['DESCRIPTION', '描述生音乐（平台代写词）']];
const TEACHING_TYPE_OPTIONS = [
  ['VIDEO', '视频'], ['PPT', 'PPT'], ['PDF', 'PDF'], ['WORD', 'Word'], ['EXCEL', 'Excel'], ['FILE', '其他文件'],
];
// 生成比例/清晰度/时长的可选项来自「计费与模型」里每个模型的能力配置，这里只负责兜底展示历史值。
function valueOptionsFor(options, current) {
  const list = Array.isArray(options) ? options : [];
  if (current !== undefined && current !== null && current !== '' && !list.includes(current)) return [current, ...list];
  return list;
}
// 平台留空＝不指定，学生在画布课堂里自己选；填了＝学生在课堂里只能看、不能改。
const STUDENT_CHOICE = '';
function paramLabel(value, suffix = '') { return value === '' || value === undefined || value === null ? '学生自选' : `${value}${suffix}`; }
// 素材编辑器里的一个字段：**带标签**，并且把「提示」放在控件下面。
// 为什么要它：原来一排裸 input/select 挤在一起（用户反馈「素材1和素材2只有一点点缝隙」），
// 每个控件没有标签、看不出哪个是哪个。这个组件把「标签 + 控件 + 提示」固定成一个块，
// 版面靠 CSS 的间距与卡片分隔来区分。
function LessonField({ label, hint, children }) {
  return <label className="lesson-field">
    <span className="lesson-field__label">{label}</span>
    {children}
    {hint ? <small className="muted">{hint}</small> : null}
  </label>;
}

let uidSeed = 0;
function nextUid() { uidSeed += 1; return `tmp-${Date.now().toString(36)}-${uidSeed}`; }
const defaultClassroomConfig = { version: 3 };
const emptyCourseForm = {
  title: '', description: '', coverImageUrl: '', coverAssetId: '', priceYuan: '', version: '1.0',
  estimatedCreditsPerPerson: '', gradeRange: '', visibility: 'PUBLIC', deliveryMode: 'CANVAS',
  difficultyLevel: '', ageRangeMin: '', ageRangeMax: '', tags: '', stockTotal: '', perStudentBudgetYuan: '',
};

// 生成框体是素材表里的一种素材（material_type=GENERATION_BOX），顺序跟着素材走；
// classroom_config 只剩版本号与 VibeCoding 配置。
function classroomConfigFor(lesson, edit) {
  const value = edit.classroomConfig ?? lesson.classroomConfig ?? {};
  return { ...defaultClassroomConfig, ...value };
}

function coverUrlOf(course) {
  if (course.coverAssetId) return `/api/public/file-assets/${course.coverAssetId}/download`;
  return course.coverImageUrl || '';
}

/* ---------------------------------------------------------------- 课包：算力预估（分/人） */

// 算力预估是**平台内部口径**（2026-09-18 用户口径：只在平台端展示与对账，官网/机构端/学生端都不下发）。
// 单位是**分/人**，与成本账（compute_attempts.upstream_cost_fen）同一口径，不再是「积分」。
// 读数来自课包详情接口的 computeEstimate（见 services/courseEstimate.js）：预估 × 实际 × 价目表折算。
function formatFen(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  // 文本单笔成本天然小于 1 分（上游按 token 计价），所以保留两位小数而不是硬取整。
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** 输入框旁的一句参考值：**只做价目表折算，不做用量预测**，公式与假设都在服务端给的 note 里。 */
function estimateReferenceHint(estimate) {
  const reference = estimate?.reference;
  if (!reference) return '正在读取当前价目表…';
  if (reference.perPersonFen === null || reference.perPersonFen === undefined) return `按当前价目表折算不出参考值：${reference.note}`;
  return `按当前价目表折算约 ${formatFen(reference.perPersonFen)} 分/人 —— ${reference.note}`;
}

/** 预估 vs 实际的结论文案 + 徽标语气。未知成本只计笔数，所以「已知」永远是下界。 */
function estimateVerdict(estimate) {
  if (!estimate) return { tone: 'muted', label: '暂无读数', detail: '' };
  if (!estimate.estimateConfigured) return { tone: 'muted', label: '未填预估', detail: '这个课包还没填「算力预估（分/人）」，填上之后这里才会出现对比。' };
  if (!estimate.studentCount) return { tone: 'muted', label: '还没有学生上课', detail: '这个课包还没有学生上过课（也没有人用过算力），暂时没法算人均实际。' };
  if (estimate.overEstimate) {
    return {
      tone: 'danger',
      label: '超出预估',
      detail: `人均实际已经比预估高 ${formatFen(estimate.overEstimateFen)} 分${estimate.costComplete ? '' : '（且还有成本未知的调用，实际只会更高）'} —— 要么预估填低了，要么课时里的生成用量比自己以为的大。`,
    };
  }
  if (!estimate.costComplete) {
    return { tone: 'warning', label: '成本未算全', detail: `还有 ${estimate.unknownCostCalls} 笔调用的成本未知（只计笔数、不按 0 计入金额），所以「实际」目前只是下界，不能断言没超。` };
  }
  return { tone: 'success', label: '在预估内', detail: '这个课包全部的调用成本都已折算出金额，人均实际没有超过预估。' };
}

/* ---------------------------------------------------------------- 课时画布配置 */

// 教学素材（教师备课资料，学生不可见）
function LessonTeachingEditor({ api, lesson, edit, onChange }) {
  const groups = edit.teachingGroups ?? lesson.teachingGroups ?? [];
  const [uploading, setUploading] = useState('');
  const [uploadMessage, setUploadMessage] = useState('');
  // 一律用函数式更新：上传回调完成时要基于最新 state 合并，否则会把上传期间新增的素材覆盖掉。
  const updateGroups = (mapper) => onChange((current) => ({ ...current, teachingGroups: mapper(current.teachingGroups ?? lesson.teachingGroups ?? []) }));
  const updateGroup = (index, patch) => updateGroups((list) => list.map((group, i) => i === index ? { ...group, ...patch } : group));
  function updateAsset(groupIndex, assetIndex, uid, patch) {
    updateGroups((list) => list.map((group, i) => {
      if (i !== groupIndex) return group;
      const assets = group.assets || [];
      const matched = uid ? assets.findIndex((item) => item.uid === uid) : -1;
      const index = matched >= 0 ? matched : assetIndex;
      if (uid && matched < 0) return group;
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
    onChange((current) => ({ ...current, uploadCount: (current.uploadCount || 0) + 1 }));
    try {
      const asset = await api.upload('admin/file-assets/upload', file, { category: 'TEACHING_ASSET', visibility: 'PUBLIC_PLATFORM' });
      if (!asset?.id) throw new Error('上传成功但未返回文件标识');
      // 教学素材走机构端受控下载路由，下载时会校验课包对当前机构的授权。
      updateAsset(groupIndex, assetIndex, uid, { assetUrl: `/api/org/file-assets/${asset.id}/download`, fileAssetId: asset.id });
      setUploadMessage(`「${file.name}」上传成功，请保存课时。`);
    } catch (error) { setUploadMessage(`上传失败：${error.message}`); } finally { setUploading(''); onChange((current) => ({ ...current, uploadCount: Math.max(0, (current.uploadCount || 0) - 1) })); }
  }
  return <div className="lesson-teaching-materials">
    {uploadMessage ? <Notice>{uploadMessage}</Notice> : null}
    <div className="lesson-config-heading"><strong>教学素材（教师备课资料，学生不可见）</strong><button type="button" className="text-button" onClick={() => updateGroups((list) => [...list, { uid: nextUid(), title: `教学素材${list.length + 1}`, assets: [] }])}>＋素材组</button></div>
    {groups.map((group, groupIndex) => <div className="lesson-material-group-editor" key={group.id || group.uid || `new-${groupIndex}`}>
      <div className="lesson-config-row"><input value={group.title || ''} placeholder={`教学素材${groupIndex + 1}`} onChange={(event) => updateGroup(groupIndex, { title: event.target.value })} /><button type="button" className="text-button danger-text" onClick={() => updateGroups((list) => list.filter((_, i) => i !== groupIndex))}>删除组</button></div>
      {(group.assets || []).map((asset, assetIndex) => <div className="lesson-material-item-editor" key={asset.id || asset.uid || `new-${assetIndex}`}>
        <div className="lesson-config-row"><input value={asset.title || ''} placeholder="素材名称" onChange={(event) => updateAsset(groupIndex, assetIndex, asset.uid, { title: event.target.value })} /><select value={asset.assetType || 'FILE'} onChange={(event) => updateAsset(groupIndex, assetIndex, asset.uid, { assetType: event.target.value })}>{TEACHING_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button type="button" className="text-button danger-text" onClick={() => removeAsset(groupIndex, assetIndex)}>删除</button></div>
        <input value={asset.description || ''} placeholder="给老师看的说明（可选）" onChange={(event) => updateAsset(groupIndex, assetIndex, asset.uid, { description: event.target.value })} />
        <MaterialPreview url={asset.assetUrl} type={asset.assetType} />
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
  // 上课类型改成可多选（画布 + VibeCoding，学生端两个入口并列）。老数据只有单值 → 读成单元素数组。
  const deliveryModes = edit.deliveryModes ?? lesson.deliveryModes ?? [deliveryMode];
  const capabilities = edit.capabilities ?? lesson.capabilities ?? ['text'];
  const offersCanvas = deliveryModes.includes('CANVAS');
  const offersVibe = deliveryModes.includes('VIBECODING');
  /** 勾/取消一种上课类型。两条规则：至少保留一种（否则这节课学生进不去）；勾了 VibeCoding 就把
   *  「AI 文字」一起勾上 —— 发布校验要求 VibeCoding 课时必须开放 text，不自动勾上会被拦下来。 */
  function toggleDeliveryMode(value) {
    const next = deliveryModes.includes(value) ? deliveryModes.filter((item) => item !== value) : [...deliveryModes, value];
    if (!next.length) return;
    onChange((current) => {
      const patch = { deliveryModes: next };
      if (next.includes('VIBECODING')) {
        const caps = current.capabilities ?? capabilities;
        if (!caps.includes('text')) patch.capabilities = [...caps, 'text'];
      }
      return { ...current, ...patch };
    });
  }
  const groups = edit.materialGroups ?? lesson.materialGroups ?? [];
  const classroomConfig = classroomConfigFor(lesson, edit);
  const [uploading, setUploading] = useState('');
  const [uploadMessage, setUploadMessage] = useState('');
  // 全部改成函数式更新：连续编辑或上传回调都基于最新 state 合并，不会互相覆盖。
  const update = (patch) => onChange((current) => ({ ...current, ...patch }));
  const updateGroups = (mapper) => onChange((current) => ({ ...current, materialGroups: mapper(current.materialGroups ?? lesson.materialGroups ?? []) }));
  const updateGroup = (index, patch) => updateGroups((list) => list.map((group, i) => i === index ? { ...group, ...patch } : group));
  // VibeCoding 课时设置（2026-09-19 用户口径）：**发送次数上限** 与 **预设提示词**。
  // 两者都放进 classroom_config.vibeCoding —— `normalizeClassroomConfig` 对该对象是整体透传的，
  // 所以**不新增表、不需要数据迁移**；判定与计数在服务端（services/vibecodingLessonSettings.js）。
  const vibeCodingConfig = classroomConfig.vibeCoding || {};
  const presetPrompts = Array.isArray(vibeCodingConfig.presetPrompts) ? vibeCodingConfig.presetPrompts : [];
  const updateVibeCoding = (patch) => onChange((current) => {
    const config = classroomConfigFor(lesson, current);
    return { ...current, classroomConfig: { ...config, vibeCoding: { ...(config.vibeCoding || {}), ...patch } } };
  });
  // 列表按函数式更新（与 materialGroups 同一套写法），连续编辑不会互相覆盖
  const updatePresetPrompts = (mapper) => onChange((current) => {
    const config = classroomConfigFor(lesson, current);
    const vibe = config.vibeCoding || {};
    const list = Array.isArray(vibe.presetPrompts) ? vibe.presetPrompts : [];
    return { ...current, classroomConfig: { ...config, vibeCoding: { ...vibe, presetPrompts: mapper(list) } } };
  });
  const updatePresetPrompt = (index, patch) => updatePresetPrompts((list) => list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const addPresetPrompt = () => updatePresetPrompts((list) => [...list, { title: '', text: '' }]);
  const removePresetPrompt = (index) => updatePresetPrompts((list) => list.filter((_, i) => i !== index));
  function updateMaterial(groupIndex, materialIndex, uid, patch) {
    updateGroups((list) => list.map((group, i) => {
      if (i !== groupIndex) return group;
      const materials = group.materials || [];
      const matched = uid ? materials.findIndex((item) => item.uid === uid) : -1;
      const index = matched >= 0 ? matched : materialIndex;
      if (uid && matched < 0) return group;
      if (!materials[index]) return group;
      return { ...group, materials: materials.map((item, j) => j === index ? { ...item, ...patch } : item) };
    }));
  }
  const removeMaterial = (groupIndex, materialIndex) => updateGroups((list) => list.map((group, i) => i !== groupIndex ? group : { ...group, materials: (group.materials || []).filter((_, j) => j !== materialIndex) }));
  // 素材级函数式更新：上传回调等异步场景不能依赖渲染时的快照。
  function patchMaterial(groupIndex, materialIndex, uid, patcher) {
    updateGroups((list) => list.map((group, i) => {
      if (i !== groupIndex) return group;
      const materials = group.materials || [];
      const matched = uid ? materials.findIndex((item) => item.uid === uid) : -1;
      const index = matched >= 0 ? matched : materialIndex;
      if (uid && matched < 0) return group;
      const material = materials[index];
      if (!material) return group;
      return { ...group, materials: materials.map((item, j) => j === index ? { ...item, ...patcher(item) } : item) };
    }));
  }
  // 生成框体素材：模型与参数存在 snapshot.box 里，改哪一项只动这个对象。
  function patchBox(groupIndex, materialIndex, uid, patcher) {
    patchMaterial(groupIndex, materialIndex, uid, (material) => {
      const snapshot = material.snapshot && typeof material.snapshot === 'object' ? material.snapshot : {};
      const box = snapshot.box && typeof snapshot.box === 'object' ? snapshot.box : {};
      return { snapshot: { ...snapshot, box: patcher(box) } };
    });
  }
  // 切成生成框体时补一份默认框体配置；模态按本课已开放的能力挑第一个。
  function changeMaterialType(groupIndex, materialIndex, uid, materialType) {
    if (materialType !== 'GENERATION_BOX') { updateMaterial(groupIndex, materialIndex, uid, { materialType }); return; }
    const modality = capabilities.includes('image') ? 'IMAGE' : capabilities.includes('video') ? 'VIDEO' : 'TEXT';
    const caps = capabilitiesFor(modality, '');
    patchMaterial(groupIndex, materialIndex, uid, (material) => {
      const snapshot = material.snapshot && typeof material.snapshot === 'object' ? material.snapshot : {};
      return {
        materialType,
        snapshot: {
          ...snapshot,
          box: snapshot.box || (modality === 'MUSIC'
            ? { modality, model: '', mode: 'LYRICS' }
            // 参数默认留空＝学生自己在课堂里选（平台想固定再填）。
            : { modality, model: '', aspectRatio: '', resolution: '', durationSeconds: null, audio: null }),
        },
      };
    });
  }
  // 换模态后重置参数：默认留空＝学生自选（平台想固定再填）。
  function changeBoxModality(groupIndex, materialIndex, uid, modality) {
    patchBox(groupIndex, materialIndex, uid, () => (modality === 'MUSIC'
      ? { modality, model: '', mode: 'LYRICS' }
      : { modality, model: '', aspectRatio: '', resolution: '', durationSeconds: null, audio: null }));
  }
  // 换模型后：学生自选的保持自选，平台定过的值如果新模型不支持就退回「学生自选」。
  function changeBoxModel(groupIndex, materialIndex, uid, model) {
    patchBox(groupIndex, materialIndex, uid, (box) => {
      const modality = String(box.modality || 'TEXT').toUpperCase();
      if (modality === 'TEXT' || modality === 'MUSIC') return { ...box, model };
      const caps = capabilitiesFor(modality, model);
      const next = { ...box, model };
      if (next.aspectRatio && !caps.aspectRatios.includes(next.aspectRatio)) next.aspectRatio = '';
      if (next.resolution && !caps.resolutions.includes(next.resolution)) next.resolution = '';
      if (modality === 'VIDEO') {
        if (Number(next.durationSeconds) && !caps.durations.includes(Number(next.durationSeconds))) next.durationSeconds = null;
        if (!caps.audio) next.audio = false;
      }
      return next;
    });
  }
  // 能力与框体联动：取消勾选能力时不再清空框体（避免误删配置），框体素材上会标注「学生看不到」。
  function toggleCapability(value, checked) {
    onChange((current) => {
      const caps = current.capabilities ?? lesson.capabilities ?? ['text'];
      const next = checked ? [...new Set([...caps, value])] : caps.filter((item) => item !== value);
      return { ...current, capabilities: next };
    });
  }
  async function uploadMaterial(groupIndex, materialIndex, file) {
    if (!file) return;
    const uid = groups[groupIndex]?.materials?.[materialIndex]?.uid;
    const key = `${groupIndex}:${materialIndex}`; setUploading(key);
    onChange((current) => ({ ...current, uploadCount: (current.uploadCount || 0) + 1 }));
    try {
      const asset = await api.upload('admin/file-assets/upload', file, { category: 'MEDIA_ASSET', visibility: 'PUBLIC_PLATFORM' });
      const assetUrl = asset?.id ? `/api/student/file-assets/${asset.id}/download` : '';
      if (!assetUrl) throw new Error('上传成功但未返回文件标识');
      patchMaterial(groupIndex, materialIndex, uid, (material) => ({
        assetUrl,
        snapshot: { ...(material.snapshot && typeof material.snapshot === 'object' ? material.snapshot : {}), assetId: asset.id },
      }));
      setUploadMessage(`「${file.name}」上传成功，请保存课时。`);
    } catch (error) { setUploadMessage(`上传失败：${error.message}`); } finally { setUploading(''); onChange((current) => ({ ...current, uploadCount: Math.max(0, (current.uploadCount || 0) - 1) })); }
  }
  const addMaterial = (groupIndex) => updateGroups((list) => list.map((group, i) => {
    if (i !== groupIndex) return group;
    const materials = group.materials || [];
    return { ...group, materials: [...materials, { uid: nextUid(), title: `素材${materials.length + 1}`, description: '', materialType: 'PROMPT', assetUrl: '', snapshot: {} }] };
  }));
  const addGroup = () => updateGroups((list) => [...list, { uid: nextUid(), title: `素材${list.length + 1}`, materials: [] }]);


  return <div className="lesson-canvas-config-editor">
    {uploadMessage ? <Notice>{uploadMessage}</Notice> : null}
    <div className="lesson-delivery-modes">
      {/* 复用「本课开放能力」那套类：flex + 复选框与文字同行（checkbox-option 是机构端的类，平台端没样式，
          用它会让文字掉到复选框下面） */}
      <div className="lesson-capability-checks"><strong>上课类型（可多选，学生端两个入口并列）</strong>
        {[['CANVAS', '画布课堂'], ['VIBECODING', 'VibeCoding 课堂']].map(([value, label]) => (
          <label key={value}><input type="checkbox" checked={deliveryModes.includes(value)} onChange={() => toggleDeliveryMode(value)} />{label}</label>
        ))}
      </div>
      <p className="muted">{offersCanvas && offersVibe
        ? '两种都开：学生在这节课可以选「画布创作」或「VibeCoding」进入，各自记进度与作品。'
        : offersVibe
          ? '只开 VibeCoding：学生进入后与 AI 对话写代码（已自动勾上「AI 文字」）。'
          : '只开画布：学生进来后在画布里创作；下面按需要开放生图 / 生视频 / 音乐能力。'}</p>
    </div>
    {offersVibe ? <section className="lesson-material-group-editor"><h3>VibeCoding 入口</h3><p className="muted">仅使用 AI 文字对话；图片、视频、音乐能力与画布素材属于画布入口。</p>
      <label>文字模型<select value={vibeCodingConfig.model || ''} onChange={(event) => updateVibeCoding({ model: event.target.value })}><option value="">跟随文字渠道默认模型</option>{channelModels('TEXT').map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
      {/* 发送次数上限（2026-09-19 用户口径「可以选发送按钮可以按几次」）。
          ⚠️ 不填 = 不限次（现状一字不改）；填了就由**服务端**按「这个学生在这节课按了几次发送」拦，
          客户端改不掉（计数在服务端，见 services/vibecodingLessonSettings.js）。 */}
      <label>发送次数上限<input type="number" min="0" step="1" value={vibeCodingConfig.sendLimit ?? ''} onChange={(event) => updateVibeCoding({ sendLimit: event.target.value === '' ? undefined : Math.max(0, Math.floor(Number(event.target.value) || 0)) })} placeholder="不填 = 不限次" /><small className="muted">不填或填 0 = 不限次。按「学生在这节课按了几次发送」计，由服务端统计（dsh 自己的内部请求不计数）。</small></label>
      {/* 预设提示词（2026-09-19 用户口径）：客户端显示成可点的提示词块，点一下把内容填进对话框 */}
      <div className="lesson-config-heading"><strong>预设提示词</strong><button type="button" className="text-button" onClick={addPresetPrompt}>＋预设提示词</button></div>
      <p className="muted">客户端会把它们显示在对话框旁边；学生点一下，就把内容**填进输入框**（不直接发送，还能自己改）。</p>
      {presetPrompts.map((preset, index) => <div className="lesson-config-row" key={index}>
        <input value={preset.title || ''} placeholder={`按钮上那句话（第 ${index + 1} 条）`} onChange={(event) => updatePresetPrompt(index, { title: event.target.value })} maxLength={40} />
        <textarea value={preset.text || ''} placeholder="点下去要填进输入框的提示词" onChange={(event) => updatePresetPrompt(index, { text: event.target.value })} maxLength={2000} />
        <button type="button" className="text-button danger-text" onClick={() => removePresetPrompt(index)}>删除</button>
      </div>)}
      {/* ⚠️ 2026-09-20：这里原来还有一个「给学生的编程任务 / 素材说明」文本域（写 lessonContent）。
          用户口径「创建 vibeCoding 时这个内容删除」——与之前删掉的「平台预填 / 预置素材 / 素材说明」
          三栏是同一条线：VibeCoding 课时的框体进画布后由**学生自己写描述、自己连图**，
          平台不再在课时上预置任务说明。历史值仍留在库里（官网课时列表还会照旧显示），只是不再可编辑。 */}
      </section> : null}
    {offersCanvas ? <div className="lesson-capability-checks"><strong>画布入口开放能力</strong>{LESSON_CAPABILITY_OPTIONS.map(([value, label]) => <label key={value}><input type="checkbox" checked={capabilities.includes(value)} onChange={(event) => toggleCapability(value, event.target.checked)} disabled={offersVibe && value === 'text'} />{label}</label>)}</div> : null}
    {offersVibe && !offersCanvas ? null : <>
      <div className="lesson-material-groups"><div className="lesson-config-heading"><strong>本节课画布素材</strong><button type="button" className="text-button" onClick={addGroup}>＋素材组</button></div>
        {groups.map((group, groupIndex) => <div className="lesson-material-group-editor" key={group.id || group.uid || `new-${groupIndex}`}>
          <div className="lesson-config-row"><input value={group.title || ''} placeholder={`素材${groupIndex + 1}`} onChange={(event) => updateGroup(groupIndex, { title: event.target.value })} /><button type="button" className="text-button danger-text" onClick={() => updateGroups((list) => list.filter((_, i) => i !== groupIndex))}>删除组</button></div>
          {(group.materials || []).map((material, materialIndex) => {
            const snapshot = material.snapshot || {};
            const isBox = material.materialType === 'GENERATION_BOX';
            const isText = ['NOTE', 'PROMPT'].includes(material.materialType);
            const box = isBox ? (snapshot.box || {}) : null;
            const modality = String(box?.modality || 'TEXT').toUpperCase();
            const caps = isBox ? capabilitiesFor(modality, box.model) : null;
            const capabilityLabel = modality === 'IMAGE' ? 'AI 生图' : modality === 'VIDEO' ? 'AI 生视频' : modality === 'MUSIC' ? 'AI 音乐' : 'AI 文字';
            // ⚠️ 2026-09-19 用户口径：把生成框体的「平台预填内容」与「预置图片 / 预置首帧图」两栏**删掉** ——
            //    框体进画布后由学生自己写描述、自己连一张图（学生端本来就有「首帧/尾帧」连线行，
            //    缺首帧时还会提示「该模型需要先连接一张画面（首帧）」，见 canvas 的 blocked 文案）。
            //    所以那两个字段不是"唯一的入口"，删掉不留功能缺口。
            const currentType = material.materialType || 'PROMPT';
            const typeOptions = MATERIAL_TYPE_OPTIONS.some(([value]) => value === currentType)
              ? MATERIAL_TYPE_OPTIONS
              : [[currentType, LEGACY_MATERIAL_TYPE_LABELS[currentType] || currentType], ...MATERIAL_TYPE_OPTIONS];
            return <article className="lesson-material-item-editor" key={material.id || material.uid || `new-${materialIndex}`}>
              {/* 类型标记：老师在一列里扫的时候，先看这个色块就知道这条是生图框体 / 生视频框体 /
                  提示词…（类型下拉只显示当前值，扫列表时看不出来；用户 2026-09-17 报的第 2 条）。
                  色与学生端列表、画布上的框体是同一套。 */}
              <header className="lesson-material-item-head">
                <span className="lesson-material-item-index">素材 {materialIndex + 1}</span>
                <span className={`lesson-material-kind is-${materialVisual({ materialType: currentType, modality }).tone}`} title={`类型：${materialVisual({ materialType: currentType, modality }).label}`}><Icon name={materialVisual({ materialType: currentType, modality }).icon} size={13} />{materialVisual({ materialType: currentType, modality }).label}</span>
                <select className="lesson-material-item-type" value={currentType} onChange={(event) => changeMaterialType(groupIndex, materialIndex, material.uid, event.target.value)}>{typeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                <button type="button" className="text-button danger-text" onClick={() => removeMaterial(groupIndex, materialIndex)}>删除</button>
              </header>
              <LessonField label="素材标题"><input value={material.title || ''} placeholder="显示给学生看的名字" onChange={(event) => updateMaterial(groupIndex, materialIndex, material.uid, { title: event.target.value })} /></LessonField>
              {isBox ? <>
                {capabilities.includes(modality.toLowerCase()) ? null : <p className="muted">本课没有开放「{capabilityLabel}」能力，学生看不到这个框体；勾选上方能力后才会出现。</p>}
                <div className="lesson-field-row">
                  <LessonField label="生成什么"><select value={modality} onChange={(event) => changeBoxModality(groupIndex, materialIndex, material.uid, event.target.value)}>{GENERATION_BOX_MODALITY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></LessonField>
                  <LessonField label="模型">{channelModels(modality).length ? <select value={box.model || ''} onChange={(event) => changeBoxModel(groupIndex, materialIndex, material.uid, event.target.value)}><option value="">使用渠道默认模型</option>{channelModels(modality).map((model) => <option key={model} value={model}>{model}</option>)}</select> : <input value={box.model || ''} placeholder="渠道未配置模型，可手填" onChange={(event) => changeBoxModel(groupIndex, materialIndex, material.uid, event.target.value)} />}</LessonField>
                  {modality === 'MUSIC' ? <LessonField label="生成模式"><select value={box.mode || 'LYRICS'} onChange={(event) => patchBox(groupIndex, materialIndex, material.uid, (current) => ({ ...current, mode: event.target.value }))}>{MUSIC_MODE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></LessonField> : null}
                </div>
                {/* 生成方式：这节课的这个框体"要哪种"（文生/图生/首尾帧/全能参考、文生图/图生图）。
                    ⚠️ 用户 2026-09-21 口径：这几个是**完全不一样的概念**，不能靠"学生连了几条线"去推 ——
                    连 2 张图也可能要全能参考而不是首尾帧。留空＝不锁（按连线与模型能力自动判断，旧课包就是这样）。
                    锁了之后：画布按它限制能连什么，服务端按它决定连过来的素材算什么（首帧 / 尾帧 / 参考）。
                    放在「模型」正下方：它是老师配这节课时**最先要定的一件事**，也是学生端连线的依据。 */}
                {(modality === 'IMAGE' || modality === 'VIDEO') ? <div className="lesson-field-row">
                  <LessonField label="生成方式" hint={generationModeOptions(caps, modality).length > 1 ? '决定画布上能连什么、连过来的素材怎么用' : '当前模型只支持这一种'}>
                    <select value={box.inputMode || ''} onChange={(event) => patchBox(groupIndex, materialIndex, material.uid, (current) => ({ ...current, inputMode: event.target.value }))}>
                      <option value="">学生自选（按连线内容自动判断）</option>
                      {generationModeSelectOptions(caps, modality, box.inputMode).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </LessonField>
                </div> : null}
                {modality === 'IMAGE' || modality === 'VIDEO' ? <div className="lesson-field-row">
                  <LessonField label="比例"><select value={box.aspectRatio || ''} onChange={(event) => patchBox(groupIndex, materialIndex, material.uid, (current) => ({ ...current, aspectRatio: event.target.value }))}><option value={STUDENT_CHOICE}>学生自选（课堂里由学生挑）</option>{valueOptionsFor(caps.aspectRatios, box.aspectRatio).map((value) => <option key={value} value={value}>{value}</option>)}</select></LessonField>
                  <LessonField label="清晰度"><select value={box.resolution || ''} onChange={(event) => patchBox(groupIndex, materialIndex, material.uid, (current) => ({ ...current, resolution: event.target.value }))}><option value={STUDENT_CHOICE}>学生自选（课堂里由学生挑）</option>{valueOptionsFor(caps.resolutions, box.resolution).map((value) => <option key={value} value={value}>{value}</option>)}</select></LessonField>
                  {modality !== 'TEXT' && !caps.aspectRatios.length ? null : null}
                </div> : null}
                {modality === 'VIDEO' ? <div className="lesson-field-row">
                  <LessonField label="时长（秒）"><select value={box.durationSeconds === null || box.durationSeconds === undefined ? '' : String(box.durationSeconds)} onChange={(event) => patchBox(groupIndex, materialIndex, material.uid, (current) => ({ ...current, durationSeconds: event.target.value === '' ? null : Number(event.target.value) }))}><option value="">学生自选（课堂里由学生挑）</option>{valueOptionsFor(caps.durations.map(String), box.durationSeconds === null || box.durationSeconds === undefined ? '' : String(box.durationSeconds)).map((value) => <option key={value} value={value}>{value} 秒</option>)}</select></LessonField>
                  <LessonField label="生成音频" hint={caps.audio ? '' : '当前模型不支持生成音频'}><select value={box.audio === true ? 'YES' : box.audio === false ? 'NO' : ''} disabled={!caps.audio} onChange={(event) => patchBox(groupIndex, materialIndex, material.uid, (current) => ({ ...current, audio: event.target.value === '' ? null : event.target.value === 'YES' }))}><option value="">学生自选（课堂里由学生挑）</option><option value="YES">带音频</option><option value="NO">不带音频</option></select></LessonField>
                </div> : null}
                {modality !== 'TEXT' && !caps.aspectRatios.length ? <p className="muted">该模型还没有配置可用比例，请先到「模型与算力 → 渠道与模型配置」里填写。</p> : null}
                                              </> : <>
                                {isText
                  ? <LessonField label={material.materialType === 'PROMPT' ? '提示词内容' : '文字内容'}><textarea rows={3} value={snapshot.content || ''} onChange={(event) => updateMaterial(groupIndex, materialIndex, material.uid, { snapshot: { ...snapshot, content: event.target.value } })} /></LessonField>
                  : <LessonField label="素材文件" hint="可粘贴 HTTPS 地址，也可直接上传">
                    <div className="lesson-asset-input">
                      <input value={material.assetUrl || ''} placeholder="资源地址" onChange={(event) => updateMaterial(groupIndex, materialIndex, material.uid, { assetUrl: event.target.value })} />
                      <label className="inline-file-upload">{uploading === `${groupIndex}:${materialIndex}` ? '上传中…' : '上传文件'}<input type="file" accept="image/*,video/*,audio/*" disabled={uploading === `${groupIndex}:${materialIndex}`} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; uploadMaterial(groupIndex, materialIndex, file); }} /></label>
                    </div>
                  </LessonField>}
              </>}
              <MaterialPreview url={material.assetUrl} type={material.materialType} content={snapshot.content} />
            </article>;
          })}
          <button type="button" className="text-button" onClick={() => addMaterial(groupIndex)}>＋素材</button>
        </div>)}
        {!groups.length && <p className="muted">还没有画布素材。学生进入课时后，可在左侧素材面板按这里的顺序逐个点击加入画布；「生成框体」也是一种素材，每个框体只能生成一次。</p>}
      </div>
    </>}

  </div>;
}

/* ---------------------------------------------------------------- 课时编辑抽屉 */

function LessonDrawer({ api, lesson, onClose, onSaved }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const [edit, setEdit] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [step, setStep] = useState(0);
  const title = edit.title ?? lesson.title;
  const summary = edit.summary ?? lesson.summary ?? '';
  const durationMinutes = edit.durationMinutes ?? lesson.durationMinutes ?? 45;
  const status = edit.status ?? lesson.status;
  const lessonContent = edit.lessonContent ?? lesson.lessonContent ?? '';
  const update = (patch) => setEdit((current) => ({ ...current, ...patch }));
  // 上课类型改为可多选（画布 + VibeCoding 可同时开，学生端两个入口并列）。
  // 老数据只有单值 deliveryMode，这里统一读成数组再编辑。
  const deliveryModes = edit.deliveryModes ?? lesson.deliveryModes ?? [lesson.deliveryMode || 'CANVAS'];

  async function save() {
    if (edit.uploadCount) { setMessage('请等待素材上传完成后保存'); return; }
    setBusy(true); setMessage('');
    try {
      if (!String(title).trim() || !Number.isInteger(Number(durationMinutes)) || Number(durationMinutes) < 1 || Number(durationMinutes) > 1440) throw new Error('请填写名称和 1–1440 分钟的整数时长');
      if (edit.platformBudgetYuan && !/^\d+(?:\.\d{1,2})?$/.test(edit.platformBudgetYuan)) throw new Error('预算必须为非负金额，最多两位小数');
      const body = {
        title, summary, durationMinutes: Number(durationMinutes), lessonContent,
        deliveryModes,
        platformBudgetFen: edit.platformBudgetYuan === undefined ? lesson.platformBudgetFen ?? null : edit.platformBudgetYuan === '' ? null : Math.round(Number(edit.platformBudgetYuan) * 100),
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

  const closeDisabled = busy || Boolean(edit.uploadCount);
  return <dialog className="lesson-editor-dialog" ref={dialogRef} aria-labelledby="lesson-drawer-title" onCancel={(event) => { event.preventDefault(); if (!closeDisabled) onClose(); }} style={{ width: 'min(920px, 100vw)', maxWidth: '100vw', height: '100dvh', maxHeight: '100dvh', margin: '0 0 0 auto', padding: 0, border: 0 }}>
    <div className="drawer-panel" style={{ width: '100%', height: '100%', minWidth: 0 }}>
      {/* 只保留抽屉里的宽度/换行修正。这里**不能**给 .inline-file-upload input 加 display:block：
          它是 label 包住的隐藏文件域，露出来会在「上传图片」按钮旁边多一个原生的
          「选择文件 / 未选择任何文件」。 */}
      <style>{`.lesson-editor-dialog .lesson-canvas-config-editor{min-width:0;max-width:none;width:100%}.lesson-editor-dialog .lesson-config-row{flex-wrap:wrap}`}</style>
      <header className="drawer-head">
        <div><span className="eyebrow">课时配置</span><h2 id="lesson-drawer-title">{title || '未命名课时'}</h2></div>
        <button type="button" className="drawer-close" aria-label="关闭课时配置" disabled={closeDisabled} onClick={onClose}>×</button>
      </header>
      <div className="drawer-body" style={{ minHeight: 0, minWidth: 0 }}>
        {message && <Notice tone="danger">{message}</Notice>}
        <nav className="tabs" aria-label="课时配置步骤" style={{ flexWrap: 'wrap' }}>{['1 基础与预算', '2 学生能力与素材', '3 教师素材与确认'].map((label, index) => <button type="button" key={label} aria-current={step === index ? 'step' : undefined} className={`tab ${step === index ? 'is-active' : ''}`} onClick={() => setStep(index)}>{label}</button>)}</nav>
        <section className="drawer-section" hidden={step !== 0}>
          <h3>基本信息</h3>
          <label>课时标题<input autoFocus value={title} onChange={(event) => update({ title: event.target.value })} required /></label>
          <label>课时简介<textarea rows={2} value={summary} onChange={(event) => update({ summary: event.target.value })} /></label>
          <div className="form-grid">
            <label>时长（分钟）<input type="number" min="1" max="1440" value={durationMinutes} onChange={(event) => update({ durationMinutes: event.target.value })} /></label>
            <label>状态<select value={status} onChange={(event) => update({ status: event.target.value })}><option value="DRAFT">草稿</option><option value="PUBLISHED">已发布</option><option value="ARCHIVED">已下架</option></select></label>
          </div>
        </section>
        <section className="drawer-section" hidden={step !== 0}>
          <label>平台预算（元 / 每场课堂）<input inputMode="decimal" value={edit.platformBudgetYuan ?? (lesson.platformBudgetFen == null ? '' : String(lesson.platformBudgetFen / 100))} placeholder="留空表示未设置" onChange={(event) => update({ platformBudgetYuan: event.target.value })} /></label>
          <p className="muted">按本课时每场课堂汇总成本，超出预算仅提醒平台，不限制学生调用。</p>
        </section>
        <section className="drawer-section" hidden={step !== 1}>
          <LessonCanvasConfigEditor api={api} lesson={lesson} edit={edit} onChange={setEdit} />
        </section>
        <section className="drawer-section" hidden={step !== 2}>
          <LessonTeachingEditor api={api} lesson={lesson} edit={edit} onChange={setEdit} />
          <p className="muted">保存仅修改编排草稿，课包内容通过「版本发布」显式上线。</p>
        </section>
      </div>
      <footer className="drawer-foot" style={{ flexWrap: 'wrap', flexShrink: 0 }}>
        <button type="button" className="secondary-button" onClick={onClose} disabled={closeDisabled}>取消</button>
        <button type="button" className="secondary-button" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>上一步</button>
        {step < 2 ? <button type="button" className="primary-button" onClick={() => setStep(step + 1)}>下一步</button> : null}
        <button type="button" className="primary-button" onClick={save} disabled={busy || Boolean(edit.uploadCount)}>{busy ? '保存中…' : '保存课时'}</button>
      </footer>
    </div>
  </dialog>;
}

/* ---------------------------------------------------------------- 新建课包 */

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
        <span>库存 {course.stockTotal || 0} 次</span>
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
    if (!window.confirm(`确认删除课包「${course.title}」？删除后课包与课时配置不可恢复；已被课堂引用的课包会拒绝删除，请改用「下架」。`)) return;
    setBusy(true); setMessage('');
    try { await api.request(`admin/course-series/${course.id}`, { method: 'DELETE' }); setMessage(`课包「${course.title}」已删除。`); courses.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  return <>
    <PageHeader eyebrow="课程资产" title="平台课包" description="维护平台级课程资料、课时编排、发布状态与机构授权；改完点「更新发布」填新版本号。"
      actions={<button className="primary-button" onClick={() => setShowCreate(true)}>＋ 新建课包</button>} />
    {message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}
    <Panel title="筛选">
      <div className="form-grid">
        <label>关键词<input value={filters.search} placeholder="课包名称 / ID" onChange={(event) => { setFilters({ ...filters, search: event.target.value }); setPage(1); }} /></label>
        <label>状态<select value={filters.status} onChange={(event) => { setFilters({ ...filters, status: event.target.value }); setPage(1); }}><option value="">全部状态</option><option value="DRAFT">草稿</option><option value="PUBLISHED">已发布</option><option value="ARCHIVED">已下架</option></select></label>
        <label>可见范围<select value={filters.visibility} onChange={(event) => { setFilters({ ...filters, visibility: event.target.value }); setPage(1); }}><option value="">全部范围</option>{VISIBILITY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
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

function CourseDetail({ api, courseId, onBack }) {
  const [activeTab, setActiveTab] = useState('basic');
  const [message, setMessage] = useState('');
  const [saveState, setSaveState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [assignOrgId, setAssignOrgId] = useState('');
  const [assignQuota, setAssignQuota] = useState('');
  const [lessonDraft, setLessonDraft] = useState({ title: '', durationMinutes: 45 });
  const [editingLesson, setEditingLesson] = useState(null);
  const [showPublishReminder, setShowPublishReminder] = useState(false);
  const [releaseVersion, setReleaseVersion] = useState('');
  const [releaseNote, setReleaseNote] = useState('');
  const [uploadingCover, setUploadingCover] = useState(false);
  const detail = useData(() => api.get(`admin/course-series/${courseId}/detail`), [api, courseId]);
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  const series = detail.data?.series || null;
  // 算力预估读数（预估 / 实际 / 价目表参考值）：跟着详情接口一起回来，见 services/courseEstimate.js
  const estimate = detail.data?.computeEstimate || null;

  useEffect(() => {
    if (!series) return;
    setEditForm({
      title: series.title, description: series.description || '', coverImageUrl: series.coverImageUrl || '', coverAssetId: series.coverAssetId || '',
      priceYuan: ((Number(series.priceFen || 0) / 100).toFixed(2)).replace(/\.00$/, ''), version: series.version || '1.0',
      estimatedCreditsPerPerson: series.estimatedCreditsPerPerson || '', gradeRange: series.gradeRange || '',
      visibility: series.visibility, sort: series.sort, difficultyLevel: series.difficultyLevel ?? '', ageRangeMin: series.ageRangeMin ?? '',
      ageRangeMax: series.ageRangeMax ?? '', tags: (series.tags || []).join(','), deliveryMode: series.deliveryMode || 'CANVAS',
      stockTotal: String(series.stockTotal ?? ''),
      perStudentBudgetYuan: series.perStudentBudgetFen == null ? '' : String(series.perStudentBudgetFen / 100),
    });
  }, [series?.id]);

  /** 更新发布：版本号由人填（不再自动 +0.1），变更说明记进版本历史 */
  async function publishVersion() {
    const version = releaseVersion.trim();
    if (!version || version === series?.version) { setMessage('请填写与当前版本不同的新版本号'); return; }
    const note = releaseNote.trim();
    setBusy(true); setMessage('');
    try {
      await api.request(`admin/course-series/${courseId}/versions`, { method: 'POST', body: { version: String(version).trim(), note } });
      setMessage(`已更新发布 v${String(version).trim()}，机构端与官网同步生效。`);
      setShowPublishReminder(false); setReleaseVersion(''); setReleaseNote('');
      detail.refresh();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

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
      // 算力预估的单位是**分/人**（与成本账一致）：非负整数，留空＝未填（0）。
      const estimateText = String(editForm.estimatedCreditsPerPerson ?? '').trim();
      if (estimateText && !/^\d+$/.test(estimateText)) throw new Error('算力预估必须是 ≥ 0 的整数分（单位：分/人）');
      const body = {
        title: editForm.title, description: editForm.description, coverImageUrl: editForm.coverImageUrl || null, coverAssetId: editForm.coverAssetId || null,
        priceFen: Math.round(Number(priceText) * 100),
        estimatedCreditsPerPerson: estimateText ? Number(estimateText) : 0, gradeRange: editForm.gradeRange || '',
        visibility: editForm.visibility, deliveryMode: editForm.deliveryMode || 'CANVAS',
      };
      if (body.coverImageUrl && !/^(https:\/\/|\/api\/)/.test(body.coverImageUrl)) throw new Error('封面地址必须是 HTTPS 链接或平台上传地址');
      body.difficultyLevel = editForm.difficultyLevel !== '' && editForm.difficultyLevel != null ? Number(editForm.difficultyLevel) : null;
      body.ageRangeMin = editForm.ageRangeMin !== '' && editForm.ageRangeMin != null ? Number(editForm.ageRangeMin) : null;
      body.ageRangeMax = editForm.ageRangeMax !== '' && editForm.ageRangeMax != null ? Number(editForm.ageRangeMax) : null;
      body.tags = String(editForm.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      await api.request(`admin/course-series/${courseId}`, { method: 'PUT', body });
      setMessage('课包资料已保存，需在版本发布中显式更新。');
      setSaveState({ tone: 'success', text: '已保存，尚未更新发布。' });
      detail.refresh();
    } catch (error) { setMessage(error.message); setSaveState({ tone: 'danger', text: error.message }); }
    finally { setBusy(false); }
  }

  async function changeStatus(action) {
    const text = action === 'archive'
      ? `确认下架「${series.title}」？下架后机构端不再可见该课包，数据保留，可随时重新发布。`
      : `确认发布「${series.title}」？发布后课包会出现在官网课程广场（${VISIBILITY_LABELS[series.visibility] || series.visibility}）供大家浏览；机构后台仍然看不到，要到「次数授权管理」中授权后该机构才能看到并使用。`;
    await run(`admin/course-series/${courseId}/status`, 'POST', { action }, action === 'archive' ? '课包已下架。' : '课包已发布。', text);
  }

  async function deleteCourse() {
    if (!window.confirm(`确认删除课包「${series.title}」？删除后课包与课时配置不可恢复；已被课堂引用的课包会拒绝删除，请改用「下架」。`)) return;
    setBusy(true); setMessage('');
    try { await api.request(`admin/course-series/${courseId}`, { method: 'DELETE' }); onBack(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  async function addLesson(event) {
    event.preventDefault();
    if (!lessonDraft.title.trim()) return;
    await run(`admin/course-series/${courseId}/lessons`, 'POST', { lessons: [{ title: lessonDraft.title.trim(), durationMinutes: Number(lessonDraft.durationMinutes || 45), deliveryMode: series?.deliveryMode || 'CANVAS', status: 'DRAFT' }] }, `已添加课时「${lessonDraft.title.trim()}」。`);
    setLessonDraft({ title: '', durationMinutes: 45 });
  }

  async function deleteLesson(lesson) {
    await run(`admin/course-lessons/${lesson.id}`, 'DELETE', undefined, `课时「${lesson.title}」已删除，剩余课时已重新排序。`, `确认删除课时「${lesson.title}」？已被课堂引用的课时无法删除。`);
  }

  async function moveLesson(lesson, direction) {
    if (!series) return;
    const ids = series.lessons.map((item) => item.id);
    const index = ids.indexOf(lesson.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await run(`admin/course-series/${courseId}/lessons/reorder`, 'PUT', { lessonIds: ids }, '课时顺序已更新。');
  }

  async function assign() {
    if (!assignOrgId) return;
    setBusy(true); setMessage('');
    try {
      // 不传有效期了：服务端按该机构的合同到期日算（老参数照旧兼容，但不再由这里决定）
      const result = await api.post(`admin/course-series/${courseId}/assignments`, { orgIds: [assignOrgId], quotaTotal: Number(String(assignQuota || "").trim() || 0) });
      setMessage(`已授权该机构使用本课包，有效期至 ${formatDate(result?.expiresAt) || '—'}。`);
      setAssignOrgId(''); setAssignQuota(''); detail.refresh();
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

  const activeAssignments = (detail.data?.assignedOrgs || []).filter((item) => !item.expired).length;
  const publishedLessons = (series?.lessons || []).filter((lesson) => lesson.status === 'PUBLISHED').length;
  const vibecodingLessons = (series?.lessons || []).filter((lesson) => (lesson.deliveryModes || [lesson.deliveryMode]).includes('VIBECODING')).length;
  const vibecodingWithoutText = (series?.lessons || []).filter((lesson) => (lesson.deliveryModes || [lesson.deliveryMode]).includes('VIBECODING') && !(lesson.capabilities || []).includes('text')).length;

  return <>
    <PageHeader eyebrow="课程资产 · 课包编排" title={series ? series.title : '课包详情'}
      description={series ? `状态 ${series.status} · 版本 v${series.version} · 共 ${series.lessons.length} 个课时` : '正在读取课包详情…'}
      actions={<><button className="secondary-button" onClick={onBack}>← 返回课包列表</button>{series ? <button className="secondary-button" disabled={busy} onClick={() => changeStatus('archive')}>下架</button> : null}{series ? <button className="text-button danger-text" disabled={busy} onClick={deleteCourse}>删除</button> : null}{series && series.status !== 'PUBLISHED' ? <button className="primary-button" disabled={busy} onClick={() => changeStatus('publish')}>发布课包</button> : null}</>} />
    {message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}
    {showPublishReminder ? <Notice tone="info"><div role="status">课时已保存，课包尚未更新发布。是否现在填写新版本号并发布？</div><div className="row-actions top-gap"><button type="button" className="primary-button" onClick={() => { setActiveTab('publish'); setShowPublishReminder(false); }}>前往版本发布</button><button type="button" className="secondary-button" onClick={() => setShowPublishReminder(false)}>稍后发布，继续编排</button></div></Notice> : null}
    {detail.loading ? <Loading label="正在读取课包详情…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : !series ? <Empty title="课包不存在" /> : <>
      <div className="metrics">
        {/* 批次 D（班级退场）：原来这两张卡是「引用班级」「班级课单项」——班级已退场，数的只是历史表，
            看的人会以为班级还在用。换成「这个课包开过多少课堂 / 其中几节正在进行」。 */}
        <MetricCard label="开过的课堂" value={detail.data.usage.sessionsForSeries} hint="使用该课包课时的课堂场次（含已结束）" />
        <MetricCard label="正在上课" value={detail.data.usage.activeSessionsForSeries} hint="其中状态为「上课中」的课堂" tone="teal" />
        <MetricCard label="学生作品" value={detail.data.usage.studentWorks} hint="基于该课包课时提交的作品数" tone="pink" />
      </div>
      {activeTab === 'publish' ? <Panel title="版本与发布">
        <div className="row-actions">
          <span>当前版本 <strong>v{series?.version}</strong></span>
          {detail.data.hasUnpublishedChanges
            ? <span className="status warning">有未发布的改动</span>
            : <span className="status success">已是最新发布</span>}

        </div>
        <form onSubmit={(event) => { event.preventDefault(); publishVersion(); }}>
          <div className="form-grid"><label>新版本号<input required maxLength={100} value={releaseVersion} placeholder={`当前 ${series.version}，请填写新版本号`} onChange={(event) => setReleaseVersion(event.target.value)} /></label><label>变更说明（可选）<input maxLength={500} value={releaseNote} onChange={(event) => setReleaseNote(event.target.value)} /></label></div>
          <button className="primary-button" disabled={busy}>{busy ? '发布中…' : '确认更新发布'}</button>
        </form>
        <p className="muted">改课时、改素材都不会自动改版本号；点「更新发布」时填写新版本号与变更说明，发布后已授权机构与官网一起更新。</p>
        {detail.data.versions?.length ? <div className="table-wrap"><table><thead><tr><th>版本</th><th>变更说明</th><th>发布时间</th></tr></thead><tbody>{detail.data.versions.slice(0, 5).map((item) => <tr key={item.id}><td>v{item.version}</td><td>{item.note || '—'}</td><td>{item.publishedAt ? formatDate(item.publishedAt) : '尚未发布'}</td></tr>)}</tbody></table></div> : null}
      </Panel> : null}
      <nav className="tabs" role="tablist">
        {/* 「有未发布的改动」必须**在标签上就看得见**（用户 2026-09-21 口径：不能点进去才知道）——
            与「版本发布」面板里那个 status 同一个判据（detail.hasUnpublishedChanges），不会漂。 */}
        {[['basic', '基本信息'], ['lessons', `课时编排（${series.lessons.length}）`], ['publish', '版本发布']].map(([key, label]) =>
          <button key={key} type="button" role="tab" aria-selected={activeTab === key} className={`tab ${activeTab === key ? 'is-active' : ''}`} onClick={() => setActiveTab(key)}>
            {label}
            {key === 'publish' && detail.data.hasUnpublishedChanges
              ? <span className="tab__flag" title="有未发布的改动：改完点「更新发布」才会同步到机构端与官网">有未发布</span>
              : null}
          </button>)}
      </nav>

      {activeTab === 'basic' ? <Panel title="课包资料">
        {editForm ? <form onSubmit={saveEdit}>
          <h3 className="form-section-title">展示信息</h3>
          <label>课包标题<input value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} required /></label>
          <label>课程简介<textarea rows={3} value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} /></label>
          <label>封面图<span className="muted">（可上传或填写 HTTPS 地址）</span></label>
          <div className="form-grid">
            <input value={editForm.coverImageUrl} placeholder="https://… 或上传后自动填充" onChange={(event) => setEditForm({ ...editForm, coverImageUrl: event.target.value, coverAssetId: '' })} />
            <label className="inline-file-upload">{uploadingCover ? '上传中…' : '上传封面'}<input type="file" accept="image/*" disabled={uploadingCover} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadEditCover(file); }} /></label>
          </div>
          <MaterialPreview url={editForm.coverImageUrl} type="IMAGE" />
          <h3 className="form-section-title">计费与属性</h3>
          <div className="form-grid">
            <label>价格（元）<input inputMode="decimal" value={editForm.priceYuan} onChange={(event) => setEditForm({ ...editForm, priceYuan: event.target.value })} /></label>
            <label>版本号<input value={editForm.version} disabled title="版本号由「更新发布」推进，这里只读" /></label>
            <label>难度（1-5）<input type="number" min="1" max="5" value={editForm.difficultyLevel} placeholder="留空表示未设置" onChange={(event) => setEditForm({ ...editForm, difficultyLevel: event.target.value })} /></label>
            {/* 算力预估（分/人）：**平台内部口径** —— 只在这里和下面的对比面板里出现，
                官网课程广场、机构端、学生端都不下发（见 lib.js 的 includeEstimatedCredits）。 */}
            <label className="span-2">算力预估（分/人）
              <input type="number" min="0" step="1" inputMode="numeric" value={editForm.estimatedCreditsPerPerson} placeholder="留空 = 未填；单位是分，与成本账一致" onChange={(event) => setEditForm({ ...editForm, estimatedCreditsPerPerson: event.target.value })} />
              <small className="muted">{estimateReferenceHint(estimate)}</small>
            </label>
          </div>
          <h3 className="form-section-title">可见范围</h3>
          <div className="form-grid">
            <label>可见范围<select value={editForm.visibility} onChange={(event) => setEditForm({ ...editForm, visibility: event.target.value })}>{VISIBILITY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存课包资料'}</button>
          {saveState ? <Notice tone={saveState.tone}>{saveState.text}</Notice> : null}
          <p className="muted">当前版本只读：改完进入「版本发布」标签页，点击「更新发布」填写新版本号。状态变更请使用右上角发布 / 下架。<strong>公开</strong> = 课程广场与授权机构都能用，<strong>私有</strong> = 不对外；机构看不到课包不是权限问题，是还没在「次数授权管理」中授权给它。</p>
        </form> : null}
      </Panel> : null}

      {activeTab === 'basic' ? <Panel title="算力预估 vs 实际" actions={estimate ? <span className={`status ${estimateVerdict(estimate).tone}`}>{estimateVerdict(estimate).label}</span> : null}>
        <p className="muted">
          这个字段是<strong>平台内部口径</strong>（单位：分/人），只在平台端展示与对账 —— 官网课程广场、机构端、学生端都不会下发。
          实际成本取该课包下所有 <code>compute_attempts</code> 的成功调用，按课时归集（<code>class_sessions.lesson_id</code> 兜底）；
          <strong>成本未知的调用只计笔数、不按 0 计入金额</strong>，所以「实际」永远是已知部分的下界。
        </p>
        <div className="split">
          <div className="table-wrap"><table><thead><tr><th>口径</th><th>分/人</th><th>合计（分）</th><th>说明</th></tr></thead><tbody>
            <tr>
              <td>课包预估</td>
              <td>{estimate?.estimateConfigured ? formatFen(estimate.estimatedPerPersonFen) : '未填'}</td>
              <td>{estimate?.estimatedTotalFen == null ? '—' : formatFen(estimate.estimatedTotalFen)}</td>
              <td>预估值 × 上过课的学生数（没有学生时合计留空，不编数字）</td>
            </tr>
            <tr>
              <td>实际（上游成本）</td>
              <td>{formatFen(estimate?.actualKnownPerPersonFen)}{estimate?.costComplete ? '' : ' 起'}</td>
              <td>{formatFen(estimate?.actualKnownTotalFen)}</td>
              <td>{estimate?.costComplete
                ? `成功调用 ${estimate.successAttemptCount} 笔的成本全部已知`
                : `另有 ${estimate.unknownCostCalls} 笔成本未知（尝试 ${estimate.unknownCostAttempts} 笔、历史无算力证据用量 ${estimate.uncostedLegacyCalls} 笔），只计笔数、不计入金额`}{estimate?.failedAttemptCount ? `；另有 ${estimate.failedAttemptCount} 笔失败/被拦的调用（不计入成本）` : ''}</td>
            </tr>
            <tr>
              <td>参考值（价目表折算）</td>
              <td>{estimate?.reference?.perPersonFen == null ? '—' : formatFen(estimate.reference.perPersonFen)}</td>
              <td>—</td>
              <td>{estimate?.reference?.note || '正在读取当前价目表…'}</td>
            </tr>
          </tbody></table></div>
          <div>
            {estimateVerdict(estimate).detail ? <Notice tone={estimateVerdict(estimate).tone === 'danger' ? 'danger' : estimateVerdict(estimate).tone === 'warning' ? 'warning' : 'info'}>{estimateVerdict(estimate).detail}</Notice> : null}
            <p className="muted">
              上过课的学生：<strong>{estimate ? estimate.studentCount : '—'}</strong> 人
              {estimate?.studentCountSource === 'SESSION_ROSTER' ? '（来自课堂名单，退出的已剔除）'
                : estimate?.studentCountSource === 'COMPUTE_USERS' ? '（没有课堂名单，按真正用过算力的人数）'
                  : estimate?.studentCountSource === 'NONE' ? '（还没有课堂名单，也没有人用过算力）' : ''}
              ；调用尝试：<strong>{estimate ? estimate.attemptCount : '—'}</strong> 笔（成功 {estimate ? estimate.successAttemptCount : '—'}）。
            </p>
          </div>
        </div>
        <h3 className="form-section-title">按课时拆分（实际成本）</h3>
        {estimate?.lessons?.length
          ? <div className="table-wrap"><table><thead><tr><th>课时</th><th>调用尝试</th><th>未知成本笔数</th><th>已知成本（分）</th><th>关联学生</th></tr></thead><tbody>
            {estimate.lessons.map((item) => <tr key={item.lessonId || 'unlinked'}>
              <td><strong>{item.lessonTitle}</strong></td>
              <td>{item.attemptCount}（成功 {item.successAttemptCount}）</td>
              <td>{item.unknownCostCalls + item.uncostedLegacyCalls > 0
                ? <span className="status warning">{item.unknownCostCalls + item.uncostedLegacyCalls} 笔未知</span>
                : <span className="status success">0</span>}</td>
              <td>{formatFen(item.knownCostFen)}</td>
              <td>{item.computeStudents} 人</td>
            </tr>)}
          </tbody></table></div>
          : <Empty title="还没有可归集的实际成本" body="该课包还没有产生成功调用，或调用没有关联到课时（课堂/项目都要带上课时才能归集）。" />}
        <p className="muted">「实际」只算成功调用（<code>status='SUCCESS'</code>）的上游成本；失败与被拦的调用不计入金额，只单独计数。归集口径：<code>compute_attempts.lesson_id</code> 为空时用课堂的课时兜底，再退一步用课堂带的教学课包。</p>
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
              <td>{(lesson.deliveryModes || [lesson.deliveryMode]).map((mode) => mode === 'CANVAS' ? '画布课堂' : 'VibeCoding').join(' / ')}</td>
              <td><Status value={lesson.status} /></td>
              <td><span className="tag-list">{(lesson.capabilities || []).map((cap) => <span key={cap} className="tag">{cap}</span>)}</span></td>
              <td className="muted">{(lesson.materialGroups || []).length} 组 · 框体 {(lesson.materialGroups || []).reduce((n, group) => n + (group.materials || []).filter((m) => m.materialType === 'GENERATION_BOX').length, 0)} 个</td>
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
        <p className="muted">平台课包必须在这里逐家授权，机构后台才看得到、用得上（发布本身不对任何机构生效）。授权有效期跟随机构的合同到期日，合同到期后该机构立即看不到此课包，续签合同即自动续上。</p>
        <div className="form-grid">
          <label>授权次数<input type="number" min="0" placeholder="留空 = 不限次数" value={assignQuota} onChange={(event) => setAssignQuota(event.target.value)} /></label><label>授权给机构<select value={assignOrgId} onChange={(event) => setAssignOrgId(event.target.value)}><option value="">选择机构</option>{organizations.data?.items?.map((org) => <option key={org.id} value={org.id}>{org.name}</option>) || null}</select></label>
          <div><button type="button" className="secondary-button" disabled={!assignOrgId || busy} onClick={assign}>授权</button></div>
        </div>
        <p className="muted">授权有效期自动跟随该机构的<strong>合同到期日</strong>（2026-09-16 口径）；要延长使用期限就去改机构合同，授权会一起续上。</p>
        {detail.data.assignedOrgs.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>授权时间</th><th>有效期至</th><th>次数（已用/授权）</th><th>操作</th></tr></thead><tbody>{detail.data.assignedOrgs.map((item) => <tr key={item.id}><td>{item.orgName}</td><td>{formatDate(item.assignedAt)}</td><td>{item.expiresAt ? <span className={item.expired ? 'status warning' : ''}>{formatDate(item.expiresAt)}{item.expired ? '（已过期，机构已看不到）' : ''}</span> : '永久有效'}</td><td>{item.quotaTotal ? (item.quotaUsed || 0) + " / " + item.quotaTotal : "不限"}</td><td><button className="text-button danger-text" disabled={busy} onClick={() => run(`admin/course-series/${courseId}/assignments/revoke`, 'POST', { orgId: item.orgId }, `已撤销 ${item.orgName} 的授权，该机构将立即看不到此课包。`, `确认撤销「${item.orgName}」对此课包的授权？`)}>撤销授权</button></td></tr>)}</tbody></table></div> : <Empty title="暂无机构授权" body="平台课包发布后只会上架课程广场；要出现在机构后台，必须在这里授权给对应机构。" />}
      </Panel> : null}

      {activeTab === 'publish' ? <Panel title="发布检查">
        <div className="publish-checklist">
          <div className={`publish-check ${series.lessons.length ? 'is-ok' : 'is-warn'}`}><strong>{series.lessons.length ? '✓' : '!'}</strong><span>课时数量：共 {series.lessons.length} 个</span></div>
          <div className={`publish-check ${series.lessons.length && publishedLessons === series.lessons.length ? 'is-ok' : 'is-warn'}`}><strong>{series.lessons.length && publishedLessons === series.lessons.length ? '✓' : '!'}</strong><span>已发布课时：{publishedLessons} / {series.lessons.length}（未发布的课时无法随课包上线）</span></div>
          <div className={`publish-check ${vibecodingWithoutText ? 'is-warn' : 'is-ok'}`}><strong>{vibecodingWithoutText ? '!' : '✓'}</strong><span>VibeCoding 课时：{vibecodingLessons} 个{vibecodingWithoutText ? `（其中 ${vibecodingWithoutText} 个未开放 AI 文字能力，无法发布）` : '（均已开放 AI 文字能力）'}</span></div>
          <div className="publish-check is-ok"><strong>✓</strong><span>可见范围：{VISIBILITY_LABELS[series.visibility] || series.visibility}</span></div>
          <div className={`publish-check ${activeAssignments ? 'is-ok' : 'is-warn'}`}><strong>{activeAssignments ? '✓' : '!'}</strong><span>机构授权：{detail.data.assignedOrgs.length ? `已授权 ${detail.data.assignedOrgs.length} 个机构，其中 ${activeAssignments} 个在有效期内` : '还没有授权任何机构 —— 发布后机构后台看不到这个课包，只会在官网课程广场展示'}</span></div>
        </div>
        <div className="row-actions top-gap">
          {series.status !== 'PUBLISHED' ? <button className="primary-button" disabled={busy} onClick={() => changeStatus('publish')}>发布课包</button> : <span className="status success">课包已发布</span>}
          {series.status !== 'ARCHIVED' ? <button className="secondary-button" disabled={busy} onClick={() => changeStatus('archive')}>下架课包</button> : null}
        </div>
        <p className="muted">发布前请确认课时均已发布、VibeCoding 课时已开放 AI 文字能力。发布只负责「上架官网课程广场」；机构能不能看到和使用完全取决于「机构授权」（可设 1 年 / 2 年等有效期）。</p>
      </Panel> : null}

      {editingLesson ? <LessonDrawer api={api} lesson={editingLesson} onClose={() => setEditingLesson(null)} onSaved={(text) => { setMessage(text); setShowPublishReminder(true); detail.refresh(); }} /> : null}
    </>}
  </>;
}

/* ---------------------------------------------------------------- 顶层容器 */

/** 列表页（路由 /courses）：点卡片进详情页，不再在一个路由里用 useState 切换 */
export function CourseSeriesListPage({ api }) {
  const navigate = useNavigate();
  return <CourseList api={api} onOpen={(course) => navigate(`/courses/${course.id}`)} />;
}

/** 详情页（路由 /courses/:seriesId）：可深链、可刷新、可后退 */
export function CourseSeriesDetailPage({ api }) {
  const { seriesId } = useParams();
  const navigate = useNavigate();
  if (!seriesId) return <Empty title="课包不存在" body="请从课包列表进入。" />;
  return <CourseDetail api={api} courseId={seriesId} onBack={() => navigate('/courses')} />;
}
