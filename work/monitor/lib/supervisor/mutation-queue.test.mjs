import { test } from "node:test";
import assert from "node:assert/strict";

import { createMutationQueue } from "./mutation-queue.mjs";

test("createMutationQueue: 严格串行——后到的动作等前一个落地才开始", async () => {
  const serialize = createMutationQueue();
  const order = [];
  let releaseFirst;
  const first = serialize(async () => {
    order.push("first:start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    order.push("first:end");
    return 1;
  });
  const second = serialize(async () => {
    order.push("second:start");
    return 2;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start"], "第一个没结束前第二个不得开始");
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});

test("createMutationQueue: 前一个失败不阻断后一个，异常只抛给它自己的调用方", async () => {
  const serialize = createMutationQueue();
  const failing = serialize(async () => { throw new Error("boom"); });
  const next = serialize(async () => "ok");
  await assert.rejects(failing, /boom/);
  assert.equal(await next, "ok");
});

test("createMutationQueue: 每个实例一条独立队列", async () => {
  const a = createMutationQueue();
  const b = createMutationQueue();
  let releaseA;
  const blocked = a(() => new Promise((resolve) => { releaseA = resolve; }));
  assert.equal(await b(async () => "b-ran"), "b-ran", "另一实例的队列不受阻塞");
  releaseA();
  await blocked;
});
