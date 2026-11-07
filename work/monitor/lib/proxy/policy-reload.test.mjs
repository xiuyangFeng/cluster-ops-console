import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPolicy, createPolicyLoader } from "./policy-reload.mjs";
import { EXTRA_ALLOWED_TARGETS } from "./target-policy.mjs";

// 注入版装配：loadConfig 返回当前 config（或抛错），stamp 由测试推进，detector 可控。
function harness({ config = {}, detected = { proxy: null }, selfPort = 8888 } = {}) {
  const state = { config, stamp: 1, detected, detectCalls: [] };
  const lines = [];
  const intervals = [];
  const loader = createPolicyLoader({
    configPath: "/team/config.json",
    localConfigPath: "/me/config.local.json",
    loadConfig: () => {
      if (state.config instanceof Error) throw state.config;
      return state.config;
    },
    stamp: (p) => `${p}#${state.stamp}`,
    detector: {
      detect: async (opts = {}) => {
        state.detectCalls.push(opts);
        if (state.detected instanceof Error) throw state.detected;
        return state.detected;
      },
    },
    selfPort,
    log: (l) => lines.push(l),
    setIntervalImpl: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearIntervalImpl: () => {},
  });
  return { loader, state, lines, intervals };
}

const allows = (policy, host, port) => policy.allowTarget(host, port);

test("首次加载：白名单（团队+个人已合并）与出网方式生成策略；manual 直接用填写的上游", async () => {
  const h = harness({ config: { proxyAllowedTargets: ["relay.example.com:9443"], egress: { mode: "manual", url: "http://127.0.0.1:7890" } } });
  await h.loader.load();
  const p = h.loader.getPolicy();
  assert.equal(p.egressMode, "manual");
  assert.deepEqual(p.upstream, { host: "127.0.0.1", port: 7890, url: "http://127.0.0.1:7890" });
  assert.equal(allows(p, "relay.example.com", 9443), true);
  assert.equal(allows(p, "other.example.com", 9443), false);
  assert.equal(allows(p, "api.openai.com", 443), true);
  assert.match(h.lines.at(-1), /策略已加载：白名单 1 条，出网 手动上游 http:\/\/127\.0\.0\.1:7890/);
});

test("首次加载失败（团队配置烂 / 路径缺失）：回落内置默认（空白名单 + 直连）并告警", async () => {
  const h = harness({ config: new Error("Unexpected token") });
  await h.loader.load();
  const p = h.loader.getPolicy();
  assert.equal(p.extraAllowedTargets, EXTRA_ALLOWED_TARGETS);
  assert.equal(p.upstream, null);
  assert.ok(h.lines.some((l) => /读取配置失败.*proxyAllowedTargets.*Unexpected token/.test(l)));

  const noPaths = createPolicyLoader({ configPath: undefined, log: () => {}, detector: { detect: async () => ({}) } });
  await noPaths.load();
  assert.equal(noPaths.getPolicy().egressMode, "direct");
});

test("热重载：文件戳不变不重读；变了就换策略（不重启），只有生效策略变化才打日志", async () => {
  const h = harness({ config: { proxyAllowedTargets: ["a.example.com:9443"] } });
  await h.loader.load();
  const first = h.loader.getPolicy();
  assert.equal(await h.loader.checkConfig(), false, "戳没变");
  assert.equal(h.loader.getPolicy(), first);

  h.state.config = { proxyAllowedTargets: ["a.example.com:9443", "b.example.com:8443"], activeServerId: "x" };
  h.state.stamp = 2;
  assert.equal(await h.loader.checkConfig(), true);
  assert.equal(allows(h.loader.getPolicy(), "b.example.com", 8443), true);
  assert.match(h.lines.at(-1), /策略已热重载：白名单 2 条，出网 直连/);

  const before = h.lines.length;
  h.state.config = { proxyAllowedTargets: ["b.example.com:8443", "a.example.com:9443"], activeServerId: "y" };
  h.state.stamp = 3;
  await h.loader.checkConfig();
  assert.equal(h.lines.length, before, "无关字段变化、白名单只是换了顺序：不刷日志");
});

test("热重载失败（个人层半写 / 读错）：保留上一份生效策略，绝不清空白名单", async () => {
  const h = harness({ config: { proxyAllowedTargets: ["keep.example.com:9443"], egress: { mode: "manual", url: "http://127.0.0.1:7890" } } });
  await h.loader.load();
  const kept = h.loader.getPolicy();

  h.state.config = { _localConfigError: true };
  h.state.stamp = 2;
  await h.loader.checkConfig();
  assert.equal(h.loader.getPolicy(), kept);
  assert.match(h.lines.at(-1), /个人配置读取失败.*保留当前白名单与出网方式/);

  h.state.config = new Error("EACCES");
  h.state.stamp = 3;
  await h.loader.checkConfig();
  assert.equal(h.loader.getPolicy(), kept);
  assert.match(h.lines.at(-1), /重读配置失败，保留当前白名单与出网方式: EACCES/);
});

