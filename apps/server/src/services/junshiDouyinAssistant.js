/**
 * 抖音采集助手（浏览器扩展）的服务端：配对 + 上报。
 *
 * 为什么是这套：抖音按出口 IP 风控，生产数据中心 IP 读不到作品列表（见交接文档）。
 * 实测视频 CDN 不拦服务器 IP，所以拆成：
 *   用户浏览器（正常 IP、已登录）→ 读作品列表 → 上报
 *   我们的服务器 → 下载 + 转写 + 入库（这部分服务器能做）
 *
 * 安全：配对码 10 分钟一次性；配对后扩展拿长期 token（库里只存 SHA-256）。
 * 上报只接受「作品元数据」，不含任何登录 cookie。
 */
import { createHash, randomBytes } from 'node:crypto';
import { aq, arow, arows, nowIso } from '../lib.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;
/** 避免 0/O/1/I 等易混字符。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
function makeCode() {
  const bytes = randomBytes(6);
  let code = '';
  for (let index = 0; index < 6; index += 1) code += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  return code;
}
function makeToken() {
  return `jdy_${randomBytes(24).toString('base64url')}`;
}
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
}

/** 生成配对码（机构在工作台点「生成配对码」；绑定当前创作账号，自己作品按账号归档）。 */
export async function createDouyinPairing(owner, accountId = 'default') {
  const code = makeCode();
  const token = makeToken();
  const at = nowIso();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  await aq('INSERT INTO junshi_workbench_douyin_pairings (code_hash,owner_key,org_id,account_id,token_hash,status,device,created_at,expires_at,used_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [sha256(code), owner.key, owner.orgId, String(accountId || 'default') || 'default', sha256(token), 'pending', '', at, expiresAt, null]);
  return { code, expiresAt };
}

/** 扩展用配对码换取长期 token。 */
export async function pairDouyinAssistant(codeInput, device = '') {
  const code = normalizeCode(codeInput);
  if (code.length !== 6) return { ok: false, error: '配对码是 6 位字母数字' };
  const row = await arow('SELECT * FROM junshi_workbench_douyin_pairings WHERE code_hash=?', [sha256(code)]);
  if (!row) return { ok: false, error: '配对码不存在，请在工作台重新生成' };
  if (row.status !== 'pending') return { ok: false, error: '这个配对码已经用过了，请重新生成' };
  if (String(row.expires_at) <= nowIso()) return { ok: false, error: '配对码已过期（10 分钟有效），请重新生成' };
  // token 明文只在配对这一刻生成并回给扩展（库里只留哈希）；pending 行里的初始哈希会被覆盖。
  const token = makeToken();
  const at = nowIso();
  await aq("UPDATE junshi_workbench_douyin_pairings SET token_hash=?, status='paired', device=?, used_at=?, expires_at=? WHERE code_hash=?",
    [sha256(token), String(device || '').slice(0, 200), at, '2999-12-31T00:00:00.000Z', sha256(code)]);
  return { ok: true, token, ownerLabel: row.owner_key };
}

/** 上报用 token 定位机构；返回 owner 上下文与 accountId。 */
export async function resolveDouyinAssistant(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  const row = await arow("SELECT * FROM junshi_workbench_douyin_pairings WHERE token_hash=? AND status='paired'", [sha256(value)]);
  if (!row) return null;
  return { ownerKey: row.owner_key, orgId: row.org_id || null, accountId: row.account_id || 'default' };
}

/** 列出某机构已配对的助手设备。 */
export async function douyinAssistants(ownerKey) {
  return await arows(
    "SELECT device, used_at FROM junshi_workbench_douyin_pairings WHERE owner_key=? AND status='paired' ORDER BY used_at DESC LIMIT 10",
    [ownerKey],
  ).catch(() => []);
}

/** 撤销某机构所有配对的助手（断开扩展）。 */
export async function revokeDouyinAssistants(ownerKey) {
  await aq("DELETE FROM junshi_workbench_douyin_pairings WHERE owner_key=?", [ownerKey]).catch(() => {});
}

/** 清理过期未用的配对码（生成时顺手清理，避免堆积）。 */
export async function pruneDouyinPairings() {
  await aq("DELETE FROM junshi_workbench_douyin_pairings WHERE status='pending' AND expires_at<=?", [nowIso()]).catch(() => {});
}
