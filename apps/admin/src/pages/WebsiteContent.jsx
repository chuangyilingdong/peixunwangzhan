import { useAdminConfirm } from '../components/AdminConfirm.jsx';
import { readSession, errorText } from '@platform/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, ErrorState, HOME_STEPS_DEFAULT, HOME_COMPARE_DEFAULT, HOME_BRANDS_DEFAULT, HOME_BRANDS_SAMPLE, HOME_VIDEOS_DEFAULT, HANDBOOK_POLICY_DEFAULT, HANDBOOK_SKILLS_DEFAULT, formatDate, Loading, Notice, PageHeader, Panel, useData } from '@platform/shared';
import { WEBSITE_CONTENT_LABELS } from '../shared.jsx';

export function parseWebsiteDraft(value) {
  try { const result = JSON.parse(value); return result && typeof result === 'object' && !Array.isArray(result) ? result : null; } catch { return null; }
}

/** 草稿预览里图片的统一内联样式（原来这串在好几处重复写）。 */
const PREVIEW_IMAGE_STYLE = { display: 'block', maxWidth: '100%', marginTop: '8px', borderRadius: '8px' };

export function WebsitePreview({ content, selectedKey }) {
  if (!content) return <div className="cms-preview-empty">保存或修正 JSON 后可预览。</div>;
  if (selectedKey === 'HOME') return <div className="cms-preview-home"><span className="cms-preview-kicker">{content.heroKicker || '首页眉题'}</span><h3>{content.heroTitle || '首页标题'} <em>{content.heroAccent || '强调标题'}</em></h3><p>{content.heroDescription || '首页描述'}</p><div className="cms-preview-trust"><strong>{content.trustTitle || '信任区标题'}</strong><span>{content.trustDescription || '信任区描述'}</span></div>{content.coverImageUrl ? <img src={content.coverImageUrl} alt="首页封面预览" /> : null}
    {/* 三步一栏：草稿里没有这一块时按**官网会显示什么**预览（内置默认那三条），
        所以运营看到的就是实际效果；删空则明说官网不显示这一栏。 */}
    <div className="cms-preview-trust"><strong>{content.steps?.title || HOME_STEPS_DEFAULT.title}</strong><span>{content.steps?.lead ?? HOME_STEPS_DEFAULT.lead}</span></div>
    <p>{(() => {
      const items = cmsListOf(content.steps ? content.steps.items : HOME_STEPS_DEFAULT.items);
      return items.length ? `页脚上方的三步一栏：${items.map((item) => `${item.number || ''} ${item.title || '（未填标题）'}`.trim()).join(' / ')}` : '页脚上方的三步一栏：已清空 —— 官网不显示这一栏。';
    })()}</p>
    {/* ⭐ 合作品牌（2026-10-03 用户口径）：预览按**官网的真实结果**给 ——
        一条品牌都没有（且标题/数字/评分/头像都空）时官网整屏不显示，这里就直说。 */}
    {(() => {
      const brands = content.brands && typeof content.brands === 'object' ? content.brands : HOME_BRANDS_DEFAULT;
      const logos = cmsListOf(brands.logos);
      const metricText = String(brands?.metric?.value ?? '').trim();
      const ratingText = String(brands?.rating?.score ?? '').trim();
      const filled = logos.length || String(brands.title || '').trim() || metricText || ratingText || cmsListOf(brands.avatars).length;
      if (!filled) return <div className="cms-preview-trust"><strong>合作品牌</strong><span>还是空的 —— 官网不显示这一屏（点「填入示例品牌」先看排版）。</span></div>;
      return <div className="cms-preview-trust"><strong>合作品牌</strong><span>{brands.title ? `${brands.title} · ` : ''}{metricText ? `数字 ${metricText}${brands?.metric?.suffix || ''} · ` : ''}{ratingText ? `评分 ${ratingText} · ` : ''}{logos.length ? `品牌 ${logos.length} 条：${logos.slice(0, 4).map((item) => item?.name || '（未命名）').join(' / ')}${logos.length > 4 ? ' …' : ''}` : '没有品牌（这一屏只显示标题与数字）'}</span></div>;
    })()}
  </div>;
  // 常见问题：预览按**官网的真实结果**给（顺序 = audienceOrder；某一档为空则官网不显示那一档），
  // 这样运营在保存前就能看出"这一档删空之后官网会怎样"。
  if (selectedKey === 'FAQ') {
    const order = faqAudienceOrder(content);
    const visible = order.filter((key) => cmsListOf(content[key]).length);
    return <div className="cms-preview-faq">{visible.length ? visible.map((key) => <div className="cms-preview-faq-group" key={key}><h4>{FAQ_LABELS[key]}</h4>{cmsListOf(content[key]).map((item, index) => <details key={`${key}-${index}`}><summary>{item.question || `问题 ${index + 1}`}</summary><p>{item.answer || '答案待填写'}</p></details>)}</div>) : <p>三档都没有问题 —— 官网这一页只显示标题，不会出现空的档位。</p>}</div>;
  }
  if (selectedKey === 'BRAND') return <div className="cms-preview-brand"><strong>{content.name || '品牌名称'}</strong><span>{content.tagline || '品牌标语'}</span><small>{content.contactEmail || '联系邮箱'}</small></div>;
  if (selectedKey === 'MARKETPLACE') return <div className="cms-preview-faq"><h3>{content.title || '灵动Ai学院课包展示'}</h3>{content.lead ? <p>{content.lead}</p> : null}</div>;
  // 机构手册（2026-09-19 按设计稿重做成「分区」结构）：预览按官网的真实顺序走一遍，图也一起看
  if (selectedKey === 'HANDBOOK') {
    const hero = content.hero || {};
    const about = content.about || {};
    const poster = content.poster || {};
    const work = content.work || {};
    const cards = Array.isArray(work.cards) ? work.cards : [];
    const lines = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
    return <div className="cms-preview-faq">
      <h3>{[hero.line1, hero.line2].filter(Boolean).join(' ') || '机构手册'}</h3>
      {hero.imageUrl ? <img src={hero.imageUrl} alt={hero.imageAlt || ''} style={PREVIEW_IMAGE_STYLE} /> : null}
      {lines(about.headingLines).length ? <p>{lines(about.headingLines).join(' / ')}</p> : null}
      {about.body ? <p>{about.body}</p> : null}
      {poster.imageUrl ? <details><summary>{poster.title || '海报'}</summary><img src={poster.imageUrl} alt={poster.imageAlt || ''} style={PREVIEW_IMAGE_STYLE} /></details> : null}
      <p>横滑卡片 {cards.length} 张：{cards.map((card) => card.title).filter(Boolean).join(' / ') || '（未配置）'}</p>
      {lines(work.introLines).length ? <p>卡片区大标题：{lines(work.introLines).join(' ')}</p> : null}
      {/* 政策一栏：草稿里还没有这一块时，预览也用官网那份默认值 —— 与官网页面看到的保持一致 */}
      {(() => {
        const policyCards = cmsListOf(content.policy?.cards).length ? cmsListOf(content.policy.cards) : cmsListOf(HANDBOOK_POLICY_DEFAULT.cards);
        return <p>政策地区卡 {policyCards.length} 张：{policyCards.map((card) => card.region).filter(Boolean).join(' / ') || '（未配置）'}</p>;
      })()}
      {/* 跨学科与综合能力：同样是"草稿里没有就用官网那份默认值" */}
      {(() => {
        const subjects = cmsListOf(content.skills?.subjects).length ? cmsListOf(content.skills.subjects) : cmsListOf(HANDBOOK_SKILLS_DEFAULT.subjects);
        const abilities = cmsListOf(content.skills?.abilities).length ? cmsListOf(content.skills.abilities) : cmsListOf(HANDBOOK_SKILLS_DEFAULT.abilities);
        return <p>跨学科与综合能力：{subjects.length} 个学科（{subjects.map((row) => row.subject).filter(Boolean).join(' / ') || '—'}）· {abilities.length} 项能力</p>;
      })()}
      {content.compare?.body ? <p>对比区：{content.compare.body}</p> : null}
      {content.cta?.headline ? <p>结尾行动：{content.cta.headline}</p> : null}
    </div>;
  }
  return <pre className="cms-preview-json">{JSON.stringify(content, null, 2)}</pre>;
}

const cmsListOf = (value) => (Array.isArray(value) ? value : []);
/**
 * 常见问题的三个档位（2026-09-18 晚用户口径：「最好3个选项，学生端、老师端、机构端，
 * 可以配置3个端的不同的问题」）。**字段名就是档位 key**；这里只定义**有哪三档、叫什么名字**。
 *
 * ⚠️ **顺序不在这一行**（2026-09-19 用户口径：「这 3 个标签可以在后台排序优先级，优先级高的排在最前面」）：
 *    真实顺序存在内容的 `audienceOrder` 里，由下面表单的 ↑/↓ 改；官网按它排 tab。
 *    FAQ_AUDIENCES 的排列只是**没配时的默认值**，所以改顺序**不用再改官网代码**。
 * ⚠️ 官网**只显示有内容的档位**：某一档问题删光 = 官网那一档不出现（同一条口径）。
 */
const FAQ_AUDIENCES = [['student', '学生端'], ['teacher', '老师端'], ['org', '机构端']];
const FAQ_LABELS = Object.fromEntries(FAQ_AUDIENCES);
/** 档位的实际显示顺序：CMS 的 `audienceOrder` 打头，没排到的按默认顺序补在后。
 *  **表单与预览共用这一份规则**，所以「后台看到的顺序」和「官网的顺序」不会各说各话。 */
