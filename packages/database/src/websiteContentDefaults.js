/**
 * 官网内容（website_contents）的默认内容 —— 官网在没有后台编辑时看到的那一份。
 *
 * 为什么单独成一个文件：有两处要用它，而且必须完全一致：
 *   ① packages/database/src/seed.js —— 全新库初始化；
 *   ② deploy/production/migrate-website-content-20260918.mjs —— 存量生产库补种
 *      （seed 的 ensureWebsiteContent() 是 insert-only：库里已有那一行就再也不动它，
 *       所以改种子对生产库里已落库的 HOME/FAQ/BRAND 完全无效）。
 * 这里只放**纯数据**、不 import 任何模块，数据库初始化脚本与迁移脚本都能安全引用。
 */
export const WEBSITE_CONTENT_DEFAULTS = {
  // ⚠️ HOME 的文案必须与官网代码里的兜底 `CMS_FALLBACK.HOME`（apps/website/src/main.jsx）**逐字一致**：
  //    这一份是「后台还没编辑过时官网显示什么」，那一份是「公开接口挂掉时官网显示什么」，
  //    两者不一致 = 同一页面会因为**接口通/断显示两套内容**（口径①，见第十六轮交接文档）。
  //    scripts/p115-website-ui-check.mjs 会把两条路径各渲染一遍逐字对比，别让它们漂开。
  //    2026-09-18 修正：这里原来还留着更早的营销文案（「给机构一套 / 能落地的青少年 AI 课」
  //    与「响应教育部…领航行动」）。用户在 CMS 里换掉之后，代码兜底对齐了、**这一份没对齐** ——
  //    而 seed 是 insert-only 且直接把 published_content 写进去，于是**任何新库/新环境上线即带退役文案**。
  HOME: {
    heroKicker: '',
    heroTitle: '培养青少年Ai思维',
    heroAccent: '掌握Ai时代的创造方式',
    heroDescription: 'AI 画布创作 + Vibe Coding 对话编程，从兴趣到独立创作',
    trustTitle: '',
    trustDescription: '',
    // 首页底部数据区（官网首页从 CMS 读 stats，后台「官网内容 → 首页」可改）
    // ⚠️ 与代码里的 HOME_STATS_FALLBACK / CMS_FALLBACK.HOME.stats 必须是同一组数字。
    //    这一组（3 门 / 48 节）是 2026-09-18 晚**打线上真浏览器量出来的**线上 CMS 现值 ——
    //    判断哪一组对只能这么量：本地守卫跑的是全新种子库，看不见生产 CMS 里那份数字。
    //    注：/org 与 /demo 的硬编码文案写的是「11 门 / 87 节」，与线上 CMS 不一致，已在交接文档记录。
    stats: [
      { icon: '◆', value: 3, suffix: ' 门', label: '标准课包' },
      { icon: '◇', value: 48, suffix: ' 节', label: '课时总量' },
      { icon: '✧', value: 2, suffix: ' 类', label: '课堂形式' },
      { icon: '⌘', value: 1, suffix: ' 套', label: '机构工作台' },
    ],
  },
  // 常见问题（/faq）：**按端分三档**（2026-09-18 晚用户口径：「最好3个选项，学生端、老师端、机构端，
  // 可以配置3个端的不同的问题。后台配置也要对应配置」）。字段名就是档位 key，数组顺序 = 官网显示顺序；
  // 档位名字（学生端/老师端/机构端）写在官网代码里，不由 CMS 改 —— 免得运营改出与后台表单对不上的标签。
  // ⚠️ `student` 这一档必须与官网兜底 `CMS_FALLBACK.FAQ.student` **逐字一致**（口径①：接口通/断不能
  //    显示两套内容），而且这里取的是**生产 CMS 里已发布的原文**（2026-09-18 晚从线上接口抄回）。
  //    这正是 HOME 那条教训的重演：兜底对齐了、种子没对齐 → 新库/新环境上线就带另一套文案。
  // ⚠️ `teacher` / `org` 两档是**我起草的初稿**（只陈述平台既有行为，不编功能），等运营在后台
  //    「官网内容 → 常见问题」里按自己的口径改；改完官网即生效（后台保存 → 发布）。
  //    改这两档时**记得同时改官网兜底**，否则接口一断就露出另一套文案。
  FAQ: {
    // 档位的**显示顺序**（2026-09-19 用户口径：「这 3 个标签可以在后台排序优先级，优先级高的排在最前面」）。
    // 后台「官网内容 → 常见问题」用上移/下移改它；官网按它排 tab，没配才用代码里的默认顺序。
    // ⚠️ 某一档的问题**全部删光 = 官网不显示那一档**（用户口径「没有内容就隐藏，有内容才出现」），
    //    所以这里写成空数组是有意义的，不是漏写。
    audienceOrder: ['student', 'teacher', 'org'],
    student: [
      { question: '需要学员自备 API Key 或对话平台账号吗？', answer: '不需要。机构账号登录即可使用平台统一模型能力。' },
      { question: '机房和教室的电脑都能用吗？', answer: '可以，公开客户端支持 macOS Apple 芯片版与 Windows 64 位。' },
      { question: '能否做 Arduino 和 micro:bit 硬件课？', answer: '支持 Arduino Uno 与 micro:bit 的课堂实践。' },
      { question: '机构的授权次数用完了会怎样？', answer: '机构端会提示老师补足授权次数，补足后学生即可继续上课；平台不会因为算力用量去拦学生。' },
    ],
    teacher: [
      { question: '上课前需要做什么准备？', answer: '学生用机构账号登录，浏览器打开课堂即可开始；机房电脑不需要额外安装环境。' },
      { question: '学生的作品和用量在哪里看？', answer: '机构后台可以查看学生的用量记录与作品，并把优秀作品发布到作品展厅。' },
    ],
    org: [
      { question: '学生需要自己买账号或自备 API Key 吗？', answer: '不需要。机构账号分级，学员无需自备 Key，由机构统一开通与管理。' },
      { question: '平台提供哪些课程？', answer: '课程中心提供标准课包（含 PPT 与 HTML 互动课件），机构可按课包直接排课。' },
    ],
  },
  // 灵动介绍（/intro）：面向「平台是什么、谁得到什么」，字段形状与官网 CmsSections 一致
  INTRO: {
    title: '灵动介绍',
    lead: '灵动ai学院是面向 8–16 岁的 AI 创作开课平台：学生用中文与 AI 伙伴「阿飞」对话，当堂做出能运行、能展示的作品；机构拿到的是课程、账号、授权次数与作品一整套可复制的交付。',
    highlights: [
      { title: '创作', desc: '对话、写代码、做网页，同一个桌面端完成；当堂见作品。' },
      { title: '开课', desc: '课程中心标准课包，课时与课件一体，老师不必自建教案。' },
      { title: '运营', desc: '机构账号分级、授权次数按班分配、作品展厅与用量记录，校区可复制。' },
    ],
    sections: [
      { title: '孩子在这里做什么', body: '用中文描述想法，AI 伙伴「阿飞」把它变成能运行的作品：小游戏、互动故事、动画、互动网页与开源硬件项目。作品留在平台的作品展厅，家长看得见「做出来了什么」。' },
      { title: '老师在这里做什么', body: '从课程中心按课包授课，课时、课件与提示词都已备好；课堂上老师带节奏、看过程，不必先把自己变成提示词工程师。' },
      { title: '机构在这里做什么', body: '开通机构账号、按班分配授权次数、查看用量与作品，把「一门 AI 课」变成能复制的校区产品。' },
      { title: '为什么不是一个对话网站', body: '通用对话工具解决「聊」，课堂要解决「管」：账号怎么开、用量怎么算、课怎么交付、作品怎么沉淀。这几件事在同一套平台里闭环，才谈得上开班。' },
      { title: '两类课堂，一个入口', body: '画布课堂适合低门槛、当堂出作品的创作；VibeCoding 课堂适合让 AI 真正把代码跑起来、自己看效果再改。学生从「灵动学习」进入，先选课包，再进这一节课。' },
    ],
    cta: { title: '把 AI 课开起来', text: '联系我们，我们会按你的班型给出课包与开通方案。' },
  },
  // 机构手册（/handbook）：正文按用户给的另一家平台手册（7 张图）改写，只保留我们平台真有的能力；
  // 涉及具体数字、政策文件名称与配图的，都留成后台可改的字段，不在这里写死。
  HANDBOOK: {
    // 2026-09-19 按用户给的设计稿（design (1).zip）重做：整页换成
    // 「主视觉 + 关于 + 海报 + 横滑卡片 + 对比 + 结尾行动」。
    // ⚠️ 与官网代码里的 CMS_FALLBACK.HANDBOOK（apps/website/src/main.jsx）**逐字一致**（口径①：
    //    接口通/断不能显示两套内容）。
    // ⚠️ 图都在 apps/website/public/assets/handbook/（自托管）—— 别换成外域地址：
    //    生产 CSP 与「不把访客 IP 带给外域」那条口径都不允许。
    // ⚠️ 带 Lines 的字段是**多行标题**（字符串数组，不是带换行的字符串）：
    //    按设计稿，**第 2 行**描边显示（CSS 的 .hb-outline）。
    hero: { line1: '让AI创作课、编程课', line2: '真正进课堂', imageUrl: '/assets/handbook/hero.webp', imageAlt: '暗色科技氛围中的创作路径主视觉' },
    about: {
      index: '01 / 关于',
      headingLines: ['从试点走向普及，', '机构需要的不只是工具'],
      body: '国家和教育部门连续推动中小学人工智能教育，课程要能开齐开足，生成式AI要可用、可管。机构真正需要的是：能进课表、能管住账号与用量、每节课都有作品的完整方案。',
      imageUrl: '/assets/handbook/about.webp',
      imageAlt: 'AI 创意思维与数据面板',
    },
    // 用户 2026-09-19：「图1可以找个合适的放」。这张是**信息图**（字很密），
    // 所以放在纸色底上整张显示（不裁不灰），点开可看大图。
    poster: {
      eyebrow: '一页看懂',
      title: '为什么现在就是开 AI 课的好时机',
      caption: '政策、家长认知、市场供给与窗口期判断 —— 一页看完。',
      imageUrl: '/assets/handbook/poster.webp',
      imageAlt: 'AI 时代的孩子从这里起步：政策层面 / 家长认知 / 市场供给 / 窗口期判断',
    },
    work: {
      introLines: ['开课管课', '沉作品', '一体化交付'],
      cards: [
        { title: '中文对话创作', desc: '学生与 AI 伙伴「阿飞」对话，做出可运行的作品', imageUrl: '/assets/handbook/card-1.webp', imageAlt: '学生在 AI 辅助下创作' },
        { title: '课堂即开即用', desc: '标准课包与互动课件直接进课堂', imageUrl: '/assets/handbook/card-2.webp', imageAlt: '课件与课堂流程' },
        { title: '账号用量可控', desc: '分级账号、授权次数、用量记录', imageUrl: '/assets/handbook/card-3.webp', imageAlt: '统一平台下的多端能力' },
        { title: '作品进展厅', desc: '校区案例库与招生素材自动沉淀', imageUrl: '/assets/handbook/card-4.webp', imageAlt: '作品与案例展台' },
        { title: '体验课转正班', desc: '90 分钟出作品，家长当场看得见', imageUrl: '/assets/handbook/card-5.webp', imageAlt: '一步一步的成长路径' },
      ],
    },
    compare: {
      eyebrow: '对比',
      headingLines: ['别再', '东拼西凑'],
      body: '对话用一家、写代码换一个编译器、课件散在网盘和群聊里——老师每换一门课就要重新教学生用哪个网站。灵动AI课堂把对话创作、代码运行、课件管理、作品沉淀整合在同一平台。',
    },
    cta: { headline: '把 AI 课开起来', text: '联系我们，我们会按你的班型给出课包与开通方案。' },
  },
  // 灵动课程（/marketplace）的页头：大标题 + 副标题。用户在后台「官网内容 → 灵动课程」可改
  // （用户口径 2026-09-18 晚：这两句要能后台配置）。
  // ⚠️ 与官网代码里的 CMS_FALLBACK.MARKETPLACE（apps/website/src/main.jsx）保持一致（口径①）。
  MARKETPLACE: {
    title: '灵动Ai学院课包展示',
    lead: '灵动Ai坚持自研国内精品Ai课程，持续探索适合青少年Ai培训体系。',
  },
  BRAND: { name: '灵动ai学院', tagline: '青少年 AI 创作开课平台', contactEmail: 'hello@aimagc.cn' }
};
