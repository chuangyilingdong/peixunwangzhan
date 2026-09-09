/**
 * 官网内容（website_contents）的 key 白名单与内置默认内容。
 *
 * 为什么默认内容放服务端：
 *   - 老库里没有 COURSES 行时，公开接口要能返回与当前官网一致的课程页内容（不用等运营发布）；
 *   - 管理端详情也要能预填这份内容，运营改完保存 → 发布即可生效。
 * 注意：官网 bundle 里 packages/shared 无法引用本文件（生产发布只拷贝 packages/database），
 * 前端另有一份等价的离线兜底（apps/website/src/main.jsx 的 COURSES_FALLBACK）。
 * 改这里的默认内容时，请同步那一份，否则断网/接口异常时展示会不一致。
 */

const COURSE_LESSON_TEMPLATE = ['认识 AI 魔法师', '创意与提示词', '角色与场景设计', '让画面动起来', '代码魔法实践', '作品打磨与发布', '同伴分享与互评', '结课展示与颁奖'];

// [图标, 课包名, 分类, 课时数, 适学年龄, 一句话简介]
const COURSE_ROWS = [
  ['🪄', '小创作家养成计划', 'AI 创作启蒙', 14, '8–16 岁', '从认识 AI 魔法师开始，完成绘画、故事、视频、编程与 AI 素养的第一份作品集。'],
  ['📖', 'AI绘本创作大师营', '故事与绘本', 8, '8–16 岁', '从故事种子到新书发布会，做一本属于自己的绘本。'],
  ['📜', 'AI古诗词创意营', '语文跨学科', 8, '8–16 岁', '让古诗活起来：用 AI 画诗、诵诗、做动画。'],
  ['🎉', 'AI节日创意工坊', '主题创作', 8, '8–16 岁', '围绕节日文化做海报、故事、小游戏与祝福视频。'],
  ['🚪', '选择之门', '互动故事', 5, '10–16 岁', '设计分叉剧情、统一画风与互动选择，完成能玩的故事书。'],
  ['🎮', 'AI游戏设计师训练营', '游戏创作', 8, '10–16 岁', '从游戏策划、角色场景到核心玩法，做出真正可以玩的小游戏。'],
  ['🔬', 'AI科学探险家', '科学探究', 8, '8–16 岁', '探索太空、海洋、恐龙、人体与气象，产出 AI 科学百科。'],
  ['🎤', 'AI小记者训练营', '表达与传播', 8, '8–16 岁', '从选题采访到新闻发布会，完成一份完整的 AI 新闻作品。'],
  ['🎬', 'AI微电影导演训练营', '视频创作', 8, '10–16 岁', '从剧本、分镜到配音、特效，拍出一部属于自己的 AI 微电影。'],
  ['🔧', 'AI智能硬件发明营', 'Arduino', 8, '10–12 岁', '用对话写代码，做出会发光、会响、会动、会感知的小发明。'],
  ['📟', 'AI Micro:bit 发明营', 'MicroPython', 8, '10–13 岁', '板载超能力加金手指外接，用说话写出 MicroPython。'],
];

function courseEntry([icon, title, category, lessonCount, ageRange, summary]) {
  return {
    icon, title, category, lessonCount, ageRange, summary,
    lessons: COURSE_LESSON_TEMPLATE.slice(0, Math.min(lessonCount, COURSE_LESSON_TEMPLATE.length)),
  };
}

export const WEBSITE_CONTENT_KEYS = new Set(['HOME', 'ORG', 'HANDBOOK', 'COMPARE', 'FAQ', 'BRAND', 'COURSES']);

// 只有「已经在官网真正生效」的区块才给默认内容；没有默认内容的 key 不会出现在管理端列表里，
// 避免运营改了却看不到效果（ORG / HANDBOOK / COMPARE 目前仍是静态页）。
export const WEBSITE_CONTENT_DEFAULTS = Object.freeze({
  COURSES: {
    eyebrow: '课程体系',
    title: '标准课包，',
    titleAccent: '马上开课',
    description: '给教培机构和学校用的课包清单，不是面向个人家长的选课商城。共 11 门、87 节，建议每节 90 分钟，适学 8–16 岁。',
    durationMinutes: 90,
    stats: [
      { value: '11', label: '门系统课程' },
      { value: '87', label: '节精品课时' },
      { value: '8–16', label: '岁适学年龄' },
      { value: '90′', label: '每节课时长' },
    ],
    courses: COURSE_ROWS.map(courseEntry),
    ctaTitle: '想看完整课包与课件示例？',
    ctaText: '预约演示，获取课程清单与试用账号。',
  },
});

export function websiteContentDefault(key) {
  return WEBSITE_CONTENT_DEFAULTS[String(key || '').toUpperCase()] || null;
}
