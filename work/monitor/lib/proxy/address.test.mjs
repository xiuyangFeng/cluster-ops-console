import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAuthority,
  isLoopbackHost,
  isPlausibleHost,
  isPrivateTarget,
  parseAllowlistEntry,
  parseHttpProxyUrl,
} from "./address.mjs";

test("parseAllowlistEntry：归一化 host 小写 + 数字端口；缺端口 / 非法端口 / 私网 / 非字符串分别给出原因", () => {
  assert.deepEqual(parseAllowlistEntry("  API.Relay-Demo.example:09443 "), { host: "api.relay-demo.example", port: 9443, entry: "api.relay-demo.example:9443" });
  assert.equal(parseAllowlistEntry("[2001:db8::1]:9443").entry, "2001:db8::1:9443", "IPv6 与 makeDefaultAllowTarget 的查表键同形");
  for (const bad of ["no-port.example.com", "x.example.com:0", "x.example.com:70000", ":9443", "[::1]"]) {
    assert.equal(parseAllowlistEntry(bad).error, "format", bad);
  }
  for (const priv of ["127.0.0.1:9443", "localhost:8443", "10.1.2.3:9000", "[::1]:9443"]) {
    assert.equal(parseAllowlistEntry(priv).error, "private", priv);
  }
  assert.equal(parseAllowlistEntry(42).error, "type");
});

test("parseHttpProxyUrl：只认 http://host:port（可带结尾斜杠），拒绝 https / socks / 账号密码 / 路径 / 缺端口", () => {
  assert.deepEqual(parseHttpProxyUrl("http://127.0.0.1:7890/"), { host: "127.0.0.1", port: 7890, url: "http://127.0.0.1:7890" });
  assert.deepEqual(parseHttpProxyUrl(" HTTP://Proxy.LAN:8080 "), { host: "proxy.lan", port: 8080, url: "http://proxy.lan:8080" });
  assert.deepEqual(parseHttpProxyUrl("http://[::1]:7890"), { host: "::1", port: 7890, url: "http://[::1]:7890" });
  for (const bad of [
    "https://127.0.0.1:7890", "socks5://127.0.0.1:7891", "http://u:p@127.0.0.1:7890", "http://127.0.0.1:7890/path",
    "http://127.0.0.1", "127.0.0.1:7890", "http://127.0.0.1:99999", "http://bad host:1", "", null, 7890,
  ]) {
    assert.equal(parseHttpProxyUrl(bad), null, String(bad));
  }
});

test("isLoopbackHost / isPlausibleHost / formatAuthority", () => {
  for (const h of [
    "127.0.0.1", "127.9.9.9", "localhost", "LocalHost.", "::1", "[::1]", "::ffff:127.0.0.1",
    // v2.54 终审：未指定地址作为目的地址时内核连到本机；非压缩 / 混合 / 十六进制内嵌 / inet_aton 简写一视同仁。
    "0.0.0.0", "0.1.2.3", "::", "[::]", "0:0:0:0:0:0:0:0", "0:0:0:0:0:0:0:1", "::ffff:0.0.0.0", "0:0:0:0:0:ffff:127.0.0.1",
    "::ffff:7f00:1", "127.1", "2130706433", "0x7f000001", "0", " 127.0.0.1 ", "::1%lo0",
  ]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["10.0.0.1", "example.com", "", "::2", "::ffff:10.0.0.1", "2001:db8::1", "1.2.3.4", "0x7f.example.com", "127.0.0.1.example.com"]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
  for (const h of ["example.com", "a-b.c_d.example", "1.2.3.4", "2001:db8::1", "single"]) assert.equal(isPlausibleHost(h), true, h);
  for (const h of ["", "bad host", "a..b", "-lead.example", "x/y", `${"a".repeat(64)}.com`]) assert.equal(isPlausibleHost(h), false, h);
  assert.equal(formatAuthority("2001:db8::1", 443), "[2001:db8::1]:443");
  assert.equal(formatAuthority("api.openai.com", 443), "api.openai.com:443");
});

test("isPrivateTarget（v2.54 终审）：IPv4-mapped / -compatible 的非压缩与混合写法、inet_aton 数字简写都按内嵌 IPv4 判", () => {
  for (const h of [
    "0:0:0:0:0:ffff:127.0.0.1", "0::ffff:127.0.0.1", "::ffff:7f00:0001", "[::ffff:10.0.0.1]", "::ffff:c0a8:0101",
    "::", "::1", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "10.1", "192.168.257",
  ]) assert.equal(isPrivateTarget(h), true, h);
  for (const h of ["::ffff:8.8.8.8", "2001:db8::1", "8.8.8.8", "api.openai.com", "134744072", "1.2.3"]) assert.equal(isPrivateTarget(h), false, h);
});
