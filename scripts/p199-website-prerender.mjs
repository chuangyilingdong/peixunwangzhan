/**
 * P199 官网预渲染守卫（2026-11-01，SEO 方案 B）。
 *
 * 钉的是什么：官网是 SPA，不跑 JS 只有 3060 字节的「正在进入课堂」——
 * 百度抓到的一直是这个，所以 sitemap 里的页面**都能被发现、但没有任何可排名的正文**。
 * 现在构建期用 Chromium 把公开页渲染成静态 HTML，部署后 nginx 直接发。
 *
 * 这条守卫钉四件事（任何一件破了，预渲染就悄悄失效，而线上看起来一切正常）：
 *   ① 预渲染的页面清单与 `sitemap.xml` **完全一致** —— 少一个就是"给百度递了空页面"，
 *      多一个就是"渲染了不该公开的页"；
 *   ② 构建脚本真的会跑它（且跑在 `vite build` 之后、复制 dist 之前）；
 *   ③ 脚本有应急开关，且**标题不符 / 正文过短会判失败**（不是"渲染了就算"）；
 *   ④ 如果本地已经有 dist 产物，逐页校验：标题互不相同、正文够长。
 *
 * 跑法：node scripts/p199-website-prerender.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (error) { failures += 1; console.error(`  ✗ ${label} —— ${error.message}`); }
};

const script = read('apps/website/scripts/prerender.mjs');
const build = read('deploy/production/build-production.sh');
const sitemap = read('apps/website/public/sitemap.xml');

/* ① 清单一致性 */
await check('① 预渲染清单与 sitemap 完全一致（路径集合相等）', async () => {
  const routes = [...script.matchAll(/\{\s*route:\s*'([^']+)'/g)].map((m) => m[1]);
  const sitemapPaths = [...sitemap.matchAll(/<loc>https:\/\/aicyld\.com(\/[^<]*)<\/loc>/g)].map((m) => m[1] || '/');
  assert.ok(routes.length >= 10, `预渲染清单只有 ${routes.length} 条`);
  const missing = sitemapPaths.filter((p) => !routes.includes(p));
  const extra = routes.filter((p) => !sitemapPaths.includes(p));
  assert.equal(missing.length, 0, `sitemap 里有但没预渲染：${missing.join(', ')}`);
  assert.equal(extra.length, 0, `预渲染了但 sitemap 里没有：${extra.join(', ')}`);
});

await check('① sitemap 不再包含 /org（它 301 到机构端且被 robots 屏蔽）', async () => {
  assert.ok(!/<loc>https:\/\/aicyld\.com\/org<\/loc>/.test(sitemap), 'sitemap 里还有 /org');
});

/* ② 构建接线 */
await check('② 构建脚本在 vite build 之后、复制 dist 之前跑预渲染', async () => {
  const viteAt = build.indexOf('vite build apps/website');
  const prerenderAt = build.indexOf('prerender.mjs');
  const copyAt = build.indexOf('cp -a "apps/${app}/dist/.');
  assert.ok(viteAt > 0, '构建脚本里没找到官网 vite build');
  assert.ok(prerenderAt > viteAt, '预渲染没有排在 vite build 之后');
  assert.ok(copyAt > prerenderAt, '预渲染没有排在复制 dist 之前（产物会进不了 release）');
  assert.match(build, /PRERENDER_SKIP/);
});

/* ③ 脚本自身的护栏 */
await check('③ 预渲染有应急开关，且标题不符/正文过短会判失败', async () => {
  assert.match(script, /PRERENDER_SKIP/);
  assert.match(script, /title\.includes\(expect\)/, '没有校验标题');
  assert.match(script, /textLength < 200/, '没有校验正文长度');
});

await check('③ 预渲染用无头浏览器真跑页面（不是拼字符串）', async () => {
  assert.match(script, /playwright-core/);
  assert.match(script, /waitUntil: 'networkidle'/);
});

/* ④ 产物校验（dist 存在才跑） */
const dist = path.join(root, 'apps/website/dist');
const routes = [...script.matchAll(/\{\s*route:\s*'([^']+)'/g)].map((m) => m[1]);
const hasPrerendered = fs.existsSync(path.join(dist, 'marketplace', 'index.html'));
// ④ 只在**真的有预渲染产物**时跑：本地仓库里的 dist 可能是很久以前构建的（不含预渲染），
//    那时校验只会误报。发布流水线里构建完再跑，或用 P199_REQUIRE_DIST=1 强制。
const requireDist = String(process.env.P199_REQUIRE_DIST || '') === '1';
if (!hasPrerendered && !requireDist) {
  console.log('  · 跳过 ④：dist 里没有预渲染产物（本地 dist 可能是旧的；发布构建后会自动校验）');
} else {
  await check('④ 每个公开页都有独立标题（不是同一份空壳）', async () => {
    const titles = new Map();
    for (const route of routes) {
      const file = route === '/' ? path.join(dist, 'index.html') : path.join(dist, route.slice(1), 'index.html');
      assert.ok(fs.existsSync(file), `${route} 没有产物：${file}`);
      const html = read(file.slice(root.length + 1));
      const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
      assert.ok(title.trim(), `${route} 没有 title`);
      titles.set(route, title);
    }
    const unique = new Set(titles.values());
    assert.equal(unique.size, routes.length, `有 ${routes.length - unique.size} 个页面的标题重复了：${JSON.stringify([...titles])}`);
  });

  await check('④ 每页正文都够长（不是只渲染了框架）', async () => {
    for (const route of routes) {
      const file = route === '/' ? path.join(dist, 'index.html') : path.join(dist, route.slice(1), 'index.html');
      const html = fs.readFileSync(path.join(root, file.slice(root.length + 1)), 'utf8');
      const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, '');
      assert.ok(text.length > 200, `${route} 去掉标签后只有 ${text.length} 字`);
    }
  });

  await check('④ 首页不再残留「正在进入课堂」空壳', async () => {
    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    assert.ok(!html.includes('正在进入课堂'), '首页还是那个加载壳');
  });

  // ⚠️ 2026-11-01 首版真的把 canonical 写成了 http://127.0.0.1:6187/handbook 并发了出去 ——
  //    预渲染是从本地起的服务打开的页面，而页面按 window.location.origin 生成 canonical。
  //    这比"没有预渲染"危害大得多（等于声明真页面在 localhost），所以钉死。
  await check('④ 没有页面把 canonical/og:url 写成 localhost', async () => {
    for (const route of routes) {
      const file = route === '/' ? path.join(dist, 'index.html') : path.join(dist, route.slice(1), 'index.html');
      const html = fs.readFileSync(path.join(root, file.slice(root.length + 1)), 'utf8');
      assert.ok(!/https?:\/\/(?:127\.0\.0\.1|localhost)[:/]/.test(html), `${route} 里还有本地地址`);
      const canonical = (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || '';
      assert.ok(canonical.startsWith('https://'), `${route} 的 canonical 不是 https：${canonical}`);
    }
  });
}

assert.equal(failures, 0, `P199 有 ${failures} 条断言没过`);
console.log('PASS: 官网预渲染（清单与 sitemap 一致、构建接线、每页独立内容）');
