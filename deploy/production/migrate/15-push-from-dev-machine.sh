#!/usr/bin/env bash
# 15 · 从**开发机**把代码推上生产机（在开发机执行）
#
# 为什么有它：RUNBOOK 里"上服务器 git pull --ff-only"这条路在**新机上是坏的** ——
#   服务器取不到 GitHub（`git@github.com-peixunwangzhan` 那个别名只在本机 ~/.ssh/config 里，
#   服务器上只剩 authorized_keys）。2026-09-24 实测 `git fetch` 报 Could not resolve hostname。
#   所以改成"本机推 → 服务器 ff 合并"，等价于原来的一次 pull，不依赖 GitHub 可达。
#
# 前置（一次性）：
#   · 本机 ~/.ssh/config 里有 aicyld-prod（HostName / User / IdentityFile，私钥路径不写进仓库）
#   · 本机 `git remote add prod ssh://aicyld-prod/srv/ai-kids-platform/source`
#
# 用法：
#   bash deploy/production/migrate/15-push-from-dev-machine.sh            # 只推 + 快进服务器工作树
#   bash deploy/production/migrate/15-push-from-dev-machine.sh --build    # 推完顺手 04：构建 + 切 release + 重启 + 验收
#
# 安全性：
#   · 服务器工作树必须**干净**（有本地改动就拒绝 —— 那正是 2026-09-24 之前踩的坑：
#     服务器源码树里有未跟踪/被改过的文件，它会静默盖过仓库里的版本）
#   · 只推到一个专用 ref `deploy-incoming`，**不碰**服务器当前检出的分支（不然 git 会拒绝）
#   · 服务器侧只做 `--ff-only` 合并（永不产生合并提交）
set -Eeuo pipefail

REMOTE="${REMOTE:-prod}"
BRANCH_REF="refs/heads/deploy-incoming"
SRC="/srv/ai-kids-platform/source"
SSH_ALIAS="${SSH_ALIAS:-aicyld-prod}"

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

log "1. 本机检查"
[[ -z "$(git status --porcelain)" ]] || die "本机工作区不干净，先提交或 stash"
LOCAL="$(git rev-parse HEAD)"
echo "  本机 HEAD : $LOCAL"
echo "  本机分支  : $(git rev-parse --abbrev-ref HEAD)"
git remote get-url "$REMOTE" >/dev/null 2>&1 || die "没有 remote $REMOTE（见文件头的前置说明）"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_ALIAS" true || die "SSH 连不上 $SSH_ALIAS"

log "2. 服务器工作树必须是干净的"
DIRTY="$(ssh -o BatchMode=yes "$SSH_ALIAS" "cd $SRC && git status --porcelain" | wc -l | tr -d ' ')"
[[ "$DIRTY" == "0" ]] || die "服务器工作树有 $DIRTY 处本地改动，先处理（git stash / 提交）再发布"
ssh -o BatchMode=yes "$SSH_ALIAS" "cd $SRC && git log --oneline -1"

log "3. 推送（只推专用 ref，不动它当前检出的分支）"
git push "$REMOTE" "HEAD:$BRANCH_REF"

log "4. 服务器快进合并"
ssh -o BatchMode=yes "$SSH_ALIAS" "cd $SRC && git merge --ff-only deploy-incoming"
REMOTE_HEAD="$(ssh -o BatchMode=yes "$SSH_ALIAS" "cd $SRC && git rev-parse HEAD")"
[[ "$REMOTE_HEAD" == "$LOCAL" ]] || die "合并后服务器 HEAD（$REMOTE_HEAD）与本机（$LOCAL）不一致"
echo "  ✓ 两边 HEAD 一致：$REMOTE_HEAD"

if [[ "${1:-}" == "--build" ]]; then
  log "5. 构建 + 切 release + 重启 + 验收（04 脚本，在服务器上跑）"
  # 04 会：读 production.env 拿域名 → 备份库 → 构建 → 切软链 → 重启 → 03 验收（38 项）
  ssh -o BatchMode=yes "$SSH_ALIAS" "cd $SRC && bash deploy/production/migrate/04-build-and-switch-release.sh"
else
  log "5. 跳过构建（没给 --build）"
  echo "  要发布的话：ssh $SSH_ALIAS 'cd $SRC && bash deploy/production/migrate/04-build-and-switch-release.sh'"
fi

cat <<'NEXT'

  回滚 release：在新机上把 current 软链切回上一版目录再重启
    ls -1dt /srv/ai-kids-platform/production/releases/*/ | head -2
    ln -sfn <上一版> /srv/ai-kids-platform/production/current && systemctl restart learning-platform-production
  ⚠️ 回滚 release **不会**把数据库退回去（启动期迁移是单向的）——带库结构变更的发布要用
     切换前那份备份：/srv/ai-kids-platform/production/backups/<stamp>/platform.db
NEXT
