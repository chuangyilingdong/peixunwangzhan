# P9-R02 官网首页 Inner Circle 改造

日期：2026-09-05
状态：本地开发完成，待功能批次结束后统一核验；未发布生产。

## 目标

参考 Inner Circle 提示词，将传统长页面首页改造成单屏、滚动驱动、手势控制的 AI 魔法学院 landing page。保留官网现有的课程、机构方案、作品、预约演示、法律页和统计同意能力，不把品牌替换成无关的英文社群产品。

## 已实现

- html / body 在首页挂载期间关闭原生滚动。
- wheel 使用 deltaY × 0.0006，touch 使用 (lastY - currentY) × 0.0015，统一 clamp 到 0 → 3.5。
- 使用 0.08 lerp 平滑显示进度；导航按钮使用 1200ms easeInOutCubic，手势输入会中断导航动画。
- Hero 使用洋红背景、外部视频 scrub 和鼠标 ±40px 视差；标题按字符向下退出。
- 0.75 后显示三张课程 / 课堂 / 作品 pill tiles，支持桌面 hover 放大与邻居位移。
- 1.15 后升起酒红色第二屏，第一屏按正弦曲线 blur 至 64px。
- 第二屏使用独立外部视频 scrub，左侧圆柱文字 drum 使用 32 行中文产品宣言（第 16 行为空行），高亮内容使用白色。
- 底部使用双轨无限 marquee；移动端提供全屏菜单，导航状态随进度更新。
- 预约演示入口继续记录 cta_click 匿名事件（仅在用户已同意统计时才会实际发送）。

## 外部依赖与降级

首页视频来自 motionsites CDN，默认预加载但不自动播放；组件只设置 currentTime，不会上传用户数据。视频加载失败时 loader 会保留，背景、导航、文案与交互仍可用。marquee 使用本地文本 wordmark，避免第三方 logo 加载失败影响页面。

## 变更范围

- apps/website/src/main.jsx
- apps/website/src/styles.css
- apps/website/index.html
- docs/AI少儿编程平台-完整上线执行总控.md

未修改 packages/canvas，未连接真实 AI、支付、公开注册或生产数据库。

## 验证

- Node v24.19.0：四端 pnpm build 通过。
- 首页 Vite 产物：apps/website/dist 生成成功。
- 生产发布：未执行。
- 统一核验：按当前工作安排后置。