test("system 模式：识别到 HTTP 代理就用它；识别不到 / 只有 SOCKS 按直连并说明；定时复查强制重识别、上游变了就换", async () => {
  const h = harness({ config: { egress: { mode: "system" } }, detected: { proxy: { host: "127.0.0.1", port: 7897, url: "http://127.0.0.1:7897" } } });
  await h.loader.load();
  assert.equal(h.loader.getPolicy().upstream.url, "http://127.0.0.1:7897");
  assert.equal(h.loader.getPolicy().egressMode, "system");

  h.state.detected = { proxy: null, socks: { host: "127.0.0.1", port: 7891 } };
  await h.loader.refreshSystemProxy();
  assert.deepEqual(h.state.detectCalls.at(-1), { force: true });
  assert.equal(h.loader.getPolicy().upstream, null);
  assert.equal(h.loader.getPolicy().egressMode, "system", "方式仍是 system，只是暂按直连");
  assert.match(h.lines.at(-1), /出网 系统代理（系统只开了 SOCKS 代理，暂不支持，暂按直连）/);

  h.state.detected = new Error("scutil missing");
  await h.loader.refreshSystemProxy();
  assert.equal(h.loader.getPolicy().upstream, null);
  assert.match(h.lines.at(-1), /识别系统代理失败：scutil missing/);

  // 非 system 模式时定时复查什么也不做。
  h.state.config = { egress: { mode: "direct" } };
  h.state.stamp = 9;
  await h.loader.checkConfig();
  const calls = h.state.detectCalls.length;
  await h.loader.refreshSystemProxy();
  assert.equal(h.state.detectCalls.length, calls);
});

test("上游指回本代理自己（环回 + 同端口）：丢弃上游按直连，并告警", async () => {
  const h = harness({ config: { egress: { mode: "manual", url: "http://127.0.0.1:8888" } }, selfPort: 8888 });
  await h.loader.load();
  assert.equal(h.loader.getPolicy().upstream, null);
  assert.match(h.lines.at(-1), /上游 http:\/\/127\.0\.0\.1:8888 就是本代理自己，暂按直连/);
});

test("上游指回自己的其它写法（0.0.0.0 / [::] / localhost）同样丢弃（v2.54 终审）", async () => {
  for (const url of ["http://0.0.0.0:8888", "http://[::]:8888", "http://localhost:8888"]) {
    const h = harness({ config: { egress: { mode: "manual", url } }, selfPort: 8888 });
    await h.loader.load();
    assert.equal(h.loader.getPolicy().upstream, null, url);
    assert.match(h.lines.at(-1), /就是本代理自己，暂按直连/, url);
  }
});

test("首次加载时个人层损坏：告警一行，照旧按团队配置（合并结果）加载，不阻断启动", async () => {
  const h = harness({ config: { proxyAllowedTargets: ["team.example.com:9443"], _localConfigError: true } });
  await h.loader.load();
  assert.ok(h.lines.some((l) => /个人配置读取失败.*本次只按团队配置加载/.test(l)), JSON.stringify(h.lines));
  assert.equal(allows(h.loader.getPolicy(), "team.example.com", 9443), true, "回落行为不变：团队白名单照常生效");
  assert.equal(h.loader.getPolicy().egressMode, "direct");
});

test("egress 写错（未知方式 / manual 缺地址）：按直连并告警，白名单照常生效", async () => {
  const h = harness({ config: { proxyAllowedTargets: ["a.example.com:9443"], egress: { mode: "manual", url: "socks5://127.0.0.1:1080" } } });
  await h.loader.load();
  assert.equal(h.loader.getPolicy().egressMode, "direct");
  assert.equal(allows(h.loader.getPolicy(), "a.example.com", 9443), true);
  assert.ok(h.lines.some((l) => /egress\.url .* 不是 http:\/\/主机:端口，出网按直连处理/.test(l)));
});

test("start：装两个 unref 的定时器（配置 2 秒、系统代理 30 秒），重复 start 不叠加", async () => {
  const h = harness();
  h.loader.start();
  h.loader.start();
  assert.deepEqual(h.intervals.map((i) => i.ms), [2000, 30_000]);
});

test("真实文件：loadLayeredConfig + fileStamp，改个人层白名单后 checkConfig 即生效", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "policy-reload-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  const localConfigPath = path.join(dir, "config.local.json");
  writeFileSync(configPath, JSON.stringify({ proxyAllowedTargets: ["team.example.com:9443"] }));
  const loader = createPolicyLoader({ configPath, localConfigPath, log: () => {}, detector: { detect: async () => ({ proxy: null }) } });
  await loader.load();
  assert.equal(loader.getPolicy().extraAllowedTargets.has("mine.example.com:8443"), false);

  writeFileSync(localConfigPath, JSON.stringify({ proxyAllowedTargets: ["mine.example.com:8443"] }));
  assert.equal(await loader.checkConfig(), true);
  const policy = loader.getPolicy();
  assert.deepEqual([...policy.extraAllowedTargets].sort(), ["mine.example.com:8443", "team.example.com:9443"], "团队层与个人层取并集");

  writeFileSync(localConfigPath, "{ half-written");
  await loader.checkConfig();
  assert.equal(loader.getPolicy(), policy, "个人层坏掉时保留上一份");
});

test("buildPolicy 缺省 = 内置默认（空白名单 + 直连）", () => {
  const p = buildPolicy();
  assert.equal(p.egressMode, "direct");
  assert.equal(p.upstream, null);
  assert.equal(p.extraAllowedTargets.size, 0);
});
