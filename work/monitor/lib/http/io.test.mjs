import assert from "node:assert/strict";
import test from "node:test";

import { isJsonObject, numberParam, readRequiredBody, respondOrError, sendErrorMessage, sendRegistryError } from "./io.mjs";
import { firstMatch, routeTable } from "./route-kit.mjs";

function makeRes() {
  return {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body === undefined ? undefined : JSON.parse(body);
    },
  };
}

function bodyOf(...chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

test("numberParam：缺失/空串走 fallback，其余一律 Number()（NaN 原样交给调用方）", () => {
  const params = new URLSearchParams("a=5&b=&c=abc&d=0");
  assert.equal(numberParam(params, "a"), 5);
  assert.equal(numberParam(params, "b"), undefined);
  assert.equal(numberParam(params, "b", null), null);
  assert.ok(Number.isNaN(numberParam(params, "c")));
  assert.equal(numberParam(params, "d", 99), 0);
  assert.equal(numberParam(params, "missing", 7), 7);
});

test("isJsonObject：只认非 null、非数组的对象", () => {
  assert.equal(isJsonObject({}), true);
  for (const value of [null, undefined, [], "x", 1, true]) assert.equal(isJsonObject(value), false);
});

test("readRequiredBody：null 正文回 400 invalid request body；数组等照样放行", async () => {
  const bad = makeRes();
  assert.equal(await readRequiredBody(bodyOf("{broken"), bad), null);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: "invalid request body" });

  const literalNull = makeRes();
  assert.equal(await readRequiredBody(bodyOf("null"), literalNull), null);
  assert.equal(literalNull.status, 400);

  const array = makeRes();
  assert.deepEqual(await readRequiredBody(bodyOf("[1]"), array), [1]);
  assert.equal(array.status, undefined, "未写响应");
});

test("错误形状：运行器只有 { error }，注册表带 { code, errors }；状态码缺省 400", () => {
  const withStatus = Object.assign(new Error("冲突"), { status: 409, code: "c", errors: ["e"] });
  const plain = new Error("坏了");

  const runner = makeRes();
  sendErrorMessage(runner, withStatus);
  assert.equal(runner.status, 409);
  assert.deepEqual(runner.body, { error: "冲突" });
  const forced = makeRes();
  sendErrorMessage(forced, withStatus, 404);
  assert.equal(forced.status, 404);
  const fallback = makeRes();
  sendErrorMessage(fallback, plain);
  assert.equal(fallback.status, 400);

  const registry = makeRes();
  sendRegistryError(registry, withStatus);
  assert.equal(registry.status, 409);
  assert.deepEqual(registry.body, { error: "冲突", code: "c", errors: ["e"] });
  const registryPlain = makeRes();
  sendRegistryError(registryPlain, plain);
  assert.equal(registryPlain.status, 400);
  assert.deepEqual(registryPlain.body, { error: "坏了" });
});

test("respondOrError：透传 work 返回值；抛错时按 onError 回响应并返回 true", async () => {
  const res = makeRes();
  assert.equal(await respondOrError(res, async () => false), false);
  assert.equal(await respondOrError(res, async () => {
    throw Object.assign(new Error("x"), { status: 418 });
  }), true);
  assert.equal(res.status, 418);
  const custom = [];
  await respondOrError(res, async () => {
    throw new Error("y");
  }, (_res, error) => custom.push(error.message));
  assert.deepEqual(custom, ["y"]);
});

test("routeTable / firstMatch：精确匹配方法+路径，第一个接住的组终止", async () => {
  const seen = [];
  const table = routeTable({ "GET /a": () => seen.push("a") });
  const fallback = async () => {
    seen.push("fallback");
    return true;
  };
  const routes = firstMatch(table, fallback);
  const ctx = (method, pathname) => ({ req: { method }, url: { pathname } });

  assert.equal(await routes(ctx("GET", "/a")), true);
  assert.equal(await routes(ctx("POST", "/a")), true);
  assert.equal(await routes(ctx("GET", "/a/")), true);
  assert.deepEqual(seen, ["a", "fallback", "fallback"]);
  assert.equal(await firstMatch(table)(ctx("GET", "/b")), false);
});
