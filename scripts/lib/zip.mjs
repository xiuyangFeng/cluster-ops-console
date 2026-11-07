// Small UTF-8 ZIP writer for distribution bundles. No runtime dependency or platform zip command.
import { deflateRawSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, i) => {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
const crc32 = data => {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
};

export function createZip(entries) {
  if (entries.length > 65535) throw new Error("ZIP file limit exceeded");
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data, mode = 0o100644 } of entries) {
    if (!name || name.startsWith("/") || name.split("/").some(p => p === "..") || name.includes("\\")) throw new Error("Unsafe archive path");
    const filename = Buffer.from(name, "utf8"), packed = deflateRawSync(data);
    if (filename.length > 65535 || data.length > 0xffffffff || offset + packed.length > 0xffffffff) throw new Error("ZIP size limit exceeded");
    const header = Buffer.alloc(30), dir = Buffer.alloc(46), crc = crc32(data);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(0x314, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x800, 8); dir.writeUInt16LE(8, 10); dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(filename.length, 28);
    dir.writeUInt32LE((mode << 16) >>> 0, 38); dir.writeUInt32LE(offset, 42);
    locals.push(header, filename, packed); central.push(dir, filename);
    offset += header.length + filename.length + packed.length;
  }
  const centralSize = central.reduce((sum, b) => sum + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
