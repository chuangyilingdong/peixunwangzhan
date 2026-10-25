/**
 * 招生军师 · 内容工作台：提示词与演示内容。
 *
 * 这里的提示词、模板和演示文案均为本项目原创；工作台只复用 junshi 自己的
 * 资料库检索结果、机构画像和平台 TEXT 渠道，不复制第三方客户端代码或素材。
 */

const clean = (v) => String(v ?? '').trim();

export function workbenchProfileBlock(profile = {}) {
  const rows = [
    ['账号名称', profile.name],
    ['平台', profile.platform],
    ['产品/服务', profile.product],
    ['目标人群', profile.audience],
    ['当前目标', profile.goal],
    ['表达风格', profile.tone],
    ['内容边界', profile.boundaries],
    ['账号定位', profile.positioning],
  ];
  const lines = rows.filter(([, value]) => clean(value)).map(([label, value]) => `- ${label}：${clean(value)}`);
  return lines.length ? lines.join('\n') : '- 内容账号档案暂未填写';
}

export function chunkBlock(chunks = []) {
  if (!chunks.length) return '（这次没有检索到直接相关的资料）';
  return chunks.map((chunk, index) => {
    const title = clean(chunk.title) || '未命名资料';
    const text = clean(chunk.text).slice(0, 900);
    return `〔资料${index + 1}〕《${title}》\n${text}`;
  }).join('\n\n');
}

export function refsBlock(refs = []) {
  return refs.slice(0, 6).map((ref, index) => {
    const title = clean(ref.name) || `同行${index + 1}`;
    const notes = clean(ref.notes).slice(0, 300);
    return `- ${title}${ref.url ? `（${clean(ref.url)}）` : ''}${notes ? `：${notes}` : ''}`;
  }).join('\n');
}

export function currentMonth() {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: 'numeric' }).format(new Date()));
}

export function calendarBlock(calendar, month) {
  const row = calendar && (calendar[String(month)] || calendar[month]);
  if (!row) return '';
  return [
    row.launch && `本月主线：${row.launch}`,
    row.consume && `消课重点：${row.consume}`,
    row.renew && `续费重点：${row.renew}`,
    row.referral && `转介绍重点：${row.referral}`,
    row.note && `提醒：${row.note}`,
  ].filter(Boolean).join('\n');
}

export function hooksBlock(hooks = []) {
  return (hooks || []).slice(0, 6).map((hook) => {
    return `- ${clean(hook.name)}（${clean(hook.kind)}，${clean(hook.price)}）：${clean(hook.rule).slice(0, 160)}${hook.note ? `；注意：${clean(hook.note)}` : ''}`;
  }).join('\n');
}

export const WORKBENCH_SYSTEM = `你是「小铃铛」，招生军师的内容操盘手，服务中国教培机构的校长、市场和教务负责人。
你不是泛泛聊天的助手，而是把机构自己的资料、账号定位和今天的任务，落成能拍、能发、能执行的内容方案。

工作原则：
1. 先给可执行结论，再解释原因；尽量给逐字话术、镜头、时间点、动作。
2. 机构档案和资料库里有的信息优先使用，并说明来自哪份资料；没有的信息不要编造。
3. 不承诺流量、收益、提分或效果；不使用「保证」「第一」「最」「全网最低」等绝对化用语。
4. 涉及预收费、有奖销售、师资资质、效果承诺时，主动提示合规边界。
5. 中文口语化，短段落，能列点就列点；不要用「作为AI」这类自我指称。
6. 如果缺少关键信息，只问 1-2 个最重要的问题，不要一次问一堆。`;

export function buildChatSystem({ profile, orgProfile, chunks, refs, calendar, hooks, memories }) {
  const memoryText = memoriesBlock(memories || []);
  return `${WORKBENCH_SYSTEM}

【这家机构的情况（来自机构画像）】
${orgProfile || '机构画像未填写。需要品类、价格、校区等信息时，先问最关键的一项。'}
${memoryText ? `\n${memoryText}\n` : ''}
【本月节点（来自招生军师的全年日历，安排内容时优先使用）】
${calendarBlock(calendar, currentMonth()) || '（本月还没有配置节点）'}

【资料库里的钩子玩法（可以结合；价格和规则按机构实际改）】
${hooksBlock(hooks) || '（这次没有可用的钩子玩法）'}

【内容账号档案】
${workbenchProfileBlock(profile)}

【同行观察笔记】
${refs?.length ? refsBlock(refs) : '（还没有同行观察记录）'}

【从机构资料库检索到的原文（优先使用，引用时写清文件标题）】
${chunkBlock(chunks)}

【输出要求】
- 引用资料时写「资料N」或文件标题，不要改写后还说是原话。
- 不要用表格回答普通聊天问题；需要分镜时可以用简洁表格。
- 每条建议都要能落到今天的一个动作上。`;
}

export function buildCopyPrompt({ profile, orgProfile, topic, count, style, chunks, copies }) {
  const examples = (copies || []).slice(0, 3)
    .map((item, index) => `〔同类文案${index + 1}·${clean(item.kind) || '文案'}〕${clean(item.c).slice(0, 300)}`)
    .join('\n');
  return `你是教培机构的口播文案策划。围绕主题写 ${count} 条可直接开拍的口播文案。

【主题】${topic}
【风格】${style || '口语化、真实、有信息量'}
【机构画像】
${orgProfile || '未填写'}
【内容账号档案】
${workbenchProfileBlock(profile)}
【资料库里的同类文案（改写结构与表达，不照抄品牌名和原句）】
${examples || '（没有检索到同类文案）'}
【资料库原文（可引用其中的事实/案例，引用要标来源）】
${chunkBlock(chunks)}

要求：
- 每条 120-220 字，开头 3 秒必须有钩子。
- 结构：标题 / 钩子 / 正文（一个具体场景或反常识点）/ 收尾行动号召。
- 不承诺提分、效果、收益；不用绝对化用语；不编造数据。
- 只输出 Markdown，按「文案 1、文案 2」编号，不要解释创作过程。`;
}

export function buildVideoPrompt({ profile, orgProfile, title, brief, referenceText, mode, chunks }) {
  return `你是短视频编导。根据机构档案和需求，输出一份可直接照着拍的分镜脚本。

【视频主题】${title}
【创作模式】${mode}
【需求说明】${brief || '围绕机构定位做一条可发布的口播视频'}
【参考内容】${referenceText || '无'}
【机构画像】
${orgProfile || '未填写'}
【内容账号档案】
${workbenchProfileBlock(profile)}
【资料库原文（结构、案例和话术可引用；引用要标来源）】
${chunkBlock(chunks)}

输出格式：
1. 视频标题与一句话策略
2. 时长与画幅建议
3. 分镜表：时间 | 画面 | 口播 | 字幕/花字
4. 拍摄清单（场景、道具、人物）
5. 可直接导入剪辑软件的 SRT 口播字幕

要求：
- 总时长 30-60 秒，开头 3 秒必须有钩子。
- 口播自然、短句、口语化；不承诺效果，不使用绝对化用语。
- 复刻模式先拆参考结构（钩子/痛点/证明/转折/行动），再说明替换点。
- 只输出内容，不要解释你的工作过程。`;
}

