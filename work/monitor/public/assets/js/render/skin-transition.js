// render/skin-transition.js —— 切换视觉版本时的全屏过场（#celestialOverlay）：破晓日出（→ 纸面天台版）、
// 暮色月升（→ 星空版）、简洁工作台（→ 简洁版）。只在「配置」里切换时播放（app.js 接线），页头不再有切换入口。
//
// 节奏是一层层出来的，不是一闪而过：幕布淡入 → 卡片浮起 → 日 / 月沿弧线升起、光晕扩开 → 标题、副题依次浮现
// → 停留片刻 → 整体淡出。幕布接近不透明时（onCovered）才真正换皮肤，整页换样式那一下藏在幕布后面。
// 点一下幕布可提前收起。系统开了「减少动态效果」时只做短暂淡入淡出。
//
// 遮罩用 popover（top layer）：「配置」是 showModal() 打开的对话框，普通 z-index 盖不过它。

const TIMING = Object.freeze({ cover: 420, hold: 3000, leave: 700 });
const REDUCED_TIMING = Object.freeze({ cover: 120, hold: 1100, leave: 200 });

const SCENES = {
  paper: {
    dir: "to-light",
    title: "破晓日出 · 纸面天台星图展开",
    sub: "DAWN OBSERVATORY · 暖米纸面手稿与赤道星轨已就绪",
    svg: `
      <svg viewBox="0 0 260 150" class="cso-svg" aria-hidden="true">
        <defs>
          <radialGradient id="csoSunGlow" cx="50%" cy="62%" r="50%">
            <stop offset="0%" stop-color="#fde68a" stop-opacity="0.95"/>
            <stop offset="45%" stop-color="#f59e0b" stop-opacity="0.45"/>
            <stop offset="100%" stop-color="#f59e0b" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <circle cx="130" cy="92" r="70" fill="url(#csoSunGlow)" class="cso-halo"/>
        <g class="cso-orb-group">
          <circle cx="130" cy="86" r="22" fill="#fffbeb" stroke="#d97706" stroke-width="2"/>
          <g class="cso-rays" stroke="#d97706" stroke-width="1.6" stroke-linecap="round" opacity="0.8">
            <line x1="130" y1="52" x2="130" y2="43"/><line x1="130" y1="120" x2="130" y2="129"/>
            <line x1="96" y1="86" x2="87" y2="86"/><line x1="164" y1="86" x2="173" y2="86"/>
            <line x1="106" y1="62" x2="100" y2="56"/><line x1="154" y1="62" x2="160" y2="56"/>
            <line x1="106" y1="110" x2="100" y2="116"/><line x1="154" y1="110" x2="160" y2="116"/>
          </g>
        </g>
        <path class="cso-horizon" d="M 8 149 Q 130 128 252 149" fill="none" stroke="#b45309" stroke-width="1.4" stroke-dasharray="4 4" opacity="0.65"/>
      </svg>`,
  },
  starry: {
    dir: "to-dark",
    title: "暮色入夜 · 深空观测台穹顶开启",
    sub: "DEEP SPACE DOME · 银河星尘暗带与引力虫洞星网已点亮",
    svg: `
      <svg viewBox="0 0 260 150" class="cso-svg" aria-hidden="true">
        <defs>
          <radialGradient id="csoMoonGlow" cx="50%" cy="60%" r="50%">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.7"/>
            <stop offset="50%" stop-color="#818cf8" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#0f172a" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <g class="cso-stars" fill="#dbe6ff">
          <circle cx="34" cy="30" r="1.1"/><circle cx="62" cy="54" r="0.8"/><circle cx="88" cy="22" r="1.3"/>
          <circle cx="176" cy="26" r="0.9"/><circle cx="204" cy="50" r="1.2"/><circle cx="232" cy="28" r="0.8"/>
          <circle cx="150" cy="16" r="0.7"/><circle cx="112" cy="40" r="0.6"/><circle cx="222" cy="78" r="0.7"/>
        </g>
        <circle cx="130" cy="84" r="70" fill="url(#csoMoonGlow)" class="cso-halo"/>
        <g class="cso-orb-group">
          <path d="M140 60 A26 26 0 1 0 156 100 A22 22 0 1 1 140 60 Z" fill="#f0f9ff" stroke="#38bdf8" stroke-width="1.5"/>
        </g>
        <path class="cso-horizon" d="M 8 149 Q 130 128 252 149" fill="none" stroke="#38bdf8" stroke-width="1.3" stroke-dasharray="4 4" opacity="0.6"/>
      </svg>`,
  },
  classic: {
    dir: "to-classic",
    title: "简洁工作台 · 经典界面已就绪",
    sub: "CLASSIC CONSOLE · 清爽卡片与高密度信息",
    svg: `
      <svg viewBox="0 0 260 150" class="cso-svg" aria-hidden="true">
        <defs>
          <radialGradient id="csoClassicGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#93b4f5" stop-opacity="0.45"/>
            <stop offset="100%" stop-color="#93b4f5" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <circle cx="130" cy="74" r="66" fill="url(#csoClassicGlow)" class="cso-halo"/>
        <g class="cso-orb-group">
          <rect x="88" y="40" width="84" height="62" rx="9" fill="rgba(255,255,255,0.06)" stroke="#93b4f5" stroke-width="1.4"/>
          <line x1="88" y1="54" x2="172" y2="54" stroke="#93b4f5" stroke-width="1" opacity="0.6"/>
          <circle cx="97" cy="47" r="1.8" fill="#93b4f5"/><circle cx="104" cy="47" r="1.8" fill="#93b4f5" opacity="0.6"/>
          <rect x="97" y="62" width="28" height="14" rx="3" fill="rgba(147,180,245,0.25)"/>
          <rect x="131" y="62" width="32" height="14" rx="3" fill="rgba(147,180,245,0.15)"/>
          <rect x="97" y="82" width="66" height="10" rx="3" fill="rgba(147,180,245,0.12)"/>
          <path d="M136 56 L126 74 L133 74 L128 90 L142 68 L134 68 Z" fill="#f5d27a" stroke="#c99a2e" stroke-width="0.8" class="cso-bolt"/>
        </g>
        <path class="cso-horizon" d="M 30 146 L 230 146" fill="none" stroke="#93b4f5" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.5"/>
      </svg>`,
  },
};

