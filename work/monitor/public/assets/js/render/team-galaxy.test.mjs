import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { galaxyMotionAllowed } from "./team-galaxy.js";

const base = { active: true, inView: true, hasGeometry: true };

test("galaxyMotionAllowed：系统减弱动效时停掉持续循环（只留静态画面）", () => {
  assert.equal(galaxyMotionAllowed(base), true);
  for (const [key, value] of [
    ["reduced", true],
    ["userPaused", true],
    ["active", false],
    ["inView", false],
    ["hidden", true],
    ["consoleHidden", true],
    ["hasGeometry", false],
  ]) {
    assert.equal(galaxyMotionAllowed({ ...base, [key]: value }), false, `${key}=${value} 时不应运行星图循环`);
  }
});

test("team-galaxy：rAF 只在 shouldRun 通过后启动；减弱动效时状态标为 paused / reduce", () => {
  const src = readFileSync(new URL("./team-galaxy.js", import.meta.url), "utf8");
  assert.match(src, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(src, /function shouldRun\(\) \{\s*return galaxyMotionAllowed\(\{/);
  assert.match(src, /if \(run && \(engagement\.engaged\(\) \|\| settling\(\)\) && !sim\.running\)/);
  assert.match(src, /else if \(!run && sim\.running\) \{\s*sim\.running = false;\s*win\.cancelAnimationFrame\(sim\.raf\);/);
  assert.match(src, /root\.dataset\.motion !== flag/);
  assert.match(src, /root\.dataset\.reducedMotion = reduceFlag/);
  // 减弱动效时的静态帧来自 rebuild()（place + fx.draw），不是循环里的第一帧
  assert.match(src, /place\(true\);\s*fx\.draw\(syncScene\(0\), 0, sim\.real\);/);
});