const subjectOf = (profile) => clean(profile?.product) || '你的课程/服务';
const audienceOf = (profile) => clean(profile?.audience) || '目标家长';

export function demoChat(profile, text) {
  const subject = subjectOf(profile);
  const audience = audienceOf(profile);
  const requestLike = /(选题|文案|口播|脚本|分镜|拆解|同行|爆款)/.test(text);
  const topic = requestLike ? subject : (clean(text).slice(0, 60) || '今天的内容');
  if (/(选题|拍什么|做什么内容|方向)/.test(text)) {
    return `先给你 3 个今天就能拍的方向，围绕「${subject}」和「${audience}」：

**方向 1：反常识纠错**
钩子：很多家长在选${topic}时，第一步就做反了。
正文：指出一个常见误区 → 给一个具体判断标准 → 用一个真实课堂/服务场景说明。
适合：建立专业感，评论区容易讨论。

**方向 2：真实过程记录**
钩子：今天不讲解，直接给你看我们怎么做。
正文：从准备、执行到结果，保留一个不完美的细节。
适合：降低广告感，让新家长先相信你。

**方向 3：家长问题现场回答**
钩子：有家长问我，${topic}到底值不值得？
正文：先共情，再给判断标准，最后给一个低门槛动作（来看一次、聊十分钟）。
适合：把私信问题变成公开内容，顺手完成转化。

建议今天先拍方向 1，30-45 秒，开头 3 秒直接说误区，不要寒暄。你回我「课程是什么、卖给谁、这条想引导什么动作」，我可以把逐字稿写出来。`;
  }
  if (/(文案|口播|脚本|写一条|写几条)/.test(text)) {
    return `先按「${subject}」给你一条 35 秒口播骨架：

**钩子（0-3 秒）**
如果你正在为${topic}发愁，先别急着做决定。

**正文（3-25 秒）**
很多${audience}的问题不是不认真，而是顺序错了：先看孩子/家庭的真实场景，再谈课程；先看老师怎么教，再谈价格。
你可以用三个问题快速判断：这件事是否高频？是否真的影响结果？有没有更低成本的替代方案？

**收尾（25-35 秒）**
把你最卡的一个点发在评论区，我按你的实际情况给一个判断，不推销。

发布前把「${subject}」换成你真实的产品细节，再加一个你自己的课堂/服务案例，会更像你本人。`;
  }
  if (/(同行|对标|爆款|拆解)/.test(text)) {
    return `拆同行别只看播放量，按这 5 层拆：

1. **钩子**：前 3 秒说了什么？是问题、冲突、结果还是身份？
2. **结构**：痛点 → 证明 → 方法 → 行动，缺了哪一段？
3. **证据**：用了案例、数据、对比还是现场画面？哪些你能复现？
4. **表达**：镜头、语速、字幕密度、情绪曲线，哪一点让你看完了？
5. **转化**：结尾引导了什么动作？评论区在问什么？

复刻时只抄结构，不抄原话和画面。把对方的「${topic}」换成你的真实场景，再加入一个对方没有的细节，才不会变成低质搬运。

把参考链接或口播文字发我，我可以按这 5 层做一份逐条拆解。`;
  }
  return `收到。为了不给你泛泛建议，我先对齐 3 件事：

1. 你具体提供什么课程/服务？（${subject === '你的课程/服务' ? '课程名称、年龄段、班型' : subject}）
2. 这条内容主要给谁看？（${audience === '目标家长' ? '孩子年龄、家长城市、消费阶段' : audience}）
3. 你希望看完的人做什么？（私信、评论、到店体验，还是先关注？）

你也可以直接告诉我「今天想拍 ${topic}」，我会按「钩子 → 场景 → 方法 → 行动」给你一版 30-45 秒口播，不需要你从零想。`;
}

export function demoCopy(profile, topic, count, style) {
  const subject = subjectOf(profile);
  const audience = audienceOf(profile);
  const hooks = [
    `如果你正在为${topic}发愁，先别急着做决定。`,
    `关于${topic}，我见过最容易踩的坑，是上来就问价格。`,
    `做${topic}之前，先问自己这三个问题。`,
    `很多家长以为${topic}靠的是运气，其实第一步就错了。`,
    `今天不讲大道理，直接给你一个能用的${topic}判断法。`,
    `如果你是${audience}，这条关于${topic}的内容建议看完。`,
  ];
  const bodies = [
    `先看孩子的真实使用场景，再看${subject}的配置；先算一周会用几次，再算单次成本。很多决定不是课程不好，而是买错了阶段。`,
    `把需求拆成「必须解决」和「可以妥协」两列。必须解决的超过三个，说明还没想清楚；可以妥协的越多，越容易找到合适方案。`,
    `别只看别人推荐什么，先记录孩子最近一周真实出现的问题。问题出现频率最高的那个，才是现在该花钱的地方。`,
    `先做一个最小成本的尝试：来一次体验、旁听一节课、和老师聊十分钟，记录卡点，再决定要不要报长期班。能复用的经验，比一次买贵更值钱。`,
    `把预算分成三份：试错、主力、备用。先用小份验证，再把大部分钱放在已经验证有效的方案上，别一次梭哈。`,
    `找三个和你情况接近的家长，问他们最后悔的一笔教育支出是什么。别人的教训，通常比机构的介绍更有参考价值。`,
  ];
  const ctas = [
    '把你最卡的一个点发在评论区，我按你的情况给判断。',
    '想要这份判断清单，评论区留「清单」，我整理给你。',
    '如果你也遇到过类似情况，说说你最后怎么处理的。',
    '先收藏，等你真正要决定的时候再拿出来对一遍。',
    '把你的孩子年龄和需求发我，我帮你看看有没有更合适的路径。',
    '关注我，下一条讲怎么避开另一个常见坑。',
  ];
  const n = Math.max(1, Math.min(Number(count) || 5, 10));
  const blocks = [];
  for (let index = 0; index < n; index += 1) {
    blocks.push(`### 文案 ${index + 1}
**标题**：${topic}，先别急着做决定
**钩子**：${hooks[index % hooks.length]}
**正文**：${bodies[index % bodies.length]}
**收尾**：${ctas[index % ctas.length]}`);
  }
  return `${blocks.join('\n\n')}\n\n> 风格：${style || '口语化'}。以上为演示模式生成，发布前请替换成你真实的产品细节和案例。`;
}

