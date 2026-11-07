// galaxy-stage.js —— 银河系列（星空版 starry / 纸面天台版 paper）的画布与动效：
// 1. 全局深空背景画布 (#galaxyGlobalSkyCanvas)：银河星尘暗带 + 多层体积星云 + O/B/A/G/M 多色温星辰（静态单帧）
// 2. 哈佛光谱日志星表 (#gxLogsCatalogBar in #dlgLogs)：O/B/A/G/M 恒星光谱分级筛选与 2.00 MB 星环容量回环守护表盘
// 3. 事件中心天象舞台 (#eventsGalaxyStage)：引力波脉冲环 + 3D 环绕事件星系与耀斑监控
// 用量 / 时间线 / 端点三处的星空版不在这里：v2.80 起由各自的渲染模块出真实数据的星图
// （render/usage-observatory.js、render/timeline-swim.js 的样式、render/pulsar-chart.js）。

import { escapeHtml } from "../store.js";
import { engagementOf, SMOOTH_FRAME_MS } from "./engagement.js";

// 伪随机数生成器（确定性分布）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// O/B/A/G/M 哈佛光谱真实天体色温表
const STAR_SPECTRAL_RGB = [
  [186, 230, 253], // O/B 蓝白高温星
  [224, 242, 254], // A 型纯白氢星
  [254, 249, 195], // F/G 暖白黄矮星
  [253, 230, 138], // K 型琥珀巨星
  [254, 215, 170], // M 型微橙红矮星
  [196, 181, 253], // 紫晶伴星
];

// ============================================================================
// 离屏精灵 + 有界缓存层
// 每帧重复的渐变、颜色字符串、measureText/fillText 与静态几何（旋臂 / 光桥 / 星核 / 流星尾焰）
// 一律预渲染成离屏 sprite 后复用；所有缓存都有条目上限与（或）字节上限，
// 换肤 / 尺寸变化 / 窗口隐藏时由 resetGalaxyRenderCaches 统一失效，避免长驻无界内存。
// ============================================================================
const TEXT_SPRITE_CACHE_LIMIT = 200;
const PILL_SPRITE_CACHE_LIMIT = 120;
const ART_SPRITE_CACHE_MAX_ENTRIES = 128;
const ART_SPRITE_CACHE_MAX_BYTES = 12 * 1024 * 1024;


// 带条目上限 / 字节上限的 LRU：get 会把命中的条目移到队尾，超限从队首淘汰。
function createBoundedCache(maxEntries, maxBytes = 0) {
  const map = new Map();
  let bytes = 0;
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      map.delete(key);
      map.set(key, entry);
      return entry.value;
    },
    set(key, value, sizeBytes = 0) {
      const prev = map.get(key);
      if (prev) {
        bytes -= prev.bytes;
        map.delete(key);
      }
      map.set(key, { value, bytes: sizeBytes });
      bytes += sizeBytes;
      while (map.size > maxEntries || (maxBytes > 0 && bytes > maxBytes && map.size > 1)) {
        const oldestKey = map.keys().next().value;
        const oldest = map.get(oldestKey);
        if (!oldest) break;
        bytes -= oldest.bytes;
        map.delete(oldestKey);
      }
    },
    clear() {
      map.clear();
      bytes = 0;
    },
    get size() {
      return map.size;
    },
  };
}

const textSpriteCache = createBoundedCache(TEXT_SPRITE_CACHE_LIMIT);
const pillSpriteCache = createBoundedCache(PILL_SPRITE_CACHE_LIMIT);
const artSpriteCache = createBoundedCache(ART_SPRITE_CACHE_MAX_ENTRIES, ART_SPRITE_CACHE_MAX_BYTES);
const measureCache = createBoundedCache(256);

// 离屏画布工厂：优先 OffscreenCanvas（不参与 DOM 布局），退化到 <canvas>；都不可用时返回 null
// （调用方据此逐帧直绘，保证无离屏能力的环境（如单元测试）依旧工作）。
function createOffscreenCanvas(width, height) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (ctx) return { canvas, ctx };
      return null;
    }
    if (typeof document !== "undefined" && document.createElement) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx) return { canvas, ctx };
    }
  } catch {
    // 无离屏画布能力：走逐帧直绘兜底
  }
  return null;
}











// 径向光晕 sprite：把 createRadialGradient + fill 一次性画进离屏画布，之后按半径缩放 drawImage。
function getRadialGlowSprite(key, sizeCss, stops, { innerRatio = 0, scale = 1.25 } = {}) {
  const cached = artSpriteCache.get(key);
  if (cached) return cached;
  const created = createOffscreenCanvas(sizeCss * scale, sizeCss * scale);
  if (!created) return null;
  const { canvas, ctx } = created;
  ctx.scale(scale, scale);
  const r = sizeCss / 2;
  const gradient = ctx.createRadialGradient(r, r, r * innerRatio, r, r, r);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, sizeCss, sizeCss);
  const sprite = { canvas, sizeCss };
  artSpriteCache.set(key, sprite, canvas.width * canvas.height * 4);
  return sprite;
}

function drawGlowSprite(ctx, sprite, cx, cy, radius) {
  if (!sprite) return false;
  ctx.drawImage(sprite.canvas, cx - radius, cy - radius, radius * 2, radius * 2);
  return true;
}

// 横向渐变条 sprite：用于光翼 / 流星尾焰 / 引力共鸣束等线性渐变笔画，绘制时拉伸即可。
function getLinearBandSprite(key, widthCss, heightCss, stops, { scale = 1.25 } = {}) {
  const cached = artSpriteCache.get(key);
  if (cached) return cached;
  const created = createOffscreenCanvas(widthCss * scale, heightCss * scale);
  if (!created) return null;
  const { canvas, ctx } = created;
  ctx.scale(scale, scale);
  const gradient = ctx.createLinearGradient(0, 0, widthCss, 0);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, widthCss, heightCss);
  const sprite = { canvas, widthCss, heightCss };
  artSpriteCache.set(key, sprite, canvas.width * canvas.height * 4);
  return sprite;
}

