import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';

/**
 * `/my-home*` → 学生自己的**对外主页** `/u/<token>`。
 *
 * ⚠️ 2026-09-27 用户口径：「**现在不需要这个 my-home 了。直接跳转到对外主页就行了啊。**
 *    以后提交的作品都到主页去。」—— 原来那一页（我的主页·控制台）已经删掉；
 *    这条重定向留着，是为了让导航项、老链接、老书签都还能用（与 `/my-works` 那两条同款）。
 *
 * homeToken 只有**学生口**知道，所以这里先问一次 `/api/student/home` 再跳。
 */
export function MyHomeRedirect({ api }) {
  const { source, id } = useParams();
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.get('student/home')
      .then((payload) => { if (live) setTarget(String(payload?.homeUrl || '')); })
      .catch((failure) => { if (live) setError(failure.message || '打不开你的主页'); });
    return () => { live = false; };
  }, [api]);

  if (error) return <main className="inner"><div className="student-page-state is-error">⚠ {error}</div></main>;
  if (!target) return <main className="inner"><div className="student-page-state">正在打开你的主页…</div></main>;
  // 带作品 id 的老地址（`/my-home/CANVAS/work_x`）→ 主页里那件作品（creator 作用域）
  return <Navigate to={source && id ? `${target}/w/${source}/${encodeURIComponent(id)}` : target} replace/>;
}
