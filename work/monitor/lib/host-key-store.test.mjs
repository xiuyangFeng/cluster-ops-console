import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildHostKeyArgs, parseFingerprints, parseKeyscanLines, resolveKnownHostsIfPresent } from "./host-key-policy.mjs";
import { createHostKeyStore } from "./host-key-store.mjs";
import { createServerRegistry } from "./server-registry.mjs";
import { writePersonalConfig } from "./config-loader.mjs";

test("buildHostKeyArgs: 生产默认 yes，可挂每服务器 known_hosts", () => {
  assert.deepEqual(buildHostKeyArgs(), ["-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no"]);
  const withFile = buildHostKeyArgs({ knownHostsPath: "/tmp/ssh/known_hosts-box" });
  assert.ok(withFile.includes("UserKnownHostsFile=/tmp/ssh/known_hosts-box"));
  assert.equal(withFile.includes("accept-new"), false);
});

test("host-key-store: 确认写入 0600，变化必须重新预览", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hostkey-"));
  const calls = [];
  const store = createHostKeyStore({
    dataDir: dir,
    execFileImpl: async (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts?.input });
      if (cmd === "ssh-keyscan") return { code: 0, stdout: "box.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest\n", stderr: "" };
      return { code: 0, stdout: "256 SHA256:abcd box.example (ED25519)\n", stderr: "" };
    },
  });
  const preview = await store.preview({ host: "box.example", sshPort: 22, serverId: "box" });
  assert.equal(preview.ok, true);
  assert.equal(preview.fingerprints[0].sha256, "SHA256:abcd");
  const saved = store.confirm("box", { linesHash: preview.linesHash });
  assert.equal(saved.ok, true);
  assert.equal(store.hasConfirmed("box"), true);
  assert.match(readFileSync(store.pathFor("box"), "utf8"), /ssh-ed25519/);
  assert.throws(() => store.confirm("box", { linesHash: "stale" }), /预览/);
  rmSync(dir, { recursive: true, force: true });
});

test("ServerRegistry: host-key 失败进入 hostkey-required，不把失败当可自动修复", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hostkey-reg-"));
  const localPath = path.join(dir, "local.json");
  let merged = { servers: [] };
  const store = createHostKeyStore({
    dataDir: dir,
    execFileImpl: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const registry = createServerRegistry({
    localConfigPath: localPath,
    writePersonalConfigImpl: writePersonalConfig,
    readPersonalConfigImpl: () => {
      try { return JSON.parse(readFileSync(localPath, "utf8")); } catch { return {}; }
    },
    getMergedConfig: () => merged,
    refreshConfigIntoKernel: async () => {
      try {
        const personal = JSON.parse(readFileSync(localPath, "utf8"));
        merged = { servers: (personal.servers || []).map((s) => ({ ...s, source: "personal" })) };
      } catch { merged = { servers: [] }; }
    },
    execFileImpl: async () => ({ code: 255, stdout: "", stderr: "Host key verification failed.", timedOut: false }),
    hostKeyStore: store,
  });
  const added = await registry.add({ address: "box.example", sshUser: "ubuntu", remotePort: 7896 });
  const result = await registry.testConnection(added.id);
  assert.equal(result.code, "hostkey");
  assert.equal(registry.list().servers.find((s) => s.id === added.id).state, "hostkey-required");
  rmSync(dir, { recursive: true, force: true });
});

test("host-key-store: 带 lines 被拒；hash 不匹配被拒；无预览被拒", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hostkey-deny-"));
  const store = createHostKeyStore({
    dataDir: dir,
    execFileImpl: async (cmd) => {
      if (cmd === "ssh-keyscan") return { code: 0, stdout: "box.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest\n", stderr: "" };
      return { code: 0, stdout: "256 SHA256:abcd box.example (ED25519)\n", stderr: "" };
    },
  });
  assert.throws(() => store.confirm("box", { linesHash: "abc" }), (err) => err.status === 400 && /预览/.test(err.message));
  const preview = await store.preview({ host: "box.example", sshPort: 22, serverId: "box" });
  assert.throws(
    () => store.confirm("box", { linesHash: preview.linesHash, lines: ["evil ssh-ed25519 AAAA"] }),
    (err) => err.status === 400 && err.code === "hostkey-lines-forbidden",
  );
  assert.throws(
    () => store.confirm("box", { linesHash: "deadbeefdeadbeefdeadbeef" }),
    (err) => err.status === 409 && err.code === "hostkey-mismatch",
  );
  const saved = store.confirm("box", { linesHash: preview.linesHash });
  assert.equal(saved.ok, true);
  assert.ok(resolveKnownHostsIfPresent(dir, "box"));
  rmSync(dir, { recursive: true, force: true });
});

test("parseKeyscanLines / parseFingerprints", () => {
  assert.deepEqual(parseKeyscanLines("# comment\nbox ssh-ed25519 AAAA\n"), ["box ssh-ed25519 AAAA"]);
  assert.equal(parseFingerprints("256 SHA256:abcd box (ED25519)\n")[0].type, "ED25519");
});
