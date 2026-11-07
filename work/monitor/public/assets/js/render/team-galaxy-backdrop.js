// team-galaxy-backdrop.js —— 团队星图的静态背景：深空（星云 / 银河带 / 星野 / 亮星衍射芒）与
// 纸面星图（纸纹 / 天球经纬网 / 墨点星 / 双线图框与刻度）。画一次就不再动；闪烁星只给参数，
// 由 team-galaxy-fx.js 在连线画布上逐帧画。随机数带种子，重画时星星不挪位置。
// 开销（v2.70 实测后改的）：几千颗星按「颜色 × 透明度十档」合并成少数几条路径一次 fill；
// 星云、银河带的柔光、纸面污渍这些本来就是大块柔和渐变的，画在 1/4 分辨率的离屏层上再放大贴回——
// 看不出差别，栅格化的像素量少 16 倍。

export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const LOW_RES = 0.25;
function offscreen(ctx, w, h) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  const c = ctx.canvas.ownerDocument.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
// 1/4 分辨率离屏层：draw(lctx) 用和主画布相同的 CSS 像素坐标画，返回层画布
function lowResLayer(ctx, W, H, draw) {
  const layer = offscreen(ctx, Math.max(8, Math.ceil(W * LOW_RES)), Math.max(8, Math.ceil(H * LOW_RES)));
  const lctx = layer.getContext("2d");
  lctx.scale(LOW_RES, LOW_RES);
  draw(lctx);
  return layer;
}
function blitLayer(ctx, layer, W, H, op) {
  ctx.save();
  ctx.globalCompositeOperation = op;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(layer, 0, 0, W, H);
  ctx.restore();
}