// 电影级星芒的三件套（corona halo / 水平拉丝光翼 / 黄金分割垂直芒针）按颜色 + 皮肤预渲染；
// 呼吸脉动只通过缩放与尺寸变化体现，不再每帧创建三个渐变对象。
function getStarHeadAssets(rgb, isPaper) {
  const [r, g, b] = rgb;
  const key = `starhead:${r},${g},${b}:${isPaper ? "p" : "s"}`;
  const cached = artSpriteCache.get(key);
  if (cached?.halo) return cached;
  const halo = getRadialGlowSprite(
    `${key}:halo`,
    96,
    [
      [0, `rgba(${r}, ${g}, ${b}, ${isPaper ? 0.38 : 0.65})`],
      [0.4, `rgba(${r}, ${g}, ${b}, ${isPaper ? 0.14 : 0.24})`],
      [1, `rgba(${r}, ${g}, ${b}, 0)`],
    ],
    { scale: 1.25 },
  );
  const flare = getLinearBandSprite(
    `${key}:flare`,
    128,
    2,
    [
      [0, `rgba(${r}, ${g}, ${b}, 0)`],
      [0.35, `rgba(${r}, ${g}, ${b}, ${isPaper ? 0.25 : 0.45})`],
      [0.5, isPaper ? "rgba(255, 250, 240, 0.95)" : "rgba(255, 255, 255, 0.95)"],
      [0.65, `rgba(${r}, ${g}, ${b}, ${isPaper ? 0.25 : 0.45})`],
      [1, `rgba(${r}, ${g}, ${b}, 0)`],
    ],
  );
  const vertical = getLinearBandSprite(
    `${key}:vertical`,
    128,
    2,
    [
      [0, `rgba(${r}, ${g}, ${b}, 0)`],
      [0.5, isPaper ? `rgba(${r}, ${g}, ${b}, 0.55)` : "rgba(255, 255, 255, 0.78)"],
      [1, `rgba(${r}, ${g}, ${b}, 0)`],
    ],
  );
  if (!halo || !flare || !vertical) return null;
  const assets = {
    halo,
    flare,
    vertical,
    coreFill: isPaper ? "#fffaf0" : "#ffffff",
    coreStroke: `rgba(${r}, ${g}, ${b}, 0.9)`,
  };
  artSpriteCache.set(key, assets, 0);
  return assets;
}








// 事件页雷达扫描扇区：锥形渐变以 0 角度预渲染，绘制时整体 rotate(sweepAngle)。
function getSweepSprite(variant) {
  const key = `sweep:${variant}`;
  const cached = artSpriteCache.get(key);
  if (cached) return cached;
  const size = 128;
  const created = createOffscreenCanvas(size * 1.25, size * 1.25);
  if (!created) return null;
  const { canvas, ctx } = created;
  ctx.scale(1.25, 1.25);
  const gradient = ctx.createConicGradient(0, size / 2, size / 2);
  if (variant === "paper") {
    gradient.addColorStop(0, "rgba(180, 83, 9, 0.18)");
    gradient.addColorStop(0.15, "rgba(180, 83, 9, 0)");
    gradient.addColorStop(1, "rgba(180, 83, 9, 0)");
  } else if (variant === "error") {
    gradient.addColorStop(0, "rgba(248, 113, 113, 0.26)");
    gradient.addColorStop(0.18, "rgba(248, 113, 113, 0)");
    gradient.addColorStop(1, "rgba(248, 113, 113, 0)");
  } else {
    gradient.addColorStop(0, "rgba(56, 189, 248, 0.2)");
    gradient.addColorStop(0.18, "rgba(56, 189, 248, 0)");
    gradient.addColorStop(1, "rgba(56, 189, 248, 0)");
  }
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fill();
  const sprite = { canvas, size };
  artSpriteCache.set(key, sprite, canvas.width * canvas.height * 4);
  return sprite;
}



const EVENTS_RING_COLORS = { starry: "rgba(56, 189, 248, 0.16)", paper: "rgba(130, 95, 45, 0.2)" };

// 生成带星团聚落 + 银河星尘带权重的深空星点
function createClusteredSky(count, seed = 108) {
  const rand = mulberry32(seed);
  const clusters = [
    { cx: 0.22, cy: 0.28, spread: 0.13 },
    { cx: 0.74, cy: 0.25, spread: 0.15 },
    { cx: 0.50, cy: 0.52, spread: 0.19 },
    { cx: 0.82, cy: 0.72, spread: 0.12 },
    { cx: 0.18, cy: 0.76, spread: 0.14 },
  ];
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    const inCluster = rand() < 0.62;
    let x;
    let y;
    if (inCluster) {
      const c = clusters[Math.floor(rand() * clusters.length)];
      const u1 = Math.max(1e-4, rand());
      const u2 = rand();
      const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
      const z1 = Math.sqrt(-2.0 * Math.log(u1)) * Math.sin(2.0 * Math.PI * u2);
      x = Math.min(0.98, Math.max(0.02, c.cx + z0 * c.spread));
      y = Math.min(0.96, Math.max(0.04, c.cy + z1 * c.spread));
    } else {
      x = rand();
      y = rand();
    }
    const tierRand = rand();
    const tier = tierRand > 0.92 ? 2 : tierRand > 0.64 ? 1 : 0;
    const rgb = STAR_SPECTRAL_RGB[Math.floor(rand() * STAR_SPECTRAL_RGB.length)];
    stars.push({
      x,
      y,
      r: tier === 2 ? 1.5 + rand() * 0.9 : tier === 1 ? 0.9 + rand() * 0.55 : 0.45 + rand() * 0.4,
      baseAlpha: tier === 2 ? 0.68 + rand() * 0.28 : tier === 1 ? 0.35 + rand() * 0.3 : 0.14 + rand() * 0.22,
      amp: tier === 2 ? 0.26 : tier === 1 ? 0.16 : 0.07,
      freq: 0.32 + rand() * 1.15,
      phase: rand() * Math.PI * 2,
      tier,
      rgb,
      // 颜色字符串与「纸面版色 / 星芒色」一次性固化，帧内只改 globalAlpha
      starryColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
      paperColor: tier === 2 ? "rgb(180, 83, 9)" : "rgb(120, 90, 50)",
    });
  }
  return stars;
}

// 离屏星空底图缓存（按尺寸 + 皮肤 + 星群种子缓存银河尘埃带、体积星云与 0/1 级基底星点，
// 避免每帧重复创建大面积渐变）；带条目与字节双上限，尺寸/皮肤变化时整体清空。
const skyBackdropCache = createBoundedCache(8, 20 * 1024 * 1024);

// 换肤 / resize / 隐藏时统一失效所有离屏精灵缓存，防止旧尺寸旧皮肤的 sprite 长驻。
function resetGalaxyRenderCaches() {
  skyBackdropCache.clear();
  textSpriteCache.clear();
  pillSpriteCache.clear();
  artSpriteCache.clear();
  measureCache.clear();
}

