import assert from "node:assert/strict";
import test from "node:test";
import {
  assignOrbits,
  buildConstellations,
  evenPhases,
  galaxySignature,
  hueIndexOf,
  hueStyle,
  memberFlags,
  memberTone,
  orbitGeometry,
  planetRadius,
  PLANET_HUES,
  relatedUsers,
  toMs,
} from "./team-galaxy-model.js";

const m = (user, over = {}) => ({
  user,
  onlineState: "offline",
  usage: { todayTokens: 0, todayCalls: 0, todayErrors: 0 },
  compute: { runningJobs: 0, gpuCount: 0, nodes: [] },
  assignment: { state: "none" },
  ...over,
});

test("hueIndexOf / hueStyle：同一账号永远同一颗星，两套主题同序号", () => {
  assert.equal(hueIndexOf("alice"), hueIndexOf("alice"));
  assert.ok(hueIndexOf("alice") < PLANET_HUES.dark.length);
  assert.equal(PLANET_HUES.dark.length, PLANET_HUES.light.length);
  assert.match(hueStyle("alice"), /^--hd-hi:#[0-9a-f]{6};--hd-base:#[0-9a-f]{6};--hd-lo:#[0-9a-f]{6};--hl-hi:#[0-9a-f]{6};--hl-base:#[0-9a-f]{6};--hl-lo:#[0-9a-f]{6}$/);
  assert.equal(hueStyle("alice"), hueStyle("alice"));
});

test("assignOrbits：按在线状态分到三条轨道，轨道内按账号排序，未知状态落到离线", () => {
  const orbits = assignOrbits([m("zed", { onlineState: "tunnel-online" }), m("amy", { onlineState: "tunnel-online" }), m("bo", { onlineState: "ssh-only" }), m("cc"), m("dd", { onlineState: "weird" }), null]);
  assert.deepEqual(orbits.map((o) => o.map((x) => x.user)), [["amy", "zed"], ["bo"], ["cc", "dd"]]);
});

test("planetRadius：sqrt 刻度，0 用量最小，人多整体收小", () => {
  assert.equal(planetRadius(m("a"), 100), 5);
  assert.equal(planetRadius(m("a", { usage: { todayTokens: 100 } }), 100), 16);
  assert.ok(planetRadius(m("a", { usage: { todayTokens: 25 } }), 100) < planetRadius(m("a", { usage: { todayTokens: 100 } }), 100));
  assert.ok(planetRadius(m("a", { usage: { todayTokens: 100 } }), 100, true) < 16);
  assert.equal(planetRadius(m("a", { usage: { todayTokens: 50 } }), 0), 5, "全员 0 用量不除零");
});

test("buildConstellations：同节点只看正在算的人；配置按 groupKey；少于 2 人不成星座", () => {
  const team = [
    m("a", { compute: { runningJobs: 1, gpuCount: 2, nodes: ["node04", "node05"] }, assignment: { state: "applied", groupKey: "k1", groupLabel: "Codex · team" } }),
    m("b", { compute: { runningJobs: 0, gpuCount: 1, nodes: ["node04"] }, assignment: { state: "pending-sync", groupKey: "k1", groupLabel: "Codex · team" } }),
    m("c", { compute: { runningJobs: 0, gpuCount: 0, nodes: ["node05"] }, assignment: { state: "applied", groupKey: "k2" } }),
    m("d", { compute: { runningJobs: 1, gpuCount: 0, nodes: ["node05"] }, assignment: { state: "none", groupKey: "k2" } }),
  ];
  const g = buildConstellations(team);
  assert.deepEqual(g.node.map((x) => [x.key, x.users]), [["node04", ["a", "b"]], ["node05", ["a", "d"]]]);
  assert.deepEqual(g.config.map((x) => [x.key, x.label, x.users]), [["k1", "Codex · team", ["a", "b"]]], "c 单独一份不成星座，d 未托管不算");
  assert.deepEqual([...relatedUsers("a", g)].sort(), ["a", "b", "d"]);
  assert.deepEqual([...relatedUsers("c", g)], ["c"]);
  assert.deepEqual(buildConstellations(null), { node: [], config: [] });
});

test("memberFlags / memberTone：按严重程度排序；出网看 egress.state=error", () => {
  const x = m("x", {
    usage: { todayErrors: 2 },
    egress: { state: "error", reason: "upstream-refused" },
    portDrift: true,
    assignedPort: 1,
    registeredPorts: [2],
    versionOutdated: true,
    assignment: { state: "pending-sync" },
  });
  const flags = memberFlags(x);
  assert.deepEqual(flags.map((f) => f.tone), ["crit", "crit", "warn", "warn", "info"]);
  assert.equal(flags[1].title, "上游代理拒绝连接");
  assert.equal(memberTone(x), "crit");
  assert.equal(memberTone(m("y", { assignment: { state: "pending-sync" } })), "info");
  assert.equal(memberTone(m("z")), "");
});

test("galaxySignature：用量小幅波动不变，在线状态 / GPU / 星座变化才变", () => {
  const base = [m("a", { onlineState: "tunnel-online", usage: { todayTokens: 1_000_000, todayCalls: 100 } }), m("b")];
  const sig = galaxySignature(base);
  assert.equal(galaxySignature([...base].reverse()), sig, "与顺序无关");
  assert.equal(galaxySignature([{ ...base[0], usage: { todayTokens: 1_030_000, todayCalls: 104 } }, base[1]]), sig);
  assert.notEqual(galaxySignature([{ ...base[0], onlineState: "offline" }, base[1]]), sig);
  assert.notEqual(galaxySignature([{ ...base[0], compute: { gpuCount: 2, nodes: [] } }, base[1]]), sig);
  assert.notEqual(galaxySignature([base[0], { ...base[1], assignment: { state: "applied", groupKey: "k" } }]), sig);
});

test("orbitGeometry / evenPhases / toMs", () => {
  const g = orbitGeometry(1000, 520);
  assert.equal(g.orbits.length, 3);
  assert.ok(g.orbits[0].rx < g.orbits[1].rx && g.orbits[1].rx < g.orbits[2].rx);
  assert.ok(g.cy - g.orbits[2].ry >= 70, "外轨顶部让开标题");
  assert.ok(g.cy + g.orbits[2].ry <= 520 - 78 - 20, "外轨底部让开读数带");
  assert.ok(g.orbits[2].rx <= 1000 / 2 - 78);
  const tiny = orbitGeometry(200, 100);
  assert.ok(tiny.orbits[2].ry > 0 && tiny.orbits[2].rx >= tiny.orbits[2].ry, "极小尺寸不出负数");
  const quarter = evenPhases(4);
  assert.equal(quarter.length, 4);
  for (const [i, p] of quarter.entries()) assert.ok(Math.abs(p - (i * Math.PI) / 2) < 1e-9);
  assert.equal(toMs(1700000000000), 1700000000000);
  assert.equal(toMs("2026-10-16T00:00:00Z"), Date.parse("2026-10-16T00:00:00Z"));
  assert.equal(toMs(null), null);
  assert.equal(toMs("junk"), null);
});
