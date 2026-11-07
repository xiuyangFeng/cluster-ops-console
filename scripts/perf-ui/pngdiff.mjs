// 无依赖 PNG 逐像素比对：用于「优化前后观感是否一致」的客观校验。
// 用法：node pngdiff.mjs <a.png> <b.png> [--tolerance=8] [--heatmap=out.png]
// 输出：不同像素占比、平均/最大通道差、最大差异位置；像素总差超过容差才算「不同」。
import fs from "node:fs";
import zlib from "node:zlib";

function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} 不是 PNG`);
  let pos = 8; let ihdr = null; const idat = []; let palette = null; let trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === "IDAT") idat.push(data);
    else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    pos += 12 + len;
  }
  if (!ihdr) throw new Error("缺少 IHDR");
  if (ihdr.depth !== 8) throw new Error(`只支持 8bit（当前 ${ihdr.depth}）`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${ihdr.colorType}`);
  if (ihdr.interlace) throw new Error("不支持隔行 PNG");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const bpp = channels; const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, colorType: ihdr.colorType, palette, trns, data: out };
}

function rgba(img, x, y) {
  const { width, channels, colorType, palette, trns, data } = img;
  const i = (y * width + x) * channels;
  if (colorType === 6) return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  if (colorType === 2) return [data[i], data[i + 1], data[i + 2], 255];
  if (colorType === 0) return [data[i], data[i], data[i], 255];
  if (colorType === 4) return [data[i], data[i], data[i], data[i + 1]];
  if (colorType === 3) { const p = data[i] * 3; return [palette[p], palette[p + 1], palette[p + 2], trns && trns[data[i]] !== undefined ? trns[data[i]] : 255]; }
  return [0, 0, 0, 255];
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const [aFile, bFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const tolerance = Number(opt.tolerance || 8);
const a = decodePng(aFile); const b = decodePng(bFile);
if (a.width !== b.width || a.height !== b.height) {
  console.log(JSON.stringify({ same: false, reason: `尺寸不同：${a.width}x${a.height} vs ${b.width}x${b.height}` }));
  process.exit(1);
}
let differing = 0; let totalDiff = 0; let maxDiff = 0; let maxAt = null;
const heat = opt.heatmap ? Buffer.alloc(a.width * a.height * 3) : null;
for (let y = 0; y < a.height; y++) {
  for (let x = 0; x < a.width; x++) {
    const p = rgba(a, x, y); const q = rgba(b, x, y);
    let d = 0; for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(p[k] - q[k]));
    totalDiff += d; if (d > maxDiff) { maxDiff = d; maxAt = [x, y]; }
    if (d > tolerance) differing += 1;
    if (heat) { const i = (y * a.width + x) * 3; heat[i] = Math.min(255, d * 4); heat[i + 1] = d > tolerance ? 0 : 40; heat[i + 2] = 0; }
  }
}
const pixels = a.width * a.height;
const result = { same: differing === 0, differingPixels: differing, pixelPct: Math.round((differing / pixels) * 10000) / 100,
  meanChannelDiff: Math.round((totalDiff / pixels) * 100) / 100, maxChannelDiff: maxDiff, maxAt, tolerance,
  size: `${a.width}x${a.height}` };
if (heat) { const file = opt.heatmap; fs.writeFileSync(file, encodePng(a.width, a.height, heat)); result.heatmap = file; }
console.log(JSON.stringify(result, null, 2));