function buildStaticSkyBackdrop(width, height, stars, isPaper, showMilkyWay, nebulaIntensity) {
  const created = createOffscreenCanvas(width, height);
  if (!created) return null;
  const { canvas: offCanvas, ctx: offCtx } = created;

  if (!isPaper && showMilkyWay) {
    // 1. 斜贯天际的银河星尘亮带（Milky Way Luminous Band）
    offCtx.save();
    offCtx.translate(width * 0.5, height * 0.5);
    offCtx.rotate(-0.24);
    const diag = Math.hypot(width, height);
    const mwGrad = offCtx.createLinearGradient(0, -diag * 0.26, 0, diag * 0.26);
    mwGrad.addColorStop(0, "rgba(15, 23, 42, 0)");
    mwGrad.addColorStop(0.28, `rgba(56, 189, 248, ${0.032 * nebulaIntensity})`);
    mwGrad.addColorStop(0.46, `rgba(167, 139, 250, ${0.055 * nebulaIntensity})`);
    mwGrad.addColorStop(0.5, `rgba(2, 6, 23, ${0.22 * nebulaIntensity})`);
    mwGrad.addColorStop(0.55, `rgba(251, 146, 60, ${0.042 * nebulaIntensity})`);
    mwGrad.addColorStop(0.74, `rgba(56, 189, 248, ${0.028 * nebulaIntensity})`);
    mwGrad.addColorStop(1, "rgba(15, 23, 42, 0)");
    offCtx.fillStyle = mwGrad;
    offCtx.fillRect(-diag * 0.65, -diag * 0.26, diag * 1.3, diag * 0.52);
    offCtx.restore();

    // 2. 多层体积星云晕染（Volumetric Nebula Clouds）
    const nebulae = [
      { x: 0.22, y: 0.28, r: 0.34, rgb: [56, 189, 248], a: 0.065 * nebulaIntensity },
      { x: 0.76, y: 0.32, r: 0.36, rgb: [167, 139, 250], a: 0.06 * nebulaIntensity },
      { x: 0.48, y: 0.68, r: 0.32, rgb: [251, 146, 60], a: 0.045 * nebulaIntensity },
    ];
    for (const neb of nebulae) {
      const nx = neb.x * width;
      const ny = neb.y * height;
      const nr = Math.max(width, height) * neb.r;
      const ng = offCtx.createRadialGradient(nx, ny, 0, nx, ny, nr);
      ng.addColorStop(0, `rgba(${neb.rgb[0]}, ${neb.rgb[1]}, ${neb.rgb[2]}, ${neb.a})`);
      ng.addColorStop(0.5, `rgba(${neb.rgb[0]}, ${neb.rgb[1]}, ${neb.rgb[2]}, ${neb.a * 0.38})`);
      ng.addColorStop(1, "rgba(0, 0, 0, 0)");
      offCtx.fillStyle = ng;
      offCtx.beginPath();
      offCtx.arc(nx, ny, nr, 0, Math.PI * 2);
      offCtx.fill();
    }
  } else if (isPaper && showMilkyWay) {
    const paperNeb = offCtx.createRadialGradient(width * 0.3, height * 0.35, 0, width * 0.3, height * 0.35, width * 0.4);
    paperNeb.addColorStop(0, "rgba(180, 125, 50, 0.045)");
    paperNeb.addColorStop(1, "rgba(180, 125, 50, 0)");
    offCtx.fillStyle = paperNeb;
    offCtx.fillRect(0, 0, width, height);
  }

  // 3. 预绘 0/1 级基底星群（仅留 2 级亮星在动画帧中做呼吸闪烁）
  for (let i = 0; i < stars.length; i += 1) {
    const s = stars[i];
    if (s.tier === 2) continue;
    const sx = s.x * width;
    const sy = s.y * height;
    const alpha = s.baseAlpha;
    if (isPaper) {
      offCtx.fillStyle = `rgba(120, 90, 50, ${alpha * 0.38})`;
    } else {
      const [r, g, b] = s.rgb || [226, 232, 240];
      offCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    offCtx.beginPath();
    offCtx.arc(sx, sy, s.r, 0, Math.PI * 2);
    offCtx.fill();
  }

  return offCanvas;
}

// 绘制高定深空背景：优先拷贝离屏缓存底图 + 仅对 2 级亮星绘制实时呼吸十字芒
function drawBreathingSky(ctx, width, height, stars, timeSec, isPaper, options = {}) {
  const { showMilkyWay = true, nebulaIntensity = 1 } = options;
  const cacheKey = `${stars.length}:${width}x${height}:${isPaper ? "p" : "s"}:${showMilkyWay ? 1 : 0}:${nebulaIntensity}`;
  let cached = skyBackdropCache.get(cacheKey);
  if (!cached) {
    cached = buildStaticSkyBackdrop(width, height, stars, isPaper, showMilkyWay, nebulaIntensity);
    if (cached) skyBackdropCache.set(cacheKey, cached, cached.width * cached.height * 4);
  }

  if (cached) {
    ctx.drawImage(cached, 0, 0, width, height);
  }

  // 仅对 2 级主序亮星（约占总数 8%）绘制实时微呼吸与十字星芒，开销降低 92%；
  // 颜色固定在星点对象上，帧内只调整 globalAlpha，不再每帧拼 rgba() 字符串。
  const prevAlpha = ctx.globalAlpha;
  for (let i = 0; i < stars.length; i += 1) {
    const s = stars[i];
    if (cached && s.tier !== 2) continue;
    const sx = s.x * width;
    const sy = s.y * height;
    const wave = Math.sin(timeSec * s.freq + s.phase);
    const alpha = Math.max(0.08, Math.min(0.98, s.baseAlpha + wave * s.amp));
    if (isPaper) {
      ctx.fillStyle = s.paperColor;
      ctx.globalAlpha = s.tier === 2 ? alpha * 0.62 : alpha * 0.38;
    } else {
      ctx.fillStyle = s.starryColor;
      ctx.globalAlpha = alpha;
    }
    ctx.beginPath();
    ctx.arc(sx, sy, s.r, 0, Math.PI * 2);
    ctx.fill();

    if (s.tier === 2 && alpha > 0.62) {
      const spikeLen = s.r * (2.5 + wave * 0.6);
      ctx.strokeStyle = isPaper ? s.paperColor : s.starryColor;
      ctx.globalAlpha = isPaper ? alpha * 0.26 : alpha * 0.34;
      ctx.lineWidth = 0.65;
      ctx.beginPath();
      ctx.moveTo(sx - spikeLen, sy);
      ctx.lineTo(sx + spikeLen, sy);
      ctx.moveTo(sx, sy - spikeLen);
      ctx.lineTo(sx, sy + spikeLen);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = prevAlpha;
}

// 绘制电影级水平拉丝光学星芒 + 黄金分割四芒星针（Anamorphic Lens Flare & Starburst）：
// 光晕 / 水平光翼 / 垂直芒针均为预渲染 sprite，呼吸脉动只通过缩放体现；
// 无离屏画布能力时退回逐帧渐变直绘（保证单元测试等环境可用）。
function drawAnamorphicStarHead(ctx, x, y, radius, rgb, isPaper, pulse = 0.5, showHorizontalFlare = true) {
  const assets = getStarHeadAssets(rgb, isPaper);

  if (!assets) {
    drawAnamorphicStarHeadFallback(ctx, x, y, radius, rgb, isPaper, pulse, showHorizontalFlare);
    return;
  }

  ctx.save();
  const haloR = radius * (3.8 + pulse * 1.4);
  drawGlowSprite(ctx, assets.halo, x, y, haloR);

  // 电影级水平拉丝光翼 (Anamorphic Horizontal Streak)
  if (showHorizontalFlare) {
    const streakLen = radius * (7.5 + pulse * 3.0);
    const lineWidth = isPaper ? 1.4 : 1.7;
    ctx.drawImage(assets.flare.canvas, x - streakLen, y - lineWidth / 2, streakLen * 2, lineWidth);
  }

  // 垂直短芒针（黄金分割比例）
  const vLen = radius * (3.2 + pulse * 1.1);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(assets.vertical.canvas, -vLen, -0.55, vLen * 2, 1.1);
  ctx.restore();

  // 高亮星核
  ctx.fillStyle = assets.coreFill;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(2.2, radius * 0.72), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = assets.coreStroke;
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.restore();
}

// 无离屏画布时的逐帧直绘兜底（与预渲染版本视觉一致）
function drawAnamorphicStarHeadFallback(ctx, x, y, radius, rgb, isPaper, pulse, showHorizontalFlare) {
  const [r, g, b] = rgb;
  ctx.save();
  const haloR = radius * (3.8 + pulse * 1.4);
  const halo = ctx.createRadialGradient(x, y, 0, x, y, haloR);
  halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${isPaper ? 0.38 : 0.65})`);
  halo.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, ${isPaper ? 0.14 : 0.24})`);
  halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, haloR, 0, Math.PI * 2);
  ctx.fill();
  if (showHorizontalFlare) {
    const streakLen = radius * (7.5 + pulse * 3.0);
    const streakGrad = ctx.createLinearGradient(x - streakLen, y, x + streakLen, y);
    streakGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
    streakGrad.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, ${isPaper ? 0.25 : 0.45})`);
    streakGrad.addColorStop(0.5, isPaper ? "rgba(255, 250, 240, 0.95)" : "rgba(255, 255, 255, 0.95)");
    streakGrad.addColorStop(0.65, `rgba(${r}, ${g}, ${b}, ${isPaper ? 0.25 : 0.45})`);
    streakGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.strokeStyle = streakGrad;
    ctx.lineWidth = isPaper ? 1.4 : 1.7;
    ctx.beginPath();
    ctx.moveTo(x - streakLen, y);
    ctx.lineTo(x + streakLen, y);
    ctx.stroke();
  }
  const vLen = radius * (3.2 + pulse * 1.1);
  const vGrad = ctx.createLinearGradient(x, y - vLen, x, y + vLen);
  vGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
  vGrad.addColorStop(0.5, isPaper ? `rgba(${r}, ${g}, ${b}, 0.55)` : "rgba(255, 255, 255, 0.78)");
  vGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.strokeStyle = vGrad;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(x, y - vLen);
  ctx.lineTo(x, y + vLen);
  ctx.stroke();
  ctx.fillStyle = isPaper ? "#fffaf0" : "#ffffff";
  ctx.beginPath();
  ctx.arc(x, y, Math.max(2.2, radius * 0.72), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.9)`;
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.restore();
}

