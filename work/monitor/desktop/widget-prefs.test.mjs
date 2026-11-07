import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createWidgetPrefsStore, normalizeWidgetPrefs, resolveIslandPosition, WIDGET_STATE_FILE } from "./widget-prefs.mjs";

function memoryFs(initial = null) {
  const files = new Map(initial == null ? [] : [[path.join("/rt", WIDGET_STATE_FILE), initial]]);
  return {
    files,
    mkdirSync() {},
    readFileSync(file) {
      if (!files.has(file)) throw new Error("ENOENT");
      return files.get(file);
    },
    writeFileSync(file, text) { files.set(file, text); },
  };
}

test("normalizeWidgetPrefs：缺省 GPU / 不钉住 / 无位置；坏值一律回默认", () => {
  assert.deepEqual(normalizeWidgetPrefs(null), { trayMetric: "gpu", islandPinned: false, islandPosition: null });
  assert.deepEqual(
    normalizeWidgetPrefs({ trayMetric: "mine", islandPinned: true, islandPosition: { x: 10.4, y: 20.6 } }),
    { trayMetric: "mine", islandPinned: true, islandPosition: { x: 10, y: 21 } },
  );
  assert.deepEqual(
    normalizeWidgetPrefs({ trayMetric: "ram", islandPinned: "yes", islandPosition: { x: "1", y: 2 } }),
    { trayMetric: "gpu", islandPinned: false, islandPosition: null },
  );
});

test("偏好存取：读不到 / 损坏用默认；update 合并后写盘，读走缓存", () => {
  const fs = memoryFs("{not json");
  const store = createWidgetPrefsStore({ runtimeDir: "/rt", fs });
  assert.equal(store.filePath, path.join("/rt", WIDGET_STATE_FILE), "按本机 path.join 拼（Windows 上是反斜杠）");
  assert.equal(store.load().trayMetric, "gpu");
  store.update({ trayMetric: "cpu" });
  store.update({ islandPinned: true, islandPosition: { x: 5, y: 6 } });
  assert.deepEqual(JSON.parse(fs.files.get(store.filePath)), { trayMetric: "cpu", islandPinned: true, islandPosition: { x: 5, y: 6 } });
  const loaded = store.load();
  loaded.trayMetric = "off";
  assert.equal(store.load().trayMetric, "cpu", "返回副本，调用方改不到缓存");

  const readOnly = createWidgetPrefsStore({ runtimeDir: "/rt", fs: { ...memoryFs(), writeFileSync() { throw new Error("EROFS"); } } });
  assert.equal(readOnly.update({ trayMetric: "mine" }).trayMetric, "mine", "写不进也照常生效（本次运行内）");
});

test("resolveIslandPosition：放回所在显示器并收进工作区；屏幕没了退回 null", () => {
  const displays = [{ workArea: { x: 0, y: 25, width: 1440, height: 875 } }, { workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }];
  const size = { width: 320, height: 300 };
  assert.deepEqual(resolveIslandPosition({ x: 100, y: 100 }, size, { displays }), { x: 100, y: 100 });
  assert.deepEqual(resolveIslandPosition({ x: 1200, y: 700 }, size, { displays }), { x: 1120, y: 600 }, "中心在左屏：右下角收回来");
  assert.deepEqual(resolveIslandPosition({ x: 3000, y: 50 }, size, { displays }), { x: 3000, y: 50 });
  assert.equal(resolveIslandPosition({ x: 5000, y: 50 }, size, { displays }), null, "外接屏拔了");
  assert.equal(resolveIslandPosition(null, size, { displays }), null);
});
