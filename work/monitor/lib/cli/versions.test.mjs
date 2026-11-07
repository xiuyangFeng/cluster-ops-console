import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, isUpdateAvailable } from "./catalog.mjs";
import { createCliVersionsService, distTagsUrl, LATEST_RETRY_MS, LATEST_TTL_MS, pickLatest } from "./versions.mjs";

test("distTagsUrl：作用域包的 / 编码成 %2F", () => {
  assert.equal(distTagsUrl("@openai/codex"), "https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags");
  assert.equal(distTagsUrl("@anthropic-ai/claude-code"), "https://registry.npmjs.org/-/package/@anthropic-ai%2Fclaude-code/dist-tags");
});

test("pickLatest：只认合法版本号（2026-10-07 实测的 dist-tags 形状）", () => {
  assert.equal(pickLatest({ latest: "0.160.1", "linux-x64": "0.160.1-linux-x64", alpha: "0.162.0-alpha.18" }), "0.160.1");
  assert.equal(pickLatest({ stable: "2.1.285", latest: "2.1.292" }), "2.1.292");
  assert.equal(pickLatest({ latest: "1.0; rm -rf ~" }), null);
  assert.equal(pickLatest(null), null);
});

test("compareVersions：数字逐段比、预发布低于正式版、非法 → null", () => {
  assert.equal(compareVersions("0.160.1", "0.159.2"), 1);
  assert.equal(compareVersions("0.159.10", "0.159.9"), 1);
  assert.equal(compareVersions("2.1.292", "2.1.292"), 0);
  assert.equal(compareVersions("0.161.0-alpha.1", "0.161.0"), -1);
  assert.equal(compareVersions("0.161.0-alpha.10", "0.161.0-alpha.9"), 1);
  assert.equal(compareVersions("0.161.0-alpha.1", "0.161.0-alpha"), 1);
  assert.equal(compareVersions("x", "1.0.0"), null);
  assert.equal(isUpdateAvailable("0.159.2", "0.160.1"), true);
  assert.equal(isUpdateAvailable("0.160.1", "0.160.1"), false);
  assert.equal(isUpdateAvailable(null, "0.160.1"), false);
});

test("版本服务：6 小时内复用缓存；过期后台刷新；经注入的上游取", async () => {
  let t = 1000;
  const calls = [];
  const svc = createCliVersionsService({
    now: () => t,
    getUpstream: async () => ({ host: "127.0.0.1", port: 7890 }),
    fetchJson: async (url, opts) => {
      calls.push([url, opts.upstream?.port]);
      return url.includes("codex") ? { latest: "0.160.1" } : { latest: "2.1.292", stable: "2.1.285" };
    },
  });
  const first = await svc.getLatest();
  assert.equal(first.codex.latest, "0.160.1");
  assert.equal(first.claude.latest, "2.1.292");
  assert.deepEqual(calls.map((c) => c[1]), [7890, 7890]);
  t += LATEST_TTL_MS - 1;
  await svc.getLatest();
  assert.equal(calls.length, 2, "缓存未过期不再取");
  t += 2;
  const stale = await svc.getLatest();
  assert.equal(stale.codex.latest, "0.160.1", "过期时先回旧值");
  await svc.refresh();
  assert.ok(calls.length >= 4);
});

test("版本服务：取失败时保留上次成功的值并标错误；10 分钟内不重试", async () => {
  let t = 0;
  let fail = false;
  let n = 0;
  const svc = createCliVersionsService({
    now: () => t,
    fetchJson: async () => {
      n += 1;
      if (fail) throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      return { latest: "1.2.3" };
    },
  });
  await svc.getLatest();
  fail = true;
  t += LATEST_TTL_MS;
  await svc.refresh();
  const view = await svc.getLatest({ wait: false });
  assert.equal(view.codex.latest, "1.2.3");
  assert.match(view.codex.error, /ENOTFOUND/);
  const before = n;
  t += LATEST_RETRY_MS - 1;
  await svc.getLatest();
  assert.equal(n, before, "退避期内不重试");
});

test("版本服务：首次取超过等待上限 → 先回 null，不卡界面", async () => {
  const svc = createCliVersionsService({ fetchJson: () => new Promise(() => {}) });
  const view = await svc.getLatest({ waitMs: 20 });
  assert.equal(view.codex.latest, null);
});
