import assert from "node:assert/strict";
import test from "node:test";

import { classifyRelayBaseUrl } from "./relay-url.mjs";

test("classifyRelayBaseUrl：https 443 零配置；非 443 进白名单；http 也进白名单但带明文提醒", () => {
  assert.deepEqual(classifyRelayBaseUrl("https://api.openai.com/v1"), { action: "none", scheme: "https", host: "api.openai.com", port: 443, warnings: [] });
  assert.deepEqual(classifyRelayBaseUrl("https://relay.example.com:443/"), { action: "none", scheme: "https", host: "relay.example.com", port: 443, warnings: [] });
  assert.deepEqual(classifyRelayBaseUrl(" https://API.Relay-Demo.example:9443/v1 "), {
    action: "allowlist", entry: "api.relay-demo.example:9443", scheme: "https", host: "api.relay-demo.example", port: 9443, warnings: [],
  });
  assert.deepEqual(classifyRelayBaseUrl("http://relay.example.com/v1"), {
    action: "allowlist", entry: "relay.example.com:80", scheme: "http", host: "relay.example.com", port: 80, warnings: ["plaintext-http"],
  });
  assert.equal(classifyRelayBaseUrl("http://relay.example.com:8080").entry, "relay.example.com:8080");
});

test("classifyRelayBaseUrl：内网 / 校内地址归 direct-candidate（不经本机代理，集群直连）", () => {
  for (const url of [
    "http://10.0.3.7:8000/v1", "https://192.168.1.5", "http://localhost:3000", "http://[fd00::1]:8080",
    "http://gpu-relay:8000", "https://relay.lab.internal/v1", "http://api.campus.lan:9000", "https://box.local",
  ]) {
    assert.equal(classifyRelayBaseUrl(url).action, "direct-candidate", url);
  }
  assert.deepEqual(classifyRelayBaseUrl("http://10.0.3.7:8000").warnings, ["plaintext-http"]);
});

test("classifyRelayBaseUrl：不是 http(s) URL → invalid（带原因）", () => {
  assert.equal(classifyRelayBaseUrl("").reason, "empty");
  assert.equal(classifyRelayBaseUrl("relay.example.com:9443").reason, "unsupported-scheme", "缺 scheme 时 URL 把主机名当协议");
  assert.equal(classifyRelayBaseUrl("not a url").reason, "not-a-url");
  assert.equal(classifyRelayBaseUrl("ftp://relay.example.com").reason, "unsupported-scheme");
  assert.equal(classifyRelayBaseUrl("socks5://127.0.0.1:1080").action, "invalid");
  assert.equal(classifyRelayBaseUrl(null).action, "invalid");
});
