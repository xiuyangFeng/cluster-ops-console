// 休眠归因的跨模块接线：supervisor 记账 → 账本落盘 → 监控侧统计 / 简报 → 页面上的字，一条线走到底。
// 各段各自的规则在同目录的模块测试里（lib/supervisor/tunnel-sleep、lib/tunnel-ledger-stats、lib/brief/brief、
// render/tunnel-stability-*）；这里只管它们接起来之后，2026-10-11 那一晚在界面上到底显示成什么。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DROP_CAUSE_TEXT } from "../work/monitor/lib/brief/model.mjs";
import { createBriefService } from "../work/monitor/lib/brief/service.mjs";
import { COMPONENT_ENTRIES, listImportClosure } from "../work/monitor/lib/component-version.mjs";
import { recordedLedger, replaySleepScene, sceneConfig, sceneTime } from "../work/monitor/lib/supervisor/sleep-scene-fixture.mjs";
import { SLEEP_ATTRIBUTION_MS, WAKE_GAP_MS } from "../work/monitor/lib/supervisor/tunnel-controller.mjs";
import { createTunnelLedgerWriter, TUNNEL_LEDGER_FILENAME } from "../work/monitor/lib/supervisor/tunnel-ledger.mjs";
import { inEveryTimeZone } from "../work/monitor/lib/test-timezones.mjs";
import { OBSERVED_GAP_MAX_MS, SLEEP_MERGE_GAP_MS, SLEEP_RECOVERY_GRACE_MS } from "../work/monitor/lib/tunnel-ledger-stats.mjs";
import { createTunnelStabilityService } from "../work/monitor/lib/tunnel-stability-service.mjs";
import { briefBodyHtml } from "../work/monitor/public/assets/js/render/brief-view.js";
import { DROP_CAUSE_LABELS } from "../work/monitor/public/assets/js/render/tunnel-stability-model.js";
import { stabilityHtml } from "../work/monitor/public/assets/js/render/tunnel-stability-view.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOUR = 3600_000;
const NOW = sceneTime("23:00:00"); // 当晚 23 点看界面
// 夹具只截了当晚；账本本身早就在记（否则简报停在「数据积累中」）。
const LEDGER_BEGAN = { v: 1, type: "alive", at: sceneTime("00:00:00") - 30 * HOUR };

