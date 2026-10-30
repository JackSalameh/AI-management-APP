// Minimal ZIP reader (stored + deflate entries) used to extract official logos from vendor logo packs.
import zlib from 'node:zlib';

export function listZip(buf) {
  // End of central directory record: signature 0x06054b50, searched from the end (comment ≤ 64 KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    entries.push({ name: buf.toString('utf8', p + 46, p + 46 + nlen), method, csize, size, off });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

export function readEntry(buf, e) {
  if (buf.readUInt32LE(e.off) !== 0x04034b50) throw new Error('Corrupt ZIP entry');
  const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 5 * 1024 * 1024 });
  throw new Error(`Unsupported ZIP compression ${e.method}`);
}

/** Picks the product's isolated logomark (icon only, brand colours) from a logo pack. */
export function pickLogomark(entries) {
  const score = (n) => {
    const s = n.toLowerCase();
    if (s.includes('__macosx') || s.endsWith('/')) return -99;
    let v = s.endsWith('.svg') ? 20 : s.endsWith('.png') ? 10 : -99;
    if (/logomark|[-_/ ]mark|icon/.test(s)) v += 8;
    if (/wordmark|lockup|attribution|horizontal|vertical|with.?text|full/.test(s)) v -= 8;
    if (/white|neutral|inverse|black|mono|dark-?mode|reversed/.test(s)) v -= 4;
    if (/brand|blue|colou?r|default|primary/.test(s)) v += 2;
    return v;
  };
  return entries.filter((e) => e.size > 0 && e.size < 1_000_000).map((e) => ({ e, v: score(e.name) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v)[0]?.e || null;
}
