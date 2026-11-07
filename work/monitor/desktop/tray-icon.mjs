// tray-icon.mjs —— 菜单栏托盘图标位图（纯函数，Node 可测；不 import electron）。
//
// 造型与 Dock 图标（scripts/assets/app-icon.svg）同一语言：上方两个节点相连、各自连到下方的集群节点；
// 右下角是状态圆点（灰 = 空闲 / 绿 = 正常 / 黄 = 降级 / 红 = 断开），圆点外圈挖空一道缝与字形分开。
// 字形是单色：深色外观白、浅色外观黑（托盘按 nativeTheme 切换重绘）。彩色状态点与单色字形放在同一张图里，
// 所以不能用 template image（template 会把所有像素染成同一色）。
//
// 输出 nativeImage.createFromBitmap 要的预乘 BGRA（Electron 实测字节序为 B,G,R,A）。
// 旧实现把 SVG 字符串交给 createFromBuffer，但它只解码 PNG/JPEG，得到 0×0 空图（菜单栏透明空位）。

export const TRAY_ICON_PX = 36; // 18pt @2x：createFromBitmap 传 scaleFactor 2
export const TRAY_STATUS_DOT = { x: 29, y: 29, r: 4.6 }; // 状态点（像素坐标，@2x）
const STATUS_GAP = 1.8; // 状态点外圈挖空宽度
const SUPERSAMPLE = 4;

// 字形（@2x 像素坐标）：三个实心节点 + 三条连线
const NODES = [
  { x: 8, y: 9, r: 4.4 },
  { x: 25, y: 9, r: 4.4 },
  { x: 16.5, y: 24.5, r: 4.8 },
];
const LINK_WIDTH = 2.6;
const LINKS = [
  [NODES[0], NODES[1]],
  [NODES[0], NODES[2]],
  [NODES[1], NODES[2]],
];

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) throw new Error(`托盘图标颜色必须是 #rrggbb：${hex}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function inGlyph(px, py) {
  for (const n of NODES) if (Math.hypot(px - n.x, py - n.y) <= n.r) return true;
  for (const [a, b] of LINKS) if (distToSegment(px, py, a, b) <= LINK_WIDTH / 2) return true;
  return false;
}

export function renderTrayIconBitmap(statusColor, { dark = true } = {}) {
  const [sr, sg, sb] = parseHex(statusColor);
  const glyph = dark ? [255, 255, 255] : [0, 0, 0];
  const glyphAlpha = dark ? 0.95 : 0.85;
  const size = TRAY_ICON_PX;
  const dot = TRAY_STATUS_DOT;
  const buf = Buffer.alloc(size * size * 4);
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0; // 预乘累加
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = x + (sx + 0.5) / SUPERSAMPLE;
          const py = y + (sy + 0.5) / SUPERSAMPLE;
          const dDot = Math.hypot(px - dot.x, py - dot.y);
          if (dDot <= dot.r) {
            r += sr; g += sg; b += sb; a += 1;
          } else if (dDot > dot.r + STATUS_GAP && inGlyph(px, py)) {
            r += glyph[0] * glyphAlpha; g += glyph[1] * glyphAlpha; b += glyph[2] * glyphAlpha; a += glyphAlpha;
          }
        }
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(b / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(r / n);
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}
