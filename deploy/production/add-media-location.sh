#!/usr/bin/env bash
# 给生产 nginx 加一条 /media/（作品广场的导入媒体，2026-09-19）。
#
# 为什么必须单独一条 location：
#   · 媒体放在 **release 之外**（/srv/ai-kids-platform/public-media），跟 /downloads/ 一个思路 ——
#     每次发布换代都不会把它冲掉；
#   · 而且**不能**复用 /downloads/：那条是 `default_type application/octet-stream` + nosniff，
#     图片/视频会因此被浏览器拒收（<img>/<video> 直接不显示）。这里让 nginx 按扩展名给对的类型。
#
# 自检顺序：备份 → 插入 → nginx -t → reload → 公网取一张真图看 content-type。
# 任一步失败都不 reload（配置没动过就谈不上回滚）。
set -euo pipefail

CONF=/etc/nginx/sites-enabled/iicili.cyou
BACKUP_DIR=/etc/nginx/backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
MEDIA_DIR=/srv/ai-kids-platform/public-media

mkdir -p "$BACKUP_DIR"
cp "$CONF" "$BACKUP_DIR/iicili.cyou.before-media.$STAMP"
echo "已备份 nginx 配置 → $BACKUP_DIR/iicili.cyou.before-media.$STAMP"

if grep -q "location ^~ /media/" "$CONF"; then
  echo "已存在 /media/ 这条 location，跳过插入"
else
  # 插在 /downloads/ 那条之后（同一片区域，都是"release 之外的静态目录"）
  python3 - "$CONF" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
anchor = """    location ^~ /downloads/ {
        alias /srv/ai-kids-platform/downloads/;
        autoindex off;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        default_type application/octet-stream;
    }"""
block = anchor + """

    # 作品广场的导入媒体（2026-09-19）：与 /downloads/ 同一套路（release 之外，换代不冲）。
    # ⚠️ 这条**不能**照抄 downloads 的 default_type octet-stream：图片/视频要能内联渲染，
    #    类型必须按扩展名给（nginx 的 mime.types 已经在 http 段里 include 过了）。
    location ^~ /media/ {
        alias /srv/ai-kids-platform/public-media/;
        autoindex off;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        expires 30d;
    }"""
if anchor not in text:
    raise SystemExit('!! 没找到 /downloads/ 那段锚点，配置可能被改过 —— 拒绝盲插')
open(path, 'w', encoding='utf-8').write(text.replace(anchor, block, 1))
print('已插入 /media/ location')
PY
fi

echo "=== nginx -t ==="
nginx -t
echo "=== reload ==="
systemctl reload nginx
echo "=== 公网核验：取一张真封面看类型 ==="
SAMPLE=$(find "$MEDIA_DIR/ltai-works" -type f \( -name 'cover.jpg' -o -name 'cover.jpeg' -o -name 'cover.png' -o -name 'cover.webp' \) | head -1)
if [ -n "$SAMPLE" ]; then
  REL=${SAMPLE#"$MEDIA_DIR"/}
  echo "样本：$REL"
  curl -sI -m 20 "https://iicili.cyou/media/$REL" | grep -iE "^HTTP|content-type|content-length|cache-control"
else
  echo "!! 媒体目录里没找到封面样本"
fi
echo "NGINX_MEDIA_DONE"
