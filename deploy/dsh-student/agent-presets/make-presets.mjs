/**
 * 生成学生端的三个功能 preset：对话 / 写代码 / 做网页（2026-09-17）。
 *
 * 做法：从 dsh 自带的 preset（`@deepseek-ai/dsh-agent-presets/presets/cordis`）复制一份目录，
 * 只改两处 —— `preset.yml`（选择器显示的名字与描述）与 `agent.cordis.yml` 里 persona 段的 prefix
 * （它承载这一档的角色说明）。其余 composition（工具、技能、沙箱、审批）原样沿用官方 preset。
 *
 * ⚠️ 为什么必须有这个脚本、而不是手工放文件：`/opt/dsh-runtime/etc/dsh/` **归镜像所有** ——
 * `provision-user-runtime.sh` 会从镜像里抽 `etc/dsh` 覆盖它（实测：手工放进去的 preset 目录与
 * 对补丁层的编辑，在一次 provision 之后全没了）。所以这份目录要随镜像/装机走，
 * 由 provision 步骤调用本脚本生成。
 *
 * 用法：node make-presets.mjs [输出根目录]（默认 /opt/dsh-runtime/etc/dsh/agent-presets）
 */
import fs from 'node:fs';

