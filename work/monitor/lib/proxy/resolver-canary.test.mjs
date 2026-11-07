// 本机解析器健康金丝雀：懒触发、结论缓存、同一时刻只跑一次、超出预算 / 抛错按失败。全部注入，不碰真实 DNS。
import assert from "node:assert/strict";
import test from "node:test";

import { canaryResolveFromLookup, createResolverCanary, RESOLVER_CANARY_HOST } from "./resolver-canary.mjs";

test("isHealthy：探测固定公网域；结论缓存 intervalMs，过期才重探；并发调用共用一次探测", async () => {
  let clock = 1000;
  const probes = [];
  let answer = "ok";
  const canary = createResolverCanary({
    resolve: async (host) => {
      probes.push(host);
      if (answer !== "ok") throw new Error(answer);
    },
    intervalMs: 60_000,
    now: () => clock,
  });
  const [a, b] = await Promise.all([canary.isHealthy(), canary.isHealthy()]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.deepEqual(probes, [RESOLVER_CANARY_HOST], "缺省探 api.openai.com，并发只探一次");

  answer = "ENOTFOUND";
  clock += 59_000;
  assert.equal(await canary.isHealthy(), true, "缓存期内沿用上次结论");
  assert.equal(probes.length, 1);
  clock += 2000;
  assert.equal(await canary.isHealthy(), false, "过期重探：本机 DNS 挂了");
  assert.equal(probes.length, 2);
});

test("isHealthy：探测超出预算按失败，同步抛错按失败，永不 reject", async () => {
  const hanging = createResolverCanary({ resolve: () => new Promise(() => {}), budgetMs: 20 });
  assert.equal(await hanging.isHealthy(), false);
  const throwing = createResolverCanary({ resolve: () => { throw new Error("boom"); } });
  assert.equal(await throwing.isHealthy(), false);
  const custom = [];
  const named = createResolverCanary({ host: "canary.example", resolve: async (h) => custom.push(h) });
  assert.equal(await named.isHealthy(), true);
  assert.deepEqual(custom, ["canary.example"], "金丝雀域名可注入");
});

test("canaryResolveFromLookup：dns.lookup 兼容函数成功即健康，空结果 / 错误为失败", async () => {
  const ok = canaryResolveFromLookup((_h, _o, cb) => cb(null, [{ address: "1.2.3.4", family: 4 }]));
  await ok("x");
  const empty = canaryResolveFromLookup((_h, _o, cb) => cb(null, []));
  await assert.rejects(empty("x"));
  const failing = canaryResolveFromLookup((_h, _o, cb) => cb(new Error("ENOTFOUND")));
  await assert.rejects(failing("x"));
});