export function demoVideo(profile, title, brief, referenceText, mode) {
  const subject = subjectOf(profile);
  const audience = audienceOf(profile);
  const safeTitle = clean(title) || `${subject}怎么选`;
  const referenceNote = mode === '复刻' && clean(referenceText)
    ? `
### 参考结构拆解
- 钩子：用一句反常识或结果前置，抓住前 3 秒。
- 痛点：点出${audience}最具体的损失或犹豫。
- 证明：用一个真实课堂/服务场景，而不是形容词。
- 转折：给一个可执行、低门槛的方法。
- 行动：引导一个明确动作，不贪多。

### 替换点
- 把参考里的产品换成「${subject}」。
- 把参考里的数据换成你自己的真实数据；没有数据就删掉。
- 把参考里的口头禅换成你的表达习惯，避免逐句搬运。`
    : '';
  return `## ${safeTitle}

**一句话策略**：用一个具体误区开场，让${audience}先对号入座，再给一个今天就能做的动作。
**时长/画幅**：45 秒 / 9:16 竖屏。

| 时间 | 画面 | 口播 | 字幕/花字 |
|---|---|---|---|
| 0-3s | 人物近景，直接看镜头 | 如果你正在为${safeTitle}发愁，先别急着做决定。 | 先别急着做决定 |
| 3-10s | 切到真实课堂/服务场景 | 很多家长的问题不是不重视，而是顺序错了：先做选择，再谈方法。 | 先选择，再方法 |
| 10-22s | 屏幕录制或对比画面 | 先看孩子的真实场景，再看课程配置；先算一周用几次，再算单次成本。 | 场景 > 配置 |
| 22-33s | 人物中景，给判断清单 | 把需求分成「必须解决」和「可以妥协」，超过三个必须项，说明还没想清楚。 | 两列清单 |
| 33-42s | 课程/服务特写 | 先用最小成本体验一次，记录卡点，再决定要不要报长期班。 | 先试，再决定 |
| 42-45s | 人物近景，收尾 | 把你最卡的点发在评论区，我按你的情况给判断。 | 评论区见 |

### 拍摄清单
- 场景：一个真实教室/服务场景 + 一个干净的近景机位。
- 道具：${subject}、手机/电脑、记录清单。
- 人物：本人出镜即可，服装与账号日常一致。
- 字幕：每行不超过 12 字，关键词用强调色。

### SRT 口播字幕
\`\`\`srt
1
00:00:00,000 --> 00:00:03,000
如果你正在为${safeTitle}发愁，先别急着做决定。

2
00:00:03,000 --> 00:00:10,000
很多家长的问题不是不重视，而是顺序错了。

3
00:00:10,000 --> 00:00:22,000
先看孩子的真实场景，再看课程配置；先算一周用几次，再算单次成本。

4
00:00:22,000 --> 00:00:33,000
把需求分成必须解决和可以妥协，超过三个必须项，说明还没想清楚。

5
00:00:33,000 --> 00:00:42,000
先用最小成本体验一次，记录卡点，再决定要不要报长期班。

6
00:00:42,000 --> 00:00:45,000
把你最卡的点发在评论区，我按你的情况给判断。
\`\`\`
${referenceNote}
> 演示模式生成。${clean(brief) ? `补充需求：${clean(brief)}` : '发布前请替换成你的真实课程细节与案例。'}`;
}

function srtTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  let secs = Math.floor(s % 60);
  let millis = Math.round((s - Math.floor(s)) * 1000);
  if (millis >= 1000) { secs += 1; millis -= 1000; }
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(hours)}:${p(minutes)}:${p(secs)},${p(millis, 3)}`;
}

/** 从脚本里抽 SRT；没有 srt 代码块时，按分镜表/普通句子生成。 */
export function buildSrt(script) {
  const source = String(script || '');
  const block = source.match(/```srt\s*([\s\S]*?)```/i);
  if (block) return block[1].trim() + '\n';
  const lines = source.split('\n').map((line) => line.trim()).filter((line) => {
    if (!line || line.startsWith('#') || line.startsWith('>')) return false;
    if (/^[-|: ]+$/.test(line)) return false;
    return true;
  }).map((line) => {
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()).filter(Boolean);
    const text = (cells[cells.length - 1] || line).replace(/[*_`]/g, '').trim();
    return text;
  }).filter((line) => line.length >= 4);
  const texts = lines.length ? lines : ['（请先在项目里生成或编辑口播脚本）'];
  let cursor = 0;
  return texts.map((text, index) => {
    const duration = Math.min(6, Math.max(2.5, text.length / 5));
    const cue = `${index + 1}\n${srtTime(cursor)} --> ${srtTime(cursor + duration)}\n${text}\n`;
    cursor += duration;
    return cue;
  }).join('\n');
}

/* ───────────── 引导式创作工作流（今日选题 / 爆款复刻 / 热点结合，2026-10-24 二期+） ─────────────
 * 交互链路参考原版 XiaoLingDang 的会话状态机（creative-sessions / viral-recreations / hotspot-combinations）：
 * 分阶段出候选 → 机构选择 → 进入下一阶段；文案阶段一次出 3 个版本，可整批重生成。
 * 合规口径与原版一致：爆款复刻只学习传播机制，不复用原钩子、原案例、原画面或原音频。 */

export function memoriesBlock(memories = []) {
  if (!memories.length) return '';
  const lines = memories.slice(0, 12).map((item, index) => `${index + 1}. ${String(item.content || '').slice(0, 300)}`);
  return `【长期记忆（机构确认过的事实与偏好，回答时遵循）】\n${lines.join('\n')}`;
}

export const COPY_STYLES = ['口语化', '专业理性', '故事感', '犀利反常识'];

export const HOTSPOT_ANGLES = [
  ['热点做引子', '先用热点把注意力拉进来，再自然转回账号自己的观点和问题。'],
  ['热点做论据', '把热点作为一个现实证据，用来支撑账号要表达的核心观点。'],
  ['热点做趋势信号', '把热点视为正在发生的趋势信号，解释它对受众意味着什么。'],
  ['热点做反例', '借热点指出一个常见误区或反面现象，再给出账号自己的判断。'],
  ['热点做冲突', '把热点与另一种现实放在一起形成反差或冲突，推动观点展开。'],
  ['热点做案例', '把热点作为一个现实案例，再提炼可迁移的方法或结论。'],
  ['热点做类比', '把热点中的逻辑类比到账号自己的领域，让复杂观点更容易理解。'],
];