export function createSkinTransition({ doc = typeof document !== "undefined" ? document : null, win = typeof window !== "undefined" ? window : null } = {}) {
  let timers = [];
  let dismiss = null;

  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
  };
  const reducedMotion = () => Boolean(win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);

  function hide(overlay) {
    try { if (overlay.matches?.(":popover-open")) overlay.hidePopover?.(); } catch {}
    overlay.classList.remove("is-active", "is-leaving");
  }

  // 播放 targetSkin 的过场；onCovered 在幕布盖住页面时调一次（调用方在这里换皮肤）。
  // 没有遮罩节点或场景时直接 onCovered，不让换肤卡住。
  function play(targetSkin, { onCovered } = {}) {
    const overlay = doc?.getElementById("celestialOverlay");
    const svgHost = doc?.getElementById("celestialOverlaySvg");
    const captionEl = doc?.getElementById("celestialOverlayCaption");
    const scene = SCENES[targetSkin];
    let covered = false;
    const cover = () => {
      if (covered) return;
      covered = true;
      onCovered?.();
    };
    if (!overlay || !svgHost || !captionEl || !scene) {
      cover();
      return;
    }
    // 上一场还没放完又切了：上一场该换的皮肤立刻换掉，从头放这一场
    clearTimers();
    dismiss?.();
    hide(overlay);

    const timing = reducedMotion() ? REDUCED_TIMING : TIMING;
    overlay.dataset.dir = scene.dir;
    overlay.dataset.scene = targetSkin;
    svgHost.innerHTML = scene.svg;
    captionEl.innerHTML = `<strong class="cso-caption-title">${scene.title}</strong><span class="cso-caption-sub">${scene.sub}</span>`;
    try { overlay.showPopover?.(); } catch {}

    const leave = () => {
      clearTimers();
      cover();
      dismiss = null;
      overlay.classList.add("is-leaving");
      later(() => hide(overlay), timing.leave);
    };
    dismiss = () => {
      clearTimers();
      cover();
      dismiss = null;
    };
    overlay.onclick = () => leave();

    // 下一帧再点亮，过渡才有起点
    const raf = win?.requestAnimationFrame?.bind(win) || ((fn) => setTimeout(fn, 16));
    raf(() => raf(() => overlay.classList.add("is-active")));
    later(cover, timing.cover);
    later(leave, timing.cover + timing.hold);
  }

  return { play };
}