// 圆点分桶：同色同透明度档的点合成一条路径
function dotBuckets() {
  const map = new Map();
  return {
    add(color, alpha, x, y, rad) {
      const key = `${color}|${Math.max(1, Math.min(10, Math.round(alpha * 10)))}`;
      let pts = map.get(key);
      if (!pts) {
        pts = [];
        map.set(key, pts);
      }
      pts.push(x, y, rad);
    },
    flush(ctx) {
      for (const [key, pts] of map) {
        const bar = key.lastIndexOf("|");
        ctx.globalAlpha = Number(key.slice(bar + 1)) / 10;
        ctx.fillStyle = key.slice(0, bar);
        ctx.beginPath();
        for (let i = 0; i < pts.length; i += 3) {
          ctx.moveTo(pts[i] + pts[i + 2], pts[i + 1]);
          ctx.arc(pts[i], pts[i + 1], pts[i + 2], 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      map.clear();
    },
  };
}

export function drawDeepSky(ctx, W, H, cx, cy) {
  const r = mulberry32(7);
  let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(W, H) * 0.65);
  g.addColorStop(0, "#080d1e");
  g.addColorStop(0.48, "#040712");
  g.addColorStop(1, "#020308");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const bw = H * 0.32;
  const dots = dotBuckets();
  // 银河带：斜穿画面的细密星尘（无圆形大光斑）
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.34);
  ctx.globalCompositeOperation = "lighter";
  const bandN = Math.round(W * 1.45);
  for (let i = 0; i < bandN; i += 1) {
    const x = (r() - 0.5) * W * 1.6;
    const y = gauss(r) * bw * 0.3;
    const alpha = 0.14 + r() * 0.46;
    dots.add(r() < 0.72 ? "#cfdcff" : "#fff1dc", alpha, x, y, 0.25 + r() * 0.52);
  }
  dots.flush(ctx);
  ctx.restore();

  // 团簇式星野（6 个疏密有致的星团中心 + 微星座连线）
  const clusters = [
    { x: W * 0.16, y: H * 0.22, spread: Math.min(W, H) * 0.11 },
    { x: W * 0.82, y: H * 0.20, spread: Math.min(W, H) * 0.12 },
    { x: W * 0.20, y: H * 0.78, spread: Math.min(W, H) * 0.11 },
    { x: W * 0.84, y: H * 0.76, spread: Math.min(W, H) * 0.11 },
    { x: W * 0.48, y: H * 0.15, spread: Math.min(W, H) * 0.09 },
    { x: W * 0.54, y: H * 0.85, spread: Math.min(W, H) * 0.09 },
  ];
  const cols = ["#ffffff", "#d6e2ff", "#bcd0ff", "#fff0d6", "#ffe2c4"];
  const N = Math.round((W * H) / 620);
  const brightPts = [];
  for (let i = 0; i < N; i += 1) {
    let x;
    let y;
    if (r() < 0.64) {
      const cl = clusters[Math.floor(r() * clusters.length)];
      x = Math.max(6, Math.min(W - 6, cl.x + gauss(r) * cl.spread));
      y = Math.max(6, Math.min(H - 6, cl.y + gauss(r) * cl.spread * 0.72));
    } else {
      x = r() * W;
      y = r() * H;
    }
    const big = r() > 0.93;
    const s = big ? 0.85 + r() * 0.85 : 0.3 + r() * 0.52;
    const alpha = big ? 0.62 + r() * 0.36 : 0.22 + r() * 0.56;
    const col = cols[Math.floor(r() * cols.length)];
    dots.add(col, alpha, x, y, s);
    if (big && brightPts.length < 42) brightPts.push({ x, y });
  }
  dots.flush(ctx);

  // 星团内部微弱星座折线连线
  ctx.save();
  ctx.strokeStyle = "rgba(182, 206, 255, 0.13)";
  ctx.lineWidth = 0.55;
  ctx.beginPath();
  for (let i = 0; i < brightPts.length; i += 1) {
    for (let j = i + 1; j < brightPts.length; j += 1) {
      const d = Math.hypot(brightPts[i].x - brightPts[j].x, brightPts[i].y - brightPts[j].y);
      if (d > 18 && d < 78 && r() < 0.42) {
        ctx.moveTo(brightPts[i].x, brightPts[i].y);
        ctx.lineTo(brightPts[j].x, brightPts[j].y);
      }
    }
  }
  ctx.stroke();
  ctx.restore();

  // 亮星（只画十字衍射芒与锐利星核，不画大圆斑）
  for (let i = 0; i < 7; i += 1) {
    const x = r() * W;
    const y = r() * H * 0.9;
    const L = 7 + r() * 11;
    const col = r() < 0.6 ? "205,222,255" : "255,226,190";
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const lg = ctx.createLinearGradient(x - dx * L, y - dy * L, x + dx * L, y + dy * L);
      lg.addColorStop(0, `rgba(${col},0)`);
      lg.addColorStop(0.5, `rgba(${col},0.78)`);
      lg.addColorStop(1, `rgba(${col},0)`);
      ctx.strokeStyle = lg;
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(x - dx * L, y - dy * L);
      ctx.lineTo(x + dx * L, y + dy * L);
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x, y, 1.15, 0, Math.PI * 2);
    ctx.fill();
  }
  // 边缘自然压暗
  g = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.38, cx, cy, Math.hypot(W, H) * 0.64);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.48)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

