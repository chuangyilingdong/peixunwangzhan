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
    {/* ⭐ 2026-10-01 用户口径：「图1 应该放在图2 旁边的位置，**直接写全称例如：繁体中文**」——
        它现在挨着右上角的账号/登录按钮，按钮上就是当前语言的全称（不再用「简 / 繁 / EN」短标）。
        ⚠️ 这段顶栏是 `position:absolute` 居中导航 + 右侧按钮组，加宽右侧**必须**跑 p115
        （当年「联系我们」就是在 1440px 下被这套布局挤掉才删的）。 */}
    <button type="button" className="lang-pick__btn" aria-haspopup="listbox" aria-expanded={open}
      aria-label={t('lang.switchTo', { name: current.label })} title={t('lang.switchTo', { name: current.label })}
      disabled={busy} onClick={() => setOpen((value) => !value)}>
      <span className="lang-pick__short">{current.label}</span>
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
