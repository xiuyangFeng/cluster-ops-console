import { test } from "node:test"; import assert from "node:assert/strict";
import { renderReclaudeProxyDropin, zcodeProxySettingsPatch, mergeZcodeSettings } from "./proxy-config.mjs";
test("reclaude dropin has [Service], port, NO_PROXY", () => {
  const s = renderReclaudeProxyDropin(7892);
  assert.match(s, /\[Service\]/);
  assert.match(s, /Environment=HTTPS_PROXY=http:\/\/127\.0\.0\.1:7892/);
  assert.match(s, /NO_PROXY=localhost,127\.0\.0\.1,::1/);
});
test("zcode patch: targets setting.json schema keys with the assigned port", () => {
  const p = zcodeProxySettingsPatch(7893);
  assert.deepEqual(p, { httpProxy: "http://127.0.0.1:7893", httpProxyNoProxy: "localhost,127.0.0.1,::1" });
});

test("mergeZcodeSettings: merges proxy keys and preserves unrelated keys", () => {
  const existing = JSON.stringify({ locale: "zh-CN", keepAwakeWhileRunning: false, httpProxy: "http://old" });
  const out = mergeZcodeSettings(existing, zcodeProxySettingsPatch(7891));
  const parsed = JSON.parse(out);
  assert.equal(parsed.httpProxy, "http://127.0.0.1:7891");
  assert.equal(parsed.locale, "zh-CN");
  assert.equal(parsed.keepAwakeWhileRunning, false);
  assert.equal(parsed.httpProxyNoProxy, "localhost,127.0.0.1,::1");
});

test("mergeZcodeSettings: missing / blank file starts from empty object", () => {
  for (const input of [undefined, null, "", "   ", "\n"]) {
    const parsed = JSON.parse(mergeZcodeSettings(input, zcodeProxySettingsPatch(7892)));
    assert.deepEqual(parsed, { httpProxy: "http://127.0.0.1:7892", httpProxyNoProxy: "localhost,127.0.0.1,::1" });
  }
});

test("mergeZcodeSettings: invalid JSON or non-object top level returns null (never clobbers)", () => {
  assert.equal(mergeZcodeSettings("{not json", zcodeProxySettingsPatch(7891)), null);
  assert.equal(mergeZcodeSettings("[1,2]", zcodeProxySettingsPatch(7891)), null);
  assert.equal(mergeZcodeSettings('"just a string"', zcodeProxySettingsPatch(7891)), null);
});
