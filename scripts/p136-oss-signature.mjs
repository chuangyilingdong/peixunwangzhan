// P136 OSS 客户端（零依赖手写 V1 签名）的签名守卫
//
// 为什么值得钉：签名拼法**错了不会在本地报错**，只会在真正发给 OSS 时被判 403 ——
// 而那一步要等密钥到位、要走线上路径才会暴露。所以这里把三样东西钉死：
//   ① 签名算法本身（HMAC-SHA1 + 待签串拼法）—— 用固定输入钉住摘要，改一个字就红
//   ② 子资源必须参与签名（`response-content-disposition` 这类）—— 少签一项 OSS 判不匹配
//   ③ **配置不全时必须退回本地**（fail-closed）—— 这是最要紧的一条：
//      如果有人把 FILE_STORAGE=oss 配上了但密钥没配齐，绝不能"半开"着跑
//      （那会让上传成功写进 OSS 一半、读的时候找不到）
//
// 跑：node scripts/p136-oss-signature.mjs
import assert from 'node:assert/strict';
import { selfTest, stringToSignV1, signV1, signedUrl, withPrefix, storageBackend, ossConfigured } from '../apps/server/src/services/objectStorage.js';

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (error) { failures += 1; console.log(`  ✗ ${label} — ${error.message}`); }
};

