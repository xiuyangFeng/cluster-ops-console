import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { statusError } from "../../status-error.mjs";
import { createOnboardingRoutes } from "./onboarding.mjs";

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

const STATE = { phase: "idle", steps: [] };

test("/api/onboarding*：读状态；各动作把正文交给服务并回最新状态", async () => {
  const calls = [];
  const record = (name) => (arg) => {
    calls.push([name, arg]);
    return { ...STATE, phase: name };
  };
  const route = createOnboardingRoutes({
    onboardingGuide: { getState: () => STATE, start: record("start"), answer: record("answer"), retry: record("retry"), setDismissed: record("dismiss"), reset: record("reset") },
  });
  assert.deepEqual(await call(route, "GET", "/api/onboarding"), { handled: true, status: 200, body: STATE });
  assert.equal((await call(route, "POST", "/api/onboarding/start", { sshUser: "amy", password: "p" })).body.phase, "start");
  await call(route, "POST", "/api/onboarding/answer", { kind: "hostkey", accept: true, linesHash: "h" });
  await call(route, "POST", "/api/onboarding/retry", {});
  await call(route, "POST", "/api/onboarding/retry", { step: "egress" });
  await call(route, "POST", "/api/onboarding/dismiss", {});
  await call(route, "POST", "/api/onboarding/dismiss", { dismissed: false });
  await call(route, "POST", "/api/onboarding/reset", {});
  assert.deepEqual(calls, [
    ["start", { sshUser: "amy", password: "p" }],
    ["answer", { kind: "hostkey", accept: true, linesHash: "h" }],
    ["retry", { step: null }],
    ["retry", { step: "egress" }],
    ["dismiss", true],
    ["dismiss", false],
    ["reset", undefined],
  ]);
});

test("/api/onboarding*：服务抛的错带上状态码 / code / field；正文不是对象 400；不认识的路径不接", async () => {
  const route = createOnboardingRoutes({
    onboardingGuide: {
      getState: () => STATE,
      start: () => { throw statusError("请填写集群用户名", 400, { code: "form", field: "sshUser" }); },
      answer: () => { throw statusError("引导正在执行上一步，请稍候", 409, { code: "busy" }); },
      retry: () => { throw new Error("boom"); },
    },
  });
  assert.deepEqual(await call(route, "POST", "/api/onboarding/start", {}), { handled: true, status: 400, body: { error: "请填写集群用户名", code: "form", field: "sshUser" } });
  const busy = await call(route, "POST", "/api/onboarding/answer", { kind: "password" });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, "busy");
  assert.equal((await call(route, "POST", "/api/onboarding/retry", {})).status, 500);
  assert.equal((await call(route, "POST", "/api/onboarding/start", "[1]")).status, 400);
  assert.equal((await call(route, "POST", "/api/onboarding/start")).status, 400);
  assert.equal((await call(route, "POST", "/api/onboarding/nope", {})).handled, false);
  assert.equal((await call(route, "GET", "/api/onboarding/start")).handled, false);
});

test("/api/onboarding*：服务没装配时 503", async () => {
  const route = createOnboardingRoutes({ onboardingGuide: null });
  assert.equal((await call(route, "GET", "/api/onboarding")).status, 503);
  assert.equal((await call(route, "POST", "/api/onboarding/start", { sshUser: "amy" })).status, 503);
});

test("/api/onboarding*：接入管理正在撤销 / 释放端口时，会往下执行步骤的三个动作 409，引导不被调用；其余照常", async () => {
  const calls = [];
  const record = (name) => () => {
    calls.push(name);
    return STATE;
  };
  let notice = "正在撤销接入";
  const route = createOnboardingRoutes({
    onboardingGuide: { getState: () => STATE, start: record("start"), answer: record("answer"), retry: record("retry"), setDismissed: record("dismiss"), reset: record("reset") },
    accessManager: { busyNotice: () => notice },
  });
  for (const [path, body] of [["/api/onboarding/start", { sshUser: "amy" }], ["/api/onboarding/answer", { kind: "password", password: "p" }], ["/api/onboarding/retry", {}]]) {
    assert.deepEqual(await call(route, "POST", path, body), { handled: true, status: 409, body: { error: "正在撤销接入，等它结束再继续接入引导", code: "busy" } });
  }
  assert.deepEqual(calls, []);
  // 读状态、「稍后再说」、清进度不受影响
  assert.equal((await call(route, "GET", "/api/onboarding")).status, 200);
  assert.equal((await call(route, "POST", "/api/onboarding/dismiss", {})).status, 200);
  assert.equal((await call(route, "POST", "/api/onboarding/reset", {})).status, 200);
  assert.deepEqual(calls, ["dismiss", "reset"]);
  // 动作结束后放行
  notice = null;
  assert.equal((await call(route, "POST", "/api/onboarding/start", { sshUser: "amy" })).status, 200);
  assert.deepEqual(calls, ["dismiss", "reset", "start"]);
});
