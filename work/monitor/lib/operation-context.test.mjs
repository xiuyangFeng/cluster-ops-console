import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOperationId, redactSensitive } from "./operation-context.mjs";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

test("normalizeOperationId preserves canonical UUID and generates for invalid or missing values", () => {
  let calls = 0;
  const randomUUID = () => { calls += 1; return UUID; };
  assert.equal(normalizeOperationId(UUID, { randomUUID }), UUID);
  assert.equal(normalizeOperationId("not-a-uuid", { randomUUID }), UUID);
  assert.equal(normalizeOperationId(undefined, { randomUUID }), UUID);
  assert.equal(calls, 2);
});

test("redactSensitive recursively redacts credentials and preserves ordinary data", () => {
  const input = {
    authorization: "Bearer secret-token",
    headers: { "x-auth-token": "abc", Accept: "application/json" },
    url: "https://alice:password@example.com/a?x=1",
    output: "curl -H 'Authorization: Bearer live-token' https://bob:pw@example.com",
    nested: [{ apiToken: "sk-sensitive", count: 7 }],
  };
  const result = redactSensitive(input);
  assert.equal(result.authorization, "[REDACTED]");
  assert.equal(result.headers["x-auth-token"], "[REDACTED]");
  assert.equal(result.headers.Accept, "application/json");
  assert.equal(result.url, "https://[REDACTED]@example.com/a?x=1");
  assert.doesNotMatch(result.output, /live-token|bob:pw/);
  assert.equal(result.nested[0].apiToken, "[REDACTED]");
  assert.equal(result.nested[0].count, 7);
  assert.notEqual(result, input);
});

test("redactSensitive bounds command output strings", () => {
  const result = redactSensitive({ stdout: "x".repeat(200_000) });
  assert.ok(result.stdout.length < 70_000);
  assert.match(result.stdout, /truncated/i);
});

test("redactSensitive removes standalone API token patterns from strings", () => {
  const result = redactSensitive(("command failed with sk-" + "proj-abcdefghijklmnopqrstuvwxyz012345"));
  assert.doesNotMatch(result, /sk-proj-/);
  assert.match(result, /\[REDACTED\]/);
});

test("redactSensitive inherits output bounds through nested arrays and objects", () => {
  const huge = "x".repeat(3 * 1024 * 1024);
  const result = redactSensitive({
    stdout: [huge],
    output: { text: huge },
  });
  assert.ok(result.stdout[0].length < 70_000);
  assert.ok(result.output.text.length < 70_000);
  assert.match(result.stdout[0], /truncated/i);
  assert.match(result.output.text, /truncated/i);
});
