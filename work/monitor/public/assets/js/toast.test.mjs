import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// toast 是 DOM 组件，这里做源码级断言（本项目对纯展示组件的一贯做法）：
// 容器必须是礼貌 live region，逐条 toast 不再用 role="alert" 打断朗读。
const src = readFileSync(new URL("./toast.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("toast：容器是 role=status + aria-live=polite 的 live region", () => {
  assert.match(src, /setAttribute\("role", "status"\)/);
  assert.match(src, /setAttribute\("aria-live", "polite"\)/);
  assert.match(src, /setAttribute\("aria-relevant", "additions"\)/);
  assert.doesNotMatch(src, /setAttribute\("role", "alert"\)/, "逐条 toast 不用 role=alert");
});

test("toast：逐条消息原子播报；index.html 预置容器同样带播报属性", () => {
  assert.match(src, /toast\.setAttribute\("aria-atomic", "true"\)/);
  assert.match(html, /id="toastContainer"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="toastContainer"[^>]*aria-atomic="false"/);
});
