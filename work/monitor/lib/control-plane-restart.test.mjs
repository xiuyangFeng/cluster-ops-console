import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDesktopMainMeta,
  buildUpdateMenuLabel,
  decideBeforeQuit,
  decideControlPlaneRestart,
  detectBundleUpdate,
  isOwnDesktopMainRecord,
  shouldRetrySingleInstanceLock,
} from "./control-plane-restart.mjs";
import { cmdlineMatches } from "./process-registry.mjs";

test("decideBeforeQuit：重启界面进行中一律拦下，优先于显式退出的任何状态", () => {
  for (const cleanupStarted of [false, true]) {
    for (const quitConfirmed of [false, true]) {
      for (const quitPromptOpen of [false, true]) {
        assert.equal(decideBeforeQuit({ controlPlaneRestarting: true, cleanupStarted, quitConfirmed, quitPromptOpen }), "block-restarting");
      }
    }
  }
});

test("decideBeforeQuit：未重启时保持原 W5 语义", () => {
  assert.equal(decideBeforeQuit({ cleanupStarted: true }), "pass-through");
  assert.equal(decideBeforeQuit({ quitConfirmed: false }), "prompt");
  assert.equal(decideBeforeQuit({ quitConfirmed: false, quitPromptOpen: true }), "prompt-open");
  assert.equal(decideBeforeQuit({ quitConfirmed: true }), "cleanup");
});

test("decideControlPlaneRestart：防重复触发、不抢显式退出、启动完成前不执行", () => {
  assert.deepEqual(decideControlPlaneRestart({ ready: true }), { ok: true, reason: "ok" });
  assert.equal(decideControlPlaneRestart({ ready: true, controlPlaneRestarting: true }).reason, "already-restarting");
  assert.equal(decideControlPlaneRestart({ ready: true, cleanupStarted: true }).reason, "quitting");
  assert.equal(decideControlPlaneRestart({ ready: true, isQuitting: true }).reason, "quitting");
  assert.equal(decideControlPlaneRestart({ ready: true, quitPromptOpen: true }).reason, "quit-prompt-open");
  assert.equal(decideControlPlaneRestart({ ready: false }).reason, "not-ready");
});

test("状态机：重启开始后，Cmd+Q 不会弹确认框也不会进入停数据面的 cleanup", () => {
  const state = { controlPlaneRestarting: false, cleanupStarted: false, quitConfirmed: false, quitPromptOpen: false, isQuitting: false };
  assert.equal(decideControlPlaneRestart({ ready: true, ...state }).ok, true);
  state.controlPlaneRestarting = true;
  assert.equal(decideBeforeQuit(state), "block-restarting");
  assert.equal(state.isQuitting, false);
  // 第二次触发（SIGUSR2 + 托盘同时到）被拒
  assert.equal(decideControlPlaneRestart({ ready: true, ...state }).ok, false);
});

test("detectBundleUpdate：commit 优先、其次 version；磁盘读不到不猜", () => {
  const running = { version: "2.25.2", gitCommit: "aaa", builtAt: "t1" };
  assert.equal(detectBundleUpdate({ running, disk: { ...running } }), null);
  const update = detectBundleUpdate({ running, disk: { version: "2.26.0", gitCommit: "bbb", builtAt: "t2" } });
  assert.equal(update.version, "2.26.0");
  assert.equal(update.key, "2.26.0|bbb|t2");
  // 同 version 不同 commit（本地重打包）也算更新
  assert.ok(detectBundleUpdate({ running, disk: { version: "2.25.2", gitCommit: "ccc", builtAt: "" } }));
  // 无 commit 时按 version
  assert.equal(detectBundleUpdate({ running: { version: "1" }, disk: { version: "1" } }), null);
  assert.ok(detectBundleUpdate({ running: { version: "1" }, disk: { version: "2" } }));
  // 磁盘无元信息（源码模式 / rename 瞬间）→ null
  assert.equal(detectBundleUpdate({ running, disk: null }), null);
  assert.equal(detectBundleUpdate({ running, disk: { version: "", gitCommit: "" } }), null);
  // 运行包无元信息、磁盘有 → 视为有更新
  assert.ok(detectBundleUpdate({ running: null, disk: { version: "2.26.0" } }));
});

test("buildUpdateMenuLabel：托盘文案", () => {
  assert.equal(buildUpdateMenuLabel({ version: "2.26.0" }), "新版本 v2.26.0 已安装 · 重启界面（隧道不中断）");
  assert.equal(buildUpdateMenuLabel({ version: "", gitCommit: "0123456789" }), "新版本 commit 01234567 已安装 · 重启界面（隧道不中断）");
});