// 账本行 →（真实写入端）磁盘 →（真实读取端）接口数据 → 页面 HTML。
async function renderEvening(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-wiring-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const writer = createTunnelLedgerWriter({ runtimeDir: dir });
  for (const row of [LEDGER_BEGAN, ...rows]) writer.append(row);
  await writer.flush();
  const written = fs.readFileSync(path.join(dir, TUNNEL_LEDGER_FILENAME), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const tunnelStability = createTunnelStabilityService({ runtimeDir: dir, getMergedConfig: sceneConfig, now: () => NOW });
  const briefService = createBriefService({
    runtimeDir: dir,
    getMergedConfig: sceneConfig,
    tunnelStability,
    incidentStore: { query: () => ({ incidents: [], nextCursor: null }) },
    now: () => NOW,
  });
  // 接口发出去的是 JSON：照样过一遍。
  const stats = JSON.parse(JSON.stringify(await tunnelStability.get()));
  const brief = JSON.parse(JSON.stringify(await briefService.get()));
  return { written, stats, brief };
}

test("2026-10-11 合盖那一晚 · 现在的 supervisor：简报一条中性的「电脑休眠 2 小时 42 分」，隧道稳定性 0 次断线、没有红色", async (t) => {
  const { rows } = await replaySleepScene();
  const { written, stats, brief } = await renderEvening(t, rows);
  assert.deepEqual(written.slice(1), rows, "账本落盘前后一字不差（sleep / wake 都过得了白名单）");

  await inEveryTimeZone((zone) => {
    const briefHtml = briefBodyHtml(brief, { lastViewedAt: null });
    assert.match(briefHtml, /<p class="bf-headline" data-tone="ok"><strong>整体平稳。<\/strong>隧道近 24 小时没有断线；没有新的事件。<\/p>/, zone);
    assert.equal((briefHtml.match(/<li /g) || []).length, 1, `${zone}：值得留意只有一条`);
    assert.match(briefHtml, /<li data-tone="neutral"><span class="bf-note-text">电脑休眠 2 小时 42 分，期间隧道不可用<\/span>/, zone);
    assert.match(briefHtml, /data-tone="ok" data-brief-goto="stability"><span class="bf-label">隧道 · 近 24 小时<\/span><span class="bf-value">0<small> 次断线<\/small><\/span><span class="bf-sub">可用率 100%<\/span>/, zone);
    assert.doesNotMatch(briefHtml, /断开|data-tone="critical"|data-tone="warn"/, zone);

    const { html } = stabilityHtml(stats, { windowKey: "24h", nowMs: NOW, dropsOpen: true });
    assert.equal((html.match(/>0 次断线 · 100%<\/small>/g) || []).length, 2, `${zone}：两条隧道都是 0 次断线`);
    assert.doesNotMatch(html, /class="cu-drop"|data-ongoing="true"|data-tone="critical"|data-tone="warn"/, `${zone}：没有红色的断开段，也没有标红的行`);
    // 在线条上是一整段斜纹，悬停说明按北京时间写（不随机器时区变）
    assert.match(html, /class="cu-unobserved" [^>]*title="10\.11 19:03 本机休眠 · 2 小时 42 分（期间隧道不可用，不计入断线与可用率）"/, zone);
    assert.match(html, /<span class="cu-label">最近一次<\/span>记录以来没有断线（自 10\.9 18:00）/, zone);
    assert.match(html, /data-stability-drops aria-expanded="true" aria-controls="stabilityDrops">休眠 1 次/, zone);
    assert.match(html, /<td class="ts-num">10\.11 19:03<\/td><td>主集群<\/td><td>本机休眠<\/td><td class="ts-num">2 小时 42 分<\/td>/, zone);
    assert.match(html, /<td class="ts-num">10\.11 19:03<\/td><td>云主机<\/td><td>本机休眠<\/td><td class="ts-num">2 小时 45 分<\/td>/, zone);
    assert.equal((html.match(/<tr data-ongoing/g) || []).length, 2, `${zone}：清单里每条隧道一行，不是一串`);

    const week = stabilityHtml(stats, { windowKey: "7d", nowMs: NOW }).html;
    assert.equal((week.match(/data-tone="ok" title="10\.11 · 断线 0 次 · 可用率 100% · 本机休眠 2 小时 42 分"/g) || []).length, 2, zone);
  });
});

test("同一晚 · 旧版 supervisor 记的账本（没有 sleep / wake）：界面与改动之前一样——三条标红的断线", async (t) => {
  const { written, stats, brief } = await renderEvening(t, recordedLedger());
  assert.ok(written.every((row) => row.type !== "wake" && !("sleep" in row)));
  const briefHtml = briefBodyHtml(brief, { lastViewedAt: null });
  assert.match(briefHtml, /<p class="bf-headline" data-tone="critical"><strong>需要留意。<\/strong>云主机 21:03–21:46 断开 43 分（连接被关闭）；主集群 20:46–21:36 断开 50 分（服务器端断开）。<\/p>/);
  assert.equal((briefHtml.match(/<li data-tone="critical">/g) || []).length, 3);
  assert.doesNotMatch(briefHtml, /休眠/);
  const { html } = stabilityHtml(stats, { windowKey: "24h", nowMs: NOW, dropsOpen: true });
  assert.match(html, />3 次断线 · [\d.]+%<\/small>/);
  assert.match(html, />4 次断线 · [\d.]+%<\/small>/);
  assert.match(html, /全部 7 次/);
  assert.match(html, /class="cu-drop"/);
  assert.doesNotMatch(html, /本机休眠/);
});

test("写入端与读取端的几个时间窗口对得上", () => {
  assert.equal(SLEEP_MERGE_GAP_MS, SLEEP_ATTRIBUTION_MS, "读侧把醒来后被标了 sleep 的断线归到刚结束的那段休眠，窗口要与 supervisor 的归因窗口同长");
  assert.ok(SLEEP_ATTRIBUTION_MS > WAKE_GAP_MS, "归因窗口得长过发现跳变的阈值");
  // 宽限里暂存的时间一律当「看着的」记账：宽限必须短于观测空档的阈值，空档一出现就已经过了宽限。
  assert.ok(SLEEP_RECOVERY_GRACE_MS < OBSERVED_GAP_MAX_MS);
});

test("原因文案：简报（后端）与隧道稳定性（前端）两份对照表逐项一致，都有「本机休眠」", () => {
  assert.deepEqual({ ...DROP_CAUSE_TEXT }, { ...DROP_CAUSE_LABELS });
  assert.equal(DROP_CAUSE_TEXT.sleep, "本机休眠");
});

test("指纹闭包：记账的两个文件只在 supervisor 闭包里；读侧、简报与夹具不在任何数据面闭包里，proxy 碰不到", async () => {
  const supervisor = await listImportClosure(ROOT, COMPONENT_ENTRIES.supervisor);
  const proxy = await listImportClosure(ROOT, COMPONENT_ENTRIES.proxy);
  for (const file of ["work/monitor/lib/supervisor/tunnel-controller.mjs", "work/monitor/lib/supervisor/tunnel-ledger.mjs"]) {
    assert.ok(supervisor.includes(file), file);
    assert.ok(!proxy.includes(file), `${file} 不该进 proxy 闭包`);
  }
  for (const file of [
    "work/monitor/lib/tunnel-ledger-stats.mjs",
    "work/monitor/lib/tunnel-stability-service.mjs",
    "work/monitor/lib/brief/model.mjs",
    "work/monitor/lib/brief/service.mjs",
    "work/monitor/lib/reports/model.mjs",
    "work/monitor/lib/supervisor/sleep-scene-fixture.mjs",
  ]) {
    assert.ok(!supervisor.includes(file), `${file} 不该进 supervisor 闭包`);
    assert.ok(!proxy.includes(file), `${file} 不该进 proxy 闭包`);
  }
});