export const VIRAL_STRENGTHS = [
  { id: 'low', label: '低强度', detail: '只借鉴选题机制，结构与表达全部重建。' },
  { id: 'medium', label: '中强度', detail: '借鉴冲突与信息递进，换主题、证据、表达与镜头。' },
  { id: 'high', label: '高强度', detail: '尽量保留传播机制和节奏，但不复用原句、原素材或一一对应镜头。' },
];

const JSON_ONLY = '只输出一个 JSON 数组，不要输出任何解释、前言或代码围栏。';

export function buildTodayIdeasPrompt({ profile, orgProfile, goal, chunks }) {
  return `【任务】为这个内容账号生成 3 个今天就能拍的选题候选。

【机构画像】
${orgProfile || '（未填写）'}

【内容账号档案】
${workbenchProfileBlock(profile)}

【机构资料库相关原文】
${chunkBlock(chunks)}

【本次方向】${clean(goal) || '不限，优先结合本月招生节点和账号当前目标'}

【每个候选包含】title（选题标题，20 字内）、hook（开头 3 秒怎么说，60 字内）、why（为什么今天适合这个账号发，80 字内）。

${JSON_ONLY}
格式：[{"title":"…","hook":"…","why":"…"}]，正好 3 个对象。`;
}

export function buildViralRewritePrompt({ profile, orgProfile, sourceText, strength }) {
  const rule = { low: '低强度：只借鉴选题机制，结构与表达全部重建。', medium: '中强度：借鉴冲突与信息递进，换主题、证据、表达与镜头。', high: '高强度：尽量保留传播机制和节奏，但不复用原句、原素材或一一对应镜头。' }[strength] || '';
  return `【任务】参考下面这条爆款原文，为这个内容账号产出 3 个合规的改写版本。

【铁律】只学习传播机制，不复用原钩子、原案例、原画面或原音频；不出现「保证」「第一」「最」等绝对化用语；不承诺流量、收益、提分或效果。
【改造强度】${rule}

【爆款原文（只作机制参考）】
${String(sourceText || '').slice(0, 3000)}

【机构画像】
${orgProfile || '（未填写）'}

【内容账号档案】
${workbenchProfileBlock(profile)}

【每个版本包含】title（标题，20 字内）、content（完整口播，180-320 字，符合铁律与强度）。

${JSON_ONLY}
格式：[{"title":"…","content":"…"}]，正好 3 个对象。`;
}

export function buildHotspotCopyPrompt({ profile, orgProfile, hotspot, angle, style }) {
  const angleRule = HOTSPOT_ANGLES.find((item) => item[0] === angle);
  return `【任务】把下面的热点事实转化为这个内容账号的 3 个口播版本。

【热点事实（只能引用这里写的事实，不要编造细节）】
标题：${clean(hotspot?.title)}
事实：${clean(hotspot?.fact)}
来源：${clean(hotspot?.sourceUrl) || '（未提供）'}

【结合方式】${angle}${angleRule ? `——${angleRule[1]}` : ''}
【表达风格】${style || '口语化'}

【机构画像】
${orgProfile || '（未填写）'}

【内容账号档案】
${workbenchProfileBlock(profile)}

【每个版本包含】title（标题，20 字内）、content（完整口播，180-320 字；热点只做引子/证据，主体回到账号自己的观点和课程场景；不承诺效果）。

${JSON_ONLY}
格式：[{"title":"…","content":"…"}]，正好 3 个对象。`;
}

export function demoIdeas(profile, goal) {
  const subject = subjectOf(profile);
  return [
    { title: `${subject}体验课的一天`, hook: '你以为的体验课和真实的体验课，差的不止一点。', why: '贴合账号当前「预约到店体验」的目标，可拍素材都在机构里。' },
    { title: '三种孩子三种安排', hook: '同样一门课，三种孩子要三种上法。', why: '家长最关心“适不适合我家孩子”，分类内容天然好懂好转发。' },
    { title: '别急着报长期班', hook: '先做完这一个小测试，再决定花不花这个钱。', why: '反常识角度利于停留，收尾可自然引导体验课。' },
  ].map((item) => ({ ...item, demo: true, ...(clean(goal) ? { note: `方向：${clean(goal)}` } : {}) }));
}

export function demoViralRewrites(profile, sourceText, strength) {
  const subject = subjectOf(profile);
  const audience = audienceOf(profile);
  const base = [
    { title: '换个行业同样成立', content: `这条视频的机制其实很简单：先抛一个大家都有的焦虑，再给一个反常识判断，最后落到一个低门槛动作。我把同样的机制搬到${subject}上：很多${audience}的焦虑是“现在开始晚不晚”，反常识判断是“晚不晚取决于怎么开始”，低门槛动作就是先来一次体验，用真实课堂代替想象做决定。` },
    { title: '同一个结构，换一组证据', content: `它的节奏是三段式：现象、冲突、办法。换成我们的场景——现象是家长群里的攀比式报班；冲突是“报得多的孩子未必学得好”；办法是按孩子的专注时长选班型，先体验再决定。整套逻辑与原视频相同，但案例、数据和表达全部换成我们自己的。` },
    { title: '留节奏，换血肉', content: `保留它“提问—否定—再提问”的推进节奏，内容完全重建：开头问“你给孩子报班前做功课吗”，中段否定“看价格做功课”这个惯性，结尾问“那该看什么”，答案是对话一次、旁听一节、对比一周再决定。` },
  ];
  return base.map((item) => ({ ...item, demo: true, strength: strength || '' }));
}

export function demoHotspotCopies(profile, hotspot, angle, style) {
  const subject = subjectOf(profile);
  const audience = audienceOf(profile);
  const title = clean(hotspot?.title) || '近期热点';
  const fact = clean(hotspot?.fact) || '（机构提供的热点事实）';
  return [
    { title: `从${title}聊起`, content: `最近大家都在讨论「${title}」。${fact} 这件事对${audience}的启发是：信息越多的时代，越需要有人帮你做判断。选${subject}也一样——不看谁声音大，看谁把方法讲清楚。我平时怎么帮家长判断，评论区聊。`, angle, style },
    { title: `${title}背后的选择逻辑`, content: `「${title}」刷屏的时候，我想提醒${audience}一件事：热闹是别人的，决策是自己的。把它当成一面镜子——你会怎么给孩子选${subject}？我给三个不花钱的判断动作，看完再用。`, angle, style },
    { title: `别只看${title}的热闹`, content: `${fact} 很多人看完就划走了，但${audience}可以多想一层：这类事情发生时，最该守住的是自己的节奏。报班、续费、换机构，都一样——先确认自己的目标没被带偏。守住节奏的具体做法，这条讲清楚。`, angle, style },
  ].map((item) => ({ ...item, demo: true }));
}

