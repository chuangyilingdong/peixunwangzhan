// 作品卡片的两块「可复用件」：类型判定 + 自动封面。
//
// ⚠️ 2026-09-27 从 `pages/MyWorks.jsx` **原样搬出来**（连注释一起），因为新增的学生**公开主页**
//    （`pages/CreatorHome.jsx`，路由 `/u/<token>`）要用**同一套**封面与类型标签 ——
//    抄一份出去就会立刻漂移（用户在两个页面上看到同一条作品长得不一样）。
//    搬的时候**一个字没改**，只是加了 export。
//
// 用到的地方：`pages/MyWorks.jsx`（学生自己）、`pages/CreatorHome.jsx`（对外公开主页）。

// 作品类型只看服务端给的产物线索：VibeCoding 的看产物文件名，画布的就是画布作品。
// 不做「猜内容」的花活 —— 猜错比不显示更糟。
// `hue` / `art` 是给下面的自动封面用的：类型决定配色家族与插画，所以一排作品看着是一套。
export function workType(work) {
  const name = String(work.entryFile || '').toLowerCase();
  if (name) {
    if (/\.pptx?$/.test(name)) return { key: 'DECK', label: 'VibeCoding · 演示文稿', icon: '📊', hue: 28, art: 'deck' };
    if (/\.docx?$/.test(name)) return { key: 'DOC', label: 'VibeCoding · 文档', icon: '📄', hue: 168, art: 'doc' };
    if (/\.xlsx?$/.test(name)) return { key: 'SHEET', label: 'VibeCoding · 表格', icon: '📈', hue: 212, art: 'sheet' };
    return { key: 'WEB', label: 'VibeCoding · 网页应用', icon: '💻', hue: 262, art: 'web' };
  }
  return { key: 'CANVAS', label: '画布作品', icon: '🎨', hue: 322, art: 'canvas' };
}

/**
 * **作品封面**（用户口径 2026-09-20：「学生发布的作品应该自动生成个封面」）。
 *
 * 学生不会自己传封面，所以封面必须**自己长出来**。两层：
 *  ① 服务端给了真封面（`coverUrl`，将来是作品的截图）→ 直接用它；
 *  ② 没有 → 用作品自身的信息**当场画一张**：类型定色系与插画，标题哈希做小幅色相偏移
 *     （同一类型的几个作品互相区分得开），标题首字当水印。
 * 刻意不引入任何图片资源：SVG 是内联的，不占带宽、不产生 404，也不依赖服务端。
 *
 * ⚠️ 为什么不用"猜内容"的花活（比如按标题选吉祥物）：猜错比留个中性的封面更糟。
 */
export function coverSeed(work) {
  const text = String(work.id || work.title || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 100003;
  return hash;
}

function CoverArt({ art }) {
  switch (art) {
    case 'web': return <g><rect x="0" y="0" width="30" height="21" rx="3" /><rect x="11" y="23" width="8" height="3" rx="1.5" /><rect x="6" y="27" width="18" height="2.4" rx="1.2" /></g>;
    case 'deck': return <g><rect x="0" y="1" width="30" height="19" rx="3" /><rect x="5" y="6" width="12" height="2.6" rx="1.3" /><rect x="5" y="11" width="18" height="2.6" rx="1.3" /><rect x="5" y="16" width="8" height="2.6" rx="1.3" /></g>;
    case 'doc': return <g><rect x="1" y="0" width="26" height="30" rx="3" /><rect x="6" y="7" width="16" height="2.4" rx="1.2" /><rect x="6" y="13" width="16" height="2.4" rx="1.2" /><rect x="6" y="19" width="10" height="2.4" rx="1.2" /></g>;
    case 'sheet': return <g><rect x="0" y="2" width="30" height="26" rx="3" /><rect x="0" y="10" width="30" height="2" /><rect x="0" y="18" width="30" height="2" /><rect x="15" y="2" width="2" height="26" /></g>;
    case 'canvas': return <g><circle cx="15" cy="15" r="14" /><circle cx="10" cy="11" r="2.6" fill="#00000055" /><circle cx="20" cy="11" r="2.6" fill="#00000055" /><circle cx="10" cy="20" r="2.6" fill="#00000055" /><circle cx="20" cy="20" r="2.6" fill="#00000055" /></g>;
    default: return null;
  }
}

export function WorkCover({ work, type }) {
  if (work.coverUrl) return <img src={work.coverUrl} alt="" loading="lazy" />;
  const seed = coverSeed(work);
  // ⚠️ 色相要**拉得开**：第一版只抖 ±12°，一排作品全是同一个粉色，等于还是"一个样"
  //    （实测 15 张画布作品的封面几乎分不出来）。现在在类型色系左右各 45° 里取，
  //    既看得出是同一类、又能一眼区分 — 同一份种子还决定下面用哪种构图。
  const hue = ((type.hue + (seed % 91) - 45) % 360 + 360) % 360;
  const gradientId = `workcover-${String(work.id || 'x').replace(/[^A-Za-z0-9_-]/g, '')}`;
  const mark = String(work.title || '作').trim().charAt(0) || '作';
  const layout = seed % 3;
  return <svg className="student-work-card__art" viewBox="0 0 320 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={`hsl(${hue} 56% ${50 + (seed % 9)}%)`} />
        <stop offset="1" stopColor={`hsl(${(hue + 26) % 360} 70% ${70 + (seed % 7)}%)`} />
      </linearGradient>
    </defs>
    <rect width="320" height="150" fill={`url(#${gradientId})`} />
    {/* 三种构图轮着来：圆环 / 斜带 / 点阵 —— 同一份种子决定，所以同一件作品永远同一张 */}
    {layout === 0 ? <g fill="#ffffff" opacity="0.12">
      <circle cx={276} cy={22} r={62} />
      <circle cx={30} cy={140} r={48} />
    </g> : null}
    {layout === 1 ? <g fill="#ffffff" opacity="0.10" transform="rotate(-18 160 75)">
      <rect x={-40} y={22} width={420} height={26} rx={13} />
      <rect x={-40} y={72} width={420} height={14} rx={7} />
      <rect x={-40} y={104} width={420} height={20} rx={10} />
    </g> : null}
    {layout === 2 ? <g fill="#ffffff" opacity="0.13">
      {[0, 1, 2, 3].map((row) => [0, 1, 2, 3, 4].map((col) => <circle key={`${row}-${col}`} cx={252 + col * 18} cy={28 + row * 18} r={3.4} />))}
    </g> : null}
    <text x="22" y="128" fill="#ffffff" opacity="0.22" fontSize={96 + (seed % 18)} fontWeight="900" fontFamily="inherit">{mark}</text>
    <g transform="translate(266,86) scale(1.7)" fill="#ffffff" opacity="0.92"><CoverArt art={type.art} /></g>
  </svg>;
}
