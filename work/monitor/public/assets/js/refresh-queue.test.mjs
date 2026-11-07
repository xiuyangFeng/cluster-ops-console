import assert from "node:assert/strict";
import test from "node:test";
import { createRefreshQueue } from "./refresh-queue.js";

function harness() {
  const requests = [], committed = [], errors = [];
  const refresh = createRefreshQueue({
    load: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    commit: value => committed.push(value),
    onError: error => errors.push(error.message),
  });
  return { refresh, requests, committed, errors };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("routine refreshes share one request and return only after rendering", async () => {
  const h = harness();
  const first = h.refresh();
  assert.equal(h.refresh(), first);
  await tick();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve("current");
  await first;
  assert.deepEqual(h.committed, ["current"]);
});

test("delete/restore refresh invalidates an in-flight snapshot and awaits the replacement", async () => {
  const h = harness();
  const previousRead = h.refresh();
  await tick();
  const afterDelete = h.refresh({ force: true });
  h.refresh({ force: true });
  h.requests[0].resolve({ incidents: ["deleted-server"], servers: ["deleted-server"] });
  await tick();
  assert.deepEqual(h.committed, []);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ incidents: [], servers: [] });
  await Promise.all([previousRead, afterDelete]);
  assert.deepEqual(h.committed, [{ incidents: [], servers: [] }]);
  const afterRestore = h.refresh({ force: true });
  await tick();
  h.requests[2].resolve({ incidents: ["restored"], servers: ["restored"] });
  await afterRestore;
  assert.equal(h.committed.at(-1).servers[0], "restored");
});

test("a failed invalidated request does not prevent the post-mutation refresh", async () => {
  const h = harness();
  h.refresh(); await tick();
  const changed = h.refresh({ force: true });
  h.requests[0].reject(new Error("old request failed"));
  await tick();
  h.requests[1].resolve("fresh"); await changed;
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.committed, ["fresh"]);
});