/* ───────────── 热点自动搜索（DeepSeek Search API，2026-10-24 三期+） ─────────────
 * 官方文档：POST https://api.deepseek.com/v1/tools/search，Bearer 同一把 Key，
 * 按成功请求计费（5 元/千次，空结果不计费）。搜索结果喂给 TEXT 模型，
 * 按账号相关性挑 3 条并给出结合方式建议 —— 对齐原版 hotspot-combinations 的链路。 */

export function buildHotspotPickPrompt({ profile, orgProfile, keyword, results }) {
  const list = (results || []).slice(0, 8).map((item, index) => `〔${index + 1}〕${item.title}\n来源：${item.siteName || ''} ${item.url || ''}\n日期：${item.date || '未知'}\n摘要：${String(item.summary || item.snippet || '').slice(0, 400)}`).join('\n\n');
  return `【任务】从下面的搜索结果里，为这个内容账号挑出 3 条「最近、真实、和它的受众有关」的热点。

【机构画像】
${orgProfile || '（未填写）'}

【内容账号档案】
${workbenchProfileBlock(profile)}

【搜索关键词】${clean(keyword)}

【搜索结果（只用这里的事实，不得编造）】
${list || '（无结果）'}

【每条输出】id（"h1"/"h2"/"h3"）、title（热点标题）、fact（1-3 句事实，只能来自上面摘要）、sourceUrl、source（来源媒体名）、publishedAt（原文日期，没有就空串）、relation（一句话：为什么和这个账号的受众有关）、recommendedAngle（从这七个里选一个：${HOTSPOT_ANGLES.map((item) => item[0]).join('、')}）。

${JSON_ONLY}
格式：[{"id":"h1","title":"…","fact":"…","sourceUrl":"…","source":"…","publishedAt":"…","relation":"…","recommendedAngle":"…"}]，正好 3 个；不够 3 条真实相关的就少给，禁止凑数。`;
}

export function demoPickedHotspots(keyword) {
  return [
    { id: 'h1', title: `「${clean(keyword) || '教育'}」相关报道一`, fact: '（演示样本）搜索渠道未配置或未返回结果时展示；上线后这里会是 DeepSeek 搜索到的真实新闻。', sourceUrl: '', source: '演示', publishedAt: '', relation: '与账号受众的关注点相关。', recommendedAngle: '热点做引子' },
    { id: 'h2', title: `「${clean(keyword) || '教育'}」相关报道二`, fact: '（演示样本）', sourceUrl: '', source: '演示', publishedAt: '', relation: '可作为近期内容的话题引子。', recommendedAngle: '热点做论据' },
    { id: 'h3', title: `「${clean(keyword) || '教育'}」相关报道三`, fact: '（演示样本）', sourceUrl: '', source: '演示', publishedAt: '', relation: '可支撑账号的核心观点。', recommendedAngle: '热点做趋势信号' },
  ];
}

/* ───────────── 六期：对齐原版交互逻辑（2026-10-25） ───────────── */

/** 爆款复刻·单版本生成（流式预览用：一次一个版本，完成即推送）。首个版本同时产出复刻蓝图。 */
export function buildViralOnePrompt({ profile, orgProfile, sourceText, strength, index }) {
  const rule = { low: '低强度：只借鉴选题机制，结构与表达全部重建。', medium: '中强度：借鉴冲突与信息递进，换主题、证据、表达与镜头。', high: '高强度：尽量保留传播机制和节奏，但不复用原句、原素材或一一对应镜头。' }[strength] || '';
  const indexRule = index === 1
    ? '第 1 个版本走「最稳」的改写：结构清晰、信息密度高。'
    : index === 2
      ? '第 2 个版本换一个切入角度（与第 1 个明显不同）。'
      : '第 3 个版本走最大胆的改写：反转或反常识开场。';
  return `【任务】参考下面这条爆款原文，为这个内容账号产出第 ${index} 个合规改写版本。${indexRule}

【铁律】只学习传播机制，不复用原钩子、原案例、原画面或原音频；不出现「保证」「第一」「最」等绝对化用语；不承诺流量、收益、提分或效果。
【改造强度】${rule}

【爆款原文（只作机制参考）】
${String(sourceText || '').slice(0, 3000)}

【机构画像】
${orgProfile || '（未填写）'}

【内容账号档案】
${workbenchProfileBlock(profile)}

【输出】${index === 1 ? `只输出一个 JSON 对象（蓝图与版本合一，不要拆成两个）：{"blueprint":{"hook":"这条爆款的开头机制（一句话）","progression":["信息推进1","信息推进2"],"turn":"转折（一句话）","closing":"收束（一句话）"},"title":"标题（20字内）","content":"完整口播（180-320 字，符合铁律与强度）"}` : `只输出一个 JSON 对象：{"title":"标题（20字内）","content":"完整口播（180-320 字，符合铁律与强度）"}`}。不要输出任何其他文字或代码围栏。`;
}

export function demoViralOne(profile, sourceText, strength, index) {
  const base = demoViralRewrites(profile, sourceText, strength);
  const item = base[(index - 1) % base.length];
  return index === 1
    ? { blueprint: { hook: '用一个反常识判断打断划走', progression: ['现象：家长的普遍焦虑', '冲突：报得多的孩子未必学得好'], turn: '把决定权从价格转回需求', closing: '给出一个低门槛动作' }, ...item }
    : item;
}

/** 文案大脑蒸馏：从带时间码的转写档案提炼方法档案。 */
export function buildBrainDistillPrompt({ name, transcripts }) {
  const corpus = transcripts.map((item, index) => {
    const lines = (item.segments || []).slice(0, 80).map((segment) => `[${Number(segment.start).toFixed(1)}-${Number(segment.end).toFixed(1)}秒] ${segment.text}`).join('\n');
    return `〔作品${index + 1}〕${item.title || '未命名'}\n${lines || item.text}`;
  }).join('\n\n');
  return `【任务】下面是创作者「${clean(name)}」的多条作品口播（带时间码）。请像原版「文案大脑」一样，把「创作者明确讲授的方法」和「作品里反复出现的写作习惯」分开提炼，再合成「可用于他人创作的综合规则」。只依据语料，不编造；每条结论都要给出语料里的时间码证据。

【语料】
${corpus.slice(0, 24000)}

【只输出一个 JSON 对象】
{"profile":{"thinking_framework":"选题/思考框架（80字内）","topic_approach":"切入话题的习惯（80字内）","tone":"语言风格（60字内）"},
"teaching_methods":[{"title":"方法名","method":"具体做法","applicability":"适用场景","evidence":[{"start":3.2,"end":9.0,"quote":"原文片段"}]}],
"writing_patterns":[{"title":"写作习惯名","pattern":"具体写法","evidence":[{"start":10.0,"end":15.5,"quote":"原文片段"}]}],
"combined_rules":["可直接借用的综合规则1","规则2","规则3","规则4","规则5"]}
teaching_methods 2-5 条、writing_patterns 2-5 条、combined_rules 3-6 条。${JSON_ONLY.replace('数组', '对象')}`;
}

