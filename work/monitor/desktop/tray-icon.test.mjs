import assert from "node:assert/strict";
import test from "node:test";

import { renderTrayIconBitmap, TRAY_ICON_PX, TRAY_STATUS_DOT } from "./tray-icon.mjs";

const px = (buf, x, y) => {
  const i = (y * TRAY_ICON_PX + x) * 4;
  return { b: buf[i], g: buf[i + 1], r: buf[i + 2], a: buf[i + 3] };
};

test("托盘图标：BGRA 位图，状态点是不透明的状态色，角落全透明（不再是 0×0 空图）", () => {
  const buf = renderTrayIconBitmap("#34d399");
  assert.equal(buf.length, TRAY_ICON_PX * TRAY_ICON_PX * 4);
  assert.deepEqual(px(buf, TRAY_STATUS_DOT.x, TRAY_STATUS_DOT.y), { r: 0x34, g: 0xd3, b: 0x99, a: 255 });
  assert.equal(px(buf, 0, TRAY_ICON_PX - 1).a, 0);
  let partial = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0 && buf[i] < 255) partial += 1;
  assert.ok(partial > 0, "边缘有抗锯齿");
});

test("托盘图标：字形单色随外观——深色白、浅色黑（预乘后近似）", () => {
  const dark = px(renderTrayIconBitmap("#34d399", { dark: true }), 8, 9);
  const light = px(renderTrayIconBitmap("#34d399", { dark: false }), 8, 9);
  assert.ok(dark.r > 200 && dark.g > 200 && dark.b > 200 && dark.a > 200);
  assert.ok(light.r === 0 && light.g === 0 && light.b === 0 && light.a > 180);
});

test("托盘图标：状态点外圈挖空，与字形之间留缝", () => {
  const buf = renderTrayIconBitmap("#f87171");
  // 状态点正左方 r+1 处位于挖空带内：要么透明，要么只有状态点边缘的抗锯齿（红色），不会是字形白色
  const p = px(buf, Math.round(TRAY_STATUS_DOT.x - TRAY_STATUS_DOT.r - 1), Math.round(TRAY_STATUS_DOT.y));
  assert.ok(!(p.r > 200 && p.g > 200 && p.b > 200));
});

test("托盘图标：颜色格式非法时直接报错，不静默生成空图标", () => {
  assert.throws(() => renderTrayIconBitmap("green"), /#rrggbb/);
});
