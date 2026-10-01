// 语言切换器（2026-10-01 用户口径：「i18n吧，需要简体中文/繁体中文/英文」，默认中文）。
//
// 两个形态共用一个组件：
//   · `variant="topbar"` —— 顶栏里那颗小胶囊（首页深色底上是另一套配色，见 styles.css 的 .lang-pick.on-dark）
//   · `variant="footer"` —— 页脚里的一行文字链（首页/内页通用）
// 切换时**保持当前页面**：只换 URL 前缀（`/works` ↔ `/en/works`），由运行时里的 useLocaleSwitch 负责。
import { useState } from 'react';
import { LOCALES, useI18n, useLocaleSwitch } from '@platform/shared';

export function LanguageSwitcher({ variant = 'topbar' }) {
  const { locale, t } = useI18n();
  const { switchTo, busy } = useLocaleSwitch();
  const [open, setOpen] = useState(false);
  const current = LOCALES.find((item) => item.code === locale) || LOCALES[0];

  if (variant === 'footer') {
    return <div className="ft-lang" role="group" aria-label={t('lang.label')}>
      {LOCALES.map((item) => (item.code === locale
        ? <strong key={item.code} aria-current="true">{item.label}</strong>
        : <button key={item.code} type="button" disabled={busy} onClick={() => switchTo(item.code)}>{item.label}</button>))}
    </div>;
  }

  return <div className={'lang-pick' + (open ? ' is-open' : '')}>
    {/* ⚠️ 顶栏这颗**只显示短标**（简 / 繁 / EN）：带全称的话右侧按钮组会变宽，
        1440px 下与绝对居中的导航叠在一起（p115 当场抓到 —— 那个「联系我们」当年就是这么被删掉的）。
        全称放在 title 与下拉里。 */}
    <button type="button" className="lang-pick__btn" aria-haspopup="listbox" aria-expanded={open}
      aria-label={t('lang.switchTo', { name: current.label })} title={current.label}
      disabled={busy} onClick={() => setOpen((value) => !value)}>
      <span className="lang-pick__short">{current.short}</span>
    </button>
    {open ? <>
      {/* 点外面收起：一层透明的遮罩，比监听 document 更省事，也不会和抽屉菜单打架 */}
      <button type="button" className="lang-pick__scrim" aria-hidden="true" tabIndex={-1} onClick={() => setOpen(false)} />
      <ul className="lang-pick__list" role="listbox" aria-label={t('lang.label')}>
        {LOCALES.map((item) => <li key={item.code}>
          <button type="button" role="option" aria-selected={item.code === locale} disabled={busy}
            onClick={() => { setOpen(false); switchTo(item.code); }}>{item.label}</button>
        </li>)}
      </ul>
    </> : null}
  </div>;
}
