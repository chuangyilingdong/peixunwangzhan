/**
 * 「生成框体 → 画布节点」的**唯一一份**实现（2026-09-30 抽出来）。
 *
 * 为什么要抽：备课画布（机构端「画布备课」）要摆出与**学生画布一模一样**的框体节点 ——
 * 抄一份出来的那天起，两边就会开始漂（学生那边改了参数、标签、默认值，备课那边看不出来）。
 * 学生画布（`canvasWorkspace.jsx`）与备课画布（`apps/org`）现在都 import 这里的两个函数。
 *
 * 两个函数都是**纯函数**：不碰 React、不碰接口，只做"框体配置 → 节点数据"的映射。
 */

/**
 * 素材面板每行要给老师/学生看清"这个框体自己的参数"（不同框体可以不一样）。
 * 平台没定的参数写「学生选」，一眼就知道进画布后这几项是自己挑的。
 */
export function boxParamsLabel(box) {
  const slotType = String(box?.modality || '').toLowerCase();
  // 模型这一格一律显示**显示名**（服务端随框体下发的 modelLabel，运营在「模型显示名」那一页配的）；
  // 没配别名时 modelLabel === 真 ID，所以显示效果与以前一致（2026-09-23 用户口径）。
  const modelName = box?.modelLabel || box?.model;
  if (slotType === 'text') return modelName || '写提示词让 AI 生成文字';
  if (slotType === 'music') {
    const mode = box.mode === 'DESCRIPTION' ? '描述生音乐（平台代写词）' : '歌词生音乐';
    return modelName ? `${mode} · ${modelName}` : mode;
  }
  const params = [box?.aspectRatio || '比例学生选', box?.resolution || '清晰度学生选'];
  if (slotType === 'video') {
    params.push(Number.isInteger(Number(box?.durationSeconds)) && Number(box.durationSeconds) > 0 ? `${box.durationSeconds}秒` : '时长学生选');
    params.push(box?.audio === true ? '含音频' : box?.audio === false ? '不含音频' : '音频学生选');
  }
  if (modelName) params.push(modelName);
  // 本节课锁定的生成方式要在**素材面板上就看得到**（老师配的是"这种课要用哪种方式"，
  // 学生进来之前就该知道这个框体是要写提示词、还是必须连图）—— 没锁就不显示。
  // 标签由服务端算好随框体下发（'文生视频' / '首尾帧' / '图生图' …）—— 单个真相源，
  // 客户端不再抄一份标签表（抄了迟早会漂）
  const modeLabel = box?.inputModeLabel || '';
  if (modeLabel) params.unshift(modeLabel);
  return params.filter(Boolean).join(' · ');
}

/**
 * 按框体定义造一个画布节点（点击添加与刷新后恢复共用）。`asset` 有值时直接把生成结果挂上。
 *
 * ⚠️ 节点字段在这里是**唯一真相**：`slotType` / `boxId` / `inputMode` / 平台定过的参数 /
 *    模型显示名 / 学生自选可选项 / 预填提示词 —— 少一个都会在学生画布或备课画布上表现成"差了点什么"。
 */
export function buildBoxNode(box, current, { asset = null, pending = false } = {}) {
  const slotType = String(box?.modality || '').toLowerCase();
  const promptText = String(box?.prompt || '');
  const assetUrl = String(asset?.assetUrl || '');
  const previewUrl = String(asset?.previewUrl || '');
  const count = current?.nodes?.length || 0;
  return {
    // 一个框体在画布上只对应一个节点：id 由框体 id 派生，重复点击不会多出第二个。
    id: `box-${box.id}`,
    // 画布节点类型：文字用 prompt，音乐用 audio，其余与模态同名
    type: slotType === 'text' ? 'prompt' : slotType === 'music' ? 'audio' : slotType,
    position: { x: 160 + (count % 4) * 280, y: 120 + (count % 3) * 180 },
    data: {
      title: box.title, slotType, boxId: box.id,
      // 本节课锁定的生成方式（'' = 不锁）：画布据此限制连线数量/类型，并显示在面板上
      inputMode: String(box.inputMode || '').toUpperCase(), inputModeLabel: box.inputModeLabel || '',
      // 平台定过的参数：空字符串表示「没定」，学生可以在画布上自己选。
      aspectRatio: box.aspectRatio || '', resolution: box.resolution || '', model: box.model || '',
      // 模型的**显示名**（2026-09-23 用户口径：后台「模型显示名」里配的别名）。服务端在每次下发时现算，
      // 所以后台改完名字、学生刷新就见效，不用重新发布课包。没配别名时它 === model，画布上的字与以前一样。
      modelLabel: box.modelLabel || '',
      // 学生自选时可选项（来自该模型的能力配置，服务端随框体下发）
      paramOptions: box.paramOptions || null,
      studentParams: {},
      referenceUrl: box.assetUrl || '',
      // 平台预填的提示词直接写进框体，学生可以改。
      text: slotType === 'image' ? '' : promptText,
      caption: slotType === 'image' ? promptText : '',
      ...(slotType === 'video' ? {
        durationSeconds: Number.isInteger(Number(box.durationSeconds)) && Number(box.durationSeconds) > 0 ? Number(box.durationSeconds) : null,
        // null＝学生自选，true/false＝平台定了
        audio: box.audio === true || box.audio === false ? box.audio : null,
        requiresFirstFrame: box.requiresFirstFrame === true,
        // 模型支持的输入画面方式（可多选）：文生 / 首帧 / 尾帧
        inputModes: Array.isArray(box.inputModes) ? box.inputModes : (box.requiresFirstFrame === true ? ['FIRST_FRAME'] : ['TEXT']),
        // 课包锁的「音频怎么用」（用户 2026-09-21 口径：对口型 / 声音参考）——面板那行要照它写
        audioRole: box.audioRole === 'VOICE_REFERENCE' ? 'VOICE_REFERENCE' : 'LIP_SYNC',
        audioRoleLabel: box.audioRoleLabel || '',
      } : {}),
      ...(slotType === 'text' ? { generatedText: '' } : {}),
      // 音乐框体：歌词模式学生写词，描述模式学生写描述（歌词由平台代写）
      ...(slotType === 'music' ? { slotType: 'music', mode: box.mode === 'DESCRIPTION' ? 'DESCRIPTION' : 'LYRICS' } : {}),
      // 生成结果（刷新后恢复用）：图片/视频/音乐挂地址，文字挂生成文本
      ...(assetUrl ? { assetUrl, previewUrl: previewUrl || assetUrl } : {}),
      ...(slotType === 'text' && asset?.metadata?.text ? { generatedText: String(asset.metadata.text) } : {}),
      ...(pending ? { generationStatus: 'PENDING' } : {}),
    },
  };
}
