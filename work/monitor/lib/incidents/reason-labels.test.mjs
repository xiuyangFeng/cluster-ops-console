// 守护：后端会写进事件的每一个原因码，界面上都有文案（render/incidents.js 的 REASON_LABELS）。
// 这里把后端产生原因码的几处都走一遍；以后新增原因码而没补文案，这个测试会指出是哪一个。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { incidentReasonLabel } from "../../public/assets/js/render/incidents.js";
import { agentReasonCode } from "../../server/incident-sync.mjs";
import { deriveTransportState } from "../readiness-view.mjs";
import { createIncidentStore } from "./store.mjs";

const hasLabel = (code) => incidentReasonLabel(code) !== code && !/[A-Z_]{3,}/.test(incidentReasonLabel(code));

test("Agent 原因码（agentReasonCode 的全部取值）都有界面文案", () => {
  // 映射表里登记的 health 取值直接从源码里读出来：新增一种 health 时不用记得来改这个测试。
  const source = readFileSync(new URL("../../server/incident-sync.mjs", import.meta.url), "utf8");
  const table = source.match(/const AGENT_HEALTH_REASON = \{([\s\S]*?)\};/);
  assert.ok(table, "找不到 AGENT_HEALTH_REASON：原因码的来源变了，这个守护要跟着改");
  const healths = [...table[1].matchAll(/^\s*"?([a-z-]+)"?:\s*"[A-Z_]+"/gm)].map((match) => match[1]);
  assert.ok(healths.length >= 5, `health 取值应至少有 5 种，读到 ${healths.join(",")}`);
  const codes = new Set([...healths, undefined, "", "anything-else"].map((health) => agentReasonCode(health)));
  assert.ok(codes.has("DEGRADED") && codes.has("AGENT_ATTENTION"));
  for (const code of codes) assert.ok(hasLabel(code), `Agent 原因码 ${code} 缺界面文案`);
});

test("通道原因码（deriveTransportState 的全部取值与缺省 CHANNEL_ERROR）都有界面文案", () => {
  const codes = new Set(["CHANNEL_ERROR", deriveTransportState({ shouldBeRunning: false }).reasonCode, deriveTransportState({}).reasonCode]);
  for (const localProxyUp of [true, false]) {
    for (const tunnelUp of [true, false]) {
      for (const remotePortOpen of [true, false]) {
        codes.add(deriveTransportState({ shouldBeRunning: true, localProxyUp, tunnelUp, remotePortOpen }).reasonCode);
      }
    }
  }
  assert.ok(codes.has("TUNNEL_DOWN") && codes.has("WAITING_FIRST_PROBE") && codes.has("MANUALLY_STOPPED"));
  for (const code of codes) {
    // 数据通路同时断了几段时原因码用 + 连起来：逐段都要有文案。
    for (const part of code.split("+")) assert.ok(hasLabel(part), `通道原因码 ${part} 缺界面文案`);
    assert.doesNotMatch(incidentReasonLabel(code), /[A-Z_]{3,}/, `${code} 的文案里不应夹着原因码`);
  }
});

test("隧道与磁盘原因码（TUNNEL_DOWN / store.observeDiskUsage 写入的码）都有界面文案", () => {
  const store = createIncidentStore({ openGate: {}, now: () => 1_000_000 });
  const disk = store.observeDiskUsage({ serverId: "srv-a", usedPct: 95 });
  assert.equal(disk.reasonCode, "DISK_THRESHOLD");
  for (const code of ["TUNNEL_DOWN", disk.reasonCode]) assert.ok(hasLabel(code), `${code} 缺界面文案`);
});
