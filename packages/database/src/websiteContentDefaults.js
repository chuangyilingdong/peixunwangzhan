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
      // icon 是**图标名**（见 apps/website/src/main.jsx 的 HOME_STAT_ICONS）；
      // 老库里那几个字符（◆ ◇ ✧ ⌘）也认，会映射到同样的图标 —— 不用迁移数据。
      { icon: 'package', value: 3, suffix: ' 门', label: '标准课包' },
      { icon: 'lessons', value: 48, suffix: ' 节', label: '课时总量' },
      { icon: 'format', value: 2, suffix: ' 类', label: '课堂形式' },
      { icon: 'console', value: 1, suffix: ' 套', label: '机构工作台' },
    ],
    // 首页「三步一栏」（2026-09-23 用户口径：「在官网页脚上方做一栏。文字和图片都可以在后台可以配置」）。
    // 参考稿是 AdGen AI 的 HowItWorks 三段（暗底 + 三张卡片 + 红色高光）。
    // ⚠️ 这一份必须与 `packages/shared/src/siteDefaults.js` 的 HOME_STEPS_DEFAULT **逐字一致**
    //    （那一份是官网兜底与后台表单预填共用的；本文件要零依赖、不能 import 它，所以手抄一份）。
    //    守卫 scripts/p135-home-steps-band.mjs 会逐字段比对这两份 —— 别只改一边。
    // ⚠️ 配图默认留空：官网画一个占位（不显示破图），运营在后台「上传图片」之后换成真图。
    steps: {
      title: '三步，把 AI 创作课开进课堂',
      lead: '从开通机构到学生交出作品，中间不需要技术团队，学生也不用自备账号或 API Key。',
      items: [
        {
          number: '01',
          title: '开通机构与账号',
          desc: '配置席位与授权次数，创建老师与学生账号。学生用机构账号登录，无需自备 API Key。',
          imageUrl: '',
          imageAlt: '',
        },
        {
          number: '02',
          title: '按课包直接排课',
          desc: '课程中心提供标准课包与课件，老师选课即用；课堂零配置，机房电脑打开就能上。',
          imageUrl: '',
          imageAlt: '',
        },
        {
          number: '03',
          title: '当堂出作品、沉淀展厅',
          desc: '学生每节课都用 AI 做出可展示的作品，提交后进入作品展厅，形成校区的案例库与招生素材。',
          imageUrl: '',
          imageAlt: '',
        },
      ],
    },
    // 首页第二屏「视频展示」（2026-09-26 用户口径：「做官网的第二屏，放在第一屏下方，后台可配置视频，
    // 我要上传多个视频来展示，文案也要可配置」）。
    // ⚠️ 这一份必须与 `packages/shared/src/siteDefaults.js` 的 HOME_VIDEOS_DEFAULT **逐字段一致**
    //    （那一份是官网兜底与后台表单预填共用的；本文件要零依赖、不能 import 它，所以手抄一份）。
    //    守卫 scripts/p147-home-videos-band.mjs 会比对这两份 —— 别只改一边。
    // **把 items 删空 = 官网不显示这一屏**；默认就是空的（视频由运营自己传，仓库不预置素材）。
    videos: {
      title: '课堂里真实做出来的东西',
      lead: '一节课一件作品：点开就是学生自己动手做出来的样子。',
      items: [],
    },
    // 首页「合作品牌」一屏（2026-10-03 用户口径：「在灵动AI，让每个少年都成为创造者下方一屏插入……
    // 这个是合作品牌的一屏，可以后台配置」）。位置：官网首页**第一屏下方、视频屏上方**。
    // ⚠️ 这一份必须与 `packages/shared/src/siteDefaults.js` 的 HOME_BRANDS_DEFAULT **逐字段一致**
    //    （那一份是官网兜底与后台表单预填共用的；本文件要零依赖、不能 import 它，所以手抄一份）。
    //    守卫 scripts/p184-home-brands-band.mjs 会比对这两份 —— 别只改一边。
    // ⚠️ 默认**全空**：合作品牌与那些数字是机构自己的事实，平台不编（参考稿里那 7 个品牌是别家的）。
    //    **一条品牌都没有 = 官网不显示这一屏**（与视频屏同一条口径）；后台点「填入示例品牌」看排版。
    brands: {
      title: '',
      metric: { value: '', suffix: '', label: '' },
      rating: { score: '', count: '', note: '' },
      avatars: [],
      logos: [],
    },
    // 首页「对比一栏」（2026-09-25 用户口径：「在官网首页页脚上面加一个以上代码的页面，后台可以配置」，
    // 参考稿是 Codecraft AI 的对比区：暗底 + 打字标题 + 高亮词 + 一正一反两张卡片）。
    // ⚠️ 这一份必须与 `packages/shared/src/siteDefaults.js` 的 HOME_COMPARE_DEFAULT **逐字一致**
    //    （那一份是官网兜底与后台表单预填共用的；本文件要零依赖、不能 import 它，所以手抄一份）。
    //    守卫 scripts/p142-home-compare-band.mjs 会逐字段比对这两份 —— 别只改一边。
    // tone: 'without' 负面那张 / 'with' 正面那张（决定配色与图标）；items 一行一条。
    // **把 cards 删空 = 官网不显示这一栏**（与 stats / steps 同一条口径）。
    compare: {
      title: '同样的 AI 课，两种上法。',
      highlight: '两种上法',
      lead: '工具、环境、账号、作品都交给平台，老师只负责教。',
      cards: [
        {
          tone: 'without',
          title: '分散拼凑',
          items: [
            '多个网站 / App 来回切换，课堂节奏被打断',
            '学生各自注册账号、自备 API Key，难管也易泄露',
            '课件与素材靠老师手工准备，每节课都要重来',
            '作品散落在群聊和个人电脑里，留不下来',
            '出问题现场排查，老师被迫当技术员',
            '校区之间无法复用，新老师从零开始',
          ],
        },
        {
          tone: 'with',
          title: '用灵动ai',
          items: [
            '同一个工作台里完成：对话 + 预览 + 项目文件',
            '机构统一开通账号与授权次数，学生无需自备 Key',
            '标准课包与课件选课即用，课堂零配置',
            '作品当堂提交、进作品展厅，形成校区案例库',
            '用量与算力有记录、有提醒，成本看得见',
            '一套流程可复制到每个校区、每位新老师',
          ],
        },
      ],
    },
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
      { question: '需要学生自备 API Key 或对话平台账号吗？', answer: '不需要。机构账号登录即可使用平台统一模型能力。' },
      { question: '机房和教室的电脑都能用吗？', answer: '可以，公开客户端支持 macOS Apple 芯片版与 Windows 64 位。' },
      { question: '能否做 Arduino 和 micro:bit 硬件课？', answer: '支持 Arduino Uno 与 micro:bit 的课堂实践。' },
      { question: '机构的授权次数用完了会怎样？', answer: '机构端会提示老师补足授权次数，补足后学生即可继续上课；平台不会因为算力用量去拦学生。' },
    ],
    teacher: [
      { question: '上课前需要做什么准备？', answer: '学生用机构账号登录，浏览器打开课堂即可开始；机房电脑不需要额外安装环境。' },
      { question: '学生的作品和用量在哪里看？', answer: '机构后台可以查看学生的用量记录与作品，并把优秀作品发布到作品展厅。' },
    ],
    org: [
      { question: '学生需要自己买账号或自备 API Key 吗？', answer: '不需要。机构账号分级，学生无需自备 Key，由机构统一开通与管理。' },
      { question: '平台提供哪些课程？', answer: '课程中心提供标准课包（含 PPT 与 HTML 互动课件），机构可按课包直接排课。' },
    ],
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
    // loaderWord = 进场幕布上那行字（用户 2026-09-19：原来是「开课」，改成这句）。
    hero: { line1: '让AI创作课、编程课', line2: '真正进课堂', loaderWord: '让Ai真正进入课堂', imageUrl: '/assets/handbook/hero.webp', imageAlt: '暗色科技氛围中的创作路径主视觉' },
    about: {
      index: '01 / 关于',
      headingLines: ['从试点走向普及，', '机构需要的不只是工具'],
      body: '国家和教育部门连续推动中小学人工智能教育，课程要能开齐开足，生成式AI要可用、可管。机构真正需要的是：能进课表、能管住账号与用量、每节课都有作品的完整方案。',
      imageUrl: '/assets/handbook/about.webp',
      imageAlt: 'AI 创意思维与数据面板',
    },
    // 「政策」一栏（2026-09-28 用户口径：给了各地公告截图，形状定成**地区卡（按地区排）**）。
    // ⚠️ 与 `packages/shared/src/siteDefaults.js` 的 `HANDBOOK_POLICY_DEFAULT` **逐字段一致**
    //    （守卫 `scripts/p162-handbook-policy.mjs` 钉着）：那份供官网兜底与后台表单预填。
    // 顺序：先「北上广深浙」（率先落地），再其余地区按发布时间排 —— 与用户给材料时的分组一致。
    policy: {
      eyebrow: '政策',
      headingLines: ['国家在推，', '各地都在落'],
      body: '教育部办公厅印发《关于加强中小学人工智能教育的通知》之后，北京、上海、广东、深圳、浙江率先落地，江苏、山东、天津、福建、重庆、西安等地陆续跟进，都把人工智能课写进了中小学课表。下面是各地已公开的文件。',
      cards: [
        { region: '北京', title: '《北京市推进中小学人工智能教育工作方案（2025—2027年）》', note: '2025-03-08 · 2025 年秋季学期起每学年不少于 8 课时', imageUrl: '/assets/handbook/policy-beijing.webp', imageAlt: '北京市推进中小学人工智能教育工作方案（2025—2027年）公告' },
        { region: '上海', title: '《上海市推进实施人工智能赋能基础教育高质量发展的行动方案（2024—2026年）》', note: '2024-10-09 · 上海市教育委员会', imageUrl: '/assets/handbook/policy-shanghai.webp', imageAlt: '上海市推进实施人工智能赋能基础教育高质量发展的行动方案（2024—2026年）通知' },
        { region: '广东', title: '《广东省基础教育课程教学改革深化行动实施方案（2024—2027年）》', note: '2024-07-25 · 广东省教育厅', imageUrl: '/assets/handbook/policy-guangdong.webp', imageAlt: '广东省基础教育课程教学改革深化行动实施方案（2024—2027年）通知' },
        { region: '深圳', title: '《深圳市推进中小学人工智能教育工作方案》', note: '2024-11-20 · 立体化场景建设与应用', imageUrl: '/assets/handbook/policy-shenzhen.webp', imageAlt: '深圳市推进中小学人工智能教育工作方案问答' },
        { region: '浙江', title: '《浙江省推进"人工智能+教育"行动方案（2025—2029年）》', note: '2025-04-29 · 浙教技〔2025〕24号', imageUrl: '/assets/handbook/policy-zhejiang.webp', imageAlt: '浙江省推进"人工智能+教育"行动方案（2025—2029年）通知' },
        { region: '天津', title: '《关于加强中小学人工智能教育的实施意见（试行）》', note: '2025-03-31 · 津教政办〔2025〕33号', imageUrl: '/assets/handbook/policy-tianjin.webp', imageAlt: '天津市关于加强中小学人工智能教育的实施意见（试行）通知' },
        { region: '重庆', title: '《关于加快推进人工智能赋能职业院校关键办学能力提升的通知》', note: '2025-05-07 · 重庆市教委', imageUrl: '/assets/handbook/policy-chongqing.webp', imageAlt: '重庆市加快推进人工智能赋能职业院校关键办学能力提升的通知' },
        { region: '江苏', title: '《人工智能赋能教育高质量发展行动方案（2025—2027年）》', note: '2025-05-09 · 苏教高〔2025〕1号', imageUrl: '/assets/handbook/policy-jiangsu.webp', imageAlt: '江苏省人工智能赋能教育高质量发展行动方案（2025—2027年）通知' },
        { region: '福建', title: '《关于推进"人工智能+教育"十条措施的通知》', note: '2025-06-20 · 闽教科〔2025〕7号', imageUrl: '/assets/handbook/policy-fujian.webp', imageAlt: '福建省关于推进"人工智能+教育"十条措施的通知' },
        { region: '山东', title: '《山东省"人工智能+教育"实施方案》', note: '2025-07-03 · 鲁教数字〔2025〕2号', imageUrl: '/assets/handbook/policy-shandong.webp', imageAlt: '山东省"人工智能+教育"实施方案通知' },
        { region: '西安', title: '《西安市推进中小学人工智能教育专项行动方案（2025—2027年）》', note: '2025-08-05 · 西安市教育局', imageUrl: '/assets/handbook/policy-xian.webp', imageAlt: '西安市推进中小学人工智能教育专项行动方案（2025—2027年）' },
      ],
    },
    // 「跨学科知识融合，综合能力培养」一栏（2026-09-28 用户口径：加在海报那段**上方**）。
    // ⚠️ 与 `packages/shared/src/siteDefaults.js` 的 `HANDBOOK_SKILLS_DEFAULT` **逐字段一致**
    //    （守卫 `scripts/p164-handbook-skills.mjs` 钉着）：那份供官网兜底与后台表单预填。
    // 内容是**真正排出来的文字**（学科表 + 能力清单），不是图片 —— 所以这里只有文字，没有 imageUrl。
    skills: {
      eyebrow: '跨学科 · 综合能力',
      headingLines: ['跨学科知识融合，', '综合能力培养'],
      intro: '一节课里同时用到语文、美术、信息技术、逻辑数学与音乐 —— 知识点不是背下来的，是用出来的。',
      subjects: [
        { subject: '语文', points: '故事结构（起承转合）、人物对话、描写细节' },
        { subject: '美术', points: '色彩、构图、光影、风格（写实 / 卡通 / 水墨）' },
        { subject: '信息技术', points: 'AI 基本原理（训练数据、生成机制）、参数调节、文件管理' },
        { subject: '逻辑与数学', points: '序列顺序、因果关系、时间轴控制' },
        { subject: '音乐 / 节奏', points: '配乐情绪匹配、音效时机' },
      ],
      abilities: [
        { title: '从"被动消费"到"主动创造"', desc: '孩子不再只是刷视频，而是能自己做一个视频表达想法。' },
        { title: '分解复杂任务的能力', desc: '一个 AI 视频 ＝ 写文案 → 生图 → 生视频 → 剪辑，学会把大目标拆成小步骤。' },
        { title: '与 AI 协作的习惯', desc: '不是"让 AI 帮我做作业"，而是"我指挥 AI，我来把关"。' },
        { title: '成长型思维', desc: '生成结果不完美 → 修改提示词 → 变好一点 → 再试。失败是迭代的一部分。' },
      ],
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
    // 结尾行动：大标题 + 说明 + 按钮。按钮的**文案与去向**也能后台配（2026-09-19 用户口径：
    // 「改成：点击进入常见问题，跳转到常见问题页面」）—— buttonTo 写站内路径，例如 /faq。
    cta: { headline: '把 AI 课开起来', text: '联系我们，我们会按你的班型给出课包与开通方案。', buttonLabel: '点击进入常见问题', buttonTo: '/faq' },
  },
  // 灵动课程（/marketplace）的页头：大标题 + 副标题。用户在后台「官网内容 → 灵动课程」可改
  // （用户口径 2026-09-18 晚：这两句要能后台配置）。
  // ⚠️ 与官网代码里的 CMS_FALLBACK.MARKETPLACE（apps/website/src/main.jsx）保持一致（口径①）。
  MARKETPLACE: {
    title: '灵动Ai学院课包展示',
    lead: '灵动Ai坚持自研国内精品Ai课程，持续探索适合青少年Ai培训体系。',
  },
  BRAND: { name: '灵动ai学院', tagline: '青少年 AI 创作开课平台', contactEmail: 'hello@aimagc.cn' },
  // 「联系我们」（/demo）页上的联系方式（2026-09-27 用户口径：「直接显示姓名电话微信二维码，后台可配置」）——
  // 原来那一页是个**表单**（填机构 / 联系人 / 电话 → 提交线索），现在改成直接展示。
  // 2026-09-28 用户口径（第二轮）：这一页**只留卡片**（页头大标题与「你将获得」清单整块删掉），
  // 而且卡片要能**在后台加**（一页放好几张）→ `contacts` 数组；老形状四个扁平字段仍然认（见下面共享的那份注释）。
  // ⚠️ 与 `packages/shared/src/siteDefaults.js` 的 `CONTACT_DEFAULT` **逐字一致**（守卫 p156 钉着）。
  CONTACT: {
    contacts: [],
    name: '',
    phone: '',
    wechatQrUrl: '',
    note: '加微信时请备注机构名称，我们会尽快安排演示与资料。',
  }
};