const EVENTS_SKY_STARS = createClusteredSky(48, 4096);
const GLOBAL_SKY_STARS = createClusteredSky(120, 8192);

export function createGalaxyStageController({ doc, win, onAcknowledgeIncident } = {}) {
  let currentSkin = "classic";
  let latestEventsOpen = null;
  let latestStatus = null;

  // 帧节奏：流畅或静止（render/engagement.js）——人在用（窗口在前台、最近有操作、没开减弱动效）时满帧（封顶约 60fps），
  // 否则画完这一帧就停（常驻开销为零），再有操作时由订阅通知重新起跑。不再用 30 / 20 / 13fps 的分档：低帧率的连续运动一顿一顿。
  // 每个循环在「上一帧画完后」用定时器预约下一帧 rAF，取消原「60Hz rAF 空转 + 节流」的双回调浪费。
  const loopState = {
    events: { raf: 0, timer: 0 },
  };
  const engagement = engagementOf(win, doc);

  // 画布父容器尺寸缓存（ResizeObserver 更新）
  const canvasSizeCache = new Map();

  function startLoop(name, drawFn, isActive) {
    const state = loopState[name];
    if (state.raf || state.timer) return;
    if (!isGalaxyActive() || !isActive()) return;
    state.raf = win?.requestAnimationFrame?.(drawFn) || 0;
  }

  // 只清句柄（从 rAF 回调内部退出时用，避免 cancel 自己）
  function haltLoop(name) {
    const state = loopState[name];
    if (state.timer && typeof clearTimeout === "function") clearTimeout(state.timer);
    state.raf = 0;
    state.timer = 0;
  }

  function stopLoop(name) {
    const state = loopState[name];
    if (state.raf && win?.cancelAnimationFrame) win.cancelAnimationFrame(state.raf);
    haltLoop(name);
  }

  function stopAllLoops() {
    for (const name of Object.keys(loopState)) stopLoop(name);
  }

  function scheduleNextFrame(name, drawFn) {
    const state = loopState[name];
    state.raf = 0;
    if (state.timer) return;
    // 没人在用：停在刚画好的这一帧
    if (!engagement.engaged()) return;
    // 预留约半个 vsync 的 rAF 对齐时间：60Hz 屏每个 VSync 一帧，120Hz 屏隔一个
    const delay = Math.max(0, SMOOTH_FRAME_MS - 8);
    state.timer = setTimeout(() => {
      state.timer = 0;
      if (!isGalaxyActive()) return;
      state.raf = win?.requestAnimationFrame?.(drawFn) || 0;
    }, delay);
  }

  // 视图/弹窗隐藏时把画布物理尺寸清零，释放后台像素显存；恢复时首帧会重新按 DPR 分配
  function releaseCanvas(id) {
    const canvas = doc?.getElementById?.(id);
    if (canvas && (canvas.width || canvas.height)) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  function releaseInactiveStageCanvases() {
    if (!isViewActive("view-events")) releaseCanvas("gxEventsCanvas");
  }

  // 画布父容器宽度：ResizeObserver 缓存（首帧读一次布局，之后只在尺寸变化时更新），
  // 不再每帧 getBoundingClientRect 触发布局读取；无 ResizeObserver 时退回逐帧读取。
  function resolveCanvasWidth(canvasId, fallbackWidth, minWidth, maxWidth) {
    const clampWidth = (value) => Math.min(maxWidth, Math.max(minWidth, Math.floor(value)));
    let entry = canvasSizeCache.get(canvasId);
    if (entry && entry.observer && entry.width > 0 && entry.parent?.isConnected !== false) {
      return clampWidth(entry.width);
    }
    const canvas = doc?.getElementById?.(canvasId);
    const parent = canvas?.parentElement;
    if (!parent || typeof parent.getBoundingClientRect !== "function") return clampWidth(fallbackWidth);
    if (!entry || entry.parent !== parent) {
      entry = { parent, width: 0, observer: null };
      canvasSizeCache.set(canvasId, entry);
      entry.width = Math.floor(parent.getBoundingClientRect()?.width || 0);
      if (typeof ResizeObserver === "function") {
        try {
          entry.observer = new ResizeObserver((records) => {
            const record = records[0];
            if (!record) return;
            const box = record.borderBoxSize?.[0] || record.borderBoxSize;
            const width = box ? box.inlineSize : record.contentRect?.width;
            if (Number.isFinite(width)) entry.width = Math.floor(width);
          });
          entry.observer.observe(parent);
        } catch {
          entry.observer = null;
        }
      }
    }
    if (!entry.observer) entry.width = Math.floor(parent.getBoundingClientRect()?.width || 0);
    return clampWidth(entry.width || fallbackWidth);
  }

  function clearCanvasSizeCache() {
    for (const entry of canvasSizeCache.values()) entry.observer?.disconnect?.();
    canvasSizeCache.clear();
  }

  // 事件星体命中区域与选中下钻状态
  let eventsHitTargets = [];
  let hoveredEventNode = null;
  let selectedEventId = null;

  // 避免首帧切换时抖动：预热一次舞台 DOM
  let stagesMounted = false;
  function ensureStagesMounted() {
    if (!doc) return;
    if (!stagesMounted) {
      const eventsStage = doc.getElementById("eventsGalaxyStage");
      if (eventsStage && !eventsStage.querySelector("#gxEventsCanvas")) {
        mountEventsDom(eventsStage);
      }
      stagesMounted = true;
    }
    // 日志哈佛光谱顶栏（用量 / 时间线 / 端点三处的星空版样式由各自的渲染模块与 CSS 负责）
    ensureLogsCatalogMounted();
  }

  function isGalaxyActive() {
    return currentSkin === "starry" || currentSkin === "paper";
  }

  function isViewActive(viewId) {
    if (!doc) return false;
    const el = doc.getElementById(viewId);
    if (!el || el.hidden) return false;
    if (typeof el.classList?.contains === "function" && el.classList.contains("active")) return true;
    return el.offsetParent !== null;
  }


  // ============================================================================
  // 5. 模块 4：日志 (#gxLogsCatalogBar in #dlgLogs)
  //    哈佛恒星光谱分类星表 (O/B/A/G/M) + 2.00 MB 星环容量回环守护仪
  // ============================================================================
  function ensureLogsCatalogMounted() {
    if (!doc) return;
    const dlgLogs = doc.getElementById("dlgLogs");
    if (!dlgLogs || dlgLogs.querySelector("#gxLogsCatalogBar")) return;

    const dialogBody = dlgLogs.querySelector(".dialog-body");
    if (!dialogBody) return;

    const bar = doc.createElement("div");
    bar.id = "gxLogsCatalogBar";
    bar.className = "gx-logs-catalog-bar";
    bar.setAttribute("aria-label", "哈佛光谱日志星表与 2MB 星环容量守护");
    bar.innerHTML = `
      <div class="gx-logs-spectral-group">
        <span class="gx-logs-eyebrow">HARVARD SPECTRAL CATALOG · 哈佛恒星光谱日志分级</span>
        <div class="gx-logs-spectral-pills" id="gxLogsSpectralPills">
          <button type="button" class="gx-spec-pill" data-spec-level="" title="查看全部光谱等级日志">
            <span class="gx-spec-code is-all">ALL</span><span>全星表</span>
          </button>
          <button type="button" class="gx-spec-pill" data-spec-level="error" title="筛选 O 型超新星告警 (ERROR)">
            <span class="gx-spec-code is-o">O2</span><span>超新星告警 · ERROR</span>
          </button>
          <button type="button" class="gx-spec-pill" data-spec-level="warn" title="筛选 B 型耀斑重试 (WARN)">
            <span class="gx-spec-code is-b">B1</span><span>耀斑重试 · WARN</span>
          </button>
          <button type="button" class="gx-spec-pill" data-spec-source="signal" title="筛选 A 型引力卡顿信号锚点 (SIGNAL)">
            <span class="gx-spec-code is-a">A0</span><span>引力信号 · SIGNAL</span>
          </button>
          <button type="button" class="gx-spec-pill" data-spec-level="info" title="筛选 G 型主序巡航脉冲 (INFO)">
            <span class="gx-spec-code is-g">G2</span><span>巡航脉冲 · INFO</span>
          </button>
        </div>
      </div>
      <div class="gx-logs-cap-meter" title="遵循 .agents/AGENTS.md 规范：单文件严格限制 2.00 MB 上限，超限自动截断并保留 .1 历史分卷">
        <svg class="gx-cap-ring-svg" width="34" height="34" viewBox="0 0 36 36" aria-hidden="true">
          <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(148,163,184,0.2)" stroke-width="3"/>
          <circle id="gxLogsCapArc" cx="18" cy="18" r="14" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linecap="round" stroke-dasharray="88" stroke-dashoffset="36" transform="rotate(-90 18 18)"/>
        </svg>
        <div class="gx-cap-text">
          <strong id="gxLogsCapValue">NDJSON 星环守护 · ≤ 2.00 MB</strong>
          <span>AUTO-ROTATE .1 · 防爆盘截断已激活</span>
        </div>
      </div>
    `;

    dialogBody.prepend(bar);

    bar.addEventListener("click", (e) => {
      const btn = e.target.closest(".gx-spec-pill");
      if (!btn) return;
      const lvl = btn.dataset.specLevel;
      const src = btn.dataset.specSource;
      const levelSelect = doc.getElementById("logLevelFilter");
      const sourceSelect = doc.getElementById("logSourceFilter");
      if (typeof src === "string") {
        if (sourceSelect) {
          sourceSelect.value = sourceSelect.value === src ? "" : src;
          sourceSelect.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (typeof lvl === "string" && levelSelect) {
        if (lvl === "" && sourceSelect) sourceSelect.value = "";
        levelSelect.value = lvl;
        levelSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  function updateLogsCapMeter(status) {
    if (!doc) return;
    const valEl = doc.getElementById("gxLogsCapValue");
    const arcEl = doc.getElementById("gxLogsCapArc");
    if (!valEl || !arcEl) return;
    const totalBytes = status?.storage?.logsBytes || status?.storage?.totalBytes || 0;
    if (totalBytes > 0) {
      const mb = Math.min(2.0, totalBytes / (1024 * 1024));
      const ratio = Math.min(0.96, Math.max(0.08, mb / 2.0));
      const offset = Math.round(88 * (1 - ratio));
      valEl.textContent = `${mb.toFixed(2)} MB / 2.00 MB 上限`;
      arcEl.setAttribute("stroke-dashoffset", String(offset));
    } else {
      valEl.textContent = `NDJSON 星环守护 · ≤ 2.00 MB`;
      arcEl.setAttribute("stroke-dashoffset", "34");
    }
  }

  // ============================================================================
  // 6. 事件中心舞台 (#eventsGalaxyStage)：引力波脉冲环 + 3D 环绕事件星系与耀斑监控
  // ============================================================================
  function mountEventsDom(stage) {
    stage.innerHTML = `
      <div class="gx-stage-shell gx-events-shell">
        <div class="gx-stage-header">
          <div class="gx-stage-title-group">
            <span class="gx-eyebrow">GRAVITATIONAL WAVE &amp; SOLAR FLARE MONITOR · 引力波与太阳耀斑监测台</span>
            <h2 class="gx-stage-title" id="gxEventsTitle">天体引力波罗盘 · 异常星体追踪</h2>
          </div>
          <div class="gx-stage-badges">
            <span class="gx-pill" id="gxEventsStatePill">引力场平稳</span>
            <span class="gx-pill gx-pill-accent" id="gxEventsCountPill">0 颗告警星体</span>
          </div>
        </div>

        <div class="gx-events-main-grid">
          <div class="gx-canvas-wrap gx-events-canvas-wrap" id="gxEventsCanvasWrap">
            <canvas id="gxEventsCanvas" class="gx-stage-canvas" aria-label="事件中心引力波罗盘与异常耀斑星体画布"></canvas>
            <div class="gx-canvas-tooltip" id="gxEventsTooltip" hidden></div>
            <div class="gx-canvas-hint">点击环绕耀斑星体可锁定查看故障坐标并一键确认消警</div>
          </div>

          <div class="gx-flare-sidebar">
            <div class="gx-flare-sidebar-head">
              <strong>实时耀斑星体序列 · FLARE QUEUE</strong>
              <span id="gxFlareSubTitle">按天体扰动等级排序</span>
            </div>
            <div class="gx-flare-list" id="gxFlareList"></div>
          </div>
        </div>

        <div class="gx-Inspect-drawer" id="gxEventsDrawer" hidden></div>
      </div>
    `;

    const canvas = stage.querySelector("#gxEventsCanvas");
    const tooltip = stage.querySelector("#gxEventsTooltip");
    if (canvas) {
      canvas.addEventListener("mousemove", (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        let hit = null;
        for (const t of eventsHitTargets) {
          const dist = Math.hypot(mx - t.x, my - t.y);
          if (dist <= t.r + 9) {
            hit = t;
            break;
          }
        }
        hoveredEventNode = hit;
        canvas.style.cursor = hit ? "pointer" : "default";
        if (hit && tooltip) {
          tooltip.hidden = false;
          tooltip.innerHTML = `
            <div class="gx-tip-head">
              <span class="gx-tip-dot" style="background:${hit.color}"></span>
              <strong>${escapeHtml(hit.title)}</strong>
              <span class="gx-tip-badge">${escapeHtml(hit.severityLabel)}</span>
            </div>
            <div class="gx-tip-rows">
              <div><span>所属坐标</span><b>${escapeHtml(hit.serverLabel)}</b></div>
              <div><span>累计耀斑爆发</span><b>${hit.occurrences} 次</b></div>
              <div><span>状态</span><b>${hit.acked ? "已确认知晓 · 阻尼稳定" : "活跃告警 · 点击锁定处置"}</b></div>
            </div>
          `;
          const tx = Math.min(rect.width - 230, Math.max(10, mx + 14));
          const ty = Math.min(rect.height - 105, Math.max(10, my - 24));
          tooltip.style.transform = `translate(${tx}px, ${ty}px)`;
        } else if (tooltip) {
          tooltip.hidden = true;
        }
      });

      canvas.addEventListener("mouseleave", () => {
        hoveredEventNode = null;
        if (tooltip) tooltip.hidden = true;
      });

      canvas.addEventListener("click", () => {
        if (hoveredEventNode) {
          selectedEventId = selectedEventId === hoveredEventNode.id ? null : hoveredEventNode.id;
          renderEventsDrawer();
          renderEventsFlareList(latestEventsOpen);
        }
      });
    }

    const listEl = stage.querySelector("#gxFlareList");
    listEl?.addEventListener("click", (e) => {
      const ackBtn = e.target.closest("[data-gx-ack]");
      if (ackBtn) {
        e.stopPropagation();
        const id = ackBtn.dataset.gxAck;
        if (id) onAcknowledgeIncident?.(id);
        return;
      }
      const item = e.target.closest("[data-gx-incident]");
      if (item) {
        const id = item.dataset.gxIncident;
        selectedEventId = selectedEventId === id ? null : id;
        renderEventsDrawer();
        renderEventsFlareList(latestEventsOpen);
      }
    });
  }

  function renderEventsDrawer() {
    if (!doc) return;
    const drawer = doc.getElementById("gxEventsDrawer");
    if (!drawer) return;
    const incidents = Array.isArray(latestEventsOpen?.incidents) ? latestEventsOpen.incidents : [];
    const inc = incidents.find((it) => (it.incidentId || it.id) === selectedEventId);
    if (!inc) {
      drawer.hidden = true;
      return;
    }
    const isErr = inc.severity === "error" || inc.severity === "critical";
    const acked = Boolean(inc.attention?.acknowledgedAt);
    const id = inc.incidentId || inc.id || "";
    const color = isErr ? "#f87171" : "#fbbf24";
    drawer.hidden = false;
    drawer.innerHTML = `
      <div class="gx-drawer-inner">
        <div class="gx-drawer-head">
          <span class="gx-drawer-dot" style="background:${color};box-shadow:0 0 12px ${color}"></span>
          <div class="gx-drawer-title">
            <strong>${escapeHtml(inc.title || inc.kind || "链路异常耀斑")}</strong>
            <span>服务器节点：${escapeHtml(inc.serverName || inc.serverId || "全局通道")} · 累计触发 ${inc.occurrences || 1} 次</span>
          </div>
          <div class="gx-drawer-actions">
            ${!acked && id ? `<button type="button" class="gx-drawer-btn" id="gxDrawerAckBtn" data-id="${escapeHtml(id)}">确认消警 (阻尼锁定)</button>` : `<span class="gx-pill">已确认知晓</span>`}
            <button type="button" class="gx-drawer-close" id="gxEventsDrawerCloseBtn" aria-label="关闭详情">✕</button>
          </div>
        </div>
        <div class="gx-drawer-metrics">
          <div><span>耀斑级别</span><strong class="${isErr ? "is-gold" : ""}">${isErr ? "日冕物质抛射 (ERROR)" : "磁暴预警 (WARN)"}</strong></div>
          <div><span>故障分类码</span><strong>${escapeHtml(inc.kind || inc.code || "TRANSPORT")}</strong></div>
          <div><span>处置建议</span><strong>${escapeHtml(inc.summary || inc.detail || "可在下方事件列表查看处置日志或执行自愈")}</strong></div>
        </div>
      </div>
    `;
    drawer.querySelector("#gxDrawerAckBtn")?.addEventListener("click", (e) => {
      const targetId = e.currentTarget.dataset.id;
      if (targetId) onAcknowledgeIncident?.(targetId);
    });
    drawer.querySelector("#gxEventsDrawerCloseBtn")?.addEventListener("click", () => {
      selectedEventId = null;
      drawer.hidden = true;
      renderEventsFlareList(latestEventsOpen);
    });
  }

  function renderEventsFlareList(openPayload) {
    if (!doc) return;
    const listEl = doc.getElementById("gxFlareList");
    const statePill = doc.getElementById("gxEventsStatePill");
    const countPill = doc.getElementById("gxEventsCountPill");
    if (!listEl) return;

    const incidents = Array.isArray(openPayload?.incidents) ? openPayload.incidents : [];
    const errCount = incidents.filter((i) => i.severity === "error" || i.severity === "critical").length;
    const warnCount = incidents.length - errCount;

    if (statePill) {
      statePill.textContent = incidents.length === 0
        ? "深空引力场平稳 · 零异常扰动"
        : errCount > 0
          ? `检测到 ${errCount} 处高能日冕耀斑`
          : `检测到 ${warnCount} 处边缘引力波动`;
      statePill.dataset.tone = errCount > 0 ? "error" : warnCount > 0 ? "warn" : "ok";
    }
    if (countPill) {
      countPill.textContent = `${incidents.length} 颗活跃告警星体`;
    }

    if (incidents.length === 0) {
      listEl.innerHTML = `
        <div class="gx-flare-empty">
          <div class="gx-flare-empty-orb"></div>
          <strong>全频段深空静默 · 零告警耀斑</strong>
          <p>所有 SSH 反向隧道、本机代理与远端守护星轨均运行在平稳引力场内。</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = incidents.slice(0, 6).map((inc) => {
      const id = inc.incidentId || inc.id || "";
      const isErr = inc.severity === "error" || inc.severity === "critical";
      const acked = Boolean(inc.attention?.acknowledgedAt);
      const selected = selectedEventId === id;
      const srv = inc.serverName || inc.serverId || "全局通道";
      const title = inc.title || inc.kind || "链路异常事件";
      const occ = inc.occurrences || 1;
      return `
        <div class="gx-flare-card ${isErr ? "is-error" : "is-warn"}${acked ? " is-acked" : ""}${selected ? " is-selected" : ""}" data-gx-incident="${escapeHtml(id)}">
          <div class="gx-flare-indicator"></div>
          <div class="gx-flare-body">
            <div class="gx-flare-top">
              <span class="gx-flare-srv">${escapeHtml(srv)}</span>
              <span class="gx-flare-occ">爆发 ×${occ}</span>
            </div>
            <strong class="gx-flare-title">${escapeHtml(title)}</strong>
          </div>
          ${!acked && id ? `<button type="button" class="gx-flare-ack-btn" data-gx-ack="${escapeHtml(id)}" title="确认知晓此告警">知晓</button>` : `<span class="gx-flare-acked-tag">已知晓</span>`}
        </div>
      `;
    }).join("");
  }

  function drawEventsStageFrame(timeMs) {
    if (!isGalaxyActive() || !isViewActive("view-events")) {
      haltLoop("events");
      releaseCanvas("gxEventsCanvas");
      return;
    }
    const canvas = doc?.getElementById("gxEventsCanvas");
    if (!canvas) {
      haltLoop("events");
      return;
    }
    const width = resolveCanvasWidth("gxEventsCanvas", 420, 220, 960);
    // 严格锁死为 108px 微缩横幅高度，绝不随容器动态撑高
    const height = 108;
    const dpr = Math.min(1.25, win?.devicePixelRatio || 1);
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    const ctx = canvas.getContext?.("2d");
    if (!ctx) {
      haltLoop("events");
      return;
    }
    ctx.save();
    ctx.scale(dpr, dpr);

    const isPaper = currentSkin === "paper";
    const paperKey = isPaper ? "paper" : "starry";
    const timeSec = timeMs / 1000;
    ctx.clearRect(0, 0, width, height);

    drawBreathingSky(ctx, width, height, EVENTS_SKY_STARS, timeSec, isPaper, { showMilkyWay: true, nebulaIntensity: 0.9 });

    const cx = width * 0.5;
    const cy = height * 0.5;
    const maxR = Math.min(width * 0.28, height * 0.42);
    const incidents = Array.isArray(latestEventsOpen?.incidents) ? latestEventsOpen.incidents : [];
    const hasErr = incidents.some((i) => i.severity === "error" || i.severity === "critical");

    // 紧凑横向微缩引力波同心罗盘
    const rings = [0.38, 0.72, 1.0];
    for (let i = 0; i < rings.length; i += 1) {
      const r = maxR * rings[i];
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 1.65, r * 0.78, 0, 0, Math.PI * 2);
      ctx.strokeStyle = EVENTS_RING_COLORS[paperKey];
      ctx.lineWidth = i === rings.length - 1 ? 1.1 : 0.75;
      if (i % 2 === 1) ctx.setLineDash([4, 6]);
      else ctx.setLineDash([]);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 雷达扫描扇区：锥形渐变预渲染 sprite，只旋转绘制（不再每帧 createConicGradient）
    const sweepAngle = (timeSec * (hasErr ? 0.75 : 0.36)) % (Math.PI * 2);
    const sweepSprite = getSweepSprite(isPaper ? "paper" : hasErr ? "error" : "ok");
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1.65, 0.78);
    if (sweepSprite) {
      ctx.rotate(sweepAngle);
      ctx.drawImage(sweepSprite.canvas, -maxR, -maxR, maxR * 2, maxR * 2);
    } else {
      const sweepGrad = ctx.createConicGradient(sweepAngle, 0, 0);
      if (isPaper) {
        sweepGrad.addColorStop(0, "rgba(180, 83, 9, 0.18)");
        sweepGrad.addColorStop(0.15, "rgba(180, 83, 9, 0)");
        sweepGrad.addColorStop(1, "rgba(180, 83, 9, 0)");
      } else if (hasErr) {
        sweepGrad.addColorStop(0, "rgba(248, 113, 113, 0.26)");
        sweepGrad.addColorStop(0.18, "rgba(248, 113, 113, 0)");
        sweepGrad.addColorStop(1, "rgba(248, 113, 113, 0)");
      } else {
        sweepGrad.addColorStop(0, "rgba(56, 189, 248, 0.2)");
        sweepGrad.addColorStop(0.18, "rgba(56, 189, 248, 0)");
        sweepGrad.addColorStop(1, "rgba(56, 189, 248, 0)");
      }
      ctx.fillStyle = sweepGrad;
      ctx.beginPath();
      ctx.arc(0, 0, maxR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 中心观测站主星
    drawAnamorphicStarHead(
      ctx,
      cx,
      cy,
      6.5,
      hasErr ? [248, 113, 113] : [56, 189, 248],
      isPaper,
      0.5 + 0.5 * Math.sin(timeSec * 1.8),
      true,
    );

    // 环绕告警星体
    const newTargets = [];
    const visibleIncidents = incidents.slice(0, 6);
    for (let i = 0; i < visibleIncidents.length; i += 1) {
      const inc = visibleIncidents[i];
      const id = inc.incidentId || inc.id || `inc-${i}`;
      const isErr = inc.severity === "error" || inc.severity === "critical";
      const acked = Boolean(inc.attention?.acknowledgedAt);
      const ringRatio = isErr ? 0.58 : 0.86;
      const baseAngle = (i / Math.max(1, visibleIncidents.length)) * Math.PI * 2 + 0.6;
      const angle = baseAngle + timeSec * (isErr ? 0.22 : 0.12);
      const sx = cx + Math.cos(angle) * maxR * ringRatio * 1.65;
      const sy = cy + Math.sin(angle) * maxR * ringRatio * 0.78;
      const rgb = isErr ? [248, 113, 113] : [251, 191, 36];
      const color = isErr ? "#f87171" : "#fbbf24";

      drawAnamorphicStarHead(ctx, sx, sy, isErr ? 5.5 : 4.5, rgb, isPaper, 0.45, isErr);

      newTargets.push({
        id,
        x: sx,
        y: sy,
        r: isErr ? 7.5 : 6,
        color,
        title: inc.title || inc.kind || "链路异常",
        serverLabel: inc.serverName || inc.serverId || "全局通道",
        severityLabel: isErr ? "日冕抛射 · ERROR" : "引力扰动 · WARN",
        occurrences: inc.occurrences || 1,
        acked,
      });
    }
    eventsHitTargets = newTargets;

    ctx.restore();
    scheduleNextFrame("events", drawEventsStageFrame);
  }

  function startEventsLoop() {
    startLoop("events", drawEventsStageFrame, () => isViewActive("view-events"));
  }

  // ============================================================================
  // 7. 全局背景星野画布 (#galaxyGlobalSkyCanvas) —— 静态单帧渲染（0% 持续 CPU/GPU 占用）
  // ============================================================================
  function ensureGlobalSkyCanvas() {
    if (!doc) return null;
    let canvas = doc.getElementById("galaxyGlobalSkyCanvas");
    if (!canvas) {
      canvas = doc.createElement("canvas");
      canvas.id = "galaxyGlobalSkyCanvas";
      canvas.className = "gx-global-sky-canvas";
      canvas.setAttribute("aria-hidden", "true");
      doc.body.prepend(canvas);
    }
    return canvas;
  }

  // 全局深空背景只在静态单帧时使用；窗口不可见 / 切回经典版时把物理尺寸清零释放显存。
  function releaseGlobalSkyCanvas() {
    const canvas = doc?.getElementById("galaxyGlobalSkyCanvas");
    if (canvas && (canvas.width || canvas.height)) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  function renderGlobalSkyStatic() {
    if (!isGalaxyActive() || doc?.hidden) {
      releaseGlobalSkyCanvas();
      return;
    }
    const canvas = ensureGlobalSkyCanvas();
    if (!canvas) return;
    const width = Math.max(320, win?.innerWidth || 1280);
    const height = Math.max(240, win?.innerHeight || 800);
    // 装饰性深空背景：DPR 上限 1.0（原先 1.25），肉眼几乎无差但后台像素减少约 36%
    const dpr = Math.min(1.0, win?.devicePixelRatio || 1);
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const isPaper = currentSkin === "paper";
    drawBreathingSky(ctx, width, height, GLOBAL_SKY_STARS, 1.0, isPaper, { showMilkyWay: true, nebulaIntensity: 0.85 });
    ctx.restore();
  }

  function syncStageVisibility() {
    if (!doc) return;
    const active = isGalaxyActive();
    const eventsStage = doc.getElementById("eventsGalaxyStage");
    const logsBar = doc.getElementById("gxLogsCatalogBar");

    if (eventsStage) eventsStage.hidden = !active;
    if (logsBar) logsBar.hidden = !active;

    if (active) {
      ensureStagesMounted();
      renderEventsFlareList(latestEventsOpen);
      updateLogsCapMeter(latestStatus);
      renderGlobalSkyStatic();
      startEventsLoop();
    } else {
      stopAllLoops();
      releaseGlobalSkyCanvas();
      releaseInactiveStageCanvases();
    }
  }

  function bindNavigationObservers() {
    if (!doc || typeof MutationObserver === "undefined") return;
    const views = ["view-overview", "view-events"]
      .map((id) => doc.getElementById(id))
      .filter(Boolean);
    const viewObserver = new MutationObserver(() => {
      if (!isGalaxyActive()) return;
      // 离开的视图立即释放画布物理像素，避免隐藏画布长驻显存
      releaseInactiveStageCanvases();
      startEventsLoop();
    });
    for (const v of views) {
      viewObserver.observe(v, { attributes: true, attributeFilter: ["hidden", "class"] });
    }

    // 监听日志弹窗 open 状态
    const dlgLogs = doc.getElementById("dlgLogs");
    if (dlgLogs) {
      new MutationObserver(() => {
        if (!isGalaxyActive()) return;
        ensureLogsCatalogMounted();
        updateLogsCapMeter(latestStatus);
      }).observe(dlgLogs, { attributes: true, attributeFilter: ["open"] });
    }

    let resizeTimer = 0;
    win?.addEventListener?.("resize", () => {
      if (!isGalaxyActive()) return;
      clearTimeout(resizeTimer);
      // 尺寸变化：所有按尺寸预渲染的 sprite / 底图与尺寸缓存立即失效
      resetGalaxyRenderCaches();
      clearCanvasSizeCache();
      releaseGlobalSkyCanvas();
      resizeTimer = setTimeout(() => {
        renderGlobalSkyStatic();
        releaseInactiveStageCanvases();
        startEventsLoop();
      }, 200);
    });

    // 又有人在用了：停在静止帧的舞台重新起跑（不在用时由 scheduleNextFrame 自己停下）
    engagement.subscribe((engaged) => {
      if (engaged && isGalaxyActive()) startEventsLoop();
    });

    doc.addEventListener("visibilitychange", () => {
      if (!doc.hidden && isGalaxyActive()) {
        renderGlobalSkyStatic();
        startEventsLoop();
        return;
      }
      // 窗口不可见：停掉所有循环并释放画布显存，避免后台持续绘制
      stopAllLoops();
      releaseGlobalSkyCanvas();
      releaseInactiveStageCanvases();
    });
  }

  return {
    init(initialSkin = "classic") {
      currentSkin = initialSkin;
      resetGalaxyRenderCaches();
      bindNavigationObservers();
      syncStageVisibility();
    },
    // 换肤过场（日月升落）不在这里：只在「配置」里切换时由 render/skin-transition.js 播放
    applySkin(nextSkin) {
      currentSkin = nextSkin;
      // 换肤：清空所有离屏 sprite / 底图缓存（按皮肤缓存的内容全部失效）
      resetGalaxyRenderCaches();
      syncStageVisibility();
    },
    updateStatus(statusPayload) {
      latestStatus = statusPayload;
      if (!isGalaxyActive()) return;
      ensureStagesMounted();
      updateLogsCapMeter(statusPayload);
    },
    updateEvents(openPayload) {
      latestEventsOpen = openPayload;
      if (isGalaxyActive()) {
        ensureStagesMounted();
        renderEventsFlareList(openPayload);
        renderEventsDrawer();
        startEventsLoop();
      }
    },
  };
}
