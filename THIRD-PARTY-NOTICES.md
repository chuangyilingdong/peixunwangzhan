# 第三方组件与设计来源声明

本仓库包含来自第三方开源项目的内容。本文件说明来源、许可与使用范围。

---

## OpenSquilla — 控制台设计系统

**用于**：VibeCoding 课堂的界面设计系统（`packages/shared/src/console/`）。

**来源**：https://github.com/TokenRhythm/opensquilla （OpenSquilla，"Token-Efficient AI Agent"）
**许可**：Apache License 2.0，许可证全文见 [`docs/third-party/opensquilla-LICENSE.txt`](docs/third-party/opensquilla-LICENSE.txt)

### 用了什么

OpenSquilla 的 Web UI 是 Vue 3 + TypeScript 实现的（`opensquilla-webui/`）。本项目是 React 技术栈，
**没有移植它的任何组件代码**，而是把它的设计语言提取出来、在 React 里重新实现。具体沿用的部分：

1. **设计令牌**（`console/tokens.css`）——深色主题的调色板与语义映射，数值取自 OpenSquilla 的
   `src/assets/foundation.css` 与 `src/themes/dark/tokens.css`：地表五级亮度阶梯（`--bg` … `--bg-hover`）、
   单一强调色 `--accent` 与六通道状态色（`--ok/--warn/--danger/--info/--queued`）、语法高亮色、
   圆角阶梯（控件 10 / 卡片 14 / 面板 18 / 模态 24）、间距梯、动效词表（4 个时长 + 4 条缓动）、
   机加工高程阴影 `--elev-*`、侧边栏映射令牌 `--sidebar-*`。
2. **布局与交互的尺寸常量**（`console/ConsoleShell.jsx`、`console/Workbench.jsx`）——侧边栏宽度与吸附阈值、
   拖拽死区与迟滞带、工作台宽度与分栏断点、对话列与输入列的宽度公式，取自它的
   `src/utils/sidebarLayout.ts`、`src/workbench/layout.ts`、`src/styles/chat-view.css`。
3. **若干 CSS 规则的写法**（`console/kit.css`、`console/chat.css`、`console/workbench.css`）——
   依据它的 `control-visual-system.css` 与 `apple-modern.css` 的最终生效值改写（该项目自身有两层覆盖，
   我们只取最终结果，不做两层叠加）。

按 Apache-2.0 的要求，上述内容的来源与许可在此声明，许可证全文随仓库归档。

### 明确没有用的东西

- **没有引入它的自托管字体**。OpenSquilla 自带 Space Grotesk / IBM Plex Sans / IBM Plex Mono 的 woff2，
  那几个字体是各自独立的 SIL OFL 授权。本项目改用系统字体栈（含中文回退）。
- **没有引入它的主题系统**。它带 9 个主题与皮肤层，本项目只做深色一套。
- 没有移植它的任何业务逻辑、适配器、状态管理或测试。

### 许可提示

Apache-2.0 允许商业使用、修改与再分发，要求保留版权与许可声明（本文件），
并对其修改过的文件标注修改。若后续从 OpenSquilla 直接拷贝了代码（而非仅参考设计），
请在对应文件头部补一条来源注释。

## qrcode-generator（二维码生成，MIT）

- **用在哪**：学生主页「分享」弹窗里的二维码、以及作品分享页（扫码打开 `/s/<码>`）。
- **来源**：npm 包 `qrcode-generator@2.0.4`（`dist/qrcode.mjs`），**原样 vendored** 到
  `packages/shared/src/vendor/qrcode-generator.mjs`（只加了本仓库的说明注释，代码未改）。
  为什么不直接依赖它：**生产服务器上没有 npm**，发布链路不该为了一个二维码去下载新包。
- **许可**：MIT，Copyright (c) 2009 Kazuhiko Arase（原始版权头保留在该文件顶部）。
- **正确性怎么保证的**（不是"看着像二维码"）：同一段文本分别用这份 vendored 实现与 npm 上成熟的
  `qrcode` 库各生成一次，**逐格比对模块矩阵**（33×33、0 处不同）才投入使用。

## traffic-compass / 流量罗盘（合规规则与引擎，MIT）

- **用在哪**：招生军师「合规体检」的规则引擎与规则包 —— `apps/server/src/services/complianceEngine.js`
  与 `apps/server/data/junshi/compliance-rules.json`。
- **来源**：https://github.com/code-wahaha/traffic-compass （MIT License，Copyright (c) code-wahaha）。
  移植的是 `webapp/engine.py` 的判定设计与 `webapp/audit_skill.md` 的审读提示词，
  以及其 douyin / xiaohongshu 规则包中的违禁词分组、白名单与资质红线。
- **改了什么**（按 MIT 要求标注修改）：按「教培物料」语境改写 ——
  ① 去掉抖音专属的站外引流判定（家长加微信、放二维码是教培正常经营动作，照搬会大量误杀），
  换成微信生态的诱导分享红线；② 增加教培词条（承诺升学/成绩宣传/师资夸大/速成夸大/价格表述）
  与营销语境补词（机构/培训/课程/报名…）；③ 去掉抖音 AI 双标注规则与流量潜力预测模型
  （不适用于朋友圈/海报）；④ Python → Node 的等价改写（判定逻辑保持一致）。
- **许可**：MIT。原始版权声明见上述仓库的 LICENSE 文件（Copyright (c) code-wahaha）。
