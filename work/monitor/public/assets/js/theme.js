// theme.js —— 外观偏好：浅色 / 跟随系统 / 深色（v2.18.2 起三档；v2.27 起强调色为低饱和蓝）。
// 旧版的紫晶灰、极简黑两套暗色主题已删，存量偏好值一律折算成深色。
// 纯逻辑（normalizeThemePref / resolveTheme）与 DOM 控制器分开，Node 可直接 import 测试。

export const THEME_PREFS = ["light", "system", "dark"];
export const THEME_STORAGE_KEY = "console-theme";
const DEFAULT_THEME_PREF = "system";

export const SKIN_MODES = ["classic", "starry", "paper"];
export const SKIN_STORAGE_KEY = "console-skin";
const DEFAULT_SKIN_MODE = "classic";

// 存量值：v2.14–v2.18.1 存的是 "cyan" | "slate" | "oled"（都是暗色），折算成 dark；
// 其它未知值回落默认（跟随系统），不抛。
export function normalizeThemePref(raw) {
  if (raw === "light" || raw === "system" || raw === "dark") return raw;
  if (raw === "cyan" || raw === "slate" || raw === "oled") return "dark";
  return DEFAULT_THEME_PREF;
}

// 视觉版本（皮肤）：classic（简洁版）/ starry（星空版）/ paper（纸面天台版）
export function normalizeSkinMode(raw) {
  if (raw === "classic" || raw === "starry" || raw === "paper") return raw;
  if (raw === "dark" || raw === "galaxy") return "starry";
  if (raw === "light") return "paper";
  return DEFAULT_SKIN_MODE;
}

// 偏好 + 系统深色与否 → 实际生效的外观（只有 light / dark 两种）。
export function resolveTheme(pref, systemDark) {
  const p = normalizeThemePref(pref);
  if (p === "system") return systemDark ? "dark" : "light";
  return p;
}

export function resolveEffectiveTheme(pref, skin, systemDark) {
  const s = normalizeSkinMode(skin);
  if (s === "starry") return "dark";
  if (s === "paper") return "light";
  return resolveTheme(pref, systemDark);
}

export const THEME_LABELS = { light: "浅色", system: "跟随系统", dark: "深色" };
export const SKIN_LABELS = { classic: "简洁版", starry: "星空版", paper: "纸面天台版" };

// DOM 控制器：body[data-theme="light"] 表示浅色，不带属性即默认深色（:root 令牌）；
// body[data-skin="classic"|"starry"|"paper"] 控制视觉版本。
// 依赖全部可注入（doc / storage / matchMedia），测试里不需要真实 DOM。
export function createThemeController({
  doc = typeof document !== "undefined" ? document : null,
  storage = typeof localStorage !== "undefined" ? localStorage : null,
  matchMedia = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? (q) => window.matchMedia(q)
    : null,
  onApplied = () => {},
} = {}) {
  let pref = DEFAULT_THEME_PREF;
  let skin = DEFAULT_SKIN_MODE;
  let mql = null;
  let listening = false;

  function systemDark() {
    if (!mql && matchMedia) {
      try { mql = matchMedia("(prefers-color-scheme: dark)"); } catch { mql = null; }
    }
    return Boolean(mql?.matches);
  }

  function apply(prevSkin = skin) {
    const theme = resolveEffectiveTheme(pref, skin, systemDark());
    if (doc?.body) {
      doc.body.setAttribute("data-skin", skin);
      if (theme === "light") doc.body.setAttribute("data-theme", "light");
      else doc.body.removeAttribute("data-theme");
    }
    onApplied({ pref, theme, skin, prevSkin });
    return theme;
  }

  // 只有 classic 下且选了"跟随系统"才需要盯着系统切换；星空版/纸面天台版或显式白/黑不随系统跳变。
  function syncListener() {
    if (!mql) return;
    const want = skin === "classic" && pref === "system";
    if (want && !listening) {
      if (typeof mql.addEventListener === "function") mql.addEventListener("change", apply);
      else if (typeof mql.addListener === "function") mql.addListener(apply);
      listening = true;
    } else if (!want && listening) {
      if (typeof mql.removeEventListener === "function") mql.removeEventListener("change", apply);
      else if (typeof mql.removeListener === "function") mql.removeListener(apply);
      listening = false;
    }
  }

  function set(nextPref) {
    const prevSkin = skin;
    pref = normalizeThemePref(nextPref);
    try { storage?.setItem(THEME_STORAGE_KEY, pref); } catch {}
    if (skin === "starry" && pref === "light") {
      skin = "paper";
      try { storage?.setItem(SKIN_STORAGE_KEY, skin); } catch {}
    } else if (skin === "paper" && pref === "dark") {
      skin = "starry";
      try { storage?.setItem(SKIN_STORAGE_KEY, skin); } catch {}
    }
    systemDark();
    syncListener();
    return apply(prevSkin);
  }

  function setSkin(nextSkin) {
    const prevSkin = skin;
    skin = normalizeSkinMode(nextSkin);
    try { storage?.setItem(SKIN_STORAGE_KEY, skin); } catch {}
    systemDark();
    syncListener();
    return apply(prevSkin);
  }

  function init() {
    let saved = null;
    let savedSkin = null;
    try { saved = storage?.getItem(THEME_STORAGE_KEY) ?? null; } catch { saved = null; }
    try { savedSkin = storage?.getItem(SKIN_STORAGE_KEY) ?? null; } catch { savedSkin = null; }
    pref = normalizeThemePref(saved);
    skin = normalizeSkinMode(savedSkin);
    systemDark();
    syncListener();
    return apply(skin);
  }

  return {
    init,
    set,
    setSkin,
    getPref: () => pref,
    getSkin: () => skin,
    current: () => resolveEffectiveTheme(pref, skin, systemDark()),
  };
}

