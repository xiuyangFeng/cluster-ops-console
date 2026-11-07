import assert from "node:assert/strict";
import test from "node:test";

import { fetchLatestRelease, githubRepoOf, isNewerVersion, releaseVersionOf } from "./release-check.mjs";

test("githubRepoOf：package.json 的 repository 常见写法 → owner/name；别的托管或写坏 → null", () => {
  assert.equal(githubRepoOf({ repository: { type: "git", url: "https://github.com/a-b/c.d-e.git" } }), "a-b/c.d-e");
  assert.equal(githubRepoOf({ repository: "github:a/b" }), "a/b");
  assert.equal(githubRepoOf({ repository: { url: "git+https://github.com/a/b.git" } }), "a/b");
  assert.equal(githubRepoOf({ repository: { url: "git@github.com:a/b.git" } }), "a/b");
  for (const repository of [undefined, "", "https://gitlab.com/a/b.git", "https://github.com/a", "https://github.com/a/b/c", { url: 3 }]) {
    assert.equal(githubRepoOf({ repository }), null, JSON.stringify(repository));
  }
});

test("版本比较：只认 x.y.z 正式版，预发布与读不懂的不算新版本", () => {
  assert.deepEqual(releaseVersionOf("v2.94.0"), [2, 94, 0]);
  assert.equal(releaseVersionOf("v2.94.0-rc.1"), null);
  assert.equal(isNewerVersion("v2.94.0", "2.93.2"), true);
  assert.equal(isNewerVersion("2.93.10", "2.93.9"), true);
  assert.equal(isNewerVersion("v2.93.2", "2.93.2"), false);
  assert.equal(isNewerVersion("v2.92.9", "2.93.2"), false);
  assert.equal(isNewerVersion("latest", "2.93.2"), false);
  assert.equal(isNewerVersion("v3.0.0", ""), false);
});

const reply = (status, body) => async (url, init) => {
  reply.last = { url, init };
  return { status, ok: status >= 200 && status < 300, json: async () => body };
};

test("fetchLatestRelease：正式版 → { version, url }；404（没有 Release / 私有仓库）、草稿、预发布 → null；其它状态码抛出", async () => {
  const ok = await fetchLatestRelease("a/b", { fetchImpl: reply(200, { tag_name: "v2.94.0", html_url: "https://github.com/a/b/releases/tag/v2.94.0" }) });
  assert.deepEqual(ok, { version: "2.94.0", url: "https://github.com/a/b/releases/tag/v2.94.0" });
  assert.equal(reply.last.url, "https://api.github.com/repos/a/b/releases/latest");
  assert.equal(reply.last.init.headers["User-Agent"], "codex-operations-console");
  const odd = await fetchLatestRelease("a/b", { fetchImpl: reply(200, { tag_name: "v2.94.0", html_url: "https://evil.example/x" }) });
  assert.equal(odd.url, "https://github.com/a/b/releases/latest", "页面地址不在本仓库下时改用固定的发布页");
  assert.equal(await fetchLatestRelease("a/b", { fetchImpl: reply(404, {}) }), null);
  assert.equal(await fetchLatestRelease("a/b", { fetchImpl: reply(200, { tag_name: "v3.0.0", prerelease: true }) }), null);
  assert.equal(await fetchLatestRelease("a/b", { fetchImpl: reply(200, { tag_name: "v3.0.0", draft: true }) }), null);
  assert.equal(await fetchLatestRelease("a/b", { fetchImpl: reply(200, { tag_name: "nightly" }) }), null);
  await assert.rejects(fetchLatestRelease("a/b", { fetchImpl: reply(403, {}) }), /403/);
  assert.equal(await fetchLatestRelease("../x", { fetchImpl: reply(200, {}) }), null, "仓库名不合法不发请求");
});