export function demoBrain(name) {
  return {
    profile: { thinking_framework: '（演示样本）先立一个家长普遍的焦虑，再给反常识判断，落到低门槛动作。', topic_approach: '从家长群里最近吵的话题切入。', tone: '口语、短句、有停顿' },
    teaching_methods: [
      { title: '三段式口播', method: '现象→冲突→办法，每段不超过三句。', applicability: '知识类口播', evidence: [{ start: 0, end: 8, quote: '（演示样本）很多家长问我……' }] },
      { title: '数字锚点', method: '用具体数字代替形容词。', applicability: '证明类内容', evidence: [{ start: 12, end: 18, quote: '（演示样本）3000 个家长里……' }] },
    ],
    writing_patterns: [
      { title: '开头抛问', pattern: '第一句永远是问句或否定句。', evidence: [{ start: 0, end: 3, quote: '（演示样本）你别再……' }] },
    ],
    combined_rules: ['开头 3 秒必须打断划走', '证据用数字不用形容词', '收尾给一个不花钱的动作', '一条只讲一个判断'],
  };
}

/** 同行研究简报（同行观察页）。 */
export function buildPeerReportPrompt({ name, transcripts }) {
  const corpus = transcripts.map((item, index) => `〔作品${index + 1}〕${item.title || '未命名'}\n${String(item.text || '').slice(0, 1500)}`).join('\n\n');
  return `【任务】为同行账号「${clean(name)}」生成一份研究简报：总结它的内容结构、表达特点与值得学习的共同优点，供我方账号借鉴（拆结构，不抄内容）。

【语料（已转写口播）】
${corpus.slice(0, 20000)}

【只输出一个 JSON 对象】
{"profile":{"positioning":"账号定位一句话","cadence":"选题节奏特点","tone":"表达风格"},
"sections":[{"title":"内容结构","content":"……"},{"title":"表达特点","content":"……"},{"title":"值得学习的共同优点","content":"……"},{"title":"对我方的启发","content":"……"}]}
4 个 sections 都要写，每个 80-150 字。${JSON_ONLY.replace('数组', '对象')}`;
}

export function demoPeerReport(name) {
  return {
    profile: { positioning: '（演示样本）面向家长的美术教育口播号', cadence: '每周 3-4 条，固定栏目化', tone: '亲切、短句、多举例' },
    sections: [
      { title: '内容结构', content: '（演示样本）开头抛焦虑，中间一个真实课堂案例，结尾给一个不花钱的判断动作。' },
      { title: '表达特点', content: '（演示样本）短句为主，数字具体，几乎不用专业术语。' },
      { title: '值得学习的共同优点', content: '（演示样本）每条只讲一个判断；案例都带孩子的原话。' },
      { title: '对我方的启发', content: '（演示样本）可以把体验课的真实对话做成固定栏目。' },
    ],
  };
}

/* ───────────── 七期 · 视频完整工作台（对齐原版 video_workspace，作者本人授权复刻） ───────────── */

// 内容方向目录：与原版一致的四类 + 细分；前端、后端校验和提示词共用这一份。
export const VIDEO_TYPES = {
  ecommerce: { label: '电商带货', subtypes: [['口播带货', '真人推荐，建立购买信任'], ['促销转化', '突出优惠，推动立即下单'], ['场景种草', '植入场景，激发使用需求'], ['痛点解决', '直击痛点，展示解决效果'], ['功能演示', '演示功能，证明产品价值']] },
  local_store: { label: '同城到店', subtypes: [['门店发现', '突出特色，制造到店理由'], ['到店实录', '真实体验，建立消费信任'], ['招牌体验', '聚焦招牌，证明门店价值'], ['同城团购', '突出优惠，推动到店核销']] },
  brand: { label: '品牌广告', subtypes: [['品牌主张', '传递理念，建立价值认同'], ['品牌故事', '讲述故事，强化品牌信任'], ['生活方式', '塑造场景，建立品牌向往'], ['创意概念', '创意表达，强化品牌记忆']] },
  drama: { label: '剧情短片', subtypes: [['对话短剧', '人物冲突，推动剧情发展'], ['反转短剧', '剧情反转，制造传播记忆'], ['悬念短剧', '设置悬念，持续吸引观看'], ['情绪短片', '情绪共鸣，强化内容感染'], ['产品植入', '融入剧情，自然传递价值']] },
};

// 开场方式（钩子策略）：与原版一致的七种。
export const VIDEO_HOOKS = [
  ['auto', '由素材推荐开场', '根据素材与类型确定最合适的第一击'],
  ['pain_point', '直击产品核心痛点', '先让观众看到问题，再给出解法'],
  ['novel_scene', '利用新奇场景开场', '先用反常或新鲜画面建立好奇'],
  ['emotional_reversal', '制造强烈情绪反转', '先建立预期，再给出反差'],
  ['contrarian', '用反常识观点开场', '用一句不同判断抓住注意力'],
  ['real_need', '真实痛点引出需求', '从真实生活困扰自然带出产品'],
  ['strong_contrast', '强烈对比突出差异', '用前后或新旧对比证明价值'],
];

export function videoTypeLabel(type) {
  return VIDEO_TYPES[type]?.label || '视频生成';
}
export function videoHookLabel(value) {
  const found = VIDEO_HOOKS.find(([key]) => key === value);
  return found ? found[1] : '由素材推荐开场';
}
function videoSubtypeName(type, subtype) {
  const found = (VIDEO_TYPES[type]?.subtypes || []).find(([name]) => name === subtype);
  return found ? found[0] : subtype;
}

