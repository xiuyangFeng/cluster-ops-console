// widget-prefs.mjs —— 菜单栏数字与悬浮岛的小偏好：菜单栏显示哪项读数、悬浮岛是否钉在桌面、钉住时的位置。
//
// 存在数据目录的 runtime/widget-state.json（与 window-state.json 同处；丢了或坏了只是回到默认：
// 菜单栏显示 GPU、悬浮岛跟着托盘弹出）。本模块不 import "electron"：显示器信息由调用方传入。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { normalizeGlanceMetric } from "../public/assets/js/render/glance-model.js";

export const WIDGET_STATE_FILE = "widget-state.json";

const int = (value) => (Number.isFinite(value) ? Math.round(value) : null);

export function normalizeWidgetPrefs(raw) {
  const x = int(raw?.islandPosition?.x);
  const y = int(raw?.islandPosition?.y);
  return {
    trayMetric: normalizeGlanceMetric(raw?.trayMetric),
    islandPinned: raw?.islandPinned === true,
    islandPosition: x != null && y != null ? { x, y } : null,
  };
}

// 纯函数：钉住时的位置放回当前显示器布局。窗口中心不在任何显示器工作区里（拔了外接屏）→ null，
// 调用方退回托盘下方；在的话把超出工作区的部分收回来。
export function resolveIslandPosition(position, size, { displays = [] } = {}) {
  if (!position) return null;
  const areas = displays.map((display) => display?.workArea).filter(Boolean);
  const cx = position.x + size.width / 2;
  const cy = position.y + size.height / 2;
  const area = areas.find((a) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height);
  if (!area) return null;
  const clamp = (v, min, max) => Math.min(Math.max(v, min), Math.max(min, max));
  return {
    x: clamp(position.x, area.x, area.x + area.width - size.width),
    y: clamp(position.y, area.y, area.y + area.height - size.height),
  };
}

// 读写都不抛：偏好是锦上添花，读不到用默认，写不进（只读盘 / 权限）就算了。
export function createWidgetPrefsStore({ runtimeDir, fs = { mkdirSync, readFileSync, writeFileSync } } = {}) {
  const filePath = path.join(runtimeDir, WIDGET_STATE_FILE);
  let cache = null;

  function load() {
    if (cache) return { ...cache };
    try {
      cache = normalizeWidgetPrefs(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch {
      cache = normalizeWidgetPrefs(null);
    }
    return { ...cache };
  }

  function update(patch) {
    cache = normalizeWidgetPrefs({ ...load(), ...patch });
    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(cache)}\n`);
    } catch {}
    return { ...cache };
  }

  return { filePath, load, update };
}
