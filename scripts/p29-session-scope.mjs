/**
 * P29 会话按应用分桶：学生端 / 平台端 / 机构端同源（生产是 iicili.cyou 的 /、/admin/、/org/），
 * 共用一个 localStorage key 会让「谁最后登录谁把别人顶掉」。这里直接跑 shared/auth.js 的存储逻辑。
 *
 * 覆盖：三个路径前缀对应三个不同的 key → 在一个端登录不影响另一个端的会话 →
 * 登出只清自己那一份 → 不再使用旧的共用 key。
 */
import assert from 'node:assert/strict';

const store = new Map();
globalThis.window = {
  location: { pathname: '/' },
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  },
};
const at = (pathname) => { globalThis.window.location.pathname = pathname; };

const { readSession, writeSession, clearSession, sessionStorageKey } = await import('../packages/shared/src/auth.js');

const session = (token, role) => ({ token, expiresAt: new Date(Date.now() + 86400000).toISOString(), user: { id: `${role}-1`, role } });

try {
  // 1) 三个路径前缀 → 三个 key
  at('/admin/dashboard'); const adminKey = sessionStorageKey();
  at('/org/dashboard'); const orgKey = sessionStorageKey();
  at('/login'); const studentKey = sessionStorageKey();
  assert.equal(new Set([adminKey, orgKey, studentKey]).size, 3, `三个端应有三个不同的 key，实际 ${adminKey} / ${orgKey} / ${studentKey}`);
  assert.ok(adminKey.endsWith('.admin') && orgKey.endsWith('.org') && studentKey.endsWith('.student'), 'key 后缀应能看出是哪个端');
  assert.ok(!store.has('ai-kids-platform.session.v1'), '不应再写旧的共用 key');

  // 2) 三个端同时登录，互不覆盖
  at('/admin/dashboard'); writeSession(session('token-admin', 'SUPER_ADMIN'));
  at('/org/dashboard'); writeSession(session('token-org', 'ORG_ADMIN'));
  at('/login'); writeSession(session('token-student', 'STUDENT'));
  at('/admin/dashboard'); assert.equal(readSession()?.token, 'token-admin', '平台端会话应还在');
  at('/org/dashboard'); assert.equal(readSession()?.token, 'token-org', '机构端会话应还在');
  at('/login'); assert.equal(readSession()?.token, 'token-student', '学生端会话应还在');

  // 3) 学生端重新登录（覆盖自己那一份）不影响另外两个端
  at('/login'); writeSession(session('token-student-2', 'STUDENT'));
  at('/admin/dashboard'); assert.equal(readSession()?.token, 'token-admin', '学生端重登不应顶掉平台端');
  at('/org/dashboard'); assert.equal(readSession()?.token, 'token-org', '学生端重登不应顶掉机构端');

  // 4) 登出只清自己那一份（401 触发的 clearSession 同理）
  at('/login'); clearSession();
  assert.equal(readSession(), null, '学生端应已登出');
  at('/admin/dashboard'); assert.equal(readSession()?.token, 'token-admin', '平台端不应被一起登出');
  at('/org/dashboard'); assert.equal(readSession()?.token, 'token-org', '机构端不应被一起登出');

  // 5) 边界：/admin 与 /organization 不是同一个端
  at('/admin'); assert.ok(sessionStorageKey().endsWith('.admin'), '/admin 无斜杠也算平台端');
  at('/organization'); assert.ok(sessionStorageKey().endsWith('.student'), '/organization 不应被当成机构端');
  at('/org'); assert.ok(sessionStorageKey().endsWith('.org'), '/org 无斜杠也算机构端');

  console.log(JSON.stringify({ name: 'session-scope', pass: true, keys: { admin: adminKey, org: orgKey, student: studentKey }, concurrent: ['admin', 'org', 'student'] }, null, 2));
} catch (error) {
  console.error(error);
  throw error;
}
