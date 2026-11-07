import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig, loadLayeredConfig, writeActiveSelection, applyValidationPort, listEnabledServers, resolveTunnelTargets, resolveProxyPort } from "./config-loader.mjs";

const team = {
  activeServerId: "server-01",
  activeAgentId: "codex",
  agents: [{ id: "codex" }],
  servers: [{ id: "server-01", host: "myserver" }],
};

test("mergeConfig: local overrides personal fields, keeps team structure", () => {
  const merged = mergeConfig(team, { activeServerId: "server-tengxun", sshUser: "alice" });
  assert.equal(merged.activeServerId, "server-tengxun");
  assert.equal(merged.activeAgentId, "codex"); // local 未给 → 取 team
  assert.equal(merged.sshUser, "alice");
  assert.deepEqual(merged.servers, team.servers); // 结构恒取 team
});

test("mergeConfig: empty/blank local values fall back to team", () => {
  const merged = mergeConfig(team, { activeServerId: "", activeAgentId: null });
  assert.equal(merged.activeServerId, "server-01");
  assert.equal(merged.activeAgentId, "codex");
});

test("mergeConfig: no local layer is safe", () => {
  assert.equal(mergeConfig(team, undefined).activeServerId, "server-01");
});

test("loadLayeredConfig: merges team + local files via injected readFileSync", () => {
  const files = {
    "/team.json": JSON.stringify(team),
    "/local.json": JSON.stringify({ activeAgentId: "claude-codewing", sshUser: "bob" }),
  };
  const readFileSync = (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; };
  const merged = loadLayeredConfig({ configPath: "/team.json", localConfigPath: "/local.json", readFileSync });
  assert.equal(merged.activeAgentId, "claude-codewing");
  assert.equal(merged.sshUser, "bob");
  assert.equal(merged.activeServerId, "server-01");
});

test("loadLayeredConfig: missing local file → team only, no throw", () => {
  const readFileSync = (p) => { if (p === "/team.json") return JSON.stringify(team); throw new Error("ENOENT"); };
  const merged = loadLayeredConfig({ configPath: "/team.json", localConfigPath: "/nope.json", readFileSync });
  assert.equal(merged.activeServerId, "server-01");
});

test("loadLayeredConfig: private callback receives the same valid personal read without exposing tombstones in config", () => {
  const personal = { servers: [], _serverTombstones: [{ id: "removed", removedAt: 123, snapshot: { authRef: "vault:private" } }] };
  let captured;
  let personalReads = 0;
  const merged = loadLayeredConfig({
    configPath: "/team.json", localConfigPath: "/local.json",
    readFileSync: (file) => {
      // 只统计个人层的读取次数：用显式分支代替 `(personalReads++, JSON.stringify(personal))`
      // 这种逗号表达式——后者把"副作用计数"藏在返回值里，读起来要先找逗号。
      if (file !== "/team.json") personalReads += 1;
      return file === "/team.json" ? JSON.stringify(team) : JSON.stringify(personal);
    },
    onPersonalConfig: value => { captured = value; },
  });
  assert.equal(personalReads, 1);
  assert.deepEqual(captured, personal);
  assert.equal(merged._serverTombstones, undefined);
  assert.equal(JSON.stringify(merged).includes("vault:private"), false);
});

test("loadLayeredConfig: invalid personal objects never publish an authoritative callback", () => {
  for (const raw of ["{", "null", "[]", "42"]) {
    let callbacks = 0;
    const merged = loadLayeredConfig({
      configPath: "/team.json", localConfigPath: "/local.json",
      readFileSync: file => file === "/team.json" ? JSON.stringify(team) : raw,
      onLocalError: () => {}, onPersonalConfig: () => { callbacks++; },
    });
    assert.equal(merged._localConfigError, true);
    assert.equal(callbacks, 0);
  }
});

