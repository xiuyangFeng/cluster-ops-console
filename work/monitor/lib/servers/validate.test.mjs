// 服务器条目纯函数（从 server-registry 拆出）：校验 / 剥离凭据字段 / 列表投影。
import { test } from "node:test";
import assert from "node:assert/strict";

import { ConfigValidationError } from "../config-loader.mjs";
import { summarizeServer } from "./summary.mjs";
import { isOverrideOnly, sanitizeEntry, validateServerInput } from "./validate.mjs";

const SECRET_FIELDS = ["password", "sshPassword", "privateKey", "identityData", "validationProfile", "sshpass"];

test("validateServerInput: 明文凭据字段逐个报错，顺序固定", () => {
  const input = { address: "10.0.0.8", sshUser: "me" };
  for (const field of [...SECRET_FIELDS].reverse()) input[field] = "x";
  assert.throws(() => validateServerInput(input), (err) => {
    assert.ok(err instanceof ConfigValidationError);
    assert.deepEqual(err.errors.map((e) => e.field), SECRET_FIELDS);
    return true;
  });
});

test("validateServerInput: 注入 now 决定时间戳，缺 id 时由名称生成", () => {
  const value = validateServerInput({ name: "My Box", address: "10.0.0.8", sshUser: " me " }, { now: () => 0 });
  assert.equal(value.id, "my-box");
  assert.equal(value.sshUser, "me");
  assert.equal(value.sshPort, 22);
  assert.equal(value.tunnel, false, "新增默认仅监控");
  assert.equal(value.createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal(value.updatedAt, "1970-01-01T00:00:00.000Z");
});

test("validateServerInput: 旧条目身份未变时允许继续缺省 sshUser", () => {
  const legacy = { id: "old", host: "10.0.0.8", sshPort: 22 };
  assert.throws(() => validateServerInput({ address: "10.0.0.8" }), /独立 SSH 用户名/);
  assert.equal(validateServerInput({ id: "old", address: "10.0.0.8" }, { legacy }).id, "old");
  assert.throws(() => validateServerInput({ id: "old", address: "10.0.0.9" }, { legacy }), /独立 SSH 用户名/);
});

test("sanitizeEntry: 剥掉全部凭据字段，其余字段与顺序原样保留", () => {
  const raw = { id: "a", host: "h", tags: ["x"] };
  for (const field of SECRET_FIELDS) raw[field] = "secret";
  const out = sanitizeEntry(raw);
  assert.deepEqual(Object.keys(out), ["id", "host", "tags"]);
  assert.equal(raw.password, "secret", "不改入参");
  assert.equal(sanitizeEntry(null), null);
});

test("isOverrideOnly: 没有 host/address 的条目才是覆盖层", () => {
  assert.ok(isOverrideOnly({ id: "server-01", disabled: true }));
  assert.equal(isOverrideOnly({ id: "a", host: "h" }), false);
  assert.equal(isOverrideOnly({ id: "a", address: "h" }), false);
});

test("summarizeServer: 凭据只投影成 authMethod，不回传引用", () => {
  const base = { id: "a", host: "h" };
  assert.equal(summarizeServer({ ...base, authRef: "vault:1" }).authMethod, "keychain");
  assert.equal(summarizeServer({ ...base, authRef: "mem:1" }).authMethod, "session-password");
  assert.equal(summarizeServer({ ...base, sshIdentityFile: "/k" }).authMethod, "identity-file");
  const plain = summarizeServer(base, { runtime: { state: "online" }, revision: 3 });
  assert.equal(plain.authMethod, "agent");
  assert.equal(plain.state, "online");
  assert.equal(plain.revision, 3);
  assert.equal("authRef" in plain, false);
  assert.equal(summarizeServer({ ...base, disabled: true }, { runtime: { state: "online" } }).state, "disabled");
});
