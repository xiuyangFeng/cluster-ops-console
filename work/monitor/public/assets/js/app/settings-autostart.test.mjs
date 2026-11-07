import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { autostartToastText, createSettingsAutostart, describeAutostart, mergeLoginItem } from "./settings-autostart.js";
import { deferred, fakeDocument, fakeElement, flush, spy } from "./test-support.mjs";

const base = (fields = {}) => ({
  supported: true,
  method: "launch-agent",
  enabled: false,
  state: "off",
  file: "~/Library/LaunchAgents/com.clusterworkbench.launcher.plist",
  target: null,
  fromAutostart: false,
  caveats: [],
  reason: null,
  manualCommand: null,
  detail: null,
  ...fields,
});

test("describeAutostart：一句说明讲清用的是哪种方式、关掉窗口后隧道是否还在", () => {
  const web = describeAutostart(base());
  assert.deepEqual([web.available, web.checked, web.note, web.warn, web.command], [true, false, "", "", ""]);
  assert.match(web.text, /macOS 的登录启动项（LaunchAgent）/);
  assert.match(web.text, /没有终端窗口，隧道不会因为关窗口断开/);
  assert.match(web.text, /浏览器不会自动打开，要看页面时点桌面图标/);

  const desktop = describeAutostart(base(), { desktop: true });
  assert.match(desktop.text, /登录后自动打开桌面窗口；关掉窗口只是收进菜单栏，隧道还在/);

  const windows = describeAutostart(base({ method: "startup-folder", file: "C:\\…\\Startup\\cluster-workbench-autostart.cmd" }));
  assert.match(windows.text, /Windows「启动」文件夹里的一个脚本/);
  assert.match(windows.text, /最小化的命令行窗口里运行，浏览器不会自动打开，要看页面时点桌面图标/);
  assert.match(windows.text, /关掉后工作台就停了，隧道没有人守护/);

  // 文案平实：不用感叹号。
  for (const view of [web, desktop, windows]) assert.doesNotMatch(view.text, /[!！]/);
  assert.deepEqual(describeAutostart(null), { available: false, checked: false, text: "打开后读取启动设置…", note: "", warn: "", command: "" });
});

test("describeAutostart：已开启时说明什么时候生效；这一份就是自启拉起来的则直说", () => {
  const manual = describeAutostart(base({ enabled: true, state: "on" }));
  assert.deepEqual([manual.available, manual.checked], [true, true]);
  assert.equal(manual.note, "下次登录起生效。现在这一份是手动启动的，仍跟着启动它的那个窗口。");
  const auto = describeAutostart(base({ enabled: true, state: "on", fromAutostart: true }));
  assert.equal(auto.note, "这一份就是登录时自动启动的。");
  assert.equal(describeAutostart(base({ fromAutostart: true })).note, "", "关着的时候不多说");
});

test("describeAutostart：指向别的安装目录可以改到这里；不是工作台放的 / 读不出时开关不可用并说明", () => {
  const other = describeAutostart(base({ state: "other-install", target: "/Users/t/old/start.sh" }));
  assert.deepEqual([other.available, other.checked], [true, false]);
  assert.equal(other.warn, "之前在另一个安装目录开过（/Users/t/old/start.sh）。在这里打开，会改成启动这一份。");

  const foreign = describeAutostart(base({ state: "foreign" }));
  assert.deepEqual([foreign.available, foreign.checked], [false, false]);
  assert.equal(foreign.warn, "~/Library/LaunchAgents/com.clusterworkbench.launcher.plist 已经存在，但不是工作台放的，没有改动它。要用这个开关，请先自己把它移走。");

  const unknown = describeAutostart(base({ state: "unknown", detail: "EISDIR" }));
  assert.equal(unknown.available, false);
  assert.equal(unknown.warn, "读不出 ~/Library/LaunchAgents/com.clusterworkbench.launcher.plist（EISDIR），没有改动它。");
});

test("describeAutostart：安装目录在受保护的文件夹里时多一句提醒，与别的提醒并存", () => {
  const view = describeAutostart(base({ caveats: ["protected-folder"] }));
  assert.equal(view.available, true);
  assert.match(view.warn, /^安装目录在「文稿 \/ 桌面 \/ 下载」或外接磁盘上：登录时 macOS 可能会问是否允许 bash 访问，需要点「允许」，否则启动不了。$/);
  const both = describeAutostart(base({ state: "other-install", target: "/old/start.sh", caveats: ["protected-folder"] }));
  assert.equal(both.warn, "之前在另一个安装目录开过（/old/start.sh）。在这里打开，会改成启动这一份。安装目录在「文稿 / 桌面 / 下载」或外接磁盘上：登录时 macOS 可能会问是否允许 bash 访问，需要点「允许」，否则启动不了。");
});