test("shouldRetrySingleInstanceLock：只有带新鲜重启标记的实例才重试拿锁", () => {
  const now = 1_000_000;
  assert.equal(shouldRetrySingleInstanceLock({ gotLock: true, marker: String(now), now }), false);
  assert.equal(shouldRetrySingleInstanceLock({ gotLock: false, marker: undefined, now }), false);
  assert.equal(shouldRetrySingleInstanceLock({ gotLock: false, marker: "garbage", now }), false);
  assert.equal(shouldRetrySingleInstanceLock({ gotLock: false, marker: String(now - 2000), now }), true);
  assert.equal(shouldRetrySingleInstanceLock({ gotLock: false, marker: String(now - 120_000), now }), false);
});

test("desktop-main 元数据：command=主可执行文件、无脚本参数，可被注册表校验通过", () => {
  const execPath = "/Applications/Codex Tunnel Operations Console.app/Contents/MacOS/Codex Tunnel Operations Console";
  const meta = buildDesktopMainMeta({ execPath, rootDir: "/Applications/X.app/Contents/Resources/app", parentPid: 1 });
  assert.equal(meta.command, execPath);
  assert.deepEqual(meta.args, []);
  // 注册表 GC 用 cmdlineMatches 判存活：主进程命令行就是可执行文件路径本身
  assert.equal(cmdlineMatches(execPath, { pid: 10, ...meta }), true);
  assert.equal(cmdlineMatches("/usr/bin/ssh -N host", { pid: 10, ...meta }), false);
});

test("isOwnDesktopMainRecord：只删自己的记录", () => {
  assert.equal(isOwnDesktopMainRecord({ pid: 42 }, 42), true);
  assert.equal(isOwnDesktopMainRecord({ pid: 43 }, 42), false);
  assert.equal(isOwnDesktopMainRecord(null, 42), false);
});

test("decideControlPlaneRestart：数据面升级在飞 → 拒绝并给出提示文案", async () => {
  const { DATA_PLANE_UPGRADING_MESSAGE } = await import("./control-plane-restart.mjs");
  const base = { ready: true, controlPlaneRestarting: false, cleanupStarted: false, isQuitting: false, quitPromptOpen: false };
  assert.deepEqual(decideControlPlaneRestart({ ...base, dataPlaneUpgrading: true }), { ok: false, reason: "data-plane-upgrading", message: DATA_PLANE_UPGRADING_MESSAGE });
  assert.equal(DATA_PLANE_UPGRADING_MESSAGE, "后台组件升级中，请稍候");
  assert.equal(decideControlPlaneRestart({ ...base, dataPlaneUpgrading: false }).ok, true);
  // 未就绪优先（信号触发时要记下待办）
  assert.equal(decideControlPlaneRestart({ ...base, ready: false, dataPlaneUpgrading: true }).reason, "not-ready");
});

test("desktop-main 签名：中文安装路径带 ASCII 尾段签名，ps 转义 M- 时仍能校验通过", async () => {
  const { desktopMainSignature } = await import("./control-plane-restart.mjs");
  const execPath = "/Users/x/Documents/集群codex连接/dist/Codex Operations Console.app/Contents/MacOS/Codex Operations Console";
  const meta = buildDesktopMainMeta({ execPath, rootDir: "/r", parentPid: 1 });
  assert.equal(meta.signature, "dist/Codex Operations Console.app/Contents/MacOS/Codex Operations Console");
  assert.equal(desktopMainSignature("/Applications/集群.app/Contents/MacOS/Codex Operations Console"), "Contents/MacOS/Codex Operations Console");
  // 纯 ASCII：不加签名（command 精确子串即可）
  assert.equal(desktopMainSignature("/Applications/X.app/Contents/MacOS/X Console"), "");
  assert.equal("signature" in buildDesktopMainMeta({ execPath: "/Applications/X.app/Contents/MacOS/X", rootDir: "/r", parentPid: 1 }), false);
  // 尾段太短 / 只剩文件名 → 不给签名
  assert.equal(desktopMainSignature("/中/a"), "");
  // C 区域下 macOS ps 的输出：非 ASCII 字节被转义成 M-...
  const escaped = "/Users/x/Documents/M-iM-^[M-^FM-gM->M-$codexM-hM-?M-^^M-fM-^NM-%/dist/Codex Operations Console.app/Contents/MacOS/Codex Operations Console";
  assert.equal(cmdlineMatches(escaped, { pid: 10, ...meta }), true);
  assert.equal(cmdlineMatches(execPath, { pid: 10, ...meta }), true);
  assert.equal(cmdlineMatches("/usr/bin/ssh -N host", { pid: 10, ...meta }), false);
  // 没有签名的旧式记录在转义输出下确实失败（本次修复的根因）
  assert.equal(cmdlineMatches(escaped, { pid: 10, command: execPath, args: [] }), false);
});
