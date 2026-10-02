// 学生主页侧的作品分享码：**发码与"件的定位"就在这里一份**，学生端（`/api/student/share-links`）
// 与机构/老师端（`/api/org/share-links`）共用 —— 两边各写一套的话，键或幂等口径迟早只在一半上生效。
//
// ⚠️ 与**作品广场**彻底解耦：广场那套 `works.share_token` 只在"公开到广场"时才发（绑审核/上下架）；
//    这里的码是"想分享就分享"，**扫它不改变任何公开状态**。
// ⚠️ 码归**作品的作者（学生）**所有 —— 老师替学生分享时，码的 `student_id` 仍是那个学生（分享卡上显示的
//    也是学生与他的机构）；"是谁分享的"留在审计里（`WORK_SHARE_LINK_CREATE` 的 actor）。
import { randomUUID } from 'node:crypto';
import { aq, arow, canvasMediaFrom, errors, nowIso, parseJson } from '../lib.js';
import { shareableArtifactNames } from '../routes/vibecoding.js';

/**
 * 一件作品里**每一件产出物**的稳定标识（分享码就按它定位）：
 *   · 画布作品：快照里的每个图/视频/音频 → `media:<fileId|url>`（优先 fileId：资产 id 跨版本稳定）
 *   · VibeCoding：**可独立分享的**那些产物的 `artifact:<文件名>`（与分享面板同一份清单
 *     `shareableArtifactNames`：各枚举一套的话，"面板上看得见的那一件"可能发不了码 ——
 *     写守卫时实测踩到）。⚠️ 2026-10-02 起**网页作品的引用零件（css/js/图）不算独立一件**
 *     （用户口径：「客户端传过来的是 1 个主文件，然后是一些引用文件……这里肯定就是一个整体啊」）。
 */
export function sharePieceKeysOf(source, row) {
  if (source === 'CANVAS') {
    return canvasMediaFrom(parseJson(row?.canvas_snapshot, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }))
      .map((item) => `media:${item.fileId || item.url}`)
      .filter((key) => !key.endsWith(':'));
  }
  return shareableArtifactNames(row).map((name) => `artifact:${name}`);
}

/** 这件产出物在不在**最新那一版**里（不在就拒 —— 免得发出一枚打不开的码）。 */
export function assertSharePiece(source, row, pieceKey) {
  if (!sharePieceKeysOf(source, row).includes(pieceKey)) throw errors.badRequest('这一件不在最新版本里', 'SHARE_PIECE_NOT_FOUND');
}

/**
 * 发一枚分享码（**幂等**：一个 (学生, 作品, 那一件) 只有一枚 —— 重复点"分享"给的是同一枚，
 * 二维码不会满天飞）。返回 `{ code, created }`；`created` 供调用方决定要不要记审计。
 */
export async function ensureWorkShareLink({ source, workId, studentId, orgId, pieceKey }) {
  const existing = await arow(
    'SELECT code FROM work_share_links WHERE student_id=? AND source=? AND work_id=? AND piece_key=?',
    [studentId, source, workId, pieceKey],
  );
  if (existing) return { code: existing.code, created: false };
  const code = `shs_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  await aq('INSERT INTO work_share_links(code,student_id,org_id,source,work_id,piece_key,created_at) VALUES (?,?,?,?,?,?,?)',
    [code, studentId, orgId, source, workId, pieceKey, nowIso()]);
  return { code, created: true };
}

/** 分享码的对外地址（前端只认 `/s/<码>` 这一条路）。 */
export const shareLinkUrl = (code) => `/s/${code}`;