test("describeAutostart：桌面壳里拿不到启动时的 PATH 时——没开的不让开并说明怎么办，已经开着的仍可以关", () => {
  const off = describeAutostart(base({ caveats: ["launcher-path-unknown"] }), { desktop: true });
  assert.deepEqual([off.available, off.checked], [false, false]);
  assert.equal(off.warn, "这一份工作台拿不到启动时的 PATH（多半是更新之后还没有完整重启）。请完全退出工作台，从桌面图标再启动一次，然后回来打开这个开关。");
  const on = describeAutostart(base({ enabled: true, state: "on", caveats: ["launcher-path-unknown"] }), { desktop: true });
  assert.deepEqual([on.available, on.checked], [true, true]);
  assert.match(on.warn, /拿不到启动时的 PATH/);
  const elsewhere = describeAutostart(base({ state: "other-install", target: "/old/start.sh", caveats: ["launcher-path-unknown"] }), { desktop: true });
  assert.equal(elsewhere.available, false, "指向别处的也要先完整重启才能改过来");
});

test("describeAutostart：不支持的情况——Linux 给手动命令；路径写不进去、找不到启动文件夹各有说法", () => {
  const linux = describeAutostart(base({ supported: false, method: "none", reason: "platform", file: null, manualCommand: "nohup bash '/home/u/wb/start.sh' --autostart >/dev/null 2>&1 &" }));
  assert.deepEqual([linux.available, linux.checked], [false, false]);
  assert.match(linux.text, /这个系统上没有做自动设置（目前只支持 macOS 与 Windows）/);
  assert.match(linux.text, /在终端执行下面这条命令；要开机自启，把它加进桌面环境的自启动项/);
  assert.equal(linux.command, "nohup bash '/home/u/wb/start.sh' --autostart >/dev/null 2>&1 &");

  const unsafe = describeAutostart(base({ supported: false, reason: "unsafe-path", file: null }));
  assert.equal(unsafe.available, false);
  assert.match(unsafe.text, /安装目录的路径没法写进系统的启动项（里面有换行、引号这类字符，或者是网络路径）/);
  assert.equal(unsafe.command, "");

  const noFolder = describeAutostart(base({ supported: false, method: "startup-folder", reason: "no-startup-folder", file: null }));
  assert.match(noFolder.text, /没有找到当前用户的「启动」文件夹/);
});

test("mergeLoginItem / describeAutostart：打包的 App——桌面窗口里可用；浏览器里说明去哪设；系统待批准或读不出时如实说", () => {
  const server = base({ method: "login-item", enabled: null, file: null });
  const on = mergeLoginItem(server, { supported: true, enabled: true, status: "enabled", error: null });
  assert.deepEqual([on.supported, on.enabled, on.state, on.loginItem], [true, true, "on", { status: "enabled", error: null }]);
  const view = describeAutostart(on, { desktop: true });
  assert.deepEqual([view.available, view.checked, view.warn], [true, true, ""]);
  assert.match(view.text, /macOS 的登录项。登录后自动打开工作台；关掉窗口只是收进菜单栏，隧道还在/);

  const pending = describeAutostart(mergeLoginItem(server, { supported: true, enabled: false, status: "requires-approval", error: null }), { desktop: true });
  assert.deepEqual([pending.available, pending.checked], [true, false]);
  assert.equal(pending.warn, "系统还没有允许：请到「系统设置 → 通用 → 登录项」里把它打开。");

  const failing = describeAutostart(mergeLoginItem(server, { supported: true, enabled: false, status: null, error: "boom" }), { desktop: true });
  assert.equal(failing.warn, "读不出系统的登录项（boom）。");

  const browser = describeAutostart({ ...server, desktopOnly: true });
  assert.deepEqual([browser.available, browser.checked], [false, false]);
  assert.equal(browser.warn, "这是打包的 App：请在它的桌面窗口里打开「配置 → 启动」来设置。");

  // 桌面壳说不支持（或回了看不懂的东西）：不当成开着，也不让点。
  for (const item of [{ supported: false, enabled: true }, null, undefined]) {
    const merged = mergeLoginItem(server, item);
    assert.deepEqual([merged.supported, merged.enabled, merged.state], [false, false, "off"]);
    assert.equal(describeAutostart(merged, { desktop: true }).available, false);
  }
});