// 编导稿（director spec）：结构化分镜 JSON，可逐镜编辑后确认渲染。
// ⚠️ 提示词要求 JSON 时只许一个对象（蓝图那次的教训：两个 JSON 会被宽松解析丢数据）。
export function buildDirectorScriptPrompt({ profile, orgProfile, mode, type, subtype, hookStrategy, brief, assets, duration, ratio, reference }) {
  const assetBlock = (assets || []).length
    ? (assets || []).map((item, index) => `- @${item.role}${index + 1}（${item.label || item.fileName || item.assetId}）：${item.notes || item.summary || '按素材内容使用'}`).join('\n')
    : '无（纯口播/生成画面）';
  return `你是短视频编导。根据机构档案、素材和需求，输出一份结构化编导稿（JSON），用于逐镜生成视频。

【创作模式】${mode === 'replicate' ? '复刻模式（参考既有内容结构，替换为本机构产品）' : '生成模式（从需求开始创作）'}
【内容方向】${videoTypeLabel(type)} · ${videoSubtypeName(type, subtype)}
【开场方式】${videoHookLabel(hookStrategy)}
【成片时长】约 ${duration} 秒，画幅 ${ratio || '9:16'}
【补充需求】${brief || '无'}
【参考内容】${reference || '无'}
【可用素材（引用格式 @角色N）】
${assetBlock}
【机构画像】
${orgProfile || '未填写'}
【内容账号档案】
${workbenchProfileBlock(profile)}

输出要求：只输出一个 JSON 对象，不要 markdown 代码块，不要解释。结构：
{"title":"视频标题（20字内）","strategy":"一句话策略","shots":[{"index":1,"seconds":5,"role":"hook","scene":"画面描述（人物/场景/镜头运动）","voiceover":"口播台词（口语短句）","overlay":"字幕或花字（可空）","renderPrompt":"给视频模型的画面提示词，包含场景、人物、动作、镜头语言，不含口播文字"}],"notes":"拍摄备注（可空）"}

规则：
- shots 总秒数必须等于 ${duration}；每镜 3-15 秒；整条 3-6 镜。
- role 只能取：hook（开场钩子）、pain（痛点）、proof（证明/展示）、turn（转折）、cta（行动引导）。
- 第一镜必须执行「${videoHookLabel(hookStrategy)}」。
- 引用了素材就在对应镜的 scene/renderPrompt 里用 @人物1/@场景1/@音色1 指明用途；没引用的素材不要编造。
- renderPrompt 要具体到可直接生成画面；voiceover 总字数与总秒数匹配（每秒约 4 字）。
- 不承诺效果，不使用绝对化用语。`;
}

// 演示编导稿：模型未接入/返回空时兜底，保证链路可走通。
export function demoDirectorScript({ profile, type, subtype, duration = 15, brief = '' }) {
  const subject = subjectOf(profile);
  const audience = audienceOf(profile);
  const safeDuration = Number(duration) || 15;
  const per = Math.max(3, Math.round(safeDuration / 3));
  const topic = clean(brief).slice(0, 40) || `${videoTypeLabel(type)} · ${subtype || '口播带货'}`;
  return JSON.stringify({
    title: `${subject}：${topic}`,
    strategy: `用一个具体误区开场，让${audience}对号入座，再给一个今天就能做的动作。`,
    shots: [
      { index: 1, seconds: per, role: 'hook', scene: '人物近景看镜头，教室背景，镜头缓推。', voiceover: `很多${audience}在选${subject}时，第一步就做反了。`, overlay: '先别急着做决定', renderPrompt: `竖屏近景，一位温和的老师在明亮的教室里直视镜头说话，镜头缓慢推近，光线柔和，${topic}氛围。` },
      { index: 2, seconds: per, role: 'pain', scene: '切到家长纠结翻资料的画面，再切回老师。', voiceover: `不是看得越多越好，而是先搞清楚孩子现在缺什么。`, overlay: '', renderPrompt: `竖屏中景，书桌上摊着资料，一只手在犹豫地翻页，随后切回教室老师讲话，节奏平稳。` },
      { index: 3, seconds: Math.max(3, safeDuration - per * 2), role: 'cta', scene: '老师拿起一页示例讲解，字幕出现行动引导。', voiceover: `先做一次现状评估，再决定要不要报，评论区可以领评估表。`, overlay: '评论区领评估表', renderPrompt: `竖屏近景，老师拿起一页打印的评估表对着镜头展示，微笑，结尾定格，画面干净。` },
    ],
    notes: '（演示编导稿）模型未返回正文时兜底生成，确认前可逐镜修改。',
  }, null, 2);
}

/* ───────────── 八期 · 内容计划/周期日历（对齐原版 content-cycles，作者本人授权复刻） ───────────── */

export const CYCLE_PURPOSES = ['涨粉', '互动', '种草', '转化', '建立信任'];

// 周期计划提示词：一次排好 N 天的轻量选题卡（类型/选题/目的/推荐理由）。
// ⚠️ 只输出一个 JSON 对象（蓝图/编导稿同一条教训）。
export function buildCyclePlanPrompt({ profile, orgProfile, brief, count, requirements = '', referenceTopics = [] }) {
  const referenceBlock = (referenceTopics || []).length
    ? `\n【同账号已有选题（避免重复，可延续系列）】\n${(referenceTopics || []).map((topic, index) => `${index + 1}. ${topic}`).join('\n')}`
    : '';
  return `你是内容运营策划。为这家机构排一份周期内容计划：每天发什么、讲什么、为什么这么排。

【机构画像】
${orgProfile || '未填写'}
【内容账号档案】
${workbenchProfileBlock(profile)}
【计划条数】${count} 条（对应 ${count} 天，每天一条）
【方向要求】${brief || '结合账号定位自动安排'}
${requirements ? `【调整要求（用户对上一版计划提出）】\n${requirements}\n` : ''}${referenceBlock}
输出要求：只输出一个 JSON 对象，不要 markdown 代码块，不要解释。结构：
{"period":"周期描述（例如：10-25 ～ 10-31 · 7 条）","distribution":{"口播带货":3,"知识科普":2,"剧情短片":2},"notice":"一句话说明这份计划的整体思路","slots":[{"day":"第 1 天","content_type":"口播带货","topic":"选题一句话（具体到能直接开拍）","purpose":"涨粉","recommendation_reason":"为什么这天发这条（结合节奏/节点/账号成长阶段）"}]}

规则：
- slots 数量必须等于 ${count}；day 按「第 1 天」「第 2 天」…顺序排。
- content_type 从这些里选：口播带货、知识科普、剧情短片、热点结合、学员案例、幕后日常、促销活动。
- purpose 只能取：${CYCLE_PURPOSES.join('、')}。
- 选题要具体（有场景/有冲突/有数字），不要「介绍我们的课程」这种空题。
- 节奏要有起伏：钩子/痛点类穿插案例与促销，不要连着三天同类。`;
}

