import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyErrorText, errorKindOf, MAX_ERROR_TEXT_CHARS, sanitizeErrorText } from "./error-text.mjs";

test("sanitizeErrorText：非字符串 = 未采集；单行化、去控制字符、二次脱敏、限长", () => {
  assert.equal(sanitizeErrorText(undefined), null);
  assert.equal(sanitizeErrorText(42), null);
  assert.equal(sanitizeErrorText(""), "");
  assert.equal(sanitizeErrorText("API Error:\n  The response\u0007 stopped arriving.\r\n"), "API Error: The response stopped arriving.");
  const secret = sanitizeErrorText("401 Bearer abc.def.ghi api_key=XYZ123 " + "sk-" + "proj-ABCDEFGHIJKLMNOPQRSTUV" + " https://u:p@host/x");
  assert.ok(!/abc\.def|XYZ123|ABCDEFGHIJ|u:p@/.test(secret), secret);
  assert.match(secret, /\[REDACTED\]/);
  assert.equal(sanitizeErrorText("x".repeat(5000)).length, MAX_ERROR_TEXT_CHARS);
});

test("classifyErrorText：只认实际抽查到的文案，认不出归 other", () => {
  const cases = {
    "API Error: The response stopped arriving. The response above may be incomplete.": "stream_stopped",
    "API Error: Connection lost mid-response. The response above may be incomplete.": "connection_lost",
    "API Error: Server error mid-response. The response above may be incomplete.": "server_mid_response",
    "API Error: Opus 5 (1M context)'s safeguards flagged this message": "safeguards",
    "You've reached your Fable limit. Run /usage-credits to continue": "usage_limit",
    "You've hit your session limit · resets 12:40am (Asia/Shanghai)": "usage_limit",
    "API Error: 502 Cannot reach the reclaude gateway. Check your network": "gateway_unreachable",
    "API Error: 400 当前绑定账号暂不可用，系统将自动处理": "account_unavailable",
    "API Error: 400 reclaude 客户端状态异常，请重启 reclaude 后重试": "client_state",
    "Please run /login · API Error: 401 OAuth access token has been revoked.": "auth_revoked",
    "Something brand new": "other",
  };
  for (const [text, kind] of Object.entries(cases)) assert.equal(classifyErrorText(text), kind, text);
  assert.equal(classifyErrorText(""), null);
});

test("errorKindOf：没有原文时给出原因键（v2.51 前 / 日志无文本 / 超出上限）", () => {
  assert.equal(errorKindOf({ ok: true }), null);
  assert.equal(errorKindOf({ ok: false, errorText: null }), "unrecorded");
  assert.equal(errorKindOf({ ok: false }), "unrecorded");
  assert.equal(errorKindOf({ ok: false, errorText: "" }), "empty");
  assert.equal(errorKindOf({ ok: false, errorText: null, errorDropped: true }), "dropped");
  assert.equal(errorKindOf({ ok: false, errorText: "Connection lost mid-response." }), "connection_lost");
});