test("autostartToastText：开 / 关之后各一句；macOS 源码安装多提醒一句系统的后台项目提示", () => {
  assert.equal(autostartToastText(base({ enabled: true }), true), "已开启，下次登录电脑时自动启动。系统可能提示添加了一个后台项目（显示为 bash），属正常。");
  assert.equal(autostartToastText(base({ enabled: true, fromAutostart: true }), true), "已开启。系统可能提示添加了一个后台项目（显示为 bash），属正常。");
  assert.equal(autostartToastText(base({ method: "startup-folder", enabled: true }), true), "已开启，下次登录电脑时自动启动。");
  assert.equal(autostartToastText(base({ method: "login-item", enabled: true }), true), "已开启，下次登录电脑时自动启动。");
  assert.equal(autostartToastText(base(), false), "已关闭，下次登录不再自动启动；现在这一份继续运行。");
});

// 假 DOM：骨架里的四段文字与开关。
function setup({ getJson, postJson, electronAPI = null } = {}) {
  const els = {
    autostartText: fakeElement({ textContent: "打开后读取启动设置…" }),
    autostartNote: fakeElement({ hidden: true }),
    autostartWarn: fakeElement({ hidden: true }),
    autostartCommand: fakeElement({ tag: "code", hidden: true }),
    autostartSwitch: fakeElement({ tag: "input", checked: false, disabled: true }),
  };
  const deps = {
    doc: fakeDocument(els),
    getJson: getJson || spy(async () => base()),
    postJson: postJson || spy(async (_path, body) => base({ enabled: body.enabled, state: body.enabled ? "on" : "off", changed: true, launchd: body.enabled ? null : "not-loaded" })),
    showToast: spy(),
    electronAPI,
  };
  const section = createSettingsAutostart(deps);
  const click = (checked) => {
    els.autostartSwitch.checked = checked;
    return els.autostartSwitch.dispatch("change");
  };
  return { deps, section, els, click };
}

test("打开配置：读 /api/autostart，填说明、放开开关；没有的段落保持隐藏", async () => {
  const ctx = setup();
  await ctx.section.onOpen();
  assert.deepEqual(ctx.deps.getJson.calls, [["/api/autostart"]]);
  assert.match(ctx.els.autostartText.textContent, /LaunchAgent/);
  assert.deepEqual([ctx.els.autostartText.hidden, ctx.els.autostartNote.hidden, ctx.els.autostartWarn.hidden, ctx.els.autostartCommand.hidden], [false, true, true, true]);
  assert.deepEqual([ctx.els.autostartSwitch.checked, ctx.els.autostartSwitch.disabled], [false, false]);
});

test("打开开关：在飞时禁用；成功后按回显勾上、给出什么时候生效，并提示一次", async () => {
  const pending = deferred();
  let posts = 0;
  // 第一次写入由用例决定何时回来；之后的照请求回显。
  const ctx = setup({ postJson: spy((_path, body) => (++posts === 1 ? pending.promise : Promise.resolve(base({ enabled: body.enabled, state: body.enabled ? "on" : "off" })))) });
  await ctx.section.onOpen();
  const done = ctx.click(true);
  await flush();
  assert.equal(ctx.els.autostartSwitch.disabled, true, "请求在飞时禁用开关");
  assert.deepEqual(ctx.deps.postJson.calls, [["/api/autostart", { enabled: true }]]);
  pending.resolve(base({ enabled: true, state: "on", changed: true, launchd: null }));
  await done;
  assert.deepEqual([ctx.els.autostartSwitch.checked, ctx.els.autostartSwitch.disabled], [true, false]);
  assert.equal(ctx.els.autostartNote.textContent, "下次登录起生效。现在这一份是手动启动的，仍跟着启动它的那个窗口。");
  assert.equal(ctx.els.autostartNote.hidden, false);
  assert.equal(ctx.deps.showToast.calls.length, 1);
  assert.equal(ctx.deps.showToast.calls[0][0].type, "success");
  assert.match(ctx.deps.showToast.calls[0][0].message, /^已开启，下次登录电脑时自动启动。/);

  await ctx.click(false);
  assert.deepEqual(ctx.deps.postJson.calls[1], ["/api/autostart", { enabled: false }]);
  assert.equal(ctx.els.autostartSwitch.checked, false);
  assert.equal(ctx.els.autostartNote.hidden, true);
  assert.equal(ctx.deps.showToast.calls[1][0].message, "已关闭，下次登录不再自动启动；现在这一份继续运行。");
});

