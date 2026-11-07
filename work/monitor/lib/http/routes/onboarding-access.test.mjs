import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { statusError } from "../../status-error.mjs";
import { createOnboardingAccessRoutes } from "./onboarding-access.mjs";

async function call(route, method, path, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  req.method = method;
  const res = {
    writeHead(code) {
      this.status = code;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
    },
  };
  const handled = await route({ req, res, url: new URL(`http://127.0.0.1${path}`) });
  return { handled, status: res.status, body: res.body };
}

const VIEW = { available: true, port: 7893, registry: { ports: [] }, busy: null, undo: null };

test("/api/onboarding/access*：读带 fresh；三个动作把正文里认得的字段交给服务", async () => {
  const calls = [];
  const record = (name, reply) => (arg) => {
    calls.push([name, arg]);
    return reply;
  };
  const route = createOnboardingAccessRoutes({
    accessManager: {
      getAccess: record("get", VIEW),
      releasePort: record("release", { port: 7895, result: "ok", access: VIEW }),
      previewUndo: record("preview", { preview: { previewId: "p1" }, access: VIEW }),
      runUndo: record("run", { access: VIEW }),
    },
  });
  assert.deepEqual(await call(route, "GET", "/api/onboarding/access"), { handled: true, status: 200, body: VIEW });
  await call(route, "GET", "/api/onboarding/access?fresh=1");
  assert.equal((await call(route, "POST", "/api/onboarding/access/release-port", { port: 7895, serverId: "server-01", extra: "ignored" })).body.result, "ok");
  assert.equal((await call(route, "POST", "/api/onboarding/access/undo/preview", {})).body.preview.previewId, "p1");
  await call(route, "POST", "/api/onboarding/access/undo/run", { previewId: "p1", releasePort: true, serverId: "server-01" });
  // 只有明确的 true 才释放端口：漏传、字符串、数字一律按保留
  await call(route, "POST", "/api/onboarding/access/undo/run", { previewId: "p1" });
  await call(route, "POST", "/api/onboarding/access/undo/run", { previewId: "p1", releasePort: "true" });
  await call(route, "POST", "/api/onboarding/access/undo/run", { previewId: "p1", releasePort: 1 });
  assert.deepEqual(calls, [
    ["get", { fresh: false }],
    ["get", { fresh: true }],
    ["release", { serverId: "server-01", port: 7895 }],
    ["preview", { serverId: null }],
    ["run", { serverId: "server-01", previewId: "p1", releasePort: true }],
    ["run", { serverId: null, previewId: "p1", releasePort: false }],
    ["run", { serverId: null, previewId: "p1", releasePort: false }],
    ["run", { serverId: null, previewId: "p1", releasePort: false }],
  ]);
});

test("/api/onboarding/access*：服务抛的错带上状态码 / code / busy；没有状态码的按 500", async () => {
  const route = createOnboardingAccessRoutes({
    accessManager: {
      getAccess: () => { throw new Error("boom"); },
      releasePort: () => { throw statusError("端口 7893 是这台电脑在用的，不能单独释放；要释放它请用「撤销接入」", 409, { code: "port-in-use" }); },
      previewUndo: () => { throw statusError("读不到集群上现在的配置", 502, { code: "survey-failed" }); },
      runUndo: () => { throw statusError("这台服务器上正在进行 codex 的安装 / 更新，请等它结束再试", 409, { code: "busy", busy: { kind: "install", cli: "codex" } }); },
    },
  });
  assert.deepEqual(await call(route, "GET", "/api/onboarding/access"), { handled: true, status: 500, body: { error: "boom" } });
  assert.deepEqual(await call(route, "POST", "/api/onboarding/access/release-port", { port: 7893 }), {
    handled: true, status: 409, body: { error: "端口 7893 是这台电脑在用的，不能单独释放；要释放它请用「撤销接入」", code: "port-in-use" },
  });
  assert.deepEqual((await call(route, "POST", "/api/onboarding/access/undo/preview", {})).status, 502);
  const busy = await call(route, "POST", "/api/onboarding/access/undo/run", { previewId: "p1" });
  assert.deepEqual([busy.status, busy.body.code, busy.body.busy], [409, "busy", { kind: "install", cli: "codex" }]);
});

test("/api/onboarding/access*：正文不是对象 / serverId 不合法 400，不调服务；不认识的路径与方法不接", async () => {
  let touched = 0;
  const touch = () => {
    touched += 1;
    return {};
  };
  const route = createOnboardingAccessRoutes({ accessManager: { getAccess: touch, releasePort: touch, previewUndo: touch, runUndo: touch } });
  assert.equal((await call(route, "POST", "/api/onboarding/access/undo/run", "[1]")).status, 400);
  assert.equal((await call(route, "POST", "/api/onboarding/access/undo/run")).status, 400);
  assert.equal((await call(route, "POST", "/api/onboarding/access/release-port", "not json")).status, 400);
  assert.equal((await call(route, "POST", "/api/onboarding/access/undo/preview", { serverId: "../etc" })).status, 400);
  assert.equal((await call(route, "POST", "/api/onboarding/access/undo/preview", { serverId: 7 })).status, 400);
  assert.equal(touched, 0);
  assert.equal((await call(route, "POST", "/api/onboarding/access", {})).handled, false);
  assert.equal((await call(route, "GET", "/api/onboarding/access/undo/run")).handled, false);
  assert.equal((await call(route, "POST", "/api/onboarding/access/undo", {})).handled, false);
  assert.equal((await call(route, "DELETE", "/api/onboarding/access/release-port", {})).handled, false);
  assert.equal((await call(route, "GET", "/api/onboarding")).handled, false, "接入引导自己的路由不归这一组");
});

test("/api/onboarding/access*：服务没装配时 503", async () => {
  const route = createOnboardingAccessRoutes({ accessManager: null });
  assert.equal((await call(route, "GET", "/api/onboarding/access")).status, 503);
  assert.equal((await call(route, "POST", "/api/onboarding/access/undo/run", { previewId: "p1" })).status, 503);
});
