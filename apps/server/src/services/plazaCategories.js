/**
 * 作品广场的**两个分类**（2026-09-19 用户口径）。
 *
 * 用户原话：「分类目前就 2 个分类：画布作品和 VibeCoding作品，图片、视频、AI播客、音乐、品牌设计
 * 放在画布作品里，其余是 VibeCoding 分类，并且分类在后台可以配置」。
 *
 * 所以这里只负责一件事：**给定一个作品的类型，说出它属于哪一类**。
 *   · 映射表存在 `platform_settings.plaza_category_map`（后台可改，改完不用发版）；
 *   · 没配到的类型走 `DEFAULT_MAP`（就是上面那句口径的默认落法）；
 *   · 站内作品不查表：画布作品就是 CANVAS、VibeCoding 提交就是 VIBECODING（它们本来就是两类来源）。
 *
 * ⚠️ 公开接口（`routes/communication/public.js`）与后台（`routes/admin/works.js`）都读这里 ——
 *    两边各写一份的话，后台改完分类、广场却按另一套算，就会出现"后台显示 A、前端显示 B"。
 */
import { row, arow } from '../lib.js';

/** 两个分类的对外名字（前端直接用它渲染胶囊，别再各写一份中文）。 */
export const PLAZA_CATEGORY_LABEL = { CANVAS: '画布作品', VIBECODING: 'VibeCoding作品' };
export const PLAZA_CATEGORIES = ['CANVAS', 'VIBECODING'];

/** 默认落法：图形/音视频/设计类算画布；能跑起来/能交互的算 VibeCoding。 */
export const DEFAULT_PLAZA_CATEGORY_MAP = {
  image: 'CANVAS', video: 'CANVAS', podcast: 'CANVAS', music: 'CANVAS', brandDesign: 'CANVAS', pictureBook: 'CANVAS',
  webpage: 'VIBECODING', miniGame: 'VIBECODING', ppt: 'VIBECODING', agent: 'VIBECODING', workflow: 'VIBECODING',
};

/** 导入件可能出现的全部类型（后台配置表单按它列，顺序固定）。 */
export const PLAZA_WORK_TYPES = Object.keys(DEFAULT_PLAZA_CATEGORY_MAP);

function parseJson(value, fallback) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '') : value;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

/** 后台配的那份（只认 CANVAS / VIBECODING 两个值，其它一律忽略，不猜）。 */
export async function configuredPlazaCategoryMap() {
  const stored = parseJson((await arow('SELECT plaza_category_map FROM platform_settings WHERE id=1'))?.plaza_category_map, {});
  const map = {};
  for (const [key, value] of Object.entries(stored || {})) {
    if (PLAZA_CATEGORIES.includes(value)) map[key] = value;
  }
  return map;
}

/** 实际生效的映射（默认表 + 后台覆盖），后台表单要拿它回显。 */
export async function plazaCategoryMap() {
  return { ...DEFAULT_PLAZA_CATEGORY_MAP, ...await configuredPlazaCategoryMap() };
}

/**
 * 这件作品属于哪一类。
 * @param input.imported 是不是导入件（导入件按类型查表）
 * @param input.workType 导入件的类型（video/webpage/…）
 * @param input.type 站内作品的来源标记（'VIBECODING' 或空）
 */
export async function plazaCategoryOf({ imported, workType, type }) {
  if (!imported) return type === 'VIBECODING' ? 'VIBECODING' : 'CANVAS';
  return (await plazaCategoryMap())[workType] || 'CANVAS';
}

/** 分类的中文名（前端直接用，别再各写一份）。 */
export async function plazaCategoryLabelOf(input) {
  return PLAZA_CATEGORY_LABEL[await plazaCategoryOf(input)] || '';
}