test("loadLayeredConfig: missing personal config publishes an empty valid layer; invalid team objects throw", () => {
  let captured;
  loadLayeredConfig({
    configPath: "/team.json", localConfigPath: "/local.json",
    readFileSync: file => { if (file === "/team.json") return JSON.stringify(team); throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    onPersonalConfig: value => { captured = value; },
  });
  assert.deepEqual(captured, {});
  for (const raw of ["null", "[]", "42", '{"servers":{}}', '{"servers":null}', '{"servers":[null]}', '{"servers":[{"id":"bad|id"}]}', '{"servers":[{"host":"missing-id.invalid"}]}']) {
    assert.throws(() => loadLayeredConfig({ configPath: "/team.json", readFileSync: () => raw }), /团队配置必须|团队服务器必须/);
  }
});

test("writeActiveSelection: only whitelisted fields persisted", () => {
  let written = null;
  const readFileSync = () => JSON.stringify({ sshUser: "bob" });
  const writeFileSync = (_p, body) => { written = JSON.parse(body); };
  const renameSync = () => {};
  const out = writeActiveSelection({
    localConfigPath: "/local.json",
    patch: { activeServerId: "server-02", evil: "x" },
    fs: { readFileSync, writeFileSync, renameSync, mkdirSync: () => {} },
  });
  assert.equal(written.activeServerId, "server-02");
  assert.equal(written.sshUser, "bob"); // 保留原有
  assert.equal("evil" in written, false); // 非白名单丢弃
  assert.equal(out.activeServerId, "server-02");
});

test("writeActiveSelection: atomic tmp+rename via injected fake fs", () => {
  const calls = [];
  const readFileSync = () => { throw new Error("ENOENT"); };
  const writeFileSync = (p, body) => calls.push({ op: "write", path: p, body });
  const renameSync = (from, to) => calls.push({ op: "rename", from, to });
  writeActiveSelection({
    localConfigPath: "/local.json",
    patch: { activeServerId: "server-03" },
    fs: { readFileSync, writeFileSync, renameSync, mkdirSync: () => {} },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].op, "write");
  assert.notEqual(calls[0].path, "/local.json"); // 先写临时文件，不是直接写目标文件
  assert.ok(calls[0].path.startsWith("/local.json.tmp."));
  assert.equal(calls[1].op, "rename");
  assert.equal(calls[1].from, calls[0].path);
  assert.equal(calls[1].to, "/local.json"); // 再 rename 到目标路径，实现原子替换
});

test("loadLayeredConfig: corrupted local config surfaces via onLocalError + _localConfigError, does not silently fall back", () => {
  const files = {
    "/team.json": JSON.stringify(team),
    "/local.json": "{bad json",
  };
  const readFileSync = (p) => { if (!(p in files)) { const e = new Error("ENOENT"); throw e; } return files[p]; };
  let captured = null;
  const onLocalError = (info) => { captured = info; };
  const merged = loadLayeredConfig({ configPath: "/team.json", localConfigPath: "/local.json", readFileSync, onLocalError });
  assert.ok(captured, "onLocalError 应被调用");
  assert.equal(captured.path, "/local.json");
  assert.ok(captured.error instanceof Error);
  assert.equal(merged._localConfigError, true);
  // 团队层字段仍在（可用），但标记必须存在，前端才能区分"干净的团队默认"和"个人层损坏后的团队默认"
  assert.equal(merged.activeServerId, "server-01");
});

test("loadLayeredConfig: missing local file stays silent, no onLocalError, no error flag", () => {
  let called = false;
  const readFileSync = (p) => { if (p === "/team.json") return JSON.stringify(team); const e = new Error("ENOENT"); throw e; };
  const onLocalError = () => { called = true; };
  const merged = loadLayeredConfig({ configPath: "/team.json", localConfigPath: "/nope.json", readFileSync, onLocalError });
  assert.equal(called, false);
  assert.equal("_localConfigError" in merged, false);
});

test("loadLayeredConfig: default onLocalError is console.warn (no throw) when not injected", () => {
  const files = { "/team.json": JSON.stringify(team), "/local.json": "{bad json" };
  const readFileSync = (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; };
  assert.doesNotThrow(() => {
    const merged = loadLayeredConfig({ configPath: "/team.json", localConfigPath: "/local.json", readFileSync });
    assert.equal(merged._localConfigError, true);
  });
});

test("mergeConfig: warns (via injected warn) on portOverrides serverId not matching any team server", () => {
  const team = { servers: [{ id: "server-01", remotePort: 7891 }] };
  const warnings = [];
  const merged = mergeConfig(team, { portOverrides: { "ghost-server": { remotePort: 9999 } } }, { warn: (msg) => warnings.push(msg) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ghost-server/);
  assert.equal(merged.servers[0].remotePort, 7891); // 未匹配的 override 不影响已有 server
});

test("mergeConfig: no warn call when all portOverrides serverIds match", () => {
  const team = { servers: [{ id: "server-01", remotePort: 7891 }] };
  const warnings = [];
  mergeConfig(team, { portOverrides: { "server-01": { remotePort: 7892 } } }, { warn: (msg) => warnings.push(msg) });
  assert.equal(warnings.length, 0);
});

test("mergeConfig applies portOverrides into matching server, deep-copies", () => {
  const team = { servers: [{ id: "server-01", remotePort: 7891, localPort: 8888 }, { id: "s2", remotePort: 7893 }] };
  const merged = mergeConfig(team, { portOverrides: { "server-01": { remotePort: 7892, localPort: 8892 } } });
  assert.equal(merged.servers.find(s => s.id === "server-01").remotePort, 7892);
  assert.equal(merged.servers.find(s => s.id === "server-01").localPort, 8892);
  assert.equal(merged.servers.find(s => s.id === "s2").remotePort, 7893);
  assert.equal(team.servers[0].remotePort, 7891); // team 未被原地改动
});
test("mergeConfig without portOverrides keeps team ports", () => {
  const team = { servers: [{ id: "server-01", remotePort: 7891 }] };
  assert.equal(mergeConfig(team, {}).servers[0].remotePort, 7891);
});
test("mergeConfig: proxyAllowedTargets 个人层在团队层基础上追加（append），而非像 PERSONAL_FIELDS 那样整体覆盖", () => {
  const team = { proxyAllowedTargets: ["api.relay-demo.example:9443"] };
  const merged = mergeConfig(team, { proxyAllowedTargets: ["my-own-api.example.com:9444"] });
  assert.deepEqual(merged.proxyAllowedTargets, ["api.relay-demo.example:9443", "my-own-api.example.com:9444"]);
  assert.deepEqual(team.proxyAllowedTargets, ["api.relay-demo.example:9443"]); // team 未被原地改动
});

test("mergeConfig: proxyAllowedTargets 只有团队层时原样保留；只有个人层时也生效", () => {
  const teamOnly = mergeConfig({ proxyAllowedTargets: ["a.example.com:9443"] }, {});
  assert.deepEqual(teamOnly.proxyAllowedTargets, ["a.example.com:9443"]);
  const localOnly = mergeConfig({}, { proxyAllowedTargets: ["b.example.com:9444"] });
  assert.deepEqual(localOnly.proxyAllowedTargets, ["b.example.com:9444"]);
});

test("mergeConfig: proxyAllowedTargets 双方都缺失时不注入字段（让下游走内置默认回落）", () => {
  const merged = mergeConfig({ servers: [] }, {});
  assert.equal("proxyAllowedTargets" in merged, false);
});

test("mergeConfig: 个人层 proxyAllowedTargets 类型不是数组时忽略并保留团队层", () => {
  const merged = mergeConfig(
    { proxyAllowedTargets: ["a.example.com:9443"] },
    { proxyAllowedTargets: "not-an-array" },
  );
  assert.deepEqual(merged.proxyAllowedTargets, ["a.example.com:9443"]);
});

test("applyValidationPort substitutes {{remotePort}}", () => {
  assert.equal(applyValidationPort({ remoteProxyTest: "curl -x http://127.0.0.1:{{remotePort}} u" }, 7892).remoteProxyTest,
    "curl -x http://127.0.0.1:7892 u");
  assert.equal(applyValidationPort(null, 7892), null);
});

// ---------------------------------------------------------------------------
// v2.18 个人服务器层：新增服务器 / 屏蔽团队条目 / 仅监控（tunnel:false）
// ---------------------------------------------------------------------------

const teamOne = { activeServerId: "server-01", servers: [{ id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }] };

test("mergeConfig: 个人层新增服务器进入合并结果，source=personal、tunnel 默认 true、缺 name 用 host", () => {
  const warnings = [];
  const merged = mergeConfig(teamOne, {
    servers: [{ id: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8890 }],
  }, { warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sshUser/);
  assert.equal(merged.servers.length, 2);
  const personal = merged.servers.find((s) => s.id === "server-tengxun");
  assert.equal(personal.source, "personal");
  assert.equal(personal.tunnel, true);
  assert.equal(personal.disabled, false);
  assert.equal(personal.name, "tengxunserver"); // 缺 name 回落 host
  assert.equal(personal.remotePort, 7893);
  const teamEntry = merged.servers.find((s) => s.id === "server-01");
  assert.equal(teamEntry.source, "team");
  assert.equal(teamEntry.disabled, false);
  assert.equal(teamEntry.tunnel, true);
  assert.equal(teamOne.servers.length, 1); // team 未被原地改动
  assert.equal("source" in teamOne.servers[0], false);
});

test("mergeConfig: 同 id 覆盖 remotePort/localPort/tunnel 生效", () => {
  const warnings = [];
  const merged = mergeConfig(teamOne, {
    servers: [{ id: "server-01", remotePort: 7899, localPort: 8899, tunnel: false }],
  }, { warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 0);
  assert.equal(merged.servers.length, 1);
  assert.equal(merged.servers[0].remotePort, 7899);
  assert.equal(merged.servers[0].localPort, 8899);
  assert.equal(merged.servers[0].tunnel, false);
  assert.equal(merged.servers[0].host, "myserver");
  assert.equal(merged.servers[0].source, "team"); // 端口覆盖不改变归属
});

test("mergeConfig: 同 id 覆盖 host/sshHostName/sshPort 被丢弃并 warn（防止把团队服务器改指到别处）", () => {
  const warnings = [];
  const merged = mergeConfig(teamOne, {
    servers: [{ id: "server-01", remotePort: 7899, host: "evil.example.com", sshHostName: "1.2.3.4", sshPort: 2222 }],
  }, { warn: (m) => warnings.push(m) });
  assert.equal(merged.servers[0].host, "myserver"); // 团队 host 不动
  assert.equal("sshHostName" in merged.servers[0], false);
  assert.equal("sshPort" in merged.servers[0], false);
  assert.equal(merged.servers[0].remotePort, 7899); // 白名单字段照常生效
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /server-01/);
  assert.match(warnings[0], /host/);
  assert.match(warnings[0], /sshHostName/);
  assert.match(warnings[0], /sshPort/);
});

test("mergeConfig + listEnabledServers/resolveTunnelTargets: disabled 条目留在数组但不进枚举与隧道", () => {
  const merged = mergeConfig(teamOne, { servers: [{ id: "server-01", disabled: true }] });
  assert.equal(merged.servers.length, 1); // 仍保留，前端要解释"已屏蔽"
  assert.equal(merged.servers[0].disabled, true);
  assert.deepEqual(listEnabledServers(merged), []);
  assert.deepEqual(resolveTunnelTargets(merged), []);
});

test("resolveTunnelTargets: tunnel:false 的条目进 listEnabledServers 但不建隧道", () => {
  const merged = mergeConfig(teamOne, {
    servers: [{ id: "server-aliyun", name: "阿里云", host: "vpn-aliyun", remotePort: 7894, localPort: 8891, tunnel: false }],
  });
  assert.deepEqual(listEnabledServers(merged).map((s) => s.id), ["server-01", "server-aliyun"]);
  assert.deepEqual(resolveTunnelTargets(merged).map((t) => t.serverId), ["server-01"]);
});

test("mergeConfig: 个人层新增条目缺 id/host/remotePort 时整条丢弃并 warn", () => {
  const warnings = [];
  const merged = mergeConfig(teamOne, {
    servers: [{ id: "no-host", remotePort: 7895 }, { id: "no-port", host: "somehost" }, { host: "no-id", remotePort: 7896 }],
  }, { warn: (m) => warnings.push(m) });
  assert.equal(merged.servers.length, 1);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /no-host/);
  assert.match(warnings[1], /no-port/);
});

test("mergeConfig: 个人层新增条目的 host/port 过 assertSafeHost/assertSafePort，注入形态被拒且不抛", () => {
  const warnings = [];
  let merged;
  assert.doesNotThrow(() => {
    merged = mergeConfig(teamOne, {
      servers: [
        { id: "bad-port", host: "okhost", remotePort: "7891; rm -rf /" },
        { id: "bad-host", host: "a b; touch /tmp/x", remotePort: 7897 },
        { id: "bad-local", host: "okhost", remotePort: 7898, localPort: "-oProxyCommand=x" },
      ],
    }, { warn: (m) => warnings.push(m) });
  });
  assert.deepEqual(merged.servers.map((s) => s.id), ["server-01"]);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /bad-port/);
  assert.match(warnings[1], /bad-host/);
  assert.match(warnings[2], /bad-local/);
});

test("mergeConfig: portOverrides 与个人层 servers 同 id 并存时 servers 后生效", () => {
  const merged = mergeConfig(teamOne, {
    portOverrides: { "server-01": { remotePort: 7892, localPort: 8892 } },
    servers: [{ id: "server-01", remotePort: 7896 }],
  });
  assert.equal(merged.servers[0].remotePort, 7896); // servers 覆盖赢
  assert.equal(merged.servers[0].localPort, 8892); // servers 未声明的字段仍由 portOverrides 决定
});

test("mergeConfig: 个人层 servers 不是数组时忽略并 warn（保留团队层）", () => {
  const warnings = [];
  const merged = mergeConfig(teamOne, { servers: "not-an-array" }, { warn: (m) => warnings.push(m) });
  assert.deepEqual(merged.servers.map((s) => s.id), ["server-01"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /servers/);
});

test("mergeConfig: 个人层 autoRepair / storageBudgetBytes 生效（hasValue 对对象与数字放行）", () => {
  const merged = mergeConfig(
    { autoRepair: { enabled: false }, storageBudgetBytes: 52428800, servers: [] },
    { autoRepair: { enabled: true, observeOnly: true }, storageBudgetBytes: 10485760 },
  );
  assert.deepEqual(merged.autoRepair, { enabled: true, observeOnly: true });
  assert.equal(merged.storageBudgetBytes, 10485760);
});

test("mergeConfig: 个人层空数组 servers 视为无值，团队层原样保留", () => {
  const warnings = [];
  const merged = mergeConfig(teamOne, { servers: [] }, { warn: (m) => warnings.push(m) });
  assert.deepEqual(merged.servers, teamOne.servers);
  assert.equal(warnings.length, 0);
});

test("resolveTunnelTargets: 输出形状带 serverId/host/端口/个人身份/source", () => {
  const merged = mergeConfig(teamOne, {
    sshUser: "kai",
    sshIdentityFile: "/Users/me/.ssh/id_codex",
    servers: [{ id: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8890 }],
  });
  assert.deepEqual(resolveTunnelTargets(merged), [
    { serverId: "server-01", host: "myserver", remotePort: 7891, localPort: 8888, sshUser: "kai", sshIdentityFile: "/Users/me/.ssh/id_codex", source: "team" },
    { serverId: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8890, sshUser: "kai", sshIdentityFile: "/Users/me/.ssh/id_codex", source: "personal" },
  ]);
});

test("resolveTunnelTargets: 团队层直接写坏的条目在这一层被再次拦下并 warn，不抛", () => {
  const warnings = [];
  const targets = resolveTunnelTargets(
    { servers: [{ id: "bad", host: "-oProxyCommand=x", remotePort: 7891 }, { id: "ok", host: "myserver", remotePort: 7891 }] },
    { warn: (m) => warnings.push(m) },
  );
  assert.deepEqual(targets.map((t) => t.serverId), ["ok"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bad/);
  assert.equal(targets[0].source, "team"); // 未打标的条目按团队条目解释
});

test("resolveProxyPort: 取活跃服务器 localPort，依次回落 server-01 / 第一条 / 8888", () => {
  const servers = [{ id: "server-01", localPort: 8888 }, { id: "server-tengxun", localPort: 8890 }];
  assert.equal(resolveProxyPort({ activeServerId: "server-tengxun", servers }), 8890);
  assert.equal(resolveProxyPort({ activeServerId: "ghost", servers }), 8888); // 回落 server-01
  assert.equal(resolveProxyPort({ activeServerId: "ghost", servers: [{ id: "only", localPort: 8891 }] }), 8891); // 回落第一条
  assert.equal(resolveProxyPort({ servers: [{ id: "only" }] }), 8888); // 无 localPort → 缺省
  assert.equal(resolveProxyPort({}), 8888);
  assert.equal(resolveProxyPort({ servers: [{ id: "only", localPort: "8890" }] }), 8890); // 返回整数
});

test("listEnabledServers: 非数组 / 缺失 servers 时返回空数组，不抛", () => {
  assert.deepEqual(listEnabledServers({}), []);
  assert.deepEqual(listEnabledServers({ servers: "x" }), []);
  assert.deepEqual(listEnabledServers(undefined), []);
});

test("writeActiveSelection: patch 含 servers/autoRepair/storageBudgetBytes 时忽略（控制台只读）", () => {
  let written = null;
  const readFileSync = () => JSON.stringify({ servers: [{ id: "server-tengxun" }] });
  const writeFileSync = (_p, body) => { written = JSON.parse(body); };
  const renameSync = () => {};
  writeActiveSelection({
    localConfigPath: "/local.json",
    patch: {
      activeServerId: "server-02",
      servers: [{ id: "evil", host: "evil.example.com" }],
      autoRepair: { enabled: false },
      storageBudgetBytes: 1,
    },
    fs: { readFileSync, writeFileSync, renameSync, mkdirSync: () => {} },
  });
  assert.equal(written.activeServerId, "server-02");
  assert.deepEqual(written.servers, [{ id: "server-tengxun" }]); // 手编内容原样保留，未被 patch 覆盖
  assert.equal("autoRepair" in written, false);
  assert.equal("storageBudgetBytes" in written, false);
});

test("writeActiveSelection: 向导写入的 sshUser/sshIdentityFile/portOverrides 仍然落盘", () => {
  let written = null;
  const readFileSync = () => { throw new Error("ENOENT"); };
  const writeFileSync = (_p, body) => { written = JSON.parse(body); };
  const renameSync = () => {};
  writeActiveSelection({
    localConfigPath: "/local.json",
    patch: { activeServerId: "server-01", sshUser: "kai", sshIdentityFile: "/tmp/id", portOverrides: { "server-01": { remotePort: 7892 } } },
    fs: { readFileSync, writeFileSync, renameSync, mkdirSync: () => {} },
  });
  assert.equal(written.sshUser, "kai");
  assert.equal(written.sshIdentityFile, "/tmp/id");
  assert.deepEqual(written.portOverrides, { "server-01": { remotePort: 7892 } });
});

test("resolveTunnelTargets: 条目自带的合法 sshUser/sshIdentityFile 优先于全局个人字段", () => {
  // 个人服务器可能在另一个集群、另一个用户名、另一把钥匙上。
  const merged = mergeConfig(
    { servers: [{ id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }] },
    {
      sshUser: "kai",
      sshIdentityFile: "/Users/me/.ssh/id_codex",
      servers: [{
        id: "server-tengxun", host: "tengxunserver", remotePort: 7893,
        sshUser: "ubuntu", sshIdentityFile: "/Users/me/.ssh/id_tengxun",
      }],
    },
  );
  const targets = resolveTunnelTargets(merged);
  assert.equal(targets[0].sshUser, "kai", "没写自己身份的团队条目仍用全局个人字段");
  assert.equal(targets[0].sshIdentityFile, "/Users/me/.ssh/id_codex");
  assert.equal(targets[1].sshUser, "ubuntu");
  assert.equal(targets[1].sshIdentityFile, "/Users/me/.ssh/id_tengxun");
});

test("resolveTunnelTargets: 条目自带的 sshUser 非法时回落全局，绝不把非法值送进 -l", () => {
  const merged = mergeConfig(
    { servers: [] },
    {
      sshUser: "kai",
      servers: [{ id: "server-tengxun", host: "tengxunserver", remotePort: 7893, sshUser: "-oProxyCommand=evil" }],
    },
  );
  const targets = resolveTunnelTargets(merged);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].sshUser, "kai");
});

// ---- v2.18：服务器 id 字符集（派生注册表/pid 文件名，Windows 文件名也要合法）----
test("mergeConfig: 个人层 address/sshPort 生效，validationProfile 被丢弃", () => {
  const warnings = [];
  const merged = mergeConfig(teamOne, {
    servers: [{
      id: "box",
      address: "10.0.0.8",
      remotePort: 7895,
      sshPort: 2222,
      sshUser: "ubuntu",
      validationProfile: { remoteProxyTest: "id" },
      password: "secret",
    }],
  }, { warn: (m) => warnings.push(m) });
  const personal = merged.servers.find((s) => s.id === "box");
  assert.equal(personal.host, "10.0.0.8");
  assert.equal(personal.address, "10.0.0.8");
  assert.equal(personal.sshPort, 2222);
  assert.equal(personal.sshUser, "ubuntu");
  assert.equal("validationProfile" in personal, false);
  assert.equal("password" in personal, false);
  assert.ok(warnings.some((m) => /validationProfile|password/.test(m)));
  const targets = resolveTunnelTargets(merged);
  const box = targets.find((t) => t.serverId === "box");
  assert.equal(box.sshPort, 2222);
  assert.equal(box.sshUser, "ubuntu");
});

test("个人层 servers 的 id 含非法字符时整条丢弃并 warn；resolveTunnelTargets 跳过非法 id", () => {
  const warns = [];
  const merged = mergeConfig(
    { servers: [{ id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }] },
    { servers: [{ id: "../evil", host: "h1", remotePort: 7893 }, { id: "ok.id-1", host: "h2", remotePort: 7894 }] },
    { warn: (m) => warns.push(m) },
  );
  assert.deepEqual(merged.servers.map((s) => s.id), ["server-01", "ok.id-1"]);
  assert.ok(warns.some((m) => m.includes("非法字符")));
  const bad = { ...merged, servers: [...merged.servers, { id: "x:y", host: "h3", remotePort: 7895 }] };
  const targets = resolveTunnelTargets(bad, { warn: (m) => warns.push(m) });
  assert.deepEqual(targets.map((t) => t.serverId), ["server-01", "ok.id-1"]);
});
