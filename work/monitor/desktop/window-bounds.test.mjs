import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWindowBoundsStore, DEFAULT_WINDOW_SIZE, resolveWindowBounds, WINDOW_STATE_FILE } from "./window-bounds.mjs";

const display = (x, y, width, height) => ({ workArea: { x, y, width, height } });
const LAPTOP = display(0, 25, 1728, 1050);
const EXTERNAL = display(1728, 0, 2560, 1415); // 接在右侧的外接屏

test("resolveWindowBounds: 没有记录 / 记录不合法 → 默认大小、不给位置", () => {
  const screen = { displays: [LAPTOP], primary: LAPTOP };
  assert.deepEqual(resolveWindowBounds(null, screen), { ...DEFAULT_WINDOW_SIZE });
  assert.deepEqual(resolveWindowBounds({}, screen), { ...DEFAULT_WINDOW_SIZE });
  assert.deepEqual(resolveWindowBounds({ x: 0, y: 0, width: "wide", height: 800 }, screen), { ...DEFAULT_WINDOW_SIZE });
  // 异常退出留下的极小矩形不当真
  assert.deepEqual(resolveWindowBounds({ x: 0, y: 0, width: 100, height: 40 }, screen), { ...DEFAULT_WINDOW_SIZE });
  // 只有大小没有位置：保留大小，位置交给系统
  assert.deepEqual(resolveWindowBounds({ width: 1000, height: 700 }, screen), { width: 1000, height: 700 });
});

test("resolveWindowBounds: 默认大小超过主显示器工作区时收进去", () => {
  const small = display(0, 25, 1152, 695);
  assert.deepEqual(resolveWindowBounds(null, { displays: [small], primary: small }), { width: 1152, height: 695 });
  // 没有显示器信息：原样给默认
  assert.deepEqual(resolveWindowBounds(null), { ...DEFAULT_WINDOW_SIZE });
});

test("resolveWindowBounds: 在可见范围内的记录原样恢复（含外接屏、小数取整）", () => {
  const screen = { displays: [LAPTOP, EXTERNAL], primary: LAPTOP };
  assert.deepEqual(resolveWindowBounds({ x: 200, y: 120, width: 1440, height: 900 }, screen), { x: 200, y: 120, width: 1440, height: 900 });
  assert.deepEqual(resolveWindowBounds({ x: 2000.4, y: 100.6, width: 1600, height: 1000 }, screen), { x: 2000, y: 101, width: 1600, height: 1000 });
});

test("resolveWindowBounds: 外接屏拔掉后，留在那块屏上的窗口回到主屏居中（保留大小）", () => {
  const saved = { x: 2200, y: 200, width: 1500, height: 900 };
  assert.deepEqual(resolveWindowBounds(saved, { displays: [LAPTOP], primary: LAPTOP }), { width: 1500, height: 900 });
  // 记录的大小比现在的主屏还大：收进工作区
  assert.deepEqual(resolveWindowBounds({ x: 2200, y: 200, width: 2400, height: 1300 }, { displays: [LAPTOP], primary: LAPTOP }), { width: 1728, height: 1050 });
});

test("resolveWindowBounds: 探出工作区的部分收回来（窗口整体可见）", () => {
  const screen = { displays: [LAPTOP], primary: LAPTOP };
  // 右下角探出去
  assert.deepEqual(resolveWindowBounds({ x: 900, y: 500, width: 1280, height: 860 }, screen), { x: 448, y: 215, width: 1280, height: 860 });
  // 顶到菜单栏上方
  assert.deepEqual(resolveWindowBounds({ x: 100, y: -200, width: 1280, height: 860 }, screen), { x: 100, y: 25, width: 1280, height: 860 });
});

test("createWindowBoundsStore: 往返读写；目录不存在会建；坏文件 / 写失败都不抛", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "window-bounds-"));
  try {
    const runtimeDir = path.join(root, "runtime"); // 尚不存在
    const store = createWindowBoundsStore({ runtimeDir });
    assert.equal(store.filePath, path.join(runtimeDir, WINDOW_STATE_FILE));
    assert.equal(store.load(), null);
    assert.equal(store.save({ x: 10.2, y: 20.7, width: 1280, height: 860, extra: "ignored" }), true);
    assert.equal(readFileSync(store.filePath, "utf8"), '{"x":10,"y":21,"width":1280,"height":860}\n');
    assert.deepEqual(store.load(), { x: 10, y: 21, width: 1280, height: 860 });
    // 残缺的矩形不写
    assert.equal(store.save({ x: 1, y: 2, width: 3 }), false);
    assert.equal(store.save(null), false);
    assert.deepEqual(store.load(), { x: 10, y: 21, width: 1280, height: 860 });
    writeFileSync(store.filePath, "{not json");
    assert.equal(store.load(), null);
    writeFileSync(store.filePath, "42");
    assert.equal(store.load(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const failing = createWindowBoundsStore({
    runtimeDir: "/nonexistent",
    fs: { mkdirSync() { throw new Error("EROFS"); }, readFileSync() { throw new Error("ENOENT"); }, writeFileSync() {} },
  });
  assert.equal(failing.load(), null);
  assert.equal(failing.save({ x: 0, y: 0, width: 800, height: 600 }), false);
});
