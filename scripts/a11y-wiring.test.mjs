// 键盘 / 读屏的跨模块接线断言：入口 HTML、命令面板、侧栏当前页、toast live region 与浏览器冒烟路径。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf8");
const indexHtml = read("work/monitor/public/index.html");
const palette = read("work/monitor/public/assets/js/command-palette.js");
const viewTabs = read("work/monitor/public/assets/js/app/view-tabs.js");
const teamController = read("work/monitor/public/assets/js/app/team-admin-controller.js");
const toast = read("work/monitor/public/assets/js/toast.js");
const smoke = read("scripts/browser-smoke-electron.mjs");

test("a11y 接线：排序控件有读屏说明（aria-describedby → 隐藏帮助文本）", () => {
  assert.match(indexHtml, /id="teamAdminSortSelect"[^>]*aria-describedby="teamAdminSortHelp"/);
  assert.match(indexHtml, /id="teamAdminSortHelp"[^>]*>按所选字段在每个轨道分组内重新排序/);
  assert.match(indexHtml, /class="tm-sr-only" id="teamAdminSortHelp"/);
  // 说明文案跟着当前排序走，不是写死的静态句子
  assert.match(teamController, /teamSortHint\(sort\)/);
  assert.match(teamController, /sortHelp\.textContent !== hint/);
});

test("a11y 接线：命令面板是 combobox + listbox，且关闭后归还焦点", () => {
  assert.match(palette, /setAttribute\("role", "combobox"\)/);
  assert.match(palette, /setAttribute\("aria-haspopup", "listbox"\)/);
  assert.match(palette, /setAttribute\("aria-activedescendant"/);
  assert.match(palette, /function restoreFocus\(\)/);
  assert.match(palette, /dialogEl\?\.addEventListener\("close", restoreFocus\)/);
});

test("a11y 接线：侧栏当前页同时维护 aria-selected 与 aria-current=page", () => {
  assert.match(viewTabs, /tab\.setAttribute\("aria-current", "page"\)/);
  assert.match(viewTabs, /tab\.removeAttribute\("aria-current"\)/);
});

test("a11y 接线：toast 容器是 status / polite live region（HTML 预置与 JS 兜底一致）", () => {
  assert.match(indexHtml, /id="toastContainer"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(toast, /setAttribute\("role", "status"\)/);
  assert.match(toast, /setAttribute\("aria-live", "polite"\)/);
});

test("a11y 接线：browser smoke 覆盖侧栏 aria-current、命令面板键盘路径与 toast 播报", () => {
  assert.match(smoke, /aria-current=page/);
  assert.match(smoke, /aria-activedescendant/);
  assert.match(smoke, /关闭命令面板后焦点回到打开前的元素/);
  assert.match(smoke, /#toastContainer \.toast-item/);
});
