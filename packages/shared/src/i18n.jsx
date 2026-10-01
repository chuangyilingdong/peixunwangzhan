// 多语言运行时（2026-10-01，用户口径：「i18n吧，需要简体中文/繁体中文/英文」，默认中文）。
//
// 为什么自研而不是引 i18next：这份需求是"**静态字典 + 插值**"，没有复数/时区/命名空间那一套；
// 几十行就够，而且**零依赖**能被守卫逐 key 校验（"三种语言的 key 集合必须一致、缺 key 要能发现"）。
// 与这个仓库一贯的做法一致（二维码 vendored、pdf.js 只挑 legacy 构建）。
//
// 语言怎么定（优先级从高到低）：
//   ① URL 前缀（`/en/...`、`/zh-TW/...`；**不带前缀 = 简体中文**，所以现有链接一个都不变）
//   ② localStorage（上次选的）
//   ③ 浏览器语言（`navigator.languages`）
//   ④ 默认简体中文
// ⚠️ URL 前缀是**可分享**的那一份：把 `/en/works` 发给别人，对方打开就是英文。
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/** 支持的语言。`htmlLang` 是写进 `<html lang>` 的值（繁体用 zh-Hant，搜索引擎认这个）。 */
export const LOCALES = Object.freeze([
  { code: 'zh-CN', label: '简体中文', short: '简', htmlLang: 'zh-CN', tag: 'zh-Hans' },
  { code: 'zh-TW', label: '繁體中文', short: '繁', htmlLang: 'zh-Hant', tag: 'zh-Hant' },
  { code: 'en', label: 'English', short: 'EN', htmlLang: 'en', tag: 'en' },
]);
export const DEFAULT_LOCALE = 'zh-CN';
export const LOCALE_CODES = LOCALES.map((item) => item.code);
export const LOCALE_STORAGE_KEY = 'ai-kids-platform.locale.v1';

const isLocale = (value) => LOCALE_CODES.includes(String(value || ''));

/** 从路径里取语言：`/en/works` → `en`；`/works` → 默认 zh-CN。 */
export function localeFromPath(pathname) {
  const first = String(pathname || '/').split('?')[0].split('/').filter(Boolean)[0] || '';
  return isLocale(first) ? first : DEFAULT_LOCALE;
}

/** 去掉路径里的语言前缀（`/en/works` → `/works`）。 */
export function stripLocale(pathname) {
  const raw = String(pathname || '/');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts.length && isLocale(parts[0])) parts.shift();
  const rest = '/' + parts.join('/');
  return (rest === '/' ? '/' : rest.replace(/\/$/, '')) + (query ? `?${query}` : '');
}

/** 给路径加上语言前缀（默认语言不加；`getHref('/works', 'en')` → `/en/works`）。 */
export function getHref(pathname, locale) {
  const clean = stripLocale(pathname);
  if (!isLocale(locale) || locale === DEFAULT_LOCALE) return clean;
  return clean === '/' ? `/${locale}` : `/${locale}${clean}`;
}

export function readStoredLocale() {
  try {
    const stored = String(window.localStorage.getItem(LOCALE_STORAGE_KEY) || '');
    return isLocale(stored) ? stored : '';
  } catch { return ''; }
}

export function writeStoredLocale(locale) {
  try { window.localStorage.setItem(LOCALE_STORAGE_KEY, String(locale)); } catch { /* 存不下就只活这一次 */ }
}

/** 路径 > 本机记忆 > 浏览器语言 > 默认。 */
export function detectLocale(pathname, fallback = '') {
  const fromPath = localeFromPath(pathname);
  if (fromPath !== DEFAULT_LOCALE) return fromPath;
  if (isLocale(fallback)) return fallback;
  const stored = readStoredLocale();
  if (stored) return stored;
  try {
    const langs = Array.isArray(navigator?.languages) && navigator.languages.length ? navigator.languages : [navigator?.language || ''];
    for (const item of langs) {
      const value = String(item || '').toLowerCase();
      if (value.startsWith('zh')) return /hant|tw|hk|mo/.test(value) ? 'zh-TW' : 'zh-CN';
      if (value.startsWith('en')) return 'en';
    }
  } catch { /* 无 window：按默认 */ }
  return DEFAULT_LOCALE;
}

const I18nContext = createContext({ locale: DEFAULT_LOCALE, messages: {}, fallback: {}, setLocale: () => {}, t: (key) => key });

/**
 * 取一条文案：**当前语言 → 简体中文 → key 本身**。
 * 缺 key 时回落而不是显示空白（英文站上一条没翻的词会显示中文，比空白好读）。
 * 插值：`t('home.greet', { name: '小明' })` 会把文案里的 `{name}` 换掉。
 */
export function translate(messages, fallback, key, vars) {
  const table = messages && typeof messages === 'object' ? messages : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  let text = table[key];
  if (text === undefined || text === '') text = base[key];
  if (text === undefined || text === '') return String(key || '');
  if (!vars || typeof vars !== 'object') return String(text);
  return String(text).replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole));
}

export function I18nProvider({ locale = DEFAULT_LOCALE, messages = null, fallback = null, children }) {
  const active = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const tables = useMemo(() => ({ [active]: messages || {}, [DEFAULT_LOCALE]: fallback || messages || {} }), [active, messages, fallback]);
  const t = useCallback((key, vars) => translate(tables[active], tables[DEFAULT_LOCALE], key, vars), [tables, active]);
  const value = useMemo(() => ({ locale: active, messages: tables[active], fallback: tables[DEFAULT_LOCALE], t }), [active, tables, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() { return useContext(I18nContext); }
export function useT() { return useContext(I18nContext).t; }

/**
 * 把语言的副作用挂到文档上：`<html lang>`、`document.title`。
 * ⚠️ SEO 相关（description/og/hreflang）在 `applyLocaleSeo` 里一起做 —— 纯 SPA 拿不到 SSR，
 *    所以这些只能靠客户端改；真要让爬虫看到，得等以后上静态预渲染（记在待办里）。
 */
export function applyLocaleDocument(locale, meta = {}) {
  const entry = LOCALES.find((item) => item.code === locale) || LOCALES[0];
  try {
    document.documentElement.setAttribute('lang', entry.htmlLang);
    document.documentElement.setAttribute('data-locale', entry.code);
  } catch { /* 无 document */ }
  if (meta.title) { try { document.title = String(meta.title); } catch { /* 忽略 */ } }
}

/** 给页面挂 hreflang 互链（同一路径的三种语言版本各一条）。 */
export function applyLocaleAlternates(pathname, origin) {
  try {
    const base = String(origin || window.location.origin).replace(/\/$/, '');
    const clean = stripLocale(pathname);
    document.querySelectorAll('link[data-i18n-alt]').forEach((node) => node.remove());
    for (const item of LOCALES) {
      const link = document.createElement('link');
      link.rel = 'alternate';
      link.hreflang = item.tag;
      link.href = `${base}${getHref(clean, item.code)}`;
      link.setAttribute('data-i18n-alt', item.code);
      document.head.appendChild(link);
    }
  } catch { /* 无 document */ }
}

/** 语言切换器要用的小工具：切到某个语言时，**保持当前页面**。 */
export function useLocaleSwitch() {
  const { locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const switchTo = useCallback((next) => {
    if (!isLocale(next) || next === locale) return;
    writeStoredLocale(next);
    setBusy(true);
    const target = `${getHref(stripLocale(window.location.pathname), next)}${window.location.search || ''}${window.location.hash || ''}`;
    window.location.assign(target);
  }, [locale]);
  return { locale, switchTo, busy };
}