export function drawPaperChart(ctx, W, H, cx, cy) {
  const r = mulberry32(11);
  ctx.fillStyle = "#f3eee2";
  ctx.fillRect(0, 0, W, H);
  // 纸张斑驳：低分辨率层，multiply 叠上去
  const stains = lowResLayer(ctx, W, H, (lc) => {
    for (let i = 0; i < 14; i += 1) {
      const x = r() * W;
      const y = r() * H;
      const rad = 60 + r() * 220;
      const g = lc.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `rgba(196,170,120,${0.05 + r() * 0.06})`);
      g.addColorStop(1, "rgba(196,170,120,0)");
      lc.fillStyle = g;
      lc.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
  });
  blitLayer(ctx, stains, W, H, "multiply");
  ctx.globalCompositeOperation = "multiply";
  const vg = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.3, cx, cy, Math.hypot(W, H) * 0.6);
  vg.addColorStop(0, "rgba(160,120,60,0)");
  vg.addColorStop(1, "rgba(160,120,60,0.22)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "source-over";
  // 纸纹：几千个小方点按透明度分档，每档一条路径
  const grain = new Map();
  const grainN = (W * H) / 90;
  for (let i = 0; i < grainN; i += 1) {
    const lvl = Math.round((0.025 + r() * 0.05) * 200);
    let pts = grain.get(lvl);
    if (!pts) {
      pts = [];
      grain.set(lvl, pts);
    }
    pts.push(r() * W, r() * H);
  }
  ctx.fillStyle = "rgb(90,70,40)";
  for (const [lvl, pts] of grain) {
    ctx.globalAlpha = lvl / 200;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) ctx.rect(pts[i], pts[i + 1], 0.6, 0.6);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 天球经纬网：以恒星为极点（同一样式，合成一条路径描一次）
  ctx.save();
  ctx.beginPath();
  ctx.rect(16, 16, W - 32, H - 32);
  ctx.clip();
  ctx.strokeStyle = "rgba(80,62,36,0.13)";
  ctx.lineWidth = 0.7;
  const maxR = Math.hypot(W, H);
  ctx.beginPath();
  for (let rad = 58; rad < maxR; rad += 58) {
    ctx.moveTo(cx + rad, cy);
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  }
  for (let a = 0; a < 24; a += 1) {
    const t = (a / 24) * Math.PI * 2;
    ctx.moveTo(cx + Math.cos(t) * 40, cy + Math.sin(t) * 40);
    ctx.lineTo(cx + Math.cos(t) * maxR, cy + Math.sin(t) * maxR);
  }
  ctx.stroke();
  // 墨点星：大小即星等
  const dots = dotBuckets();
  const rings = [];
  const N = Math.round((W * H) / 1500);
  for (let i = 0; i < N; i += 1) {
    const x = r() * W;
    const y = r() * H;
    const mag = r();
    const s = mag > 0.97 ? 1.9 : mag > 0.88 ? 1.25 : 0.45 + r() * 0.5;
    dots.add("rgb(36,40,58)", s > 1.2 ? 0.8 : 0.35 + r() * 0.35, x, y, s);
    if (mag > 0.97) rings.push(x, y, s + 2.4);
  }
  dots.flush(ctx);
  ctx.strokeStyle = "rgba(36,40,58,0.55)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let i = 0; i < rings.length; i += 3) {
    ctx.moveTo(rings[i] + rings[i + 2], rings[i + 1]);
    ctx.arc(rings[i], rings[i + 1], rings[i + 2], 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();

  // 双线图框 + 刻度
  ctx.strokeStyle = "rgba(60,46,28,0.62)";
  ctx.lineWidth = 1;
  ctx.strokeRect(8.5, 8.5, W - 17, H - 17);
  ctx.strokeStyle = "rgba(60,46,28,0.40)";
  ctx.lineWidth = 0.7;
  ctx.strokeRect(16.5, 16.5, W - 33, H - 33);
  ctx.strokeStyle = "rgba(60,46,28,0.45)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let x = 16; x <= W - 16; x += 10) {
    const L = (x - 16) % 50 === 0 ? 6 : 3;
    ctx.moveTo(x + 0.5, 9);
    ctx.lineTo(x + 0.5, 9 + L);
    ctx.moveTo(x + 0.5, H - 9);
    ctx.lineTo(x + 0.5, H - 9 - L);
  }
  for (let y = 16; y <= H - 16; y += 10) {
    const L = (y - 16) % 50 === 0 ? 6 : 3;
    ctx.moveTo(9, y + 0.5);
    ctx.lineTo(9 + L, y + 0.5);
    ctx.moveTo(W - 9, y + 0.5);
    ctx.lineTo(W - 9 - L, y + 0.5);
  }
  ctx.stroke();
}

// 团簇呼吸闪烁星：种子固定，按 5 个星团聚集分布，深空与纸面天台均赋予微呼吸生命力
export function makeTwinkles(width, theme) {
  const r = mulberry32(99);
  const n = theme === "light"
    ? Math.max(10, Math.min(36, Math.round(width / 38)))
    : Math.max(18, Math.min(72, Math.round(width / 22)));
  const centers = [
    [0.16, 0.22],
    [0.82, 0.20],
    [0.18, 0.76],
    [0.84, 0.74],
    [0.50, 0.16],
  ];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    let x;
    let y;
    if (r() < 0.72) {
      const [cx, cy] = centers[Math.floor(r() * centers.length)];
      x = Math.max(0.03, Math.min(0.97, cx + gauss(r) * 0.08));
      y = Math.max(0.04, Math.min(0.88, cy + gauss(r) * 0.07));
    } else {
      x = 0.03 + r() * 0.94;
      y = 0.04 + r() * 0.84;
    }
    out.push({
      warm: r() < 0.34,
      x,
      y,
      period: 2.6 + r() * 4.6,
      phase: r() * Math.PI * 2,
      size: 0.65 + r() * 0.95,
    });
  }
  return out;
}

