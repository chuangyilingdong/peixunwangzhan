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
