import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeServerId,
  isAuthRef,
  isBoundedServerId,
  isSafeServerId,
  MAX_SERVER_ID_LENGTH,
} from "./validators.mjs";

test("validators: serverId 两种口径——不限长 vs 1–64，字符集同为 [\\w.-]", () => {
  const long = "a".repeat(MAX_SERVER_ID_LENGTH + 1);
  for (const ok of ["server-01", "a.b_c-d", "x".repeat(MAX_SERVER_ID_LENGTH)]) {
    assert.equal(isSafeServerId(ok), true, ok);
    assert.equal(isBoundedServerId(ok), true, ok);
  }
  assert.equal(isSafeServerId(long), true, "不限长口径接受超长 id");
  assert.equal(isBoundedServerId(long), false, "有界口径拒绝 65 字符 id");
  for (const bad of ["", "../x", "a/b", "a:b", "a b", "服务器", null, undefined, 42, {}]) {
    assert.equal(isSafeServerId(bad), false, String(bad));
    assert.equal(isBoundedServerId(bad), false, String(bad));
  }
});

test("validators: assertSafeServerId 先 String() 归一再校验，非法即抛且文案不变", () => {
  assert.equal(assertSafeServerId("server-01"), "server-01");
  assert.equal(assertSafeServerId(7), "7");
  assert.throws(() => assertSafeServerId("../x"), (err) => err.message === 'unsafe serverId: "../x"，只允许 [\\w.-] 字符');
  assert.throws(() => assertSafeServerId(null), /unsafe serverId: null/);
  assert.throws(() => assertSafeServerId(""), /unsafe serverId: ""/);
});

test("validators: authRef 只认 vault:/mem: 前缀加安全 id", () => {
  assert.equal(isAuthRef("vault:server-01"), true);
  assert.equal(isAuthRef("mem:abc.def"), true);
  for (const bad of ["vault:", "disk:x", "vault:a/b", "vault:a b", 1, null]) assert.equal(isAuthRef(bad), false, String(bad));
});