test("后端拒绝（同名文件不是工作台放的）：勾选回到原状、说明原因，并重读一次让提醒跟上", async () => {
  let foreign = false;
  const ctx = setup({
    getJson: spy(async () => (foreign ? base({ state: "foreign" }) : base())),
    postJson: spy(async () => {
      foreign = true;
      throw Object.assign(new Error("HTTP 409"), { serverMessage: "~/Library/LaunchAgents/x.plist 已经存在，但不是工作台放的，没有改动它。" });
    }),
  });
  await ctx.section.onOpen();
  await ctx.click(true);
  assert.equal(ctx.els.autostartSwitch.checked, false, "失败后勾选回到实际状态");
  assert.equal(ctx.deps.showToast.calls[0][0].type, "error");
  assert.match(ctx.deps.showToast.calls[0][0].message, /^没有改成：.*不是工作台放的/);
  assert.equal(ctx.deps.getJson.calls.length, 2, "重读了一次");
  assert.equal(ctx.els.autostartSwitch.disabled, true, "不是我们的文件：开关不可用");
  assert.match(ctx.els.autostartWarn.textContent, /不是工作台放的/);
  assert.equal(ctx.els.autostartWarn.hidden, false);
});

test("读取失败：说明原因、开关不可用；连点不会重复提交", async () => {
  const failing = setup({ getJson: spy(async () => { throw new Error("offline"); }) });
  await failing.section.onOpen();
  assert.equal(failing.els.autostartText.textContent, "启动设置读取失败：offline；重新打开配置可重试。");
  assert.equal(failing.els.autostartSwitch.disabled, true);
  await failing.click(true);
  assert.equal(failing.deps.postJson.calls.length, 0, "没读到状态时不提交");

  // 页面比运行中的监控服务新（刚更新完还没重启）：那边没有这个接口，说人话而不是「HTTP 404」。
  const stale = setup({ getJson: spy(async () => { throw Object.assign(new Error("HTTP 404"), { status: 404 }); }) });
  await stale.section.onOpen();
  assert.equal(stale.els.autostartText.textContent, "运行中的监控服务还是旧版本，没有这一项；重启界面后再打开。");
  assert.equal(stale.els.autostartSwitch.disabled, true);

  const pending = deferred();
  const ctx = setup({ postJson: spy(() => pending.promise) });
  await ctx.section.onOpen();
  const first = ctx.click(true);
  await flush();
  await ctx.click(true);
  assert.equal(ctx.deps.postJson.calls.length, 1);
  pending.resolve(base({ enabled: true, state: "on" }));
  await first;
});

test("写入之后才回来的旧读取不覆盖新状态", async () => {
  const slowRead = deferred();
  let reads = 0;
  const ctx = setup({ getJson: spy(() => (++reads === 2 ? slowRead.promise : Promise.resolve(base()))) });
  await ctx.section.onOpen();
  const stale = ctx.section.load(); // 第二次读取还没回来
  await ctx.click(true);
  assert.equal(ctx.els.autostartSwitch.checked, true);
  slowRead.resolve(base()); // 这份读取是在打开开关之前发出的
  await stale;
  assert.equal(ctx.els.autostartSwitch.checked, true, "旧读取被丢弃");
});

