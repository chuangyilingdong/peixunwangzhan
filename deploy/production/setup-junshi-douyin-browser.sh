#!/usr/bin/env bash
# 一次性：给生产机装抖音采集的浏览器运行时（Playwright Chromium + xvfb）。在服务器上以 root 跑。
#
# 为什么需要：
#   · 抖音对未登录请求返回 403，作品列表/详情都拿不到（2026-10-25 实测）。
#   · 十二期改为「真实浏览器 + 扫码登录」：采集用 Playwright 无头旁路，登录用有头窗口截二维码。
#   · 有头窗口必须有显示服务 → xvfb-run 提供临时虚拟显示（登录 worker 会自己套 xvfb-run）。
set -Eeuo pipefail

VENV=/srv/ai-kids-platform/runtime/douyin-venv

[ -x "$VENV/bin/python" ] || { echo "先跑 setup-junshi-douyin-runtime.sh（f2 venv 不存在）"; exit 1; }

echo "== 1. 装 xvfb（有头登录窗口的虚拟显示）"
if command -v apt-get >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q xvfb >/dev/null
elif command -v dnf >/dev/null; then
  dnf install -y -q xorg-x11-server-Xvfb
else
  echo "!! 未知包管理器，请手动安装 xvfb"; exit 1
fi
command -v xvfb-run >/dev/null && echo "   xvfb-run: $(command -v xvfb-run)"

echo "== 1b. 服务用户必须有可写的 HOME"
# 有头 Chromium 会写配置/缓存；HOME 指向不存在的目录会直接 SIGTRAP 崩掉（2026-10-25 踩到）。
if id ai-kids-prod >/dev/null 2>&1; then
  SERVICE_HOME="$(getent passwd ai-kids-prod | cut -d: -f6)"
  if [ -n "$SERVICE_HOME" ] && [ ! -d "$SERVICE_HOME" ]; then
    mkdir -p "$SERVICE_HOME" && chown ai-kids-prod:ai-kids-prod "$SERVICE_HOME"
    echo "   已创建 $SERVICE_HOME"
  else
    echo "   HOME=$SERVICE_HOME 已存在"
  fi
fi

echo "== 2. 装 Playwright（与原版桌面端同一套浏览器自动化）"
"$VENV/bin/pip" install -q --upgrade playwright -i https://pypi.tuna.tsinghua.edu.cn/simple
"$VENV/bin/python" -c "import playwright; print('   playwright ok')"

echo "== 3. 装 Chromium 与系统依赖（首次约 150MB）"
# ⚠️ 必须装到服务用户可读的共享路径：默认落到 /root/.cache/ms-playwright，
# 而服务以 ai-kids-prod 运行 → 启动浏览器必然 browser_launch_failed（2026-10-25 踩到）。
BROWSERS_PATH=/srv/ai-kids-platform/runtime/ms-playwright
mkdir -p "$BROWSERS_PATH"
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" "$VENV/bin/playwright" install --with-deps chromium
if id ai-kids-prod >/dev/null 2>&1; then
  chown -R ai-kids-prod:ai-kids-prod "$BROWSERS_PATH"
  echo "   已授权 ai-kids-prod 读取 $BROWSERS_PATH"
fi
ENV_FILE=/etc/ai-kids-platform/production.env
if [ -f "$ENV_FILE" ]; then
  grep -q '^PLAYWRIGHT_BROWSERS_PATH=' "$ENV_FILE" \
    || echo "PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_PATH" >> "$ENV_FILE"
  echo "   production.env: $(grep '^PLAYWRIGHT_BROWSERS_PATH=' "$ENV_FILE")"
else
  echo "!! 找不到 $ENV_FILE，请手动加 PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_PATH"
fi

echo "== 4. 验证（无头启动 + 有头起窗口）"
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" "$VENV/bin/python" - <<'EOF'
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto('about:blank')
        await browser.close()
        print('   headless ok')

asyncio.run(main())
EOF
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" xvfb-run -a "$VENV/bin/python" - <<'EOF'
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        page = await browser.new_page()
        await page.goto('about:blank')
        await browser.close()
        print('   headed (xvfb) ok')

asyncio.run(main())
EOF

echo "== 完成。重启服务后「连接抖音」即可出二维码：systemctl restart learning-platform-production"