const faqAudienceOrder = (content) => {
  const configured = cmsListOf(content?.audienceOrder).filter((key) => FAQ_LABELS[key]);
  return [...configured, ...FAQ_AUDIENCES.map(([key]) => key).filter((key) => !configured.includes(key))];
};

export function WebsiteContent({ api }) {
  const [confirm, confirmation] = useAdminConfirm();
  const navigate = useNavigate();
  const [savedDraft, setSavedDraft] = useState('');
  const [storageError, setStorageError] = useState('');
  const storageKey = (key) => `admin.cms.${readSession()?.user?.id || 'current'}.${key}`;
  function readRecovery(key) { try { return JSON.parse(sessionStorage.getItem(storageKey(key)) || 'null'); } catch { return null; } }
  function clearRecovery() { try { sessionStorage.removeItem(storageKey(selectedKey)); } catch { /* beforeunload still protects edits */ } }
  function keepDraft(text, preview) {
    setDraft(text);
    if (preview) setStructured(preview);
    try { sessionStorage.setItem(storageKey(selectedKey), JSON.stringify({ draft: text, preview: preview || structured })); setStorageError(''); }
    catch { setStorageError('浏览器无法暂存草稿，请在离开前保存或复制 JSON。'); }
  }
  const list = useData(() => api.get('admin/website-content'), [api]);
  const [selectedKey, setSelectedKey] = useState('');
  const [draft, setDraft] = useState('');
  const [structured, setStructured] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [detailState, setDetailState] = useState({ loading: false, data: null, error: null });
  const [revision, setRevision] = useState(0);
  // 图片上传中的标识（记「哪个字段在上传」），据此禁用按钮并显示进度
  const [uploading, setUploading] = useState('');
  const detail = { ...detailState, refresh: () => setRevision((value) => value + 1) };
  const dirty = draft !== savedDraft;
  const valid = Boolean(parseWebsiteDraft(draft));
  useEffect(() => {
    if (!selectedKey) return;
    let cancelled = false;
    setDetailState({ loading: true, data: null, error: null });
    api.get(`admin/website-content/${selectedKey}`).then((data) => {
      if (cancelled) return;
      const content = data.content || {};
      const original = JSON.stringify(content, null, 2);
      const recovery = readRecovery(selectedKey);
      setSavedDraft(original); setDraft(recovery?.draft ?? original);
      setStructured(parseWebsiteDraft(recovery?.draft) || recovery?.preview || content);
      setAdvancedOpen(Boolean(recovery));
      setDetailState({ loading: false, data, error: null });
    }).catch((error) => { if (!cancelled) setDetailState({ loading: false, data: null, error }); });
    return () => { cancelled = true; };
  }, [api, selectedKey, revision]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const intercept = (event) => {
      const link = event.target.closest?.('a[href]');
      if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || link.target === '_blank') return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      event.preventDefault(); event.stopPropagation();
      confirm({ title: '离开内容编辑', message: '当前改动尚未保存到服务器。草稿会保留在当前标签页，返回时恢复。是否继续离开？', confirmLabel: '保留并离开' }).then((accepted) => {
        if (accepted) navigate(url.pathname.replace(/^\/admin(?=\/|$)/, '') + url.search + url.hash);
      });
    };
    document.addEventListener('click', intercept, true);
    return () => document.removeEventListener('click', intercept, true);
  }, [dirty, navigate, confirm]);
  async function selectContent(key) {
    if (key === selectedKey || busy) return;
    if (dirty && !await confirm({ title: '切换内容区块', message: '当前改动尚未保存到服务器。草稿会暂存在当前浏览器标签页，返回时恢复；是否继续切换？', confirmLabel: '保留并切换' })) return;
    setSelectedKey(key); setMessage('');
  }
  async function reloadContent() {
    if (dirty && !await confirm({ title: '重新读取内容', message: '刷新将放弃当前未保存改动，读取服务器内容。', confirmLabel: '放弃并刷新' })) return;
    clearRecovery(); list.refresh(); detail.refresh();
  }
  useEffect(() => {
    const first = list.data?.items?.[0]?.key;
    if (!selectedKey && first) setSelectedKey(first);
  }, [list.data, selectedKey]);
  function updateStructured(patch) {
    if (!valid) return;
    const next = { ...(structured || {}), ...patch };
    keepDraft(JSON.stringify(next, null, 2), next);
  }
  // 常见问题原来是「一个 items 列表」配四个专用 handler（updateFaqItem / moveFaqItem / addFaqItem /
  // removeFaqItem）。2026-09-18 晚改成分档后，档位 key 就是字段名，直接走下面那套通用列表 handler
  // （updateList / moveList / addList / removeList），所以那四个函数删掉了。
  function updateStat(index, patch) {
    const stats = Array.isArray(structured?.stats) ? structured.stats : [];
    updateStructured({ stats: stats.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  }
  function addStat() { updateStructured({ stats: [...(Array.isArray(structured?.stats) ? structured.stats : []), { value: '', label: '' }] }); }
  function removeStat(index) { updateStructured({ stats: (structured?.stats || []).filter((_, itemIndex) => itemIndex !== index) }); }
  // ── 首页「三步一栏」（2026-09-23 用户口径：在官网页脚上方做一栏，文字与图片都要后台可配）──
  // 草稿里**还没有这一块**时，表单用官网内置默认（HOME_STEPS_DEFAULT，与官网兜底/种子默认同一份）预填：
  // 运营打开时看到的就是**官网正在显示的那三条**；一改动就把**整块**（默认值 + 本次改动）写进草稿，
  // 所以不会出现"后台看着是空的、官网却有内容"这种没人看得懂的状态。
  // ⚠️ 不走上面那套 updateList/moveList：它们从 `structured[field]` 取基准（草稿里可能没有这一块），
  //    这里必须以**显示出来的这一份**为基准，否则第一次编辑会把默认那几条丢掉。
  const stepsBlock = structured?.steps && typeof structured.steps === 'object' ? structured.steps : HOME_STEPS_DEFAULT;
  const stepItems = Array.isArray(stepsBlock.items) ? stepsBlock.items : [];
  function updateSteps(patch) { updateStructured({ steps: { ...stepsBlock, ...patch } }); }
  function updateStep(index, patch) { updateSteps({ items: stepItems.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)) }); }
  function moveStep(index, direction) {
    const next = index + direction;
    if (next < 0 || next >= stepItems.length) return;
    const list = [...stepItems];
    [list[index], list[next]] = [list[next], list[index]];
    updateSteps({ items: list });
  }
  function addStep() { updateSteps({ items: [...stepItems, { number: String(stepItems.length + 1).padStart(2, '0'), title: '', desc: '', imageUrl: '', imageAlt: '' }] }); }
  function removeStep(index) { updateSteps({ items: stepItems.filter((_, itemIndex) => itemIndex !== index) }); }
  // ── 首页「对比一栏」（2026-09-25 用户口径：「在官网首页页脚上面加一个以上代码的页面，后台可以配置」）──
  // 与三步一栏同一套做法：草稿里还没有这一块时，用官网内置默认（HOME_COMPARE_DEFAULT）预填，
  // 运营看到的就是官网**正在显示**的那份；一改动就把整块（默认值 + 本次改动）写进草稿。
  // 条目用**多行文本**编辑（一行一条）——比一条一个输入框快得多，也少一大截表单高度。
  const compareBlock = structured?.compare && typeof structured.compare === 'object' ? structured.compare : HOME_COMPARE_DEFAULT;
  const compareCards = Array.isArray(compareBlock.cards) ? compareBlock.cards : [];
  function updateCompare(patch) { updateStructured({ compare: { ...compareBlock, ...patch } }); }
  function updateCompareCard(index, patch) { updateCompare({ cards: compareCards.map((card, cardIndex) => (cardIndex === index ? { ...card, ...patch } : card)) }); }
  function removeCompareCard(index) { updateCompare({ cards: compareCards.filter((_, cardIndex) => cardIndex !== index) }); }
  function addCompareCard() { updateCompare({ cards: [...compareCards, { tone: compareCards.some((card) => card?.tone === 'with') ? 'without' : 'with', title: '', items: [] }] }); }
  // 第二屏「视频展示」（2026-09-26）：标题 + 副标题 + 多个视频卡（标签/标题/说明/视频/封面）。
  const videosBlock = structured?.videos && typeof structured.videos === 'object' ? structured.videos : HOME_VIDEOS_DEFAULT;
  const videoItems = Array.isArray(videosBlock.items) ? videosBlock.items : [];
  function updateVideos(patch) { updateStructured({ videos: { ...videosBlock, ...patch } }); }
  function updateVideo(index, patch) { updateVideos({ items: videoItems.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)) }); }
  function removeVideo(index) { updateVideos({ items: videoItems.filter((_, itemIndex) => itemIndex !== index) }); }
  function addVideo() { updateVideos({ items: [...videoItems, { tag: '', title: '', desc: '', videoUrl: '', posterUrl: '' }] }); }
  // ⭐ 合作品牌（2026-10-03 用户口径：「在灵动AI，让每个少年都成为创造者下方一屏插入……可以后台配置」）。
  //    位置：官网首页**第一屏下方、视频屏上方**。字段是**嵌套的**（title / metric{} / rating{} / avatars[] / logos[]），
  //    所以走 updateSection（分区内字段）这条路；数字与评分再往里合并一层。
  //    ⚠️ 默认**全空**：合作品牌与那些数字是机构自己的事实，平台不编（参考稿里那 7 个品牌是别家的）。
  //      一条品牌都没有（且标题/数字/评分/头像都空）= **官网不显示这一屏**。
  const brandsBlock = structured?.brands && typeof structured.brands === 'object' ? structured.brands : HOME_BRANDS_DEFAULT;
  const brandLogos = cmsListOf(brandsBlock.logos);
  const brandAvatars = cmsListOf(brandsBlock.avatars);
  const brandMetric = brandsBlock.metric && typeof brandsBlock.metric === 'object' ? brandsBlock.metric : HOME_BRANDS_DEFAULT.metric;
  const brandRating = brandsBlock.rating && typeof brandsBlock.rating === 'object' ? brandsBlock.rating : HOME_BRANDS_DEFAULT.rating;
  function updateBrands(patch) { updateSection('brands', patch); }
  function updateBrandMetric(patch) { updateBrands({ metric: { ...brandMetric, ...patch } }); }
  function updateBrandRating(patch) { updateBrands({ rating: { ...brandRating, ...patch } }); }
  function fillBrandsSample() { updateBrands(JSON.parse(JSON.stringify(HOME_BRANDS_SAMPLE))); }
  // ── 机构手册「政策」一栏（2026-09-28 用户口径：给了各地公告截图，形状定成**地区卡（按地区排）**）──
  // 与「三步一栏」同一条做法：草稿里**还没有这一块**时，用官网内置默认（HANDBOOK_POLICY_DEFAULT，
  // 与官网兜底、数据库种子同一份）预填 —— 运营打开就看到官网正在显示的那 11 张卡，改哪张写哪张。
  // ⚠️ 千万别退回"直接从草稿取列表"：草稿里没有这一块时，列表是空的，
  //    运营点一下「新增地区」保存后会把内置的 11 张全冲掉（官网那一段就只剩一张空卡）。
  const policyBlock = structured?.policy && typeof structured.policy === 'object' ? structured.policy : HANDBOOK_POLICY_DEFAULT;
  const policyCards = Array.isArray(policyBlock.cards) ? policyBlock.cards : [];
  function updatePolicy(patch) { updateStructured({ policy: { ...policyBlock, ...patch } }); }
  function updatePolicyCard(index, patch) { updatePolicy({ cards: policyCards.map((card, cardIndex) => (cardIndex === index ? { ...card, ...patch } : card)) }); }
  function movePolicyCard(index, direction) {
    const items = [...policyCards]; const next = index + direction;
    if (next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next], items[index]];
    updatePolicy({ cards: items });
  }
  function removePolicyCard(index) { updatePolicy({ cards: policyCards.filter((_, cardIndex) => cardIndex !== index) }); }
  function addPolicyCard() { updatePolicy({ cards: [...policyCards, { region: '', title: '', note: '', imageUrl: '', imageAlt: '' }] }); }
  // ── 机构手册「跨学科知识融合，综合能力培养」一栏（2026-09-28 用户口径：加在海报上方）──
  // 同样是"草稿里没有就用内置默认预填"，理由与政策那一栏完全一样（不让运营一改就把默认冲掉）。
  // 内容是**排出来的文字**（学科表 + 能力清单），所以没有图片字段。
  const skillsBlock = structured?.skills && typeof structured.skills === 'object' ? structured.skills : HANDBOOK_SKILLS_DEFAULT;
  const skillSubjects = Array.isArray(skillsBlock.subjects) ? skillsBlock.subjects : [];
  const skillAbilities = Array.isArray(skillsBlock.abilities) ? skillsBlock.abilities : [];
  function updateSkills(patch) { updateStructured({ skills: { ...skillsBlock, ...patch } }); }
  function updateSkillSubject(index, patch) { updateSkills({ subjects: skillSubjects.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)) }); }
  function moveSkillSubject(index, direction) {
    const items = [...skillSubjects]; const next = index + direction;
    if (next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next], items[index]];
    updateSkills({ subjects: items });
  }
  function removeSkillSubject(index) { updateSkills({ subjects: skillSubjects.filter((_, rowIndex) => rowIndex !== index) }); }
  function addSkillSubject() { updateSkills({ subjects: [...skillSubjects, { subject: '', points: '' }] }); }
  function updateSkillAbility(index, patch) { updateSkills({ abilities: skillAbilities.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)) }); }
  function moveSkillAbility(index, direction) {
    const items = [...skillAbilities]; const next = index + direction;
    if (next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next], items[index]];
    updateSkills({ abilities: items });
  }
  function removeSkillAbility(index) { updateSkills({ abilities: skillAbilities.filter((_, itemIndex) => itemIndex !== index) }); }
  function addSkillAbility() { updateSkills({ abilities: [...skillAbilities, { title: '', desc: '' }] }); }
  // 视频上传：与配图同一条路（file-assets），只是 category 用 MEDIA_ASSET（语义更准，且公开口认它）。
  // ⚠️ 生产上限 200MB（FILE_UPLOAD_MAX_BYTES），而且会过病毒扫描 —— 官网展示用的片段请压到 10MB 内。
  async function uploadVideo(file, apply, key) {
    setUploading(key); setMessage('');
    try {
      const asset = await api.upload('admin/file-assets/upload', file, { category: 'MEDIA_ASSET', visibility: 'PUBLIC_PLATFORM' });
      apply(`/api/public/file-assets/${asset.id}/download`);
    } catch (error) { setMessage(errorText('视频上传失败：' + (error.message || '未知错误'))); }
    finally { setUploading(''); }
  }
  const asLines = (value) => (Array.isArray(value) ? value.join('\n') : '');
  const fromLines = (value) => String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
  function updateCourse(index, patch) {
    const list = Array.isArray(structured?.courses) ? structured.courses : [];
    updateStructured({ courses: list.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  }
  function moveCourse(index, direction) {
    const list = Array.isArray(structured?.courses) ? [...structured.courses] : [];
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= list.length) return;
    [list[index], list[nextIndex]] = [list[nextIndex], list[index]];
    updateStructured({ courses: list });
  }
  function addCourse() { updateStructured({ courses: [...(Array.isArray(structured?.courses) ? structured.courses : []), { icon: '✨', title: '', category: '', lessonCount: 8, ageRange: '8–16 岁', summary: '', lessons: [] }] }); }
  function removeCourse(index) { updateStructured({ courses: (structured?.courses || []).filter((_, itemIndex) => itemIndex !== index) }); }
  // ── 「联系我们」的联系卡片（2026-09-28 用户口径：「这里这个卡片后台支持增加」，一页可放好几张）──
  // 老内容（2026-09-28 之前发布的 `CONTACT` 是 name/phone/wechatQrUrl/note 四个扁平字段）
  // 第一次进这个表单时显示成**一张卡**；只要动一下就写成新的 `contacts` 数组、
  // 并把那四个老字段清空 —— 留着两份迟早没人知道哪份算数（官网优先认 contacts，见 main.jsx 的 contactCardsOf）。
  const contactCards = cmsListOf(structured?.contacts).length
    ? cmsListOf(structured?.contacts)
    : ((structured?.name || structured?.phone || structured?.wechatQrUrl)
      ? [{ name: structured?.name || '', phone: structured?.phone || '', wechatQrUrl: structured?.wechatQrUrl || '', note: structured?.note || '' }]
      : []);
  function writeContacts(next) { updateStructured({ contacts: next, name: '', phone: '', wechatQrUrl: '', note: '' }); }
  function addContact() { writeContacts([...contactCards, { name: '', phone: '', wechatQrUrl: '', note: '' }]); }
  function removeContact(index) { writeContacts(contactCards.filter((_, itemIndex) => itemIndex !== index)); }
  function moveContact(index, direction) {
    const next = [...contactCards];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    writeContacts(next);
  }
  function updateContact(index, patch) { writeContacts(contactCards.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item))); }
  // ── 列表字段的通用增删改 ──────────────────────────────────────────────
  // 首页的 stats（以及历史上机构手册的 cards）都是「数组里放对象」，
  // 一份代码管多种字段，免得每加一个区块就把同样的四个函数再抄一遍。
  function updateList(field, index, patch) {
    const items = cmsListOf(structured?.[field]);
    updateStructured({ [field]: items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  }
  function moveList(field, index, direction) {
    const items = [...cmsListOf(structured?.[field])];
    const next = index + direction;
    if (next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next], items[index]];
    updateStructured({ [field]: items });
  }
  function addList(field, blank) { updateStructured({ [field]: [...cmsListOf(structured?.[field]), blank] }); }
  function removeList(field, index) { updateStructured({ [field]: cmsListOf(structured?.[field]).filter((_, itemIndex) => itemIndex !== index) }); }
  /** 某一档整体上下移一位 = 改它的显示优先级（官网 tab 顺序跟着变，改完发布即生效）。 */
  function moveAudience(index, direction) {
    const order = faqAudienceOrder(structured);
    const next = index + direction;
    if (next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    updateStructured({ audienceOrder: order });
  }
  // 机构手册（2026-09-19 按设计稿重做成「分区」结构）用的几个 helper：
  // 它的字段是**嵌套**的（hero/about/poster/work/compare/cta 各一小块），
  // 上面那套 updateList/moveList 只认顶层字段，所以这里补一层「分区内的字段」操作。
  function updateSection(section, patch) {
    updateStructured({ [section]: { ...(structured?.[section] || {}), ...patch } });
  }
  /** 多行标题里的一行（headingLines / introLines）。 */
  function updateSectionLine(section, field, index, value) {
    const lines = cmsListOf(structured?.[section]?.[field]);
    updateSection(section, { [field]: lines.map((line, lineIndex) => (lineIndex === index ? value : line)) });
  }
  /** 分区里的列表（现在只有 work.cards）：增删改 + 上下移。 */
  function updateSectionList(section, field, index, patch) {
    const items = cmsListOf(structured?.[section]?.[field]);
    updateSection(section, { [field]: items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)) });
  }
  function moveSectionList(section, field, index, direction) {
    const items = [...cmsListOf(structured?.[section]?.[field])];
    const next = index + direction;
    if (next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next], items[index]];
    updateSection(section, { [field]: items });
  }
  function addSectionList(section, field, blank) { updateSection(section, { [field]: [...cmsListOf(structured?.[section]?.[field]), blank] }); }
  function removeSectionList(section, field, index) { updateSection(section, { [field]: cmsListOf(structured?.[section]?.[field]).filter((_, itemIndex) => itemIndex !== index) }); }
  // 配图上传：走平台已有的文件资产接口（与课程封面上传同一条路），拿到公开可读地址后写回字段。
  async function uploadImage(file, apply, key) {
    setUploading(key); setMessage('');
    try {
      const asset = await api.upload('admin/file-assets/upload', file, { category: 'PROMO_COVER', visibility: 'PUBLIC_PLATFORM' });
      apply(`/api/public/file-assets/${asset.id}/download`);
    } catch (error) { setMessage(errorText('图片上传失败：' + (error.message || '未知错误'))); }
    finally { setUploading(''); }
  }
  async function saveDraft() {
    setBusy(true); setMessage('');
    try {
      const content = parseWebsiteDraft(draft);
      if (!content || Array.isArray(content) || typeof content !== 'object') throw new Error('内容必须是 JSON 对象。');
      await api.put(`admin/website-content/${selectedKey}`, { content });
      clearRecovery(); setSavedDraft(draft); setMessage('草稿已保存。'); await detail.refresh(); await list.refresh();
    } catch (error) { setMessage(errorText(error instanceof SyntaxError ? 'JSON 格式无效。' : error.message)); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (!valid || dirty || busy) return;
    await confirm({ title: '发布官网内容', message: `确认发布「${WEBSITE_CONTENT_LABELS[selectedKey] || selectedKey}」草稿 v${detail.data?.draftVersion}？官网将立即读取此版本。`, confirmLabel: '确认发布', execute: async () => {
      setBusy(true); setMessage('');
      try { await api.post(`admin/website-content/${selectedKey}/publish`, { reason: '官网内容管理台发布' }); setMessage('已发布，官网公开接口将读取新版本。'); detail.refresh(); list.refresh(); }
      finally { setBusy(false); }
    } });
  }
  async function rollback(version) {
    await confirm({ title: '回滚并发布', message: `确认回滚到版本 ${version} 并立即发布？${dirty ? '当前未保存改动将被覆盖。' : '官网内容将替换为该历史版本。'}`, confirmLabel: '确认回滚', execute: async () => {
      setBusy(true); setMessage('');
      try { await api.post(`admin/website-content/${selectedKey}/rollback`, { version, reason: `官网内容管理台回滚到版本 ${version}` }); clearRecovery(); setMessage(`已回滚到版本 ${version}。`); detail.refresh(); list.refresh(); }
      finally { setBusy(false); }
    } });
  }
  const preview = structured;
  return <>
    {confirmation}
    <PageHeader eyebrow="官网运营" title="官网内容 CMS"  actions={<button className="secondary-button" disabled={busy} onClick={reloadContent}>刷新</button>} />
    {message && <Notice tone="success">{message}</Notice>}
    <div className="split website-cms">
      <Panel title="内容区块">
        {list.loading ? <Loading label="正在读取内容…" /> : list.error ? <ErrorState error={list.error} onRetry={list.refresh} /> : <div className="card-list">{(list.data?.items || []).map((item) => <button type="button" key={item.key} className={`item-card cms-key ${selectedKey === item.key ? 'selected' : ''}`} disabled={busy} aria-pressed={selectedKey === item.key} onClick={() => selectContent(item.key)}><strong>{WEBSITE_CONTENT_LABELS[item.key] || item.key}</strong><span>{item.key} · {item.status === 'PUBLISHED' ? '已发布' : item.status === 'DEFAULT' ? '内置默认' : '仅草稿'} · 草稿 v{item.draftVersion}</span></button>)}</div>}
      </Panel>
      <Panel title={selectedKey ? `编辑 ${WEBSITE_CONTENT_LABELS[selectedKey] || selectedKey}` : '选择区块'}>
        {!selectedKey ? <Empty title="暂无内容区块" desc="请先创建或运行 seed 初始化默认区块。" /> : detail.loading ? <Loading label="正在读取详情…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : <>
          <div className="cms-meta"><span>公开状态：{detail.data?.status === 'PUBLISHED' ? '已发布' : detail.data?.status === 'DEFAULT' ? '内置默认' : '草稿'}</span><span>草稿 v{detail.data?.draftVersion}</span><span>发布 v{detail.data?.publishedVersion || '—'}</span></div>
          {detail.data?.isDefault ? <Notice tone="info">该区块还没有草稿：当前展示的是平台内置默认内容。改动后点「保存草稿」，再点「发布」才会对官网生效。</Notice> : null}
          <div role="status" className="notice info">{dirty ? '有未保存改动 · 当前标签页会暂存草稿，返回时恢复。请保存后再发布。' : '当前内容已与服务器草稿同步。'}</div>
          {storageError && <Notice tone="danger">{storageError}</Notice>}
          {!valid && <div role="alert" id="cms-json-error" className="notice danger">JSON 无效：内容必须是 JSON 对象。预览保留最后有效内容；请修正 JSON 后保存或发布。</div>}
          <fieldset disabled={busy || !valid} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {selectedKey === 'HOME' && <div className="cms-form">
            <div className="form-grid"><label>首页眉题<input value={structured?.heroKicker || ''} onChange={(event) => updateStructured({ heroKicker: event.target.value })} maxLength={100} /></label><label>首页标题<input value={structured?.heroTitle || ''} onChange={(event) => updateStructured({ heroTitle: event.target.value })} maxLength={100} /></label><label>强调标题<input value={structured?.heroAccent || ''} onChange={(event) => updateStructured({ heroAccent: event.target.value })} maxLength={100} /></label><label>封面 / 真实资源 URL（可选）<input value={structured?.coverImageUrl || ''} onChange={(event) => updateStructured({ coverImageUrl: event.target.value })} placeholder="仅填写已有真实资源地址，不会上传文件" /></label></div>
            <label>首页描述<textarea value={structured?.heroDescription || ''} onChange={(event) => updateStructured({ heroDescription: event.target.value })} maxLength={500} /></label>
            <div className="form-grid"><label>信任区标题<input value={structured?.trustTitle || ''} onChange={(event) => updateStructured({ trustTitle: event.target.value })} maxLength={150} /></label><label>信任区描述<input value={structured?.trustDescription || ''} onChange={(event) => updateStructured({ trustDescription: event.target.value })} maxLength={300} /></label></div>
            <div className="cms-section-heading top-gap"><strong>首页数据区（官网首页底部那一排）</strong><span>图标 / 数值 / 后缀 / 名称</span></div>
            <div className="cms-faq-list">{cmsListOf(structured?.stats).map((item, index) => <div className="cms-faq-item" key={`stat-${index}`}><div className="cms-faq-heading"><strong>第 {index + 1} 项</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveList('stats', index, -1)} aria-label={`第 ${index + 1} 项上移`}>↑</button><button type="button" className="text-button" disabled={index === cmsListOf(structured?.stats).length - 1} onClick={() => moveList('stats', index, 1)} aria-label={`第 ${index + 1} 项下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeList('stats', index)}>删除</button></div></div><div className="form-grid"><label>图标<input value={item.icon || ''} onChange={(event) => updateList('stats', index, { icon: event.target.value })} maxLength={24} placeholder="package / lessons / format / console" /><small className="muted">填图标名：package（课包）/ lessons（课时）/ format（形式）/ console（工作台）；也可以直接写一个字符或 emoji。</small></label><label>数值<input value={item.value ?? ''} onChange={(event) => updateList('stats', index, { value: event.target.value })} maxLength={12} /></label><label>后缀<input value={item.suffix || ''} onChange={(event) => updateList('stats', index, { suffix: event.target.value })} maxLength={8} /></label><label>名称<input value={item.label || ''} onChange={(event) => updateList('stats', index, { label: event.target.value })} maxLength={24} /></label></div></div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={() => addList('stats', { icon: 'package', value: '', suffix: '', label: '' })}>新增数据项</button>
            {/* 三步一栏（官网页脚上方那一栏，2026-09-23 用户口径）：标题 + 副标题 + 每一步（编号/标题/说明/配图）。
                配图走平台已有的文件资产接口（与机构手册那几处同一条路），传完把公开地址写回字段。
                ⚠️ 把三步**全部删掉**是有效操作：官网那一栏会整栏不显示（与首页数据区同一条口径）。 */}
            <div className="cms-section-heading top-gap"><strong>三步一栏（官网页脚上方）</strong><span>大标题 / 副标题 / 每一步的编号、标题、说明与配图 · 全部删掉 ＝ 官网不显示这一栏</span></div>
            <div className="form-grid">
              <label>大标题<input value={stepsBlock.title || ''} onChange={(event) => updateSteps({ title: event.target.value })} maxLength={60} placeholder="例如：三步，把 AI 创作课开进课堂" /></label>
              <label>副标题<input value={stepsBlock.lead || ''} onChange={(event) => updateSteps({ lead: event.target.value })} maxLength={160} /></label>
            </div>
            <div className="cms-faq-list">{stepItems.map((item, index) => <div className="cms-faq-item" key={`hp-step-${index}`}><div className="cms-faq-heading"><strong>第 {index + 1} 步</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveStep(index, -1)} aria-label={`第 ${index + 1} 步上移`}>↑</button><button type="button" className="text-button" disabled={index === stepItems.length - 1} onClick={() => moveStep(index, 1)} aria-label={`第 ${index + 1} 步下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeStep(index)}>删除</button></div></div>
              <div className="form-grid"><label>编号<input value={item.number || ''} onChange={(event) => updateStep(index, { number: event.target.value })} maxLength={8} placeholder="01" /></label><label>标题<input value={item.title || ''} onChange={(event) => updateStep(index, { title: event.target.value })} maxLength={40} /></label></div>
              <label>说明<textarea value={item.desc || ''} onChange={(event) => updateStep(index, { desc: event.target.value })} maxLength={200} /></label>
              <div className="form-grid"><label>配图地址<input value={item.imageUrl || ''} onChange={(event) => updateStep(index, { imageUrl: event.target.value })} placeholder="留空则官网画一个占位图（不出破图）" /></label><label>配图说明（无障碍用）<input value={item.imageAlt || ''} onChange={(event) => updateStep(index, { imageAlt: event.target.value })} maxLength={160} /></label></div>
              <div className="row-actions top-gap"><label className="inline-file-upload">{uploading === `hp-step-${index}` ? '上传中…' : '上传配图'}<input type="file" accept="image/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadImage(file, (url) => updateStep(index, { imageUrl: url }), `hp-step-${index}`); }} /></label></div>
            </div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={addStep}>新增一步</button>
            {/* ⭐ 合作品牌（2026-10-03 用户口径：「在灵动AI，让每个少年都成为创造者下方一屏插入……
                这个是合作品牌的一屏，可以后台配置」）。位置：官网首页**第一屏下方、视频屏上方**。
                品牌没有 logo 图时官网按**文字商标**画，所以先只填名字也能看到整条走马灯。
                ⚠️ 默认全空 ⇒ 官网不显示这一屏（合作品牌与那些数字是您自己的事实，平台不替您编）。 */}
            <div className="cms-section-heading top-gap"><strong>合作品牌（首页第一屏下方 · 视频屏上方）</strong><span>大标题 / 数字 / 评分 / 头像 / 品牌 · 一条品牌都没有 ＝ 官网不显示这一屏</span></div>
            {(brandLogos.length || String(brandsBlock.title || '').trim()) ? null : <Notice tone="warning">这一屏现在是空的，<strong>官网上不会显示</strong>。点下面的<strong>「填入示例品牌」</strong>先看排版，再把名字与 logo 换成真实的合作品牌，然后记得点<strong>「发布」</strong>（只保存草稿官网看不到）。</Notice>}
            <div className="form-grid">
              <label>大标题<input value={brandsBlock.title || ''} onChange={(event) => updateBrands({ title: event.target.value })} maxLength={80} placeholder="例如：和这些伙伴一起，把 AI 创作带进课堂" /></label>
              <label>数字说明<input value={brandMetric.label || ''} onChange={(event) => updateBrandMetric({ label: event.target.value })} maxLength={80} placeholder="例如：累计生成的 AI 作品" /></label>
            </div>
            <div className="form-grid">
              <label>数字<input value={brandMetric.value ?? ''} onChange={(event) => updateBrandMetric({ value: event.target.value })} inputMode="numeric" placeholder="例如：73（留空则不显示大数字）" /><small className="muted">官网滚到这一屏时从 0 滚上去；点一下数字还会再滚一次。</small></label>
              <label>数字后缀<input value={brandMetric.suffix || ''} onChange={(event) => updateBrandMetric({ suffix: event.target.value })} maxLength={12} placeholder="例如：M+ / 万件 / 所" /></label>
            </div>
            <div className="form-grid">
              <label>评分<input value={brandRating.score || ''} onChange={(event) => updateBrandRating({ score: event.target.value })} maxLength={12} placeholder="例如：4.8（留空则不显示评分）" /></label>
              <label>评价数<input value={brandRating.count || ''} onChange={(event) => updateBrandRating({ count: event.target.value })} maxLength={24} placeholder="例如：(728k 条评价)" /></label>
            </div>
            <label>评分说明<input value={brandRating.note || ''} onChange={(event) => updateBrandRating({ note: event.target.value })} maxLength={80} placeholder="例如：来自真实课堂的家长与老师" /></label>
            <div className="cms-section-heading"><strong>头像（可选）</strong><span>最多 6 张，堆叠显示 · 全部删掉 ＝ 官网上不画这一组</span></div>
            <div className="cms-faq-list">{brandAvatars.map((url, index) => <div className="cms-faq-item" key={`hp-brand-avatar-${index}`}>
              <div className="cms-faq-heading"><strong>头像 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button danger-text" onClick={() => removeSectionList('brands', 'avatars', index)}>删除</button></div></div>
              <label>图片地址<input value={url || ''} onChange={(event) => updateSectionList('brands', 'avatars', index, event.target.value)} placeholder="留空则删掉这一张" /></label>
              <div className="row-actions top-gap"><label className="inline-file-upload">{uploading === `hp-brand-avatar-${index}` ? '上传中…' : '上传头像'}<input type="file" accept="image/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadImage(file, (url2) => updateSectionList('brands', 'avatars', index, url2), `hp-brand-avatar-${index}`); }} /></label></div>
            </div>)}</div>
            <button type="button" className="secondary-button top-gap" disabled={brandAvatars.length >= 6} onClick={() => addSectionList('brands', 'avatars', '')}>新增头像</button>
            <div className="cms-section-heading top-gap"><strong>品牌（走马灯里那一条）</strong><span>名称 + logo 图（没有图就按文字商标画）· 可上下移、可删</span></div>
            <div className="cms-faq-list">{brandLogos.map((item, index) => <div className="cms-faq-item" key={`hp-brand-logo-${index}`}>
              <div className="cms-faq-heading"><strong>品牌 {index + 1}{item?.name ? ` · ${item.name}` : ''}</strong>{item?.imageUrl ? null : <span>⚠️ 没有 logo 图，官网按文字商标显示</span>}<div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveSectionList('brands', 'logos', index, -1)} aria-label={`品牌 ${index + 1} 上移`}>↑</button><button type="button" className="text-button" disabled={index === brandLogos.length - 1} onClick={() => moveSectionList('brands', 'logos', index, 1)} aria-label={`品牌 ${index + 1} 下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeSectionList('brands', 'logos', index)}>删除</button></div></div>
              <div className="form-grid">
                <label>名称<input value={item?.name || ''} onChange={(event) => updateSectionList('brands', 'logos', index, { name: event.target.value })} maxLength={40} placeholder="品牌 / 机构名称" /></label>
                <label>跳转链接（可选）<input value={item?.linkUrl || ''} onChange={(event) => updateSectionList('brands', 'logos', index, { linkUrl: event.target.value })} placeholder="https://…（留空则不可点）" /></label>
              </div>
              <label>logo 图地址<input value={item?.imageUrl || ''} onChange={(event) => updateSectionList('brands', 'logos', index, { imageUrl: event.target.value })} placeholder="建议 PNG/SVG 透明底、高 88px 以内" /></label>
              <div className="row-actions top-gap"><label className="inline-file-upload">{uploading === `hp-brand-logo-${index}` ? '上传中…' : '上传 logo'}<input type="file" accept="image/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadImage(file, (url2) => updateSectionList('brands', 'logos', index, { imageUrl: url2 }), `hp-brand-logo-${index}`); }} /></label></div>
              <small className="muted">logo 会按 72% 不透明度显示、悬停变亮；一排大约 7 个，建议宽度接近（高 44px 以内）。</small>
            </div>)}</div>
            <div className="row-actions top-gap">
              <button type="button" className="secondary-button" onClick={() => addSectionList('brands', 'logos', { name: '', imageUrl: '', linkUrl: '' })}>新增品牌</button>
              <button type="button" className="secondary-button" onClick={fillBrandsSample}>填入示例品牌（先看排版）</button>
            </div>
            {/* 第二屏「视频展示」（2026-09-26 用户口径：「做一个官网的第二屏，放在第一屏下方，后台可配置
                视频，我要上传多个视频来展示，文案也要可配置」）。位置：官网首页**第一屏下方、三步一栏上方**。
                视频走平台已有的文件资产接口（category=MEDIA_ASSET + PUBLIC_PLATFORM 才能被公开口读到）。
                ⚠️ 上传上限 200MB 且要过病毒扫描；官网展示片段建议 ≤10MB。卡片全删 ＝ 官网不显示这一屏。 */}
            <div className="cms-section-heading top-gap"><strong>第二屏 · 视频展示（首页第一屏下方）</strong><span>标题 / 副标题 / 多个视频卡（标签、标题、说明、视频、封面）· 视频全删掉 ＝ 官网不显示这一屏</span></div>
            {/* 空状态写明白（2026-09-26：这一屏做完上线后运营以为"没做出来" —— 其实是空的时候官网不显示，
                而且只点「保存草稿」官网也看不到，必须再点「发布」）。 */}
            {videoItems.length ? null : <Notice tone="warning">这一屏现在是空的，<strong>官网上不会显示</strong>。点下面的「新增视频」上传第一个视频，然后记得点<strong>「发布」</strong>（只保存草稿官网看不到）。</Notice>}
            <div className="form-grid">
              <label>大标题<input value={videosBlock.title || ''} onChange={(event) => updateVideos({ title: event.target.value })} maxLength={60} /></label>
              <label>副标题<input value={videosBlock.lead || ''} onChange={(event) => updateVideos({ lead: event.target.value })} maxLength={160} /></label>
            </div>
            <div className="cms-faq-list">{videoItems.map((item, index) => <div className="cms-faq-item" key={`hp-vid-${index}`}>
              <div className="cms-faq-heading"><strong>第 {index + 1} 个视频</strong>{item.posterUrl ? null : <span>⚠️ 还没配封面，手机上是黑块</span>}<div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveSectionList('videos', 'items', index, -1)} aria-label={`第 ${index + 1} 个上移`}>↑</button><button type="button" className="text-button" disabled={index === videoItems.length - 1} onClick={() => moveSectionList('videos', 'items', index, 1)} aria-label={`第 ${index + 1} 个下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeVideo(index)}>删除</button></div></div>
              <label>标题<input value={item.title || ''} onChange={(event) => updateVideo(index, { title: event.target.value })} maxLength={40} /></label>
              <label>说明<textarea value={item.desc || ''} onChange={(event) => updateVideo(index, { desc: event.target.value })} maxLength={200} rows={2} /></label>
              <div className="form-grid">
                <label>视频地址<input value={item.videoUrl || ''} onChange={(event) => updateVideo(index, { videoUrl: event.target.value })} placeholder="/api/public/file-assets/<id>/download" /></label>
                <label>封面地址<input value={item.posterUrl || ''} onChange={(event) => updateVideo(index, { posterUrl: event.target.value })} placeholder="必填：留空在手机上就是一块黑（iOS 不会预加载视频，出不来第一帧）" /></label>
              </div>
              <div className="row-actions top-gap">
                <label className="inline-file-upload">{uploading === `hp-vid-${index}` ? '上传中…' : '上传视频'}<input type="file" accept="video/mp4,video/webm" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadVideo(file, (url) => updateVideo(index, { videoUrl: url }), `hp-vid-${index}`); }} /></label>
                <label className="inline-file-upload">{uploading === `hp-vid-cover-${index}` ? '上传中…' : '上传封面'}<input type="file" accept="image/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadImage(file, (url) => updateVideo(index, { posterUrl: url }), `hp-vid-cover-${index}`); }} /></label>
              </div>
              <small className="muted">视频建议：横版 16:9、≤10MB 的短视频（官网按 5 Mbps 出口发放，越大首屏越慢）。封面会自动按 960 宽取缩略图。</small>
            </div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={addVideo}>新增视频</button>
            {/* 对比一栏（2026-09-25 用户口径）：标题 + 要高亮的词 + 副标题 + 一正一反两张卡片（标题 + 一行一条的条目）。
                高亮词会带手绘感下划线；tone 决定配色与图标（without 暖色皱眉 / with 紫色高亮）。 */}
            <div className="cms-section-heading top-gap"><strong>对比一栏（官网首页 · 页脚上方）</strong><span>标题 / 高亮词 / 副标题 / 卡片 · 卡片全删掉 ＝ 官网不显示这一栏</span></div>
            <div className="form-grid">
              <label>标题<input value={compareBlock.title || ''} onChange={(event) => updateCompare({ title: event.target.value })} maxLength={60} placeholder="例如：同样的 AI 课，两种上法。" /><small className="muted">官网会一个字一个字打出来（滚到这一栏才开始打）。</small></label>
              <label>高亮词<input value={compareBlock.highlight || ''} onChange={(event) => updateCompare({ highlight: event.target.value })} maxLength={24} placeholder="标题里的某一段，例如：两种上法" /><small className="muted">标题里原样出现的一段就高亮那一段；<strong>不在标题里时会当作后半段追加显示</strong>（标题写前半句、这里写后半句也成立）；留空则整句按高亮色显示。</small></label>
            </div>
            <label>副标题<input value={compareBlock.lead || ''} onChange={(event) => updateCompare({ lead: event.target.value })} maxLength={160} /></label>
            <div className="cms-faq-list">{compareCards.map((card, index) => <div className="cms-faq-item" key={`hp-cmp-${index}`}>
              <div className="cms-faq-heading"><strong>第 {index + 1} 张卡片（{card?.tone === 'with' ? '正面' : '负面'}）</strong>
                <div className="row-actions"><button type="button" className="text-button danger-text" onClick={() => removeCompareCard(index)}>删除</button></div>
              </div>
              <div className="form-grid">
                <label>正 / 反<select value={card?.tone === 'with' ? 'with' : 'without'} onChange={(event) => updateCompareCard(index, { tone: event.target.value })}><option value="without">负面（暖色 + 皱眉图标）</option><option value="with">正面（紫色高亮 + 星标图标）</option></select></label>
                <label>卡片标题<input value={card?.title || ''} onChange={(event) => updateCompareCard(index, { title: event.target.value })} maxLength={40} /></label>
              </div>
              <label>条目（一行一条）<textarea value={asLines(card?.items)} onChange={(event) => updateCompareCard(index, { items: fromLines(event.target.value) })} rows={7} placeholder={'每行一条，例如：\n多个网站 / App 来回切换，课堂节奏被打断'} /></label>
            </div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={addCompareCard}>新增一张卡片</button>
          </div>}
          {selectedKey === 'FAQ' && (() => {
            // 三个档位各配一套问答（2026-09-18 晚用户口径）。三组共用同一套增删改 + 上下移，
            // 档位 key 直接当字段名用（与官网 /faq 的 tab 一一对应）。
            // ⚠️ 这里按 `audienceOrder`（= 官网真实显示顺序）渲染，所以**后台看到的顺序就是官网的顺序**；
            //    每组标题右边的 ↑/↓ 改的就是它（2026-09-19 用户口径：「可以排序优先级，优先级高的排在最前面」）。
            // ⚠️ 某一档问题为空 = 官网**不显示**那一档（口径：「没有内容就隐藏，有内容才出现」）；
            //    空档位不回退任何兜底内容（口径③：空 = 运营故意清空）。
            const order = faqAudienceOrder(structured);
            return <div className="cms-form">
              <div className="cms-section-heading"><strong>档位显示顺序</strong><span>优先级高的排在最前，官网 tab 按这个顺序；某一档问题为空则官网不显示那一档</span></div>
              {order.map((key, position) => {
                const label = FAQ_LABELS[key];
                const items = cmsListOf(structured?.[key]);
                return <div className="cms-faq-group" key={key}>
                  <div className="cms-faq-group-head"><strong>第 {position + 1} 位 · {label}</strong><span>{items.length} 条 · 字段 {key} · {items.length ? '官网会显示' : '⚠️ 官网不显示这一档'}</span><div className="row-actions"><button type="button" className="text-button" disabled={position === 0} onClick={() => moveAudience(position, -1)} aria-label={`把${label}的显示优先级上移`}>↑</button><button type="button" className="text-button" disabled={position === order.length - 1} onClick={() => moveAudience(position, 1)} aria-label={`把${label}的显示优先级下移`}>↓</button></div></div>
                  <div className="cms-faq-list">{items.map((item, index) => <div className="cms-faq-item" key={`faq-${key}-${index}`}><div className="cms-faq-heading"><strong>问题 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveList(key, index, -1)} aria-label={`${label} 第 ${index + 1} 个问题上移`}>↑</button><button type="button" className="text-button" disabled={index === items.length - 1} onClick={() => moveList(key, index, 1)} aria-label={`${label} 第 ${index + 1} 个问题下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeList(key, index)}>删除</button></div></div><label>问题<input value={item.question || ''} onChange={(event) => updateList(key, index, { question: event.target.value })} maxLength={200} /></label><label>答案<textarea value={item.answer || ''} onChange={(event) => updateList(key, index, { answer: event.target.value })} maxLength={1000} /></label></div>)}</div>
                  <button type="button" className="secondary-button top-gap" onClick={() => addList(key, { question: '', answer: '' })}>给{label}新增问题</button>
                </div>;
              })}
            </div>;
          })()}
          {selectedKey === 'BRAND' && <div className="cms-form"><div className="form-grid"><label>品牌名称<input value={structured?.name || ''} onChange={(event) => updateStructured({ name: event.target.value })} maxLength={100} /></label><label>联系邮箱<input type="email" value={structured?.contactEmail || ''} onChange={(event) => updateStructured({ contactEmail: event.target.value })} maxLength={200} /></label></div><label>品牌标语<input value={structured?.tagline || ''} onChange={(event) => updateStructured({ tagline: event.target.value })} maxLength={200} /></label></div>}
          {selectedKey === 'MARKETPLACE' && <div className="cms-form">
            <label>页面大标题<input value={structured?.title || ''} onChange={(event) => updateStructured({ title: event.target.value })} maxLength={100} /></label>
            <label>副标题<textarea value={structured?.lead || ''} onChange={(event) => updateStructured({ lead: event.target.value })} maxLength={400} /></label>
            <p className="muted">这里只改「灵动课程」页头这两句。课包本身（价格、封面、难度、适学年龄、课时、上下架）在「课包与课程编排」里维护 —— 官网列表读的就是那些字段。</p>
          </div>}
          {/* ⭐ 「联系我们」（/demo）页的联系卡片。
              2026-09-27 口径：官网那一页从**表单**改成**直接展示**（姓名 / 电话 / 微信二维码），后台可配。
              2026-09-28 口径（第二轮，见交接文档 §五十）：
                · 官网那一页**只剩卡片** —— 页头大标题与「你将获得」清单都删了，别照截图再加回来；
                · 卡片**可以有多张**（一页放几个联系人）→ 这里是增 / 删 / 上移 / 下移；
                · 电话在官网上是**纯文本、不点击拨打**（用户原话「应该就是数字就好了啊」），
                  所以提示里不要再写"可点击拨打"。
              ⚠️ 老内容（四个扁平字段）第一次进来显示成一张卡；一改就写成 `contacts` 数组并清空老字段。 */}
          {selectedKey === 'CONTACT' && <div className="cms-form">
            <div className="cms-section-heading"><strong>商务联系卡片</strong><span>官网「联系我们」页按这个顺序一人一张卡；留空的项在官网上显示「待配置」。电话在官网上是纯文本（不点击拨打）。</span></div>
            <div className="cms-faq-list">{contactCards.map((card, index) => <div className="cms-faq-item" key={`contact-${index}`}>
              <div className="cms-faq-heading"><strong>卡片 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveContact(index, -1)} aria-label={`卡片 ${index + 1} 上移`}>↑</button><button type="button" className="text-button" disabled={index === contactCards.length - 1} onClick={() => moveContact(index, 1)} aria-label={`卡片 ${index + 1} 下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeContact(index)}>删除</button></div></div>
              <div className="form-grid">
                <label>联系人姓名<input value={card.name || ''} onChange={(event) => updateContact(index, { name: event.target.value })} maxLength={40} placeholder="例如：王老师" /></label>
                <label>联系电话<input value={card.phone || ''} onChange={(event) => updateContact(index, { phone: event.target.value })} maxLength={30} placeholder="例如：13800000000" /></label>
              </div>
              <label>微信二维码图片地址<input value={card.wechatQrUrl || ''} onChange={(event) => updateContact(index, { wechatQrUrl: event.target.value })} placeholder="点下面的「上传二维码」也可以直接传图" /></label>
              <div className="row-actions"><label className="inline-file-upload">{uploading === `contact-qr-${index}` ? '上传中…' : '上传二维码'}<input type="file" accept="image/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadImage(file, (url) => updateContact(index, { wechatQrUrl: url }), `contact-qr-${index}`); }} /></label>
                {card.wechatQrUrl ? <img src={card.wechatQrUrl} alt={`卡片 ${index + 1} 微信二维码预览`} style={{ width: 96, height: 96, objectFit: 'contain', border: '1px solid #eee', borderRadius: 8 }} /> : null}</div>
              <label>二维码下面那行小字<textarea value={card.note || ''} onChange={(event) => updateContact(index, { note: event.target.value })} maxLength={200} placeholder="例如：加微信时请备注机构名称" /></label>
            </div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={addContact}>新增联系卡片</button>
          </div>}
          {selectedKey === 'HANDBOOK' && <div className="cms-form">
            {/* 2026-09-19 按用户给的设计稿（design (1).zip）重做：整页换成
                「主视觉 + 关于 + 海报 + 横滑卡片 + 对比 + 结尾行动」。字段与官网一一对应
                （apps/website/src/main.jsx 的 Handbook()）。
                ⚠️ 带 Lines 的是**多行标题**：官网把**第 2 行**渲染成描边字（设计稿如此），
                   所以这里**一行一个输入框**，不要合并成一个 textarea、也不要在里面敲换行。
                ⚠️ 图片留空时官网用内置的默认图（public/assets/handbook/）；换图可以直接贴地址，
                   也可以点「上传图片」走平台的文件资产接口。 */}
            {[['hero', '主视觉（首屏）', '两行大标题 + 通屏背景图'], ['about', '关于（纸色区块）', '左侧图 + 右侧标题与正文'], ['poster', '海报（信息图）', '用户给的那张「AI 时代的孩子」——整张显示，不裁切，点开可看大图']].map(([section, title, hint]) => {
              const block = structured?.[section] || {};
              const lines = cmsListOf(block.headingLines);
              return <div key={`hb-${section}`}>
                <div className="cms-section-heading top-gap"><strong>{title}</strong><span>{hint}</span></div>
                <div className="form-grid">
                  <label>图片地址<input value={block.imageUrl || ''} onChange={(event) => updateSection(section, { imageUrl: event.target.value })} placeholder="留空则用默认图" /></label>
                  <label>图片说明（无障碍用）<input value={block.imageAlt || ''} onChange={(event) => updateSection(section, { imageAlt: event.target.value })} maxLength={160} /></label>
                  {section === 'about' && <label>角标文字<input value={block.index || ''} onChange={(event) => updateSection(section, { index: event.target.value })} maxLength={24} placeholder="例如 01 / 关于" /></label>}
                  {section === 'poster' && <label>眉题<input value={block.eyebrow || ''} onChange={(event) => updateSection(section, { eyebrow: event.target.value })} maxLength={24} /></label>}
                </div>
                {section === 'hero' && <div className="form-grid">
                  <label>进场幕布文案<input value={block.loaderWord || ''} onChange={(event) => updateSection('hero', { loaderWord: event.target.value })} maxLength={30} placeholder="进场那一秒盖在整页上的那行字" /></label>
                  <label>标题第 1 行<input value={block.line1 || ''} onChange={(event) => updateSection('hero', { line1: event.target.value })} maxLength={40} /></label>
                  <label>标题第 2 行<input value={block.line2 || ''} onChange={(event) => updateSection('hero', { line2: event.target.value })} maxLength={40} /></label>
                </div>}
                {section === 'about' && <>
                  <div className="form-grid">
                    <label>标题第 1 行<input value={lines[0] || ''} onChange={(event) => updateSectionLine('about', 'headingLines', 0, event.target.value)} maxLength={40} /></label>
                    <label>标题第 2 行<input value={lines[1] || ''} onChange={(event) => updateSectionLine('about', 'headingLines', 1, event.target.value)} maxLength={40} /></label>
                  </div>
                  <label>正文<textarea value={block.body || ''} onChange={(event) => updateSection('about', { body: event.target.value })} maxLength={800} /></label>
                </>}
                {section === 'poster' && <>
                  <label>海报标题<input value={block.title || ''} onChange={(event) => updateSection('poster', { title: event.target.value })} maxLength={60} /></label>
                  <label>图注<textarea value={block.caption || ''} onChange={(event) => updateSection('poster', { caption: event.target.value })} maxLength={200} /></label>
                </>}
                <div className="row-actions top-gap"><label className="inline-file-upload">{uploading === `hb-${section}` ? '上传中…' : '上传图片'}<input type="file" accept="image/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadImage(file, (url) => updateSection(section, { imageUrl: url }), `hb-${section}`); }} /></label></div>
              </div>;
            })}
            <div className="cms-section-heading top-gap"><strong>横滑卡片区（向右滚动的 5 张）</strong><span>标题 + 一句话 + 配图；第 2 行标题官网是描边字</span></div>
            <div className="form-grid">{cmsListOf(structured?.work?.introLines).map((line, index) => <label key={`hb-intro-${index}`}>大标题第 {index + 1} 行{index === 1 ? '（描边）' : ''}<input value={line || ''} onChange={(event) => updateSectionLine('work', 'introLines', index, event.target.value)} maxLength={20} /></label>)}</div>
            <div className="cms-faq-list">{cmsListOf(structured?.work?.cards).map((card, index) => <div className="cms-faq-item" key={`hb-card-${index}`}><div className="cms-faq-heading"><strong>卡片 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveSectionList('work', 'cards', index, -1)} aria-label={`卡片 ${index + 1} 上移`}>↑</button><button type="button" className="text-button" disabled={index === cmsListOf(structured?.work?.cards).length - 1} onClick={() => moveSectionList('work', 'cards', index, 1)} aria-label={`卡片 ${index + 1} 下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeSectionList('work', 'cards', index)}>删除</button></div></div>
              <div className="form-grid"><label>标题<input value={card.title || ''} onChange={(event) => updateSectionList('work', 'cards', index, { title: event.target.value })} maxLength={40} /></label><label>一句话说明<input value={card.desc || ''} onChange={(event) => updateSectionList('work', 'cards', index, { desc: event.target.value })} maxLength={120} /></label><label>配图地址<input value={card.imageUrl || ''} onChange={(event) => updateSectionList('work', 'cards', index, { imageUrl: event.target.value })} /></label><label>配图说明<input value={card.imageAlt || ''} onChange={(event) => updateSectionList('work', 'cards', index, { imageAlt: event.target.value })} maxLength={160} /></label></div>
              <div className="row-actions top-gap"><label className="inline-file-upload">{uploading === `hb-card-${index}` ? '上传中…' : '上传配图'}<input type="file" accept="image/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadImage(file, (url) => updateSectionList('work', 'cards', index, { imageUrl: url }), `hb-card-${index}`); }} /></label></div>
            </div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={() => addSectionList('work', 'cards', { title: '', desc: '', imageUrl: '', imageAlt: '' })}>新增卡片</button>
            {/* 「政策」一栏（2026-09-28）：地区卡，按地区排。字段 = 地区 / 文件全名 / 一行注 / 卡片图。
                ⚠️ 卡片图是**公告截图的裁切版**（1200×676，官网按 16:9 铺满、从顶部对齐），
                   换图要重裁 —— 直接丢一张竖图进来会被裁得只剩中间一条。 */}
            <div className="cms-section-heading top-gap"><strong>政策一栏（地区卡）</strong><span>角标 + 两行标题 + 正文；下面每张卡 = 一个地区，卡片图建议 1200×676</span></div>
            <div className="form-grid">
              <label>眉题<input value={policyBlock.eyebrow || ''} onChange={(event) => updatePolicy({ eyebrow: event.target.value })} maxLength={24} placeholder="例如 政策" /></label>
              <label>标题第 1 行<input value={cmsListOf(policyBlock.headingLines)[0] || ''} onChange={(event) => updatePolicy({ headingLines: [event.target.value, cmsListOf(policyBlock.headingLines)[1] || ''] })} maxLength={30} /></label>
              <label>标题第 2 行<input value={cmsListOf(policyBlock.headingLines)[1] || ''} onChange={(event) => updatePolicy({ headingLines: [cmsListOf(policyBlock.headingLines)[0] || '', event.target.value] })} maxLength={30} /></label>
            </div>
            <label>正文<textarea value={policyBlock.body || ''} onChange={(event) => updatePolicy({ body: event.target.value })} maxLength={800} /></label>
            <div className="cms-faq-list">{policyCards.map((card, index) => <div className="cms-faq-item" key={`hb-policy-${index}`}><div className="cms-faq-heading"><strong>{(card.region || '未填地区')} · 第 {index + 1} 张</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => movePolicyCard(index, -1)} aria-label={`第 ${index + 1} 张上移`}>↑</button><button type="button" className="text-button" disabled={index === policyCards.length - 1} onClick={() => movePolicyCard(index, 1)} aria-label={`第 ${index + 1} 张下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removePolicyCard(index)}>删除</button></div></div>
              <div className="form-grid"><label>地区<input value={card.region || ''} onChange={(event) => updatePolicyCard(index, { region: event.target.value })} maxLength={12} placeholder="例如 北京" /></label><label>文件全名<input value={card.title || ''} onChange={(event) => updatePolicyCard(index, { title: event.target.value })} maxLength={120} /></label><label>一行注（时间 · 编号或要点）<input value={card.note || ''} onChange={(event) => updatePolicyCard(index, { note: event.target.value })} maxLength={80} /></label><label>卡片图地址<input value={card.imageUrl || ''} onChange={(event) => updatePolicyCard(index, { imageUrl: event.target.value })} /></label><label>图说（无障碍用）<input value={card.imageAlt || ''} onChange={(event) => updatePolicyCard(index, { imageAlt: event.target.value })} maxLength={160} /></label></div>
              <div className="row-actions top-gap"><label className="inline-file-upload">{uploading === `hb-policy-${index}` ? '上传中…' : '上传卡片图'}<input type="file" accept="image/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadImage(file, (url) => updatePolicyCard(index, { imageUrl: url }), `hb-policy-${index}`); }} /></label></div>
            </div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={addPolicyCard}>新增地区</button>
            {/* 「跨学科知识融合，综合能力培养」（2026-09-28）：两列 —— 学科表 + 能力清单，全是文字。 */}
            <div className="cms-section-heading top-gap"><strong>跨学科与综合能力一栏</strong><span>左：学科领域 / 具体知识点；右：能力清单（带序号）。全文字，没有配图</span></div>
            <div className="form-grid">
              <label>眉题<input value={skillsBlock.eyebrow || ''} onChange={(event) => updateSkills({ eyebrow: event.target.value })} maxLength={24} placeholder="例如 跨学科 · 综合能力" /></label>
              <label>标题第 1 行<input value={cmsListOf(skillsBlock.headingLines)[0] || ''} onChange={(event) => updateSkills({ headingLines: [event.target.value, cmsListOf(skillsBlock.headingLines)[1] || ''] })} maxLength={30} /></label>
              <label>标题第 2 行<input value={cmsListOf(skillsBlock.headingLines)[1] || ''} onChange={(event) => updateSkills({ headingLines: [cmsListOf(skillsBlock.headingLines)[0] || '', event.target.value] })} maxLength={30} /></label>
            </div>
            <label>导语<textarea value={skillsBlock.intro || ''} onChange={(event) => updateSkills({ intro: event.target.value })} maxLength={400} /></label>
            <div className="cms-section-heading top-gap"><strong>左列：学科领域 / 具体知识点</strong><span>逐行一条；窄屏会自动折成一列</span></div>
            <div className="cms-faq-list">{skillSubjects.map((row, index) => <div className="cms-faq-item" key={`hb-subject-${index}`}><div className="cms-faq-heading"><strong>{(row.subject || '未填学科')} · 第 {index + 1} 条</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveSkillSubject(index, -1)} aria-label={`第 ${index + 1} 条上移`}>↑</button><button type="button" className="text-button" disabled={index === skillSubjects.length - 1} onClick={() => moveSkillSubject(index, 1)} aria-label={`第 ${index + 1} 条下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeSkillSubject(index)}>删除</button></div></div>
              <div className="form-grid"><label>学科领域<input value={row.subject || ''} onChange={(event) => updateSkillSubject(index, { subject: event.target.value })} maxLength={20} placeholder="例如 语文" /></label><label>具体知识点<input value={row.points || ''} onChange={(event) => updateSkillSubject(index, { points: event.target.value })} maxLength={120} /></label></div>
            </div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={addSkillSubject}>新增学科</button>
            <div className="cms-section-heading top-gap"><strong>右列：综合能力清单</strong><span>标题 + 一句话说明；官网按顺序带序号</span></div>
            <div className="cms-faq-list">{skillAbilities.map((item, index) => <div className="cms-faq-item" key={`hb-ability-${index}`}><div className="cms-faq-heading"><strong>能力 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveSkillAbility(index, -1)} aria-label={`能力 ${index + 1} 上移`}>↑</button><button type="button" className="text-button" disabled={index === skillAbilities.length - 1} onClick={() => moveSkillAbility(index, 1)} aria-label={`能力 ${index + 1} 下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeSkillAbility(index)}>删除</button></div></div>
              <div className="form-grid"><label>标题<input value={item.title || ''} onChange={(event) => updateSkillAbility(index, { title: event.target.value })} maxLength={40} /></label><label>一句话说明<input value={item.desc || ''} onChange={(event) => updateSkillAbility(index, { desc: event.target.value })} maxLength={160} /></label></div>
            </div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={addSkillAbility}>新增能力</button>
            <div className="cms-section-heading top-gap"><strong>对比区（粒子背景）</strong><span>眉题 + 两行标题（第 2 行描边）+ 正文</span></div>
            <div className="form-grid">
              <label>眉题<input value={structured?.compare?.eyebrow || ''} onChange={(event) => updateSection('compare', { eyebrow: event.target.value })} maxLength={24} /></label>
              <label>标题第 1 行<input value={cmsListOf(structured?.compare?.headingLines)[0] || ''} onChange={(event) => updateSectionLine('compare', 'headingLines', 0, event.target.value)} maxLength={30} /></label>
              <label>标题第 2 行（描边）<input value={cmsListOf(structured?.compare?.headingLines)[1] || ''} onChange={(event) => updateSectionLine('compare', 'headingLines', 1, event.target.value)} maxLength={30} /></label>
            </div>
            <label>正文<textarea value={structured?.compare?.body || ''} onChange={(event) => updateSection('compare', { body: event.target.value })} maxLength={800} /></label>
            <div className="cms-section-heading top-gap"><strong>结尾行动</strong><span>大标题 + 说明（按钮与联系方式由官网统一）</span></div>
            <div className="form-grid"><label>标题<input value={structured?.cta?.headline || ''} onChange={(event) => updateSection('cta', { headline: event.target.value })} maxLength={40} /></label><label>说明<input value={structured?.cta?.text || ''} onChange={(event) => updateSection('cta', { text: event.target.value })} maxLength={200} /></label></div>
          </div>}
          </fieldset>
          <div className="cms-preview-wrap"><div className="cms-section-heading"><strong>草稿预览</strong><span>未保存内容仅在本页预览</span></div><WebsitePreview content={preview} selectedKey={selectedKey} /></div>
          <details className="cms-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary>高级 JSON 编辑（其他区块或复杂字段）</summary><label>JSON 内容<textarea className="cms-editor" value={draft} disabled={busy} aria-invalid={!valid} aria-describedby={!valid ? 'cms-json-error' : undefined} onChange={(event) => keepDraft(event.target.value, parseWebsiteDraft(event.target.value))} spellCheck="false" aria-label={`${selectedKey} JSON 内容`} /></label></details>
          <div className="row-actions top-gap"><button className="primary-button" disabled={busy || !valid || !dirty} onClick={saveDraft}>保存草稿</button><button className="secondary-button" disabled={busy || !valid || dirty || !detail.data} onClick={publish}>发布</button></div>
          <div className="top-gap"><strong>历史版本</strong><div className="card-list top-gap">{(detail.data?.revisions || []).map((revision) => <div className="cms-revision" key={`${revision.key}-${revision.version}`}><span>v{revision.version} · {revision.action} · {formatDate(revision.createdAt)}</span><button className="text-button" disabled={busy || revision.version === detail.data?.publishedVersion} onClick={() => rollback(revision.version)}>回滚并发布</button></div>)}</div></div>
        </>}
      </Panel>
    </div>
  </>;
}