test("打包的 App（桌面窗口）：经 electronAPI 读写登录项，不 POST；系统没接受时如实报错并保持没开", async () => {
  const item = { supported: true, enabled: false, status: "not-registered", error: null };
  const electronAPI = {
    getAutostart: spy(async () => ({ ...item })),
    setAutostart: spy(async (enabled) => {
      item.enabled = enabled;
      item.status = enabled ? "enabled" : "not-registered";
      return { ...item };
    }),
  };
  const ctx = setup({ getJson: spy(async () => base({ method: "login-item", enabled: null, file: null })), electronAPI });
  await ctx.section.onOpen();
  assert.equal(electronAPI.getAutostart.calls.length, 1);
  assert.match(ctx.els.autostartText.textContent, /macOS 的登录项/);
  assert.deepEqual([ctx.els.autostartSwitch.checked, ctx.els.autostartSwitch.disabled], [false, false]);
  await ctx.click(true);
  assert.deepEqual(electronAPI.setAutostart.calls, [[true]]);
  assert.equal(ctx.deps.postJson.calls.length, 0, "登录项不经监控服务");
  assert.equal(ctx.els.autostartSwitch.checked, true);
  assert.equal(ctx.deps.showToast.calls[0][0].message, "已开启，下次登录电脑时自动启动。");

  const rejecting = {
    getAutostart: spy(async () => ({ supported: true, enabled: false, status: "not-registered", error: null })),
    setAutostart: spy(async () => ({ supported: true, enabled: false, status: "not-registered", error: null })),
  };
  const refused = setup({ getJson: spy(async () => base({ method: "login-item", enabled: null, file: null })), electronAPI: rejecting });
  await refused.section.onOpen();
  await refused.click(true);
  assert.equal(refused.els.autostartSwitch.checked, false);
  assert.equal(refused.deps.showToast.calls[0][0].type, "error");
  assert.match(refused.deps.showToast.calls[0][0].message, /系统没有接受这次设置.*系统设置 → 通用 → 登录项」里手动添加/);
  assert.equal(refused.deps.getJson.calls.length, 1, "登录项的失败不必重读后端");

  // 关不掉（回读仍是开着）：同样如实报错，开关留在开着，出路是去系统设置里移除。
  const sticky = {
    getAutostart: spy(async () => ({ supported: true, enabled: true, status: "enabled", error: null })),
    setAutostart: spy(async () => ({ supported: true, enabled: true, status: "enabled", error: "Operation not permitted" })),
  };
  const stuck = setup({ getJson: spy(async () => base({ method: "login-item", enabled: null, file: null })), electronAPI: sticky });
  await stuck.section.onOpen();
  assert.equal(stuck.els.autostartSwitch.checked, true);
  await stuck.click(false);
  assert.equal(stuck.els.autostartSwitch.checked, true);
  assert.equal(stuck.deps.showToast.calls[0][0].message, "没有改成：系统没有接受这次设置；可以到「系统设置 → 通用 → 登录项」里手动把它移除。（Operation not permitted）");
});

test("打包的 App 的页面开在浏览器里：没有桌面壳的接口，开关不可用并说明去哪里设", async () => {
  const ctx = setup({ getJson: spy(async () => base({ method: "login-item", enabled: null, file: null })) });
  await ctx.section.onOpen();
  assert.equal(ctx.els.autostartSwitch.disabled, true);
  assert.match(ctx.els.autostartWarn.textContent, /请在它的桌面窗口里打开「配置 → 启动」/);
  // 旧版桌面壳（preload 里还没有这两个方法）同样按不可用处理，不抛错。
  const old = setup({ getJson: spy(async () => base({ method: "login-item", enabled: null, file: null })), electronAPI: { platform: "darwin" } });
  await old.section.onOpen();
  assert.equal(old.els.autostartSwitch.disabled, true);
});

test("Linux：开关不可用，手动命令显示出来", async () => {
  const ctx = setup({ getJson: spy(async () => base({ supported: false, method: "none", reason: "platform", file: null, manualCommand: "nohup bash '/home/u/wb/start.sh' --autostart >/dev/null 2>&1 &" })) });
  await ctx.section.onOpen();
  assert.equal(ctx.els.autostartSwitch.disabled, true);
  assert.equal(ctx.els.autostartCommand.textContent, "nohup bash '/home/u/wb/start.sh' --autostart >/dev/null 2>&1 &");
  assert.equal(ctx.els.autostartCommand.hidden, false);
});

test("index.html 的骨架与脚本用到的元素一一对应；这一节在配置浮层里，只有一个开关", () => {
  const html = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
  const settings = html.slice(html.indexOf('<dialog id="dlgSettings"'), html.indexOf("</dialog>", html.indexOf('<dialog id="dlgSettings"')));
  const section = settings.slice(settings.indexOf('id="settingsAutostart"'));
  const body = section.slice(0, section.indexOf("</details>"));
  assert.ok(body.length > 0, "「启动」一节在配置浮层里");
  assert.match(body, /<summary><span>启动<small>/);
  for (const id of ["autostartText", "autostartNote", "autostartWarn", "autostartCommand", "autostartSwitch"]) {
    assert.equal(body.split(`id="${id}"`).length - 1, 1, id);
  }
  assert.equal(body.split("<input").length - 1, 1, "只有一个开关");
  assert.match(body, /<input type="checkbox" role="switch" class="mod-switch" id="autostartSwitch" aria-label="登录电脑后自动启动" disabled>/, "读到状态之前不可点");
  assert.match(body, /<span class="mod-label">登录电脑后自动启动<\/span>/);
});
