// 最小 ZIP 写入器 —— 只用 node:zlib，不引任何第三方包。
//
// 为什么自己写：docx / xlsx / pptx 本质都是「一堆 XML 的 ZIP 包」，而服务端目前**零 npm 依赖**，
// release 也只拷 server/database 源码（不装 node_modules）。为一个 ZIP 去引库会打破这套发布方式，
// 所以这里手写一个够用的（本地文件头 + 中央目录 + EOCD）。
//
// 几个必须做对、做错就「文件打不开但没有任何报错」的点：
//   · 名字与内容都用 UTF-8，且要置 **bit 11 (0x0800)**，否则中文文件名在 Windows 上变乱码；
//   · 每个条目的 crc32 / 压缩前后长度必须和实际字节一致（Office 会校验）；
//   · 中央目录里的 localHeaderOffset 必须指向真正的本地头偏移；
//   · OOXML 要求 `[Content_Types].xml` 是**第一个**条目（多数阅读器按此假设）。
// 时间戳固定成 1980-01-01，产出字节可复现（测试能直接比哈希）。
import { deflateRawSync, crc32 } from 'node:zlib';

const DOS_TIME = 0;   // 00:00:00
const DOS_DATE = 33;  // 1980-01-01（DOS 日期从 1980 起算，33 = 0x0021）

/**
 * @param {Array<{name: string, data: Buffer|string, store?: boolean}>} entries
 * @returns {Buffer} 完整的 zip 字节
 */
export function createZip(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('zip 至少要有一个条目');
  const files = [];
  const seen = new Set();
  for (const entry of entries) {
    const name = String(entry?.name || '').replaceAll('\\', '/');
    if (!name || name.startsWith('/') || name.includes('..')) throw new Error(`zip 条目名不合法：${name}`);
    if (seen.has(name)) throw new Error(`zip 条目重名：${name}`);
    seen.add(name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    // 已经压过的东西（图片、嵌套 zip）再压一次只会变大，直接 store
    const raw = deflateRawSync(data, { level: 9 });
    const store = entry.store === true || raw.length >= data.length;
    files.push({ name, data, body: store ? data : raw, method: store ? 0 : 8, crc: crc32(data) });
  }

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    local.writeUInt16LE(20, 4);           // 解压所需版本
    local.writeUInt16LE(0x0800, 6);       // bit 11 = 文件名是 UTF-8
    local.writeUInt16LE(file.method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(file.crc, 14);
    local.writeUInt32LE(file.body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);           // extra 长度
    chunks.push(local, nameBytes, file.body);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);    // 中央目录签名
    head.writeUInt16LE(20, 4);            // version made by
    head.writeUInt16LE(20, 6);            // version needed
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(file.method, 10);
    head.writeUInt16LE(DOS_TIME, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(file.crc, 16);
    head.writeUInt32LE(file.body.length, 20);
    head.writeUInt32LE(file.data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt16LE(0, 30);            // extra
    head.writeUInt16LE(0, 32);            // comment
    head.writeUInt16LE(0, 34);            // disk number
    head.writeUInt16LE(0, 36);            // internal attrs
    head.writeUInt32LE(0, 38);            // external attrs
    head.writeUInt32LE(offset, 42);       // 本地头偏移
    central.push(head, nameBytes);

    offset += local.length + nameBytes.length + file.body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // EOCD 签名
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // 注释长度
  return Buffer.concat([...chunks, centralBuffer, end]);
}

/** XML 文本转义（属性与文本共用一套，够用且安全） */
export function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

/** 去掉 XML 1.0 不允许的控制字符（模型偶尔会吐出来，留着会让整份文件打不开） */
export function xmlSafe(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}
