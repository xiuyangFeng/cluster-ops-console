// config-loader 的出网（egress）解析与个人层白名单写入校验（v2.54）。单独成文件，
// 与 config-loader.test.mjs 里端口 / 服务器相关的用例互不干扰。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ConfigValidationError,
  mergeConfig,
  normalizeEgressForWrite,
  PERSONAL_ALLOWLIST_MAX,
  PERSONAL_FIELDS,
  resolveEgressSetting,
  validateAllowlistForWrite,
  writePersonalConfig,
} from "./config-loader.mjs";

test("egress 是个人层字段：合并时个人层生效", () => {
  assert.ok(PERSONAL_FIELDS.includes("egress"));
  const merged = mergeConfig({ servers: [] }, { egress: { mode: "system" } });
  assert.deepEqual(merged.egress, { mode: "system" });
});

test("resolveEgressSetting：缺省直连；manual 给出上游；写错按直连并说明原因", () => {
  assert.deepEqual(resolveEgressSetting(undefined), { mode: "direct", url: null, upstream: null, issue: null });
  assert.deepEqual(resolveEgressSetting({ mode: "manual", url: "http://127.0.0.1:7890/" }), {
    mode: "manual", url: "http://127.0.0.1:7890", upstream: { host: "127.0.0.1", port: 7890, url: "http://127.0.0.1:7890" }, issue: null,
  });
  const system = resolveEgressSetting({ mode: "system", url: "http://127.0.0.1:7890" });
  assert.equal(system.mode, "system");
  assert.equal(system.upstream, null, "system 的上游由代理运行时识别");
  assert.equal(system.url, "http://127.0.0.1:7890", "保留填过的手动地址");

  for (const bad of [{ mode: "socks" }, { mode: "manual" }, { mode: "manual", url: "https://127.0.0.1:7890" }, "system", []]) {
    const r = resolveEgressSetting(bad);
    assert.equal(r.mode, "direct", JSON.stringify(bad));
    assert.ok(r.issue, JSON.stringify(bad));
  }
});

test("normalizeEgressForWrite：只收三种方式；manual 必须是 http://host:port；非 manual 也可保留合法地址", () => {
  assert.deepEqual(normalizeEgressForWrite({ mode: "direct" }), { mode: "direct" });
  assert.deepEqual(normalizeEgressForWrite({}), { mode: "direct" });
  assert.deepEqual(normalizeEgressForWrite({ mode: "manual", url: " http://Proxy.LAN:3128/ " }), { mode: "manual", url: "http://proxy.lan:3128" });
  assert.deepEqual(normalizeEgressForWrite({ mode: "system", url: "http://127.0.0.1:7890", extra: 1 }), { mode: "system", url: "http://127.0.0.1:7890" }, "多余字段丢弃");
  assert.deepEqual(normalizeEgressForWrite({ mode: "system", url: "" }), { mode: "system" });

  const fieldOf = (fn) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof ConfigValidationError);
      return err.errors[0].field;
    }
    assert.fail("应抛 ConfigValidationError");
  };
  assert.equal(fieldOf(() => normalizeEgressForWrite("system")), "egress");
  assert.equal(fieldOf(() => normalizeEgressForWrite({ mode: "pac" })), "egress.mode");
  assert.equal(fieldOf(() => normalizeEgressForWrite({ mode: "manual" })), "egress.url");
  assert.equal(fieldOf(() => normalizeEgressForWrite({ mode: "manual", url: "socks5://127.0.0.1:7891" })), "egress.url");
  assert.equal(fieldOf(() => normalizeEgressForWrite({ mode: "direct", url: "http://u:p@h:1" })), "egress.url");
});

test("validateAllowlistForWrite：归一化去重；443 / 私网 / 缺端口 / 怪主机名逐条报错；最多 32 条", () => {
  assert.deepEqual(validateAllowlistForWrite(["API.Relay-Demo.example:9443", "api.relay-demo.example:9443", " relay.example.com:8443 "]), {
    ok: true, value: ["api.relay-demo.example:9443", "relay.example.com:8443"], errors: [],
  });
  assert.deepEqual(validateAllowlistForWrite([]), { ok: true, value: [], errors: [] }, "空数组 = 清空个人白名单");

  const bad = validateAllowlistForWrite(["api.openai.com:443", "10.1.2.3:9443", "localhost:8080", "no-port.example.com", "bad host:9443", 7]);
  assert.equal(bad.ok, false);
  assert.equal(bad.value, null);
  assert.deepEqual(bad.errors.map((e) => e.field), [0, 1, 2, 3, 4, 5].map((i) => `proxyAllowedTargets[${i}]`));
  assert.match(bad.errors[0].message, /443 端口默认放行/);
  assert.match(bad.errors[1].message, /内网/);

  const tooMany = validateAllowlistForWrite(Array.from({ length: PERSONAL_ALLOWLIST_MAX + 1 }, (_, i) => `h${i}.example.com:9443`));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors.at(-1).message, /最多 32 条/);
  assert.equal(validateAllowlistForWrite("a.example.com:9443").ok, false);
});

test("writePersonalConfig：egress 与 proxyAllowedTargets 校验后落盘（归一化）；不合法整体拒绝、原文件不动", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "personal-egress-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const localConfigPath = path.join(dir, "config.local.json");
  writeFileSync(localConfigPath, JSON.stringify({ sshUser: "kai", revision: 3 }));

  const saved = writePersonalConfig({
    localConfigPath,
    patch: { egress: { mode: "manual", url: "http://127.0.0.1:7890/" }, proxyAllowedTargets: ["API.Relay-Demo.example:9443"] },
    expectedRevision: 3,
  });
  assert.deepEqual(saved.egress, { mode: "manual", url: "http://127.0.0.1:7890" });
  assert.deepEqual(saved.proxyAllowedTargets, ["api.relay-demo.example:9443"]);
  assert.equal(saved.sshUser, "kai", "其余字段原样保留");
  const onDisk = JSON.parse(readFileSync(localConfigPath, "utf8"));
  assert.deepEqual(onDisk.proxyAllowedTargets, ["api.relay-demo.example:9443"]);
  assert.equal(onDisk.revision, 4);

  const snapshot = readFileSync(localConfigPath, "utf8");
  assert.throws(
    () => writePersonalConfig({ localConfigPath, patch: { proxyAllowedTargets: ["192.168.1.5:9443"] } }),
    (err) => err instanceof ConfigValidationError && err.errors[0].field === "proxyAllowedTargets[0]",
  );
  assert.throws(
    () => writePersonalConfig({ localConfigPath, patch: { egress: { mode: "manual", url: "socks5://127.0.0.1:1080" } } }),
    (err) => err instanceof ConfigValidationError && err.errors[0].field === "egress.url",
  );
  assert.equal(readFileSync(localConfigPath, "utf8"), snapshot, "校验失败时原文件一字不改");

  // 合并后个人白名单与团队层取并集（代理侧读到的就是这份）。
  const merged = mergeConfig({ proxyAllowedTargets: ["team.example.com:9443"] }, onDisk);
  assert.deepEqual(merged.proxyAllowedTargets, ["team.example.com:9443", "api.relay-demo.example:9443"]);
});
