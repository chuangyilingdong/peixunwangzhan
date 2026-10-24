#!/usr/bin/env bash
# 一次性：给生产机装抖音采集运行时（隔离 venv + f2，版本对齐原版 0.0.1.7）。在服务器上以 root 跑。
# 之后 04 发版重启会自动带上 JUNSHI_DOUYIN_PYTHON（本脚本写入 production.env）。
set -Eeuo pipefail

VENV=/srv/ai-kids-platform/runtime/douyin-venv
ENV_FILE=/etc/ai-kids-platform/production.env

if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
"$VENV/bin/pip" install -q "f2==0.0.1.7" "httpx" -i https://pypi.tuna.tsinghua.edu.cn/simple
"$VENV/bin/python" -c "import f2, httpx; print('f2 ok', __import__('f2').__name__)"

if ! grep -q '^JUNSHI_DOUYIN_PYTHON=' "$ENV_FILE"; then
  echo "JUNSHI_DOUYIN_PYTHON=$VENV/bin/python" >> "$ENV_FILE"
  echo "已写入 JUNSHI_DOUYIN_PYTHON（下次服务重启生效）"
else
  echo "JUNSHI_DOUYIN_PYTHON 已存在：$(grep '^JUNSHI_DOUYIN_PYTHON=' "$ENV_FILE")"
fi
echo "完成。worker 脚本随源码发布：apps/server/src/douyin/douyin_worker.py"
