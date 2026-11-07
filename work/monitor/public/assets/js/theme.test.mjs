import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeThemePref,
  normalizeSkinMode,
  resolveTheme,
  createThemeController,
  THEME_PREFS,
  THEME_STORAGE_KEY,
  SKIN_MODES,
  SKIN_STORAGE_KEY,
} from "./theme.js";

test("normalizeThemePref: 三档原样，旧的 cyan/slate/oled 折算成 dark，未知回落 system", () => {
  for (const p of THEME_PREFS) assert.equal(normalizeThemePref(p), p);
  assert.equal(normalizeThemePref("cyan"), "dark");
  assert.equal(normalizeThemePref("slate"), "dark");
  assert.equal(normalizeThemePref("oled"), "dark");
  assert.equal(normalizeThemePref(null), "system");
  assert.equal(normalizeThemePref("neon"), "system");
});

test("normalizeSkinMode: classic/starry/paper 原样，别名折算，未知回落 classic", () => {
  for (const s of SKIN_MODES) assert.equal(normalizeSkinMode(s), s);
  assert.equal(normalizeSkinMode("galaxy"), "starry");
  assert.equal(normalizeSkinMode("dark"), "starry");
  assert.equal(normalizeSkinMode("light"), "paper");
  assert.equal(normalizeSkinMode(null), "classic");
  assert.equal(normalizeSkinMode("unknown"), "classic");
});

test("resolveTheme: system 跟随系统深浅，显式选择不受系统影响", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("oled", false), "dark");
});

function makeEnv({ saved = null, savedSkin = null, systemDark = true } = {}) {
  const attrs = new Map();
  const body = {
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
  };
  const entries = [];
  if (saved != null) entries.push([THEME_STORAGE_KEY, saved]);
  if (savedSkin != null) entries.push([SKIN_STORAGE_KEY, savedSkin]);
  const store = new Map(entries);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const listeners = new Set();
  const mql = {
    matches: systemDark,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    flip() { this.matches = !this.matches; for (const fn of listeners) fn(); },
  };
  const applied = [];
  const ctl = createThemeController({ doc: { body }, storage, matchMedia: () => mql, onApplied: (e) => applied.push(e) });
  return { ctl, body, store, mql, listeners, applied };
}

test("controller: 存量 cyan 偏好 → dark，body 不带 data-theme；改成 light 写属性并持久化", () => {
  const env = makeEnv({ saved: "cyan", systemDark: false });
  assert.equal(env.ctl.init(), "dark");
  assert.equal(env.body.getAttribute("data-theme"), null);
  assert.equal(env.body.getAttribute("data-skin"), "classic");
  assert.equal(env.ctl.getPref(), "dark");
  assert.equal(env.ctl.set("light"), "light");
  assert.equal(env.body.getAttribute("data-theme"), "light");
  assert.equal(env.store.get(THEME_STORAGE_KEY), "light");
});

test("controller: 切换 classic / starry / paper 三套视觉版本并联动 data-skin 与 data-theme", () => {
  const env = makeEnv({ saved: "system", systemDark: false });
  assert.equal(env.ctl.init(), "light");
  assert.equal(env.ctl.getSkin(), "classic");
  assert.equal(env.body.getAttribute("data-skin"), "classic");
  assert.equal(env.body.getAttribute("data-theme"), "light");

  assert.equal(env.ctl.setSkin("starry"), "dark");
  assert.equal(env.ctl.getSkin(), "starry");
  assert.equal(env.body.getAttribute("data-skin"), "starry");
  assert.equal(env.body.getAttribute("data-theme"), null);
  assert.equal(env.store.get(SKIN_STORAGE_KEY), "starry");

  assert.equal(env.ctl.setSkin("paper"), "light");
  assert.equal(env.ctl.getSkin(), "paper");
  assert.equal(env.body.getAttribute("data-skin"), "paper");
  assert.equal(env.body.getAttribute("data-theme"), "light");
  assert.equal(env.store.get(SKIN_STORAGE_KEY), "paper");

  assert.equal(env.ctl.setSkin("classic"), "light");
  assert.equal(env.ctl.getSkin(), "classic");
  assert.equal(env.body.getAttribute("data-skin"), "classic");
});

test("controller: system 跟随系统变化并只在 system 档监听", () => {
  const env = makeEnv({ saved: "system", systemDark: true });
  assert.equal(env.ctl.init(), "dark");
  assert.equal(env.listeners.size, 1);
  env.mql.flip();
  assert.equal(env.body.getAttribute("data-theme"), "light", "系统切到浅色后自动跟随");
  env.ctl.set("dark");
  assert.equal(env.listeners.size, 0, "显式选黑色后不再监听系统");
  env.mql.flip();
  assert.equal(env.body.getAttribute("data-theme"), null, "系统再变也不影响显式选择");
});

test("controller: 无 storage / 无 matchMedia / 无 DOM 时安全空转，默认 system 按浅色处理", () => {
  const ctl = createThemeController({ doc: null, storage: null, matchMedia: null });
  assert.equal(ctl.init(), "light");
  assert.equal(ctl.set("dark"), "dark");
  assert.equal(ctl.current(), "dark");
});

