// team-galaxy-fx.js —— 团队星图的连线与天象（画在独立 canvas 上，位于行星 SVG 之下）：
//   隧道：行星色→恒星暖金的渐变线 + 柔光，彗星越靠近恒星越快，撞上时朝来向激起弧形涟漪、恒星微微一亮；
//   同节点：金线 + 两人之间来回穿梭的光珠；同配置：星光串上流动的亮度波；
//   悬停：从聚焦行星沿星座逐段传出光脉冲 + 声呐波纹；另有偶尔划过的流星、恒星背后反向慢转的两层光芒、闪烁星。
// 每帧开销（v2.70 实测后改的）：
//   · 颜色只缓存成 "rgb(r,g,b)"，透明度一律走 globalAlpha——不再每个点拼一个 rgba 字符串（GC 压力）；
//   · 配置星座的光点按透明度分 8 档，每档一条路径一次 fill（40 人时每帧 ~800 个点 → 8 次 fill）；
//   · 连线渐变只含颜色、按端点缓存（挪动 >1px 才重建），呼吸 / 聚焦变暗都乘在 globalAlpha 上；
//   · 光晕 / 彗尾 / 光芒 / 闪烁星预渲染成贴图（按颜色缓存，条目有上限）；
//   · 每条线最多 10 颗彗星、涟漪 14 个、流星 2 颗；quality 由主控按帧率逐级下调（2 全开 / 1 / 0 只留呼吸）。

const TAU = Math.PI * 2;
const COLORS = {
  dark: { tunnel: [143, 178, 255], star: [255, 204, 138], node: [240, 196, 142], config: [202, 178, 255], head: [255, 250, 240], meteor: [214, 228, 255], white: [255, 255, 255], bead: [255, 240, 214] },
  light: { tunnel: [42, 38, 32], star: [168, 112, 30], node: [180, 70, 47], config: [61, 90, 153], head: [42, 38, 32], meteor: [42, 38, 32], white: [42, 38, 32], bead: [180, 70, 47] },
};
const TWINKLE_COOL = [190, 212, 255];
const TWINKLE_WARM = [255, 214, 170];
const RAY_LAYERS = [
  [1, 1, 0.24],
  [-1.6, 0.7, 0.13],
];
const MAX_PARTS_PER_LINE = 10;
const MAX_RIPPLES = 14;
const MAX_METEORS = 2;
const MAX_SPRITES = 64;
const DOT_LEVELS = 8; // 配置光点的透明度分档
const ALPHA_MAX = 1.3; // lineAlpha 的上限（聚焦时 1.3）

