'use strict';

/** Минимальный ZIP-ридер (для DOCX) на DecompressionStream — без зависимостей. */

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream недоступен на этом устройстве');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Файл не похож на ZIP/DOCX');
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (view.getUint32(off, true) !== 0x02014b50) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const local = view.getUint32(off + 42, true);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    entries.set(name, { method, compSize, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const readBytes = async (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const nl = view.getUint16(e.local + 26, true);
    const el = view.getUint16(e.local + 28, true);
    const start = e.local + 30 + nl + el;
    const data = bytes.subarray(start, start + e.compSize);
    if (e.method === 0) return data.slice();
    if (e.method === 8) return inflateRaw(data);
    throw new Error(`Неподдерживаемое сжатие ZIP: ${e.method}`);
  };
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    bytes: readBytes,
    text: async (name) => {
      const b = await readBytes(name);
      return b ? dec.decode(b) : null;
    },
  };
}

module.exports = { readZip };