// 固定一套配置来跑（跑完还原，别污染外面）
const saved = { ...process.env };
const setEnv = (vars) => {
  for (const k of ['FILE_STORAGE', 'OSS_BUCKET', 'OSS_REGION', 'OSS_ENDPOINT', 'OSS_INTERNAL_ENDPOINT', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_PREFIX']) delete process.env[k];
  Object.assign(process.env, vars);
};
const FULL = {
  FILE_STORAGE: 'oss',
  OSS_BUCKET: 'bucket-a',
  OSS_ENDPOINT: 'oss-cn-guangzhou.aliyuncs.com',
  OSS_INTERNAL_ENDPOINT: 'oss-cn-guangzhou-internal.aliyuncs.com',
  OSS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  OSS_ACCESS_KEY_SECRET: 'test-secret',
};

console.log('P136 OSS 签名守卫');

console.log('① 签名算法（固定输入 → 固定摘要）');
setEnv(FULL);
const PINNED = '/vpZqJwA2Oam/ri9xUEBdH/96EY=';
check('selfTest 与钉住的摘要一致', () => assert.equal(selfTest(), PINNED));
check('摘要由 HMAC-SHA1 与待签串共同决定（换 secret 就变）', () => {
  setEnv({ ...FULL, OSS_ACCESS_KEY_SECRET: 'another-secret' });
  const other = signV1({ verb: 'GET', key: 'dir/file.png', dateOrExpires: 1234567890 });
  assert.notEqual(other, '');
  setEnv(FULL);
  assert.notEqual(signV1({ verb: 'GET', key: 'dir/file.png', dateOrExpires: 1234567890 }), other);
});

console.log('② 待签串的形状（V1：VERB\\nMD5\\nCTYPE\\nDATE\\n/resource[?sub]）');
check('GET 无子资源', () => {
  assert.equal(
    stringToSignV1({ verb: 'GET', key: 'dir/file.png', dateOrExpires: 1234567890 }),
    'GET\n\n\n1234567890\n/bucket-a/dir/file.png',
  );
});
check('PUT 带 Content-Type', () => {
  assert.equal(
    stringToSignV1({ verb: 'PUT', key: 'a.json', contentType: 'application/json', dateOrExpires: 'Thu, 01 Jan 2026 00:00:00 GMT' }),
    'PUT\n\napplication/json\nThu, 01 Jan 2026 00:00:00 GMT\n/bucket-a/a.json',
  );
});
check('子资源按字典序拼进 CanonicalizedResource（顺序不同也必须同签）', () => {
  const a = stringToSignV1({
    verb: 'GET', key: 'x.png', dateOrExpires: 1,
    subResources: { 'response-content-type': 'image/png', 'response-content-disposition': 'inline' },
  });
  const b = stringToSignV1({
    verb: 'GET', key: 'x.png', dateOrExpires: 1,
    subResources: { 'response-content-disposition': 'inline', 'response-content-type': 'image/png' },
  });
  assert.equal(a, b);
  assert.match(a, /\/bucket-a\/x\.png\?response-content-disposition=inline&response-content-type=image\/png$/);
});
check('空值子资源不进签名（否则拼出 ?k= 这种无效项）', () => {
  assert.equal(
    stringToSignV1({ verb: 'GET', key: 'x.png', dateOrExpires: 1, subResources: { 'response-content-type': '' } }),
    'GET\n\n\n1\n/bucket-a/x.png',
  );
});
check('**有键无值**的子资源只拼键名（?policy / ?acl 这类，不能变成 ?policy=）', () => {
  assert.equal(
    stringToSignV1({ verb: 'PUT', key: '', contentType: 'application/json', dateOrExpires: 'D', subResources: { policy: true } }),
    'PUT\n\napplication/json\nD\n/bucket-a/?policy',
  );
});

console.log('③ 对象键与前缀');
check('withPrefix 去掉两头的斜杠再拼', () => {
  setEnv({ ...FULL, OSS_PREFIX: '/lingdong/' });
  assert.equal(withPrefix('/2026/09/a.png'), 'lingdong/2026/09/a.png');
  setEnv(FULL);
  assert.equal(withPrefix('2026/09/a.png'), '2026/09/a.png');
});
// ⭐ 2026-09-24 加：**幂等**。写进库的是"带前缀的完整键"，而读路径（签名 / HEAD / 取回 / 删除）
//    还会再走一次 withPrefix —— 不判一下就叠成 lingdong/lingdong/…，OSS 一律 404。
//    生产上真的这样烧了一天多：下载接口照常回 302，404 发生在 OSS 那边，
//    nginx 日志里只看得见那个 302，所以很容易被当成"客户端不显示"的问题。
check('带前缀的完整键不再叠一层（幂等）', () => {
  setEnv({ ...FULL, OSS_PREFIX: 'lingdong' });
  assert.equal(withPrefix('lingdong/2026/09/a.png'), 'lingdong/2026/09/a.png', '库里存的完整键必须原样用');
  assert.equal(withPrefix('/lingdong/2026/09/a.png'), 'lingdong/2026/09/a.png');
  assert.equal(withPrefix('lingdong'), 'lingdong');
  // 前缀只是首段的一部分时不能误判（lingdong2 不是 lingdong）
  assert.equal(withPrefix('lingdong2/2026/a.png'), 'lingdong/lingdong2/2026/a.png');
  // 相对键（回填脚本写的那种）照旧补前缀
  assert.equal(withPrefix('2026/09/a.png'), 'lingdong/2026/09/a.png');
  setEnv(FULL);   // 还给下面几条（这个文件里每条 check 自己负责还原环境）
});
check('同一条键连过两次 withPrefix 结果不变（"写—读往返"的核心）', () => {
  setEnv({ ...FULL, OSS_PREFIX: 'lingdong' });
  const stored = withPrefix('2026/09/a.png');   // putObject 落库的那一份
  assert.equal(withPrefix(stored), stored, '签名/HEAD 再走一次不能改键');
  assert.equal(new URL(signedUrl(stored, { expires: 60 })).pathname, '/lingdong/2026/09/a.png');
  setEnv(FULL);
});

console.log('④ 签名 URL 的形状（给浏览器的那一份）');
check('带正确的参数、且键按段编码（/ 不转义）', () => {
  const url = new URL(signedUrl('2026/09/my file.png', { expires: 600, contentDisposition: 'attachment; filename="x.png"' }));
  assert.equal(url.host, 'bucket-a.oss-cn-guangzhou.aliyuncs.com');
  assert.equal(url.pathname, '/2026/09/my%20file.png');
  assert.equal(url.searchParams.get('OSSAccessKeyId'), 'AKIDEXAMPLE');
  assert.ok(Number(url.searchParams.get('Expires')) > Math.floor(Date.now() / 1000));
  assert.ok((url.searchParams.get('Signature') || '').length > 10);
  assert.equal(url.searchParams.get('response-content-disposition'), 'attachment; filename="x.png"');
});
check('有效期可以要求更长（上传大文件用）', () => {
  const short = Number(new URL(signedUrl('a.png', { expires: 60 })).searchParams.get('Expires'));
  const long = Number(new URL(signedUrl('a.png', { expires: 3600 })).searchParams.get('Expires'));
  assert.ok(long - short >= 3500, `差值应接近 3540，实际 ${long - short}`);
});

console.log('⑤ fail-closed：配置不全时必须退回本地');
check('FILE_STORAGE=oss 但缺密钥 → 仍然是 local', () => {
  setEnv({ FILE_STORAGE: 'oss', OSS_BUCKET: 'bucket-a', OSS_ENDPOINT: 'oss-cn-guangzhou.aliyuncs.com' });
  assert.equal(ossConfigured(), false);
  assert.equal(storageBackend(), 'local');
});
check('什么都不配 → local', () => {
  setEnv({});
  assert.equal(ossConfigured(), false);
  assert.equal(storageBackend(), 'local');
});
check('FILE_STORAGE 不是 oss → 即使配置齐全也是 local', () => {
  setEnv({ ...FULL, FILE_STORAGE: 'local' });
  assert.equal(ossConfigured(), true);
  assert.equal(storageBackend(), 'local');
});
check('配置齐全 + FILE_STORAGE=oss → oss', () => {
  setEnv(FULL);
  assert.equal(storageBackend(), 'oss');
});
check('只有 region 没给 endpoint 也能推出公网端点', () => {
  setEnv({ ...FULL, OSS_ENDPOINT: '', OSS_REGION: 'cn-guangzhou' });
  assert.equal(new URL(signedUrl('a.png')).host, 'bucket-a.oss-cn-guangzhou.aliyuncs.com');
});

// 还原环境
setEnv(saved);

if (failures) { console.log(`\nP136 失败：${failures} 项`); process.exit(1); }
console.log('\nP136 全部通过');
