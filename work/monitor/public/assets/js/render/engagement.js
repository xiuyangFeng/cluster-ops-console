// render/engagement.js —— 持续动画的「流畅或静止」：人在用的时候满帧，不在用的时候停住。
//
// 「在用」= 页面可见、窗口在前台、最近 ENGAGED_MS 内有过指针 / 键盘 / 滚轮 / 触控操作，且没开「减少动态效果」。
// 在用时团队星图、事件页舞台按满帧跑（封顶约 60fps，120Hz 屏也不翻倍）；不在用时停在当前一帧，常驻开销为零。
// 取代原来 30 / 20 / 13fps 的分档：低帧率的连续运动看起来一顿一顿，不如静止。
// 每个窗口一份（engagementOf 按 window 缓存）；订阅者在「在用 ↔ 不在用」切换时收到通知。
export const ENGAGED_MS = 45_000;
// 满帧的最短帧间隔：120Hz 屏上隔一个 VSync 画一帧（≈60fps），给时间戳抖动留 2ms 余量
export const SMOOTH_FRAME_MS = 14;

const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"];
const cache = new WeakMap();

export function createEngagement({ win, doc, now = () => win?.performance?.now?.() ?? Date.now(), idleMs = ENGAGED_MS } = {}) {
  const setTimer = typeof win?.setTimeout === "function" ? win.setTimeout.bind(win) : setTimeout;
  const reduceMq = typeof win?.matchMedia === "function" ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const subscribers = new Set();
  let lastActivity = now();
  let idleTimer = 0;
  let state = compute();

  function focused() {
    return typeof doc?.hasFocus !== "function" || doc.hasFocus();
  }

  function compute() {
    return !doc?.hidden && focused() && !reduceMq?.matches && now() - lastActivity < idleMs;
  }

  function sync() {
    const next = compute();
    if (next === state) return;
    state = next;
    for (const fn of subscribers) {
      try {
        fn(state);
      } catch {}
    }
  }

  // 只有一个定时器：到点时离上次操作还不满 idleMs 就顺延，而不是每次 pointermove 都重排定时器
  function armIdle() {
    if (idleTimer) return;
    idleTimer = setTimer(() => {
      idleTimer = 0;
      const left = idleMs - (now() - lastActivity);
      if (left > 0) armIdle();
      else sync();
    }, Math.max(50, idleMs - (now() - lastActivity)));
    idleTimer?.unref?.();
  }

  function poke() {
    lastActivity = now();
    if (!state) sync();
    armIdle();
  }

  for (const type of ACTIVITY_EVENTS) win?.addEventListener?.(type, poke, { passive: true, capture: true });
  win?.addEventListener?.("focus", poke);
  win?.addEventListener?.("blur", sync);
  doc?.addEventListener?.("visibilitychange", sync);
  reduceMq?.addEventListener?.("change", sync);
  armIdle();

  return {
    engaged: () => state,
    // 外部也能算一次操作（比如程序化地切进了带动画的页面）
    poke,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

export function engagementOf(win, doc = win?.document) {
  if (!win) return { engaged: () => false, poke() {}, subscribe: () => () => {} };
  let entry = cache.get(win);
  if (!entry) {
    entry = createEngagement({ win, doc });
    cache.set(win, entry);
  }
  return entry;
}