export function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return [200, 200, 200];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a <= 0 ? 0 : a >= 1 ? 1 : a.toFixed(3)})`;
const rgbCache = new WeakMap();
function rgbOf(c) {
  let s = rgbCache.get(c);
  if (!s) {
    s = `rgb(${c[0]},${c[1]},${c[2]})`;
    rgbCache.set(c, s);
  }
  return s;
}
export const mixRgb = (c1, c2, t) => [0, 1, 2].map((i) => Math.round(c1[i] + (c2[i] - c1[i]) * t));
const clamp01 = (a) => (a <= 0 ? 0 : a >= 1 ? 1 : a);

// 配置星座的弧线控制点：两端中点向远离恒星的方向鼓出（和节点直线一眼可分）。
export function configCtrl(scene, L) {
  const mx = (L.a.x + L.b.x) / 2;
  const my = (L.a.y + L.b.y) / 2;
  const ox = mx - scene.cx;
  const oy = my - scene.cy;
  const od = Math.hypot(ox, oy) || 1;
  const bow = Math.min(46, Math.hypot(L.b.x - L.a.x, L.b.y - L.a.y) * 0.22);
  return [mx + (ox / od) * bow, my + (oy / od) * bow];
}

export function createGalaxyFx({ doc = typeof document !== "undefined" ? document : null, random = Math.random } = {}) {
  const sprites = new Map();
  let ctx = null;
  let dpr = 1;
  let W = 0;
  let H = 0;
  let epoch = 0; // 换画布（resize）后作废缓存的渐变
  let ripples = [];
  let meteors = [];
  let meteorWait = 2.5;
  let flare = 0;
  const dotBuckets = Array.from({ length: DOT_LEVELS }, () => []); // 扁平 [x, y, r, ...]，每帧复用
  const headDots = []; // 常规亮度彗星头批量 [x, y, r, ...]，每帧一次 fill

  function cacheSprite(key, make) {
    let s = sprites.get(key);
    if (s) return s;
    if (sprites.size >= MAX_SPRITES) sprites.delete(sprites.keys().next().value);
    s = make();
    sprites.set(key, s);
    return s;
  }
  function canvas(w, h) {
    const c = doc.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  function radialSprite(key, stops) {
    return cacheSprite(key, () => {
      const s = canvas(64, 64);
      const x = s.getContext("2d");
      const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      for (const [o, col] of stops) g.addColorStop(o, col);
      x.fillStyle = g;
      x.fillRect(0, 0, 64, 64);
      return s;
    });
  }
  const glowSprite = (c) => radialSprite(`g${c}`, [[0, rgba(c, 1)], [0.22, rgba(c, 0.42)], [0.55, rgba(c, 0.1)], [1, rgba(c, 0)]]);
  // 闪烁星：光晕和白色星核画在同一张贴图里，每颗一次 drawImage
  const twinkleSprite = (c) => radialSprite(`w${c}`, [[0, "rgba(255,255,255,1)"], [0.14, "rgba(255,255,255,0.9)"], [0.2, rgba(c, 0.55)], [0.5, rgba(c, 0.12)], [1, rgba(c, 0)]]);
  function tailSprite(c) {
    return cacheSprite(`t${c}`, () => {
      const s = canvas(128, 8);
      const x = s.getContext("2d");
      const g = x.createLinearGradient(0, 0, 128, 0);
      g.addColorStop(0, rgba(c, 0));
      g.addColorStop(0.7, rgba(c, 0.5));
      g.addColorStop(1, rgba(c, 1));
      x.fillStyle = g;
      x.fillRect(0, 0, 128, 8);
      x.globalCompositeOperation = "destination-in";
      const v = x.createLinearGradient(0, 0, 0, 8);
      v.addColorStop(0, "rgba(0,0,0,0)");
      v.addColorStop(0.5, "rgba(0,0,0,1)");
      v.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = v;
      x.fillRect(0, 0, 128, 8);
      return s;
    });
  }
  function raysSprite() {
    return cacheSprite("rays", () => {
      const s = canvas(320, 320);
      const x = s.getContext("2d");
      x.translate(160, 160);
      for (let i = 0; i < 14; i += 1) {
        const a = (i / 14) * TAU + (i % 2 ? 0.09 : 0);
        const w = i % 3 === 0 ? 0.07 : 0.035;
        const L = i % 2 ? 158 : 112;
        const g = x.createRadialGradient(0, 0, 12, 0, 0, L);
        g.addColorStop(0, "rgba(255,212,150,0.5)");
        g.addColorStop(1, "rgba(255,212,150,0)");
        x.fillStyle = g;
        x.beginPath();
        x.moveTo(0, 0);
        x.arc(0, 0, L, a - w, a + w);
        x.closePath();
        x.fill();
      }
      return s;
    });
  }

  const sprite = (img, x, y, r, a) => {
    if (a <= 0.01) return;
    ctx.globalAlpha = clamp01(a);
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
  };
  const glow = (c, x, y, r, a) => sprite(glowSprite(c), x, y, r, a);
  // 彗尾：头在 (x,y)，尾巴朝 -(ux,uy) 方向拖出 len
  const tail = (c, x, y, ux, uy, len, w, a) => {
    if (a <= 0.01 || len < 1) return;
    ctx.setTransform(ux * dpr, uy * dpr, -uy * dpr, ux * dpr, x * dpr, y * dpr);
    ctx.globalAlpha = clamp01(a);
    ctx.drawImage(tailSprite(c), -len, -w / 2, len, w);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const dot = (c, x, y, r, a) => {
    if (a <= 0.01) return;
    ctx.globalAlpha = clamp01(a);
    ctx.fillStyle = rgbOf(c);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  };
  const seg = (x1, y1, x2, y2) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  const ring = (c, x, y, r, a, width, a0 = 0, a1 = TAU) => {
    if (a <= 0.01) return;
    ctx.globalAlpha = clamp01(a);
    ctx.strokeStyle = rgbOf(c);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, r, a0, a1);
    ctx.stroke();
  };
  const flash = (x, y, col, a, dark) => {
    if (dark) {
      glow(col, x, y, 13, 0.9 * a);
      dot(COLORS.dark.white, x, y, 2.1, a);
    } else {
      ring(col, x, y, 4.2, 0.8 * a, 1);
      dot(col, x, y, 1.8, a);
    }
  };
  // 渐变只含颜色（stops：[offset, rgb, alpha]），端点挪动 >1px 才重建；整体透明度由调用方的 globalAlpha 给
  function lineGradient(L, x1, y1, x2, y2, stops) {
    const g0 = L.grad;
    if (g0 && L.gradEpoch === epoch && Math.abs(L.gx1 - x1) < 1 && Math.abs(L.gy1 - y1) < 1 && Math.abs(L.gx2 - x2) < 1 && Math.abs(L.gy2 - y2) < 1) return g0;
    const g = ctx.createLinearGradient(x1, y1, x2, y2);
    for (const [o, c, a] of stops) g.addColorStop(o, rgba(c, a));
    L.grad = g;
    L.gradEpoch = epoch;
    L.gx1 = x1;
    L.gy1 = y1;
    L.gx2 = x2;
    L.gy2 = y2;
    return g;
  }

  function lineAlpha(scene, L) {
    const layer = L.kind === "ssh" ? "tunnel" : L.kind;
    if (scene.hidden.has(layer)) return 0;
    let a = 1;
    if (scene.focus) a *= scene.focusLines.has(L) ? 1.3 : 0.07;
    if (scene.layerFocus && scene.layerFocus !== layer) a *= 0.12;
    if (L.muted) a *= 0.07;
    return a;
  }

  // 从聚焦行星出发沿星座逐段传出的光脉冲：返回本段上的位置（0→1 为 a→b），不在本段时为 null
  function focusPulse(scene, L, T) {
    if (!scene.focus || !scene.focusLines.has(L)) return null;
    const k0 = (T - scene.focusT0) * 1.6;
    if (L.kind === "tunnel") return L.a.m.user === scene.focus && k0 >= 0 && k0 <= 1 ? k0 : null;
    if (!L.grp) return null;
    const f = L.grp.users.indexOf(scene.focus);
    if (f < 0) return null;
    const fwd = L.idx >= f;
    const k = k0 - (fwd ? L.idx - f : f - 1 - L.idx) * 0.9;
    if (k < 0 || k > 1) return null;
    return fwd ? k : 1 - k;
  }

  function drawMeteors(dt, C, dark) {
    meteorWait -= dt;
    if (meteorWait <= 0 && meteors.length < MAX_METEORS) {
      meteorWait = 6 + random() * 8;
      const ang = (random() < 0.5 ? 0.45 : Math.PI - 0.45) + (random() - 0.5) * 0.3; // 斜向下划过
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      meteors.push({
        x: (ux > 0 ? 0.04 + random() * 0.5 : 0.46 + random() * 0.5) * W,
        y: (0.04 + random() * 0.3) * H,
        ux, uy, v: 520 + random() * 380, t: 0, life: 0.7 + random() * 0.45, len: 80 + random() * 80,
      });
    }
    for (let i = meteors.length - 1; i >= 0; i -= 1) {
      const m = meteors[i];
      m.t += dt;
      if (m.t >= m.life) {
        meteors.splice(i, 1);
        continue;
      }
      m.x += m.ux * m.v * dt;
      m.y += m.uy * m.v * dt;
      const a = Math.sin(Math.PI * (m.t / m.life)); // 淡入淡出
      tail(C.meteor, m.x, m.y, m.ux, m.uy, m.len * (0.4 + 0.6 * a), dark ? 2.4 : 1.4, (dark ? 0.9 : 0.5) * a);
      if (dark) glow(C.meteor, m.x, m.y, 8, 0.8 * a);
      dot(C.white, m.x, m.y, dark ? 1.15 : 0.9, a);
    }
  }

  function drawTunnel(scene, L, a, br, dt, T, C, dark, moving) {
    const { cx, cy, starR } = scene;
    const p = L.a;
    const dx = cx - p.x;
    const dy = cy - p.y;
    const dd = Math.hypot(dx, dy) || 1;
    const ux = dx / dd;
    const uy = dy / dd;
    const x1 = p.x + ux * p.r * p.s;
    const y1 = p.y + uy * p.r * p.s;
    const x2 = cx - ux * (starR + 4);
    const y2 = cy - uy * (starR + 4);
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 6) return;
    if (L.kind === "ssh") {
      ctx.setLineDash([2, 5]);
      ctx.globalAlpha = clamp01((dark ? 0.32 : 0.42) * a * br);
      ctx.strokeStyle = rgbOf(C.tunnel);
      ctx.lineWidth = 1;
      seg(x1, y1, x2, y2);
      ctx.setLineDash([]);
      return;
    }
    ctx.strokeStyle = lineGradient(L, x1, y1, x2, y2, dark
      ? [[0, p.hue, 0.5 * ALPHA_MAX], [1, C.star, 0.42 * ALPHA_MAX]]
      : [[0, C.tunnel, 0.5 * ALPHA_MAX], [1, C.tunnel, 0.35 * ALPHA_MAX]]);
    const base = (a * br) / ALPHA_MAX;
    ctx.globalAlpha = clamp01(base);
    ctx.lineWidth = dark ? 1 : 0.8;
    seg(x1, y1, x2, y2);
    if (dark) {
      ctx.globalAlpha = clamp01(base * 0.13);
      ctx.lineWidth = 6;
      seg(x1, y1, x2, y2);
    }
    const rate = L.rate * (scene.quality >= 2 ? 1 : scene.quality === 1 ? 0.5 : 0);
    if (moving && rate) {
      L.acc += dt * rate;
      while (L.acc >= 1) {
        L.acc -= 1;
        if (L.parts.length < MAX_PARTS_PER_LINE) L.parts.push({ s: 0, v: 0.8 + random() * 0.4 });
      }
    }
    const tc = dark ? p.hue : C.tunnel;
    for (let i = L.parts.length - 1; i >= 0; i -= 1) {
      const pt = L.parts[i];
      if (moving) pt.s += (dt * 44 * pt.v * (0.5 + 1.25 * pt.s)) / len; // 越近越快：被恒星"吸"进去
      if (pt.s >= 1) {
        L.parts.splice(i, 1);
        if (a > 0.3) {
          if (ripples.length < MAX_RIPPLES) ripples.push({ t: 0, ang: Math.atan2(-uy, -ux), a: Math.min(1, a) });
          flare = Math.min(1, flare + 0.16);
        }
        continue;
      }
      if (!rate && !moving) continue;
      const hx = x1 + (x2 - x1) * pt.s;
      const hy = y1 + (y2 - y1) * pt.s;
      tail(tc, hx, hy, ux, uy, Math.min(pt.s * len, 9 + 22 * pt.s), dark ? 3 : 2.2, 0.95 * a);
      if (dark) glow(tc, hx, hy, 6, 0.6 * a);
      if (a >= 0.95) headDots.push(hx, hy, dark ? 1.25 : 1.35);
      else dot(C.head, hx, hy, dark ? 1.25 : 1.35, 0.95 * a);
    }
    if (scene.quality === 0) L.parts.length = 0;
    const fp = focusPulse(scene, L, T);
    if (fp != null) {
      const e = fp * fp;
      flash(x1 + (x2 - x1) * e, y1 + (y2 - y1) * e, tc, 1, dark);
    }
  }

  function drawNode(scene, L, a, br, T, C, dark, moving) {
    const A = L.a;
    const B = L.b;
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    if (len < 6) return;
    if (!L.mixA) {
      L.mixA = mixRgb(A.hue, COLORS.dark.node, 0.55);
      L.mixB = mixRgb(B.hue, COLORS.dark.node, 0.55);
    }
    ctx.strokeStyle = lineGradient(L, A.x, A.y, B.x, B.y, dark
      ? [[0, L.mixA, 0.5 * ALPHA_MAX], [0.5, C.node, 0.72 * ALPHA_MAX], [1, L.mixB, 0.5 * ALPHA_MAX]]
      : [[0, C.node, 0.78 * ALPHA_MAX], [1, C.node, 0.78 * ALPHA_MAX]]);
    const base = (a * br) / ALPHA_MAX;
    ctx.globalAlpha = clamp01(base);
    ctx.lineWidth = dark ? 1.15 : 1;
    seg(A.x, A.y, B.x, B.y);
    if (dark) {
      ctx.globalAlpha = clamp01((0.09 + 0.05 * br) * (a / ALPHA_MAX) * 1.4);
      ctx.lineWidth = 7;
      seg(A.x, A.y, B.x, B.y);
    }
    if (scene.quality >= 1) {
      // 穿梭光珠：两人共用一台节点，算力在彼此之间来回
      const u = moving ? ((T + L.off) / L.period) % 2 : 0.5;
      const t = u < 1 ? u : 2 - u;
      const e = t * t * (3 - 2 * t);
      const dir = u < 1 ? 1 : -1;
      const vx = ((B.x - A.x) / len) * dir;
      const vy = ((B.y - A.y) / len) * dir;
      const hx = A.x + (B.x - A.x) * e;
      const hy = A.y + (B.y - A.y) * e;
      tail(C.node, hx, hy, vx, vy, 3 + 120 * t * (1 - t), dark ? 3 : 2, 0.95 * a);
      if (dark) glow(C.node, hx, hy, 8, 0.7 * a);
      dot(C.bead, hx, hy, dark ? 1.6 : 1.7, a);
    }
    const fp = focusPulse(scene, L, T);
    if (fp != null) flash(A.x + (B.x - A.x) * fp, A.y + (B.y - A.y) * fp, C.node, 1, dark);
  }

  // 配置星座：光点只登记进透明度分档，等所有线画完再每档一次 fill（见 flushDots）
  function drawConfig(scene, L, a, br, T, C, dark, moving) {
    const A = L.a;
    const B = L.b;
    const chord = Math.hypot(B.x - A.x, B.y - A.y);
    if (chord < 6) return;
    const [qx, qy] = configCtrl(scene, L);
    const n = Math.max(5, Math.round((chord * 1.08) / 6.5));
    const fp = focusPulse(scene, L, T);
    const glowOn = dark && scene.quality >= 1;
    const k = a * (0.72 + 0.28 * br);
    for (let i = 1; i < n; i += 1) {
      const t = i / n;
      const mt = 1 - t;
      const x = mt * mt * A.x + 2 * mt * t * qx + t * t * B.x;
      const y = mt * mt * A.y + 2 * mt * t * qy + t * t * B.y;
      const w = moving ? Math.sin(t * TAU * 1.25 - T * 1.5 + L.ph) : 0;
      let b = w > 0 ? w * w * w * w : 0; // 亮度波沿弧线流动
      if (fp != null) b = Math.max(b, Math.exp(-(((t - fp) / 0.07) ** 2)) * 1.4);
      const bb = b > 1 ? 1 : b;
      if (glowOn && b > 0.42 && (i & 1) === 0) glow(C.config, x, y, 5.5, 0.55 * bb * a);
      const alpha = (0.18 + 0.72 * bb) * k;
      if (alpha <= 0.01) continue;
      const lvl = Math.min(DOT_LEVELS - 1, Math.floor((alpha / ALPHA_MAX) * DOT_LEVELS));
      dotBuckets[lvl].push(x, y, 0.85 + 0.8 * Math.min(1.2, b));
    }
  }
  function flushDots(c, headCol) {
    if (headDots.length) {
      ctx.fillStyle = rgbOf(headCol);
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      for (let i = 0; i < headDots.length; i += 3) {
        const x = headDots[i];
        const y = headDots[i + 1];
        const r = headDots[i + 2];
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
      }
      ctx.fill();
      headDots.length = 0;
    }
    ctx.fillStyle = rgbOf(c);
    for (let lvl = 0; lvl < DOT_LEVELS; lvl += 1) {
      const pts = dotBuckets[lvl];
      if (!pts.length) continue;
      ctx.globalAlpha = clamp01(((lvl + 0.5) / DOT_LEVELS) * ALPHA_MAX);
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 3) {
        ctx.moveTo(pts[i] + pts[i + 2], pts[i + 1]);
        ctx.arc(pts[i], pts[i + 1], pts[i + 2], 0, TAU);
      }
      ctx.fill();
      pts.length = 0;
    }
  }

  return {
    resize(canvasEl, width, height, dprCap = 1.5) {
      dpr = Math.min(dprCap, doc?.defaultView?.devicePixelRatio || 1);
      W = width;
      H = height;
      canvasEl.width = Math.max(1, Math.round(W * dpr));
      canvasEl.height = Math.max(1, Math.round(H * dpr));
      ctx = canvasEl.getContext("2d");
      epoch += 1;
      ripples = [];
      meteors = [];
      flare = 0;
    },
    draw(scene, dt, T) {
      if (!ctx) return;
      const dark = scene.theme !== "light";
      const C = dark ? COLORS.dark : COLORS.light;
      const moving = !scene.reduced;
      const { cx, cy, starR } = scene;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
      ctx.lineCap = "round";
      flare *= 0.2 ** dt; // 到达闪烁约 1 秒衰减完
      // 恒星背后两层反向慢转的光芒；聚焦时让位
      if (dark && scene.quality >= 2) {
        const rs = raysSprite();
        const size = 300 * (1 + 0.05 * Math.sin(T * 0.5));
        const dim = scene.focus ? 0.45 : 1;
        for (const [k, sc, al] of RAY_LAYERS) {
          const ang = T * 0.035 * k;
          ctx.setTransform(Math.cos(ang) * dpr, Math.sin(ang) * dpr, -Math.sin(ang) * dpr, Math.cos(ang) * dpr, cx * dpr, cy * dpr);
          ctx.globalAlpha = clamp01((al + 0.3 * flare) * dim);
          ctx.drawImage(rs, (-size * sc) / 2, (-size * sc) / 2, size * sc, size * sc);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      if (dark) glow(C.star, cx, cy, 44 + 12 * flare, 0.1 + 0.32 * flare);
      // 闪烁星（近景，视差 1.9×；降级到 1 以下就不画）
      if (scene.quality >= 2 && scene.twinkles?.length) {
        const px = (scene.parX || 0) * 1.9;
        const py = (scene.parY || 0) * 1.9;
        for (const tw of scene.twinkles) {
          const w = moving ? 0.5 + 0.5 * Math.sin((T / tw.period) * TAU + tw.phase) : 0.6;
          const k = w * w;
          if (dark) {
            sprite(twinkleSprite(tw.warm ? TWINKLE_WARM : TWINKLE_COOL), tw.x * W + px, tw.y * H + py, 3.6 * tw.size * (0.65 + 0.35 * k), 0.18 + 0.82 * k);
          } else {
            dot(tw.warm ? C.node : C.tunnel, tw.x * W + px, tw.y * H + py, 1.35 * tw.size * (0.75 + 0.25 * k), 0.22 + 0.52 * k);
          }
        }
      }
      if (moving && scene.quality >= 2) drawMeteors(dt, C, dark);
      for (const L of scene.lines) {
        const a = lineAlpha(scene, L);
        if (a <= 0) continue;
        const br = moving ? 0.58 + 0.42 * (0.5 + 0.5 * Math.sin(T * L.omega + L.ph)) : 0.85; // 呼吸
        if (L.kind === "tunnel" || L.kind === "ssh") drawTunnel(scene, L, a, br, dt, T, C, dark, moving);
        else if (L.kind === "node") drawNode(scene, L, a, br, T, C, dark, moving);
        else drawConfig(scene, L, a, br, T, C, dark, moving);
      }
      flushDots(C.config, C.head);
      // 彗星撞上恒星时朝来向激起的弧形涟漪
      for (let i = ripples.length - 1; i >= 0; i -= 1) {
        const rp = ripples[i];
        rp.t += dt / 0.95;
        if (rp.t >= 1) {
          ripples.splice(i, 1);
          continue;
        }
        const k = rp.t;
        const e = 1 - (1 - k) * (1 - k);
        ring(C.star, cx, cy, starR + 4 + e * 24, (1 - k) * (dark ? 0.55 : 0.45) * rp.a, (dark ? 1.6 : 1) * (1 - k) + 0.4, rp.ang - 0.6, rp.ang + 0.6);
      }
      // 聚焦行星：一圈圈声呐波纹
      if (scene.focus && moving) {
        const p = scene.planets.get(scene.focus);
        if (p) {
          for (let k = 0; k < 2; k += 1) {
            const ph = ((((T - scene.focusT0) / 1.8 + k * 0.5) % 1) + 1) % 1;
            ring(dark ? p.hue : C.tunnel, p.x, p.y, p.r * p.s + 4 + ph * 28, (1 - ph) * (dark ? 0.6 : 0.45), (dark ? 1.3 : 0.9) * (1 - ph) + 0.3);
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    },
    stats() {
      return { sprites: sprites.size, ripples: ripples.length, meteors: meteors.length };
    },
  };
}
