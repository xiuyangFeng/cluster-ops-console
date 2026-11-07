// 修复轮接线测试（源码级）：Electron 主进程/preload/悬浮岛不便在 node:test 里真跑，
// 这里锁住关键接线，防止回归到"悬浮岛退出绕过确认框"。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
// 主进程 = 入口 electron-main.mjs + work/monitor/desktop/*.mjs；退出编排在 desktop/quit.mjs，
// IPC 在 desktop/ipc.mjs。行为层面的覆盖见 work/monitor/desktop/quit.test.mjs / ipc.test.mjs。
const mainProcessSources = () => [
  "electron-main.mjs",
  ...readdirSync(path.join(root, "work/monitor/desktop"))
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .map((file) => `work/monitor/desktop/${file}`),
].map(read).join("\n");

test("悬浮岛「退出」走需确认通道：request-quit 不置 quitConfirmed，由 before-quit 弹原生确认框", () => {
  const island = read("work/monitor/public/island.js");
  assert.match(island, /electronAPI\.requestQuit\(\)/);
  assert.doesNotMatch(island, /electronAPI\.quitApp\(\)/, "悬浮岛不得再调用视为已确认的 quitApp");
  // 按属性逐个断言，不要求它们在标签里相邻或同序：原先写成 /id="quitAppBtn" title="…"/，
  // 给这个按钮补任何属性（例如 aria-label）都会误报——补可访问性属性时真的踩过一次。
  const islandHtml = read("work/monitor/public/island.html");
  const quitButton = islandHtml.match(/<button\b[^>]*id="quitAppBtn"[^>]*>/);
  assert.ok(quitButton, "悬浮岛必须有 #quitAppBtn");
  assert.match(quitButton[0], /title="退出并停止后台"/);
  assert.match(read("preload.js"), /requestQuit: \(\) => ipcRenderer\.send\("request-quit"\)/);

  const main = mainProcessSources();
  const fnBody = main.match(/^([ \t]*)function requestQuitWithConfirm\(\) \{([\s\S]*?)\n\1\}/m);
  assert.ok(fnBody, "requestQuitWithConfirm 必须存在");
  assert.doesNotMatch(fnBody[2], /quitConfirmed\s*=/);
  assert.match(fnBody[2], /app\.quit\(\)/);
  const handler = main.match(/ipcMain\.on\("request-quit",[\s\S]*?\n\s*\}\);/);
  assert.ok(handler, "request-quit IPC 必须注册");
  assert.match(handler[0], /if \(!trusted\(event\)\) return;/);
  assert.match(main, /const trusted = \(event\) => isTrustedAppIpc\(event,/);
  assert.match(handler[0], /requestQuitWithConfirm\(\)/);
});

test("Cmd+Q 确认框：macOS 先把应用抢到前台，避免对话框落在其他窗口后面", () => {
  const quit = read("work/monitor/desktop/quit.mjs");
  const confirm = quit.slice(quit.indexOf("function showQuitConfirmDialog()"));
  const darwinAt = confirm.indexOf('if (platform === "darwin")');
  const focusAt = confirm.indexOf("app.focus({ steal: true })");
  const dialogAt = confirm.indexOf("dialog.showMessageBox");
  assert.ok(darwinAt > 0 && darwinAt < focusAt && focusAt < dialogAt);
  // before-quit 的"prompt"分支确实走这个确认框。
  assert.match(quit, /if \(action === "prompt"\) showQuitConfirmDialog\(\);/);
});