// 演示周期计划：mock/空回执兜底。
export function demoCyclePlan({ profile, count = 7, brief = '' }) {
  const subject = subjectOf(profile);
  const audience = audienceOf(profile);
  const safeCount = clampCount(count);
  const typePool = ['口播带货', '知识科普', '剧情短片', '学员案例', '促销活动'];
  const purposePool = ['涨粉', '互动', '种草', '转化', '建立信任'];
  const topicPool = [
    `${audience}最容易踩的 3 个坑，第 2 个几乎人人中招`,
    `为什么有人学完没效果？差别在第一步`,
    `一节课的真实课堂记录（无剪辑）`,
    `学员 30 天前后对比，变化最大的不是成绩`,
    `${subject}到底适合什么样的孩子？一条视频说清`,
    `家长问我最多的问题，今天一次答完`,
    `这周报名的注意事项（名额与时间）`,
  ];
  const slots = Array.from({ length: safeCount }, (_, index) => ({
    day: `第 ${index + 1} 天`,
    content_type: typePool[index % typePool.length],
    topic: topicPool[index % topicPool.length],
    purpose: purposePool[index % purposePool.length],
    recommendation_reason: `（演示计划）第 ${index + 1} 条用来${purposePool[index % purposePool.length]}，按节奏穿插类型避免连续同质。`,
  }));
  return JSON.stringify({
    period: `本周期 · ${safeCount} 条（演示）`,
    distribution: slots.reduce((acc, slot) => { acc[slot.content_type] = (acc[slot.content_type] || 0) + 1; return acc; }, {}),
    notice: `（演示周期计划）围绕「${clean(brief) || subject}」排了 ${safeCount} 条，类型交替保持账号节奏。`,
    slots,
  }, null, 2);
}

function clampCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 7;
  return Math.min(10, Math.max(4, Math.round(n)));
}

// 单槽位重新生成：保持 day 与内容类型不变（除非明确换类型），只换选题与理由。
export function buildCycleSlotPrompt({ profile, orgProfile, slot, siblingTopics = [], brief = '' }) {
  return `你是内容运营策划。为下面这一天重新想一个选题（替换掉原来那条）。

【机构画像】
${orgProfile || '未填写'}
【内容账号档案】
${workbenchProfileBlock(profile)}
【这一天】${slot?.day || '当天'} · 内容类型：${slot?.content_type || '不限'}
【同周期其他选题（不要重复）】
${(siblingTopics || []).map((topic, index) => `${index + 1}. ${topic}`).join('\n') || '无'}
【计划方向】${brief || '结合账号定位'}

输出要求：只输出一个 JSON 对象，不要 markdown 代码块。结构：
{"content_type":"${slot?.content_type || '口播带货'}","topic":"选题一句话（具体到能直接开拍）","purpose":"涨粉","recommendation_reason":"为什么这天发这条"}

规则：purpose 只能取 ${CYCLE_PURPOSES.join('、')}；选题要具体（有场景/有冲突/有数字）。`;
}

export function demoCycleSlot({ slot }) {
  const seed = String(slot?.day || '').length + String(slot?.content_type || '').length;
  const topics = [
    '家长群里吵翻的一个选择，你怎么看？',
    '同样听课两个月，为什么效果差三倍？',
    '我们把课堂全程拍了下来，你看完再决定',
    '报名前一定要问的 3 个问题（不是推销）',
    '这个细节暴露了孩子适不适合学',
    '别再问「几岁开始合适」了，先看这件事',
  ];
  return JSON.stringify({
    content_type: slot?.content_type || '口播带货',
    topic: topics[seed % topics.length],
    purpose: CYCLE_PURPOSES[seed % CYCLE_PURPOSES.length],
    recommendation_reason: '（演示）替换后的选题与前文不重复，节奏上承接前一天的类型。',
  }, null, 2);
}

/* ───────────── 九期 · 数据复盘洞察（基于五期截图回填的发布数据） ───────────── */

export function buildReviewsInsightPrompt({ profile, orgProfile, published }) {
  const rows = (published || []).map((item, index) => {
    const stats = item.stats || {};
    const pick = (key) => (Number.isFinite(Number(stats[key])) ? Number(stats[key]) : '—');
    return `${index + 1}. 主题：${item.topic}（风格：${item.style || '—'}；发布：${stats.publishedAt || '—'}）→ 播放 ${pick('plays')}，赞 ${pick('likes')}，评 ${pick('comments')}，转 ${pick('shares')}，藏 ${pick('saves')}`;
  }).join('\n');
  return `你是内容数据分析师。基于这家机构自己回填的发布数据，做一次复盘：哪些内容跑得好、为什么、下一周期怎么调。

【机构画像】
${orgProfile || '未填写'}
【内容账号档案】
${workbenchProfileBlock(profile)}
【已回填的发布数据（${(published || []).length} 条）】
${rows}

输出 Markdown（不要代码块，直接正文）：
## 一句话总结
（整体表现与最突出的信号）
## 跑得好的内容
（点名 2-3 条，说清共同特征：主题/钩子/类型/发布节奏）
## 表现平平的内容
（共同问题，对事不对人）
## 下一周期建议
（3 条以内，具体到选题方向和类型配比，能直接执行）

规则：只基于上面给出的数字下结论，数字不足就明说「样本还太少」；不承诺效果，不使用绝对化用语。`;
}

export function demoReviewsInsight({ published = [] } = {}) {
  const count = (published || []).length;
  return `## 一句话总结
（演示洞察）已回填 ${count} 条数据；样本${count >= 5 ? '初步够看趋势' : '还太少，先多回填几条再下结论'}。

## 跑得好的内容
（演示）主题具体、带真实场景的条目通常数据更好；建议把表现最好的 2 条的钩子结构记下来复用。

## 表现平平的内容
（演示）主题偏「介绍我们」而不是「对号入座」的条目普遍偏弱。

## 下一周期建议
1. 把下一周期里表现最好的类型配比调高一档。
2. 选题继续「具体冲突 + 真实场景」，避免空泛介绍。
3. 每条发布后 48 小时内回填截图，让下轮复盘有据可依。`;
}

/* ───────────── 十期 · 素材视觉分析（素材分析队列） ───────────── */

export function buildAssetAnalysisPrompt({ fileName, folder }) {
  return `这是一张教培机构素材库里的图片（文件名：${fileName || '未命名'}${folder ? `，文件夹：${folder}` : ''}）。分析它的画面内容与复用价值。

只输出一个 JSON 对象，不要 markdown 代码块：
{"description":"一句话描述画面（人物/场景/在做什么）","tags":["3-6个中文标签"],"reusable":true或false,"usableAs":"人物/场景/道具/背景/无","note":"复用建议或风险（如含人脸需授权、画面模糊等），一句话"}

规则：reusable=画面清晰、主体明确、可在后续视频制作中作为参考或素材；usableAs 选最合适的一个职责，没有就填"无"。`;
}

export function demoAssetAnalysis({ fileName = '素材' } = {}) {
  return JSON.stringify({
    description: `（演示分析）${fileName}：一张素材图片，画面主体清晰。`,
    tags: ['演示', '素材', '待人工复核'],
    reusable: true,
    usableAs: '场景',
    note: '（演示分析）模型未接入时的兜底结果，建议人工确认后再用。',
  }, null, 2);
}
